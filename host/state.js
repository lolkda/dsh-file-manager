import path from 'node:path';
import { z } from 'zod';
import Schema from '@deepseek-ai/schemastery';
import { FileManagerError } from '../contracts/errors.js';

const NS = 'local-file-manager';
// Settings uses kebab-case; Storage units must match /^[a-z][a-z0-9_]*$/.
const STORAGE_NS = 'local_file_manager';
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

const limitsSchema = Schema.object({
  maxTextBytes: Schema.natural().min(1).max(32 * 1024 * 1024).default(5 * 1024 * 1024).description('Text editing limit in bytes'),
  maxFileBytes: Schema.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(2 * 1024 ** 3).description('Individual transfer file limit in bytes'),
  maxTaskBytes: Schema.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(10 * 1024 ** 3).description('Total transfer task limit in bytes'),
  maxTaskEntries: Schema.natural().min(1).max(100000).default(10000).description('Entry count limit for transfer tasks'),
  transferConcurrency: Schema.natural().min(1).max(8).default(2).description('Simultaneous transfer count'),
  pollIntervalMs: Schema.natural().min(250).max(60000).default(2000).description('Snapshot reconciliation interval in milliseconds'),
  deletePlanTtlMs: Schema.natural().min(1000).max(600000).default(300000).description('Deletion confirmation lifetime in milliseconds'),
});

/** Open profile-owned metadata through DSH, without writing a separate config file. */
export async function openProfileState(ctx) {
  ctx.settings.register(NS, limitsSchema, { applies: 'restart' });
  const limits = ctx.settings.get(NS);
  const domain = await ctx.storageDomain.open({
    name: STORAGE_NS,
    version: 1,
    layout: 'per-record',
    global: { schema: rootStateSchema, initial: { revision: 0, roots: [] } },
    tables: {},
  });
  return {
    limits,
    managerOptions: {
      initialRoots: domain.global.get().roots,
      maxTextBytes: limits.maxTextBytes,
      deletePlanTtlMs: limits.deletePlanTtlMs,
      async persistRoots(roots) {
        const current = domain.global.get();
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

/** Keep raw checkpoints intact; public task DTOs are not recovery journals. */
export async function openOperationState(ctx) {
  const domain = await ctx.storageDomain.open({
    name: `${STORAGE_NS}_operations`, version: 1, layout: 'per-record',
    global: { schema: z.object({}).strict(), initial: {} },
    tables: { tasks: { valueSchema: taskRecordSchema }, transfers: { valueSchema: transferRecordSchema } },
  });
  const tasks = domain.table('tasks');
  const transfers = domain.table('transfers');
  const readRecords = table => [...table.entries()].map(([key, record]) => {
    if (record.id !== key) throw new FileManagerError('INVALID_STATE', 'An operation journal key does not match its identity.', 500);
    return structuredClone(record);
  });
  let initialTasks;
  let initialTransfers;
  try { initialTasks = readRecords(tasks); initialTransfers = readRecords(transfers); }
  catch (error) { await domain.close(); throw error; }
  const taskCache = new Map(initialTasks.map(task => [task.id, JSON.stringify(task)]));
  const transferCache = new Map(initialTransfers.map(task => [task.id, JSON.stringify(task)]));
  let tail = Promise.resolve();
  let closed = false;
  const queued = operation => {
    if (closed) return Promise.reject(new FileManagerError('SERVICE_STOPPED', 'The operation journal is closing.', 503));
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
  async function persist(table, cache, record) {
    const serialized = JSON.stringify(record);
    if (cache.get(record.id) === serialized) return;
    await table.put(record.id, record);
    // A rejected write must never be treated as durable by the next attempt.
    cache.set(record.id, serialized);
  }
  return {
    taskOptions: {
      initialTasks,
      persistTask(record) {
        const snapshot = structuredClone(record);
        // Domain validates records on open; typed writes trust their caller.
        return queued(() => persist(tasks, taskCache, taskRecordSchema.parse(snapshot)));
      },
    },
    transferOptions: {
      initialTasks: initialTransfers,
      persistTasks(records) {
        const snapshot = structuredClone(records);
        return queued(async () => {
          const validated = snapshot.map(record => transferRecordSchema.parse(record));
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
