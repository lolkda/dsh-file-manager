/**
 * Typed transport for the file manager.
 *
 * Requests and results are derived from the frozen contract (`ControlRequest`,
 * `ControlResult<Op>`, `TextRequest`), so one `control()` call is associated with
 * the op it sends. Only *type* imports come from `protocol.ts`/`views.ts`:
 * importing them as values would bundle zod into the browser artifact.
 *
 * Two defects are fixed here:
 *  - a user-initiated abort is a cancellation, never an I/O failure. The legacy
 *    `if (failure.code) throw failure` treated `AbortError` (numeric DOMException
 *    code 20, a truthy value) as a classified failure, so a cancel degraded into
 *    `error.IO_ERROR`. Cancellation is now decided by the contract's own rule;
 *  - a request id belongs to a logical action, not to one HTTP call. Callers pass
 *    the id they minted for an action and reuse it when retrying that action, so
 *    the Host ledger can deduplicate instead of applying the mutation twice.
 */

import { FileManagerError, isCancellationError, normalizeError } from '../contracts/errors.js';
import { isManifestOp } from '../contracts/limits.js';
import type { ControlOp, ControlRequest, ControlResult, ResponseEnvelope, TextRequest, TextResult } from '../contracts/protocol.js';

/**
 * A mutation carries its own `requestId` on the wire, so the caller decides the
 * identity of the logical action: reuse the stored id to retry that action, or
 * mint a fresh one with {@link Api.requestId} for a new action.
 */
export type MutationRequest<Op extends ControlOp> = Extract<ControlRequest, { op: Op }>;

/**
 * v2 routes, frozen in `docs/CONTRACT.md` §6 and in `ROUTES` (`protocol.ts`).
 * They are repeated here as literals because importing `ROUTES` would pull the
 * contract's zod schemas into the browser bundle.
 */
export const API_PATHS = Object.freeze({
  control: '/api/file-manager/v2/control',
  manifest: '/api/file-manager/v2/manifest',
  text: '/api/file-manager/v2/text',
  upload: '/api/file-manager/v2/upload',
  download: '/api/file-manager/v2/download',
  events: '/api/file-manager/v2/events',
});

/** Client-local carrier key for a task view that arrived with a transfer failure. */
export const FAILURE_TASK_KEY = 'task';

export interface CallOptions {
  /** Cancels this call. An abort is reported as `CANCELLED`. */
  readonly signal?: AbortSignal | undefined;
  /** Keep the request alive across a view remount (mutations the user confirmed). */
  readonly persistent?: boolean;
  /** Identity of the logical action; reuse it when retrying that same action. */
  readonly requestId?: string | undefined;
}

export interface ApiRuntime {
  readonly fetch?: typeof fetch;
  /** Long-lived signal: a confirmed mutation must not die with the panel view. */
  readonly persistentSignal?: () => AbortSignal | undefined;
  /** Signal of the current view lifetime. */
  readonly viewSignal?: () => AbortSignal | undefined;
}

export interface Api {
  requestId(): string;
  control<Op extends ControlOp>(request: Extract<ControlRequest, { op: Op }>, options?: CallOptions): Promise<ControlResult<Op>>;
  text(request: TextRequest, options?: CallOptions): Promise<TextResult>;
  uploadUrl(taskId: string, itemId: string): string;
  downloadUrl(taskId: string): string;
}

let sequence = 0;

/** A fresh identity for one logical action. */
export function createRequestId(): string {
  const generated = globalThis.crypto?.randomUUID?.();
  if (typeof generated === 'string' && generated.length > 0) return generated;
  sequence += 1;
  return `fm-${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function envelopeError(payload: unknown): FileManagerError | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const envelope = payload as Partial<ResponseEnvelope>;
  if (envelope.ok !== false) return null;
  const error = envelope.error;
  if (typeof error !== 'object' || error === null) return null;
  const { code, message, details } = error as { code?: unknown; message?: unknown; details?: unknown };
  return new FileManagerError(
    typeof code === 'string' && code.length > 0 ? code : 'IO_ERROR',
    typeof message === 'string' ? message : 'The file operation failed.',
    500,
    typeof details === 'object' && details !== null ? { ...(details as Record<string, unknown>) } : {},
  );
}

export function createApi(runtime: ApiRuntime = {}): Api {
  const request = runtime.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  function signalFor(options: CallOptions): AbortSignal | undefined {
    if (options.signal) return options.signal;
    return options.persistent ? runtime.persistentSignal?.() : runtime.viewSignal?.();
  }

  async function send(url: string, init: RequestInit, options: CallOptions): Promise<{ value: unknown; failure: FileManagerError | null }> {
    const signal = signalFor(options);
    let payload: unknown;
    try {
      const response = await request(url, { credentials: 'same-origin', ...init, ...(signal ? { signal } : {}) });
      payload = await response.json();
    } catch (failure) {
      // A cancel is a cancel: it must not be reported as a filesystem failure,
      // and the numeric `AbortError` code must never be read as an error code.
      if (isCancellationError(failure) || signal?.aborted === true) {
        throw normalizeError(new FileManagerError('CANCELLED', 'The operation was cancelled.', 499), { signal });
      }
      throw new FileManagerError('TRANSPORT', 'File manager connection failed.', 0);
    }
    const failure = envelopeError(payload);
    if (failure) {
      const carrier = payload as { value?: unknown };
      if (carrier.value !== undefined) failure.details[FAILURE_TASK_KEY] = carrier.value;
      throw failure;
    }
    return { value: (payload as { value?: unknown }).value, failure: null };
  }

  const call = async <Op extends ControlOp>(request_: Extract<ControlRequest, { op: Op }>, options: CallOptions = {}): Promise<ControlResult<Op>> => {
    const route = isManifestOp(request_.op) ? API_PATHS.manifest : API_PATHS.control;
    const body = JSON.stringify({ ...request_, requestId: options.requestId ?? request_.requestId ?? createRequestId() });
    const { value } = await send(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, options);
    return value as ControlResult<Op>;
  };

  return {
    requestId: createRequestId,
    control: call,
    async text(request_: TextRequest, options: CallOptions = {}): Promise<TextResult> {
      const body = JSON.stringify({ ...request_, requestId: options.requestId ?? request_.requestId ?? createRequestId() });
      const { value } = await send(API_PATHS.text, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, options);
      return value as TextResult;
    },
    uploadUrl: (taskId, itemId) => `${API_PATHS.upload}?taskId=${encodeURIComponent(taskId)}&itemId=${encodeURIComponent(itemId)}`,
    downloadUrl: taskId => `${API_PATHS.download}?taskId=${encodeURIComponent(taskId)}`,
  };
}

/** The task view that accompanied a transfer failure, when the Host sent one. */
export function failureTask(failure: unknown): unknown {
  if (typeof failure !== 'object' || failure === null) return undefined;
  const details = (failure as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return undefined;
  return (details as Record<string, unknown>)[FAILURE_TASK_KEY];
}

/** True when the failure means the path or root no longer exists. */
const MISSING_CODES: readonly string[] = Object.freeze(['NOT_FOUND', 'ROOT_NOT_FOUND', 'ROOT_CHANGED', 'ROOT_UNAVAILABLE']);

export const isMissingFailure = (failure: unknown): boolean => {
  const code = typeof failure === 'object' && failure !== null ? (failure as { code?: unknown }).code : undefined;
  return typeof code === 'string' && MISSING_CODES.includes(code);
};

export const failureCodeOf = (failure: unknown): string | null => {
  const code = typeof failure === 'object' && failure !== null ? (failure as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code.length > 0 ? code : null;
};
