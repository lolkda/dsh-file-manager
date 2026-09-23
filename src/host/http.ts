import { FileManagerError, fail, normalizeError } from '../contracts/errors.js';
import {
  CONTROL_ENVELOPE_BYTES, MANIFEST_ENVELOPE_BYTES, WIRE_STAGE, resolveLimits, textEnvelopeBytes,
  type ProfileLimits,
} from '../contracts/limits.js';
import { VERSION } from '../version.js';
import {
  LEGACY_ROUTES, ROUTES, ROUTE_IDS, manifestRouteAccepts, parseControlRequest, parseEventRequest, parseTextRequest,
  routeAdmission, type RouteId,
} from '../contracts/protocol.js';
import {
  toActivityDismissedReceipt, toActivityRejectedReceipt, toDeleteCommitResult, toDeletePlan, toEntrySnapshot,
  toEntryStat, toPublicError, toPublicTransfer, toRootDescriptor, toTextReceipt, toTextSnapshot,
  type DegradedView,
} from '../contracts/views.js';
import type { EntryView, UnaddressableEntry } from './io.js';
import type { Manager, RootDescriptor } from './manager.js';
import type { RequestLedger } from './requests.js';
import { createRequestLedger } from './requests.js';
import type { TaskService } from './tasks.js';
import type { TransferService } from './transfers.js';
import type { EventHub, WatchEvent, WatchService, WatchTarget } from './watch.js';
import type { WorkspaceCandidateView } from './context.js';

const BODY_BYTES = Symbol('control-body-bytes');
type BodyInput = Record<string, unknown> & { [BODY_BYTES]?: number };

/** Envelope shared by every v2 JSON route. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

function errorResult(error: unknown, profile: 'control' | 'transfer' = 'control'): Response {
  const problem = normalizeError(error, { profile });
  return json({ ok: false, error: toPublicError(problem) }, problem.status);
}

/**
 * Read one bounded JSON envelope, refusing the surplus before buffering it.
 * The request body is released on every rejection path.
 */
async function readJson(request: Request, limit: number, operationRequired = true): Promise<BodyInput> {
  if (request.method !== 'POST') fail('INVALID_REQUEST', 'This operation requires POST.', 405);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) fail('INVALID_REQUEST', 'Expected an application/json body.', 415);
  if (!request.body) fail('INVALID_REQUEST', 'The request body is missing.');
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
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
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total))); }
  catch { fail('INVALID_REQUEST', 'The request is not valid JSON.'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (operationRequired && typeof (payload as { op?: unknown }).op !== 'string')) {
    fail('INVALID_REQUEST', 'A valid object request payload is required.');
  }
  const input = payload as BodyInput;
  Object.defineProperty(input, BODY_BYTES, { value: total });
  return input;
}

export interface ControlHandlerOptions {
  manager: Manager;
  workspaces: () => WorkspaceCandidateView[];
  ledger?: RequestLedger | undefined;
  persistentRoots?: boolean | undefined;
  /** Defaults to the effective profile limits; callers normally pass the resolved ones. */
  limits?: ProfileLimits | undefined;
  tasks?: TaskService | undefined;
  transfers?: TransferService | undefined;
  watcher?: WatchService | undefined;
  /** Defaults to the installed package version. */
  version?: string | undefined;
  /** `manifest` accepts only bulk operations and the larger envelope. */
  envelope?: 'control' | 'manifest' | undefined;
  degraded?: DegradedView | null | undefined;
  /** True when the operation journal is unavailable: browse/read only. */
  readOnly?: boolean | undefined;
}

/** Operations that change durable state and are refused while degraded. */
const WRITE_OPS = new Set([
  'roots.add', 'roots.remove', 'entries.create-file', 'entries.create-directory', 'entries.rename',
  'delete.prepare', 'delete.commit', 'activities.dismiss',
]);

