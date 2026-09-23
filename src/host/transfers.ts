import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ZipFile } from 'yazl';
import { FileManagerError, fail, normalizeError } from '../contracts/errors.js';
import { HEAVY_IO_QUEUE_LIMIT, LIMIT_DEFAULTS } from '../contracts/limits.js';
import type { TaskItemStatus, TaskStatus } from '../contracts/views.js';
import { toPublicTransfer } from '../contracts/views.js';
import { chargeVerification, type EntryView, type VerificationBudget } from './io.js';
import type { Manager } from './manager.js';
import { createHeavyIoScheduler, type HeavyIoPermit, type HeavyIoScheduler } from './scheduler.js';

export interface TransferLimits {
  maxFileBytes: number;
  maxTaskBytes: number;
  maxTaskEntries: number;
  transferConcurrency: number;
}

export const DEFAULT_TRANSFER_LIMITS: Readonly<TransferLimits> = Object.freeze({
  maxFileBytes: LIMIT_DEFAULTS.maxFileBytes,
  maxTaskBytes: LIMIT_DEFAULTS.maxTaskBytes,
  maxTaskEntries: LIMIT_DEFAULTS.maxTaskEntries,
  transferConcurrency: LIMIT_DEFAULTS.transferConcurrency,
});

const unfinished = (status: TaskItemStatus): boolean => status === 'pending' || status === 'running';
const terminalStatuses = new Set<TaskStatus>(['completed', 'partial', 'failed', 'cancelled', 'interrupted']);

function nextHistoryRevision(task: { historyRevision: number }): number {
  if (task.historyRevision >= Number.MAX_SAFE_INTEGER) fail('HISTORY_REVISION_EXHAUSTED', 'The task history revision cannot advance safely.', 409);
  return task.historyRevision + 1;
}

const cancelled = (signal: AbortSignal | undefined): void => { if (signal?.aborted) fail('CANCELLED', 'The transfer was cancelled.', 499); };
const absent = (error: unknown): void => { const code = (error as NodeJS.ErrnoException).code; if (code !== 'ENOENT' && code !== 'NOT_FOUND') throw error; };
const join = (parent: string, child: string): string => parent ? `${parent}/${child}` : child;

/** One persisted error record; projected through `views.toPublicError` on the wire. */
export interface PublicErrorRecord {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export type TransferConflict = 'error' | 'skip' | 'overwrite';

export interface TransferItem {
  id: string;
  path: string;
  archivePath?: string | undefined;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  /** Selection version; strong for files once fingerprinted, weak for directories. */
  version?: string | undefined;
  identity?: string | undefined;
  mode?: number | undefined;
  modifiedAt?: string | undefined;
  status: TaskItemStatus;
  bytesTransferred: number;
  committed: boolean;
  conflict?: TransferConflict | undefined;
  expectedVersion?: string | undefined;
  sha256?: string | undefined;
  error?: PublicErrorRecord | undefined;
}

export interface TransferTask {
  id: string;
  type: 'transfer';
  direction: 'upload' | 'download';
  rootId: string;
  path: string;
  status: TaskStatus;
  dismissed: boolean;
  historyRevision: number;
  createdAt: number;
  updatedAt: number;
  bytesTransferred: number;
  bytesTotal: number;
  itemsTotal: number;
  itemsCompleted: number;
  items: TransferItem[];
  destinationIdentity?: string | undefined;
  downloadKind?: 'zip' | 'file' | undefined;
  downloadName?: string | undefined;
  wireBytesTransferred?: number | undefined;
  completion?: 'server-stream-finished' | undefined;
  cancelRequested?: boolean | undefined;
  error?: PublicErrorRecord | undefined;
  /** Derived, never persisted. */
  canDismiss?: boolean | undefined;
}

interface TransferRuntime {
  controller: AbortController;
  inFlight: Map<string, Promise<unknown>>;
  directories: Map<string, Promise<void>>;
  cancelled: boolean;
  lastProgress: number | null;
  retrying: Promise<unknown> | null;
  dismissing: boolean;
  cancelling: number;
  pendingWrites: number;
  downloadFinishing: boolean;
  cancelDuringRetry: boolean;
  /** One verification budget per transfer operation. */
  budget: VerificationBudget;
}

export interface TransferServiceOptions {
  manager: Manager;
  limits?: Partial<TransferLimits> | undefined;
  initialTasks?: readonly TransferTask[] | undefined;
  persistTasks?: ((records: TransferTask[]) => Promise<void>) | undefined;
  onProgress?: ((task: TransferTask) => unknown) | undefined;
  now?: (() => number) | undefined;
  /** Shared heavy-IO budget; a private one is created when the Host does not pass one. */
  scheduler?: HeavyIoScheduler | undefined;
}

export interface TransferBeginInput {
  op?: string | undefined;
  direction?: unknown;
  rootId?: unknown;
  path?: unknown;
  expectedVersion?: unknown;
  items?: unknown;
  taskId?: unknown;
}

export interface TransferService {
  begin(input?: TransferBeginInput, requestSignal?: AbortSignal): Promise<TransferTask>;
  control(input?: TransferBeginInput, requestSignal?: AbortSignal): Promise<unknown>;
  handleUpload(request: Request): Promise<Response>;
  handleDownload(request: Request): Promise<Response>;
  list(): TransferTask[];
  get(id: unknown): TransferTask;
  cancel(id: unknown): Promise<TransferTask>;
  retry(id: unknown): Promise<TransferTask>;
  dismiss(input?: { taskId?: unknown; expectedHistoryRevision?: unknown }): Promise<TransferTask>;
  close(): Promise<void>;
}

function relativePath(value: unknown, allowRoot = false): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f\\]/.test(value)
    || /^[A-Za-z]:/.test(value) || /[\uD800-\uDFFF]/u.test(value)) fail('INVALID_PATH', 'Expected a safe root-relative path.');
  if (value === '' && allowRoot) return value;
  if (value.split('/').some(part => !part || part === '.' || part === '..')) fail('INVALID_PATH', 'Empty and dot path segments are not allowed.');
  return value;
}

