/**
 * Dialogs: every confirmation the panel can raise.
 *
 * They are presentational — all of them receive state and callbacks, none of
 * them perform I/O — so the interaction rules they encode are directly testable
 * from the rendered tree:
 *  - a permanent deletion needs a reviewed server manifest, an explicit
 *    acknowledgement and a second confirmation;
 *  - a dialog belongs to one attempt: a cancelled or replaced attempt can never
 *    reopen itself or submit anything when a late response arrives.
 */

import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { TaskConflictPolicy, UploadConflictPolicy } from '../contracts/limits.js';

/** The upload dialog also offers a local "rename to avoid the conflict" policy. */
export type UploadPolicy = UploadConflictPolicy | 'rename';

const asTaskConflict = (value: string): TaskConflictPolicy => (value === 'rename' || value === 'overwrite' ? value : 'skip');
const asUploadPolicy = (value: string): UploadPolicy => (value === 'rename' || value === 'overwrite' || value === 'error' ? value : 'skip');
import type { DeletePlan, EntryVersion, PublicTransferView } from '../contracts/views.js';
import type { Translate } from './i18n.js';
import type { PrimitiveProps, UiPrimitives } from './ui.js';

export type DeletePhase = 'preparing' | 'ready' | 'failed' | 'committing';

export interface DeleteAttempt {
  id: string;
  phase: DeletePhase;
  /** Identity of the logical action; a retry of this attempt reuses it. */
  requestId: string;
  acknowledged: boolean;
  plan: DeletePlan | null;
  error: unknown;
  targets: { rootId: string; path: string }[];
  controller: AbortController;
}

export interface RootRemovalAttempt {
  id: string;
  phase: 'ready' | 'failed' | 'committing';
  requestId: string;
  root: { id: string; label: string; path: string };
  error: unknown;
}

export interface PasteItem {
  source: { rootId: string; path: string; name: string; kind: string; expectedVersion?: EntryVersion | undefined };
  target: { kind: string; version: EntryVersion } | null;
  conflict: TaskConflictPolicy;
  name: string;
}

export interface PastePlan {
  operation: 'copy' | 'move';
  destination: { rootId: string; path: string };
  items: readonly PasteItem[];
}

export interface UploadSource {
  path: string;
  kind: 'file' | 'directory';
  file?: File | undefined;
}

export interface UploadGroup {
  name: string;
  kind: string;
  target: { kind: string; version: EntryVersion } | null;
  /** `error` is the local default before the Host answered the name lookup. */
  conflict: UploadPolicy;
  renamed: string;
}

export interface UploadPlan {
  rootId: string;
  path: string;
  sources: readonly UploadSource[];
  groups: readonly UploadGroup[];
}

export interface ReferenceEntry {
  mention: string;
}

export interface DialogContext {
  readonly t: Translate;
  readonly ui: UiPrimitives;
  readonly busy: boolean;
  readonly errorText: (failure: unknown) => string;
}

export function dialogButton({ t, ui }: Pick<DialogContext, 't' | 'ui'>, label: string, props: PrimitiveProps = {}): ReactNode {
  return <ui.Button variant="ghost" size="sm" type="button" {...props}>{t(label)}</ui.Button>;
}

/**
 * The upload review's footer action: the standard control size, this dialog only.
 *
 * Sizing belongs to the caller instead of `dialogButton`, so the small default
 * every other dialog uses stays untouched.
 */
function uploadAction({ t, ui }: Pick<DialogContext, 't' | 'ui'>, label: string, props: PrimitiveProps = {}): ReactNode {
  return <ui.Button variant="ghost" size="md" type="button" {...props}>{t(label)}</ui.Button>;
}

function Actions({ children }: { children: ReactNode }): ReactNode {
  return <div className="fm-dialog-actions">{children}</div>;
}

export function NameDialog({ t, ui, busy, errorText, error, kind, value, onCancel, onChange, onSubmit }: DialogContext & {
  error: unknown;
  kind: 'file' | 'directory' | 'rename';
  value: string;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
}): ReactNode {
  const title = kind === 'rename' ? 'rename' : kind === 'directory' ? 'newDirectory' : 'newFile';
  return (
    <ui.Modal
      contentClassName="dsh-fm-dialog"
      open
      onClose={() => { if (!busy) onCancel(); }}
      title={t(title)}
      closeLabel={t('close')}
      description={t('nameDescription')}
      footer={<Actions>
        {dialogButton({ t, ui }, 'cancel', { disabled: busy, onClick: onCancel })}
        {dialogButton({ t, ui }, 'applyName', { variant: 'primary', disabled: busy || !value, onClick: onSubmit, 'data-fm-action': 'name-submit' })}
      </Actions>}
    >
      <div className="fm-dialog-content">
        <label className="fm-field">
          {t('name')}
          <ui.Input
            className="fm-input" autoFocus value={value} disabled={busy} aria-label={t('name')} data-fm-name
            onChange={(event: { target: { value: string } }) => onChange(event.target.value)}
            onKeyDown={(event: { key: string; preventDefault: () => void }) => { if (event.key === 'Enter' && !busy) { event.preventDefault(); onSubmit(); } }}
          />
        </label>
        {error ? <div role="alert">{errorText(error)}</div> : null}
      </div>
    </ui.Modal>
  );
}