/** Adapt the domain to Connection-authenticated, Session-independent control. */
export function createControlHandler(options: ControlHandlerOptions): (request: Request) => Promise<Response> {
  const {
    manager, workspaces, ledger = createRequestLedger(), persistentRoots = false,
    limits = resolveLimits(), tasks, transfers, watcher, version = VERSION,
    envelope = 'control', degraded = null, readOnly = false,
  } = options;
  const degradedScope = degraded?.scope;
  return async (request: Request): Promise<Response> => {
    try {
        const limit = envelope === 'manifest' ? MANIFEST_ENVELOPE_BYTES : CONTROL_ENVELOPE_BYTES;
      const input = await readJson(request, limit);
      if (degradedScope === 'roots' && input.op !== 'bootstrap') {
        // Browsing is impossible without trustworthy grants, but the client must
        // still be able to ask why: only bootstrap answers.
        fail('FILE_MANAGER_UNAVAILABLE', 'The stored root grants are unusable; the file manager is unavailable.', 503, { scope: 'roots' });
      }
      if (envelope === 'manifest' && !manifestRouteAccepts(input.op)) {
        fail('INVALID_REQUEST', 'The manifest route accepts only tasks.start, tasks.retry and transfers.begin.', 400);
      }
      if (envelope === 'control' && manifestRouteAccepts(input.op)) {
        fail('INVALID_REQUEST', 'This bulk operation must be sent to /api/file-manager/v2/manifest.', 400);
      }
      if (readOnly && WRITE_OPS.has(input.op as string)) {
        fail('FILE_MANAGER_UNAVAILABLE', 'The operation journal is unavailable; the file manager is read-only.', 503, { scope: 'operations' });
      }
      const parsed = parseControlRequest(input);
      const operation = parsed.op;
      const ref: { rootId: unknown; path: string | undefined } = { rootId: input.rootId, path: input.path as string | undefined };
      const mutation = <T>(work: () => Promise<T>): Promise<T> => ledger.run(input.requestId, { channel: envelope, ...input }, work);
      let value: unknown;
      switch (operation) {
        case 'bootstrap':
          value = {
            roots: degradedScope === 'roots' ? [] : manager.listRoots().map(toRootDescriptor),
            workspaces: workspaces(),
            version,
            stage: WIRE_STAGE,
            limits,
            capabilities: {
              write: !readOnly && degradedScope === undefined,
              persistentRoots: degradedScope === undefined ? persistentRoots : false,
              tasks: Boolean(tasks) && !readOnly && degradedScope === undefined,
              transfers: Boolean(transfers) && !readOnly && degradedScope === undefined,
              watch: Boolean(watcher) && degradedScope === undefined,
              references: Boolean(manager.io) && degradedScope === undefined,
              taskHistory: !readOnly && degradedScope === undefined && Boolean(tasks || transfers),
            },
            degraded,
          };
          break;
        case 'roots.list': value = manager.listRoots().map(toRootDescriptor); break;
        case 'roots.add': value = await mutation(async () => toRootDescriptor(await manager.addRoot({ path: input.path }))); break;
        case 'roots.remove': value = await mutation(() => manager.removeRoot({ rootId: input.rootId })); break;
        case 'entries.list': {
          const listing = await manager.list({ ...ref, path: (input.path as string | undefined) ?? '', limit: (input.limit as number | undefined) ?? undefined, cursor: input.cursor as string | undefined });
          value = {
            rootId: listing.rootId,
            path: listing.path,
            entries: listing.entries.map(toEntrySnapshot),
            unaddressable: listing.unaddressable,
            total: listing.total,
            nextCursor: listing.nextCursor,
          };
          break;
        }
        case 'entries.stat': value = toEntryStat(await manager.io.stat({ ...ref, metadataOnly: false })); break;
        case 'entries.reference': value = await reference(manager, input); break;
        case 'text.read': value = toTextSnapshot(await manager.readText({ ...ref, signal: request.signal })); break;
        case 'entries.create-file': value = await mutation(async () => toTextReceipt(await manager.createFile({ ...ref, signal: request.signal }))); break;
        case 'entries.create-directory': value = await mutation(async () => toEntryStat(await manager.createDirectory(ref))); break;
        case 'entries.rename': value = await mutation(async () => toEntryStat(await manager.rename({ ...ref, name: input.name, expectedVersion: input.expectedVersion }))); break;
        case 'delete.prepare': value = toDeletePlan(await manager.prepareDelete({ items: input.items, signal: request.signal })); break;
        case 'delete.commit': value = await mutation(async () => toDeleteCommitResult(await manager.commitDelete({ planId: input.planId, confirmed: input.confirmed }))); break;
        case 'activities.dismiss': value = await mutation(() => dismissActivities({ input, tasks, transfers })); break;
        case 'tasks.start':
        case 'tasks.list':
        case 'tasks.get':
        case 'tasks.cancel':
        case 'tasks.retry': {
          if (!tasks) fail('FEATURE_UNAVAILABLE', 'The task service is not composed.', 503);
          const service = tasks;
          if (operation === 'tasks.start') value = await mutation(() => service.start({ operation: input.operation, items: input.items, destination: input.destination, conflict: input.conflict }));
          else if (operation === 'tasks.list') value = await service.list();
          else if (operation === 'tasks.get') value = await service.get({ taskId: input.taskId });
          else if (operation === 'tasks.cancel') value = await mutation(() => service.cancel({ taskId: input.taskId }));
          else value = await mutation(() => service.retry({ taskId: input.taskId, items: input.items }));
          break;
        }
        case 'transfers.begin':
        case 'transfers.list':
        case 'transfers.get':
        case 'transfers.cancel':
        case 'transfers.retry': {
          if (!transfers) fail('FEATURE_UNAVAILABLE', 'The transfer service is not composed.', 503);
          const service = transfers;
          const transferInput = {
            op: operation,
            rootId: input.rootId, path: input.path, direction: input.direction,
            items: input.items, taskId: input.taskId, expectedVersion: input.expectedVersion,
          };
          if (operation === 'transfers.list') value = (await service.control(transferInput, request.signal) as unknown[]).map(toPublicTransfer);
          else if (operation === 'transfers.get') value = toPublicTransfer(await service.control(transferInput, request.signal));
          else value = await mutation(async () => toPublicTransfer(await service.control(transferInput, request.signal)));
          break;
        }
        default: fail('INVALID_REQUEST', 'This operation is not supported.');
      }
      return json({ ok: true, value });
    } catch (error) { return errorResult(error); }
  };
}

