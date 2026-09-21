import path from 'node:path';
import { createManager } from './host/manager.js';
import { openOperationState, openProfileState } from './host/state.js';
import { createTaskService } from './host/tasks.js';
import { createTransferService } from './host/transfers.js';
import { createEventHub, createWatchService } from './host/watch.js';
import { createRequestLedger } from './host/requests.js';
import { FileManagerError, fail } from './contracts/errors.js';

export const inject = ['connection', 'workspaceRegistry', 'storageDomain', 'settings'];
const MAX_CONTROL_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const BODY_BYTES = Symbol('control-body-bytes');
const DEFAULT_TEXT_BYTES = 5 * 1024 * 1024;
const VERSION = '0.1.4';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

async function readControl(request, limit = MAX_CONTROL_BYTES, operationRequired = true) {
  if (request.method !== 'POST') fail('INVALID_REQUEST', 'This operation requires POST.', 405);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) fail('INVALID_REQUEST', 'Expected an application/json body.', 415);
  if (!request.body) fail('INVALID_REQUEST', 'The request body is missing.');
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        fail('TOO_LARGE', 'The request exceeds its byte limit.', 413);
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total))); }
  catch { fail('INVALID_REQUEST', 'The request is not valid JSON.'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (operationRequired && typeof payload.op !== 'string')) fail('INVALID_REQUEST', 'A valid object request payload is required.');
  Object.defineProperty(payload, BODY_BYTES, { value: total });
  return payload;
}

function errorResult(error) {
  if (error instanceof FileManagerError) return json({ ok: false, error: { code: error.code, message: error.message, details: error.details } }, error.status);
  const errors = {
    ENOENT: ['NOT_FOUND', 404, 'The selected entry no longer exists.'],
    EACCES: ['PERMISSION_DENIED', 403, 'The filesystem denied this operation.'],
    EPERM: ['PERMISSION_DENIED', 403, 'The filesystem denied this operation.'],
    ENOTDIR: ['NOT_DIRECTORY', 422, 'A path component is not a directory.'],
    ELOOP: ['UNSUPPORTED_ENTRY', 422, 'Symbolic links are not followed.'],
    EEXIST: ['ALREADY_EXISTS', 409, 'The destination already exists.'],
    ENOSPC: ['NO_SPACE', 507, 'The destination has no space available.'],
    ABORT_ERR: ['CANCELLED', 499, 'The operation was cancelled.'],
  };
  const [code, status, message] = errors[error?.code] ?? ['IO_ERROR', 500, 'The filesystem operation failed.'];
  const details = {};
  if (error?.details?.committed === true) details.committed = true;
  if (error?.details?.cleanupFailed === true) details.cleanupFailed = true;
  if (typeof error?.details?.stagingName === 'string') details.stagingName = error.details.stagingName;
  return json({ ok: false, error: { code, message, details } }, status);
}

function snapshotReceipt(snapshot) {
  const { text, ...receipt } = snapshot;
  return receipt;
}