export function RootRemovalDialog({ t, ui, busy, errorText, attempt, onCancel, onConfirm }: DialogContext & {
  attempt: RootRemovalAttempt | null;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  if (!attempt) return null;
  return (
    <ui.Modal
      contentClassName="dsh-fm-dialog"
      open
      onClose={onCancel}
      title={t('removeRootTitle')}
      closeLabel={t('close')}
      description={t('removeRootDescription')}
      footer={<Actions>
        {dialogButton({ t, ui }, 'cancel', { disabled: attempt.phase === 'committing', onClick: onCancel, 'data-fm-action': 'remove-root-cancel' })}
        {dialogButton({ t, ui }, 'removeRootConfirm', { variant: 'primary', disabled: attempt.phase === 'committing' || busy, onClick: onConfirm, 'data-fm-action': 'remove-root-confirm' })}
      </Actions>}
    >
      <div className="fm-dialog-content">
        <p data-fm-remove-root-preview style={{ overflowWrap: 'anywhere' }}>{attempt.root.path}</p>
        {attempt.phase === 'committing' ? <p role="status">{t('removeRootWorking')}</p> : null}
        {attempt.error ? <div role="alert">{errorText(attempt.error)}</div> : null}
      </div>
    </ui.Modal>
  );
}

export function DeleteDialog({ t, ui, busy, errorText, write, attempt, onCancel, onAcknowledge, onConfirm }: DialogContext & {
  write: boolean;
  attempt: DeleteAttempt | null;
  onCancel: () => void;
  onAcknowledge: (acknowledged: boolean) => void;
  onConfirm: () => void;
}): ReactNode {
  if (!attempt) return null;
  const phase = attempt.phase;
  return (
    <ui.Modal
      contentClassName="dsh-fm-dialog"
      open
      onClose={onCancel}
      title={t('deleteTitle')}
      closeLabel={t('close')}
      description={t('deleteDescription')}
      footer={<Actions>
        {dialogButton({ t, ui }, 'cancel', { disabled: phase === 'committing', onClick: onCancel, 'data-fm-action': 'delete-cancel' })}
        {dialogButton({ t, ui }, 'deleteConfirm', {
          variant: 'primary',
          disabled: phase !== 'ready' || !attempt.plan || !attempt.acknowledged || busy || !write,
          onClick: onConfirm, 'data-fm-action': 'delete-confirm',
        })}
      </Actions>}
    >
      <div className="fm-dialog-content" data-fm-delete-phase={phase}>
        {attempt.error ? <div role="alert">{errorText(attempt.error)}</div> : null}
        <ui.Checkbox
          checked={attempt.acknowledged}
          onChange={(acknowledged: boolean) => onAcknowledge(acknowledged)}
          label={t('deleteAck')}
          // Acknowledging is a statement of intent, so it waits only for the
          // prepared plan. Gating it on `busy` made an unrelated in-flight
          // request (a listing, a save) block the checkbox for as long as that
          // request took. Double-submit protection stays on the confirm button.
          disabled={phase !== 'ready'}
        />
      </div>
    </ui.Modal>
  );
}

export function PasteDialog({ t, ui, busy, errorText, error, tasks, plan, onCancel, onChange, onConfirm }: DialogContext & {
  error: unknown;
  tasks: boolean;
  plan: PastePlan | null;
  onCancel: () => void;
  onChange: (index: number, change: Partial<PasteItem>) => void;
  onConfirm: () => void;
}): ReactNode {
  const [openPolicy, setOpenPolicy] = useState<number | null>(null);
  const fieldId = useId();
  useEffect(() => {
    if (!plan || busy) setOpenPolicy(null);
  }, [plan, busy]);
  if (!plan) return null;
  return (
    <ui.Modal
      contentClassName="dsh-fm-dialog"
      open
      onClose={() => { if (!busy) onCancel(); }}
      title={t('pasteTitle')}
      closeLabel={t('close')}
      description={t('pasteDescription')}
      footer={<Actions>
        {dialogButton({ t, ui }, 'cancel', { disabled: busy, onClick: onCancel })}
        {dialogButton({ t, ui }, 'pasteConfirm', { variant: 'primary', disabled: busy || !tasks, onClick: onConfirm, 'data-fm-action': 'paste-confirm' })}
      </Actions>}
    >
      <div className="fm-dialog-content fm-paste-content" onKeyDownCapture={event => {
        // A portal still belongs to this React subtree. Consume Escape before
        // the enclosing Modal's document listener can dismiss the whole review.
        if (event.key !== 'Escape' || openPolicy === null) return;
        event.preventDefault();
        event.stopPropagation();
        setOpenPolicy(null);
        event.currentTarget.querySelector<HTMLButtonElement>(`button[data-fm-conflict-policy="${openPolicy}"]`)?.focus();
      }}>
        {plan.items.map((item, index) => {
          const policies = [
            { id: 'skip', label: t('skip') },
            { id: 'rename', label: t('renameConflict') },
            ...(item.source.kind === 'file' && item.target?.kind === 'file'
              ? [{ id: 'overwrite', label: t('pasteOverwrite') }] : []),
          ];
          const selectedLabel = policies.find(policy => policy.id === item.conflict)?.label ?? t('skip');
          const open = openPolicy === index && !busy;
          const labelId = `${fieldId}-${index}-label`;
          const valueId = `${fieldId}-${index}-value`;
          return (
            <div className="fm-paste-item" key={`${item.source.rootId}:${item.source.path}`}>
              <div className="fm-paste-filename">{item.source.name}</div>
              <div className="fm-field">
                <span id={labelId} className="fm-paste-label">{t('pasteConflictPolicy')}</span>
                <ui.Menu
                  className="fm-paste-policy-menu"
                  open={open} portal autoFocus
                  items={policies} selectedId={item.conflict}
                  onClose={() => setOpenPolicy(null)}
                  onSelect={id => {
                    if (busy || !policies.some(policy => policy.id === id)) return;
                    onChange(index, { conflict: asTaskConflict(id) });
                    setOpenPolicy(null);
                  }}
                  anchor={
                    <ui.Button
                      type="button" variant="outline" className="fm-paste-policy-trigger"
                      disabled={busy} data-fm-conflict-policy={index}
                      aria-haspopup="menu" aria-expanded={open} aria-labelledby={`${labelId} ${valueId}`}
                      onClick={() => { if (!busy) setOpenPolicy(current => current === index ? null : index); }}
                      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                        if (!busy && !open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                          event.preventDefault();
                          setOpenPolicy(index);
                        }
                      }}
                    >
                      <span id={valueId}>{selectedLabel}</span>
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </ui.Button>
                  }
                />
              </div>
              {item.conflict === 'rename' ? (
                <label className="fm-field">
                  <span className="fm-paste-label">{t('pasteNewName')}</span>
                  <ui.Input
                    className="fm-input" value={item.name} placeholder={item.source.name} aria-label={`${t('rename')}: ${item.source.name}`}
                    data-fm-paste-name={index} disabled={busy}
                    onChange={(event: { target: { value: string } }) => onChange(index, { name: event.target.value })}
                  />
                </label>
              ) : null}
            </div>
          );
        })}
        {error ? <div role="alert">{errorText(error)}</div> : null}
      </div>
    </ui.Modal>
  );
}

