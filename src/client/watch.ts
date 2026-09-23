/**
 * Live observation: one SSE connection, one resynchronization per `ready`, and a
 * complete release path.
 *
 * The watcher is a plain function, not a React effect body, so its timers,
 * abort controllers and subscriptions have one owner with one `dispose()`. The
 * connection is re-established with an exponential backoff that the retry timer
 * clears on dispose, and every frame is gated per connection because the Host
 * restarts its sequence for each connection.
 */

import { consumeEvents, createFrameGate, createRetryTimer, classifyFrame, type SseFrame } from './sse.js';
import { API_PATHS } from './api.js';

export type WatchStatus = 'connecting' | 'watching' | 'polling' | 'unavailable' | 'disconnected';

export interface WatchTarget {
  readonly rootId: string;
  readonly path: string;
}

export interface WatchHandlers {
  invalidate(ids: readonly string[]): Promise<void> | void;
  sync(): Promise<void> | void;
  task(taskId: string): Promise<void> | void;
  transfer(taskId: string): Promise<void> | void;
}

export interface WatchOptions {
  readonly targets: readonly WatchTarget[];
  /** Plugin-runtime signal: aborting it stops observation for good. */
  readonly parentSignal?: AbortSignal | undefined;
  /** Live handlers; read through a getter so a re-render never restarts the stream. */
  readonly handlers: () => WatchHandlers;
  /** True while an interaction owns the UI; frames are queued, not dropped. */
  readonly isBusy: () => boolean;
  readonly onStatus: (status: WatchStatus) => void;
  readonly onError: (failure: unknown) => void;
  readonly fetch?: typeof fetch;
  readonly heartbeatMs?: number;
  readonly debounceMs?: number;
}

export const WATCH_MAX_TARGETS = 128;
const DEFAULT_HEARTBEAT_MS = 45000;

export function startWatch(options: WatchOptions): () => void {
  const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const debounceMs = options.debounceMs ?? 80;
  const lifetime = new AbortController();
  const retry = createRetryTimer();
  let closed = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const rootsToRefresh = new Set<string>();
  const taskIds = new Set<string>();
  const transferIds = new Set<string>();
  const statuses = new Map<string, string>();

  const disconnect = (): void => { lifetime.abort(); };
  options.parentSignal?.addEventListener('abort', disconnect, { once: true });
  if (options.parentSignal?.aborted === true) disconnect();

  function schedule(): void {
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = null; void drain(); }, debounceMs);
  }

  async function drain(): Promise<void> {
    if (closed || lifetime.signal.aborted) return;
    if (options.isBusy()) {
      // The user is mid-interaction; re-check shortly instead of dropping frames.
      if (debounce !== null) clearTimeout(debounce);
      debounce = setTimeout(() => { debounce = null; void drain(); }, 100);
      return;
    }
    const ids = [...rootsToRefresh];
    rootsToRefresh.clear();
    const tasks = [...taskIds];
    taskIds.clear();
    const transfers = [...transferIds];
    transferIds.clear();
    try {
      await options.handlers().invalidate(ids);
      for (const id of tasks) await options.handlers().task(id);
      for (const id of transfers) await options.handlers().transfer(id);
    } catch (failure) {
      if (!closed && !lifetime.signal.aborted) options.onError(failure);
    }
  }

  function applyFrame(frame: SseFrame): void {
    const action = classifyFrame(frame);
    switch (action.kind) {
      case 'resync':
        retry.reset();
        statuses.clear();
        if (!closed) options.onStatus('watching');
        for (const target of options.targets) rootsToRefresh.add(target.rootId);
        void Promise.resolve(options.handlers().sync()).then(schedule, failure => { if (!closed) options.onError(failure); });
        return;
      case 'invalidate':
        rootsToRefresh.add(action.rootId);
        schedule();
        return;
      case 'task':
        taskIds.add(action.taskId);
        schedule();
        return;
      case 'transfer':
        transferIds.add(action.taskId);
        schedule();
        return;
      case 'watch-status': {
        statuses.set(`${action.rootId}:${action.path}`, action.status);
        const values = [...statuses.values()];
        if (!closed) options.onStatus(values.includes('unavailable') ? 'unavailable' : values.includes('polling') ? 'polling' : 'watching');
        return;
      }
      default:
        return;
    }
  }

  async function connect(): Promise<void> {
    while (!closed && !lifetime.signal.aborted) {
      const connection = new AbortController();
      const abort = (): void => connection.abort();
      lifetime.signal.addEventListener('abort', abort, { once: true });
      const gate = createFrameGate();
      const heartbeat = (): void => {
        if (watchdog !== null) clearTimeout(watchdog);
        watchdog = setTimeout(abort, heartbeatMs);
      };
      if (!closed) options.onStatus('connecting');
      try {
        const response = await request(API_PATHS.events, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ targets: options.targets }),
          signal: connection.signal,
        });
        heartbeat();
        await consumeEvents(response, {
          signal: connection.signal,
          onFrame: frame => {
            heartbeat();
            if (!gate.accept(frame)) return;
            applyFrame(frame);
          },
        });
      } catch {
        // A closed or failed stream is visibly disconnected and resynchronized
        // by the next `ready` frame.
      } finally {
        if (watchdog !== null) clearTimeout(watchdog);
        watchdog = null;
        connection.abort();
        lifetime.signal.removeEventListener('abort', abort);
      }
      if (closed || lifetime.signal.aborted) break;
      options.onStatus('disconnected');
      await retry.wait();
    }
  }

  void connect();

  return () => {
    closed = true;
    lifetime.abort();
    if (debounce !== null) clearTimeout(debounce);
    debounce = null;
    if (watchdog !== null) clearTimeout(watchdog);
    watchdog = null;
    retry.dispose();
    options.parentSignal?.removeEventListener('abort', disconnect);
  };
}
