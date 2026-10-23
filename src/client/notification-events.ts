/**
 * Turns live activity transitions into notifications, and gives the UI one
 * explicit way to report a terminal result it received directly.
 *
 * The rules that matter:
 *  - **Nothing merely discovered is announced.** The observer reports a record
 *    only when an *already known* record moves into a terminal state. History the
 *    panel imports asynchronously (`tasks.list` right after bootstrap), a page
 *    re-render, or a record whose first sighting is already finished are all
 *    silent: this observer cannot tell "it just finished" from "it was already
 *    finished before anyone looked".
 *  - **The UI owns the fast path.** When a user's own action returns a terminal
 *    result — a refused transfer, an instantly finished download, a task the Host
 *    rejects on start — the caller reports it with `reportTerminal` (or the
 *    module-level `reportTerminalNotification`). Both share the observer's key,
 *    so that event is shown exactly once whichever path arrives first.
 *  - **Repeats are free.** Polling, SSE frames and re-renders republish the same
 *    (id, status, revision) many times; a repeat is not a transition.
 *  - **A retry is a new generation**: finishing again in a higher
 *    `historyRevision` is a real transition, so it notifies again — even when the
 *    observer never saw the reopened frame, because the raised revision on a
 *    known, unfinished-or-finished record is itself the evidence.
 *  - **A long history import cannot swallow a live transition.** Previous states
 *    are read from a bounded snapshot taken at the start of each pass, and the
 *    bounded cache prefers to forget finished records, so evicting history never
 *    makes running work look brand new.
 *
 * References are plugin-owned actions rather than Host history, so they are
 * reported on first sighting: a new request is an info notification that can
 * navigate to the task area, and a blocked one is a warning whose reason is the
 * translated error, with the requested mentions kept as details.
 */

import { TERMINAL_STATUSES, type ActivityRecord, type ActivityStore, type ActivityView } from './activity.js';
import type { Translate } from './i18n.js';
import type { NotificationInput, NotificationLevel, NotificationStore } from './notifications.js';

/** The UI speaks about one record; the store keeps two lists. */
export type ActivityEventKind = 'task' | 'transfer';

const STORE_KIND: Record<ActivityEventKind, 'tasks' | 'transfers'> = Object.freeze({ task: 'tasks', transfer: 'transfers' });
const KINDS: readonly ('tasks' | 'transfers')[] = Object.freeze(['tasks', 'transfers']);

const LEVEL_BY_STATUS: Record<string, NotificationLevel> = Object.freeze({
  completed: 'success',
  partial: 'warning',
  failed: 'error',
  cancelled: 'info',
  interrupted: 'warning',
});

/** Bounded memory: how many records and reference attempts one observer tracks. */
const KNOWN_LIMIT = 1000;

/** What one observer remembers about a record: the last status and generation it saw. */
interface KnownRecord {
  readonly status: string;
  readonly revision: number;
}

/** Stable diagnostic code for "a reference is waiting to be inserted". */
export const REFERENCE_PENDING_CODE = 'REFERENCE_PENDING';

export type TerminalReportOptions = {
  /** A stable business code from the failure, shown as diagnostic detail. */
  readonly code?: string | undefined;
  /** A richer summary the caller already knows; the observer never invents one. */
  readonly message?: string | undefined;
};

const field = (record: object, key: string): unknown => (record as unknown as Record<string, unknown>)[key];

/** The revision a retry mints; an unknown revision counts as the first one. */
export function revisionOf(record: ActivityView): number {
  const revision = record.historyRevision;
  return Number.isSafeInteger(revision) && (revision as number) >= 0 ? (revision as number) : 0;
}

/** One event identity: the same record in the same state of the same generation. */
export function terminalEventKey(kind: 'tasks' | 'transfers', id: string, revision: number, status: string): string {
  return `terminal:${kind}:${id}:${revision}:${status}`;
}

export function terminalLevel(status: string): NotificationLevel {
  return LEVEL_BY_STATUS[status] ?? 'info';
}

/**
 * The title reuses the existing translations: which operation ran and how it
 * ended. The wording is fixed when the event happens, so a later locale switch
 * cannot rewrite history.
 */
function terminalTitle(t: Translate, kind: 'tasks' | 'transfers', record: ActivityView): string {
  const status = t(`status.${record.status}`);
  if (kind === 'tasks') {
    const operation = field(record, 'operation');
    return `${t(operation === 'move' ? 'cut' : operation === 'copy' ? 'copy' : 'tasks')} · ${status}`;
  }
  const direction = field(record, 'direction');
  return `${t(direction === 'download' ? 'download' : 'uploadFiles')} · ${status}`;
}

function publishTerminal(
  notifications: NotificationStore, t: Translate, kind: 'tasks' | 'transfers',
  record: ActivityView, key: string, options: TerminalReportOptions,
): string | null {
  const input: NotificationInput = {
    level: terminalLevel(record.status),
    title: terminalTitle(t, kind, record),
    ...(options.message !== undefined ? { message: options.message } : {}),
    ...(options.code !== undefined ? { code: options.code } : {}),
    action: { kind: 'surface', surface: 'tasks' },
    dedupeKey: key,
  };
  const id = notifications.publish(input);
  return id || null;
}

/**
 * Report a terminal outcome without an observer — for a UI that already holds the
 * Host's answer. Shares the observer's key, so the two can never both be shown.
 */
export function reportTerminalNotification(
  notifications: NotificationStore, t: Translate, kind: ActivityEventKind,
  record: ActivityView, options: TerminalReportOptions = {},
): string | null {
  const list = STORE_KIND[kind];
  if (list === undefined || !TERMINAL_STATUSES.includes(record.status)) return null;
  return publishTerminal(notifications, t, list, record, terminalEventKey(list, record.id, revisionOf(record), record.status), options);
}

