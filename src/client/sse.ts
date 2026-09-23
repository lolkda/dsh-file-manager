/**
 * Server-sent event decoding for the live-observation channel.
 *
 * The stream is untrusted input: frames are size-bounded, JSON is validated
 * against a field whitelist, and a truncated tail is reported instead of being
 * silently discarded. The decoder is flushed when the stream ends — without
 * that flush the bytes of an interrupted multi-byte sequence would disappear
 * without any error, and the view would silently show stale state.
 */

export class EventStreamError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EventStreamError';
    this.code = code;
  }
}

export interface SseFrame {
  readonly kind: string;
  readonly seq?: number;
  readonly rootId?: string;
  readonly path?: string;
  readonly taskId?: string;
  readonly status?: string;
}

export interface ConsumeOptions {
  readonly signal?: AbortSignal;
  readonly onFrame: (frame: SseFrame) => void | Promise<void>;
}

/** One decoded frame never exceeds this many bytes. */
const MAX_FRAME_BYTES = 262144;

function invalidStream(): never {
  throw new EventStreamError('EVENT_STREAM_INVALID', 'The file event stream is invalid.');
}

/** Adopts only the fields the Host actually sends, never the whole body. */
function frameFrom(parsed: unknown): SseFrame {
  if (typeof parsed !== 'object' || parsed === null) invalidStream();
  const record = parsed as Record<string, unknown>;
  if (typeof record.kind !== 'string') invalidStream();
  const frame: { kind: string; seq?: number; rootId?: string; path?: string; taskId?: string; status?: string } = { kind: record.kind };
  if (typeof record.seq === 'number') frame.seq = record.seq;
  if (typeof record.rootId === 'string') frame.rootId = record.rootId;
  if (typeof record.path === 'string') frame.path = record.path;
  if (typeof record.taskId === 'string') frame.taskId = record.taskId;
  if (typeof record.status === 'string') frame.status = record.status;
  return frame;
}

function decodeChunk(decoder: TextDecoder, value?: Uint8Array): string {
  try {
    return value === undefined ? decoder.decode() : decoder.decode(value, { stream: true });
  } catch {
    return invalidStream();
  }
}

export async function consumeEvents(response: Response, { signal, onFrame }: ConsumeOptions): Promise<void> {
  if (!response.ok || !response.body) invalidStream();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const abort = (): void => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  let buffer = '';
  let ended = false;
  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        ended = true;
        // Flush the decoder so an interrupted sequence fails loudly here
        // instead of being dropped without a trace.
        buffer += decodeChunk(decoder);
        break;
      }
      buffer += decodeChunk(decoder, value);
      let match = /\r?\n\r?\n/.exec(buffer);
      while (match) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (frame.length > MAX_FRAME_BYTES) invalidStream();
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (data) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            invalidStream();
          }
          await onFrame(frameFrom(parsed));
        }
        match = /\r?\n\r?\n/.exec(buffer);
      }
      if (buffer.length > MAX_FRAME_BYTES) invalidStream();
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export interface FrameGate {
  /** True when this frame is newer than everything already handled. */
  accept(frame: SseFrame): boolean;
  /** A new connection restarts the server's per-connection sequence. */
  reset(): void;
  readonly sequence: number;
}

export function createFrameGate(): FrameGate {
  let sequence = 0;
  return {
    get sequence() {
      return sequence;
    },
    reset() {
      sequence = 0;
    },
    accept(frame) {
      if (typeof frame.seq !== 'number') return true;
      if (frame.seq <= sequence) return false;
      sequence = frame.seq;
      return true;
    },
  };
}

export type FrameAction =
  | { readonly kind: 'resync' }
  | { readonly kind: 'invalidate'; readonly rootId: string }
  | { readonly kind: 'task'; readonly taskId: string }
  | { readonly kind: 'transfer'; readonly taskId: string }
  | { readonly kind: 'watch-status'; readonly rootId: string; readonly path: string; readonly status: string }
  | { readonly kind: 'ignore' };

/** Maps one frame onto the work the watcher has to do. */
export function classifyFrame(frame: SseFrame): FrameAction {
  switch (frame.kind) {
    case 'ready':
      return { kind: 'resync' };
    case 'invalidate':
      return typeof frame.rootId === 'string' ? { kind: 'invalidate', rootId: frame.rootId } : { kind: 'ignore' };
    case 'task':
      return typeof frame.taskId === 'string' ? { kind: 'task', taskId: frame.taskId } : { kind: 'ignore' };
    case 'transfer':
      return typeof frame.taskId === 'string' ? { kind: 'transfer', taskId: frame.taskId } : { kind: 'ignore' };
    case 'watch-status':
      return typeof frame.rootId === 'string' && typeof frame.path === 'string' && typeof frame.status === 'string'
        ? { kind: 'watch-status', rootId: frame.rootId, path: frame.path, status: frame.status }
        : { kind: 'ignore' };
    default:
      return { kind: 'ignore' };
  }
}

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface RetryTimerOptions {
  readonly base?: number;
  readonly max?: number;
  readonly setTimer?: (handler: () => void, ms: number) => TimerHandle;
  readonly clearTimer?: (handle: TimerHandle) => void;
}

export interface RetryTimer {
  readonly delay: number;
  readonly disposed: boolean;
  /** Resolves when the delay elapses, or immediately once disposed. */
  wait(): Promise<void>;
  reset(): void;
  dispose(): void;
}

/**
 * Reconnect backoff with a complete release path: `dispose` clears the pending
 * timer and wakes the loop that is awaiting it, so unmounting the panel can
 * never leave a retry timer behind.
 */
export function createRetryTimer(options: RetryTimerOptions = {}): RetryTimer {
  const base = options.base ?? 1000;
  const maximum = options.max ?? 30000;
  const setTimer = options.setTimer ?? ((handler: () => void, ms: number): TimerHandle => setTimeout(handler, ms));
  const clearTimer = options.clearTimer ?? ((handle: TimerHandle): void => { clearTimeout(handle); });
  let delay = base;
  let disposed = false;
  let handle: TimerHandle | null = null;
  let wake: (() => void) | null = null;

  function settle(): void {
    const current = wake;
    wake = null;
    current?.();
  }

  return {
    get delay() {
      return delay;
    },
    get disposed() {
      return disposed;
    },
    wait() {
      if (disposed) return Promise.resolve();
      return new Promise<void>(done => {
        wake = done;
        handle = setTimer(() => {
          handle = null;
          delay = Math.min(delay * 2, maximum);
          settle();
        }, delay);
      });
    },
    reset() {
      delay = base;
    },
    dispose() {
      disposed = true;
      if (handle !== null) {
        clearTimer(handle);
        handle = null;
      }
      settle();
    },
  };
}