/**
 * The session-scoped notification store.
 *
 * A notification is a *display record* of something that already happened. It
 * owns no file, task or grant state: clearing, reading or removing notifications
 * can never change the file-task clipboard, cancel a task, close history, drop a
 * draft or revoke a root. The store is deliberately free of React, callbacks and
 * Host requests — it holds data only, so it can be created by the plugin root and
 * outlive any panel that displays it.
 *
 * Two bounded memories are kept:
 *  - `entries`, at most `limit` (100) newest-first display records;
 *  - `reported`, at most `dedupeLimit` (400) source keys, so a repeated poll or
 *    SSE frame for the same event cannot produce a second notification.
 * Both are evicted oldest-first, so a long session cannot grow without bound.
 */

export type NotificationLevel = 'success' | 'info' | 'warning' | 'error';

/**
 * The surface a notification may navigate to; the UI resolves it, not the store.
 *
 * The browsing entry point is no longer a chooseable directory, so no event has a
 * "manage locations" destination: a record either names work the user can act on
 * (the task area) or the document viewer.
 */
export type NotificationSurface = 'tasks' | 'viewer';

export interface NotificationSurfaceAction {
  readonly kind: 'surface';
  readonly surface: NotificationSurface;
}

/** A copy that failed: the store keeps the exact text the user can copy by hand. */
export interface NotificationManualCopyAction {
  readonly kind: 'manual-copy';
  readonly text: string;
}

export type NotificationAction = NotificationSurfaceAction | NotificationManualCopyAction;

export interface NotificationInput {
  readonly level: NotificationLevel;
  readonly title: string;
  readonly message?: string;
  readonly details?: readonly string[];
  readonly action?: NotificationAction;
  /**
   * Identifies the *event*, not the wording: publishing twice with one key keeps
   * exactly one notification. Manual actions (a click, a typed request) omit it,
   * so doing the same thing twice still reports twice.
   */
  readonly dedupeKey?: string;
  /** A stable business code, shown as diagnostic detail. */
  readonly code?: string;
}

export interface NotificationEntry extends NotificationInput {
  readonly id: string;
  /** Epoch milliseconds; the UI formats it. */
  readonly createdAt: number;
  readonly read: boolean;
}

export interface NotificationSnapshot {
  /** Newest first; the snapshot reference is stable until something changes. */
  readonly entries: readonly NotificationEntry[];
  readonly unreadCount: number;
}

export interface NotificationStore {
  getSnapshot(): NotificationSnapshot;
  /** The listener takes no argument; read the snapshot through `getSnapshot`. */
  subscribe(listener: () => void): () => void;
  /**
   * Record one event and return its id.
   *
   * A repeat of an already-reported `dedupeKey` returns the id that key was
   * first given — and the matching display entry may already have been removed
   * or cleared, so a returned id is **not** a promise that `getSnapshot()` still
   * holds it. The dedupe memory is bounded: once its oldest key is evicted the
   * same key can be reported again, so a suppressed repeat is not permanent.
   * A disposed store records nothing and returns `''`.
   */
  publish(input: NotificationInput): string;
  /** No argument marks everything read; unknown ids are ignored. */
  markRead(ids?: readonly string[]): void;
  remove(id: string): void;
  clear(): void;
  /** Releases listeners and records; later calls are safe no-ops. */
  dispose(): void;
}

export const NOTIFICATION_LIMIT = 100;
export const NOTIFICATION_DEDUPE_LIMIT = 400;

export interface NotificationStoreOptions {
  readonly limit?: number | undefined;
  readonly dedupeLimit?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly id?: (() => string) | undefined;
}

const LEVELS: readonly NotificationLevel[] = Object.freeze(['success', 'info', 'warning', 'error']);
/** The only surfaces a notification may navigate to; the UI resolves them. */
const SURFACES: readonly NotificationSurface[] = Object.freeze(['tasks', 'viewer']);

/**
 * Rebuild the action from a per-kind whitelist. The store holds *data*: an extra
 * field on the caller's object — a callback, a React node, anything else — must
 * not travel into the history, so it is dropped rather than copied.
 */
function sanitizeAction(action: unknown): NotificationAction | undefined {
  if (action === undefined) return undefined;
  if (typeof action !== 'object' || action === null) throw new TypeError('A notification action must be an object.');
  const kind = (action as { kind?: unknown }).kind;
  if (kind === 'surface') {
    const surface = (action as { surface?: unknown }).surface;
    if (!SURFACES.includes(surface as NotificationSurface)) throw new TypeError(`Unknown notification surface: ${String(surface)}`);
    return Object.freeze({ kind: 'surface', surface: surface as NotificationSurface });
  }
  if (kind === 'manual-copy') {
    const text = (action as { text?: unknown }).text;
    if (typeof text !== 'string') throw new TypeError('A manual-copy action requires string text.');
    return Object.freeze({ kind: 'manual-copy', text });
  }
  throw new TypeError(`Unknown notification action kind: ${String(kind)}`);
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`A notification ${field} must be a string.`);
  return value;
}

