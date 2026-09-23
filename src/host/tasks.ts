import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { FileManagerError, fail, normalizeError } from '../contracts/errors.js';
import { HEAVY_IO_QUEUE_LIMIT, LIMIT_DEFAULTS } from '../contracts/limits.js';
import { toPublicTask, type PublicTaskView, type TaskStatus } from '../contracts/views.js';
import { chargeVerification, type EntryKind, type EntryView, type VerificationBudget } from './io.js';
import type { Manager } from './manager.js';
import { createHeavyIoScheduler, type HeavyIoScheduler } from './scheduler.js';

const terminalStates = new Set<TaskStatus>(['completed', 'partial', 'failed', 'cancelled']);
const policies = new Set(['skip', 'rename', 'overwrite']);
const childPath = (parent: string, name: string): string => parent ? `${parent}/${name}` : name;
const parentRef = (ref: TaskRef): TaskRef => ({ rootId: ref.rootId, path: ref.path.includes('/') ? ref.path.slice(0, ref.path.lastIndexOf('/')) : '' });
const under = (child: string, parent: string): boolean => child === parent || child.startsWith(`${parent}/`);

export interface TaskErrorView {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

const errorView = (error: unknown): TaskErrorView => {
  // Task items move file content, so they normalize like a transfer: an
  // unmapped errno becomes IO_ERROR/500 with the raw code kept as a cause,
  // never a bare errno on the wire.
  const failure = normalizeError(error, { profile: 'transfer' });
  return { code: failure.code, message: failure.message, details: failure.details };
};

const cancellation = (signal: AbortSignal | undefined): void => { if (signal?.aborted) fail('CANCELLED', 'The task was cancelled.', 499); };

export interface TaskRef { rootId: string; path: string }

export interface TaskSource extends TaskRef { expectedVersion: string }

export interface TaskItemResult {
  destination: EntryView;
  bytes: number;
  sourceRemoved: boolean;
  method: 'copy' | 'copy-delete' | 'rename';
}

export interface TaskCheckpoint {
  phase: 'renaming' | 'publishing' | 'published' | 'renamed';
  manifest: EntryView[];
  removed: string[];
  targetParent: EntryView;
  receipt?: EntryView | undefined;
  targetManifest?: EntryView[] | undefined;
}

export interface TaskItem {
  id: string;
  source: TaskSource;
  conflict: string;
  name?: string | undefined;
  expectedTargetVersion?: string | undefined;
  destination: TaskRef;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';
  attempts: number;
  bytesTransferred: number;
  measured?: { entries: number; bytes: number } | undefined;
  checkpoint?: TaskCheckpoint | undefined;
  result?: TaskItemResult | undefined;
  error?: TaskErrorView | undefined;
}

export interface TaskRecord {
  id: string;
  operation: 'copy' | 'move';
  destination: TaskRef;
  conflict: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  dismissed: boolean;
  historyRevision: number;
  items: TaskItem[];
  progress?: Record<string, number> | undefined;
  canDismiss?: boolean | undefined;
  cancelRequested?: boolean | undefined;
  persistenceError?: TaskErrorView | undefined;
}

export interface TaskServiceOptions {
  manager: Manager;
  limits?: {
    maxFileBytes?: number | undefined;
    maxTaskBytes?: number | undefined;
    maxTaskEntries?: number | undefined;
    transferConcurrency?: number | undefined;
  } | undefined;
  initialTasks?: readonly TaskRecord[] | undefined;
  persistTask?: ((record: TaskRecord) => Promise<void>) | undefined;
  onChange?: ((task: PublicTaskView) => unknown) | undefined;
  /** Shared heavy-IO budget; a private one is created when the Host does not pass one. */
  scheduler?: HeavyIoScheduler | undefined;
}

export interface TaskStartInput {
  operation?: unknown;
  items?: unknown;
  destination?: unknown;
  conflict?: unknown;
}

export interface TaskService {
  start(input?: TaskStartInput): Promise<PublicTaskView>;
  list(): Promise<PublicTaskView[]>;
  get(input?: { taskId?: unknown }): Promise<PublicTaskView>;
  cancel(input?: { taskId?: unknown }): Promise<PublicTaskView>;
  retry(input?: { taskId?: unknown; items?: unknown }): Promise<PublicTaskView>;
  dismiss(input?: { taskId?: unknown; expectedHistoryRevision?: unknown }): Promise<PublicTaskView>;
  close(): Promise<void>;
}

function refOf(ref: unknown, allowRoot = false): TaskRef {
  const value = ref as { rootId?: unknown; path?: unknown } | undefined;
  if (!value || typeof value.rootId !== 'string' || !value.rootId || typeof value.path !== 'string'
    || value.path.length > 4096 || /[\x00-\x1f\\]/.test(value.path) || path.posix.isAbsolute(value.path) || /^[A-Za-z]:/.test(value.path)
    || (value.path && value.path.split('/').some(part => !part || part === '.' || part === '..'))) {
    fail('INVALID_PATH', 'Expected an authorized root and a relative path.');
  }
  if (!allowRoot && !value.path) fail('ROOT_OPERATION_NOT_ALLOWED', 'The granted root itself cannot be copied or moved.', 403);
  return { rootId: value.rootId, path: value.path };
}

function nameOf(name: unknown): string | undefined {
  if (name === undefined) return undefined;
  refOf({ rootId: 'name-validation', path: name });
  if ((name as string).includes('/')) fail('INVALID_PATH', 'A conflict rename must be one path segment.');
  return name as string;
}

function versionOf(version: unknown): string {
  if (typeof version !== 'string' || !version) fail('VERSION_REQUIRED', 'Each source requires its selected version.', 409);
  return version;
}

interface ActiveRun { controller: AbortController; promise: Promise<void> }

/** Asynchronous task orchestration. Storage and notification remain profile-owned injection points. */
export function createTaskService(options: TaskServiceOptions): TaskService {
  const { manager, initialTasks = [], persistTask = async () => {}, onChange = () => {} } = options;
  if (!manager?.io) fail('INVALID_STATE', 'The safe manager I/O capability is required.', 500);
  const io = manager.io;
  const configured = options.limits ?? {};
  const bounds = {
    maxFileBytes: configured.maxFileBytes ?? LIMIT_DEFAULTS.maxFileBytes,
    maxTaskBytes: configured.maxTaskBytes ?? LIMIT_DEFAULTS.maxTaskBytes,
    maxTaskEntries: configured.maxTaskEntries ?? LIMIT_DEFAULTS.maxTaskEntries,
    concurrency: configured.transferConcurrency ?? LIMIT_DEFAULTS.transferConcurrency,
  };
  for (const value of Object.values(bounds)) if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_STATE', 'Task limits must be positive safe integers.', 500);
  if (bounds.concurrency > 8) fail('INVALID_STATE', 'Task concurrency cannot exceed eight.', 500);
  const scheduler = options.scheduler ?? createHeavyIoScheduler({ concurrency: bounds.concurrency, queueLimit: HEAVY_IO_QUEUE_LIMIT });
  const tasks = new Map<string, TaskRecord>();
  const active = new Map<string, ActiveRun>();
  const waiting: TaskRecord[] = [];
  const requeuing = new Set<string>();
  const historyUpdates = new Set<string>();
  const controls = new Set<Promise<unknown>>();
  let stopped = false;
  let closingPromise: Promise<void> | undefined;
  let persistenceTail: Promise<unknown> = Promise.resolve();

  function progress(task: TaskRecord): Record<string, number> {
    const result: Record<string, number> = { total: task.items.length, completed: 0, failed: 0, skipped: 0, cancelled: 0, bytes: 0, totalBytes: 0 };
    for (const item of task.items) {
      if (item.status in result) result[item.status] = (result[item.status] ?? 0) + 1;
      result.bytes = (result.bytes ?? 0) + (item.result?.bytes ?? item.bytesTransferred ?? 0);
      result.totalBytes = (result.totalBytes ?? 0) + (item.measured?.bytes ?? 0);
    }
    return result;
  }

  function quiescent(task: TaskRecord): boolean {
    return terminalStates.has(task.status) && !active.has(task.id) && !requeuing.has(task.id) && !historyUpdates.has(task.id);
  }

  function nextHistoryRevision(task: TaskRecord): number {
    if (task.historyRevision === Number.MAX_SAFE_INTEGER) fail('HISTORY_REVISION_EXHAUSTED', 'The task history revision cannot advance safely.', 409);
    return task.historyRevision + 1;
  }

  /** The only public projection; private recovery proof never leaves this boundary. */
  function view(task: TaskRecord): PublicTaskView {
    return toPublicTask({ ...task, canDismiss: !task.dismissed && quiescent(task), progress: progress(task) });
  }

  function notify(task: TaskRecord): void {
    try { onChange(view(task)); } catch { /* Notification failure must not disguise a completed filesystem mutation. */ }
  }

  async function save(task: TaskRecord, publish = true): Promise<void> {
    task.updatedAt = new Date().toISOString();
    task.progress = progress(task);
    const record = structuredClone(task);
    delete record.canDismiss;
    const saving = persistenceTail.then(() => persistTask(record));
    persistenceTail = saving.catch(() => {});
    await saving;
    if (publish) notify(task);
  }

  /**
   * Persist a record this open migrated (defaults filled, interrupted work
   * marked). Unlike `save`, it never invents a new modification time: `updatedAt`
   * moves only on a real state transition, so reopening cannot creep forward.
   */
  async function persistMigrated(task: TaskRecord): Promise<void> {
    task.progress = progress(task);
    const record = structuredClone(task);
    delete record.canDismiss;
    const saving = persistenceTail.then(() => persistTask(record));
    persistenceTail = saving.catch(() => {});
    await saving;
    notify(task);
  }

  function taskOf(taskId: unknown): TaskRecord {
    if (typeof taskId !== 'string' || !tasks.has(taskId)) fail('TASK_NOT_FOUND', 'The task is unavailable.', 404);
    return tasks.get(taskId as string) as TaskRecord;
  }

  function accepting(): void { if (stopped) fail('SERVICE_STOPPED', 'The task service is stopping.', 503); }

  function logicalPath(ref: TaskRef): string {
    const grant = manager.listRoots().find(root => root.id === ref.rootId);
    if (!grant) fail('ROOT_NOT_FOUND', 'The root grant no longer exists.', 404);
    // Used only for overlap comparison. All filesystem access goes through io capabilities.
    return path.posix.join(grant.path, ref.path);
  }

  function statusOf(task: TaskRecord, cancelled = false): TaskStatus {
    if (cancelled || task.items.some(item => item.status === 'cancelled')) return 'cancelled';
    const failed = task.items.filter(item => item.status === 'failed').length;
    if (!failed) return 'completed';
    return failed === task.items.length ? 'failed' : 'partial';
  }

  if (!Array.isArray(initialTasks)) fail('INVALID_STATE', 'Stored tasks are invalid.', 500);
  // Opening the history must be idempotent: a record is rewritten only when the
  // reopen actually migrates observable state, never merely to refresh a
  // timestamp. A second open of the same snapshot performs zero writes.
  const migrated: TaskRecord[] = [];
  for (const record of initialTasks) {
    if (!record || typeof record.id !== 'string' || !record.id || tasks.has(record.id)
      || !['copy', 'move'].includes(record.operation) || !Array.isArray(record.items) || !record.items.length) {
      fail('INVALID_STATE', 'Stored tasks are invalid; no task was silently discarded.', 500);
    }
    const task = structuredClone(record) as TaskRecord;
    let changed = false;
    if (task.dismissed === undefined) { task.dismissed = false; changed = true; }
    if (task.historyRevision === undefined) { task.historyRevision = 0; changed = true; }
    if (typeof task.dismissed !== 'boolean' || !Number.isSafeInteger(task.historyRevision) || task.historyRevision < 0) {
      fail('INVALID_STATE', 'Stored task history flags or revision are invalid.', 500);
    }
    if ('canDismiss' in task) { delete task.canDismiss; changed = true; }
    refOf(task.destination, true);
    for (const item of task.items) {
      refOf(item.source); refOf(item.destination); versionOf(item.source.expectedVersion);
      if (typeof item.id !== 'string' || !Number.isSafeInteger(item.attempts) || item.attempts < 0) fail('INVALID_STATE', 'Stored task items are invalid.', 500);
      // A record written before these fields existed is still served: the public
      // contract must be able to report every record the engine accepts, and one
      // unrepresentable record must never break the whole history.
      if (item.conflict === undefined) { item.conflict = 'skip'; changed = true; }
      else if (!policies.has(item.conflict)) fail('INVALID_STATE', 'A stored task item has an invalid conflict strategy.', 500);
      if (item.bytesTransferred === undefined) { item.bytesTransferred = 0; changed = true; }
      else if (!Number.isSafeInteger(item.bytesTransferred) || item.bytesTransferred < 0) fail('INVALID_STATE', 'A stored task item has an invalid byte count.', 500);
      for (const [key, rootRef] of [['manifest', item.source], ['targetManifest', item.destination]] as Array<[string, TaskRef]>) {
        const manifest = (item.checkpoint as unknown as Record<string, EntryView[] | undefined> | undefined)?.[key] ?? [];
        for (const entry of manifest) {
          refOf(entry);
          if (entry.rootId !== rootRef.rootId || !under(entry.path, rootRef.path)) fail('INVALID_STATE', 'A stored task manifest escaped its selected subtree.', 500);
        }
      }
      if (item.status === 'running' || item.status === 'pending') {
        item.status = 'failed';
        item.error = { code: 'INTERRUPTED', message: 'The Host stopped before this item obtained a durable completion receipt. Review and retry it.', details: { committed: Boolean(item.checkpoint?.receipt) } };
        changed = true;
      }
    }
    if (!terminalStates.has(task.status)) {
      const derived = statusOf(task);
      if (derived !== task.status) { task.status = derived; changed = true; }
    }
    tasks.set(task.id, task);
    if (changed) migrated.push(task);
  }
  const ready = Promise.all(migrated.map(task => persistMigrated(task)));
  ready.catch(() => {});

  async function start(input: TaskStartInput = {}): Promise<PublicTaskView> {
    accepting(); await ready;
    const { operation, items, destination, conflict = 'skip' } = input;
    if (!['copy', 'move'].includes(operation as string) || !Array.isArray(items) || !items.length || items.length > bounds.maxTaskEntries) fail('INVALID_REQUEST', 'Select an operation and a bounded nonempty item list.');
    if (!policies.has(conflict as string)) fail('INVALID_REQUEST', 'Choose skip, rename, or overwrite for conflicts.');
    const target = refOf(destination, true);
    if ((await io.stat({ ...target, metadataOnly: true })).kind !== 'directory') fail('NOT_DIRECTORY', 'The task destination must be a directory.', 422);
    const selected = (items as Array<Record<string, unknown>>).map(input => {
      const source: TaskSource = { ...refOf(input), expectedVersion: versionOf(input.expectedVersion) };
      const policy = (input.conflict ?? conflict) as string;
      if (!policies.has(policy)) fail('INVALID_REQUEST', 'An item conflict strategy is invalid.');
      return {
        source, conflict: policy, name: nameOf(input.name),
        expectedTargetVersion: typeof input.expectedTargetVersion === 'string' ? input.expectedTargetVersion : undefined,
        logical: logicalPath(source),
      };
    }).sort((a, b) => a.logical.length - b.logical.length || a.logical.localeCompare(b.logical));
    const unique: typeof selected = [];
    for (const item of selected) if (!unique.some(parent => under(item.logical, parent.logical))) unique.push(item);
    // Preserve the UI selection order after removing descendants and exact duplicates.
    unique.sort((a, b) => (items as Array<Record<string, unknown>>).findIndex(input => input.rootId === a.source.rootId && input.path === a.source.path)
      - (items as Array<Record<string, unknown>>).findIndex(input => input.rootId === b.source.rootId && input.path === b.source.path));
    const createdAt = new Date().toISOString();
    const task: TaskRecord = {
      id: randomUUID(), operation: operation as 'copy' | 'move', destination: target, conflict: conflict as string,
      status: 'queued', createdAt, updatedAt: createdAt, dismissed: false, historyRevision: 0,
      items: unique.map(({ logical, ...item }) => ({
        id: randomUUID(), ...item,
        destination: { rootId: target.rootId, path: childPath(target.path, item.name ?? path.posix.basename(item.source.path)) },
        status: 'pending', attempts: 0, bytesTransferred: 0,
      })),
    };
    await save(task);
    tasks.set(task.id, task);
    schedule(task);
    return view(task);
  }

  async function inspect(ref: TaskRef, signal: AbortSignal | undefined, budget?: VerificationBudget): Promise<EntryView | undefined> {
    try { return await io.stat({ ...ref, signal, ...(budget ? { budget } : {}) }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }

  async function resolveDestination(task: TaskRecord, item: TaskItem, source: EntryView, signal: AbortSignal | undefined, budget: VerificationBudget): Promise<{ skip?: boolean; overwrite: boolean; expectedVersion?: string }> {
    const sourcePath = logicalPath(item.source);
    const targetParent = logicalPath(task.destination);
    if (source.kind === 'directory' && under(targetParent, sourcePath)) fail('SELF_DESCENDANT', 'A directory cannot be copied or moved into itself or its own subtree.', 409);
    const base = item.name ?? path.posix.basename(item.source.path);
    let ref: TaskRef = { rootId: task.destination.rootId, path: childPath(task.destination.path, base) };
    let existing = await inspect(ref, signal, budget);
    if (existing && item.conflict === 'rename' && item.name === undefined) {
      const extension = source.kind === 'file' ? path.posix.extname(base) : '';
      const stem = extension ? base.slice(0, -extension.length) : base;
      for (let suffix = 1; existing && suffix <= 10000; suffix++) {
        ref = { rootId: task.destination.rootId, path: childPath(task.destination.path, `${stem} (${suffix})${extension}`) };
        existing = await inspect(ref, signal, budget);
      }
      if (existing) fail('ALREADY_EXISTS', 'No unused conflict name was found.', 409);
    }
    item.destination = ref;
    if (existing && source.identity === existing.identity) fail('SAME_ENTRY', 'The source and destination identify the same entry.', 409);
    if (existing && item.conflict === 'skip') return { skip: true, overwrite: false };
    if (existing && item.conflict === 'rename') fail('ALREADY_EXISTS', 'The explicitly chosen new name also exists.', 409);
    if (existing && (source.kind === 'directory' || existing.kind === 'directory')) fail('DIRECTORY_CONFLICT', 'Directories cannot be overwritten or merged.', 409);
    if (existing && (source.kind !== 'file' || existing.kind !== 'file')) fail('UNSUPPORTED_ENTRY', 'Only ordinary files can be overwritten.', 422);
    if (existing && (typeof item.expectedTargetVersion !== 'string' || !/:[0-9a-f]{64}$/.test(item.expectedTargetVersion))) fail('STRONG_VERSION_REQUIRED', 'Overwrite requires a content-bound version from an explicit target stat.', 409);
    if (item.expectedTargetVersion !== undefined && item.conflict === 'overwrite'
      && (!existing || existing.version !== item.expectedTargetVersion)) fail('VERSION_CONFLICT', 'The selected overwrite target changed.', 409);
    return { overwrite: Boolean(existing), ...(existing ? { expectedVersion: existing.version } : {}) };
  }

  interface MeasuredTree {
    planned: PlannedEntry[];
    entries: number;
    bytes: number;
  }

  interface PlannedEntry {
    ref: TaskRef;
    kind: EntryKind;
    size: number;
    stamp: string;
    children?: string[] | undefined;
  }

  /**
   * Metadata-only enumeration of the selected tree. It reads no file content, so
   * an operation that exceeds the verification budget is refused here — before a
   * single byte is hashed.
   */
  async function measureTree(root: TaskRef, signal: AbortSignal | undefined): Promise<MeasuredTree> {
    const planned: PlannedEntry[] = [];
    let bytes = 0;
    async function walk(ref: TaskRef): Promise<void> {
      cancellation(signal);
      if (planned.length >= bounds.maxTaskEntries) fail('TOO_LARGE', 'The task exceeds its configured entry limit.', 413);
      const entry = await io.stat({ ...ref, signal, metadataOnly: true });
      if (!['file', 'directory'].includes(entry.kind)) fail('UNSUPPORTED_ENTRY', 'A selected tree contains a link or special entry; nothing was silently omitted.', 422);
      if (entry.mode & 0o7000) fail('UNSUPPORTED_ENTRY', 'Copy and move support ordinary POSIX permission bits only.', 422);
      if (entry.kind === 'file' && entry.size > bounds.maxFileBytes) fail('TOO_LARGE', 'A selected file exceeds the configured byte limit.', 413);
      if (entry.kind === 'file') bytes += entry.size;
      if (planned.length >= bounds.maxTaskEntries) fail('TOO_LARGE', 'The task exceeds its configured entry limit.', 413);
      if (bytes > bounds.maxTaskBytes) fail('TOO_LARGE', 'The task exceeds its configured byte limit.', 413);
      const plan: PlannedEntry = { ref, kind: entry.kind, size: entry.size, stamp: entry.version };
      planned.push(plan);
      if (entry.kind === 'directory') {
        const lease = await io.acquireDirectory(ref);
        let children: EntryView[];
        try {
          const listing = await lease.listing();
          // A name the grammar cannot express must fail this directory item
          // instead of silently copying less than the user selected.
          if (listing.unaddressable.length) {
            fail('UNREPRESENTABLE_REFERENCE', 'This directory contains an entry name that cannot be represented safely by the current path grammar; it cannot be copied or moved.', 422);
          }
          children = listing.entries;
        } finally { await lease.close(); }
        plan.children = children.map(child => child.name ?? '').sort();
        for (const child of children) await walk(child);
        if ((await io.stat({ ...ref, metadataOnly: true })).version !== plan.stamp) fail('VERSION_CONFLICT', 'The source directory changed during planning.', 409);
      }
    }
    await walk(root);
    return { planned, entries: planned.length, bytes };
  }

  async function collect(item: TaskItem, signal: AbortSignal | undefined, budget: VerificationBudget, measured: MeasuredTree): Promise<EntryView[]> {
    item.measured = { entries: measured.entries, bytes: measured.bytes };
    const manifest: EntryView[] = [];
    for (const plan of measured.planned) {
      cancellation(signal);
      const entry = await io.stat({
        ...plan.ref, signal, budget, expectedVersion: plan.stamp,
        ...(plan.kind === 'file' ? { maxBytes: plan.size } : {}),
      });
      if (entry.kind !== plan.kind) fail('VERSION_CONFLICT', 'A selected entry changed during planning.', 409);
      if (plan.children) entry.children = plan.children;
      manifest.push(entry);
    }
    if ((manifest[0] as EntryView).version !== item.source.expectedVersion) fail('VERSION_CONFLICT', 'The source changed after selection.', 409);
    return manifest;
  }

  async function verifyManifest(manifest: EntryView[], removed: string[] = [], signal: AbortSignal | undefined, budget: VerificationBudget): Promise<void> {
    const deleted = new Set(removed);
    for (const original of manifest) {
      cancellation(signal);
      if (deleted.has(original.path)) continue;
      const current = await io.stat({ ...original, signal, budget, ...(original.kind === 'file' ? { maxBytes: original.size } : {}) });
      const changed = original.kind === 'directory' && deleted.size ? current.identity !== original.identity : current.version !== original.version;
      if (changed || current.kind !== original.kind) fail('VERSION_CONFLICT', 'A manifest entry changed before the next operation.', 409);
      if (original.kind === 'directory') {
        const lease = await io.acquireDirectory(original);
        try {
          const children = (await lease.entries()).map(entry => entry.name ?? '').sort();
          const expected = (original.children ?? []).filter(name => !deleted.has(childPath(original.path, name)));
          if (children.join('\0') !== expected.join('\0')) fail('VERSION_CONFLICT', 'A manifest directory acquired different children.', 409);
        } finally { await lease.close(); }
      }
    }
  }

  const targetRef = (item: TaskItem, entry: EntryView): TaskRef => ({ rootId: item.destination.rootId, path: item.destination.path + entry.path.slice(item.source.path.length) });

  async function captureTarget(item: TaskItem, manifest: EntryView[], signal: AbortSignal | undefined, budget: VerificationBudget): Promise<EntryView[]> {
    const targets: EntryView[] = [];
    for (const entry of manifest) {
      cancellation(signal);
      const target = await io.stat({ ...targetRef(item, entry), signal, budget, ...(entry.kind === 'file' ? { maxBytes: entry.size } : {}) });
      if (entry.kind !== target.kind || (entry.kind === 'file' && (entry.size !== target.size || entry.sha256 !== target.sha256))) fail('VERSION_CONFLICT', 'The published target differs from the copied tree.', 409);
      targets.push({ ...target, ...(entry.children ? { children: [...entry.children] } : {}), ...(entry.sha256 ? { sha256: entry.sha256 } : {}) });
    }
    return targets;
  }

  async function verifyTarget(checkpoint: TaskCheckpoint, signal: AbortSignal | undefined, budget: VerificationBudget): Promise<void> {
    function invalid(): never {
      return fail('RECOVERY_REQUIRED', 'The saved publication proof is incomplete or inconsistent. No source deletion is authorized.', 409, { outcomeUncertain: true });
    }
    const sources = checkpoint.manifest;
    const targets = checkpoint.targetManifest;
    const receipt = checkpoint.receipt;
    const targetParent = checkpoint.targetParent;
    if (!Array.isArray(sources) || !sources.length || !targets || targets.length !== sources.length
      || !receipt || !['published', 'renamed'].includes(checkpoint.phase)) invalid();
    const sourceRoot = sources[0] as EntryView;
    const targetRoot = targets[0] as EntryView;
    const expectedParent = parentRef(targetRoot);
    if (targetParent.kind !== 'directory' || typeof targetParent.identity !== 'string'
      || targetParent.rootId !== expectedParent.rootId || targetParent.path !== expectedParent.path) invalid();
    if (receipt.rootId !== targetRoot.rootId || receipt.path !== targetRoot.path
      || receipt.version !== targetRoot.version || receipt.kind !== targetRoot.kind) invalid();
    if (new Set(sources.map(entry => entry.path)).size !== sources.length || new Set(targets.map(entry => entry.path)).size !== targets.length) invalid();
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index] as EntryView;
      const target = targets[index] as EntryView;
      if (source.rootId !== sourceRoot.rootId || !under(source.path, sourceRoot.path)
        || target.rootId !== targetRoot.rootId || target.path !== targetRoot.path + source.path.slice(sourceRoot.path.length)
        || !['file', 'directory'].includes(source.kind) || target.kind !== source.kind) invalid();
      if (source.kind === 'file') {
        if (typeof source.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(source.sha256) || source.sha256 !== target.sha256
          || source.size !== target.size || !source.version.endsWith(`:${source.sha256}`) || !target.version.endsWith(`:${source.sha256}`)) invalid();
      } else if (!Array.isArray(source.children) || !Array.isArray(target.children)
        || source.children.join('\0') !== target.children.join('\0')) invalid();
    }
    const sourcePaths = new Set(sources.map(entry => entry.path));
    if (!Array.isArray(checkpoint.removed) || new Set(checkpoint.removed).size !== checkpoint.removed.length
      || checkpoint.removed.some(entryPath => !sourcePaths.has(entryPath))) invalid();
    const container = await io.acquireDirectory(targetParent);
    try {
      if (container.entry.identity !== targetParent.identity) fail('VERSION_CONFLICT', 'The published destination container was replaced.', 409);
      await container.verify();
    } finally { await container.close(); }
    const targetManifest = checkpoint.targetManifest as EntryView[];
    await verifyManifest(targetManifest, [], signal, budget);
    for (const entry of targetManifest) {
      if (entry.kind !== 'file' || !entry.sha256) continue;
      const source = await io.openRead({ ...entry, expectedVersion: entry.version, maxBytes: entry.size, signal, budget });
      try {
        const hash = createHash('sha256');
        for await (const chunk of source.stream) hash.update(chunk as Buffer);
        await source.verify();
        if (hash.digest('hex') !== entry.sha256) fail('CHECKSUM_MISMATCH', 'The published destination no longer contains the copied bytes.', 409);
      } finally { await source.close(); }
    }
  }

  /** Run the destination check after source hashing, holding its parent identity chain through unlink/rmdir. */
  async function removeWithTargetProof(source: EntryView, target: EntryView, parents: EntryView[], signal: AbortSignal | undefined, budget: VerificationBudget): Promise<void> {
    const held: Array<Awaited<ReturnType<typeof io.acquireDirectory>>> = [];
    let removed = false;
    let primaryError: FileManagerError | undefined;
    try {
      await io.removeEntry({ ...source, signal, budget, beforeRemove: async () => {
        cancellation(signal);
        for (const parent of parents) {
          const lease = await io.acquireDirectory(parent);
          held.push(lease);
          if (lease.entry.identity !== parent.identity) fail('VERSION_CONFLICT', 'A published destination parent was replaced.', 409, { target: { rootId: target.rootId, path: target.path } });
        }
        const current = await io.stat({ ...target, signal, budget, ...(target.kind === 'file' ? { maxBytes: target.size } : {}) });
        if (current.kind !== target.kind || current.identity !== target.identity || current.version !== target.version
          || (target.kind === 'file' && current.sha256 !== target.sha256)) {
          fail('VERSION_CONFLICT', 'The corresponding published destination changed before source removal.', 409, { target: { rootId: target.rootId, path: target.path } });
        }
        if (target.kind === 'directory') {
          const directory = await io.acquireDirectory(target);
          held.push(directory);
          if (directory.entry.identity !== target.identity) fail('VERSION_CONFLICT', 'The published destination directory was replaced.', 409);
          const children = (await directory.entries()).map(entry => entry.name ?? '').sort();
          if (children.join('\0') !== (target.children ?? []).join('\0')) fail('VERSION_CONFLICT', 'The published destination directory membership changed.', 409);
        }
        for (const lease of held) await lease.verify();
        cancellation(signal);
      } });
      removed = true;
    } catch (error) {
      primaryError = error as FileManagerError;
      throw error;
    } finally {
      const failures: unknown[] = [];
      for (const lease of held.reverse()) {
        try { await lease.close(); } catch (error) { failures.push(error); }
      }
      if (failures.length) {
        if (primaryError) primaryError.details = { ...(primaryError.details ?? {}), targetLeaseCleanupFailed: true };
        else throw new FileManagerError('CLEANUP_FAILED', 'A checked destination lease could not be released.', 500, { removed, targetLeaseCleanupFailed: true });
      }
    }
  }

  async function cleanupSource(task: TaskRecord, item: TaskItem, signal: AbortSignal | undefined, budget: VerificationBudget): Promise<void> {
    const checkpoint = item.checkpoint as TaskCheckpoint;
    const result = item.result as TaskItemResult;
    try {
      cancellation(signal);
      await verifyTarget(checkpoint, signal, budget);
      await verifyManifest(checkpoint.manifest, checkpoint.removed ?? [], signal, budget);
      const targets = new Map(checkpoint.manifest.map((entry, index) => [entry.path, (checkpoint.targetManifest as EntryView[])[index] as EntryView]));
      const directories = new Map((checkpoint.targetManifest as EntryView[]).filter(entry => entry.kind === 'directory').map(entry => [entry.path, entry]));
      directories.set(checkpoint.targetParent.path, checkpoint.targetParent);
      const lineages = new Map<string, EntryView[]>();
      function parentsFor(target: EntryView): EntryView[] {
        const parent = parentRef(target);
        const cached = lineages.get(parent.path);
        if (cached) return cached;
        const parents: EntryView[] = [];
        let current = parent;
        while (true) {
          const proof = directories.get(current.path);
          if (!proof || proof.rootId !== target.rootId) fail('RECOVERY_REQUIRED', 'A published destination parent proof is missing.', 409);
          parents.push(proof);
          if (current.path === checkpoint.targetParent.path) break;
          if (!current.path) fail('RECOVERY_REQUIRED', 'The destination parent proof escaped its publication container.', 409);
          current = parentRef(current);
        }
        parents.reverse();
        lineages.set(parent.path, parents);
        return parents;
      }
      for (const entry of [...checkpoint.manifest].reverse()) {
        if (checkpoint.removed.includes(entry.path)) continue;
        cancellation(signal);
        const target = targets.get(entry.path) as EntryView;
        try { await removeWithTargetProof(entry, target, parentsFor(target), signal, budget); }
        catch (error) {
          if ((error as FileManagerError).details?.removed) checkpoint.removed.push(entry.path);
          throw error;
        }
        checkpoint.removed.push(entry.path);
        result.sourceRemoved = checkpoint.removed.length === checkpoint.manifest.length;
        await save(task);
      }
      result.sourceRemoved = true;
    } catch (error) {
      result.sourceRemoved = checkpoint.removed.length === checkpoint.manifest.length;
      throw new FileManagerError('SOURCE_DELETE_FAILED', 'The destination was published, but source cleanup did not complete. The remaining source entries were retained.', 409,
        { committed: true, sourceRemoved: result.sourceRemoved, bothCopiesExist: checkpoint.removed.length === 0, cause: (error as FileManagerError).code ?? 'IO_ERROR', removedPaths: [...checkpoint.removed] });
    }
  }

  async function copy(task: TaskRecord, item: TaskItem, manifest: EntryView[], destinationPolicy: { overwrite: boolean; expectedVersion?: string }, signal: AbortSignal | undefined, budget: VerificationBudget): Promise<void> {
    const byPath = new Map(manifest.map(entry => [entry.path, entry]));
    const targetContainer = await io.acquireDirectory(parentRef(item.destination));
    async function copyEntry(entry: EntryView, destination: TaskRef, top = false): Promise<EntryView> {
      cancellation(signal);
      const stage = entry.kind === 'directory'
        ? await io.createStagedDirectory({ ...destination, mode: entry.mode, signal, budget })
        : await io.createStagedFile({ ...destination, mode: entry.mode, signal, budget, ...(top ? destinationPolicy : {}) });
      let primaryError: FileManagerError | undefined;
      try {
        let validation: { bytes: number; sha256: string } | undefined;
        if (entry.kind === 'directory') {
          for (const name of entry.children ?? []) await copyEntry(byPath.get(childPath(entry.path, name)) as EntryView, { rootId: (stage.ref as TaskRef).rootId, path: childPath((stage.ref as TaskRef).path, name) });
        } else {
          const source = await io.openRead({ ...entry, expectedVersion: entry.version, maxBytes: bounds.maxFileBytes, signal, budget });
          try {
            const hash = createHash('sha256');
            let bytes = 0;
            for await (const chunk of source.stream) {
              cancellation(signal);
              await stage.write(chunk as Buffer);
              hash.update(chunk as Buffer); bytes += (chunk as Buffer).length;
              item.bytesTransferred += (chunk as Buffer).length;
              notify(task);
            }
            await source.verify();
            entry.sha256 = hash.digest('hex');
            validation = { bytes, sha256: entry.sha256 };
          } finally { await source.close(); }
        }
        if (top) {
          await verifyManifest(manifest, [], signal, budget);
          item.checkpoint = { phase: 'publishing', manifest, removed: [], targetParent: targetContainer.entry };
          await save(task);
          await targetContainer.verify();
        }
        cancellation(signal);
        const receipt = await stage.commit(validation);
        if (top) {
          item.result = { destination: receipt, bytes: item.measured?.bytes ?? 0, sourceRemoved: false, method: task.operation === 'move' ? 'copy-delete' : 'copy' };
          item.checkpoint = { ...(item.checkpoint as TaskCheckpoint), phase: 'published', receipt, targetManifest: await captureTarget(item, manifest, signal, budget) };
          await save(task);
        }
        return receipt;
      } catch (error) {
        primaryError = error as FileManagerError;
        if (top && !primaryError.details?.committed && !item.result) delete item.checkpoint;
        if (top && item.result) primaryError.details = { ...(primaryError.details ?? {}), committed: true };
        throw error;
      } finally {
        try { await stage.abort(); }
        catch (error) {
          if (primaryError) primaryError.details = { ...(primaryError.details ?? {}), cleanupFailed: true, cleanupError: (error as FileManagerError).code ?? 'IO_ERROR' };
          else throw error;
        }
      }
    }
    try {
      await copyEntry(manifest[0] as EntryView, item.destination, true);
      if (task.operation === 'move') await cleanupSource(task, item, signal, budget);
    } finally { await targetContainer.close(); }
  }

  async function execute(task: TaskRecord, item: TaskItem, signal: AbortSignal | undefined, budget: VerificationBudget, measured: MeasuredTree | undefined): Promise<void> {
    cancellation(signal);
    if (item.checkpoint) {
      if (!item.checkpoint.receipt || !item.checkpoint.targetManifest) fail('RECOVERY_REQUIRED', 'A previous publication has an uncertain outcome. Review the source and destination before starting a new task.', 409, { outcomeUncertain: true });
      await verifyTarget(item.checkpoint, signal, budget);
      if (task.operation === 'move' && !item.result?.sourceRemoved) await cleanupSource(task, item, signal, budget);
      return;
    }
    if (!measured) fail('INVALID_STATE', 'The task was not planned before execution.', 500);
    const manifest = await collect(item, signal, budget, measured);
    const destinationPolicy = await resolveDestination(task, item, manifest[0] as EntryView, signal, budget);
    if (destinationPolicy.skip) { item.status = 'skipped'; return; }
    await verifyManifest(manifest, [], signal, budget);
    if (task.operation === 'move') {
      const targetContainer = await io.acquireDirectory(parentRef(item.destination));
      item.checkpoint = { phase: 'renaming', manifest, removed: [], targetParent: targetContainer.entry };
      try {
        await save(task);
        await targetContainer.verify();
        const receipt = await io.renameEntry({
          source: item.source, destination: item.destination, expectedVersion: item.source.expectedVersion,
          overwrite: destinationPolicy.overwrite, expectedTargetVersion: destinationPolicy.expectedVersion, signal,
        });
        item.result = { destination: receipt, bytes: item.measured?.bytes ?? 0, sourceRemoved: true, method: 'rename' };
        item.checkpoint = { phase: 'renamed', manifest, removed: manifest.map(entry => entry.path), receipt, targetParent: targetContainer.entry, targetManifest: await captureTarget(item, manifest, signal, budget) };
        await save(task);
        return;
      } catch (error) {
        const problem = error as FileManagerError;
        if (!problem.details?.committed && !item.result) delete item.checkpoint;
        if (problem.code !== 'EXDEV') throw error;
      } finally { await targetContainer.close(); }
    }
    await copy(task, item, manifest, destinationPolicy, signal, budget);
  }

  async function runTask(task: TaskRecord, signal: AbortSignal): Promise<void> {
    try {
      task.status = 'running';
      await save(task);
      // One verification budget for the whole operation. Every item is planned
      // from metadata first, so a manifest that exceeds the budget is refused
      // before a single byte of content is read.
      const budget = manager.verificationBudget();
      const plans = new Map<string, MeasuredTree>();
      const planErrors = new Map<string, FileManagerError>();
      let plannedBytes = 0;
      for (const item of task.items) {
        if (item.status !== 'pending' || item.checkpoint) continue;
        try {
          const measured = await measureTree(item.source, signal);
          plans.set(item.id, measured);
          plannedBytes += measured.bytes;
        } catch (error) {
          // One unreadable selection fails its own item; it never stops its siblings.
          planErrors.set(item.id, error as FileManagerError);
        }
      }
      let refusal: FileManagerError | undefined;
      try { chargeVerification(budget, plannedBytes); }
      catch (error) { refusal = error as FileManagerError; }
      for (const item of task.items) {
        if (item.status !== 'pending') continue;
        if (signal.aborted) { item.status = 'cancelled'; continue; }
        item.status = 'running'; item.attempts++; item.bytesTransferred = 0;
        delete item.error;
        const statusAfter = (): TaskItem['status'] => item.status;
        try {
          await save(task);
          const planned = planErrors.get(item.id) ?? refusal;
          if (planned) throw planned;
          // Every file-copying step shares the profile-level heavy-IO budget.
          await scheduler.run(() => execute(task, item, signal, budget, plans.get(item.id)));
          if (statusAfter() !== 'skipped') item.status = 'completed';
        } catch (error) {
          const problem = error as FileManagerError;
          if (item.result) problem.details = { ...(problem.details ?? {}), committed: true, sourceRemoved: item.result.sourceRemoved };
          item.error = errorView(error);
          item.status = problem.code === 'CANCELLED' && !item.result && !problem.details?.committed ? 'cancelled' : 'failed';
        }
        await save(task);
      }
      task.status = statusOf(task, signal.aborted);
      await save(task);
    } catch (error) {
      const problem = error as FileManagerError;
      task.persistenceError = errorView(error);
      for (const item of task.items) if (item.status === 'pending' || item.status === 'running') {
        item.status = 'failed'; item.error = { code: 'TASK_PERSISTENCE_FAILED', message: 'Task persistence failed; further filesystem work was stopped.', details: { cause: problem.code ?? 'IO_ERROR' } };
      }
      task.status = task.items.every(item => item.status === 'failed') ? 'failed' : 'partial';
      try { await save(task); } catch { notify(task); }
    }
  }

  function pump(): void {
    while (!stopped && active.size < bounds.concurrency && waiting.length) {
      const task = waiting.shift() as TaskRecord;
      if (task.status !== 'queued') continue;
      const controller = new AbortController();
      const run: ActiveRun = { controller, promise: Promise.resolve() };
      active.set(task.id, run);
      run.promise = runTask(task, controller.signal).finally(() => {
        active.delete(task.id);
        notify(tasks.get(task.id) ?? task);
        pump();
      });
    }
  }

  function schedule(task: TaskRecord): void { waiting.push(task); queueMicrotask(pump); }

  async function list(): Promise<PublicTaskView[]> { await ready; return [...tasks.values()].map(view); }
  async function get({ taskId }: { taskId?: unknown } = {}): Promise<PublicTaskView> { await ready; return view(taskOf(taskId)); }

  async function cancel({ taskId }: { taskId?: unknown } = {}): Promise<PublicTaskView> {
    accepting(); await ready;
    const task = taskOf(taskId);
    if (terminalStates.has(task.status)) return view(task);
    const run = active.get(task.id);
    if (run) run.controller.abort();
    else {
      for (const item of task.items) if (item.status === 'pending') item.status = 'cancelled';
      task.status = 'cancelled';
    }
    task.cancelRequested = true;
    await save(task);
    return view(task);
  }

  async function dismiss({ taskId, expectedHistoryRevision }: { taskId?: unknown; expectedHistoryRevision?: unknown } = {}): Promise<PublicTaskView> {
    accepting(); await ready;
    const current = taskOf(taskId);
    if (current.dismissed) {
      // Already hidden: a repeated close is idempotent, so the caller's revision
      // is irrelevant. It must still never bypass a metadata lock — a retry that
      // is committing its own revision has to finish first.
      if (!quiescent(current)) fail('TASK_BUSY', 'Wait for the task and its metadata changes to finish before dismissing it.', 409);
      return view(current);
    }
    // Still visible: a stale revision is the actionable problem — reloading is
    // what prevents an old close action from hiding a newer execution.
    if (expectedHistoryRevision !== current.historyRevision) fail('TASK_CHANGED', 'The task history changed; reload it before dismissing.', 409);
    if (!quiescent(current)) fail('TASK_BUSY', 'Wait for the task and its metadata changes to finish before dismissing it.', 409);
    const candidate = structuredClone(current);
    candidate.historyRevision = nextHistoryRevision(current);
    candidate.dismissed = true;
    historyUpdates.add(current.id);
    notify(current);
    try {
      await save(candidate, false);
      tasks.set(current.id, candidate);
    } finally {
      historyUpdates.delete(current.id);
      notify(taskOf(current.id));
    }
    return view(taskOf(current.id));
  }

  async function retry({ taskId, items: patches = [] }: { taskId?: unknown; items?: unknown } = {}): Promise<PublicTaskView> {
    accepting(); await ready;
    const task = structuredClone(taskOf(taskId));
    if (!quiescent(task)) fail('TASK_BUSY', 'Wait for the task and its metadata changes to finish before retrying failed items.', 409);
    const failed = task.items.filter(item => item.status === 'failed');
    if (!failed.length) fail('NO_FAILED_ITEMS', 'Only failed items can be retried.', 409);
    if (!Array.isArray(patches)) fail('INVALID_REQUEST', 'Retry item patches must be an array.');
    const seen = new Set<string>();
    for (const patch of patches as Array<Record<string, unknown>>) {
      const item = failed.find(candidate => candidate.id === patch?.id);
      if (!item || seen.has(item.id)) fail('INVALID_REQUEST', 'Retry patches must refer to distinct failed items.');
      seen.add(item.id);
      if (Object.keys(patch).some(key => !['id', 'conflict', 'name', 'expectedTargetVersion', 'expectedVersion'].includes(key))) fail('INVALID_REQUEST', 'A retry cannot change the source selection.');
      if (item.checkpoint && Object.keys(patch).some(key => key !== 'id')) fail('RECOVERY_REQUIRED', 'A published item cannot be retargeted or given a different source version.', 409);
      if (patch.conflict !== undefined && !policies.has(patch.conflict as string)) fail('INVALID_REQUEST', 'An item conflict strategy is invalid.');
      if (patch.name !== undefined) nameOf(patch.name);
      if (patch.expectedVersion !== undefined) versionOf(patch.expectedVersion);
    }
    for (const patch of patches as Array<Record<string, unknown>>) {
      const item = failed.find(candidate => candidate.id === patch.id) as TaskItem;
      if (patch.conflict !== undefined) item.conflict = patch.conflict as string;
      if (patch.name !== undefined) item.name = patch.name as string;
      if (patch.expectedTargetVersion !== undefined) item.expectedTargetVersion = patch.expectedTargetVersion as string;
      if (patch.expectedVersion !== undefined) item.source.expectedVersion = patch.expectedVersion as string;
    }
    for (const item of failed) { item.status = 'pending'; delete item.error; }
    delete task.cancelRequested; delete task.persistenceError;
    task.historyRevision = nextHistoryRevision(task);
    task.dismissed = false;
    task.status = 'queued';
    requeuing.add(task.id);
    notify(taskOf(task.id));
    try {
      await save(task, false);
      tasks.set(task.id, task);
      schedule(task);
      return view(task);
    } finally {
      requeuing.delete(task.id);
      notify(taskOf(task.id));
    }
  }

  function controlled<T>(operation: () => Promise<T>): Promise<T> {
    if (stopped) return Promise.reject(new FileManagerError('SERVICE_STOPPED', 'The task service is stopping.', 503));
    const result = operation();
    controls.add(result);
    result.then(() => controls.delete(result), () => controls.delete(result));
    return result;
  }

  function close(): Promise<void> {
    if (closingPromise) return closingPromise;
    stopped = true;
    for (const run of active.values()) run.controller.abort();
    closingPromise = (async () => {
      await Promise.allSettled([...controls]);
      await ready;
      for (const task of waiting.splice(0)) {
        for (const item of task.items) if (item.status === 'pending') item.status = 'cancelled';
        task.status = 'cancelled';
        await save(task);
      }
      await Promise.all([...active.values()].map(run => run.promise));
      await persistenceTail;
    })();
    return closingPromise;
  }

  return {
    start: input => controlled(() => start(input)), list, get,
    cancel: input => controlled(() => cancel(input)), retry: input => controlled(() => retry(input)),
    dismiss: input => controlled(() => dismiss(input)), close,
  };
}