function manifest(sources: unknown, limits: TransferLimits): TransferItem[] {
  if (!Array.isArray(sources) || !sources.length) fail('INVALID_MANIFEST', 'A nonempty upload manifest is required.');
  if (sources.length > limits.maxTaskEntries) fail('TOO_LARGE', 'The task exceeds its entry limit.', 413);
  const explicit = new Set<string>();
  const items = new Map<string, Omit<TransferItem, 'id' | 'status' | 'bytesTransferred' | 'committed'>>();
  let bytes = 0;
  for (const source of sources as Array<Record<string, unknown>>) {
    if (!source || typeof source !== 'object') fail('INVALID_MANIFEST', 'Every manifest entry must be an object.');
    const name = relativePath(source.path);
    if (explicit.has(name)) fail('INVALID_MANIFEST', 'Duplicate upload paths are not allowed.');
    explicit.add(name);
    if (!['file', 'directory'].includes(source.kind as string)) fail('UNSUPPORTED_ENTRY', 'Only files and directories can be uploaded.', 422);
    const kind = source.kind as 'file' | 'directory';
    const size = kind === 'directory' ? 0 : source.size as number;
    if (!Number.isSafeInteger(size) || size < 0) fail('INVALID_MANIFEST', 'Each file requires its exact nonnegative byte size.');
    bytes += size;
    if (size > limits.maxFileBytes || bytes > limits.maxTaskBytes) fail('TOO_LARGE', 'The manifest exceeds its byte limit.', 413);
    const conflict = (source.conflict ?? 'error') as TransferConflict;
    if (!['error', 'skip', 'overwrite'].includes(conflict) || (kind === 'directory' && conflict === 'overwrite')) fail('INVALID_MANIFEST', 'Directories cannot be overwritten or merged.');
    if (conflict === 'overwrite' && (typeof source.expectedVersion !== 'string' || !source.expectedVersion)) fail('VERSION_REQUIRED', 'Overwrite requires the expected destination version.', 409);
    if (items.has(name) && items.get(name)?.kind !== kind) fail('INVALID_MANIFEST', 'A file cannot be an ancestor of another item.');
    const segments = name.split('/');
    for (let index = 1; index < segments.length; index++) {
      const parent = segments.slice(0, index).join('/');
      if (items.get(parent)?.kind === 'file') fail('INVALID_MANIFEST', 'A file cannot be an ancestor of another item.');
      if (!items.has(parent)) items.set(parent, { path: parent, kind: 'directory', size: 0, conflict: 'error' });
    }
    items.set(name, {
      path: name, kind, size, conflict,
      ...(typeof source.expectedVersion === 'string' ? { expectedVersion: source.expectedVersion } : {}),
    });
    if (items.size > limits.maxTaskEntries) fail('TOO_LARGE', 'The task including inferred directories exceeds its entry limit.', 413);
  }
  return [...items.values()]
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length)
    .map(item => ({ ...item, id: randomUUID(), status: 'pending' as const, bytesTransferred: 0, committed: false }));
}

