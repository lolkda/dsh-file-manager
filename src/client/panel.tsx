/**
 * The independent file-manager main panel.
 *
 * It orchestrates: bootstrap, directory browsing, document editing, tasks and
 * transfers, references and the dialogs. Behavioural rules it must keep:
 *  - the Host has exactly one root, fixed when the Host started. There is nothing
 *    to add, choose, remove or re-authorize here, so this panel holds no such
 *    state — and when the Host has no usable root it says so instead of offering
 *    a way to create one;
 *  - the *location inside* that root survives a remount only while the root id
 *    is unchanged. A changed id means a different directory, so the relative
 *    path, its listing and its selection are dropped, open drafts keep their
 *    text but are marked unavailable, and a clipboard naming the old root is
 *    cleared — nothing is re-bound to the new root;
 *  - switching main panels never discards an unsaved draft (the document store is
 *    root-owned and outlives this component);
 *  - a background refresh, a failed save or a deleted file never overwrites a
 *    draft and never recreates a file;
 *  - a dialog belongs to one attempt, so a late response after cancel/replace can
 *    neither reopen it nor submit anything;
 *  - pagination is deduplicated by directory generation and cursor, and a page
 *    already in flight is never re-requested with the same cursor; refreshing
 *    the directory that is already open re-reads at least the pages the user
 *    has loaded instead of silently collapsing the list to page one;
 *  - the optional session hook is called unconditionally, so a `useSessions`
 *    prop that appears after mount cannot reorder hooks.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { EntrySnapshot, EntryStat, EntryVersion, RootDescriptor } from '../contracts/views.js';
import { DIRECTORY_PAGE_DEFAULT, DIRECTORY_PAGE_MAX } from '../contracts/limits.js';
import { failureCode, type Translate } from './i18n.js';
import { createApi, failureCodeOf, isMissingFailure, type Api } from './api.js';
import type { ActivityStore } from './activity.js';
import { activityCounts, canDismissActivity, isActivityRunning } from './activity.js';
import type { DocumentStore, OpenDocument } from './documents.js';
import { AttemptSlot, type UiPrimitives } from './ui.js';
import { CodeEditor } from './code-editor.js';
import { PANEL_CSS } from './styles.js';
import { Overlay } from './overlay.js';
import type { NotificationAction, NotificationEntry, NotificationInput, NotificationLevel, NotificationStore } from './notifications.js';
import { NotificationButton, NotificationDrawer, NotificationLiveRegion } from './notification-center.js';
import {
  EMPTY_LISTING, FileSection, applyPage, type FileActions, type FileCapabilities,
  type ListingPage, type ListingState, type UnaddressableEntry,
} from './browser.js';
import {
  CloseDialog, ConflictDialog, DeleteDialog, DownloadDialog, NameDialog, PasteDialog, ReferenceDialog, UploadDialog,
  type DeleteAttempt, type PastePlan, type UploadGroup, type UploadPlan, type UploadSource,
} from './dialogs.js';
import { startWatch } from './watch.js';
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
  /**
   * The plugin-owned notification store. It outlives this view, so an operation
   * the user confirmed can still report its outcome after the panel unmounts.
   */
  readonly notifications: NotificationStore;
  /**
   * Reports a record this panel just created *before* it is published to the
   * activity store, so a terminal outcome the user is already looking at is
   * announced once, with the action's own wording, instead of being re-derived by
   * the observer. Non-terminal records return `null`.
   */
  readonly reportTerminal: (kind: 'task' | 'transfer', record: { readonly id: string; readonly status: string }, options?: { readonly code?: string; readonly message?: string }) => string | null;
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
  const { t, documents, activity, ui, runtime, notifications, reportTerminal } = props;
  const { Button } = ui;
  const useSessions = props.useSessions ?? useNoSessions;
  const sessionCatalog = useSessions(value => value);
  const activities = useSyncExternalStore(activity.subscribe, activity.getSnapshot, activity.getSnapshot);
  const documentState = useSyncExternalStore(documents.subscribe, documents.getSnapshot, documents.getSnapshot);
  const notificationState = useSyncExternalStore(notifications.subscribe, notifications.getSnapshot, notifications.getSnapshot);
  const active = documentState.documents.find(item => item.id === documentState.activeId);
  const sessionOptions = sessionCatalog.ids
    .map(id => sessionCatalog.byId[id])
    .filter((session): session is NonNullable<typeof session> => Boolean(session) && !session?.parentId && session?.origin !== 'subagent');

  /**
   * The Host's single root, as bootstrap reported it. `null` means the Host has
   * no usable root: the panel then says so and offers no way to create one.
   */
  const [root, setRoot] = useState<RootDescriptor | null>(null);
  const [capabilities, setCapabilities] = useState<FileCapabilities & { watch?: boolean; taskHistory?: boolean }>({});
  const [limits, setLimits] = useState<{ maxTextBytes?: number; maxFileBytes?: number; maxTaskBytes?: number; maxTaskEntries?: number; transferConcurrency?: number }>({});
  /** Read-only degradation: why writes and/or history are unavailable. */
  const [degraded, setDegraded] = useState<{ scope: string; code: string; message: string; readOnly: boolean } | null>(null);
  const [directory, setDirectory] = useState(runtime.location.path);
  const [listing, setListing] = useState<ListingState>(EMPTY_LISTING);
  const [selected, setSelected] = useState('');
  const [selection, setSelection] = useState<string[]>([]);
  const [nameDialog, setNameDialog] = useState<{ kind: 'file' | 'directory' | 'rename'; rootId: string; directory: string; entry: EntryStat | null } | null>(null);
  const [nameInput, setNameInput] = useState('');
  /**
   * The error this dialog is showing. Every step of its submission writes it,
   * including a failure *after* a committed rename. It is not the shared `error`
   * slot, so another action's failure can never reach this dialog, and this
   * dialog's failure can never reach another one.
   */
  const [nameFailure, setNameFailure] = useState<unknown>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteAttempt | null>(null);
  /**
   * The notification drawer is a peer overlay, not one of the `surface` values:
   * opening it must not replace the directory, viewer or tasks view behind it.
   */
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [pastePlan, setPastePlan] = useState<PastePlan | null>(null);
  const [uploadPlan, setUploadPlan] = useState<UploadPlan | null>(null);
  const [download, setDownload] = useState<{ id: string; downloadName?: string | null } | null>(null);
  const [referencePlan, setReferencePlan] = useState<{ mention: string }[] | null>(null);
  const [referenceSession, setReferenceSession] = useState('');
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [closeId, setCloseId] = useState<string | null>(null);
  const [conflictId, setConflictId] = useState<string | null>(null);
  const [surface, setSurface] = useState<'viewer' | 'tasks' | null>(null);
  const [fileAttempt, setFileAttempt] = useState<{ rootId: string; path: string; loading: boolean; error: unknown } | null>(null);

  const alive = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const fileGeneration = useRef(0);
  const interactionBusy = useRef(0);
  const uploadInput = useRef<HTMLInputElement>(null);
  const directoryInput = useRef<HTMLInputElement>(null);
  /** The viewer header, for moving focus off a tab button that is about to be removed. */
  const viewerHeader = useRef<HTMLDivElement>(null);
  const deleteAttempt = useRef(new AttemptSlot<DeleteAttempt>());
  /**
   * Set synchronously by the name dialog's submit, so two clicks in one tick
   * cannot both pass a `busy` value React has not re-rendered yet.
   */
  const nameSubmitting = useRef(false);
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

  useEffect(() => {
    if (surface === 'viewer' && !active && !fileAttempt) setSurface(null);
  }, [surface, active, fileAttempt]);

  /**
   * Reading the drawer is what marks records read: opening it — or leaving it open
   * while new events arrive — consumes the unread count without any request. The
   * guard on `unreadCount` is what keeps this bounded: once nothing is unread the
   * effect stops calling into the store, so no render loop can form.
   */
  useEffect(() => {
    if (!notificationsOpen || notificationState.unreadCount === 0) return;
    notifications.markRead();
  }, [notificationsOpen, notificationState, notifications]);

  const api = useMemo<Api>(() => createApi({
    persistentSignal: () => runtime.controller.signal,
    viewSignal: () => lifetime.current?.signal,
  }), [runtime]);
  apiRef.current = api;

  /**
   * The one root id every request in this view is addressed to. Empty means the
   * Host has no usable root: nothing is requested, and the file list says so
   * rather than inviting the user to add a directory that cannot exist.
   */
  const rootId = root?.id ?? '';
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

  /** One name attempt owns its failure; a later attempt never inherits it. */
  const discardNameAttempt = (): void => { setNameFailure(null); };

  function commitListing(next: ListingState): void {
    listingRef.current = next;
    setListing(next);
  }

  /**
   * One listing page on the wire, normalized once so appends and multi-page
   * refreshes cannot disagree about which fields they carry.
   */
  async function requestListingPage(id: string, relative: string, cursor: string | null, limit?: number): Promise<ListingPage> {
    const value = await api.control({
      op: 'entries.list',
      rootId: id,
      path: relative,
      ...(cursor ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return {
      rootId: value.rootId,
      path: value.path,
      entries: value.entries,
      total: value.total,
      nextCursor: value.nextCursor,
      unaddressable: (value.unaddressable ?? []) as readonly UnaddressableEntry[],
    };
  }

  /**
   * Publishes one event. The store is plugin-owned, so this keeps working after
   * this view unmounts. Only plain data travels: already-translated text, a typed
   * navigation target and the text to copy — never a callback or a live node.
   */
  function notify(input: NotificationInput): void {
    notifications.publish(input);
  }

  /**
   * Reports a failed user action.
   *
   * A cancel is not a failure, and nothing here is deduplicated by code: doing the
   * same thing again must produce its own record. Only state-shaped sources pass a
   * `dedupeKey`, which is what keeps a repeating watcher or poll from filling the
   * history.
   */
  function notifyFailure(failure: unknown, options: { code?: string; dedupeKey?: string; title?: string; level?: NotificationLevel } = {}): void {
    // `failureCode` maps an aborted request to CANCELLED: a user cancel is not a
    // failure, and the numeric DOMException code would otherwise look like one.
    const reported = failureCode(failure);
    if (reported === 'CANCELLED') return;
    const code = options.code ?? reported ?? undefined;
    notify({
      level: options.level ?? 'error',
      title: options.title ?? errorText(failure),
      ...(code ? { code } : {}),
      ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
    });
  }

  /**
   * A transfer failure belongs in the history once per task and code: the upload
   * worker reports item by item, and one task must not fill the list with its own
   * rows. It is reported whether or not this view is still alive, because the
   * transfer the user started keeps running either way.
   */
  function notifyTransferFailure(taskId: string, failure: unknown): void {
    notifyFailure(failure, { dedupeKey: `transfer:${taskId}:${failureCode(failure) ?? 'TRANSPORT'}` });
  }

  /** One record per finished operation, carrying the per-target outcomes. */
  function notifyOperationResult(result: { status: string; results: readonly { path: string; status: string; error?: { code?: string } | undefined }[] }): void {
    notify({
      level: result.status === 'completed' ? 'success' : result.status === 'partial' ? 'warning' : 'error',
      title: `${t('operationResult')}: ${t(`status.${result.status}`)}`,
      ...(result.results.length
        ? { details: result.results.map(item => `${item.path}: ${t(`status.${item.status}`)}${item.error ? ` · ${errorText(item.error)}` : ''}`) }
        : {}),
      code: 'OPERATION_RESULT',
    });
  }

  async function run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (!alive.current) return undefined;
    setBusy(value => value + 1);
    setError(null);
    try {
      return await operation();
    } catch (failure) {
      // The event record is independent of this view's lifetime: a request the user
      // confirmed keeps its outcome even when the panel is gone, so a failure that
      // lands after unmount is still reported. A plugin teardown (the runtime
      // signal is aborted) and a user cancel are not failures at all.
      const ownedByDialog = alive.current && nestedDialog;
      if (!ownedByDialog && failureCode(failure) !== 'CANCELLED' && !runtime.controller.signal.aborted) notifyFailure(failure);
      // The inline error stays bound to the live view: a dialog that is gone cannot
      // show it, and a late response must never write into a newer view's state.
      if (alive.current && lifetime.current?.signal.aborted !== true) setError(failure);
      return undefined;
    } finally {
      if (alive.current) setBusy(value => Math.max(0, value - 1));
    }
  }

  /**
   * Lists one directory of the single root.
   *
   * `recoverSavedDirectory` belongs to the startup listing only: a saved
   * directory that no longer exists is then opened as the root. Every other
   * failure — and every other listing — is reported as it is.
   */
  async function listAt(id: string, relative: string, append = false, preserveSelection = false, recoverSavedDirectory = false): Promise<void> {
    // A request without a root cannot be answered and must not consume a ticket:
    // bumping the generation here would cancel the page already in flight.
    if (!id) return;
    // An append extends the listing that is already committed, so it carries
    // that listing's generation instead of claiming a new one: a page from a
    // directory that has since been replaced — or from a listing that a refresh
    // has already superseded — still fails the ticket check below.
    const ticket = append ? generation.current : ++generation.current;
    const previous = listingRef.current;
    const cursor = append ? previous.nextCursor : null;
    // Re-listing the directory already on screen is a refresh, not navigation:
    // it must re-read at least the same number of rows the user has loaded.
    // Otherwise any watcher invalidation turns 400 rows back into page one.
    const preserveLoaded = !append && previous.entries.length > 0
      && previous.rootId === id && previous.path === relative;
    const targetEntries = preserveLoaded ? previous.entries.length : 0;
    if (append) appendPending.current = true;
    /** The lifetime this request belongs to; a late answer must not navigate. */
    const asked = lifetime.current?.signal;
    try {
      let page = await requestListingPage(
        id, relative, cursor,
        preserveLoaded
          ? Math.min(Math.max(targetEntries, DIRECTORY_PAGE_DEFAULT), DIRECTORY_PAGE_MAX)
          : undefined,
      );
      if (!alive.current || ticket !== generation.current) return;
      if (preserveLoaded && page.entries.length < targetEntries) {
        // A page can contain unaddressable names, and an older page size may be
        // smaller than the requested limit. Continue with the remaining row
        // count so a refresh never overshoots into a page the user did not load.
        const entries = [...page.entries];
        const unaddressable = [...page.unaddressable];
        const seenEntries = new Set(entries.map(entry => entry.path));
        const seenUnaddressable = new Set(unaddressable.map(entry => `${entry.kind}\u0000${entry.name}`));
        const seenCursors = new Set<string>();
        let nextCursor = page.nextCursor;
        let total = page.total;
        while (entries.length < targetEntries && nextCursor && !seenCursors.has(nextCursor)) {
          seenCursors.add(nextCursor);
          const limit = Math.max(1, Math.min(DIRECTORY_PAGE_MAX, targetEntries - entries.length));
          const next = await requestListingPage(id, relative, nextCursor, limit);
          if (!alive.current || ticket !== generation.current) return;
          if (next.rootId !== page.rootId || next.path !== page.path) {
            throw Object.assign(new Error('The listing response belongs to another directory.'), { code: 'INVALID_RESPONSE' });
          }
          total = next.total;
          for (const entry of next.entries) {
            if (seenEntries.has(entry.path)) continue;
            seenEntries.add(entry.path);
            entries.push(entry);
          }
          for (const entry of next.unaddressable) {
            const key = `${entry.kind}\u0000${entry.name}`;
            if (seenUnaddressable.has(key)) continue;
            seenUnaddressable.add(key);
            unaddressable.push(entry);
          }
          nextCursor = next.nextCursor;
        }
        page = { rootId: page.rootId, path: page.path, entries, total, nextCursor, unaddressable };
      }
      setDirectory(relative);
      runtime.location = { rootId: id, path: relative };
      locationRef.current = { rootId: id, path: relative };
      commitListing(applyPage(listingRef.current, page, { append, cursor, generation: ticket }));
      if (!append) {
        if (preserveSelection) setSelection(previous => previous.filter(filename => page.entries.some(entry => entry.path === filename)));
        else { setSelected(''); setSelection([]); }
      }
    } catch (failure) {
      // The fallback is bounded by this request still being the live one: a late
      // NOT_FOUND from a view that unmounted, from a replaced lifetime, or from a
      // listing the user has already navigated away from must not move the panel.
      if (recoverSavedDirectory && relative !== '' && failureCodeOf(failure) === 'NOT_FOUND'
        && alive.current && ticket === generation.current && asked === lifetime.current?.signal) {
        await listAt(id, '');
        return;
      }
      throw failure;
    } finally {
      if (append) appendPending.current = false;
    }
  }

  async function refreshDocuments(id: string, prefix = '', persistent = false): Promise<void> {
    // A partial directory deletion only reconciles open documents, never walks
    // the deleted subtree again. Confirmed effects also survive a panel remount.
    for (const document of documents.getSnapshot().documents.filter(item => item.rootId === id && !item.saving
      && (!prefix || item.path === prefix || item.path.startsWith(`${prefix}/`)))) {
      const isCurrent = (): boolean => {
        const current = findDocument(document.id);
        return Boolean(current && !current.saving && current.rootId === document.rootId && current.path === document.path
          && current.attempt === document.attempt && current.base.version === document.base.version);
      };
      try {
        const snapshot = await api.control({ op: 'text.read', rootId: document.rootId, path: document.path }, { persistent });
        if ((alive.current || persistent) && isCurrent()) documents.open(snapshot, { activate: false });
      } catch (failure) {
        if (isMissingFailure(failure)) { if (isCurrent()) documents.markMissing(document.rootId, document.path); }
        else throw failure;
      }
    }
  }

  /**
   * Adopts the Host's single root and opens the best location inside it.
   *
   * A relative path only means anything against the same root id. When the id
   * changed, the old location, listing and selection describe entries that are
   * gone, so they are dropped before the first request; drafts keep their text
   * and are only marked unavailable, and the clipboard is dropped only when it
   * names another root. Nothing is re-bound to the new root.
   */
  async function applyRoot(descriptor: RootDescriptor | null): Promise<void> {
    if (!descriptor) return;
    const stale = new Set<string>();
    for (const document of documents.getSnapshot().documents) {
      if (document.rootId && document.rootId !== descriptor.id) stale.add(document.rootId);
    }
    for (const id of stale) documents.markMissing(id, '');
    // The clipboard is judged against the root itself, not against the open
    // drafts: an item naming any other root id can no longer be pasted here.
    const clipboard = activity.getSnapshot().clipboard;
    if (clipboard?.items.some(item => item.rootId !== descriptor.id)) activity.clipboard(null);
    const before = locationRef.current;
    const changed = before.rootId !== descriptor.id;
    if (changed) {
      // Retire the old location before the first request, so a listing that fails
      // cannot leave the new root rendered with the old relative path.
      generation.current++;
      setDirectory('');
      commitListing(EMPTY_LISTING);
      setSelected('');
      setSelection([]);
      locationRef.current = { rootId: descriptor.id, path: '' };
      runtime.location = { rootId: descriptor.id, path: '' };
    }
    const path = changed ? '' : before.path;
    // The startup listing is the only one allowed to recover a saved directory
    // that has since been removed; it is the only request the user did not ask for.
    await listAt(descriptor.id, path, false, false, true);
  }

  const openDirectory = (id: string, relative: string, append = false): void => { void run(() => listAt(id, relative, append)); };
  const refresh = (): void => { void run(async () => { await listAt(rootId, directory); await refreshDocuments(rootId); }); };
  const loadMore = (): void => {
    if (appendPending.current || !listingRef.current.nextCursor) return;
    openDirectory(rootId, directory, true);
  };

  const openFile = (entry: EntrySnapshot): void => {
    const ticket = ++fileGeneration.current;
    const target = { rootId, path: entry.path };
    setSelected(entry.path);
    setSurface('viewer');
    setFileAttempt({ ...target, loading: true, error: null });
    void run(async () => {
      const existing = documents.getSnapshot().documents.find(item => item.rootId === target.rootId && item.path === target.path);
      if (existing) documents.activate(existing.id);
      try {
        const value = await api.control({ op: 'text.read', ...target });
        if (alive.current && ticket === fileGeneration.current) {
          documents.open(value);
          setFileAttempt(null);
        }
      } catch (failure) {
        if (alive.current && ticket === fileGeneration.current) setFileAttempt({ ...target, loading: false, error: failure });
      }
    });
  };
  const resumeViewer = (): void => {
    fileGeneration.current++;
    setFileAttempt(null);
    setSurface('viewer');
  };

  /**
   * The window X hides the editing surface only: every document, draft and the
   * mounted editor instance survive, and a save already running keeps running.
   * The read-generation bump invalidates the current open attempt, so a late
   * `text.read` response can neither add a document nor bring this window back;
   * clearing the attempt keeps a stale loading/failed state from being restored
   * on resume. Back-to-files and Escape keep their hide-only semantics.
   */
  const closeViewer = (): void => {
    fileGeneration.current++;
    setFileAttempt(null);
    setSurface(null);
  };

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
      notify({ level: 'success', title: `${t('saved')}: ${document.path}`, code: 'DOCUMENT_SAVED' });
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
    // Closing removes the tab row that may own the focus right now. When focus
    // sits on the tab X being closed, move it to the always-present window
    // close button first: the browser would otherwise drop it to <body> and
    // the viewer overlay would lose its keyboard loop. Readers without this
    // header leave focus alone.
    const header = viewerHeader.current;
    const focused = header?.ownerDocument.activeElement;
    if (focused?.closest('[data-fm-close-document]')?.getAttribute('data-fm-close-document') === id) {
      header?.querySelector<HTMLButtonElement>('[data-fm-action="close-viewer"]')?.focus({ preventScroll: true });
    }
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
      setRoot(value.root ?? null);
      setCapabilities((value.capabilities ?? {}) as FileCapabilities & { watch?: boolean; taskHistory?: boolean });
      setLimits((value.limits ?? {}) as typeof limits);
      setDegraded(value.degraded ?? null);
      // The degradation itself is business state and keeps its compact indicator;
      // the *reason* is an event, reported once per scope and code rather than on
      // every remount. There is no destination to offer with it: the only place
      // that could fix a degraded Host is the Host.
      const degradation = value.degraded;
      if (degradation) {
        notify({
          level: 'error',
          title: degradation.readOnly ? t('readOnly') : t('degraded'),
          message: degradation.message,
          code: degradation.code,
          dedupeKey: `degraded:${degradation.scope}:${degradation.code}`,
        });
      }
      // Opening the root is not a precondition for anything else on this page: a
      // listing that fails is reported on its own, and the task history still
      // synchronizes — otherwise a broken directory would also hide every task
      // the user is waiting on.
      try {
        await applyRoot(value.root ?? null);
      } catch (failure) {
        notifyFailure(failure);
        if (alive.current) setError(failure);
      }
      if (controller.signal.aborted) return;
      // A Host that refuses every file operation would only answer 503 to the two
      // history listings, so they are not sent; an `operations` degradation still
      // follows the Host's own capability bits.
      if (value.degraded?.scope !== 'filesystem') await syncActivities((value.capabilities ?? {}) as FileCapabilities);
    });
    return () => {
      alive.current = false;
      deleteAttempt.current.peek()?.controller.abort();
      deleteAttempt.current.clear();
      controller.abort();
      generation.current++;
      fileGeneration.current++;
    };
    // Bootstrap runs once for the mounted view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          // Driven by task views rather than by a click: one record per code.
          notifyFailure(failure, { dedupeKey: `task-relocation:${failureCode(failure) ?? 'TRANSPORT'}` });
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
  // The two scopes mean different things: `operations` is a journal that cannot
  // be written, so browsing and reading still work and only the history is
  // missing; `filesystem` is the root itself being unusable, so every file
  // operation — browsing, editing, tasks, transfers and references — is refused
  // by the Host and the history cannot be listed either.
  //
  // Every write entry point reads `allowed.write` — the editor and its edit/save
  // buttons included — so no degradation path can leave one of them offering a
  // write the others refuse.
  const degradedScope = degraded?.scope ?? null;
  const rootUsable = degradedScope !== 'filesystem';
  const allowed: FileCapabilities & { watch?: boolean; taskHistory?: boolean } = {
    ...capabilities,
    write: capabilities.write === true && degradedScope === null,
    tasks: capabilities.tasks === true && degradedScope !== 'operations' && rootUsable,
    transfers: capabilities.transfers === true && degradedScope !== 'operations' && rootUsable,
    references: capabilities.references === true && degradedScope !== 'operations' && rootUsable && sessionOptions.length > 0,
  };
  const historyAvailable = capabilities.taskHistory === true && degradedScope !== 'operations' && rootUsable;
  const counts = activityCounts({ tasks: activities.tasks, transfers: activities.transfers }, allowed);
  const visibleTasks = counts.visibleTasks;
  const visibleTransfers = counts.visibleTransfers;
  const activeActivityCount = counts.active;
  const closableActivityCount = counts.closable;
  const failedActivityCount = [...visibleTasks, ...visibleTransfers].filter(record =>
    ['failed', 'partial', 'interrupted'].includes(record.status) || (record as unknown as { items?: { status: string }[] }).items?.some(item => item.status === 'failed')).length;

  const activitySync = useRef(syncActivities);
  activitySync.current = syncActivities;
  const hasActiveTasks = activeActivityCount > 0;
  useEffect(() => {
    if (!hasActiveTasks || (!capabilities.tasks && !capabilities.transfers)) return;
    let updating = false;
    const timer = setInterval(() => {
      if (updating || !alive.current) return;
      updating = true;
      void Promise.resolve(activitySync.current()).catch(failure => {
        // A poll that repeats the same failure is one event, not one per tick.
        if (alive.current) { notifyFailure(failure, { dedupeKey: `activity-sync:${failureCodeOf(failure) ?? 'TRANSPORT'}` }); setError(failure); }
      }).finally(() => { updating = false; });
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
    if (targets.length > 128) return;
    return startWatch({
      targets,
      parentSignal: runtime.controller.signal,
      handlers: () => watchHandlers.current,
      isBusy: () => interactionRef.current > 0,
      // Observation stays active without a status row or status-only renders.
      onStatus: () => {},
      onError: failure => {
        // Observation failures repeat while a stream is down: one record per code.
        if (alive.current) { notifyFailure(failure, { dedupeKey: `watch:${failureCodeOf(failure) ?? 'TRANSPORT'}` }); setError(failure); }
      },
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
    notify({
      level: 'info',
      title: t('clipboardItems', { count: items.length }),
      message: t(operation === 'move' ? 'cut' : 'copy'),
      code: 'CLIPBOARD_ITEMS',
    });
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
    // Reported before it enters the activity store: a task that is already
    // terminal is announced by this action, with the action's own wording, and the
    // observer yields on the same identity instead of reporting it again.
    reportTerminal('task', task);
    await putTask(task as TaskView);
    if (plan.operation === 'move') activity.clipboard(null);
    if (alive.current) setPastePlan(null);
  }); };

  const taskAction = (action: 'cancel' | 'retry', task: { id: string }): void => { void run(async () => {
    if (!capabilities.tasks) return;
    const requestId = api.requestId();
    await putTask(await (async (): Promise<TaskView> => {
      const changed = await api.control(action === 'cancel' ? { op: 'tasks.cancel', requestId, taskId: task.id } : { op: 'tasks.retry', requestId, taskId: task.id }, { persistent: true }) as TaskView;
      // A retry starts a new attempt: it is reported before the store sees it, so
      // an immediately failing attempt is announced once, with this action's words.
      reportTerminal('task', changed);
      return changed;
    })());
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
    // Without the handle picker the file-list fallback cannot see empty
    // directories: that is an event the user can read later, not a banner that
    // holds list height until it is dismissed.
    if (!picker) {
      notify({ level: 'warning', title: t('directoryFallback'), code: 'DIRECTORY_FALLBACK' });
      directoryInput.current?.click();
      return;
    }
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
      await prepareUpload(sources);
    });
  };
  const changeUpload = (index: number, change: Partial<UploadGroup>): void => setUploadPlan(plan => (plan ? { ...plan, groups: plan.groups.map((group, position) => (position === index ? { ...group, ...change } : group)) } : plan));

  async function processUpload(taskId: string): Promise<void> {
    const source = runtime.uploads.get(taskId);
    if (!source || source.working) return;
    const upload = source;
    upload.working = true;
    // This attempt owns both body requests and the final receipt refresh. A
    // cancelled refresh must not keep local workers busy or publish a late view.
    const controller = upload.controller;
    const stopped = (): boolean => upload.cancelled || controller.signal.aborted;
    const abort = (): void => controller.abort();
    runtime.controller.signal.addEventListener('abort', abort, { once: true });
    if (runtime.controller.signal.aborted) abort();
    const getTask = () => activity.getSnapshot().transfers.find(task => task.id === taskId) as unknown as { items: { id: string; path: string; kind: string; status: string }[] } | undefined;
    async function sendItem(item: { id: string; path: string; kind: string }): Promise<void> {
      if (stopped() || getTask()?.items.find(value => value.id === item.id)?.status !== 'pending') return;
      try {
        const file = upload.files.get(item.path);
        if (item.kind === 'file' && !file) throw Object.assign(new Error('The selected browser file is unavailable.'), { code: 'UPLOAD_SOURCE_LOST' });
        const response = await fetch(api.uploadUrl(taskId, item.id), {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' },
          ...(item.kind === 'file' && file ? { body: file } : {}), signal: controller.signal,
        });
        const result = await response.json() as { ok: boolean; value?: unknown; error?: { code?: string; message?: string } };
        if (stopped()) return;
        if (result.value) activity.put('transfers', result.value as never);
        if (!result.ok) throw Object.assign(new Error(result.error?.message ?? 'Upload failed.'), result.error ?? {});
      } catch (failure) {
        // A missing code is a connection-level failure; an aborted request keeps its
        // own identity so a user cancel is not turned into an error event.
        const reported = failureCode(failure) === null
          ? Object.assign(new Error('Upload connection failed.'), { code: 'TRANSPORT' })
          : failure;
        notifyTransferFailure(taskId, reported);
        if (!stopped() && alive.current) setError(reported);
      }
    }
    try {
      const task = getTask();
      if (!task) return;
      for (const item of task.items.filter(value => value.kind === 'directory')) { if (stopped()) break; await sendItem(item); }
      const files = task.items.filter(value => value.kind === 'file');
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(limits.transferConcurrency ?? 2, files.length) }, async () => {
        while (!stopped() && index < files.length) await sendItem(files[index++]!);
      }));
      if (stopped()) return;
      const latest = await api.control({ op: 'transfers.get', taskId }, { signal: controller.signal });
      if (stopped()) return;
      activity.put('transfers', latest as never);
      for (const item of latest.items) if (item.committed || item.status === 'skipped') upload.files.delete(item.path);
    } catch (failure) {
      notifyTransferFailure(taskId, failure);
      if (!stopped() && alive.current) setError(failure);
    } finally {
      upload.working = false;
      runtime.controller.signal.removeEventListener('abort', abort);
      const latest = getTask();
      if (latest) activity.put('transfers', latest as never);
    }
    // Directory browsing is not upload work: a slow listing must not prevent
    // cancellation/retry of an otherwise settled transfer.
    if (!stopped() && alive.current && rootId) {
      try { await listAt(rootId, directory); }
      catch (failure) {
        // The follow-up refresh is state-shaped: one record per code, not per attempt.
        notifyFailure(failure, { dedupeKey: `upload-refresh:${failureCode(failure) ?? 'TRANSPORT'}` });
        if (!stopped() && alive.current) setError(failure);
      }
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
      // A begin that is already terminal (an immediate refusal, for instance) is
      // reported here, before the store hands the same state to the observer.
      reportTerminal('transfer', task);
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
      // A retry starts a new attempt; an immediate terminal state belongs to this
      // action, and the observer yields on the same identity.
      reportTerminal('transfer', result);
      activity.put('transfers', result as never);
      if (action === 'retry') {
        if (task.direction === 'download') setDownload({ id: result.id, downloadName: result.downloadName ?? null });
        else if (source) { source.cancelled = false; source.controller = new AbortController(); retry = result.id; }
      }
    });
    if (retry) await processUpload(retry);
  })(); };

  async function prepareDownload(target: { rootId: string; path: string }, bindEntry: boolean): Promise<void> {
    const snapshot = bindEntry ? await api.control({ op: 'entries.stat', ...target }) : null;
    const task = await api.control({
      op: 'transfers.begin', requestId: api.requestId(), direction: 'download', ...target,
      ...(snapshot ? { expectedVersion: snapshot.version } : {}),
    }, { persistent: true });
    // A download that already finished server-side is this action's outcome.
    reportTerminal('transfer', task);
    activity.put('transfers', task as never);
    if (alive.current) setDownload({ id: task.id, downloadName: task.downloadName ?? null });
  }
  const beginDownload = (): void => { void run(async () => {
    if (!allowed.transfers || !rootId || selectedEntries.length > 1) return;
    const entry = selectedEntries[0];
    await prepareDownload({ rootId, path: entry?.path ?? directory }, Boolean(entry));
  }); };
  const downloadViewedFile = (): void => { void run(async () => {
    const target = fileAttempt ?? active;
    if (!allowed.transfers || !target || busy > 0) return;
    await prepareDownload({ rootId: target.rootId, path: target.path }, true);
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
    if (alive.current) { discardNameAttempt(); setNameInput(entry?.name ?? ''); setNameDialog({ kind, rootId, directory, entry }); }
  }); };
  /**
   * One submission of the name dialog.
   *
   * A rename is a single form submission: its first and only request authorizes
   * the Host's compatible fallback. The Host still tries atomic no-replace first,
   * so the authorization only changes the outcome when the filesystem itself
   * proves that guarantee is unavailable.
   */
  const submitName = (): void => {
    if (busy || nameSubmitting.current) return;
    nameSubmitting.current = true;
    void run(async () => {
      if (!allowed.write || !nameDialog) return;
      const operation = nameDialog;
      /**
       * Reports one failure of this submission.
       *
       * While this view is alive the dialog is where its outcome belongs: the
       * shared slot stays untouched. A failure that lands after the view is gone
       * has no dialog left to speak through, so it is recorded in the history
       * exactly like any other confirmed persistent mutation.
       */
      const reject = (failure: unknown): void => {
        if (!alive.current) { if (!runtime.controller.signal.aborted) notifyFailure(failure); return; }
        setNameFailure(failure);
      };
      if (!nameInput || nameInput === '.' || nameInput === '..' || /[/\0]/.test(nameInput)) {
        reject(Object.assign(new Error('A single name is required.'), { code: 'INVALID_PATH' }));
        return;
      }
      if (operation.kind === 'rename' && operation.entry) {
        const source = operation.entry;
        let result;
        try {
          // A fresh request id per logical submission. The version is the one this
          // dialog captured, never re-read here, so the Host's own re-check
          // decides — the UI cannot refresh a bypass.
          result = await api.control({
            op: 'entries.rename', requestId: api.requestId(), rootId: operation.rootId, path: source.path, name: nameInput,
            expectedVersion: source.version, allowNonExclusiveRename: true as const,
          }, { persistent: true });
        } catch (failure) { reject(failure); return; }
        // The rename is committed from here on. A document that cannot follow it is
        // a failure of this submission and is reported in the same place.
        const affected = documents.getSnapshot().documents.filter(document => document.rootId === operation.rootId && (document.path === source.path || document.path.startsWith(`${source.path}/`)));
        for (const document of affected) {
          const nextPath = result.path + document.path.slice(source.path.length);
          try { documents.relocate(document.id, await api.control({ op: 'text.read', rootId: operation.rootId, path: nextPath }, { persistent: true })); }
          catch (failure) { documents.markMissing(document.rootId, document.path); reject(failure); return; }
        }
        notify({ level: 'success', title: `${t('rename')}: ${source.name} → ${nameInput}`, code: 'ENTRY_RENAMED' });
      } else {
        const filename = [operation.directory, nameInput].filter(Boolean).join('/');
        const requestId = api.requestId();
        try {
          await api.control(operation.kind === 'file' ? { op: 'entries.create-file', requestId, rootId: operation.rootId, path: filename } : { op: 'entries.create-directory', requestId, rootId: operation.rootId, path: filename }, { persistent: true });
        } catch (failure) { reject(failure); return; }
        if (operation.kind === 'file') {
          // The file is created from here on: a read that cannot follow it is this
          // submission's outcome, so it is reported in the same dialog rather than
          // in a shared slot this dialog no longer reads.
          let opened;
          try { opened = await api.control({ op: 'text.read', rootId: operation.rootId, path: filename }, { persistent: true }); }
          catch (failure) { reject(failure); return; }
          documents.open(opened);
          if (alive.current) { setFileAttempt(null); setSurface('viewer'); }
        }
        notify({ level: 'success', title: `${t(operation.kind === 'file' ? 'newFile' : 'newDirectory')}: ${filename}`, code: 'ENTRY_CREATED' });
      }
      // The attempt is over, so the acknowledgement given for it is over too.
      if (alive.current) { discardNameAttempt(); setNameDialog(null); await listAt(operation.rootId, operation.directory); }
    }).finally(() => { nameSubmitting.current = false; });
  };

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
    setDeleteDialog({ ...attempt });
    const parentSignal = lifetime.current?.signal;
    const abort = (): void => attempt.controller.abort();
    parentSignal?.addEventListener('abort', abort, { once: true });
    try {
      const plan = await api.control({ op: 'delete.prepare', items: attempt.targets }, { signal: attempt.controller.signal });
      if (!alive.current || !deleteAttempt.current.isCurrent(attempt) || attempt.controller.signal.aborted) return;
      const targetKeys = new Set((plan.targets ?? []).map(target => `${target.rootId}\0${target.path}`));
      const validTargets = Array.isArray(plan.targets) && plan.targets.length > 0 && targetKeys.size === plan.targets.length
        && plan.targets.every(target => attempt.targets.some(selected => target.rootId === selected.rootId && target.path === selected.path))
        && attempt.targets.every(selected => plan.targets.some(target => target.rootId === selected.rootId
          && (selected.path === target.path || selected.path.startsWith(`${target.path}/`))));
      const validEntries = Array.isArray(plan.entries) && validTargets && plan.entries.length === plan.targets.length
        && plan.entries.length === plan.entryCount
        && new Set(plan.entries.map(entry => `${entry.rootId}\0${entry.path}`)).size === plan.entries.length
        && plan.entries.every(entry => typeof entry.version === 'string' && entry.version.length > 0
          && ['file', 'directory', 'symlink'].includes(entry.kind) && targetKeys.has(`${entry.rootId}\0${entry.path}`));
      if (typeof plan.id !== 'string' || !plan.id || plan.scope !== 'selected-trees' || plan.permanent !== true
        || !Number.isFinite(plan.expiresAt) || !validTargets || !validEntries) {
        throw Object.assign(new Error('The server did not confirm the selected-tree deletion scope.'), { code: 'INVALID_DELETE_PLAN' });
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
        const result = await api.control({ op: 'delete.commit', requestId: attempt.requestId, planId: plan.id, scope: plan.scope, confirmed: true }, { persistent: true });
        // The confirmed deletion already happened: its outcome is recorded here,
        // before any reconciliation and whether or not this view is still alive.
        notifyOperationResult(result);
        fileGeneration.current += 1;
        for (const item of result.results) {
          if (item.status === 'completed' || item.removed) documents.markMissing(item.rootId, item.path);
          else {
            try { await refreshDocuments(item.rootId, item.path, true); }
            catch (failure) {
              // Reconciliation is a follow-up: it cannot unmake the deletion above,
              // so it is reported separately instead of replacing that outcome.
              notifyFailure(failure);
              if (alive.current) setError(failure);
            }
          }
        }
        if (alive.current) {
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
    clearSelection: () => setSelection([]),
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
   * Follows a notification's own navigation target.
   *
   * The drawer closes first, and nothing else moves: the directory, documents,
   * selection and clipboard stay exactly as they were, and `surface` changes only
   * when the record explicitly names a surface to show. A `viewer` target that has
   * nothing to show stays where it is instead of opening an empty viewer.
   */
  const notificationAction = (action: NotificationAction, _entry: NotificationEntry): void => {
    if (action.kind !== 'surface') return;
    setNotificationsOpen(false);
    if (action.surface === 'tasks') { setSurface('tasks'); return; }
    if (active || fileAttempt) setSurface('viewer');
  };

  const notificationEntry = (
    <NotificationButton t={t} ui={ui} unreadCount={notificationState.unreadCount} onOpen={() => setNotificationsOpen(true)} />
  );

  /** The current path supplies the grammar; write permission and availability gate typing. */
  const activeEditor = active ? {
    documentId: active.id,
    path: active.path,
    value: active.draft,
    canWrite: allowed.write === true && !active.missing,
    languageHint: ui.languageForPath?.(active.path),
    ariaLabel: `${t('editor')}: ${active.path}`,
    t,
    onChange: (text: string) => documents.edit(active.id, text),
    onSave: () => save(active.id),
  } : null;

  const nestedDialog = Boolean(nameDialog || deleteDialog || pastePlan || uploadPlan || download || referencePlan || closing || conflicting);
  const viewerTitle = fileAttempt?.path ?? active?.path ?? t('preview');
  /**
   * The pending reference controls live in the task surface now, which is where an
   * insertion is retried. They are activity state, not history, so clearing
   * notifications never removes them.
   */
  const pendingReferences = activities.references as unknown as readonly { id: string; sessionId: string; status: string; mentions: readonly string[]; error?: string | null }[];

  return (
    <section className="dsh-fm" aria-label={t('title')} data-fm-version={__FM_VERSION__}>
      <style>{PANEL_CSS}</style>
      {/* The notification drawer is a peer overlay: it suspends whatever surface is
          open instead of replacing it, so closing it returns to that view. */}
      <div className="fm-base" {...(surface || notificationsOpen ? { inert: '' } : {})}>
      <header className="fm-main-header">
        <h1>{t('title')}</h1>
        <div className="fm-header-actions">
          <Button variant="ghost" size="sm" type="button" disabled={!active} onClick={resumeViewer} data-fm-action="open-documents" aria-haspopup="dialog">
            {t('openDocuments')}{documentState.documents.length ? ` · ${documentState.documents.length}` : ''}
          </Button>
          {allowed.tasks || allowed.transfers || !historyAvailable || pendingReferences.length > 0 ? <Button variant="ghost" size="sm" type="button"
            className={failedActivityCount || !historyAvailable || activities.historyFailures.length ? 'fm-task-attention' : undefined}
            onClick={() => setSurface('tasks')} data-fm-action="show-tasks" aria-haspopup="dialog">
            {t('tasks')}<span className="fm-task-count" data-fm-task-summary role="status">{activeActivityCount ? ` · ${activeActivityCount}` : ''}{failedActivityCount ? ` · ${t('failedTasks', { count: failedActivityCount })}` : ''}{!historyAvailable || activities.historyFailures.length ? ' !' : ''}</span>
          </Button> : null}
          {notificationEntry}
        </div>
      </header>
      {/* Degradation is business state: it keeps a compact indicator here, with the
          full reason on its title, and the explanation in the notification history —
          read-only mode never depends on opening the drawer. */}
      {degraded ? (
        <div className="fm-notice fm-degraded-chip" role="status" title={degraded.message} data-fm-degraded={degraded.scope}>
          {degraded.readOnly ? t('readOnly') : t('degraded')}
        </div>
      ) : null}
      <div className="fm-layout">

        <FileSection
          t={t} ui={ui} busy={busy} capabilities={allowed} rootId={rootId} root={root} directory={directory}
          listing={listing} selection={selection} selected={selected} clipboard={activities.clipboard}
          notifications={notifications} selectionSaving={selectionSaving} loadingMore={appendPending.current}
          uploadInput={uploadInput} directoryInput={directoryInput} actions={fileActions}
        />

      </div>

      <footer className="fm-list-footer">
        <span className="fm-list-status" data-fm-list-status role="status" aria-live="polite">{busy ? t('loading') : `${listing.entries.length} / ${listing.total} ${t('items')}`}{selectedEntries.length > 0 ? ` · ${t('selectionCount', { count: selectedEntries.length })}` : ''}</span>
        <span className="fm-footer-note">{t('note')}</span>
      </footer>
      </div>
      {/* Outside `fm-base` and outside every overlay card on purpose: those become
          inert while a surface or the drawer is open, and an inert subtree is not
          announced. This is the one channel a new result speaks through. */}
      <NotificationLiveRegion entries={notificationState.entries} />
      <Overlay name="viewer" title={viewerTitle} open={surface === 'viewer'} suspended={nestedDialog || notificationsOpen} onClose={() => setSurface(null)}>
        <div ref={viewerHeader} className="fm-overlay-header fm-viewer-header">
          {button('backToFiles', { onClick: () => setSurface(null), 'data-fm-action': 'back-to-files' })}
          {/* One row per open file, single file included. Switch and close are
              sibling buttons; the tab area scrolls sideways so the window
              controls keep their place. The wrapper also carries the active
              marker: the tab stylesheet fills that one surface, so the name and
              its X read as a single chip instead of two adjacent buttons. */}
          {!fileAttempt && documentState.documents.length > 0 ? (
            <nav className="fm-tabs fm-viewer-tabs" aria-label={t('openDocuments')}>
              {documentState.documents.map(document => {
                const activeDocument = document.id === active?.id;
                const name = document.path.split('/').at(-1) ?? document.path;
                return (
                  <span key={document.id} className={activeDocument ? 'fm-tab fm-active' : 'fm-tab'}>
                    <Button
                      variant="ghost" size="sm" type="button"
                      className={activeDocument ? 'fm-active' : ''}
                      title={`${document.rootId}: ${document.path}`}
                      aria-current={activeDocument ? 'true' : undefined}
                      onClick={() => { fileGeneration.current++; setFileAttempt(null); documents.activate(document.id); }}
                      data-fm-tab={document.id}
                    >{`${document.dirty ? '● ' : ''}${name}`}</Button>
                    <Button
                      variant="ghost" size="sm" type="button" icon={<ui.IconCloseOutlineRegular />}
                      title={`${t('closeDocument')}: ${document.path}`}
                      aria-label={`${t('closeDocument')}: ${document.path}`}
                      disabled={document.saving}
                      onClick={() => closeDocument(document.id)}
                      data-fm-action="close-document" data-fm-close-document={document.id}
                    />
                  </span>
                );
              })}
            </nav>
          ) : <strong className="fm-viewer-title" title={viewerTitle}>{viewerTitle.split('/').at(-1)}</strong>}
          {!fileAttempt && active && allowed.write && !active.missing ? button(active.saving ? 'saving' : 'save', {
            variant: 'ghost', disabled: !active.dirty || active.saving, onClick: () => save(active.id), 'data-fm-action': 'save',
          }) : null}
          {/* The window X hides the editor only; it stays enabled during saves. */}
          <Button variant="ghost" size="sm" type="button" icon={<ui.IconCloseOutlineRegular />} title={t('closeViewer')} aria-label={t('closeViewer')}
            onClick={closeViewer} data-fm-action="close-viewer" />
        </div>
        {fileAttempt ? <div className="fm-viewer-attempt" aria-busy={fileAttempt.loading} data-fm-file-attempt={fileAttempt.loading ? 'loading' : 'failed'}>
          {fileAttempt.loading ? <div className="fm-placeholder" role="status">{t('loading')}</div> : <>
            <div className="fm-error" role="alert">{errorText(fileAttempt.error)}</div>
            {button('viewerDownload', { disabled: !allowed.transfers || busy > 0, onClick: downloadViewedFile, 'data-fm-action': 'download-viewed-file' })}
          </>}
        </div> : null}
        <section className="fm-preview" hidden={Boolean(fileAttempt)}>
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
      </Overlay>
      <Overlay name="tasks" title={t('tasks')} open={surface === 'tasks'} suspended={nestedDialog || notificationsOpen} drawer onClose={() => setSurface(null)}>
        <div className="fm-overlay-header">
          <strong>{t('tasks')}</strong>
          {button('close', { onClick: () => setSurface(null), 'data-fm-action': 'close-tasks' })}
        </div>
      {allowed.tasks || allowed.transfers || !historyAvailable || pendingReferences.length > 0 ? (
        <section className="fm-taskarea" aria-label={t('tasks')}>
          <div className="fm-pathbar">
            <div className="fm-actions"><strong>{t('tasks')}</strong><span data-fm-active-count={activeActivityCount}>{`${activeActivityCount} ${t('activeTasks')}`}</span></div>
            <div className="fm-actions">
              {button('refreshTasks', { onClick: refreshActivities, disabled: busy > 0, 'data-fm-action': 'refresh-tasks' })}
              {historyAvailable ? button('clearEndedTasks', { onClick: clearEndedActivities, disabled: activities.historyPending || !closableActivityCount, title: t('closeTaskHint'), 'data-fm-history-action': 'clear' }) : null}
              {button(activities.tasksCollapsed ? 'expandTasks' : 'collapseTasks', { onClick: () => activity.collapse(!activities.tasksCollapsed), 'aria-expanded': !activities.tasksCollapsed, 'aria-controls': 'dsh-fm-task-cards', 'data-fm-history-action': 'toggle' })}
            </div>
          </div>
          {/* A reference that is still waiting is work in progress, so its controls
              live here — next to the tasks — and a notification navigates to this
              surface instead of holding the only copy of the entry point. Cleared
              history never removes them: they belong to the activity store. */}
          {pendingReferences.length > 0 ? (
            <div className="fm-notice fm-pending-references" data-fm-pending-references={pendingReferences.length}>
              <div className="fm-actions"><strong>{t('reference')}</strong></div>
              {pendingReferences.map(reference => (
                <div key={reference.id} className="fm-notice" data-fm-reference-request={reference.sessionId}>
                  <span>{`${sessionOptions.find(session => session?.id === reference.sessionId)?.displayTitle ?? reference.sessionId}: ${t(reference.error || 'referenceWaiting')}`}</span>
                  {button('referenceRetry', {
                    disabled: busy > 0 || reference.status === 'inserting',
                    onClick: () => retryReference(reference),
                    'data-fm-action': 'reference-retry', 'data-fm-reference-request': reference.sessionId,
                  })}
                  {button('cancel', {
                    disabled: reference.status === 'inserting',
                    'data-fm-action': 'reference-cancel', 'data-fm-reference-request': reference.sessionId,
                    onClick: () => { if (activity.getSnapshot().references.find(item => item.id === reference.id)?.status !== 'inserting') activity.remove('references', reference.id); },
                  })}
                </div>
              ))}
            </div>
          ) : null}
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
          {!visibleTasks.length && !visibleTransfers.length && historyAvailable ? <div className="fm-placeholder">{t('noTasks')}</div> : null}
          <div id="dsh-fm-task-cards" hidden={activities.tasksCollapsed} data-fm-task-cards>
            {visibleTasks.map(task => {
              const record = task as unknown as TaskView;
              const progress = record.progress ?? { total: 0, completed: 0, failed: 0, skipped: 0, cancelled: 0, bytes: 0, totalBytes: 0 };
              return (
                <article key={record.id} className="fm-notice" data-fm-task-id={record.id} data-fm-task-status={record.status}>
                  <div className="fm-actions">
                    <strong>{`${t(record.operation === 'move' ? 'moveTask' : 'copyTask')} · ${t(`status.${record.status}`)}`}</strong>
                    <span>{`${progress.completed}/${progress.total} ${t('items')}`}</span>
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
                    <span>{`${record.itemsCompleted}/${record.itemsTotal} ${t('items')}`}</span>
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
      </Overlay>
      {nameDialog ? <NameDialog
        {...dialogContext} error={nameFailure} kind={nameDialog.kind} value={nameInput}
        onCancel={() => { discardNameAttempt(); setNameDialog(null); }}
        onChange={value => { discardNameAttempt(); setNameInput(value); }}
        onSubmit={() => submitName()}
      /> : null}
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
      <NotificationDrawer
        t={t} ui={ui} open={notificationsOpen} suspended={nestedDialog}
        entries={notificationState.entries}
        onClose={() => setNotificationsOpen(false)}
        onDismiss={id => notifications.remove(id)}
        onClear={() => notifications.clear()}
        onAction={notificationAction}
      />
    </section>
  );
}

interface DirectoryHandleLike {
  readonly kind: string;
  readonly name: string;
  entries(): AsyncIterableIterator<[string, DirectoryHandleLike]>;
  getFile(): Promise<File>;
}
