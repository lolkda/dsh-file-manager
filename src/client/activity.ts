/**
 * Root-owned activity store: clipboard, task/transfer cards and reference
 * requests. It is a view model only — it performs no I/O and owns no timers.
 *
 * Two invariants matter to the UI:
 *  - a history revision is a generation: an older revision can never hide a
 *    newer retry, and the same revision can never undo a dismissal;
 *  - `claim` is a compare-and-set so a second render, a late response or a
 *    cancelled request can never replay an insertion.
 */

export type ActivityKind = 'tasks' | 'transfers' | 'references';

export const ACTIVE_STATUSES: readonly string[] = Object.freeze(['queued', 'running']);
export const TERMINAL_STATUSES: readonly string[] = Object.freeze(['completed', 'partial', 'failed', 'cancelled', 'interrupted']);

/** The fields the view model itself reads from a task, transfer or reference. */
export interface ActivityView {
  readonly id: string;
  readonly status: string;
  /** Task views carry an ISO string, transfer views epoch milliseconds. */
  readonly updatedAt?: number | string | undefined;
  readonly historyRevision?: number | undefined;
  readonly dismissed?: boolean | undefined;
  readonly canDismiss?: boolean | undefined;
}

/** A stored record; Host view fields beyond this base survive every commit. */
export interface ActivityRecord extends ActivityView {
  readonly updatedAt: number | string;
}

export interface ClipboardEntry {
  readonly rootId: string;
  readonly path: string;
  readonly version: string;
  readonly expectedVersion?: string;
}

export interface Clipboard {
  readonly operation: 'copy' | 'move';
  readonly items: readonly ClipboardEntry[];
}

export interface ActivityError {
  readonly code?: string;
  readonly message?: string;
}

export interface ActivityFailure {
  readonly kind: 'task' | 'transfer';
  readonly taskId: string;
  readonly error: ActivityError;
}

export interface ActivitySnapshot<TRecord extends ActivityRecord = ActivityRecord> {
  readonly clipboard: Clipboard | null;
  readonly tasks: readonly TRecord[];
  readonly transfers: readonly TRecord[];
  readonly references: readonly TRecord[];
  readonly tasksCollapsed: boolean;
  readonly historyPending: boolean;
  readonly historyFailures: readonly ActivityFailure[];
}

export interface PutOptions {
  readonly partial?: boolean;
}

export interface ActivityCapabilities {
  readonly taskHistory?: boolean;
}

export interface ActivityCounts<TRecord extends ActivityView> {
  readonly visibleTasks: readonly TRecord[];
  readonly visibleTransfers: readonly TRecord[];
  /** Cards that need attention: still running, or the Host refuses to close them. */
  readonly active: number;
  /** Cards that may be closed right now. */
  readonly closable: number;
}

export interface ActivityStore<TRecord extends ActivityRecord = ActivityRecord> {
  getSnapshot(): ActivitySnapshot<TRecord>;
  subscribe(listener: () => void): () => void;
  clipboard(value: Clipboard | null): void;
  collapse(value: unknown): void;
  history(pending: unknown, failures?: readonly ActivityFailure[]): void;
  remove(kind: ActivityKind, id: string): void;
  put(kind: ActivityKind, value: TRecord, options?: PutOptions): boolean;
  /** Moves `id` from one status to another exactly once. */
  claim(kind: ActivityKind, id: string, from: string, to: string): boolean;
}

export const isActivityRunning = (record: ActivityView): boolean => ACTIVE_STATUSES.includes(record.status);

export const isActivityVisible = (record: ActivityView): boolean => isActivityRunning(record) || record.dismissed !== true;

export const canDismissActivity = (record: ActivityView, capabilities: ActivityCapabilities): boolean =>
  Boolean(capabilities.taskHistory)
  && !isActivityRunning(record)
  && TERMINAL_STATUSES.includes(record.status)
  && record.dismissed !== true
  && record.canDismiss === true;