export interface NotificationEventsOptions<Record_ extends ActivityRecord = ActivityRecord> {
  readonly notifications: NotificationStore;
  readonly activity: ActivityStore<Record_>;
  readonly t: Translate;
}

export interface NotificationEvents {
  /**
   * Report an outcome a user action produced directly. Call it only at a
   * mutation's own result site — never from a generic record sync or history
   * refresh, which would announce imported work as if it just happened.
   */
  reportTerminal(kind: ActivityEventKind, record: ActivityView, options?: TerminalReportOptions): string | null;
  dispose(): void;
}

export function createNotificationEvents<Record_ extends ActivityRecord = ActivityRecord>(
  options: NotificationEventsOptions<Record_>,
): NotificationEvents {
  const { notifications, activity, t } = options;
  /** kind -> record id -> the status and generation this observer last saw. */
  const known = new Map<string, Map<string, KnownRecord>>([['tasks', new Map()], ['transfers', new Map()]]);
  /** Reference attempts (plugin-owned) already reported, so a re-render is not a new request. */
  const announced = new Set<string>();
  let disposed = false;

  /**
   * Record the new state. Lookups deliberately read a per-pass snapshot (see
   * `observe`), so an eviction during a long history scan can never make an
   * already-known record look brand new.
   */
  function rememberKnown(seen: Map<string, KnownRecord>, id: string, status: string, revision: number): void {
    seen.delete(id);
    seen.set(id, { status, revision });
    while (seen.size > KNOWN_LIMIT) {
      // Keep work that is still running: a finished record is the cheapest to
      // forget, and forgetting an active one could hide its completion.
      let evicted = false;
      for (const [key, value] of seen) {
        if (TERMINAL_STATUSES.includes(value.status)) { seen.delete(key); evicted = true; break; }
      }
      if (evicted) continue;
      const oldest = seen.keys().next();
      if (oldest.done === true) break;
      seen.delete(oldest.value);
    }
  }

  function rememberAnnounced(key: string): void {
    announced.add(key);
    while (announced.size > KNOWN_LIMIT) {
      const oldest = announced.values().next();
      if (oldest.done === true) break;
      announced.delete(oldest.value);
    }
  }

  function publishReference(record: ActivityRecord, status: 'pending' | 'blocked', key: string): void {
    const mentions = field(record, 'mentions');
    // The requested mentions are context, not the reason: the reason is the
    // translated error, and the mentions travel as details.
    const details = Array.isArray(mentions)
      ? Object.freeze(mentions.filter((mention): mention is string => typeof mention === 'string'))
      : Object.freeze([] as readonly string[]);
    const reason = field(record, 'error');
    notifications.publish({
      level: status === 'pending' ? 'info' : 'warning',
      title: status === 'pending' ? t('referenceWaiting') : t(typeof reason === 'string' && reason ? reason : 'status.failed'),
      ...(details.length ? { details } : {}),
      // The pending entry keeps the task area as its handling location: clearing
      // notifications never removes the control that resolves the request.
      action: { kind: 'surface', surface: 'tasks' },
      ...(status === 'pending' ? { code: REFERENCE_PENDING_CODE } : {}),
      dedupeKey: key,
    });
  }

  function observe(): void {
    if (disposed) return;
    const state = activity.getSnapshot();
    // Take the previous states from a bounded copy before this pass changes
    // anything: a large history import must not evict the very records this pass
    // has not looked at yet, which would make a live transition look like a
    // first sighting and swallow it.
    const before = new Map<string, Map<string, KnownRecord>>();
    for (const [kind, seen] of known) before.set(kind, new Map(seen));
    for (const kind of KINDS) {
      const seen = known.get(kind) as Map<string, KnownRecord>;
      const previousOf = before.get(kind) as Map<string, KnownRecord>;
      for (const record of state[kind]) {
        const previous = previousOf.get(record.id);
        const revision = revisionOf(record);
        rememberKnown(seen, record.id, record.status, revision);
        // A first sighting is history as far as this observer knows: the panel
        // imports past tasks asynchronously, so it must never be announced.
        if (previous === undefined) continue;
        // A closed card is the user's own decision: never re-announce it.
        if (record.dismissed === true) continue;
        // Progress updates (queued, running) are not results either.
        if (!TERMINAL_STATUSES.includes(record.status)) continue;
        // Three things are results: a live transition into a terminal state, a
        // status change between two terminal states, and a retry generation that
        // finished without this observer ever seeing the reopened frame. The same
        // status in the same generation is just a repeated poll or SSE frame.
        const result = !TERMINAL_STATUSES.includes(previous.status)
          || previous.status !== record.status
          || revision > previous.revision;
        if (!result) continue;
        publishTerminal(notifications, t, kind, record, terminalEventKey(kind, record.id, revision, record.status), {});
      }
    }
    for (const record of state.references) {
      const status = record.status;
      if (status !== 'pending' && status !== 'blocked') continue;
      // A retry stamps a new `updatedAt`, which is a new attempt.
      const key = `reference:${record.id}:${status}:${String(record.updatedAt)}`;
      if (announced.has(key)) continue;
      rememberAnnounced(key);
      publishReference(record, status, key);
    }
  }

  const unsubscribe = activity.subscribe(observe);

  return {
    reportTerminal(kind, record, reportOptions = {}) {
      if (disposed) return null;
      const list = STORE_KIND[kind];
      if (list === undefined || !TERMINAL_STATUSES.includes(record.status)) return null;
      return publishTerminal(notifications, t, list, record, terminalEventKey(list, record.id, revisionOf(record), record.status), reportOptions);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      known.get('tasks')?.clear();
      known.get('transfers')?.clear();
      announced.clear();
    },
  };
}
