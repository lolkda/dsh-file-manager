/**
 * Directory browsing: the listing state machine and the file-list section.
 *
 * Two rules live here:
 *  - a page belongs to the directory generation and to the cursor it was
 *    requested with. A response for an older directory, or for a cursor the
 *    current listing has already moved past, is dropped instead of being merged;
 *  - a page whose path grammar cannot express a child name is still shown. Those
 *    entries carry no path, no selection control and no action, so the UI can
 *    never fabricate an executable reference to a different real entry (R18),
 *    and one unrepresentable name never makes the whole directory unusable.
 */

import type { ReactNode, RefObject } from 'react';
import type { EntrySnapshot, UnaddressableEntry } from '../contracts/protocol.js';
import type { Translate } from './i18n.js';
import type { PrimitiveProps, UiPrimitives } from './ui.js';

/** Re-exported so the panel and this module agree on the frozen shape. */
export type { UnaddressableEntry } from '../contracts/protocol.js';

export interface ListingPage {
  readonly rootId: string;
  readonly path: string;
  readonly entries: readonly EntrySnapshot[];
  readonly total: number;
  readonly nextCursor: string | null;
  readonly unaddressable: readonly UnaddressableEntry[];
}

export interface ListingState {
  readonly rootId: string;
  readonly path: string;
  readonly entries: readonly EntrySnapshot[];
  readonly total: number;
  readonly nextCursor: string | null;
  readonly unaddressable: readonly UnaddressableEntry[];
  /** Directory generation; a response from another generation is stale. */
  readonly generation: number;
}

export const EMPTY_LISTING: ListingState = Object.freeze({
  rootId: '', path: '', entries: Object.freeze([]), total: 0, nextCursor: null, unaddressable: Object.freeze([]), generation: 0,
});

/** Starts a new directory: the page cursor of the previous directory is gone. */
export function beginDirectory(generation: number, rootId: string, path: string): ListingState {
  return { ...EMPTY_LISTING, rootId, path, generation };
}

export interface ApplyPageOptions {
  readonly append: boolean;
  /** The cursor the request was sent with, or null for a first page. */
  readonly cursor: string | null;
  readonly generation: number;
}

/**
 * Merges one page. Returns the previous state unchanged when the page is stale,
 * so a late response can never pollute the directory the user is looking at.
 */
export function applyPage(state: ListingState, page: ListingPage, { append, cursor, generation }: ApplyPageOptions): ListingState {
  if (!append) {
    // A first page opens the directory: the caller already proved its ticket is
    // the current generation, so it replaces whatever was listed before.
    return {
      rootId: page.rootId,
      path: page.path,
      entries: page.entries,
      total: page.total,
      nextCursor: page.nextCursor,
      unaddressable: page.unaddressable,
      generation,
    };
  }
  // An append belongs to the directory and to the cursor it was sent with; a
  // late page from another directory or another cursor is dropped.
  if (generation !== state.generation) return state;
  if (cursor !== state.nextCursor) return state;
  if (page.rootId !== state.rootId || page.path !== state.path) return state;
  // Defensive: a repeated page must not duplicate rows even if the Host re-sends
  // a cursor, because the view keys rows by path.
  const seen = new Set(state.entries.map(entry => entry.path));
  const merged = [...state.entries, ...page.entries.filter(entry => !seen.has(entry.path))];
  return { ...state, entries: merged, total: page.total, nextCursor: page.nextCursor, unaddressable: [...state.unaddressable, ...page.unaddressable] };
}

/** True while another page of the same directory is already in flight. */
export function canLoadMore(state: ListingState, pending: boolean): boolean {
  return !pending && typeof state.nextCursor === 'string' && state.nextCursor.length > 0;
}

export interface FileCapabilities {
  readonly write?: boolean;
  readonly tasks?: boolean;
  readonly transfers?: boolean;
  readonly references?: boolean;
}

export interface FileActions {
  openDirectory(id: string, path: string, append?: boolean): void;
  openFile(entry: EntrySnapshot): void;
  refresh(): void;
  toggleSelection(path: string, checked: boolean): void;
  beginName(kind: 'file' | 'directory' | 'rename'): void;
  prepareDelete(): void;
  copySelection(operation: 'copy' | 'move'): void;
  preparePaste(): void;
  pickUpload(kind: 'files' | 'directory'): void | Promise<void>;
  beginDownload(): void;
  beginReference(): void;
  loadMore(): void;
  pickFiles(event: { target: { files?: unknown; value: string } }): void | Promise<void>;
}

