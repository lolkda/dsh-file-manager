/**
 * The independent file-manager main panel.
 *
 * It orchestrates: bootstrap, directory browsing, document editing, tasks and
 * transfers, references and the dialogs. Behavioural rules it must keep:
 *  - switching main panels never discards an unsaved draft (the document store is
 *    root-owned and outlives this component);
 *  - a background refresh, a failed save or a deleted file never overwrites a
 *    draft and never recreates a file;
 *  - a dialog belongs to one attempt, so a late response after cancel/replace can
 *    neither reopen it nor submit anything;
 *  - pagination is deduplicated by directory generation and cursor, and a page
 *    already in flight is never re-requested with the same cursor;
 *  - the optional session hook is called unconditionally, so a `useSessions`
 *    prop that appears after mount cannot reorder hooks.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { EntrySnapshot, EntryStat, EntryVersion } from '../contracts/views.js';
import type { Translate } from './i18n.js';
import { createApi, isMissingFailure, type Api } from './api.js';
import type { ActivityStore } from './activity.js';
import { activityCounts, canDismissActivity, isActivityRunning } from './activity.js';
import type { DocumentStore, OpenDocument } from './documents.js';
import { AttemptSlot, type UiPrimitives } from './ui.js';
import { CodeEditor } from './code-editor.js';
import { PANEL_CSS } from './styles.js';
import {
  EMPTY_LISTING, FileSection, applyPage, type FileActions, type FileCapabilities,
  type ListingPage, type ListingState, type UnaddressableEntry,
} from './browser.js';
import {
  CloseDialog, ConflictDialog, DeleteDialog, DownloadDialog, NameDialog, PasteDialog, ReferenceDialog,
  RootRemovalDialog, UploadDialog, type DeleteAttempt, type PastePlan, type RootRemovalAttempt, type UploadGroup, type UploadPlan, type UploadSource,
} from './dialogs.js';
import { startWatch, type WatchStatus } from './watch.js';
import type { ReferenceScope } from './reference.js';

export interface PanelRuntime {
  readonly controller: AbortController;
  location: { rootId: string; path: string };
  readonly relocations: Set<string>;
  readonly uploads: Map<string, UploadState>;
  readonly openSession?: ((sessionId: string) => void) | null;
  /**
   * The composer scope a reference is inserted into. It lives on the shared
   * runtime because the bridge, not the panel, performs the insertion.
   */
  readonly referenceScope?: ((sessionId: string) => ReferenceScope | null) | null;
}

export interface UploadState {
  readonly files: Map<string, File>;
  controller: AbortController;
  cancelled: boolean;
  working: boolean;
}

export interface SessionCatalog {
  readonly ids: readonly string[];
  readonly byId: Record<string, { id: string; displayTitle: string; parentId?: string | null; origin?: string; running?: boolean } | undefined>;
}

export interface PanelProps {
  readonly t: Translate;
  readonly documents: DocumentStore;
  readonly activity: ActivityStore<Record<string, never> & { id: string; status: string; updatedAt: number }>;
  readonly ui: UiPrimitives;
  readonly runtime: PanelRuntime;
  readonly useSessions?: ((selector: (value: SessionCatalog) => SessionCatalog) => SessionCatalog) | undefined;
}

const EMPTY_CATALOG: SessionCatalog = Object.freeze({ ids: Object.freeze([]), byId: Object.freeze({}) });
const subscribeNothing = (): (() => void) => () => {};

/**
 * Fallback for a Host without a session registry. It performs the same single
 * hook call as a real selector hook, so a `useSessions` prop that appears after
 * mount can never change the number or order of this component's hooks.
 */
function useNoSessions(selector: (value: SessionCatalog) => SessionCatalog): SessionCatalog {
  return selector(useSyncExternalStore(subscribeNothing, () => EMPTY_CATALOG, () => EMPTY_CATALOG));
}