/** Build a `@path` mention without ever minting one the grammar cannot express. */
async function reference(manager: Manager, input: BodyInput): Promise<unknown> {
  const ref: { rootId: unknown; path: string | undefined } = { rootId: input.rootId, path: input.path as string | undefined };
  const entry = await manager.io.stat({ ...ref, metadataOnly: true });
  if (!['file', 'directory'].includes(entry.kind)) fail('UNSUPPORTED_ENTRY', 'Only regular files and directories can be referenced.', 422);
  const root = manager.listRoots().find(candidate => candidate.id === ref.rootId);
  if (!root) fail('ROOT_NOT_FOUND', 'The root grant was removed.', 404);
  const absolutePath = `${root.path}${entry.path ? `/${entry.path}` : ''}`;
  const mentionPath = entry.kind === 'directory' ? `${absolutePath.replace(/\/+$/, '')}/` : absolutePath;
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(mentionPath)) fail('UNREPRESENTABLE_REFERENCE', 'This path cannot be represented safely by the current reference grammar.', 422);
  const mention = /\s/u.test(mentionPath) ? `@"${mentionPath}"` : `@${mentionPath}`;
  return { rootId: ref.rootId, path: entry.path, kind: entry.kind, absolutePath, mention };
}

async function dismissActivities({ input, tasks, transfers }: {
  input: BodyInput; tasks?: TaskService | undefined; transfers?: TransferService | undefined;
}): Promise<unknown> {
  const items = input.items;
  if (!Array.isArray(items) || !items.length) fail('INVALID_REQUEST', 'Select at least one task record to close.');
  if (items.length > 256) fail('TOO_LARGE', 'Close at most 256 task records per request.', 413);
  const seen = new Set<string>();
  for (const item of items as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !['task', 'transfer'].includes(item.kind as string)
      || typeof item.taskId !== 'string' || !item.taskId || item.taskId.length > 128
      || !Number.isSafeInteger(item.expectedHistoryRevision) || (item.expectedHistoryRevision as number) < 0
      || Object.keys(item).some(key => !['kind', 'taskId', 'expectedHistoryRevision'].includes(key))) fail('INVALID_REQUEST', 'Provide a task kind, identity and observed history revision.');
    const key = `${item.kind as string}:${item.taskId as string}`;
    if (seen.has(key)) fail('INVALID_REQUEST', 'Task close selections must be distinct.');
    seen.add(key);
  }
  const results: unknown[] = [];
  for (const item of items as Array<{ kind: 'task' | 'transfer'; taskId: string; expectedHistoryRevision: number }>) {
    try {
      const service = item.kind === 'task' ? tasks : transfers;
      if (!service || typeof service.dismiss !== 'function') fail('FEATURE_UNAVAILABLE', 'This task service does not support closing history records.', 503);
      const task = await service.dismiss({ taskId: item.taskId, expectedHistoryRevision: item.expectedHistoryRevision });
      results.push(toActivityDismissedReceipt(item.kind, item.taskId, task));
    } catch (error) {
      results.push(toActivityRejectedReceipt(item.kind, item.taskId, normalizeError(error)));
    }
  }
  return { results };
}