export function UploadDialog({ t, ui, busy, errorText, error, transfers, plan, onCancel, onChange, onConfirm }: DialogContext & {
  error: unknown;
  transfers: boolean;
  plan: UploadPlan | null;
  onCancel: () => void;
  onChange: (index: number, change: Partial<UploadGroup>) => void;
  onConfirm: () => void;
}): ReactNode {
  const [openPolicy, setOpenPolicy] = useState<number | null>(null);
  const fieldId = useId();
  useEffect(() => {
    if (!plan || busy) setOpenPolicy(null);
  }, [plan, busy]);
  if (!plan) return null;
  return (
    <ui.Modal
      // Two scopes, because the Modal puts `className` on the card and
      // `contentClassName` on the header/description/body wrapper: the footer is
      // a sibling of that wrapper, and the card is the level the viewport can
      // cap. One class cannot address both.
      className="fm-upload-dialog"
      contentClassName="dsh-fm-dialog fm-upload-dialog-content"
      open
      onClose={() => { if (!busy) onCancel(); }}
      title={t('uploadTitle')}
      closeLabel={t('close')}
      description={t('uploadDescription')}
      footer={<div className="fm-dialog-actions fm-upload-actions">
        {uploadAction({ t, ui }, 'cancel', { disabled: busy, onClick: onCancel })}
        {uploadAction({ t, ui }, 'uploadConfirm', {
          variant: 'primary',
          disabled: busy || !transfers || plan.groups.some(group => group.conflict === 'rename' && !group.renamed),
          onClick: onConfirm, 'data-fm-action': 'upload-confirm',
        })}
      </div>}
    >
      <div className="fm-dialog-content fm-upload-content" onKeyDownCapture={event => {
        // A portal still belongs to this React subtree. Consume Escape before
        // the enclosing Modal's document listener can dismiss the whole review,
        // and hand focus back to the control the list was opened from.
        if (event.key !== 'Escape' || openPolicy === null) return;
        event.preventDefault();
        event.stopPropagation();
        setOpenPolicy(null);
        event.currentTarget.querySelector<HTMLButtonElement>(`button[data-fm-upload-policy="${openPolicy}"]`)?.focus();
      }}>
        <p>{`${plan.sources.length} ${t('items')} · ${plan.sources.reduce((total, item) => total + (item.file?.size ?? 0), 0).toLocaleString()} ${t('bytes')}`}</p>
        {plan.groups.map((group, index) => {
          // The policy set is the reviewed plan: `error` is the explicit
          // pre-conflict state of a name the destination does not have yet,
          // `overwrite` exists only where a file would replace a file, and a
          // directory target can never be merged.
          const policies = [
            ...(!group.target ? [{ id: 'error', label: t('uploadFiles') }] : []),
            { id: 'skip', label: t('skip') },
            { id: 'rename', label: t('renameConflict') },
            ...(group.kind === 'file' && group.target?.kind === 'file' ? [{ id: 'overwrite', label: t('overwrite') }] : []),
          ];
          const selectedLabel = policies.find(policy => policy.id === group.conflict)?.label ?? t('skip');
          const open = openPolicy === index && !busy;
          const labelId = `${fieldId}-${index}-label`;
          const valueId = `${fieldId}-${index}-value`;
          return (
            <div className="fm-upload-item" key={group.name}>
              <div className="fm-upload-filename">{group.name}</div>
              <div className="fm-field">
                <span id={labelId} className="fm-upload-label">{t('uploadConflictPolicy')}</span>
                <ui.Menu
                  className="fm-upload-policy-menu"
                  open={open} portal autoFocus
                  items={policies} selectedId={group.conflict}
                  onClose={() => setOpenPolicy(null)}
                  onSelect={id => {
                    if (busy || !policies.some(policy => policy.id === id)) return;
                    onChange(index, { conflict: asUploadPolicy(id) });
                    setOpenPolicy(null);
                  }}
                  anchor={
                    <ui.Button
                      type="button" variant="ghost" className="fm-upload-policy-trigger"
                      disabled={busy} data-fm-upload-policy={index}
                      aria-haspopup="menu" aria-expanded={open} aria-labelledby={`${labelId} ${valueId}`}
                      onClick={() => { if (!busy) setOpenPolicy(current => current === index ? null : index); }}
                      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                        if (!busy && !open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                          event.preventDefault();
                          setOpenPolicy(index);
                        }
                      }}
                    >
                      <span id={valueId}>{selectedLabel}</span>
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </ui.Button>
                  }
                />
              </div>
              {group.conflict === 'rename' ? (
                <label className="fm-field">
                  <span className="fm-upload-label">{t('uploadNewName')}</span>
                  <ui.Input
                    className="fm-input" value={group.renamed} placeholder={group.name} aria-label={`${t('rename')}: ${group.name}`}
                    data-fm-upload-name={index} disabled={busy}
                    onChange={(event: { target: { value: string } }) => onChange(index, { renamed: event.target.value })}
                  />
                </label>
              ) : null}
              {group.target ? <details><summary>{t('versions')}</summary><code>{group.target.version}</code></details> : null}
            </div>
          );
        })}
        {error ? <div role="alert">{errorText(error)}</div> : null}
      </div>
    </ui.Modal>
  );
}