export function Panel(props: PanelProps): ReactNode {
  const { t, documents, activity, ui, runtime } = props;
  const { Button } = ui;
  const useSessions = props.useSessions ?? useNoSessions;
  const sessionCatalog = useSessions(value => value);
  const activities = useSyncExternalStore(activity.subscribe, activity.getSnapshot, activity.getSnapshot);
  const documentState = useSyncExternalStore(documents.subscribe, documents.getSnapshot, documents.getSnapshot);
  const active = documentState.documents.find(item => item.id === documentState.activeId);
  const sessionOptions = sessionCatalog.ids
    .map(id => sessionCatalog.byId[id])
    .filter((session): session is NonNullable<typeof session> => Boolean(session) && !session?.parentId && session?.origin !== 'subagent');

  const [roots, setRoots] = useState<{ id: string; label: string; path: string }[]>([]);
  const [workspaces, setWorkspaces] = useState<{ id: string; path: string; title: string }[]>([]);
  const [capabilities, setCapabilities] = useState<FileCapabilities & { watch?: boolean; taskHistory?: boolean; persistentRoots?: boolean }>({});
  const [limits, setLimits] = useState<{ maxTextBytes?: number; maxFileBytes?: number; maxTaskBytes?: number; maxTaskEntries?: number; transferConcurrency?: number }>({});
  /** Read-only degradation: why writes and/or history are unavailable. */
  const [degraded, setDegraded] = useState<{ scope: string; code: string; message: string; readOnly: boolean } | null>(null);
  const [rootId, setRootId] = useState(runtime.location.rootId);
  const [directory, setDirectory] = useState(runtime.location.path);
  const [listing, setListing] = useState<ListingState>(EMPTY_LISTING);
  const [selected, setSelected] = useState('');
  const [selection, setSelection] = useState<string[]>([]);
  const [nameDialog, setNameDialog] = useState<{ kind: 'file' | 'directory' | 'rename'; rootId: string; directory: string; entry: EntryStat | null } | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [deleteDialog, setDeleteDialog] = useState<DeleteAttempt | null>(null);
  const [rootRemoval, setRootRemoval] = useState<RootRemovalAttempt | null>(null);
  const [operationResult, setOperationResult] = useState<{ status: string; results: { rootId: string; path: string; status: string; removed?: boolean | undefined; error?: { code?: string } | undefined }[] } | null>(null);
  const [pastePlan, setPastePlan] = useState<PastePlan | null>(null);
  const [uploadPlan, setUploadPlan] = useState<UploadPlan | null>(null);
  const [download, setDownload] = useState<{ id: string; downloadName?: string | null } | null>(null);
  const [referencePlan, setReferencePlan] = useState<{ mention: string }[] | null>(null);
  const [referenceSession, setReferenceSession] = useState('');
  const [directoryFallback, setDirectoryFallback] = useState(false);
  const [watchStatus, setWatchStatus] = useState<WatchStatus>('connecting');
  const [pathInput, setPathInput] = useState('/');
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [closeId, setCloseId] = useState<string | null>(null);
  const [conflictId, setConflictId] = useState<string | null>(null);

  const alive = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const fileGeneration = useRef(0);
  const interactionBusy = useRef(0);
  const uploadInput = useRef<HTMLInputElement>(null);
  const directoryInput = useRef<HTMLInputElement>(null);
  const deleteAttempt = useRef(new AttemptSlot<DeleteAttempt>());
  const rootRemovalAttempt = useRef(new AttemptSlot<RootRemovalAttempt>());
  /** Latest listing, so two appends in one frame never reuse the same cursor. */
  const listingRef = useRef<ListingState>(EMPTY_LISTING);
  /**
   * Latest directory, readable from asynchronous callbacks (the watcher). A
   * handler that reads the render closure instead would ask for the directory
   * that was current when the effect started — and a stale request must never
   * be able to cancel the page that is legitimately in flight.
   */
  const locationRef = useRef({ rootId: runtime.location.rootId, path: runtime.location.path });
  const appendPending = useRef(false);
  const saveRequests = useRef(new Map<string, string>());
  const apiRef = useRef<Api | null>(null);
  const interactionRef = useRef(0);
  interactionBusy.current = busy;
  interactionRef.current = busy;

  const api = useMemo<Api>(() => createApi({
    persistentSignal: () => runtime.controller.signal,
    viewSignal: () => lifetime.current?.signal,
  }), [runtime]);
  apiRef.current = api;

  const root = roots.find(item => item.id === rootId);
  const selectedEntries = listing.entries.filter(item => selection.includes(item.path));
  const selectionSaving = documentState.documents.some(document => document.saving && document.rootId === rootId && selectedEntries.some(entry => document.path === entry.path || document.path.startsWith(`${entry.path}/`)));
  const closing = documentState.documents.find(item => item.id === closeId) ?? null;
  const conflicting = documentState.documents.find(item => item.id === conflictId && item.external) ?? null;
  const findDocument = (id: string | null): OpenDocument | undefined => (id === null ? undefined : documents.getSnapshot().documents.find(item => item.id === id));
  const errorText = (failure: unknown): string => {
    const code = typeof failure === 'object' && failure !== null ? (failure as { code?: unknown }).code : undefined;
    const key = `error.${String(code)}`;
    const translated = t(key);
    return translated === key ? t('error.IO_ERROR') : translated;
  };
  const button = (label: string, attributes: Record<string, unknown> = {}): ReactNode =>
    <Button variant="ghost" size="sm" type="button" {...attributes}>{t(label)}</Button>;

  function commitListing(next: ListingState): void {
    listingRef.current = next;
    setListing(next);
  }

  async function run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (!alive.current) return undefined;
    setBusy(value => value + 1);
    setError(null);
    try {
      return await operation();
    } catch (failure) {
      if (alive.current && lifetime.current?.signal.aborted !== true) setError(failure);
      return undefined;
    } finally {
      if (alive.current) setBusy(value => Math.max(0, value - 1));
    }
  }

  async function listAt(id: string, relative: string, append = false, preserveSelection = false): Promise<void> {
    // A request without a root cannot be answered and must not consume a ticket:
    // bumping the generation here would cancel the page already in flight.
    if (!id) return;
    // An append extends the listing that is already committed, so it carries
    // that listing's generation instead of claiming a new one: a page from a
    // directory that has since been replaced — or from a listing that a refresh
    // has already superseded — still fails the ticket check below.
    const ticket = append ? generation.current : ++generation.current;
    const cursor = append ? listingRef.current.nextCursor : null;
    if (append) appendPending.current = true;
    try {
      const value = await api.control({ op: 'entries.list', rootId: id, path: relative, ...(cursor ? { cursor } : {}) });
      if (!alive.current || ticket !== generation.current) return;
      const page: ListingPage = {
        rootId: value.rootId,
        path: value.path,
        entries: value.entries,
        total: value.total,
        nextCursor: value.nextCursor,
        unaddressable: (value.unaddressable ?? []) as readonly UnaddressableEntry[],
      };
      setRootId(id);
      setDirectory(relative);
      runtime.location = { rootId: id, path: relative };
      locationRef.current = { rootId: id, path: relative };
      commitListing(applyPage(listingRef.current, page, { append, cursor, generation: ticket }));
      if (!append) {
        if (preserveSelection) setSelection(previous => previous.filter(filename => value.entries.some(entry => entry.path === filename)));
        else { setSelected(''); setSelection([]); }
      }
    } finally {
      if (append) appendPending.current = false;
    }
  }

  async function refreshDocuments(id: string): Promise<void> {
    for (const document of documents.getSnapshot().documents.filter(item => item.rootId === id && !item.saving)) {
      try {
        const snapshot = await api.control({ op: 'text.read', rootId: document.rootId, path: document.path });
        const current = findDocument(document.id);
        if (alive.current && current && !current.saving && current.rootId === document.rootId && current.path === document.path && current.base.version === document.base.version) {
          documents.open(snapshot, { activate: false });
        }
      } catch (failure) {
        if (isMissingFailure(failure)) documents.markMissing(document.rootId, document.path);
        else throw failure;
      }
    }
  }

  const openDirectory = (id: string, relative: string, append = false): void => { void run(() => listAt(id, relative, append)); };
  const refresh = (): void => { void run(async () => { await listAt(rootId, directory); await refreshDocuments(rootId); }); };
  const loadMore = (): void => {
    if (appendPending.current || !listingRef.current.nextCursor) return;
    openDirectory(rootId, directory, true);
  };

  const openFile = (entry: EntrySnapshot): void => { void run(async () => {
    const ticket = ++fileGeneration.current;
    setSelected(entry.path);
    setSelection([entry.path]);
    const existing = documents.getSnapshot().documents.find(item => item.rootId === rootId && item.path === entry.path);
    if (existing) documents.activate(existing.id);
    const value = await api.control({ op: 'text.read', rootId, path: entry.path });
    if (alive.current && ticket === fileGeneration.current) documents.open(value);
  }); };

  async function saveDocument(id: string | null): Promise<boolean> {
    const document = findDocument(id);
    if (id === null || !allowed.write || !document || document.missing || document.saving) return false;
    if (!document.dirty) return true;
    if (document.external) { if (alive.current) setConflictId(id); return false; }
    const submitted = document.draft;
    const attempt = documents.beginSave(id);
    // One request id per logical save: retrying the same save (same path and
    // base version) reuses it so the Host ledger can deduplicate, while a new
    // save of a changed file gets a new identity.
    const actionKey = `${document.rootId}:${document.path}:${document.base.version}`;
    const requestId = saveRequests.current.get(actionKey) ?? api.requestId();
    saveRequests.current.set(actionKey, requestId);
    let actual;
    try {
      const receipt = await api.text({
        op: 'save', requestId, rootId: document.rootId, path: document.path, expectedVersion: document.base.version, text: submitted,
      }, { persistent: true });
      actual = await api.control({ op: 'text.read', rootId: document.rootId, path: document.path }, { persistent: true });
      if (actual.version !== receipt.version) {
        documents.conflict(id, actual);
        throw Object.assign(new Error('The disk changed after this save.'), { code: 'VERSION_CONFLICT', details: { committed: true } });
      }
      documents.saved(attempt, receipt, submitted, actual);
      saveRequests.current.delete(actionKey);
      return true;
    } catch (failure) {
      if (isMissingFailure(failure)) documents.markMissing(document.rootId, document.path);
      if (typeof failure === 'object' && failure !== null && (failure as { code?: unknown }).code === 'VERSION_CONFLICT') {
        if (!actual) {
          try {
            actual = await api.control({ op: 'text.read', rootId: document.rootId, path: document.path }, { persistent: true });
            documents.conflict(id, actual);
          } catch (readFailure) {
            if (isMissingFailure(readFailure)) documents.markMissing(document.rootId, document.path);
          }
        }
        if (alive.current) setConflictId(id);
      }
      throw failure;
    } finally {
      documents.saveSettled(attempt);
    }
  }

  const save = (id: string): void => { void run(() => saveDocument(id)); };
  const closeDocument = (id: string): void => {
    if (findDocument(id)?.saving) return;
    if (!documents.close(id)) setCloseId(id);
  };
  const saveAndClose = (): void => { void run(async () => {
    const id = closeId;
    if (await saveDocument(id)) {
      if (id !== null && documents.close(id) && alive.current) setCloseId(null);
    }
  }); };

  useEffect(() => {
    alive.current = true;
    lifetime.current = new AbortController();
    const controller = lifetime.current;
    void run(async () => {
      const value = await api.control({ op: 'bootstrap' });
      if (controller.signal.aborted) return;
      setRoots(value.roots);
      setWorkspaces(value.workspaces ?? []);
      setCapabilities((value.capabilities ?? {}) as FileCapabilities & { watch?: boolean; taskHistory?: boolean; persistentRoots?: boolean });
      setLimits((value.limits ?? {}) as typeof limits);
      setDegraded(value.degraded ?? null);
      const previous = value.roots.find(item => item.id === runtime.location.rootId);
      const target = previous ?? value.roots[0];
      if (target) await listAt(target.id, previous ? runtime.location.path : '');
      await syncActivities((value.capabilities ?? {}) as FileCapabilities);
    });
    return () => {
      alive.current = false;
      deleteAttempt.current.peek()?.controller.abort();
      deleteAttempt.current.clear();
      rootRemovalAttempt.current.clear();
      controller.abort();
      generation.current++;
      fileGeneration.current++;
    };
    // Bootstrap runs once for the mounted view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = (event: { preventDefault: () => void }): void => {
    event.preventDefault();
    void run(async () => {
      const added = await api.control({ op: 'roots.add', requestId: api.requestId(), path: pathInput });
      const nextRoots = await api.control({ op: 'roots.list' });
      if (!alive.current) return;
      setRoots(nextRoots);
      await listAt(added.id, '');
    });
  };

  const beginRootRemoval = (item: { id: string; label: string; path: string }): void => {
    if (!alive.current || busy || rootRemovalAttempt.current.peek()?.phase === 'committing') return;
    const attempt: RootRemovalAttempt = { id: api.requestId(), requestId: api.requestId(), root: item, phase: 'ready', error: null };
    setRootRemoval({ ...rootRemovalAttempt.current.begin(attempt) });
    setError(null);
  };
  const cancelRootRemoval = (id: string | undefined): void => {
    const attempt = rootRemovalAttempt.current.peek();
    if (!attempt || attempt.id !== id || attempt.phase === 'committing') return;
    rootRemovalAttempt.current.clear(attempt);
    setRootRemoval(null);
  };
  const confirmRootRemoval = (id: string | undefined): void => {
    const attempt = rootRemovalAttempt.current.peek();
    if (!alive.current || !attempt || attempt.id !== id || attempt.phase === 'committing' || busy) return;
    rootRemovalAttempt.current.update(attempt, { phase: 'committing', error: null });
    setRootRemoval({ ...attempt });
    void run(async () => {
      try {
        await api.control({ op: 'roots.remove', requestId: attempt.requestId, rootId: attempt.root.id }, { persistent: true });
        documents.markMissing(attempt.root.id, '');
        const nextRoots = await api.control({ op: 'roots.list' });
        if (!alive.current) return;
        if (rootRemovalAttempt.current.isCurrent(attempt)) {
          rootRemovalAttempt.current.clear(attempt);
          setRootRemoval(null);
        }
        setRoots(nextRoots);
        if (rootId === attempt.root.id) {
          const fallback = nextRoots[0];
          if (fallback) await listAt(fallback.id, '');
          else {
            generation.current++;
            setRootId('');
            setDirectory('');
            runtime.location = { rootId: '', path: '' };
            commitListing(EMPTY_LISTING);
            setSelected('');
            setSelection([]);
          }
        }
      } catch (failure) {
        if (alive.current && rootRemovalAttempt.current.isCurrent(attempt)) {
          rootRemovalAttempt.current.update(attempt, { phase: 'failed', error: failure });
          setRootRemoval({ ...attempt });
        }
        throw failure;
      }
    });
  };

  type TaskView = { id: string; operation?: string; status: string; updatedAt: string | number; historyRevision?: number; dismissed?: boolean; canDismiss?: boolean; progress?: { total: number; completed: number; failed: number; skipped: number; cancelled: number; bytes: number; totalBytes: number }; items: { id: string; status: string; source: { rootId: string; path: string }; destination?: { rootId: string; path: string }; result?: { destination?: { rootId: string; path: string }; sourceRemoved?: boolean } | null; error?: { code?: string; details?: { committed?: boolean } } | null }[]; cancelRequested?: boolean };

  async function putTask(task: TaskView): Promise<void> {
    if (activity.put('tasks', task as never) === false) return;
    if (task.operation !== 'move') return;
    for (const item of task.items) {
      if (!item.result?.sourceRemoved || item.status !== 'completed') continue;
      const identity = `${task.id}:${item.id}`;
      if (runtime.relocations.has(identity)) continue;
      runtime.relocations.add(identity);
      for (const document of documents.getSnapshot().documents.filter(value => value.rootId === item.source.rootId && (value.path === item.source.path || value.path.startsWith(`${item.source.path}/`)))) {
        const destination = item.result.destination;
        if (!destination) continue;
        const moved = { rootId: destination.rootId, path: destination.path + document.path.slice(item.source.path.length) };
        try {
          documents.relocate(document.id, await api.control({ op: 'text.read', rootId: moved.rootId, path: moved.path }, { persistent: true }));
        } catch (failure) {
          documents.markMissing(document.rootId, document.path);
          if (alive.current) setError(failure);
        }
      }
    }
  }

  async function syncActivities(caps: FileCapabilities = capabilities): Promise<void> {
    if (caps.tasks) for (const task of await api.control({ op: 'tasks.list' })) await putTask(task as TaskView);
    if (caps.transfers) for (const transfer of await api.control({ op: 'transfers.list' })) activity.put('transfers', transfer as never);
  }
  const refreshActivities = (): void => { void run(async () => { await syncActivities(); if (rootId) await listAt(rootId, directory); }); };

  const captureActivity = (kind: 'task' | 'transfer', task: { id: string; historyRevision?: number }) => ({ kind, taskId: task.id, expectedHistoryRevision: task.historyRevision ?? 0 });
  async function dismissActivities(candidates: { kind: 'task' | 'transfer'; taskId: string; expectedHistoryRevision: number }[]): Promise<void> {
    if (!historyAvailable || activity.getSnapshot().historyPending || !candidates.length) return;
    const failures: { kind: 'task' | 'transfer'; taskId: string; error: { code?: string } }[] = [];
    const accepted: typeof candidates = [];
    const failItem = (item: { kind: 'task' | 'transfer'; taskId: string }, error: { code?: string }): void => { failures.push({ kind: item.kind, taskId: item.taskId, error }); };
    // Only this click's ids and revisions are captured: a later completion or
    // retry is never pulled into a subsequent chunk of the same clear.
    for (const item of candidates) {
      const current = activity.getSnapshot()[item.kind === 'task' ? 'tasks' : 'transfers'].find(task => task.id === item.taskId);
      if (!current || current.historyRevision !== item.expectedHistoryRevision) failItem(item, { code: 'TASK_CHANGED' });
      else if (!canDismissActivity(current, capabilities)) failItem(item, { code: 'TASK_BUSY' });
      else accepted.push({ ...item });
    }
    activity.history(true, []);
    try {
      for (let offset = 0; offset < accepted.length; offset += 256) {
        const batch = accepted.slice(offset, offset + 256);
        let response;
        try {
          response = await api.control({ op: 'activities.dismiss', requestId: api.requestId(), items: batch }, { persistent: true });
          if (!Array.isArray(response?.results)) throw Object.assign(new Error('Invalid dismissal response.'), { code: 'INVALID_HISTORY_RESULT' });
        } catch (failure) {
          const code = typeof failure === 'object' && failure !== null ? (failure as { code?: string }).code : undefined;
          for (const item of accepted.slice(offset)) failItem(item, code === undefined ? {} : { code });
          break;
        }
        for (const item of batch) {
          const matches = response.results.filter(result => result.kind === item.kind && result.taskId === item.taskId);
          const result = matches.length === 1 ? matches[0] : null;
          const dismissed = result?.outcome === 'dismissed' ? result.task : null;
          if (dismissed && dismissed.id === item.taskId && dismissed.dismissed === true && !isActivityRunning(dismissed)
            && Number.isSafeInteger(dismissed.historyRevision) && dismissed.historyRevision >= item.expectedHistoryRevision) {
            if (activity.put(item.kind === 'task' ? 'tasks' : 'transfers', dismissed as never, { partial: true }) === false) failItem(item, { code: 'TASK_CHANGED' });
          } else if (result?.outcome === 'rejected') failItem(item, { code: result.error.code });
          else failItem(item, { code: 'INVALID_HISTORY_RESULT' });
        }
      }
    } finally {
      activity.history(false, failures);
    }
  }
  const clearEndedActivities = (): void => {
    const current = activity.getSnapshot();
    void dismissActivities([
      ...current.tasks.filter(task => canDismissActivity(task, capabilities)).map(task => captureActivity('task', task)),
      ...current.transfers.filter(task => canDismissActivity(task, capabilities)).map(task => captureActivity('transfer', task)),
    ]);
  };
  const closeActivityButton = (kind: 'task' | 'transfer', task: { id: string; status: string }): ReactNode => (canDismissActivity(task, capabilities)
    ? <Button
      variant="ghost" size="sm" type="button" title={t('closeTaskHint')} aria-label={`${t('closeTask')}: ${task.id}`}
      disabled={activities.historyPending} onClick={() => { void dismissActivities([captureActivity(kind, task)]); }}
      data-fm-history-action="dismiss" data-fm-history-kind={kind} data-fm-history-id={task.id}
    >×</Button>
    : null);

  // A degraded Host must not present an unusable capability as usable, and an
  // unavailable history must never be rendered as "no tasks".
  //
  // Every write entry point reads `allowed.write` — the editor and its edit/save
  // buttons included — so no degradation path can leave one of them offering a
  // write the others refuse.
  const degradedScope = degraded?.scope ?? null;
  const allowed: FileCapabilities & { watch?: boolean; taskHistory?: boolean; persistentRoots?: boolean } = {
    ...capabilities,
    write: capabilities.write === true && degradedScope === null,
    tasks: capabilities.tasks === true && degradedScope !== 'operations',
    transfers: capabilities.transfers === true && degradedScope !== 'operations',
    references: capabilities.references === true && degradedScope !== 'operations' && sessionOptions.length > 0,
  };
  const historyAvailable = capabilities.taskHistory === true && degradedScope !== 'operations';
  const counts = activityCounts({ tasks: activities.tasks, transfers: activities.transfers }, allowed);
  const visibleTasks = counts.visibleTasks;
  const visibleTransfers = counts.visibleTransfers;
  const activeActivityCount = counts.active;
  const closableActivityCount = counts.closable;

  const activitySync = useRef(syncActivities);
  activitySync.current = syncActivities;
  const hasActiveTasks = activeActivityCount > 0;
  useEffect(() => {
    if (!hasActiveTasks || (!capabilities.tasks && !capabilities.transfers)) return;
    let updating = false;
    const timer = setInterval(() => {
      if (updating || !alive.current) return;
      updating = true;
      void Promise.resolve(activitySync.current()).catch(failure => { if (alive.current) setError(failure); }).finally(() => { updating = false; });
    }, capabilities.watch ? 5000 : 1500);
    return () => clearInterval(timer);
  }, [hasActiveTasks, capabilities.tasks, capabilities.transfers, capabilities.watch]);

  const watchTargets = [...new Map([
    ...(rootId ? [{ rootId, path: directory }] : []),
    ...documentState.documents.filter(document => !document.missing).map(document => ({ rootId: document.rootId, path: document.path.split('/').slice(0, -1).join('/') })),
  ].map(target => [JSON.stringify(target), target])).values()];
  const watchKey = JSON.stringify(watchTargets);
  const watchHandlers = useRef({ invalidate: async (_ids: readonly string[]) => {}, sync: async () => {}, task: async (_id: string) => {}, transfer: async (_id: string) => {} });
  watchHandlers.current = {
    async invalidate(ids: readonly string[]) {
      if (!alive.current) return;
      // Read the current directory from the ref: this handler outlives the
      // render that created it, and a stale directory would blank the listing.
      const current = locationRef.current;
      for (const id of ids) {
        if (current.rootId === id) await listAt(current.rootId, current.path, false, true);
        await refreshDocuments(id);
      }
    },
    sync: async () => { await syncActivities(); },
    async task(id: string) { await putTask(await api.control({ op: 'tasks.get', taskId: id }) as TaskView); },
    async transfer(id: string) { activity.put('transfers', await api.control({ op: 'transfers.get', taskId: id }) as never); },
  };
  useEffect(() => {
    if (!capabilities.watch) return;
    const targets = JSON.parse(watchKey) as { rootId: string; path: string }[];
    if (targets.length > 128) { setWatchStatus('unavailable'); return; }
    return startWatch({
      targets,
      parentSignal: runtime.controller.signal,
      handlers: () => watchHandlers.current,
      isBusy: () => interactionRef.current > 0,
      onStatus: status => { if (alive.current) setWatchStatus(status); },
      onError: failure => { if (alive.current) setError(failure); },
    });
  }, [capabilities.watch, watchKey, runtime]);

  const copySelection = (operation: 'copy' | 'move'): void => { void run(async () => {
    if (!allowed.tasks || !selectedEntries.length || selectionSaving) return;
    const items = [];
    for (const entry of selectedEntries) {
      const stat = await api.control({ op: 'entries.stat', rootId, path: entry.path });
      items.push({ ...stat, rootId, expectedVersion: stat.version });
    }
    activity.clipboard({ operation, items: items as never });
  }); };

  const preparePaste = (): void => { void run(async () => {
    if (!allowed.tasks || !activities.clipboard || !rootId) return;
    const destination = { rootId, path: directory };
    const items = [];
    for (const source of activities.clipboard.items as unknown as { name: string; rootId: string; path: string }[]) {
      let target = null;
      try { target = await api.control({ op: 'entries.stat', rootId, path: [directory, source.name].filter(Boolean).join('/') }); }
      catch (failure) { if ((failure as { code?: string }).code !== 'NOT_FOUND') throw failure; }
      items.push({ source, target, conflict: 'skip', name: '' });
    }
    if (alive.current) setPastePlan({ operation: activities.clipboard.operation, destination, items } as unknown as PastePlan);
  }); };
  const changePaste = (index: number, change: Partial<PastePlan['items'][number]>): void => setPastePlan(plan => (plan ? { ...plan, items: plan.items.map((item, position) => (position === index ? { ...item, ...change } : item)) } : plan));
  const submitPaste = (): void => { void run(async () => {
    if (!allowed.tasks || !pastePlan) return;
    const plan = pastePlan;
    const task = await api.control({
      op: 'tasks.start', requestId: api.requestId(), operation: plan.operation, destination: plan.destination, conflict: 'skip',
      items: plan.items.map(item => ({
        rootId: item.source.rootId, path: item.source.path, expectedVersion: item.source.expectedVersion,
        conflict: item.conflict,
        ...(item.conflict === 'rename' && item.name ? { name: item.name } : {}),
        ...(item.conflict === 'overwrite' && item.target ? { expectedTargetVersion: item.target.version } : {}),
      })),
    }, { persistent: true });
    await putTask(task as TaskView);
    if (plan.operation === 'move') activity.clipboard(null);
    if (alive.current) setPastePlan(null);
  }); };

  const taskAction = (action: 'cancel' | 'retry', task: { id: string }): void => { void run(async () => {
    if (!capabilities.tasks) return;
    const requestId = api.requestId();
    await putTask(await api.control(action === 'cancel' ? { op: 'tasks.cancel', requestId, taskId: task.id } : { op: 'tasks.retry', requestId, taskId: task.id }, { persistent: true }) as TaskView);
  }); };

  async function prepareUpload(sources: readonly UploadSource[]): Promise<void> {
    if (!allowed.transfers || !rootId || !sources.length) return;
    const bounds = { maxFileBytes: 2 * 1024 ** 3, maxTaskBytes: 10 * 1024 ** 3, maxTaskEntries: 10000, ...limits };
    if (sources.length > bounds.maxTaskEntries || sources.some(item => (item.file?.size ?? 0) > bounds.maxFileBytes) || sources.reduce((total, item) => total + (item.file?.size ?? 0), 0) > bounds.maxTaskBytes) {
      throw Object.assign(new Error('Upload selection exceeds configured limits.'), { code: 'TOO_LARGE' });
    }
    const groups = new Map<string, UploadGroup>();
    for (const source of sources) {
      const name = source.path.split('/')[0] ?? '';
      if (!groups.has(name)) groups.set(name, { name, kind: source.path.includes('/') ? 'directory' : source.kind, target: null, conflict: 'error', renamed: '' });
    }
    for (const group of groups.values()) {
      try {
        const target = await api.control({ op: 'entries.stat', rootId, path: [directory, group.name].filter(Boolean).join('/') });
        group.target = { kind: target.kind, version: target.version };
        group.conflict = 'skip';
      } catch (failure) {
        if ((failure as { code?: string }).code !== 'NOT_FOUND') throw failure;
      }
    }
    if (alive.current) setUploadPlan({ rootId, path: directory, sources, groups: [...groups.values()] });
  }

  const pickFiles = (event: { target: { files?: unknown; value: string } }): Promise<void> | void => {
    const files = Array.from((event.target.files ?? []) as ArrayLike<File>);
    event.target.value = '';
    // The review dialog opens only once the target versions are known, so the
    // handler hands its work back to the caller instead of dropping it.
    return run(() => prepareUpload(files.map(file => ({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, kind: 'file', file }))));
  };
  const pickDirectory = (): Promise<void> | void => {
    if (!allowed.transfers || !rootId) return;
    const picker = (window as unknown as { showDirectoryPicker?: (options: { mode: string }) => Promise<DirectoryHandleLike> }).showDirectoryPicker;
    if (!picker) { setDirectoryFallback(true); directoryInput.current?.click(); return; }
    return run(async () => {
      let handle: DirectoryHandleLike;
      try { handle = await picker({ mode: 'read' }); }
      catch (failure) { if ((failure as { name?: string }).name === 'AbortError') return; throw failure; }
      const sources: UploadSource[] = [];
      async function collect(entry: DirectoryHandleLike, relative: string): Promise<void> {
        if (sources.length >= (limits.maxTaskEntries ?? 10000)) throw Object.assign(new Error('Too many upload entries.'), { code: 'TOO_LARGE' });
        if (entry.kind === 'directory') {
          sources.push({ path: relative, kind: 'directory' });
          for await (const [name, child] of entry.entries()) await collect(child, `${relative}/${name}`);
        } else if (entry.kind === 'file') sources.push({ path: relative, kind: 'file', file: await entry.getFile() });
      }
      await collect(handle, handle.name);
      setDirectoryFallback(false);
      await prepareUpload(sources);
    });
  };
  const changeUpload = (index: number, change: Partial<UploadGroup>): void => setUploadPlan(plan => (plan ? { ...plan, groups: plan.groups.map((group, position) => (position === index ? { ...group, ...change } : group)) } : plan));

  async function processUpload(taskId: string): Promise<void> {
    const source = runtime.uploads.get(taskId);
    if (!source || source.working) return;
    const upload = source;
    upload.working = true;
    const abort = (): void => upload.controller.abort();
    runtime.controller.signal.addEventListener('abort', abort, { once: true });
    if (runtime.controller.signal.aborted) abort();
    const getTask = () => activity.getSnapshot().transfers.find(task => task.id === taskId) as unknown as { items: { id: string; path: string; kind: string; status: string }[] } | undefined;
    async function sendItem(item: { id: string; path: string; kind: string }): Promise<void> {
      if (upload.cancelled || getTask()?.items.find(value => value.id === item.id)?.status !== 'pending') return;
      try {
        const file = upload.files.get(item.path);
        if (item.kind === 'file' && !file) throw Object.assign(new Error('The selected browser file is unavailable.'), { code: 'UPLOAD_SOURCE_LOST' });
        const response = await fetch(api.uploadUrl(taskId, item.id), {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' },
          ...(item.kind === 'file' && file ? { body: file } : {}), signal: upload.controller.signal,
        });
        const result = await response.json() as { ok: boolean; value?: unknown; error?: { code?: string; message?: string } };
        if (result.value) activity.put('transfers', result.value as never);
        if (!result.ok) throw Object.assign(new Error(result.error?.message ?? 'Upload failed.'), result.error ?? {});
      } catch (failure) {
        const code = typeof failure === 'object' && failure !== null ? (failure as { code?: unknown }).code : undefined;
        if (!upload.cancelled && alive.current) setError(typeof code === 'string' ? failure : Object.assign(new Error('Upload connection failed.'), { code: 'TRANSPORT' }));
      }
    }
    try {
      const task = getTask();
      if (!task) return;
      for (const item of task.items.filter(value => value.kind === 'directory')) { if (upload.cancelled) break; await sendItem(item); }
      const files = task.items.filter(value => value.kind === 'file');
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(limits.transferConcurrency ?? 2, files.length) }, async () => {
        while (!upload.cancelled && index < files.length) await sendItem(files[index++]!);
      }));
      const latest = await api.control({ op: 'transfers.get', taskId }, { persistent: true });
      activity.put('transfers', latest as never);
      for (const item of latest.items) if (item.committed || item.status === 'skipped') upload.files.delete(item.path);
      if (alive.current && rootId) await listAt(rootId, directory);
    } catch (failure) {
      if (!upload.cancelled && alive.current) setError(failure);
    } finally {
      upload.working = false;
      runtime.controller.signal.removeEventListener('abort', abort);
      const latest = getTask();
      if (latest) activity.put('transfers', latest as never);
    }
  }

  const submitUpload = (): void => { void (async () => {
    const accepted = await run(async () => {
      if (!allowed.transfers || !uploadPlan) return;
      const plan = uploadPlan;
      const files = new Map<string, File>();
      const items: { path: string; kind: 'file' | 'directory'; size: number; conflict: 'error' | 'skip' | 'overwrite'; expectedVersion?: EntryVersion }[] = plan.sources.map(source => {
        const top = source.path.split('/')[0] ?? '';
        const group = plan.groups.find(item => item.name === top);
        if (!group) throw Object.assign(new Error('The upload plan is incomplete.'), { code: 'INVALID_MANIFEST' });
        if (group.conflict === 'rename' && (!group.renamed || group.renamed.includes('/') || group.renamed === '.' || group.renamed === '..')) {
          throw Object.assign(new Error('A renamed upload requires a single name.'), { code: 'INVALID_PATH' });
        }
        const filename = group.conflict === 'rename' ? group.renamed + source.path.slice(top.length) : source.path;
        if (source.file) files.set(filename, source.file);
        return {
          path: filename, kind: source.kind, size: source.file?.size ?? 0,
          conflict: group.conflict === 'rename' ? 'error' : group.conflict,
          ...(group.conflict === 'overwrite' && source.path === top && group.target ? { expectedVersion: group.target.version } : {}),
        };
      });
      const task = await api.control({ op: 'transfers.begin', requestId: api.requestId(), direction: 'upload', rootId: plan.rootId, path: plan.path, items }, { persistent: true });
      runtime.uploads.set(task.id, { files, controller: new AbortController(), cancelled: false, working: false });
      activity.put('transfers', task as never);
      if (alive.current) setUploadPlan(null);
      return task.id;
    });
    if (accepted) await processUpload(accepted);
  })(); };

  const canRetryTransfer = (task: { id: string; direction?: string | undefined; items: { path: string; kind?: string | undefined; status: string; committed?: boolean | undefined }[] }): boolean => {
    if (task.direction === 'download') return true;
    const source = runtime.uploads.get(task.id);
    if (!source || source.working) return false;
    return task.items.filter(item => !item.committed && item.kind === 'file' && ['failed', 'cancelled'].includes(item.status)).every(item => source.files.has(item.path));
  };
  const transferAction = (action: 'cancel' | 'retry', task: { id: string; direction?: string }): void => { void (async () => {
    let retry: string | null = null;
    await run(async () => {
      if (!allowed.transfers) return;
      const source = runtime.uploads.get(task.id);
      if (action === 'cancel' && source) { source.cancelled = true; source.controller.abort(); }
      if (action === 'retry' && !canRetryTransfer(task as never)) throw Object.assign(new Error('Upload source files must be selected again.'), { code: 'UPLOAD_SOURCE_LOST' });
      const requestId = api.requestId();
      const result = await api.control(action === 'cancel' ? { op: 'transfers.cancel', requestId, taskId: task.id } : { op: 'transfers.retry', requestId, taskId: task.id }, { persistent: true });
      activity.put('transfers', result as never);
      if (action === 'retry') {
        if (task.direction === 'download') setDownload({ id: result.id, downloadName: result.downloadName ?? null });
        else if (source) { source.cancelled = false; source.controller = new AbortController(); retry = result.id; }
      }
    });
    if (retry) await processUpload(retry);
  })(); };

  const beginDownload = (): void => { void run(async () => {
    if (!allowed.transfers || !rootId || selectedEntries.length > 1) return;
    const entry = selectedEntries[0];
    const snapshot = entry ? await api.control({ op: 'entries.stat', rootId, path: entry.path }) : null;
    const task = await api.control({
      op: 'transfers.begin', requestId: api.requestId(), direction: 'download', rootId, path: entry?.path ?? directory,
      ...(snapshot ? { expectedVersion: snapshot.version } : {}),
    }, { persistent: true });
    activity.put('transfers', task as never);
    if (alive.current) setDownload({ id: task.id, downloadName: task.downloadName ?? null });
  }); };

  const beginReference = (): void => { void run(async () => {
    if (!allowed.references || !runtime.openSession || !selectedEntries.length) return;
    const references = [];
    for (const entry of selectedEntries) references.push(await api.control({ op: 'entries.reference', rootId, path: entry.path }));
    if (alive.current) { setReferencePlan(references); setReferenceSession(''); }
  }); };
  const submitReference = (): void => { void run(async () => {
    if (!referencePlan || !runtime.openSession || !allowed.references) return;
    const target = sessionOptions.find(session => session?.id === referenceSession);
    if (!target) throw Object.assign(new Error('The selected session is unavailable.'), { code: 'REFERENCE_TARGET_UNAVAILABLE' });
    if (target.running) throw Object.assign(new Error('The selected session is busy.'), { code: 'REFERENCE_BUSY' });
    const pending = { id: api.requestId(), sessionId: target.id, mentions: referencePlan.map(entry => entry.mention), status: 'pending', error: null, createdAt: Date.now(), updatedAt: Date.now() };
    activity.put('references', pending as never);
    try { runtime.openSession(target.id); }
    catch {
      activity.put('references', { ...pending, status: 'blocked', error: 'referenceTargetUnavailable', updatedAt: Date.now() } as never);
      throw Object.assign(new Error('Opening the session failed.'), { code: 'REFERENCE_TARGET_UNAVAILABLE' });
    }
    if (alive.current) setReferencePlan(null);
  }); };
  const retryReference = (request: { id: string; sessionId: string }): void => { void run(async () => {
    if (activity.getSnapshot().references.find(item => item.id === request.id)?.status === 'inserting') return;
    const target = sessionOptions.find(session => session?.id === request.sessionId);
    if (!target || !runtime.openSession) throw Object.assign(new Error('The selected session is unavailable.'), { code: 'REFERENCE_TARGET_UNAVAILABLE' });
    if (target.running) throw Object.assign(new Error('The selected session is busy.'), { code: 'REFERENCE_BUSY' });
    activity.put('references', { ...request, status: 'pending', error: null, updatedAt: Date.now() } as never);
    try { runtime.openSession(request.sessionId); }
    catch {
      activity.put('references', { ...request, status: 'blocked', error: 'referenceTargetUnavailable', updatedAt: Date.now() } as never);
      throw Object.assign(new Error('Opening the session failed.'), { code: 'REFERENCE_TARGET_UNAVAILABLE' });
    }
  }); };

  const beginName = (kind: 'file' | 'directory' | 'rename'): void => { void run(async () => {
    if (!allowed.write || !rootId || busy || selectionSaving) return;
    if (kind === 'rename' && selectedEntries.length !== 1) return;
    const entry = kind === 'rename' ? await api.control({ op: 'entries.stat', rootId, path: selectedEntries[0]!.path }) : null;
    if (alive.current) { setNameInput(entry?.name ?? ''); setNameDialog({ kind, rootId, directory, entry }); }
  }); };
  const submitName = (): void => { void run(async () => {
    if (!allowed.write || !nameDialog) return;
    if (!nameInput || nameInput === '.' || nameInput === '..' || /[/\0]/.test(nameInput)) throw Object.assign(new Error('A single name is required.'), { code: 'INVALID_PATH' });
    const operation = nameDialog;
    if (operation.kind === 'rename' && operation.entry) {
      const source = operation.entry;
      const result = await api.control({ op: 'entries.rename', requestId: api.requestId(), rootId: operation.rootId, path: source.path, name: nameInput, expectedVersion: source.version }, { persistent: true });
      const affected = documents.getSnapshot().documents.filter(document => document.rootId === operation.rootId && (document.path === source.path || document.path.startsWith(`${source.path}/`)));
      for (const document of affected) {
        const nextPath = result.path + document.path.slice(source.path.length);
        try { documents.relocate(document.id, await api.control({ op: 'text.read', rootId: operation.rootId, path: nextPath }, { persistent: true })); }
        catch (failure) { documents.markMissing(document.rootId, document.path); throw failure; }
      }
    } else {
      const filename = [operation.directory, nameInput].filter(Boolean).join('/');
      const requestId = api.requestId();
      await api.control(operation.kind === 'file' ? { op: 'entries.create-file', requestId, rootId: operation.rootId, path: filename } : { op: 'entries.create-directory', requestId, rootId: operation.rootId, path: filename }, { persistent: true });
      if (operation.kind === 'file') documents.open(await api.control({ op: 'text.read', rootId: operation.rootId, path: filename }, { persistent: true }));
    }
    if (alive.current) { setNameDialog(null); await listAt(operation.rootId, operation.directory); }
  }); };

  const publishDelete = (attempt: DeleteAttempt, change: Partial<DeleteAttempt>): void => {
    if (!alive.current || !deleteAttempt.current.isCurrent(attempt)) return;
    deleteAttempt.current.update(attempt, change);
    setDeleteDialog({ ...attempt });
  };
  const cancelDelete = (id: string | undefined): void => {
    const attempt = deleteAttempt.current.peek();
    if (!attempt || attempt.id !== id || attempt.phase === 'committing') return;
    deleteAttempt.current.clear(attempt);
    attempt.controller.abort();
    setDeleteDialog(null);
  };
  const acknowledgeDelete = (id: string, acknowledged: boolean): void => {
    const attempt = deleteAttempt.current.peek();
    if (!attempt || attempt.id !== id || attempt.phase !== 'ready' || !attempt.plan) return;
    publishDelete(attempt, { acknowledged: acknowledged === true });
  };
  const prepareDelete = (): void => { void (async () => {
    const current = deleteAttempt.current.peek();
    if (!alive.current || !allowed.write || !selectedEntries.length || selectionSaving || busy || current?.phase === 'committing') return;
    current?.controller.abort();
    const attempt: DeleteAttempt = {
      id: api.requestId(), phase: 'preparing', requestId: api.requestId(), controller: new AbortController(), acknowledged: false, plan: null, error: null,
      targets: selectedEntries.map(entry => ({ rootId, path: entry.path })),
    };
    deleteAttempt.current.begin(attempt);
    setError(null);
    setOperationResult(null);
    setDeleteDialog({ ...attempt });
    const parentSignal = lifetime.current?.signal;
    const abort = (): void => attempt.controller.abort();
    parentSignal?.addEventListener('abort', abort, { once: true });
    try {
      const plan = await api.control({ op: 'delete.prepare', items: attempt.targets }, { signal: attempt.controller.signal });
      if (!alive.current || !deleteAttempt.current.isCurrent(attempt) || attempt.controller.signal.aborted) return;
      const validTargets = plan.targets.length > 0 && plan.targets.every(target => attempt.targets.some(selected => target.rootId === selected.rootId && target.path === selected.path));
      const validEntries = plan.entries.length > 0 && plan.entries.length === plan.entryCount && plan.entries.every(entry =>
        typeof entry.path === 'string' && typeof entry.version === 'string' && entry.version.length > 0 && ['file', 'directory', 'symlink'].includes(entry.kind)
        && validTargets && plan.targets.some(target => entry.rootId === target.rootId && (entry.path === target.path || entry.path.startsWith(`${target.path}/`))));
      if (typeof plan.id !== 'string' || !plan.id || plan.permanent !== true || !Number.isFinite(plan.expiresAt) || !validTargets || !validEntries) {
        throw Object.assign(new Error('The server did not return a reviewable deletion manifest.'), { code: 'INVALID_DELETE_PLAN' });
      }
      publishDelete(attempt, { phase: 'ready', plan, acknowledged: false });
    } catch (failure) {
      if (!attempt.controller.signal.aborted) publishDelete(attempt, { phase: 'failed', plan: null, acknowledged: false, error: failure });
    } finally {
      parentSignal?.removeEventListener('abort', abort);
    }
  })(); };
  const commitDelete = (id: string | undefined): void => {
    const attempt = deleteAttempt.current.peek();
    if (!alive.current || !allowed.write || !attempt || attempt.id !== id || attempt.phase !== 'ready' || !attempt.plan || !attempt.acknowledged || busy) return;
    const plan = attempt.plan;
    publishDelete(attempt, { phase: 'committing', acknowledged: false });
    void run(async () => {
      try {
        const result = await api.control({ op: 'delete.commit', requestId: attempt.requestId, planId: plan.id, confirmed: true }, { persistent: true });
        for (const item of result.results) if (item.status === 'completed' || item.removed) documents.markMissing(item.rootId, item.path);
        if (alive.current) {
          setOperationResult(result);
          if (deleteAttempt.current.isCurrent(attempt)) { deleteAttempt.current.clear(attempt); setDeleteDialog(null); }
          await listAt(rootId, directory);
        }
      } catch (failure) {
        publishDelete(attempt, { phase: 'failed', plan: null, acknowledged: false, error: failure });
        throw failure;
      }
    });
  };

  const fileActions: FileActions = {
    openDirectory,
    openFile,
    refresh,
    toggleSelection: (path, checked) => setSelection(previous => (checked ? [...new Set([...previous, path])] : previous.filter(item => item !== path))),
    beginName,
    prepareDelete,
    copySelection,
    preparePaste,
    pickUpload: kind => (kind === 'files' ? uploadInput.current?.click() : pickDirectory()),
    beginDownload,
    beginReference,
    loadMore,
    pickFiles,
  };

  const dialogContext = { t, ui, busy: busy > 0, errorText };

  /**
   * The code editor's props, derived during render rather than cached: a rename
   * or a mode switch re-reads the current path, so the language hint can never
   * come from a stale one. Both modes carry the same LF-normalized draft — BOM
   * and line endings stay with `base` and the Host save chain — and the write
   * gate is the same `allowed.write` every other entry point uses.
   */
  const activeEditor = active ? {
    documentId: active.id,
    path: active.path,
    value: active.draft,
    mode: active.editing ? ('edit' as const) : ('preview' as const),
    canWrite: allowed.write === true,
    languageHint: ui.languageForPath?.(active.path),
    ariaLabel: `${t('editor')}: ${active.path}`,
    t,
    onChange: (text: string) => documents.edit(active.id, text),
    onSave: () => save(active.id),
  } : null;

  return (
    <section className="dsh-fm" aria-label={t('title')} data-fm-version={__FM_VERSION__}>
      <style>{PANEL_CSS}</style>
      <header>
        <div><h1>{t('title')}</h1><div className="fm-subtitle">{t('subtitle')}</div></div>
        <span className="fm-badge">{t('stage')}</span>
      </header>
      {error ? <div className="fm-error" role="alert">{errorText(error)}</div> : null}
      {degraded ? (
        <div className="fm-notice" role="status" data-fm-degraded={degraded.scope}>
          {`${t('degraded')}: ${degraded.message}`}
        </div>
      ) : null}
      {capabilities.watch ? <div className="fm-muted" role="status" data-fm-watch={watchStatus} style={{ padding: '6px 14px' }}>{t(`watch.${watchStatus}`)}</div> : null}
      {activities.references.length > 0 ? (
        <div style={{ maxHeight: '18vh', overflow: 'auto' }}>
          {activities.references.map(request => {
            const reference = request as unknown as { id: string; sessionId: string; status: string; mentions: readonly string[]; error?: string | null };
            return (
              <div key={reference.id} className="fm-notice" data-fm-reference-request={reference.sessionId}>
                <span>{`${sessionOptions.find(session => session?.id === reference.sessionId)?.displayTitle ?? reference.sessionId}: ${t(reference.error || 'referenceWaiting')}`}</span>
                {button('referenceRetry', { disabled: busy > 0 || reference.status === 'inserting', onClick: () => retryReference(reference) })}
                {button('cancel', {
                  disabled: reference.status === 'inserting',
                  onClick: () => { if (activity.getSnapshot().references.find(item => item.id === reference.id)?.status !== 'inserting') activity.remove('references', reference.id); },
                })}
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="fm-layout">
        <aside>
          <h2>{t('roots')}</h2>
          {roots.map(item => (
            <div className="fm-rootrow" key={item.id}>
              <Button
                variant="ghost" size="sm" type="button" className={item.id === rootId ? 'fm-active' : ''} title={item.path}
                disabled={busy > 0} onClick={() => openDirectory(item.id, '')} data-fm-root
              >
                <span>{item.label}</span>
              </Button>
              <Button
                variant="ghost" size="sm" type="button" title={t('removeRoot')} aria-label={`${t('removeRoot')}: ${item.label}`}
                disabled={busy > 0} onClick={() => beginRootRemoval(item)}
              >×</Button>
            </div>
          ))}
          <form onSubmit={add} data-fm-add-root>
            <input
              value={pathInput} placeholder={t('pathPlaceholder')} aria-label={t('pathPlaceholder')} list="dsh-fm-workspace-candidates"
              required disabled={busy > 0} onChange={event => setPathInput(event.target.value)} data-fm-add-path
            />
            <datalist id="dsh-fm-workspace-candidates">{workspaces.map(workspace => <option key={workspace.id} value={workspace.path}>{workspace.title}</option>)}</datalist>
            {button('add', { type: 'submit', variant: 'primary', disabled: busy > 0 || !pathInput.trim() })}
          </form>
          {capabilities.persistentRoots === false ? <p className="fm-muted">{t('notPersistent')}</p> : null}
        </aside>
        <FileSection
          t={t} ui={ui} busy={busy} capabilities={allowed} rootId={rootId} root={root} directory={directory}
          listing={listing} selection={selection} selected={selected} clipboard={activities.clipboard} directoryFallback={directoryFallback}
          operationResult={operationResult} selectionSaving={selectionSaving} loadingMore={appendPending.current} errorText={errorText}
          uploadInput={uploadInput} directoryInput={directoryInput} actions={fileActions}
        />
        <section className="fm-preview">
          {documentState.documents.length > 0 ? (
            <nav className="fm-tabs" aria-label={t('openDocuments')}>
              {documentState.documents.map(document => (
                <Button
                  key={document.id} variant="ghost" size="sm" type="button"
                  className={document.id === active?.id ? 'fm-active' : ''} title={`${document.rootId}: ${document.path}`}
                  onClick={() => documents.activate(document.id)} data-fm-tab={document.id}
                >{`${document.dirty ? '● ' : ''}${document.path.split('/').at(-1)}`}</Button>
              ))}
            </nav>
          ) : null}
          <div className="fm-pathbar">
            <span className="fm-preview-title" title={active?.path}>{active?.path || t('preview')}</span>
            {active ? (
              <div className="fm-actions">
                {!active.editing ? button('edit', { disabled: !allowed.write || active.missing, onClick: () => documents.edit(active.id, active.draft), 'data-fm-action': 'edit' }) : null}
                {active.editing ? button(active.saving ? 'saving' : 'save', { variant: 'primary', disabled: !allowed.write || !active.dirty || active.saving || active.missing, onClick: () => save(active.id), 'data-fm-action': 'save' }) : null}
                {button('closeDocument', { disabled: active.saving, onClick: () => closeDocument(active.id), 'data-fm-action': 'close-document' })}
              </div>
            ) : null}
          </div>
          {active?.missing ? <div className="fm-error" data-fm-missing>{t('missing')}</div> : null}
          {active?.external ? <div className="fm-notice" data-fm-external-change>{t('external')}{' '}{button('compare', { onClick: () => setConflictId(active.id) })}</div> : null}
          {activeEditor
            ? <CodeEditor {...activeEditor} />
            : <div className="fm-placeholder">{t('selectFile')}</div>}
          {active ? (
            <footer>
              <span role="status" data-fm-document-state={active.dirty ? 'dirty' : 'clean'}>{t(active.saving ? 'saving' : active.dirty ? 'dirty' : 'saved')}</span>
              <span>{`UTF-8${active.base.bom ? ' · BOM' : ''} · ${String(active.base.newline ?? 'lf').toUpperCase()}${limits.maxTextBytes ? ` · ≤${Math.round(limits.maxTextBytes / 1024)} KiB` : ''}`}</span>
            </footer>
          ) : null}
        </section>
      </div>
      {allowed.tasks || allowed.transfers || !historyAvailable ? (
        <section className="fm-taskarea" aria-label={t('tasks')} style={{ maxHeight: '24vh', overflow: 'auto', borderTop: '1px solid var(--dsw-alias-border-l1)' }}>
          <div className="fm-pathbar">
            <div className="fm-actions"><strong>{t('tasks')}</strong><span data-fm-active-count={activeActivityCount}>{`${activeActivityCount} ${t('activeTasks')}`}</span></div>
            <div className="fm-actions">
              {button('refreshTasks', { onClick: refreshActivities, disabled: busy > 0, 'data-fm-action': 'refresh-tasks' })}
              {historyAvailable ? button('clearEndedTasks', { onClick: clearEndedActivities, disabled: activities.historyPending || !closableActivityCount, title: t('closeTaskHint'), 'data-fm-history-action': 'clear' }) : null}
              {button(activities.tasksCollapsed ? 'expandTasks' : 'collapseTasks', { onClick: () => activity.collapse(!activities.tasksCollapsed), 'aria-expanded': !activities.tasksCollapsed, 'aria-controls': 'dsh-fm-task-cards', 'data-fm-history-action': 'toggle' })}
            </div>
          </div>
          {!historyAvailable ? (
            <div className="fm-notice" role="status" data-fm-history-unavailable>
              {`${t('historyUnavailable')}${degraded ? ` · ${degraded.message}` : ''}`}
            </div>
          ) : null}
          {activities.historyFailures.length > 0 ? (
            <div className="fm-error" role="alert" data-fm-history-errors>
              {t('historyFailures')}
              {activities.historyFailures.map(failure => <div key={`${failure.kind}:${failure.taskId}`}>{`${failure.taskId}: ${errorText(failure.error)}`}</div>)}
            </div>
          ) : null}
          <div id="dsh-fm-task-cards" hidden={activities.tasksCollapsed} data-fm-task-cards>
            {visibleTasks.map(task => {
              const record = task as unknown as TaskView;
              const progress = record.progress ?? { total: 0, completed: 0, failed: 0, skipped: 0, cancelled: 0, bytes: 0, totalBytes: 0 };
              return (
                <article key={record.id} className="fm-notice" data-fm-task-id={record.id} data-fm-task-status={record.status}>
                  <div className="fm-actions">
                    <strong>{`${t(record.operation === 'move' ? 'moveTask' : 'copyTask')} · ${t(`status.${record.status}`)}`}</strong>
                    <span>{`${progress.completed}/${progress.total} ${t('items')} · ${progress.bytes.toLocaleString()} ${t('bytes')}`}</span>
                    {isActivityRunning(record) ? button('cancelTask', { onClick: () => taskAction('cancel', record), disabled: Boolean(record.cancelRequested), 'data-fm-task-action': 'cancel', 'data-fm-task-id': record.id }) : null}
                    {!isActivityRunning(record) && record.items.some(item => item.status === 'failed') ? button('retry', { onClick: () => taskAction('retry', record), disabled: busy > 0, 'data-fm-task-action': 'retry', 'data-fm-task-id': record.id }) : null}
                    {closeActivityButton('task', record)}
                  </div>
                  <progress
                    max={progress.totalBytes || Math.max(1, progress.total)}
                    value={progress.totalBytes ? progress.bytes : progress.completed + progress.failed + progress.skipped + progress.cancelled}
                    aria-label={t('tasks')}
                  />
                  {record.items.map(item => (
                    <div key={item.id}>
                      {`${item.source.path} → ${item.result?.destination?.path ?? item.destination?.path ?? ''}: ${t(`status.${item.status}`)}`}
                      {item.error ? <span>{` · ${errorText(item.error)}`}</span> : null}
                      {item.error?.details?.committed ? <strong>{` · ${t('targetCommitted')}`}</strong> : null}
                    </div>
                  ))}
                </article>
              );
            })}
            {visibleTransfers.map(task => {
              const record = task as unknown as { id: string; status: string; direction?: string; completion?: string; itemsTotal: number; itemsCompleted: number; bytesTransferred: number; bytesTotal: number; items: { id: string; path: string; status: string; error?: { code?: string; details?: { committed?: boolean } } | null }[]; error?: { code?: string } | null };
              return (
                <article key={record.id} className="fm-notice" data-fm-transfer-id={record.id} data-fm-transfer-status={record.status}>
                  <div className="fm-actions">
                    <strong>{`${t(record.direction === 'upload' ? 'uploadTask' : 'downloadTask')} · ${t(record.direction === 'download' && record.completion === 'server-stream-finished' ? 'serverFinished' : `status.${record.status}`)}`}</strong>
                    <span>{`${record.itemsCompleted}/${record.itemsTotal} ${t('items')} · ${record.bytesTransferred.toLocaleString()}/${record.bytesTotal.toLocaleString()} ${t('bytes')}`}</span>
                    {isActivityRunning(record) ? button('cancelTask', { onClick: () => transferAction('cancel', record), 'data-fm-transfer-action': 'cancel', 'data-fm-transfer-id': record.id }) : null}
                    {!['queued', 'running', 'completed'].includes(record.status) ? button('retry', { disabled: busy > 0 || !canRetryTransfer(record), onClick: () => transferAction('retry', record), 'data-fm-transfer-action': 'retry', 'data-fm-transfer-id': record.id }) : null}
                    {closeActivityButton('transfer', record)}
                  </div>
                  <progress max={Math.max(1, record.bytesTotal)} value={record.bytesTransferred} aria-label={t(record.direction === 'upload' ? 'uploadTask' : 'downloadTask')} />
                  {record.items.map(item => (
                    <div key={item.id}>
                      {`${item.path}: ${t(`status.${item.status}`)}`}
                      {item.error ? <span>{` · ${errorText(item.error)}`}</span> : null}
                      {item.error?.details?.committed ? <strong>{` · ${t('targetCommitted')}`}</strong> : null}
                    </div>
                  ))}
                  {record.error ? <div>{errorText(record.error)}</div> : null}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
      <footer>
        <span role="status" aria-live="polite">{busy ? t('loading') : `${listing.entries.length} / ${listing.total} ${t('items')}`}</span>
        <span>{t('note')}</span>
      </footer>
      {nameDialog ? <NameDialog {...dialogContext} error={error} kind={nameDialog.kind} value={nameInput} onCancel={() => setNameDialog(null)} onChange={setNameInput} onSubmit={submitName} /> : null}
      <RootRemovalDialog {...dialogContext} attempt={rootRemoval} onCancel={() => cancelRootRemoval(rootRemoval?.id)} onConfirm={() => confirmRootRemoval(rootRemoval?.id)} />
      <DeleteDialog
        {...dialogContext} write={allowed.write === true} attempt={deleteDialog}
        onCancel={() => cancelDelete(deleteDialog?.id)} onAcknowledge={acknowledged => { if (deleteDialog) acknowledgeDelete(deleteDialog.id, acknowledged); }} onConfirm={() => commitDelete(deleteDialog?.id)}
      />
      <PasteDialog {...dialogContext} error={error} tasks={allowed.tasks === true} plan={pastePlan} onCancel={() => setPastePlan(null)} onChange={changePaste} onConfirm={submitPaste} />
      <UploadDialog {...dialogContext} error={error} transfers={allowed.transfers === true} plan={uploadPlan} onCancel={() => setUploadPlan(null)} onChange={changeUpload} onConfirm={submitUpload} />
      <DownloadDialog {...dialogContext} downloadUrl={download ? api.downloadUrl(download.id) : ''} task={download ? { id: download.id, downloadName: download.downloadName ?? null } as never : null} onClose={() => setDownload(null)} />
      <ReferenceDialog {...dialogContext} error={error} plan={referencePlan} sessionId={referenceSession} sessions={sessionOptions} onCancel={() => setReferencePlan(null)} onChange={setReferenceSession} onConfirm={submitReference} />
      <CloseDialog {...dialogContext} write={allowed.write === true} document={closing ? { path: closing.path, saving: closing.saving, missing: closing.missing } : null} onCancel={() => setCloseId(null)} onDiscard={() => { if (closing && documents.close(closing.id, { discard: true })) setCloseId(null); }} onSaveClose={saveAndClose} />
      <ConflictDialog {...dialogContext} document={conflicting?.external ? { path: conflicting.path, draft: conflicting.draft, external: { text: conflicting.external.text } } : null} onCancel={() => setConflictId(null)} onRebase={() => { if (conflicting) documents.rebase(conflicting.id); setConflictId(null); setError(null); }} />
    </section>
  );
}

interface DirectoryHandleLike {
  readonly kind: string;
  readonly name: string;
  entries(): AsyncIterableIterator<[string, DirectoryHandleLike]>;
  getFile(): Promise<File>;
}
