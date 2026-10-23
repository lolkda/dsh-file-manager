/**
 * The notification drawer.
 *
 * Notifications are an event log, not business state: this module renders and
 * dismisses records, and the only action it offers navigates to the surface that
 * owns the work. It never mutates the file-task clipboard, tasks, references,
 * documents or selection, so clearing history can never remove a capability —
 * and the dangerous confirmations stay where they are.
 *
 * The store lives outside this component (the plugin owns it), so a confirmed
 * operation can still report its outcome after the panel unmounts.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { NotificationAction, NotificationEntry, NotificationLevel } from './notifications.js';
import type { Translate } from './i18n.js';
import type { UiPrimitives } from './ui.js';
import { Overlay } from './overlay.js';

/** The surface label each navigation target shows on its button. */
const SURFACE_LABEL = Object.freeze({ tasks: 'tasks', viewer: 'preview' } as const);

/** A level is also a colour and a shape, so the row reads without colour alone. */
function LevelIcon({ level }: { level: NotificationLevel }): ReactNode {
  const path = level === 'success' ? 'M4 8.5 6.5 11 12 5'
    : level === 'warning' ? 'M8 4v5M8 12h.01'
      : level === 'error' ? 'M5 5l6 6M11 5l-6 6'
        : 'M8 7v.01M8 10v.01';
  return (
    <svg className="fm-notification-icon" width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {level === 'info'
        ? <circle cx={8} cy={8} r={5.5} stroke="currentColor" strokeWidth={1.4} />
        : <path d={path} stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

/**
 * A timestamp the user can read and a machine can parse. An entry whose stamp is
 * unusable renders no time instead of "Invalid Date".
 */
function timeOf(createdAt: number): { readonly iso: string; readonly text: string } {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return { iso: '', text: '' };
  return { iso: date.toISOString(), text: date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) };
}

export interface NotificationButtonProps {
  readonly t: Translate;
  readonly ui: UiPrimitives;
  readonly unreadCount: number;
  readonly onOpen: () => void;
}

/**
 * The header entry point. The count is exposed as an attribute in every state —
 * including zero — while the visible badge appears only when there is something
 * to read, so opening the drawer cannot shift the header. The badge itself is
 * decorative, so the count is also in the accessible name: a screen reader hears
 * how much is unread, not just that the button exists.
 */
export function NotificationButton({ t, ui, unreadCount, onOpen }: NotificationButtonProps): ReactNode {
  const label = unreadCount > 0 ? `${t('notifications')} · ${t('notificationUnread', { count: unreadCount })}` : t('notifications');
  return (
    <ui.Button
      variant="ghost" size="sm" type="button" onClick={onOpen}
      className={unreadCount > 0 ? 'fm-notification-entry fm-attention' : 'fm-notification-entry'}
      title={t('notifications')} aria-label={label} aria-haspopup="dialog"
      data-fm-action="notifications" data-fm-notification-count={String(unreadCount)}
    >
      {t('notifications')}
      {unreadCount > 0 ? <span className="fm-notification-badge" aria-hidden="true">{unreadCount > 99 ? '99+' : String(unreadCount)}</span> : null}
    </ui.Button>
  );
}

/**
 * The accessible channel for a new result.
 *
 * Only an *insertion* speaks: the previously rendered ids are remembered, so
 * removing a record or marking it read never re-announces an older message, and
 * the first render after mount records what is already there instead of replaying
 * history. It is visually hidden and carries one short title, so no layout moves.
 */
export function NotificationLiveRegion({ entries }: { readonly entries: readonly NotificationEntry[] }): ReactNode {
  const [message, setMessage] = useState('');
  const previousIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    const previous = previousIds.current;
    // Keeping only the current ids bounds the bookkeeping by the store's own limit.
    previousIds.current = new Set(entries.map(entry => entry.id));
    if (previous === null) return;
    const inserted = entries.find(entry => !previous.has(entry.id));
    if (inserted) setMessage(inserted.title);
  }, [entries]);
  return (
    <span className="fm-notification-live" role="status" aria-live="polite" data-fm-notification-live>
      {message}
    </span>
  );
}

export interface NotificationRowProps {
  readonly t: Translate;
  readonly ui: UiPrimitives;
  readonly entry: NotificationEntry;
  readonly onDismiss: (id: string) => void;
  readonly onAction: (action: NotificationAction, entry: NotificationEntry) => void;
}