export interface TextHandlerOptions {
  manager: Manager;
  ledger?: RequestLedger | undefined;
  maxTextBytes?: number | undefined;
  readOnly?: boolean | undefined;
  degraded?: DegradedView | null | undefined;
}

/** Text bodies have a separate bounded route rather than using the small control envelope. */
export function createTextHandler(options: TextHandlerOptions): (request: Request) => Promise<Response> {
  const { manager, ledger = createRequestLedger(), maxTextBytes = resolveLimits().maxTextBytes, readOnly = false, degraded = null } = options;
  return async (request: Request): Promise<Response> => {
    try {
      // JSON escapes can require six wire bytes for one text byte.
      const input = await readJson(request, textEnvelopeBytes(maxTextBytes));
      if (degraded?.scope === 'roots') fail('FILE_MANAGER_UNAVAILABLE', 'The stored root grants are unusable; the file manager is unavailable.', 503, { scope: 'roots' });
      if (readOnly) fail('FILE_MANAGER_UNAVAILABLE', 'The operation journal is unavailable; the file manager is read-only.', 503, { scope: 'operations' });
      const parsed = parseTextRequest(input);
      if (parsed.op !== 'save') fail('INVALID_REQUEST', 'The text mutation operation must be save.');
      const receipt = await ledger.run(input.requestId, { channel: 'text', ...input }, async () => toTextReceipt(await manager.saveText({
        rootId: input.rootId, path: input.path as string, text: input.text, expectedVersion: input.expectedVersion, signal: request.signal,
      })));
      return json({ ok: true, value: receipt });
    } catch (error) { return errorResult(error); }
  };
}

export interface EventHandlerOptions {
  watcher: WatchService;
  events: EventHub;
  heartbeatMs?: number | undefined;
  maxQueuedEvents?: number | undefined;
  readOnly?: boolean | undefined;
}

