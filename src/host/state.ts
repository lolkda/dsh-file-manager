import path from 'node:path';
import { z } from 'zod';
import Schema from '@deepseek-ai/schemastery';
import { FileManagerError } from '../contracts/errors.js';
import {
  LIMIT_BOUNDS, LIMIT_DEFAULTS, OPERATIONS_STORAGE_NAMESPACE, SETTINGS_NAMESPACE, STORAGE_NAMESPACE,
  type LimitName, type ProfileLimits,
} from '../contracts/limits.js';
import type { PluginContext, StorageDomainHandle } from './context.js';
import type { RootDescriptor } from './manager.js';
import type { TaskRecord } from './tasks.js';
import type { TransferTask } from './transfers.js';

const rootSchema = z.object({
  id: z.string().min(1).max(128),
  provider: z.literal('host-local'),
  path: z.string().refine(value => path.isAbsolute(value) && !/[\x00-\x1f]/.test(value)),
  label: z.string(),
  identity: z.string().regex(/^\d+:\d+$/),
  createdAt: z.string().datetime(),
}).strict();
const rootStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  roots: z.array(rootSchema),
}).strict().refine(state => new Set(state.roots.map(root => root.id)).size === state.roots.length);

/** One settings field per frozen limit, described by the limit contract itself. */
function limitField(name: LimitName) {
  const bounds = LIMIT_BOUNDS[name];
  return Schema.natural().min(bounds.min).max(bounds.max).default(LIMIT_DEFAULTS[name]).description(bounds.description);
}

const limitsSchema = Schema.object({
  maxTextBytes: limitField('maxTextBytes'),
  maxFileBytes: limitField('maxFileBytes'),
  maxTaskBytes: limitField('maxTaskBytes'),
  maxTaskEntries: limitField('maxTaskEntries'),
  transferConcurrency: limitField('transferConcurrency'),
  pollIntervalMs: limitField('pollIntervalMs'),
  deletePlanTtlMs: limitField('deletePlanTtlMs'),
  maxVerificationBytes: limitField('maxVerificationBytes'),
});

export interface ProfileState {
  limits: ProfileLimits;
  managerOptions: {
    initialRoots: RootDescriptor[];
    maxTextBytes: number;
    maxVerificationBytes: number;
    deletePlanTtlMs: number;
    persistRoots(roots: RootDescriptor[]): Promise<void>;
  };
  close(): Promise<void>;
}

/** Open profile-owned metadata through DSH, without writing a separate config file. */
export async function openProfileState(ctx: PluginContext): Promise<ProfileState> {
  ctx.settings.register(SETTINGS_NAMESPACE, limitsSchema, { applies: 'restart' });
  const limits = ctx.settings.get(SETTINGS_NAMESPACE);
  const domain = await ctx.storageDomain.open({
    name: STORAGE_NAMESPACE,
    version: 1,
    layout: 'per-record',
    global: { schema: rootStateSchema, initial: { revision: 0, roots: [] } },
    tables: {},
  });
  const stored = domain.global.get() as { roots: RootDescriptor[] };
  return {
    limits,
    managerOptions: {
      initialRoots: stored.roots,
      maxTextBytes: limits.maxTextBytes,
      maxVerificationBytes: limits.maxVerificationBytes,
      deletePlanTtlMs: limits.deletePlanTtlMs,
      async persistRoots(roots: RootDescriptor[]) {
        const current = domain.global.get() as { revision: number };
        await domain.global.set({ revision: current.revision + 1, roots });
      },
    },
    close: () => domain.close(),
  };
}

const statusSchema = z.enum(['queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted']);
const historyFields = {
  dismissed: z.boolean().optional(),
  historyRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
};
const taskRecordSchema = z.object({
  id: z.string().min(1), operation: z.enum(['copy', 'move']), status: statusSchema, ...historyFields,
  items: z.array(z.record(z.string(), z.unknown())).max(100000),
}).passthrough();
const transferRecordSchema = z.object({
  id: z.string().min(1), type: z.literal('transfer'), direction: z.enum(['upload', 'download']),
  rootId: z.string().min(1), path: z.string(), status: statusSchema, ...historyFields,
  items: z.array(z.record(z.string(), z.unknown())).max(100000),
}).passthrough();

export interface OperationState {
  taskOptions: {
    initialTasks: TaskRecord[];
    persistTask(record: TaskRecord): Promise<void>;
  };
  transferOptions: {
    initialTasks: TransferTask[];
    persistTasks(records: TransferTask[]): Promise<void>;
  };
  close(): Promise<void>;
}

/**
 * Keep raw checkpoints intact; public task DTOs are not recovery journals.
 * A journal that cannot be read is reported, never reset or dropped.
 */
export async function openOperationState(ctx: PluginContext): Promise<OperationState> {
  const domain: StorageDomainHandle = await ctx.storageDomain.open({
    name: OPERATIONS_STORAGE_NAMESPACE, version: 1, layout: 'per-record',
    global: { schema: z.object({}).strict(), initial: {} },
    tables: { tasks: { valueSchema: taskRecordSchema }, transfers: { valueSchema: transferRecordSchema } },
  });
  const tasks = domain.table('tasks');
  const transfers = domain.table('transfers');
  const readRecords = (table: { entries(): IterableIterator<[string, unknown]> }): Array<Record<string, unknown>> => [...table.entries()].map(([key, record]) => {
    if ((record as { id?: unknown }).id !== key) throw new FileManagerError('INVALID_STATE', 'An operation journal key does not match its identity.', 500);
    return structuredClone(record) as Record<string, unknown>;
  });
  // The domain schema validated every record when the journal opened; the
  // engine's in-memory shape is the same object with its recovery proof intact.
  let taskRecords: unknown[];
  let transferRecords: unknown[];
  try { taskRecords = readRecords(tasks); transferRecords = readRecords(transfers); }
  catch (error) { await domain.close(); throw error; }
  const initialTasks = taskRecords as TaskRecord[];
  const initialTransfers = transferRecords as TransferTask[];
  const taskCache = new Map(initialTasks.map(task => [task.id, JSON.stringify(task)]));
  const transferCache = new Map(initialTransfers.map(task => [task.id, JSON.stringify(task)]));
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;
  const queued = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new FileManagerError('SERVICE_STOPPED', 'The operation journal is closing.', 503));
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
  async function persist(table: { put(key: string, value: unknown): Promise<void> }, cache: Map<string, string>, record: Record<string, unknown>): Promise<void> {
    const serialized = JSON.stringify(record);
    if (cache.get(record.id as string) === serialized) return;
    await table.put(record.id as string, record);
    // A rejected write must never be treated as durable by the next attempt.
    cache.set(record.id as string, serialized);
  }
  return {
    taskOptions: {
      initialTasks,
      persistTask(record) {
        const snapshot = structuredClone(record);
        return queued(() => persist(tasks, taskCache, taskRecordSchema.parse(snapshot) as Record<string, unknown>));
      },
    },
    transferOptions: {
      initialTasks: initialTransfers,
      persistTasks(records) {
        const snapshot = structuredClone(records);
        return queued(async () => {
          const validated = snapshot.map(record => transferRecordSchema.parse(record) as Record<string, unknown>);
          for (const record of validated) await persist(transfers, transferCache, record);
        });
      },
    },
    async close() {
      closed = true;
      await tail;
      await domain.close();
    },
  };
}