function NotificationRow({ t, ui, entry, onDismiss, onAction }: NotificationRowProps): ReactNode {
  const action = entry.action;
  const when = timeOf(entry.createdAt);
  return (
    <article
      className="fm-notification" data-fm-notification-id={entry.id} data-fm-notification-level={entry.level}
      {...(entry.code ? { 'data-fm-notification-code': entry.code } : {})}
    >
      <div className="fm-notification-head">
        <span className="fm-notification-level" aria-hidden="true"><LevelIcon level={entry.level} /></span>
        <strong className="fm-notification-title">{entry.title}</strong>
        {when.text ? <time className="fm-notification-time" dateTime={when.iso} title={when.iso}>{when.text}</time> : null}
        <ui.Button
          variant="ghost" size="sm" type="button" className="fm-notification-remove"
          title={t('notificationDismiss')} aria-label={`${t('notificationDismiss')}: ${entry.title}`}
          onClick={() => onDismiss(entry.id)}
          data-fm-action="notification-dismiss" data-fm-notification-id={entry.id}
        >×</ui.Button>
      </div>
      {entry.message ? <p className="fm-notification-message">{entry.message}</p> : null}
      {entry.details?.length ? (
        <ul className="fm-notification-details">
          {entry.details.map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}
        </ul>
      ) : null}
      {action?.kind === 'surface' ? (
        <ui.Button
          variant="ghost" size="sm" type="button" className="fm-notification-goto"
          onClick={() => onAction(action, entry)}
          data-fm-action="notification-action" data-fm-notification-id={entry.id}
        >{t(SURFACE_LABEL[action.surface])}</ui.Button>
      ) : null}
      {action?.kind === 'manual-copy' ? (
        <div className="fm-notification-manual">
          {/* The complete text is rendered, never truncated, and selecting it on
              focus is the whole manual fallback: for a failed copy this row holds
              the only copy of it. */}
          <textarea
            className="fm-path-copy-text" readOnly value={action.text}
            rows={Math.min(4, action.text.split('\n').length)} wrap="off" spellCheck={false}
            aria-label={t('pathCopyManual')} data-fm-path-copy-text
            onFocus={event => event.currentTarget.select()}
          />
        </div>
      ) : null}
    </article>
  );
}

export interface NotificationDrawerProps {
  readonly t: Translate;
  readonly ui: UiPrimitives;
  readonly open: boolean;
  /** A nested confirmation owns the keyboard while it is open. */
  readonly suspended: boolean;
  readonly entries: readonly NotificationEntry[];
  readonly onClose: () => void;
  readonly onDismiss: (id: string) => void;
  readonly onClear: () => void;
  readonly onAction: (action: NotificationAction, entry: NotificationEntry) => void;
}

/**
 * The drawer itself. It is a peer overlay rather than another `surface`, so
 * opening it leaves the current directory, document and selection untouched and
 * closing it returns to exactly the view that was there.
 */
export function NotificationDrawer({ t, ui, open, suspended, entries, onClose, onDismiss, onClear, onAction }: NotificationDrawerProps): ReactNode {
  return (
    <Overlay name="notifications" title={t('notifications')} open={open} suspended={suspended} drawer onClose={onClose}>
      <div className="fm-overlay-header">
        <strong>{t('notifications')}</strong>
        {entries.length ? (
          <ui.Button variant="ghost" size="sm" type="button" onClick={onClear} data-fm-action="notifications-clear">
            {t('notificationsClear')}
          </ui.Button>
        ) : null}
        <ui.Button variant="ghost" size="sm" type="button" onClick={onClose} data-fm-action="close-notifications">
          {t('close')}
        </ui.Button>
      </div>
      <aside className="fm-notification-list">
        <p className="fm-muted">{t('notificationsHint')}</p>
        {entries.length === 0 ? <div className="fm-placeholder" data-fm-notifications-empty>{t('notificationsEmpty')}</div> : null}
        {entries.map(entry => (
          <NotificationRow key={entry.id} t={t} ui={ui} entry={entry} onDismiss={onDismiss} onAction={onAction} />
        ))}
      </aside>
    </Overlay>
  );
}