export function DownloadDialog({ t, ui, downloadUrl, task, onClose }: DialogContext & {
  downloadUrl: string;
  task: PublicTransferView | null;
  onClose: () => void;
}): ReactNode {
  if (!task) return null;
  return (
    <ui.Modal
      contentClassName="dsh-fm-dialog"
      open
      onClose={onClose}
      title={t('downloadTitle')}
      closeLabel={t('close')}
      description={t('downloadNote')}
      footer={dialogButton({ t, ui }, 'close', { onClick: onClose })}
    >
      <div className="fm-dialog-content">
        <p data-fm-download-note>{t('downloadNote')}</p>
        <a href={downloadUrl} download={task.downloadName ?? ''} data-fm-download>{t('downloadStart')}</a>
      </div>
    </ui.Modal>
  );
}

export function ReferenceDialog({ t, ui, busy, errorText, error, plan, sessionId, sessions, onCancel, onChange, onConfirm }: DialogContext & {
  error: unknown;
  plan: readonly ReferenceEntry[] | null;
  sessionId: string;
  sessions: readonly { id: string; displayTitle: string }[];
  onCancel: () => void;
  onChange: (sessionId: string) => void;
  onConfirm: () => void;
}): ReactNode {
  if (!plan) return null;
  return (
    <ui.Modal
      contentClassName="dsh-fm-dialog"
      open
      onClose={() => { if (!busy) onCancel(); }}
      title={t('referenceTitle')}
      closeLabel={t('close')}
      description={t('referenceDescription')}
      footer={<Actions>
        {dialogButton({ t, ui }, 'cancel', { disabled: busy, onClick: onCancel })}
        {dialogButton({ t, ui }, 'referenceConfirm', { variant: 'primary', disabled: busy || !sessionId, onClick: onConfirm, 'data-fm-action': 'reference-confirm' })}
      </Actions>}
    >
      <div className="fm-dialog-content">
        <label className="fm-field">
          {t('referenceSession')}
          <select value={sessionId} data-fm-reference-session disabled={busy} onChange={event => onChange(event.target.value)}>
            <option value="">{t('referenceSelect')}</option>
            {sessions.map(session => <option key={session.id} value={session.id}>{session.displayTitle}</option>)}
          </select>
        </label>
        <div style={{ maxHeight: '30vh', overflow: 'auto', overflowWrap: 'anywhere' }}>
          {/*
            The plan is an immutable snapshot of the Host's answers: it is replaced
            wholesale when the dialog opens and never reordered or extended, so the
            row's position is its stable identity. The mention cannot serve as the
            key — a Host answer may omit it or repeat it for two selected entries,
            and either would leave React without a usable identity.
          */}
          {plan.map((entry, index) => <div key={index}>{entry.mention}</div>)}
        </div>
        {error ? <div role="alert">{errorText(error)}</div> : null}
      </div>
    </ui.Modal>
  );
}