/** Bounded SSE over the existing trusted Connection route, with explicit resync. */
export function createEventHandler(options: EventHandlerOptions): (request: Request) => Promise<Response> {
  const { watcher, events, heartbeatMs = 15000, maxQueuedEvents = 128 } = options;
  return async (request: Request): Promise<Response> => {
    try {
      const input = await readJson(request, CONTROL_ENVELOPE_BYTES, false);
      const parsed = parseEventRequest(input);
      if (request.signal.aborted) fail('CANCELLED', 'The event subscription was cancelled.', 499);
      const encoder = new TextEncoder();
      const queued: WatchEvent[] = [];
      let sequence = 0;
      let closed = false;
      let output: ReadableStreamDefaultController<Uint8Array> | undefined;
      let heartbeat: NodeJS.Timeout | undefined;
      let releaseHub: () => void = () => {};
      let subscription: Promise<() => Promise<void>> = Promise.resolve(async () => {});
      let cleanupPromise: Promise<void> | undefined;
      const cleanup = (): Promise<void> => {
        if (cleanupPromise) return cleanupPromise;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        request.signal.removeEventListener('abort', abort);
        releaseHub();
        queued.length = 0;
        try { output?.close(); } catch { /* The consumer may already have cancelled. */ }
        cleanupPromise = subscription.then(release => release(), () => undefined);
        return cleanupPromise;
      };
      const abort = (): void => { void cleanup().catch(() => {}); };
      const encode = (event: WatchEvent): Uint8Array => encoder.encode(`data: ${JSON.stringify({ ...event, seq: ++sequence })}\n\n`);
      const flush = (): void => {
        if (closed || !output) return;
        try {
          while (queued.length && (output.desiredSize ?? 0) > 0) output.enqueue(encode(queued.shift() as WatchEvent));
        } catch { void cleanup().catch(() => {}); }
      };
      const push = (event: WatchEvent): void => {
        if (closed) return;
        if (event.kind === 'closed') { void cleanup().catch(() => {}); return; }
        if (queued.length >= maxQueuedEvents) {
          queued.length = 0;
          queued.push({ kind: 'ready', reason: 'overflow' });
        }
        queued.push(event);
        flush();
      };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          output = controller;
          releaseHub = events.subscribe(push);
          request.signal.addEventListener('abort', abort, { once: true });
          push({ kind: 'ready', reason: 'connected' });
          subscription = watcher.subscribe(parsed.targets as WatchTarget[], push, { signal: request.signal });
          subscription.catch((error: FileManagerError) => {
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

export interface FileManagerRouterOptions extends ControlHandlerOptions {
  transfers?: TransferService | undefined;
  watcher?: WatchService | undefined;
  events?: EventHub | undefined;
  heartbeatMs?: number | undefined;
  maxQueuedEvents?: number | undefined;
}

/**
 * The single Request -> Response wiring for the v2 routes. Every route is
 * admitted before its body is read, and the retired v1 paths answer with an
 * explicit upgrade error instead of silently serving the old protocol.
 */
export function createFileManagerRouter(options: FileManagerRouterOptions): (request: Request) => Promise<Response> {
  const control = createControlHandler({ ...options, envelope: 'control' });
  const manifest = createControlHandler({ ...options, envelope: 'manifest' });
  const text = createTextHandler({
    manager: options.manager,
    ...(options.ledger ? { ledger: options.ledger } : {}),
    maxTextBytes: (options.limits ?? resolveLimits()).maxTextBytes,
    readOnly: options.readOnly === true,
    degraded: options.degraded ?? null,
  });
  const events = options.events && options.watcher
    ? createEventHandler({
      watcher: options.watcher, events: options.events,
      ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
      ...(options.maxQueuedEvents !== undefined ? { maxQueuedEvents: options.maxQueuedEvents } : {}),
    })
    : undefined;
  const active = new Map<RouteId, number>();

  function admit(route: RouteId): () => void {
    const limit = routeAdmission(route);
    const current = active.get(route) ?? 0;
    if (current >= limit) fail('TOO_MANY_REQUESTS', 'Too many concurrent file-manager requests; retry once they finish.', 429);
    active.set(route, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active.set(route, Math.max(0, (active.get(route) ?? 1) - 1));
    };
  }

  const handlers: Record<RouteId, (request: Request) => Promise<Response>> = {
    control,
    manifest,
    text,
    upload: request => options.transfers
      ? options.transfers.handleUpload(request)
      : Promise.resolve(errorResult(new FileManagerError('FEATURE_UNAVAILABLE', 'The transfer service is not composed.', 503))),
    download: request => options.transfers
      ? options.transfers.handleDownload(request)
      : Promise.resolve(errorResult(new FileManagerError('FEATURE_UNAVAILABLE', 'The transfer service is not composed.', 503))),
    events: request => events
      ? events(request)
      : Promise.resolve(errorResult(new FileManagerError('FEATURE_UNAVAILABLE', 'Filesystem monitoring is not composed.', 503))),
  };

  return async (request: Request): Promise<Response> => {
    let pathname: string;
    try { pathname = new URL(request.url).pathname; }
    catch { return errorResult(new FileManagerError('INVALID_REQUEST', 'A valid request URL is required.')); }
    if (LEGACY_ROUTES.includes(pathname)) {
      await request.body?.cancel().catch(() => {});
      return errorResult(new FileManagerError('INVALID_REQUEST', 'This endpoint has been replaced. Use /api/file-manager/v2/{control,manifest,text,upload,download,events}.', 404));
    }
    const route = ROUTE_IDS.find(id => ROUTES[id].path === pathname);
    if (!route) {
      await request.body?.cancel().catch(() => {});
      return errorResult(new FileManagerError('INVALID_REQUEST', 'This file-manager endpoint does not exist.', 404));
    }
    if (options.degraded?.scope === 'roots' && route !== 'control') {
      await request.body?.cancel().catch(() => {});
      return errorResult(new FileManagerError('FILE_MANAGER_UNAVAILABLE', 'The stored root grants are unusable; the file manager is unavailable.', 503, { scope: 'roots' }));
    }
    let release: () => void;
    try { release = admit(route); }
    catch (error) {
      // Refuse the surplus immediately and never buffer the body.
      await request.body?.cancel().catch(() => {});
      return errorResult(error);
    }
    try { return await handlers[route](request); }
    finally { release(); }
  };
}

/**
 * A route handler for a file manager whose durable state could not open. It
 * still answers `bootstrap` with the degradation reason, because a client that
 * only sees a 503 cannot tell "untrusted grants" from "Host is down".
 */
export function createUnavailableHandler(degraded: DegradedView, options: {
  workspaces: () => WorkspaceCandidateView[];
  /** Only the control route may answer `bootstrap`; every other route refuses. */
  route?: RouteId | undefined;
  version?: string | undefined;
  limits?: ProfileLimits | undefined;
  persistentRoots?: boolean | undefined;
}): (request: Request) => Promise<Response> {
  const { workspaces, route = 'control', version = VERSION, limits = resolveLimits() } = options;
  return async (request: Request): Promise<Response> => {
    try {
      const input = await readJson(request, CONTROL_ENVELOPE_BYTES, false);
      if (degraded.scope === 'roots' && route === 'control' && input.op === 'bootstrap') {
        return json({ ok: true, value: {
          roots: [], workspaces: workspaces(), version, stage: WIRE_STAGE, limits,
          capabilities: { write: false, persistentRoots: false, tasks: false, transfers: false, watch: false, references: false, taskHistory: false },
          degraded,
        } });
      }
      fail('FILE_MANAGER_UNAVAILABLE', degraded.message, 503, { scope: degraded.scope });
    } catch (error) {
      if ((error as FileManagerError).code === 'FILE_MANAGER_UNAVAILABLE') return errorResult(error);
      return errorResult(new FileManagerError('FILE_MANAGER_UNAVAILABLE', degraded.message, 503, { scope: degraded.scope }));
    }
  };
}

/** Route ids in registration order, for the Host entry to register. */
export const ROUTE_TABLE: ReadonlyArray<{ id: RouteId; path: string; methods: readonly string[]; requestBody: string }> =
  ROUTE_IDS.map(id => ({ id, ...ROUTES[id] }));

export type { EntryView, UnaddressableEntry, RootDescriptor };