/** Details are display strings only, copied so a later caller mutation cannot leak in. */
function optionalDetails(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new TypeError('Notification details must be an array of strings.');
  }
  return Object.freeze([...value] as string[]);
}

function freezeEntry(entry: NotificationEntry): NotificationEntry {
  return Object.freeze(entry);
}

export function createNotificationStore(options: NotificationStoreOptions = {}): NotificationStore {
  const limit = options.limit ?? NOTIFICATION_LIMIT;
  const dedupeLimit = options.dedupeLimit ?? NOTIFICATION_DEDUPE_LIMIT;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('The notification limit must be a positive integer.');
  if (!Number.isSafeInteger(dedupeLimit) || dedupeLimit < 1) throw new TypeError('The notification dedupe limit must be a positive integer.');
  let sequence = 0;
  const id = options.id ?? (() => `n${++sequence}`);

  let entries: readonly NotificationEntry[] = Object.freeze([]);
  let unreadCount = 0;
  let snapshot: NotificationSnapshot = Object.freeze({ entries, unreadCount });
  const listeners = new Set<() => void>();
  /** dedupeKey -> entry id, in insertion order so the oldest key evicts first. */
  const reported = new Map<string, string>();
  let disposed = false;

  const countUnread = (list: readonly NotificationEntry[]): number =>
    list.reduce((total, entry) => (entry.read ? total : total + 1), 0);

  function commit(next: readonly NotificationEntry[]): void {
    entries = next;
    unreadCount = countUnread(next);
    snapshot = Object.freeze({ entries, unreadCount });
    // Iterate a copy: a listener may subscribe or unsubscribe while it runs.
    for (const listener of [...listeners]) listener();
  }

  function remember(key: string, entryId: string): void {
    reported.set(key, entryId);
    while (reported.size > dedupeLimit) {
      const oldest = reported.keys().next();
      if (oldest.done === true) break;
      reported.delete(oldest.value);
    }
  }

  return {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    publish(input) {
      if (disposed) return '';
      if (!LEVELS.includes(input.level)) throw new TypeError(`Unknown notification level: ${String(input.level)}`);
      if (typeof input.title !== 'string' || !input.title) throw new TypeError('A notification requires a title.');
      // Validate every field before the dedupe shortcut: a malformed repeat is a
      // caller bug and must be reported, not silently answered with an old id.
      const message = optionalText(input.message, 'message');
      const code = optionalText(input.code, 'code');
      const details = optionalDetails(input.details);
      const action = sanitizeAction(input.action);
      const key = typeof input.dedupeKey === 'string' && input.dedupeKey ? input.dedupeKey : undefined;
      if (key !== undefined) {
        const known = reported.get(key);
        // The same event reported again never adds a second entry and never
        // resurrects an unread one; the caller gets the id it already has.
        if (known !== undefined) return known;
      }
      const entry = freezeEntry({
        id: id(),
        level: input.level,
        title: input.title,
        ...(message !== undefined ? { message } : {}),
        ...(details !== undefined ? { details } : {}),
        ...(action !== undefined ? { action } : {}),
        ...(key !== undefined ? { dedupeKey: key } : {}),
        ...(code !== undefined ? { code } : {}),
        createdAt: now(),
        read: false,
      });
      if (key !== undefined) remember(key, entry.id);
      const next = Object.freeze([entry, ...entries].slice(0, limit));
      commit(next);
      return entry.id;
    },

    markRead(ids) {
      if (disposed || !entries.length) return;
      const target = ids === undefined ? undefined : new Set(ids);
      const matches = (entry: NotificationEntry): boolean => !entry.read && (target === undefined || target.has(entry.id));
      if (!entries.some(matches)) return;
      commit(Object.freeze(entries.map(entry => (matches(entry) ? freezeEntry({ ...entry, read: true }) : entry))));
    },

    remove(id) {
      if (disposed) return;
      if (!entries.some(entry => entry.id === id)) return;
      commit(Object.freeze(entries.filter(entry => entry.id !== id)));
    },

    clear() {
      if (disposed || !entries.length) return;
      // Display records only: the dedupe memory survives, so an event the user
      // already saw is not re-announced by a repeated poll or SSE frame.
      commit(Object.freeze([]));
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      reported.clear();
      entries = Object.freeze([]);
      unreadCount = 0;
      snapshot = Object.freeze({ entries, unreadCount });
    },
  };
}