/** Adapt the domain to Connection-authenticated, Session-independent control. */
export function createControlHandler({ manager, workspaces, ledger = createRequestLedger(), persistentRoots = false, limits = { maxTextBytes: DEFAULT_TEXT_BYTES }, tasks, transfers, watcher }) {
  return async request => {
    try {
      const input = await readControl(request, MAX_MANIFEST_BYTES);
      if (input[BODY_BYTES] > MAX_CONTROL_BYTES && !['tasks.start', 'tasks.retry', 'transfers.begin'].includes(input.op)) fail('TOO_LARGE', 'This control operation exceeds the small-envelope limit.', 413);
      const mutation = operation => ledger.run(input.requestId, { channel: 'control', ...input }, operation);
      const ref = { rootId: input.rootId, path: input.path };
      let value;
      switch (input.op) {
        case 'bootstrap':
          value = {
            roots: await manager.listRoots(), workspaces: workspaces(), version: VERSION, stage: 'basic-management', limits,
            capabilities: {
              write: true, persistentRoots, tasks: Boolean(tasks), transfers: Boolean(transfers), watch: Boolean(watcher), references: Boolean(manager.io?.stat),
              taskHistory: Boolean(tasks || transfers) && (!tasks || typeof tasks.dismiss === 'function') && (!transfers || typeof transfers.dismiss === 'function'),
            },
          };
          break;
        case 'roots.list': value = await manager.listRoots(); break;
        case 'roots.add': value = await mutation(() => manager.addRoot({ path: input.path })); break;
        case 'roots.remove': value = await mutation(() => manager.removeRoot({ rootId: input.rootId })); break;
        case 'entries.list': value = await manager.list({ ...ref, path: input.path ?? '', limit: input.limit ?? 200, cursor: input.cursor }); break;
        case 'entries.stat': value = await manager.io.stat(ref); break;
        case 'entries.reference': {
          const entry = await manager.io.stat(ref);
          if (!['file', 'directory'].includes(entry.kind)) fail('UNSUPPORTED_ENTRY', 'Only regular files and directories can be referenced.', 422);
          const root = manager.listRoots().find(candidate => candidate.id === ref.rootId);
          if (!root) fail('ROOT_NOT_FOUND', 'The root grant was removed.', 404);
          const absolutePath = path.join(root.path, ref.path);
          const mentionPath = entry.kind === 'directory' ? `${absolutePath.replace(/\/+$/, '')}/` : absolutePath;
          if (/[\u0000-\u001f\u007f-\u009f"]/u.test(mentionPath)) fail('UNREPRESENTABLE_REFERENCE', 'This path cannot be represented safely by the current reference grammar.', 422);
          const mention = /\s/u.test(mentionPath) ? `@"${mentionPath}"` : `@${mentionPath}`;
          value = { ...ref, kind: entry.kind, absolutePath, mention };
          break;
        }
        case 'text.read': value = await manager.readText({ ...ref, signal: request.signal }); break;
        case 'entries.create-file': value = await mutation(async () => snapshotReceipt(await manager.createFile({ ...ref, signal: request.signal }))); break;
        case 'entries.create-directory': value = await mutation(() => manager.createDirectory(ref)); break;
        case 'entries.rename': value = await mutation(() => manager.rename({ ...ref, name: input.name, expectedVersion: input.expectedVersion })); break;
        case 'delete.prepare': value = await manager.prepareDelete({ items: input.items, signal: request.signal }); break;
        case 'delete.commit': value = await mutation(() => manager.commitDelete({ planId: input.planId, confirmed: input.confirmed })); break;
        case 'activities.dismiss': {
          if (!Array.isArray(input.items) || !input.items.length) fail('INVALID_REQUEST', 'Select at least one task record to close.');
          if (input.items.length > 256) fail('TOO_LARGE', 'Close at most 256 task records per request.', 413);
          const seen = new Set();
          for (const item of input.items) {
            if (!item || typeof item !== 'object' || Array.isArray(item) || !['task', 'transfer'].includes(item.kind)
              || typeof item.taskId !== 'string' || !item.taskId || item.taskId.length > 128
              || !Number.isSafeInteger(item.expectedHistoryRevision) || item.expectedHistoryRevision < 0
              || Object.keys(item).some(key => !['kind', 'taskId', 'expectedHistoryRevision'].includes(key))) fail('INVALID_REQUEST', 'Provide a task kind, identity and observed history revision.');
            const key = `${item.kind}:${item.taskId}`;
            if (seen.has(key)) fail('INVALID_REQUEST', 'Task close selections must be distinct.');
            seen.add(key);
          }
          value = await mutation(async () => {
            const results = [];
            for (const item of input.items) {
              try {
                const service = item.kind === 'task' ? tasks : transfers;
                if (typeof service?.dismiss !== 'function') fail('FEATURE_UNAVAILABLE', 'This task service does not support closing history records.', 503);
                const task = await service.dismiss({ taskId: item.taskId, expectedHistoryRevision: item.expectedHistoryRevision });
                results.push({ kind: item.kind, taskId: item.taskId, outcome: 'dismissed', task: {
                  id: task.id, status: task.status, dismissed: task.dismissed, historyRevision: task.historyRevision, canDismiss: task.canDismiss,
                } });
              } catch (error) {
                const problem = await errorResult(error).json();
                results.push({ kind: item.kind, taskId: item.taskId, outcome: 'rejected', error: problem.error });
              }
            }
            return { results };
          });
          break;
        }
        case 'tasks.start':
        case 'tasks.list':
        case 'tasks.get':
        case 'tasks.cancel':
        case 'tasks.retry': {
          if (!tasks) fail('FEATURE_UNAVAILABLE', 'The task service is not composed.', 503);
          if (input.op === 'tasks.start') value = await mutation(() => tasks.start(input));
          else if (input.op === 'tasks.list') value = await tasks.list();
          else if (input.op === 'tasks.get') value = await tasks.get({ taskId: input.taskId });
          else if (input.op === 'tasks.cancel') value = await mutation(() => tasks.cancel({ taskId: input.taskId }));
          else value = await mutation(() => tasks.retry({ taskId: input.taskId, items: input.items }));
          break;
        }
        case 'transfers.begin':
        case 'transfers.list':
        case 'transfers.get':
        case 'transfers.cancel':
        case 'transfers.retry': {
          if (!transfers) fail('FEATURE_UNAVAILABLE', 'The transfer service is not composed.', 503);
          value = ['transfers.list', 'transfers.get'].includes(input.op)
            ? await transfers.control(input, request.signal)
            : await mutation(() => transfers.control(input, request.signal));
          break;
        }
        default: fail('INVALID_REQUEST', 'This operation is not supported.');
      }
      return json({ ok: true, value });
    } catch (error) { return errorResult(error); }
  };
}

/** Text bodies have a separate bounded route rather than using the small control envelope. */
export function createTextHandler({ manager, ledger = createRequestLedger(), maxTextBytes = DEFAULT_TEXT_BYTES }) {
  return async request => {
    try {
      // JSON escapes can require six wire bytes for one text byte.
      const input = await readControl(request, maxTextBytes * 6 + 65536);
      if (input.op !== 'save') fail('INVALID_REQUEST', 'The text mutation operation must be save.');
      const receipt = await ledger.run(input.requestId, { channel: 'text', ...input }, async () => snapshotReceipt(await manager.saveText({
        rootId: input.rootId, path: input.path, text: input.text, expectedVersion: input.expectedVersion, signal: request.signal,
      })));
      return json({ ok: true, value: receipt });
    } catch (error) { return errorResult(error); }
  };
}

/** Bounded SSE over the existing trusted Connection route, with explicit resync. */
export function createEventHandler({ watcher, events, heartbeatMs = 15000, maxQueuedEvents = 128 }) {
  return async request => {
    try {
      const input = await readControl(request, MAX_CONTROL_BYTES, false);
      if (!Array.isArray(input.targets) || input.targets.length > 128 || input.targets.some(target => !target || typeof target.rootId !== 'string' || typeof target.path !== 'string')) fail('INVALID_REQUEST', 'Provide up to 128 directory watch targets.');
      if (request.signal.aborted) fail('CANCELLED', 'The event subscription was cancelled.', 499);
      const encoder = new TextEncoder();
      const queued = [];
      let sequence = 0;
      let closed = false;
      let output;
      let heartbeat;
      let releaseHub = () => {};
      let subscription = Promise.resolve(async () => {});
      let cleanupPromise;
      const cleanup = () => {
        if (cleanupPromise) return cleanupPromise;
        closed = true;
        clearInterval(heartbeat);
        request.signal.removeEventListener('abort', abort);
        releaseHub();
        queued.length = 0;
        try { output?.close(); } catch {}
        cleanupPromise = subscription.then(release => release(), () => undefined);
        return cleanupPromise;
      };
      const abort = () => { void cleanup().catch(() => {}); };
      const encode = event => encoder.encode(`data: ${JSON.stringify({ ...event, seq: ++sequence })}\n\n`);
      const flush = () => {
        if (closed || !output) return;
        try {
          while (queued.length && output.desiredSize > 0) output.enqueue(encode(queued.shift()));
        } catch { void cleanup().catch(() => {}); }
      };
      const push = event => {
        if (closed) return;
        if (event.kind === 'closed') { void cleanup().catch(() => {}); return; }
        if (queued.length >= maxQueuedEvents) {
          queued.length = 0;
          queued.push({ kind: 'ready', reason: 'overflow' });
        }
        queued.push(event);
        flush();
      };
      const body = new ReadableStream({
        start(controller) {
          output = controller;
          releaseHub = events.subscribe(push);
          request.signal.addEventListener('abort', abort, { once: true });
          push({ kind: 'ready', reason: 'connected' });
          subscription = watcher.subscribe(input.targets, push, { signal: request.signal });
          subscription.catch(error => {
            push({ kind: 'error', code: error.code ?? 'IO_ERROR' });
            void cleanup().catch(() => {});
          });
          heartbeat = setInterval(() => push({ kind: 'heartbeat' }), heartbeatMs);
          heartbeat.unref?.();
          if (request.signal.aborted) abort();
        },
        pull() { flush(); },
        cancel() { return cleanup(); },
      });
      return new Response(body, { headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform', 'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no',
      } });
    } catch (error) { return errorResult(error); }
  };
}

/** Host-owned resources dispose in reverse order: routes, writes, then durable storage. */
export async function apply(ctx) {
  let profile;
  let operations;
  try {
    profile = await openProfileState(ctx);
    operations = await openOperationState(ctx);
  } catch (error) {
    try { await profile?.close(); }
    catch (cleanupError) { ctx.logger?.error?.(`[local-file-manager] failed to close incomplete storage: ${String(cleanupError)}`); }
    const causeCode = error?.code ?? 'INITIALIZATION_FAILED';
    ctx.logger?.error?.(`[local-file-manager] storage initialization failed (${causeCode}): ${String(error)}`);
    const unavailable = new FileManagerError('FILE_MANAGER_UNAVAILABLE', 'File manager storage could not initialize. File operations are disabled; inspect the Host log.', 503, { causeCode });
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/file-manager/control', methods: ['POST'], requestBody: 'streaming',
      async fetch(request) {
        await request.body?.cancel().catch(() => {});
        return errorResult(unavailable);
      },
    }));
    return;
  }
  ctx.effect(() => () => profile.close());
  ctx.effect(() => () => operations.close());
  const manager = createManager(profile.managerOptions);
  ctx.effect(() => () => manager.close());
  const events = createEventHub();
  ctx.effect(() => () => events.close());
  const tasks = createTaskService({
    ...operations.taskOptions, manager, limits: profile.limits,
    onChange: task => events.publish({ kind: 'task', taskId: task.id, summary: { status: task.status, progress: task.progress, updatedAt: task.updatedAt } }),
  });
  ctx.effect(() => () => tasks.close());
  const transfers = createTransferService({
    ...operations.transferOptions, manager, limits: profile.limits,
    onProgress: task => events.publish({ kind: 'transfer', taskId: task.id, summary: { status: task.status, bytesTransferred: task.bytesTransferred, bytesTotal: task.bytesTotal, itemsCompleted: task.itemsCompleted, itemsTotal: task.itemsTotal } }),
  });
  ctx.effect(() => () => transfers.close());
  const watcher = createWatchService({ manager, pollIntervalMs: profile.limits.pollIntervalMs });
  ctx.effect(() => () => watcher.close());
  const ledger = createRequestLedger();
  const control = createControlHandler({
    manager, tasks, transfers, watcher, ledger, persistentRoots: true, limits: profile.limits,
    workspaces: () => ctx.workspaceRegistry.list().map(workspace => ({ id: workspace.id, path: workspace.path, title: workspace.title })),
  });
  const text = createTextHandler({ manager, ledger, maxTextBytes: profile.limits.maxTextBytes });
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/file-manager/control', methods: ['POST'], requestBody: 'streaming', fetch: control }));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/file-manager/text', methods: ['POST'], requestBody: 'streaming', fetch: text }));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/file-manager/upload', methods: ['POST'], requestBody: 'streaming', fetch: request => transfers.handleUpload(request) }));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/file-manager/download', methods: ['GET'], requestBody: 'buffered', fetch: request => transfers.handleDownload(request) }));
  const stream = createEventHandler({ watcher, events });
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/file-manager/events', methods: ['POST'], requestBody: 'streaming', fetch: stream }));
}
