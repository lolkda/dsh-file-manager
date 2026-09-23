import { watch as nativeWatch } from 'node:fs';
import { FileManagerError } from '../contracts/errors.js';
import { EVENT_MAX_QUEUED, WATCH_MAX_RECORDS, WATCH_MAX_TARGETS } from '../contracts/limits.js';
import type { DirectoryLease } from './io.js';
import type { Manager } from './manager.js';

/** One broadcastable observation. The event route adds the sequence number. */
export interface WatchEvent {
  kind: string;
  [key: string]: unknown;
}

export interface EventHub {
  publish(event: WatchEvent): void;
  subscribe(listener: (event: WatchEvent) => void): () => boolean;
  close(): void;
}

/** Broadcast only invalidation/progress metadata; closing ends every consumer. */
export function createEventHub(): EventHub {
  const listeners = new Set<(event: WatchEvent) => void>();
  let stopped = false;
  return {
    publish(event: WatchEvent) {
      if (stopped) return;
      for (const listener of listeners) { try { listener(event); } catch { /* Observers own their transport failures. */ } }
    },
    subscribe(listener: (event: WatchEvent) => void) {
      if (stopped) throw new FileManagerError('SERVICE_STOPPED', 'The event stream is closing.', 503);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (stopped) return;
      stopped = true;
      for (const listener of listeners) { try { listener({ kind: 'closed' }); } catch { /* A broken observer must not block shutdown. */ } }
      listeners.clear();
    },
  };
}

export interface DirectoryWatcher {
  close(): void;
  on?(event: string, listener: (error: NodeJS.ErrnoException) => void): unknown;
}

export type WatchFactory = (address: string, options: { persistent: boolean }, listener: () => void) => DirectoryWatcher;

export interface WatchTarget {
  rootId: string;
  path: string;
}