export interface FileSectionProps {
  readonly t: Translate;
  readonly ui: UiPrimitives;
  readonly busy: number;
  readonly capabilities: FileCapabilities;
  readonly rootId: string;
  readonly root: { id: string; label: string; path: string } | undefined;
  readonly directory: string;
  readonly listing: ListingState;
  readonly selection: readonly string[];
  readonly selected: string;
  readonly clipboard: { operation: 'copy' | 'move'; items: readonly unknown[] } | null;
  readonly directoryFallback: boolean;
  readonly operationResult: { status: string; results: readonly { path: string; status: string; error?: { code?: string } | undefined }[] } | null;
  readonly selectionSaving: boolean;
  readonly loadingMore: boolean;
  readonly errorText: (failure: unknown) => string;
  readonly uploadInput: RefObject<HTMLInputElement>;
  readonly directoryInput: RefObject<HTMLInputElement>;
  readonly actions: FileActions;
}

function button({ t, ui }: { t: Translate; ui: UiPrimitives }, label: string, props: PrimitiveProps = {}): ReactNode {
  return <ui.Button variant="ghost" size="sm" type="button" {...props}>{t(label)}</ui.Button>;
}

function FolderIcon({ size = 18, active = false }: { size?: number; active?: boolean }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden style={{ flex: 'none', color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' }}>
      <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" />
      <path d="M3 11h18" stroke="currentColor" strokeWidth={1.6} />
    </svg>
  );
}

function FileIcon(): ReactNode {
  return (
    <svg width={17} height={19} viewBox="0 0 20 24" fill="none" aria-hidden style={{ flex: 'none' }}>
      <path d="M4 2h8l5 5v15H4V2Z M12 2v6h5 M7 12h7 M7 16h7" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" />
    </svg>
  );
}

export { FolderIcon, FileIcon };

export function FileSection(props: FileSectionProps): ReactNode {
  const { t, ui, busy, capabilities, rootId, root, directory, listing, selection, selected, clipboard, directoryFallback, operationResult, selectionSaving, loadingMore, errorText, uploadInput, directoryInput, actions } = props;
  const crumbs = directory ? directory.split('/') : [];
  const selectedEntries = listing.entries.filter(entry => selection.includes(entry.path));
  const selectable = (kind: string): boolean => ['file', 'directory', 'symlink'].includes(kind);

  return (
    <section className="fm-files">
      {/* The directory path row keeps the shared path-row class for its height,
          padding and border, and adds its own breadcrumb class for the layout
          that class cannot carry: the listing column, the preview title row and
          the task bar reuse `.fm-pathbar`, so a fix written there would move
          them too (R20). */}
      <div className="fm-pathbar fm-breadcrumb-bar">
        <nav className="fm-crumbs" aria-label={t('roots')}>
          {root ? <ui.Button variant="ghost" size="sm" type="button" disabled={busy > 0} title={root.path} onClick={() => actions.openDirectory(rootId, '')}>{root.label}</ui.Button> : null}
          {crumbs.map((part, index) => (
            <span className="fm-crumb" key={crumbs.slice(0, index + 1).join('/')}>
              <i aria-hidden>/</i>
              <ui.Button variant="ghost" size="sm" type="button" disabled={busy > 0} onClick={() => actions.openDirectory(rootId, crumbs.slice(0, index + 1).join('/'))}>{part}</ui.Button>
            </span>
          ))}
        </nav>
        {button({ t, ui }, 'refresh', { disabled: !rootId || busy > 0, onClick: actions.refresh, 'data-fm-action': 'refresh' })}
      </div>
      <div className="fm-pathbar fm-actions">
        {button({ t, ui }, 'newFile', { disabled: !capabilities.write || !rootId || busy > 0, onClick: () => actions.beginName('file'), 'data-fm-action': 'new-file' })}
        {button({ t, ui }, 'newDirectory', { disabled: !capabilities.write || !rootId || busy > 0, onClick: () => actions.beginName('directory'), 'data-fm-action': 'new-directory' })}
        {button({ t, ui }, 'rename', { disabled: !capabilities.write || selectedEntries.length !== 1 || busy > 0 || selectionSaving, onClick: () => actions.beginName('rename'), 'data-fm-action': 'rename' })}
        {button({ t, ui }, 'delete', { disabled: !capabilities.write || !selectedEntries.length || busy > 0 || selectionSaving, onClick: actions.prepareDelete, 'data-fm-action': 'delete' })}
        {button({ t, ui }, 'copy', { disabled: !capabilities.tasks || !selectedEntries.length || busy > 0 || selectionSaving, onClick: () => actions.copySelection('copy'), 'data-fm-action': 'copy' })}
        {button({ t, ui }, 'cut', { disabled: !capabilities.tasks || !selectedEntries.length || busy > 0 || selectionSaving, onClick: () => actions.copySelection('move'), 'data-fm-action': 'cut' })}
        {button({ t, ui }, 'paste', { disabled: !capabilities.tasks || !clipboard || !rootId || busy > 0, onClick: actions.preparePaste, 'data-fm-action': 'paste' })}
        {button({ t, ui }, 'uploadFiles', { disabled: !capabilities.transfers || !rootId || busy > 0, onClick: () => actions.pickUpload('files'), 'data-fm-action': 'upload-files' })}
        {button({ t, ui }, 'uploadDirectory', { disabled: !capabilities.transfers || !rootId || busy > 0, onClick: () => actions.pickUpload('directory'), 'data-fm-action': 'upload-directory' })}
        {button({ t, ui }, 'download', { disabled: !capabilities.transfers || !rootId || selectedEntries.length > 1 || busy > 0, onClick: actions.beginDownload, 'data-fm-action': 'download' })}
        {button({ t, ui }, 'reference', { disabled: !capabilities.references || !selectedEntries.length || busy > 0, onClick: actions.beginReference, 'data-fm-action': 'reference' })}
        <input type="file" multiple hidden ref={uploadInput} disabled={!capabilities.transfers} onChange={actions.pickFiles} aria-label={t('uploadFiles')} data-fm-upload-files />
        <input type="file" multiple hidden ref={directoryInput} disabled={!capabilities.transfers} onChange={actions.pickFiles} aria-label={t('uploadDirectory')} data-fm-upload-directory-input />
      </div>
      {directoryFallback ? <div className="fm-notice">{t('directoryFallback')}</div> : null}
      {clipboard ? <div className="fm-muted" style={{ padding: '4px 12px' }}>{`${t('clipboard')}: ${t(clipboard.operation === 'move' ? 'cut' : 'copy')} · ${clipboard.items.length} ${t('items')}`}</div> : null}
      {selectedEntries.length > 0 ? <div className="fm-muted" style={{ padding: '4px 12px' }}>{`${selectedEntries.length} ${t('selected')}`}</div> : null}
      {operationResult ? (
        <div className="fm-notice" data-fm-operation-result={operationResult.status}>
          {t(`status.${operationResult.status}`)}
          {operationResult.results.map(result => (
            <div key={`${result.path}:${result.status}`}>{`${result.path}: ${t(`status.${result.status}`)}${result.error ? ` · ${errorText(result.error)}` : ''}`}</div>
          ))}
        </div>
      ) : null}
      <div className="fm-scroll" aria-busy={busy > 0}>
        {!rootId ? <div className="fm-placeholder"><FolderIcon size={34} />{busy ? t('loading') : t('emptyRoots')}</div> : null}
        {rootId && listing.entries.length === 0 && listing.unaddressable.length === 0 ? <div className="fm-placeholder">{busy ? t('loading') : t('empty')}</div> : null}
        {listing.entries.map(entry => (
          <div key={entry.path} className="fm-entryline">
            <label className="fm-selection-control" title={`${t('select')}: ${entry.name}`}>
              <input
                type="checkbox" className="fm-selection" checked={selection.includes(entry.path)}
                disabled={busy > 0 || !selectable(entry.kind)}
                aria-label={`${t('select')}: ${entry.name}`}
                onChange={event => actions.toggleSelection(entry.path, event.target.checked)}
              />
            </label>
            <ui.Button
              variant="ghost" size="sm" type="button" className={`fm-row${entry.path === selected ? ' fm-active' : ''}`}
              disabled={busy > 0 || !['directory', 'file'].includes(entry.kind)}
              title={['directory', 'file'].includes(entry.kind) ? entry.name : t('special')}
              onClick={() => (entry.kind === 'directory' ? actions.openDirectory(rootId, entry.path) : actions.openFile(entry))}
              data-fm-entry={entry.kind} data-fm-path={entry.path}
            >
              {entry.kind === 'directory' ? <FolderIcon size={17} /> : <FileIcon />}
              <span className="fm-filename">{entry.name}</span>
              {entry.kind === 'file' ? <span className="fm-size">{`${entry.size.toLocaleString()} ${t('bytes')}`}</span> : null}
            </ui.Button>
          </div>
        ))}
        {listing.unaddressable.length > 0 ? (
          <div className="fm-notice" data-fm-unaddressable={listing.unaddressable.length}>
            <strong>{`${t('unaddressable')}: ${listing.unaddressable.length}`}</strong>
            <div className="fm-muted">{t('unaddressableHint')}</div>
            {listing.unaddressable.map(entry => (
              <div key={`${entry.kind}:${entry.name}`} className="fm-muted" data-fm-unaddressable-name={entry.name}>
                {`${entry.name} · ${entry.reason}`}
              </div>
            ))}
          </div>
        ) : null}
        {listing.nextCursor ? button({ t, ui }, 'more', { className: 'fm-more', disabled: busy > 0 || loadingMore, onClick: actions.loadMore, 'data-fm-action': 'more' }) : null}
      </div>
    </section>
  );
}