/** Normalize any thrown value into the transfer profile's stable failure. */
function failure(error: unknown): FileManagerError {
  if (error instanceof FileManagerError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const mapping: Record<string, [string, number, string]> = {
    ENOENT: ['NOT_FOUND', 404, 'The selected entry no longer exists.'],
    EACCES: ['PERMISSION_DENIED', 403, 'The filesystem denied the transfer.'],
    EPERM: ['PERMISSION_DENIED', 403, 'The filesystem denied the transfer.'],
    ENOTDIR: ['NOT_DIRECTORY', 422, 'A path component is not a directory.'],
    ELOOP: ['UNSUPPORTED_ENTRY', 422, 'Symbolic links are not followed.'],
    EEXIST: ['ALREADY_EXISTS', 409, 'The destination already exists.'],
    ENOSPC: ['NO_SPACE', 507, 'The destination has no space available.'],
    EDQUOT: ['NO_SPACE', 507, 'The destination quota is exhausted.'],
    ABORT_ERR: ['CANCELLED', 499, 'The transfer was cancelled.'],
  };
  const [mappedCode, status, message] = mapping[code ?? ''] ?? ['IO_ERROR', 500, 'The transfer failed.'];
  const source = (error as FileManagerError | undefined)?.details;
  const details: Record<string, unknown> = {};
  if (source?.committed === true) details.committed = true;
  if (source?.cleanupFailed === true) details.cleanupFailed = true;
  if (typeof source?.stagingName === 'string') details.stagingName = source.stagingName;
  return new FileManagerError(mappedCode, message, status, details);
}

const errorDTO = (error: FileManagerError): PublicErrorRecord => ({ code: error.code, message: error.message, details: error.details ?? {} });

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

function discardBody(request: Request): void { request.body?.cancel().catch(() => {}); }

/** Read one bounded chunk at a time. Abort cancels even a currently blocked read. */
async function consume(request: Request, signal: AbortSignal, consumeChunk: (chunk: Buffer) => Promise<void> | void): Promise<void> {
  cancelled(signal);
  if (!request.body) return;
  const reader = request.body.getReader();
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  let ended = false;
  try {
    cancelled(signal);
    while (true) {
      const { done, value } = await reader.read();
      cancelled(signal);
      if (done) { ended = true; break; }
      if (!(value instanceof Uint8Array)) fail('INVALID_REQUEST', 'The upload body must contain bytes.');
      await consumeChunk(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Host integration (routes/authentication and requestId ledger belong to caller):
 * - begin({direction:'upload', rootId, path, items:[{path,kind,size,conflict?,expectedVersion?}]})
 * - begin({direction:'download', rootId, path, expectedVersion?})
 * - control({op:'transfers.begin|list|get|cancel|retry|dismiss', ...}) returns plain DTOs.
 * - dismiss({taskId,expectedHistoryRevision}) hides only fully stopped history.
 * - Public dismissed/historyRevision/canDismiss never replace raw recovery records;
 *   canDismiss is derived and never persisted. Accepted retries reopen a new revision.
 * - handleUpload: POST ?taskId=&itemId=, raw body; directories have empty bodies.
 * - handleDownload: GET ?taskId=, raw file or streaming stored ZIP response.
 *
 * Only manager capabilities touch content; no root absolute path is consumed.
 * Every heavy step shares one scheduler: uploads, downloads, archive streaming and
 * strong fingerprint planning all wait for the same profile-level permits.
 */
export function createTransferService(options: TransferServiceOptions): TransferService {
  const { manager, initialTasks = [], persistTasks = async () => {}, onProgress = () => {}, now = Date.now } = options;
  const limits = { ...DEFAULT_TRANSFER_LIMITS, ...(options.limits ?? {}) };
  for (const key of Object.keys(DEFAULT_TRANSFER_LIMITS) as Array<keyof TransferLimits>) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) fail('INVALID_STATE', `Invalid transfer limit: ${key}.`, 500);
  }
  const scheduler = options.scheduler ?? createHeavyIoScheduler({ concurrency: limits.transferConcurrency, queueLimit: HEAVY_IO_QUEUE_LIMIT });
  const tasks = new Map<string, TransferTask>();
  const runtimes = new Map<string, TransferRuntime>();
  const planning = new Set<Promise<unknown>>();
  const controls = new Set<Promise<unknown>>();
  const lifetime = new AbortController();
  let closed = false;
  let closing: Promise<void> | undefined;
  let stateTail: Promise<unknown> = Promise.resolve();
  for (const saved of initialTasks) {
    const task = structuredClone(saved) as TransferTask;
    if (!task || typeof task.id !== 'string' || !Array.isArray(task.items) || tasks.has(task.id)) fail('INVALID_STATE', 'Stored transfer tasks are invalid.', 500);
    if ((task.dismissed !== undefined && typeof task.dismissed !== 'boolean')
      || (task.historyRevision !== undefined && (!Number.isSafeInteger(task.historyRevision) || task.historyRevision < 0))) {
      fail('INVALID_STATE', 'Stored transfer history metadata is invalid.', 500);
    }
    task.dismissed ??= false;
    task.historyRevision ??= 0;
    delete task.canDismiss;
    if (['queued', 'running'].includes(task.status)) {
      task.status = 'interrupted';
      task.error = { code: 'INTERRUPTED', message: 'The Host stopped before this transfer completed.', details: {} };
      for (const item of task.items) if (unfinished(item.status)) { item.status = 'failed'; item.error = { ...task.error }; }
    }
    tasks.set(task.id, task);
  }
  // Durable snapshots always contain complete raw records, never public projections.
  const rawSnapshot = (): TransferTask[] => [...tasks.values()].map(task => structuredClone(task));

  function historyBusy(task: TransferTask): boolean {
    const state = runtime(task);
    return Boolean(closed || state.inFlight.size || state.directories.size || state.retrying || state.dismissing
      || state.cancelling || state.pendingWrites || state.downloadFinishing);
  }

  /** Service-level snapshot: the raw record plus the derived `canDismiss`. */
  function view(task: TransferTask): TransferTask {
    return {
      ...structuredClone(task),
      canDismiss: !task.dismissed && terminalStatuses.has(task.status)
        && !task.items.some(item => unfinished(item.status)) && !historyBusy(task),
    };
  }

  const list = (): TransferTask[] => [...tasks.values()].map(view);

  function taskOf(id: unknown): TransferTask {
    const task = tasks.get(id as string);
    if (!task) fail('TASK_NOT_FOUND', 'The transfer task is no longer available.', 404);
    return task;
  }

  const get = (id: unknown): TransferTask => view(taskOf(id));
  function available(): void { if (closed) fail('SERVICE_STOPPED', 'The transfer service is stopping.', 503); }

  function runtime(task: TransferTask): TransferRuntime {
    let state = runtimes.get(task.id);
    if (!state) {
      state = {
        controller: new AbortController(), inFlight: new Map(), directories: new Map(), cancelled: false,
        lastProgress: null, retrying: null, dismissing: false, cancelling: 0, pendingWrites: 0,
        downloadFinishing: false, cancelDuringRetry: false, budget: manager.verificationBudget(),
      };
      runtimes.set(task.id, state);
    }
    return state;
  }

  function notify(task: TransferTask): void {
    try { Promise.resolve(onProgress(view(task))).catch(() => {}); }
    catch { /* Observers are not part of the publication transaction. */ }
  }

  function stateOperation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = stateTail.then(operation);
    stateTail = pending.catch(() => {});
    return pending;
  }

  function trackControl<T>(promise: Promise<T>): Promise<T> {
    controls.add(promise);
    promise.then(() => controls.delete(promise), () => controls.delete(promise));
    return promise;
  }

  async function persist(task: TransferTask): Promise<void> {
    task.updatedAt = now();
    const state = runtime(task);
    state.pendingWrites++;
    try { await stateOperation(() => persistTasks(rawSnapshot())); }
    finally { state.pendingWrites--; }
    notify(task);
  }

  function summarize(task: TransferTask, cancelledOverride?: boolean): void {
    task.itemsCompleted = task.items.filter(item => item.status === 'completed').length;
    const state = runtime(task);
    if (cancelledOverride ?? state.cancelled) task.status = 'cancelled';
    else if (task.direction === 'download' && state.inFlight.size && !state.downloadFinishing) task.status = 'running';
    else if (task.items.some(item => item.status === 'running')) task.status = 'running';
    else if (task.items.some(item => item.status === 'pending')) task.status = 'queued';
    else if (task.items.some(item => ['failed', 'cancelled'].includes(item.status))) task.status = task.items.some(item => item.committed || item.status === 'completed') ? 'partial' : 'failed';
    else task.status = 'completed';
    task.updatedAt = now();
  }

  const acquire = (signal: AbortSignal): Promise<HeavyIoPermit> => scheduler.acquire({ signal });
  const itemRef = (task: TransferTask, item: TransferItem) => ({ rootId: task.rootId, path: join(task.path, item.path) });

  const entryRef = (rootId: string, relativePathValue: string) => ({ rootId, path: relativePathValue });

  async function prepareDownload(input: TransferBeginInput, selected: string, signal: AbortSignal, budget: VerificationBudget): Promise<{
    items: TransferItem[]; downloadKind: 'zip' | 'file'; downloadName: string;
  }> {
    const rootId = String(input.rootId);
    const entry = await manager.io.stat({ rootId: input.rootId, path: selected, maxBytes: Math.min(limits.maxFileBytes, limits.maxTaskBytes), signal });
    if (input.expectedVersion !== undefined && entry.version !== input.expectedVersion) fail('VERSION_CONFLICT', 'The source changed after it was selected.', 409);
    const base = selected.split('/').at(-1) || manager.listRoots().find(root => root.id === input.rootId)?.label || 'download';
    relativePath(base);
    const items: TransferItem[] = [];
    let total = 0;
    // Pass one reads no file content: it only enumerates the tree, so the whole
    // manifest is known (and charged) before any hashing starts.
    async function measure(current: EntryView, archivePath: string): Promise<void> {
      available(); cancelled(signal);
      relativePath(current.path, true); relativePath(archivePath);
      if (!['file', 'directory'].includes(current.kind)) fail('UNSUPPORTED_ENTRY', 'The selected tree contains a link or special entry; it cannot be archived.', 422);
      const size = current.kind === 'file' ? current.size : 0;
      if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes || total + size > limits.maxTaskBytes || items.length >= limits.maxTaskEntries) fail('TOO_LARGE', 'The download exceeds its byte or entry limit.', 413);
      total += size;
      items.push({
        id: randomUUID(), path: current.path, archivePath, kind: current.kind, size,
        version: current.version, identity: current.identity, mode: current.mode, modifiedAt: current.modifiedAt,
        status: 'pending', bytesTransferred: 0, committed: false,
      });
      if (current.kind === 'directory') {
        const lease = await manager.io.acquireDirectory({ rootId: input.rootId, path: current.path });
        let children: EntryView[];
        try {
          cancelled(signal);
          if (lease.entry.version !== current.version) fail('VERSION_CONFLICT', 'The directory changed during download planning.', 409);
          const listing = await lease.listing();
          // A name the grammar cannot express must fail this directory item
          // loudly instead of silently archiving less than the user selected.
          if (listing.unaddressable.length) {
            fail('UNREPRESENTABLE_REFERENCE', 'This directory contains an entry name that cannot be represented safely by the current path grammar; it cannot be archived.', 422);
          }
          children = listing.entries;
          if (items.length + children.length > limits.maxTaskEntries) fail('TOO_LARGE', 'The download exceeds its entry limit.', 413);
        } finally { await lease.close(); }
        for (const child of children) await measure(child, `${archivePath}/${child.name}`);
        if ((await manager.io.stat({ ...entryRef(rootId, current.path), metadataOnly: true })).version !== current.version) fail('VERSION_CONFLICT', 'The directory changed during download planning.', 409);
      }
    }
    await measure(entry, base);
    chargeVerification(budget, total);
    // Pass two promotes every file to a content-bound version, bounded by the
    // size the plan observed; never reinterpret or truncate version strings.
    for (const item of items) {
      cancelled(signal);
      if (item.kind !== 'file') continue;
      const strong = await manager.io.stat({ ...entryRef(rootId, item.path), maxBytes: item.size, signal, budget, expectedVersion: item.version });
      if (strong.kind !== 'file' || strong.identity !== item.identity || strong.size !== item.size) fail('VERSION_CONFLICT', 'An archive member changed during fingerprint planning.', 409);
      item.version = strong.version; item.sha256 = strong.sha256; item.mode = strong.mode; item.modifiedAt = strong.modifiedAt;
    }
    return { items, downloadKind: entry.kind === 'directory' ? 'zip' : 'file', downloadName: entry.kind === 'directory' ? `${base}.zip` : base };
  }

  async function begin(input: TransferBeginInput = {}, requestSignal?: AbortSignal): Promise<TransferTask> {
    available();
    const signal = requestSignal ? AbortSignal.any([lifetime.signal, requestSignal]) : lifetime.signal;
    const pending = beginTask(input, signal);
    planning.add(pending);
    try { return await pending; }
    finally { planning.delete(pending); }
  }

  async function beginTask(input: TransferBeginInput, signal: AbortSignal): Promise<TransferTask> {
    available(); cancelled(signal);
    // One verification budget for this whole transfer operation.
    const budget = manager.verificationBudget();
    if (!['upload', 'download'].includes(input.direction as string)) fail('INVALID_REQUEST', 'Expected an upload or download direction.');
    const direction = input.direction as 'upload' | 'download';
    const destination = relativePath(input.path ?? '', true);
    let items: TransferItem[];
    let downloadInfo: Partial<TransferTask> = {};
    if (direction === 'upload') {
      items = manifest(input.items, limits);
      for (const item of items) relativePath(join(destination, item.path));
      const container = await manager.io.stat({ rootId: input.rootId, path: destination, signal });
      if (container.kind !== 'directory') fail('NOT_DIRECTORY', 'The upload destination must be a directory.', 422);
      downloadInfo = { destinationIdentity: container.identity };
      // The declared manifest total is charged before any body is accepted.
      chargeVerification(budget, items.reduce((sum, item) => sum + item.size, 0));
    } else {
      const permit = await acquire(signal);
      try {
        const prepared = await prepareDownload(input, destination, signal, budget);
        items = prepared.items;
        downloadInfo = { downloadKind: prepared.downloadKind, downloadName: prepared.downloadName };
      } finally { permit.release(); }
    }
    const task: TransferTask = {
      id: randomUUID(), type: 'transfer', direction,
      rootId: String(input.rootId), path: destination, status: 'queued', dismissed: false, historyRevision: 0,
      createdAt: now(), updatedAt: now(), bytesTransferred: 0,
      bytesTotal: items.reduce((sum, item) => sum + item.size, 0),
      itemsTotal: items.length, itemsCompleted: 0, items, ...downloadInfo,
    };
    runtime(task).budget = budget;
    await stateOperation(async () => {
      available();
      await persistTasks([...rawSnapshot(), structuredClone(task)]);
      tasks.set(task.id, task);
      if (closed) {
        runtime(task).cancelled = true;
        for (const item of task.items) item.status = 'cancelled';
        summarize(task);
        await persistTasks(rawSnapshot());
      }
    });
    notify(task);
    return get(task.id);
  }

  function recordFailure(item: TransferItem, error: unknown): FileManagerError {
    const problem = failure(error);
    item.status = problem.code === 'CANCELLED' ? 'cancelled' : 'failed';
    item.committed ||= problem.details?.committed === true;
    item.error = errorDTO(problem);
    return problem;
  }

  async function finish(task: TransferTask, item: TransferItem | undefined, error: unknown): Promise<FileManagerError | undefined> {
    let problem = error ? recordFailure(item as TransferItem, error) : undefined;
    summarize(task);
    try { await persist(task); }
    catch (storageError) {
      const details: Record<string, unknown> = { committed: item?.committed, cause: failure(storageError).code };
      if (problem) problem.details = { ...problem.details, persistenceFailed: true, ...details };
      else problem = new FileManagerError('PERSISTENCE_FAILED', 'The transfer receipt could not be persisted; committed content was not rolled back.', 500, details);
      recordFailure(item as TransferItem, problem);
      if (task.direction === 'download') { delete task.completion; task.error = errorDTO(problem); }
      summarize(task); notify(task);
    }
    return problem;
  }

  function skipTree(task: TransferTask, parent: TransferItem): void {
    for (const item of task.items) if ((item === parent || item.path.startsWith(`${parent.path}/`)) && !item.committed) {
      item.status = 'skipped'; delete item.error;
    }
  }

  async function verifyDestination(task: TransferTask): Promise<void> {
    const current = await manager.io.stat({ rootId: task.rootId, path: task.path });
    if (current.kind !== 'directory' || !task.destinationIdentity || current.identity !== task.destinationIdentity) fail('PATH_CHANGED', 'The upload destination directory was replaced.', 409);
  }

  async function verifyOwned(task: TransferTask, item: TransferItem): Promise<void> {
    const current = await manager.io.stat(itemRef(task, item));
    if (current.kind !== 'directory' || !item.identity || current.identity !== item.identity) fail('PATH_CHANGED', 'An uploaded parent directory was replaced.', 409);
  }

  async function parents(task: TransferTask, item: TransferItem, signal: AbortSignal, create: boolean): Promise<boolean> {
    const parts = item.path.split('/');
    for (let index = 1; index < parts.length; index++) {
      cancelled(signal);
      const parent = task.items.find(value => value.path === parts.slice(0, index).join('/')) as TransferItem;
      if (create) await ensureDirectory(task, parent, signal);
      else await verifyOwned(task, parent);
      if (parent.status === 'skipped') { item.status = 'skipped'; return false; }
    }
    return true;
  }

  function completed(item: TransferItem, receipt: EntryView): void {
    item.status = 'completed'; item.committed = true;
    item.version = receipt.version; item.identity = receipt.identity;
    if (receipt.sha256) item.sha256 = receipt.sha256;
    delete item.error;
  }

  async function cleanupStage(stage: { abort(): Promise<void> } | undefined, error: FileManagerError | undefined, committed: boolean): Promise<FileManagerError | undefined> {
    try { await stage?.abort(); return error; }
    catch (cleanupError) {
      const cleanup = cleanupError as FileManagerError;
      const details = { ...(error?.details ?? {}), ...(cleanup?.details ?? {}), cleanupFailed: true, committed: committed || error?.details?.committed === true };
      return new FileManagerError(error?.code ?? 'CLEANUP_FAILED', error?.message ?? 'Owned staging could not be cleaned.', error?.status ?? 500, details);
    }
  }

  async function ensureDirectory(task: TransferTask, item: TransferItem, signal: AbortSignal): Promise<void> {
    const state = runtime(task);
    const existingWork = state.directories.get(item.id);
    if (existingWork) return existingWork;
    if (item.status === 'completed') return verifyOwned(task, item);
    if (item.status === 'skipped') return;
    if (!unfinished(item.status)) {
      // A persisted item error may be a legacy bare errno; it is normalized
      // before it can reach the wire.
      if (item.error) {
        const failure = normalizeError(item.error, { profile: 'transfer' });
        throw new FileManagerError(failure.code, failure.message, 409, failure.details);
      }
      fail('ITEM_NOT_READY', 'Retry the parent directory first.', 409);
    }
    const work = (async () => {
      let stage: { commit(): Promise<EntryView>; abort(): Promise<void> } | undefined;
      let problem: FileManagerError | undefined;
      try {
        cancelled(signal);
        item.status = 'running'; summarize(task); await persist(task);
        const existing = await manager.io.stat({ ...itemRef(task, item), signal }).catch(absent as (error: unknown) => undefined);
        if (existing) {
          if (item.conflict !== 'skip') fail('ALREADY_EXISTS', 'An upload directory already exists; directory merging is not allowed.', 409);
          skipTree(task, item);
        } else {
          await verifyDestination(task);
          stage = await manager.io.createStagedDirectory({ ...itemRef(task, item), signal });
          cancelled(signal); await verifyDestination(task);
          completed(item, await stage.commit());
        }
      } catch (error) { problem = failure(error); }
      finally {
        problem = await cleanupStage(stage, problem, item.committed);
        problem = await finish(task, item, problem);
      }
      if (problem) throw problem;
    })();
    state.directories.set(item.id, work);
    try { await work; }
    finally { state.directories.delete(item.id); }
  }

  function account(task: TransferTask, item: TransferItem, bytes: number): void {
    if (item.bytesTransferred + bytes > limits.maxFileBytes || task.bytesTransferred + bytes > limits.maxTaskBytes) fail('TOO_LARGE', 'The received bytes exceed the transfer limit.', 413);
    if (item.bytesTransferred + bytes > item.size) fail('SIZE_MISMATCH', 'The upload is larger than its declared byte size.', 400);
    item.bytesTransferred += bytes; task.bytesTransferred += bytes;
  }

  function progress(task: TransferTask, item: TransferItem, firstChunk = false): void {
    const state = runtime(task);
    if (firstChunk || state.lastProgress === null || now() - state.lastProgress >= 100 || item.bytesTransferred === item.size) {
      state.lastProgress = now(); task.updatedAt = now(); notify(task);
    }
  }

  async function upload(task: TransferTask, item: TransferItem, request: Request, signal: AbortSignal): Promise<FileManagerError | undefined> {
    let permit: HeavyIoPermit | undefined;
    let stage: { write(chunk: Uint8Array): Promise<void>; commit(validation?: { bytes?: number; sha256?: string }): Promise<EntryView>; abort(): Promise<void> } | undefined;
    let problem: FileManagerError | undefined;
    async function receive(): Promise<void> {
      if (!await parents(task, item, signal, true)) { discardBody(request); return; }
      if (item.status === 'skipped') { discardBody(request); return; }
      if (item.kind === 'directory') {
        await consume(request, signal, bytes => { if (bytes.length) fail('INVALID_REQUEST', 'Directory upload bodies must be empty.'); });
        await ensureDirectory(task, item, signal);
        return;
      }
      item.status = 'running'; summarize(task); await persist(task);
      const existing = await manager.io.stat({ ...itemRef(task, item), signal }).catch(absent as (error: unknown) => undefined);
      if (existing) {
        if (item.conflict === 'skip') { item.status = 'skipped'; discardBody(request); return; }
        if (item.conflict !== 'overwrite') fail('ALREADY_EXISTS', 'The destination already exists; no overwrite was authorized.', 409);
        if (existing.kind !== 'file') fail('UNSUPPORTED_ENTRY', 'Only ordinary files may be overwritten.', 422);
        if (existing.version !== item.expectedVersion) fail('VERSION_CONFLICT', 'The destination changed after overwrite was authorized.', 409);
      }
      stage = await manager.io.createStagedFile({
        ...itemRef(task, item), signal, overwrite: item.conflict === 'overwrite', expectedVersion: item.expectedVersion,
        ...(existing ? { mode: existing.mode & 0o777 } : {}),
      });
      const hash = createHash('sha256');
      await consume(request, signal, async bytes => {
        account(task, item, bytes.length);
        await stage?.write(bytes); hash.update(bytes); progress(task, item, item.bytesTransferred === bytes.length);
      });
      if (item.bytesTransferred !== item.size) fail('SIZE_MISMATCH', 'The upload ended before its declared byte size was received.', 400);
      await parents(task, item, signal, false); await verifyDestination(task); cancelled(signal);
      completed(item, await (stage as { commit(validation?: { bytes?: number; sha256?: string }): Promise<EntryView> }).commit({ bytes: item.size, sha256: hash.digest('hex') }));
    }
    try {
      permit = await acquire(signal); cancelled(signal); available();
      await verifyDestination(task);
      await receive();
    } catch (error) { problem = failure(error); discardBody(request); }
    finally {
      problem = await cleanupStage(stage, problem, item.committed);
      problem = await finish(task, item, problem);
      permit?.release();
    }
    return problem;
  }

  async function handleUpload(request: Request): Promise<Response> {
    let task: TransferTask | undefined;
    try {
      available();
      if (request.method !== 'POST') fail('INVALID_REQUEST', 'Uploads require POST.', 405);
      const params = new URL(request.url).searchParams;
      task = taskOf(params.get('taskId'));
      if (task.direction !== 'upload') fail('INVALID_REQUEST', 'This is not an upload task.');
      const item = task.items.find(value => value.id === params.get('itemId'));
      if (!item) fail('ITEM_NOT_FOUND', 'The upload item does not belong to this task.', 404);
      const state = runtime(task);
      if (state.retrying) fail('TASK_BUSY', 'Retry acceptance is still being persisted.', 409);
      if (item.status === 'completed' || item.status === 'skipped') { discardBody(request); return json({ ok: true, value: toPublicTransfer(get(task.id)) }); }
      if (state.cancelled || !unfinished(item.status)) fail('ITEM_NOT_READY', 'Retry the failed or cancelled task before uploading this item.', 409);
      let work = state.inFlight.get(item.id);
      if (work) discardBody(request);
      else {
        const signal = AbortSignal.any([state.controller.signal, request.signal]);
        work = upload(task, item, request, signal);
        state.inFlight.set(item.id, work);
      }
      let problem: FileManagerError | undefined;
      try { problem = await work as FileManagerError | undefined; }
      finally {
        if (state.inFlight.get(item.id) === work) { state.inFlight.delete(item.id); notify(task); }
      }
      return problem
        ? json({ ok: false, error: errorDTO(problem), value: toPublicTransfer(get(task.id)) }, problem.status)
        : json({ ok: true, value: toPublicTransfer(get(task.id)) });
    } catch (error) {
      discardBody(request);
      const problem = failure(error);
      return json({ ok: false, error: errorDTO(problem), ...(task ? { value: toPublicTransfer(get(task.id)) } : {}) }, problem.status);
    }
  }

  interface PayloadSource {
    stream: Readable;
    verify(): Promise<void>;
    close(): Promise<void>;
  }

  /** Wrap a held safe source with payload accounting and a verified EOF. */
  async function payloadSource(task: TransferTask, item: TransferItem, signal: AbortSignal): Promise<PayloadSource> {
    cancelled(signal);
    const source = await manager.io.openRead({ rootId: task.rootId, path: item.path, expectedVersion: item.version, maxBytes: limits.maxFileBytes, signal, budget: runtime(task).budget });
    let closed = false;
    const close = async (): Promise<void> => { if (!closed) { closed = true; await source.close(); } };
    const stream = Readable.from((async function* () {
      try {
        for await (const bytes of source.stream) {
          cancelled(signal); account(task, item, bytes.length); progress(task, item, item.bytesTransferred === bytes.length);
          yield bytes;
        }
        await source.verify();
        if (item.bytesTransferred !== item.size) fail('SIZE_MISMATCH', 'The source stream did not match its planned byte size.', 409);
        item.status = 'completed'; summarize(task); await persist(task);
      } catch (error) { recordFailure(item, error); throw error; }
      finally { await close(); }
    })(), { objectMode: false, highWaterMark: 64 * 1024 });
    stream.on('error', () => {});
    return {
      stream,
      async verify() {
        if (item.status !== 'completed') fail('INCOMPLETE_DOWNLOAD', 'The source did not finish streaming.', 409);
      },
      async close() { stream.destroy(); await close(); },
    };
  }

  /** yazl is fed only held safe streams, never addFile(absolutePath). */
  async function zipSource(task: TransferTask, signal: AbortSignal): Promise<PayloadSource> {
    const zip = new ZipFile();
    const sources = new Set<PayloadSource>();
    const opening = new Set<Promise<unknown>>();
    let stopped = false;
    const onError = (error: unknown): void => { zip.outputStream.destroy(failure(error)); };
    zip.on('error', onError);
    zip.outputStream.on('error', () => {});
    for (const item of task.items) {
      cancelled(signal);
      const mtime = new Date(item.modifiedAt as string);
      if (item.kind === 'directory') {
        item.status = 'running';
        zip.addEmptyDirectory(item.archivePath as string, { mtime, mode: 0o040000 | ((item.mode ?? 0) & 0o777) });
        continue;
      }
      // Stored entries are valid streaming ZIP, avoid compression resource pools,
      // and bound memory independently of compressibility and file size.
      zip.addReadStreamLazy(item.archivePath as string, { size: item.size, compress: false, mtime, mode: 0o100000 | ((item.mode ?? 0) & 0o777) }, callback => {
        const work = (async () => {
          cancelled(signal);
          if (stopped) fail('CANCELLED', 'The archive was cancelled.', 499);
          item.status = 'running'; summarize(task); await persist(task);
          const source = await payloadSource(task, item, signal);
          if (stopped || signal.aborted) { await source.close(); fail('CANCELLED', 'The archive was cancelled.', 499); }
          sources.add(source);
          source.stream.once('close', () => sources.delete(source));
          source.stream.on('error', onError);
          callback(null, source.stream);
        })();
        opening.add(work);
        work.catch(error => { recordFailure(item, error); callback(failure(error)); }).finally(() => opening.delete(work));
      });
    }
    zip.end();
    return {
      stream: zip.outputStream,
      async verify() {
        cancelled(signal);
        for (const item of task.items) {
          if (item.kind === 'directory') {
            const current = await manager.io.stat({ rootId: task.rootId, path: item.path });
            if (current.version !== item.version) fail('VERSION_CONFLICT', 'The archived directory changed while streaming.', 409);
            item.status = 'completed';
          } else if (item.status !== 'completed') fail('INCOMPLETE_DOWNLOAD', 'An archive member did not finish streaming.', 409);
        }
      },
      async close() {
        if (stopped) return;
        stopped = true; zip.outputStream.destroy();
        const closing = [...sources].map(source => source.close());
        await Promise.allSettled([...opening]);
        const results = await Promise.allSettled(closing);
        sources.clear();
        const errors = results.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason);
        if (errors.length) throw new AggregateError(errors, 'Archive source cleanup failed.');
      },
    };
  }

  async function handleDownload(request: Request): Promise<Response> {
    let task: TransferTask | undefined;
    let state: TransferRuntime | undefined;
    try {
      available();
      if (request.method !== 'GET') fail('INVALID_REQUEST', 'Downloads require GET.', 405);
      task = taskOf(new URL(request.url).searchParams.get('taskId'));
      if (task.direction !== 'download') fail('INVALID_REQUEST', 'This is not a download task.');
      state = runtime(task);
      if (state.inFlight.size || state.retrying) fail('TASK_BUSY', 'This download already has an active stream or pending retry.', 409);
      if (task.status !== 'queued') fail('ITEM_NOT_READY', 'Create or retry a download task before opening its stream.', 409);
    } catch (error) {
      const problem = failure(error);
      return json({ ok: false, error: errorDTO(problem), ...(task ? { value: toPublicTransfer(get(task.id)) } : {}) }, problem.status);
    }
    const local = new AbortController();
    const activeTask = task;
    const activeState = state;
    const signal = AbortSignal.any([activeState.controller.signal, request.signal, local.signal]);
    let complete: (problem?: FileManagerError) => void = () => {};
    const completion = new Promise<void>(resolve => { complete = resolve as () => void; });
    activeState.inFlight.set('download', completion);
    let source: PayloadSource | undefined;
    let iterator: AsyncIterator<Buffer> | undefined;
    let permit: HeavyIoPermit | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let settling: Promise<FileManagerError | undefined> | undefined;
    const settle = (error?: unknown): Promise<FileManagerError | undefined> => {
      if (settling) return settling;
      settling = (async () => {
        let problem = error ? failure(error) : undefined;
        signal.removeEventListener('abort', onAbort);
        try { await source?.close(); await iterator?.return?.(); }
        catch {
          problem ??= new FileManagerError('CLEANUP_FAILED', 'The download source could not be closed.', 500);
          problem.details = { ...problem.details, cleanupFailed: true };
        }
        if (problem) {
          delete activeTask.completion; activeTask.error = errorDTO(problem);
          for (const item of activeTask.items) if (unfinished(item.status)) recordFailure(item, problem);
        } else activeTask.completion = 'server-stream-finished';
        activeState.downloadFinishing = true;
        const target = activeTask.items.find(item => ['running', 'failed', 'cancelled'].includes(item.status)) ?? activeTask.items[0];
        try { problem = await finish(activeTask, target, problem); }
        finally {
          activeState.downloadFinishing = false;
          activeState.inFlight.delete('download'); permit?.release(); complete(problem); notify(activeTask);
        }
        return problem;
      })();
      return settling;
    };
    const onAbort = (): void => {
      activeState.cancelled = true;
      settle(new FileManagerError('CANCELLED', 'The download was cancelled.', 499)).then(problem => {
        try { controller?.error(problem); } catch { /* The consumer may already have cancelled. */ }
      }).catch(() => {});
    };
    try {
      permit = await acquire(signal); cancelled(signal); available();
      activeTask.status = 'running'; await persist(activeTask);
      if (activeTask.downloadKind === 'zip') source = await zipSource(activeTask, signal);
      else {
        (activeTask.items[0] as TransferItem).status = 'running';
        source = await payloadSource(activeTask, activeTask.items[0] as TransferItem, signal);
      }
      cancelled(signal);
      const activeSource = source;
      iterator = activeSource.stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
      const stream = new ReadableStream<Uint8Array>({
        start(value) { controller = value; },
        async pull() {
          if (settling) return;
          try {
            const chunk = await (iterator as AsyncIterator<Buffer>).next();
            if (settling) return;
            if (chunk.done) {
              await activeSource.verify(); cancelled(signal);
              const problem = await settle();
              if (problem) controller?.error(problem); else controller?.close();
            } else {
              activeTask.wireBytesTransferred = (activeTask.wireBytesTransferred ?? 0) + chunk.value.byteLength;
              controller?.enqueue(new Uint8Array(chunk.value.buffer, chunk.value.byteOffset, chunk.value.byteLength));
            }
          } catch (error) {
            const problem = await settle(error);
            try { controller?.error(problem); } catch { /* Cancellation already closed the stream. */ }
          }
        },
        async cancel() { activeState.cancelled = true; local.abort(); await settle(new FileManagerError('CANCELLED', 'The download was cancelled.', 499)); },
      }, { highWaterMark: 0 });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      const filename = activeTask.downloadName as string;
      const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
      const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      return new Response(stream, { headers: {
        'content-type': activeTask.downloadKind === 'zip' ? 'application/zip' : 'application/octet-stream',
        'content-disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      } });
    } catch (error) {
      const problem = await settle(error);
      return json({ ok: false, error: errorDTO(problem as FileManagerError), value: toPublicTransfer(get(activeTask.id)) }, (problem as FileManagerError).status);
    }
  }

  async function cancel(id: unknown): Promise<TransferTask> {
    available();
    return cancelTracked(id);
  }

  async function cancelTracked(id: unknown): Promise<TransferTask> {
    const state = runtime(taskOf(id));
    if (state.dismissing) fail('TASK_BUSY', 'The history dismissal is still being persisted.', 409);
    state.cancelling++;
    const pending = (async () => {
      try { await cancelTask(id); }
      finally { state.cancelling--; notify(taskOf(id)); }
    })();
    await trackControl(pending);
    return get(id);
  }

  async function cancelTask(id: unknown): Promise<void> {
    const state = runtime(taskOf(id));
    if (state.retrying) {
      state.cancelDuringRetry = true;
      await state.retrying;
    }
    // Retry publishes a replacement raw record, so reacquire it after awaiting.
    const task = taskOf(id);
    if (!task.items.some(item => unfinished(item.status)) && !state.inFlight.size) return;
    state.cancelled = true; state.controller.abort();
    for (const item of task.items) if (item.status === 'pending') item.status = 'cancelled';
    task.status = 'cancelled'; notify(task);
    await Promise.allSettled([...state.inFlight.values()]);
    summarize(task); await persist(task);
  }

  async function retry(id: unknown): Promise<TransferTask> {
    available();
    const task = taskOf(id); const state = runtime(task);
    if (state.retrying) { await state.retrying; return get(id); }
    if (state.inFlight.size || state.directories.size || state.dismissing || state.cancelling || state.pendingWrites || state.downloadFinishing) {
      fail('TASK_BUSY', 'Wait for active streams and metadata controls to finish before retrying.', 409);
    }
    state.cancelDuringRetry = false;
    const retrying = stateOperation(async () => {
      available();
      const next = structuredClone(task);
      next.historyRevision = nextHistoryRevision(task);
      next.dismissed = false;
      for (const item of next.items) if (next.direction === 'download' || (['failed', 'cancelled'].includes(item.status) && !item.committed)) {
        next.bytesTransferred -= item.bytesTransferred; item.bytesTransferred = 0; item.status = 'pending'; delete item.error;
      }
      if (next.direction === 'download') { next.wireBytesTransferred = 0; delete next.completion; }
      delete next.error; summarize(next, false);
      const snapshot = (): TransferTask[] => rawSnapshot().map(value => value.id === id ? structuredClone(next) : value);
      await persistTasks(snapshot());
      if (closed || state.cancelDuringRetry) {
        for (const item of next.items) if (item.status === 'pending') item.status = 'cancelled';
        summarize(next, true);
        await persistTasks(snapshot());
      }
      tasks.set(next.id, next);
      state.cancelled = closed || state.cancelDuringRetry;
      state.controller = new AbortController(); state.lastProgress = null;
      if (state.cancelled) state.controller.abort();
    }).finally(() => {
      if (state.retrying === retrying) state.retrying = null;
      notify(taskOf(id));
    });
    state.retrying = retrying;
    await trackControl(retrying);
    return get(id);
  }

  async function dismiss({ taskId, expectedHistoryRevision }: { taskId?: unknown; expectedHistoryRevision?: unknown } = {}): Promise<TransferTask> {
    available();
    const task = taskOf(taskId);
    if (!task.dismissed && expectedHistoryRevision !== task.historyRevision) fail('TASK_CHANGED', 'The task history changed; refresh before closing it.', 409);
    if (historyBusy(task) || !terminalStatuses.has(task.status) || task.items.some(item => unfinished(item.status))) fail('TASK_BUSY', 'The transfer has not finished all active work.', 409);
    if (task.dismissed) return get(taskId);
    const revision = nextHistoryRevision(task);
    const state = runtime(task);
    state.dismissing = true;
    const pending = stateOperation(async () => {
      const next: TransferTask = { ...structuredClone(task), dismissed: true, historyRevision: revision, updatedAt: now() };
      await persistTasks(rawSnapshot().map(value => value.id === taskId ? next : value));
      tasks.set(taskId as string, next);
    }).finally(() => { state.dismissing = false; notify(taskOf(taskId)); });
    await trackControl(pending);
    return get(taskId);
  }

  async function control(input: TransferBeginInput = {}, requestSignal?: AbortSignal): Promise<unknown> {
    switch (input.op) {
      case 'transfers.begin': return begin(input, requestSignal);
      case 'transfers.list': return list();
      case 'transfers.get': return get(input.taskId);
      case 'transfers.cancel': return cancel(input.taskId);
      case 'transfers.retry': return retry(input.taskId);
      case 'transfers.dismiss': return dismiss(input);
      default: fail('INVALID_REQUEST', 'Unknown transfer operation.');
    }
  }

  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    lifetime.abort();
    closing = (async () => {
      const results = await Promise.allSettled([...tasks.values()]
        .filter(task => task.items.some(item => unfinished(item.status)) || runtime(task).inFlight.size)
        .map(task => cancelTracked(task.id)));
      const metadata = await Promise.allSettled([...controls]);
      await Promise.allSettled([...planning]);
      await stateTail;
      const errors = [...results, ...metadata].filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason);
      if (errors.length) throw new AggregateError(errors, 'Transfer cleanup or receipt persistence failed.');
    })();
    return closing;
  }

  return { begin, control, handleUpload, handleDownload, list, get, cancel, retry, dismiss, close };
}