export interface WatchService {
  subscribe(
    targets: readonly WatchTarget[],
    listener: (event: WatchEvent) => void,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

interface WatchRecord {
  key: string;
  target: WatchTarget;
  listeners: Map<symbol, (event: WatchEvent) => void>;
  lease: DirectoryLease | null;
  watcher: DirectoryWatcher | null;
  inFlight: Promise<void> | null;
  closePromise: Promise<void> | null;
  statusKey: string;
  stopped: boolean;
  nativeDisabled: boolean;
  interval: NodeJS.Timeout | null;
  debounce: NodeJS.Timeout | null;
  pendingReason: string | null;
}

/** Shared, reference-counted observations over authorized directory leases. */
export function createWatchService({ manager, pollIntervalMs = 2000, debounceMs = 60, watchFactory = nativeWatch as unknown as WatchFactory }: {
  manager: Manager;
  pollIntervalMs?: number;
  debounceMs?: number;
  watchFactory?: WatchFactory;
}): WatchService {
  const records = new Map<string, WatchRecord>();
  let stopped = false;

  function publish(record: WatchRecord, event: WatchEvent): void {
    if (record.stopped) return;
    const value = { ...event, rootId: record.target.rootId, path: record.target.path };
    for (const listener of record.listeners.values()) {
      try { listener({ ...value }); } catch { /* A disconnected observer must not break filesystem monitoring. */ }
    }
  }

  function status(record: WatchRecord, next: string, code?: string): void {
    const key = `${next}:${code ?? ''}`;
    if (record.statusKey === key) return;
    record.statusKey = key;
    publish(record, { kind: 'watch-status', status: next, ...(code ? { code } : {}) });
  }

  async function releaseLease(record: WatchRecord): Promise<void> {
    const watcher = record.watcher;
    record.watcher = null;
    watcher?.close();
    const lease = record.lease;
    record.lease = null;
    await lease?.close();
  }

  function schedule(record: WatchRecord, reason: string): void {
    if (record.stopped || stopped) return;
    record.pendingReason = reason === 'watch' ? 'watch' : record.pendingReason ?? reason;
    if (record.debounce) return;
    record.debounce = setTimeout(() => {
      record.debounce = null;
      const next = record.pendingReason;
      record.pendingReason = null;
      void refresh(record, next ?? 'reconcile');
    }, debounceMs);
    record.debounce.unref?.();
  }

  function refresh(record: WatchRecord, reason: string): Promise<void> {
    if (record.stopped || stopped) return Promise.resolve();
    if (record.inFlight) {
      schedule(record, reason);
      return record.inFlight;
    }
    record.inFlight = (async () => {
      try {
        const recovering = !record.lease;
        if (!record.lease) {
          const lease = await manager.io.acquireDirectory(record.target);
          if (record.stopped || stopped) { await lease.close(); return; }
          record.lease = lease;
          record.nativeDisabled = false;
        }
        await record.lease.verify();
        if (record.stopped || stopped) return;
        if (!record.watcher && !record.nativeDisabled) {
          try {
            record.watcher = watchFactory(record.lease.address, { persistent: false }, () => schedule(record, 'watch'));
            record.watcher.on?.('error', error => {
              if (record.stopped) return;
              record.watcher?.close();
              record.watcher = null;
              record.nativeDisabled = true;
              status(record, 'polling', error.code ?? 'WATCH_UNAVAILABLE');
              schedule(record, 'reconcile');
            });
          } catch (error) {
            record.nativeDisabled = true;
            status(record, 'polling', (error as NodeJS.ErrnoException).code ?? 'WATCH_UNAVAILABLE');
          }
        }
        // Observe through the lease again, not through a raw absolute path. A
        // name the grammar cannot express must not fail the whole observation.
        await record.lease.entries();
        if (record.stopped || stopped) return;
        status(record, record.watcher ? 'watching' : 'polling');
        publish(record, { kind: 'invalidate', reason: recovering ? 'recovered' : reason });
      } catch (error) {
        if (record.stopped || stopped) return;
        status(record, 'unavailable', (error as NodeJS.ErrnoException).code ?? 'IO_ERROR');
        await releaseLease(record).catch(() => {});
      }
    })().finally(() => { record.inFlight = null; });
    return record.inFlight;
  }

  async function closeRecord(record: WatchRecord): Promise<void> {
    if (record.closePromise) return record.closePromise;
    record.stopped = true;
    record.listeners.clear();
    if (record.interval) clearInterval(record.interval);
    if (record.debounce) clearTimeout(record.debounce);
    record.debounce = null;
    record.pendingReason = null;
    records.delete(record.key);
    record.closePromise = (async () => {
      record.watcher?.close();
      record.watcher = null;
      await record.inFlight;
      await releaseLease(record);
    })();
    return record.closePromise;
  }

  async function subscribe(targets: readonly WatchTarget[], listener: (event: WatchEvent) => void, { signal }: { signal?: AbortSignal | undefined } = {}): Promise<() => Promise<void>> {
    if (stopped) throw new FileManagerError('SERVICE_STOPPED', 'Filesystem monitoring is stopping.', 503);
    if (!Array.isArray(targets) || targets.length > WATCH_MAX_TARGETS || typeof listener !== 'function') throw new FileManagerError('INVALID_REQUEST', `At most ${WATCH_MAX_TARGETS} directory watch targets are allowed.`);
    const unique = new Map<string, WatchTarget>();
    for (const target of targets) {
      if (!target || typeof target.rootId !== 'string' || typeof target.path !== 'string') throw new FileManagerError('INVALID_REQUEST', 'A watch target needs a root id and directory path.');
      unique.set(JSON.stringify([target.rootId, target.path]), { rootId: target.rootId, path: target.path });
    }
    if (signal?.aborted) return async () => {};
    const token = Symbol('directory-observer');
    const retained: WatchRecord[] = [];
    let releasePromise: Promise<void> | undefined;
    const release = (): Promise<void> => {
      if (releasePromise) return releasePromise;
      signal?.removeEventListener('abort', abort);
      releasePromise = Promise.all(retained.map(async record => {
        record.listeners.delete(token);
        if (record.listeners.size === 0) await closeRecord(record);
      })).then(() => undefined);
      return releasePromise;
    };
    const abort = () => { void release().catch(() => {}); };
    try {
      for (const [key, target] of unique) {
        let record = records.get(key);
        if (!record) {
          if (records.size >= WATCH_MAX_RECORDS) throw new FileManagerError('TOO_MANY_REQUESTS', 'Too many active directory observations.', 429);
          record = {
            key, target, listeners: new Map(), lease: null, watcher: null, inFlight: null, closePromise: null,
            statusKey: '', stopped: false, nativeDisabled: false, interval: null, debounce: null, pendingReason: null,
          };
          records.set(key, record);
          record.interval = setInterval(() => { void refresh(record as WatchRecord, 'reconcile'); }, pollIntervalMs);
          record.interval.unref?.();
        }
        record.listeners.set(token, listener);
        retained.push(record);
        await refresh(record, 'recovered');
      }
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted || stopped) await release();
      return release;
    } catch (error) {
      await release();
      throw error;
    }
  }

  return {
    subscribe,
    async close() {
      stopped = true;
      await Promise.all([...records.values()].map(closeRecord));
    },
  };
}

export { EVENT_MAX_QUEUED };
