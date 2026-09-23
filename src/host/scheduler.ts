import { AsyncLocalStorage } from 'node:async_hooks';
import { FileManagerError, fail } from '../contracts/errors.js';
import { HEAVY_IO_QUEUE_LIMIT, LIMIT_DEFAULTS } from '../contracts/limits.js';

/**
 * One bounded scheduler for every operation that reads or writes a lot of file
 * bytes: copies, moves, uploads, downloads and full-content verification. The
 * budget is deliberately small because the limit exists to protect the Host
 * process, not to maximise throughput.
 *
 * The numbers themselves live in the frozen limit contract; these aliases only
 * give the scheduler vocabulary for them.
 */
export const DEFAULT_HEAVY_IO_CONCURRENCY = LIMIT_DEFAULTS.transferConcurrency;
export const DEFAULT_HEAVY_IO_QUEUE_LIMIT = HEAVY_IO_QUEUE_LIMIT;

export interface HeavyIoSchedulerOptions {
  /** Permits that may be held at the same time. */
  concurrency?: number;
  /** Operations allowed to wait for a permit before the surplus is refused. */
  queueLimit?: number;
}

export interface HeavyIoRunOptions {
  /** Cancels the operation while it is still waiting for a permit. */
  signal?: AbortSignal;
}

export interface HeavyIoStatus {
  concurrency: number;
  queueLimit: number;
  active: number;
  queued: number;
  peak: number;
}

export interface HeavyIoHandle<T> {
  promise: Promise<T>;
  /** Cancels the work if it is still queued; a running operation is not killed. */
  cancel(): void;
}

export interface HeavyIoScheduler {
  run<T>(operation: () => T | Promise<T>, options?: HeavyIoRunOptions): Promise<T>;
  submit<T>(operation: () => T | Promise<T>, options?: HeavyIoRunOptions): HeavyIoHandle<T>;
  /**
   * Takes a permit that is held until `release()`. Streaming work needs this
   * because its cost lasts as long as the stream, not as long as the call that
   * opened it.
   */
  acquire(options?: HeavyIoRunOptions): Promise<HeavyIoPermit>;
  /** Reads scheduler state without consuming a permit. */
  status(): HeavyIoStatus;
  /** Resolves once no operation is running or waiting. */
  drain(): Promise<void>;
}

export interface HeavyIoPermit {
  /** Releases the permit. Idempotent; a reentrant permit releases nothing. */
  release(): void;
}

interface Permit {
  released: boolean;
}

interface Waiter {
  resolve: (permit: Permit) => void;
  reject: (error: FileManagerError) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

function cancelledError(): FileManagerError {
  return new FileManagerError('CANCELLED', 'The queued file operation was cancelled before it started.', 499);
}

function overloadError(): FileManagerError {
  return new FileManagerError('TOO_MANY_REQUESTS', 'Too many file operations are already running. Wait for them to finish before retrying.', 429);
}

export function createHeavyIoScheduler(options: HeavyIoSchedulerOptions = {}): HeavyIoScheduler {
  const concurrency = options.concurrency ?? DEFAULT_HEAVY_IO_CONCURRENCY;
  const queueLimit = options.queueLimit ?? DEFAULT_HEAVY_IO_QUEUE_LIMIT;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) fail('INVALID_STATE', 'Heavy IO concurrency must be a positive safe integer.', 500);
  if (!Number.isSafeInteger(queueLimit) || queueLimit < 1) fail('INVALID_STATE', 'Heavy IO queue limit must be a positive safe integer.', 500);

  /** Tracks the permit held by the current async context so nested work reuses it. */
  const held = new AsyncLocalStorage<Permit>();
  const waiting: Waiter[] = [];
  const drains: Array<() => void> = [];
  let active = 0;
  let peak = 0;

  function settleDrains(): void {
    if (active > 0 || waiting.length > 0) return;
    while (drains.length) drains.shift()?.();
  }

  function permit(): Permit {
    active++;
    peak = Math.max(peak, active);
    return { released: false };
  }

  function release(current: Permit): void {
    if (current.released) return;
    current.released = true;
    active--;
    pump();
    settleDrains();
  }

  function pump(): void {
    while (active < concurrency && waiting.length > 0) {
      const waiter = waiting.shift();
      if (!waiter) return;
      if (waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort as () => void);
      waiter.resolve(permit());
    }
  }

  function acquirePermit(signal: AbortSignal | undefined): Promise<Permit> {
    if (active < concurrency) return Promise.resolve(permit());
    if (waiting.length >= queueLimit) return Promise.reject(overloadError());
    return new Promise<Permit>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, onAbort: undefined };
      waiter.onAbort = () => {
        const index = waiting.indexOf(waiter);
        if (index !== -1) waiting.splice(index, 1);
        reject(cancelledError());
        settleDrains();
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      waiting.push(waiter);
      pump();
    });
  }

  function execute<T>(operation: () => T | Promise<T>, current: Permit): Promise<T> {
    return held.run(current, async () => {
      try {
        return await operation();
      } finally {
        release(current);
      }
    });
  }

  function run<T>(operation: () => T | Promise<T>, runOptions?: HeavyIoRunOptions): Promise<T> {
    if (typeof operation !== 'function') fail('INVALID_STATE', 'Heavy IO work must be a function.', 500);
    const signal = runOptions?.signal;
    if (signal?.aborted) return Promise.reject(cancelledError());
    const current = held.getStore();
    // Work that already owns a permit keeps it: re-acquiring here would let a
    // nested operation wait behind its own caller and deadlock the budget.
    if (current && !current.released) return Promise.resolve().then(() => operation());
    return acquirePermit(signal).then(current => execute(operation, current));
  }

  function submit<T>(operation: () => T | Promise<T>, runOptions?: HeavyIoRunOptions): HeavyIoHandle<T> {
    const controller = new AbortController();
    const outer = runOptions?.signal;
    const signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
    return { promise: run(operation, { signal }), cancel: () => controller.abort() };
  }

  function acquire(runOptions?: HeavyIoRunOptions): Promise<HeavyIoPermit> {
    const signal = runOptions?.signal;
    if (signal?.aborted) return Promise.reject(cancelledError());
    const current = held.getStore();
    // A caller that already holds a permit gets a permit that releases nothing,
    // so releasing nested work can never free its caller's slot.
    if (current && !current.released) return Promise.resolve({ release: () => {} });
    return acquirePermit(signal).then(taken => ({ release: () => release(taken) }));
  }

  return {
    run,
    submit,
    acquire,
    status: () => ({ concurrency, queueLimit, active, queued: waiting.length, peak }),
    drain: () => {
      if (active === 0 && waiting.length === 0) return Promise.resolve();
      return new Promise<void>(resolve => { drains.push(resolve); });
    },
  };
}

let shared: HeavyIoScheduler | undefined;

/**
 * The profile-level budget every Host component shares. It always uses the
 * frozen contract defaults; a Host that needs a configured budget constructs
 * its own scheduler with {@link createHeavyIoScheduler} and shares that one
 * instance, so the effective limit can never depend on who called first.
 */
export function sharedHeavyIoScheduler(): HeavyIoScheduler {
  shared ??= createHeavyIoScheduler();
  return shared;
}