export function activityCounts<TRecord extends ActivityView>(
  records: { readonly tasks: readonly TRecord[]; readonly transfers: readonly TRecord[] },
  capabilities: ActivityCapabilities,
): ActivityCounts<TRecord> {
  const visibleTasks = records.tasks.filter(record => isActivityVisible(record));
  const visibleTransfers = records.transfers.filter(record => isActivityVisible(record));
  const visible = [...visibleTasks, ...visibleTransfers];
  return {
    visibleTasks,
    visibleTransfers,
    active: visible.filter(record => isActivityRunning(record) || (Boolean(capabilities.taskHistory) && record.canDismiss === false)).length,
    closable: visible.filter(record => canDismissActivity(record, capabilities)).length,
  };
}

/**
 * The legacy ordering rule: two timestamps of the same kind compare directly,
 * while a mixed pair never counts as newer (JavaScript would compare NaN).
 */
const isOlder = (previous: number | string, value: number | string): boolean =>
  typeof previous === 'number' && typeof value === 'number' ? previous > value
    : typeof previous === 'string' && typeof value === 'string' ? previous > value
      : false;

const revisionOf = (record: ActivityView | undefined): number =>
  (Number.isSafeInteger(record?.historyRevision) && (record?.historyRevision ?? -1) >= 0 ? record?.historyRevision ?? 0 : 0);

export function createActivityStore<TRecord extends ActivityRecord = ActivityRecord>(): ActivityStore<TRecord> {
  let state: ActivitySnapshot<TRecord> = Object.freeze({
    clipboard: null,
    tasks: Object.freeze([] as readonly TRecord[]),
    transfers: Object.freeze([] as readonly TRecord[]),
    references: Object.freeze([] as readonly TRecord[]),
    tasksCollapsed: false,
    historyPending: false,
    historyFailures: Object.freeze([] as readonly ActivityFailure[]),
  });
  const listeners = new Set<() => void>();

  function commit(next: ActivitySnapshot<TRecord>): void {
    state = Object.freeze(next);
    for (const listener of listeners) listener();
  }

  function replace(kind: ActivityKind, records: readonly TRecord[]): void {
    const lists: Record<ActivityKind, readonly TRecord[]> = {
      tasks: state.tasks,
      transfers: state.transfers,
      references: state.references,
    };
    lists[kind] = Object.freeze(records);
    commit({ ...state, ...lists });
  }

  return {
    getSnapshot: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    clipboard(value) {
      commit({ ...state, clipboard: value });
    },

    collapse(value) {
      commit({ ...state, tasksCollapsed: value === true });
    },

    history(pending, failures = state.historyFailures) {
      commit({ ...state, historyPending: pending === true, historyFailures: Object.freeze([...failures]) });
    },

    remove(kind, id) {
      replace(kind, state[kind].filter(record => record.id !== id));
    },

    put(kind, value, { partial = false } = {}) {
      const previous = state[kind].find(record => record.id === value.id);
      const history = kind === 'tasks' || kind === 'transfers';
      const revision = revisionOf(value);
      // An older revision is a stale close/refresh: it must never hide the
      // newer card the Host already published.
      if (history && previous && revision < revisionOf(previous)) return false;
      if (partial && !previous) return false;
      if (previous && (!history || revision === revisionOf(previous)) && !partial && isOlder(previous.updatedAt, value.updatedAt)) return false;
      const merged: TRecord = partial && previous ? { ...previous, ...value } : { ...value };
      const next: TRecord = history
        ? {
          ...merged,
          historyRevision: revision,
          dismissed: !isActivityRunning(merged)
            && (merged.dismissed === true || (previous?.dismissed === true && revision === revisionOf(previous))),
        }
        : merged;
      replace(kind, [...state[kind].filter(record => record.id !== value.id), Object.freeze(next)]);
      return true;
    },

    claim(kind, id, from, to) {
      const record = state[kind].find(item => item.id === id);
      if (!record || record.status !== from) return false;
      replace(kind, state[kind].map(item => (item.id === id ? Object.freeze({ ...item, status: to }) : item)));
      return true;
    },
  };
}