export function CloseDialog({ t, ui, write, document, onCancel, onDiscard, onSaveClose }: DialogContext & {
  write: boolean;
  document: { path: string; saving: boolean; missing: boolean } | null;
  onCancel: () => void;
  onDiscard: () => void;
  onSaveClose: () => void;
}): ReactNode {
  if (!document) return null;
  return (
    <ui.Modal
      contentClassName="dsh-fm-dialog"
      open
      onClose={() => { if (!document.saving) onCancel(); }}
      title={t('closeTitle')}
      closeLabel={t('close')}
      description={t('closeDescription')}
      footer={<Actions>
        {dialogButton({ t, ui }, 'cancel', { onClick: onCancel, disabled: document.saving, 'data-fm-action': 'close-cancel' })}
        {dialogButton({ t, ui }, 'discard', { onClick: onDiscard, disabled: document.saving, 'data-fm-action': 'close-discard' })}
        {dialogButton({ t, ui }, 'saveClose', { variant: 'primary', disabled: document.saving || document.missing || !write, onClick: onSaveClose, 'data-fm-action': 'close-save' })}
      </Actions>}
    >
      <p className="fm-dialog-content">{document.path}</p>
    </ui.Modal>
  );
}

export function ConflictDialog({ t, ui, document, onCancel, onRebase }: DialogContext & {
  document: { path: string; draft: string; external: { text: string } } | null;
  onCancel: () => void;
  onRebase: () => void;
}): ReactNode {
  if (!document) return null;
  return (
    <ui.Modal
      contentClassName="dsh-fm-dialog"
      open
      onClose={onCancel}
      title={t('conflictTitle')}
      closeLabel={t('close')}
      description={t('conflictDescription')}
      footer={<Actions>
        {dialogButton({ t, ui }, 'cancel', { onClick: onCancel })}
        {dialogButton({ t, ui }, 'rebase', { variant: 'primary', onClick: onRebase, 'data-fm-action': 'rebase' })}
      </Actions>}
    >
      <div className="fm-compare">
        <div><h3>{t('localDraft')}</h3><pre data-fm-conflict="draft">{document.draft}</pre></div>
        <div><h3>{t('diskVersion')}</h3><pre data-fm-conflict="disk">{document.external.text}</pre></div>
      </div>
    </ui.Modal>
  );
}
