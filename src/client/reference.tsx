/**
 * The composer bridge that appends file references to an existing session draft.
 *
 * Claiming the request is a compare-and-set on the root-owned activity store, so
 * a second render, a StrictMode replay or a late completion can never insert the
 * same mention twice; a cancelled request is gone and cannot be revived.
 */

import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { ActivityStore } from './activity.js';
import type { Translate } from './i18n.js';
import type { UiPrimitives } from './ui.js';

export interface ReferenceRecord {
  readonly id: string;
  readonly status: string;
  readonly updatedAt: number;
  readonly sessionId: string;
  readonly mentions: readonly string[];
  readonly error?: string | null;
}

export interface ReferenceInput {
  readonly draft: string;
  readonly draftRev: number;
  readonly phase: string;
  readonly occurrences: readonly { length: number }[];
}

export interface ReferenceSession {
  readonly removed: boolean;
  readonly openState: string;
}

/** The composer scope a reference is inserted into, as the Host exposes it. */
export interface ReferenceScope {
  bail(event: string, payload: unknown): unknown;
}

export interface ReferenceRuntime {
  readonly controller: { readonly signal: AbortSignal };
  readonly referenceScope?: ((sessionId: string) => ReferenceScope | null) | null | undefined;
}

export interface ReferenceBridgeProps {
  readonly t: Translate;
  readonly sessionId: string;
  /** Supplied by the Host composer slot; the fallback keeps the hook order fixed. */
  readonly useInput?: ((selector: (value: ReferenceInput) => ReferenceInput) => ReferenceInput) | undefined;
  readonly useSession?: ((selector: (value: ReferenceSession) => ReferenceSession) => ReferenceSession) | undefined;
  readonly activity: ActivityStore<ReferenceRecord>;
  readonly runtime: ReferenceRuntime;
  readonly ui: UiPrimitives;
}

const EMPTY_INPUT: ReferenceInput = Object.freeze({ draft: '', draftRev: 0, phase: 'plain', occurrences: Object.freeze([]) });
const EMPTY_SESSION: ReferenceSession = Object.freeze({ removed: false, openState: 'closed' });
const subscribeNothing = (): (() => void) => () => {};

function useNoInput(selector: (value: ReferenceInput) => ReferenceInput): ReferenceInput {
  return selector(useSyncExternalStore(subscribeNothing, () => EMPTY_INPUT, () => EMPTY_INPUT));
}

function useNoSession(selector: (value: ReferenceSession) => ReferenceSession): ReferenceSession {
  return selector(useSyncExternalStore(subscribeNothing, () => EMPTY_SESSION, () => EMPTY_SESSION));
}

export function ReferenceBridge(props: ReferenceBridgeProps): ReactNode {
  const { t, sessionId, activity, runtime, ui } = props;
  const state = useSyncExternalStore(activity.subscribe, activity.getSnapshot, activity.getSnapshot);
  const input = (props.useInput ?? useNoInput)(value => value);
  const session = (props.useSession ?? useNoSession)(value => value);
  const requests = state.references.filter(request => request.sessionId === sessionId);

  useEffect(() => {
    const current = activity.getSnapshot().references.filter(request => request.sessionId === sessionId);
    if (current.some(request => request.status === 'inserting')) return;
    const request = current.find(item => item.status === 'pending');
    if (!request || runtime.controller.signal.aborted) return;
    const blocked = (error: string): void => { activity.put('references', { ...request, status: 'blocked', error, updatedAt: Date.now() }); };
    if (session.removed || session.openState === 'error') { blocked('referenceTargetUnavailable'); return; }
    if (session.openState !== 'open') return;
    if (input.phase !== 'plain') { blocked('referenceBusy'); return; }
    const context = runtime.referenceScope?.(sessionId);
    if (!context) { blocked('referenceTargetUnavailable'); return; }
    const end = input.draft.length - input.occurrences.reduce((length, occurrence) => length + occurrence.length - 1, 0);
    if (!Number.isSafeInteger(end) || end < 0 || !Number.isSafeInteger(input.draftRev)) { blocked('referenceStale'); return; }
    // Claim in the root store before invoking the business event: StrictMode,
    // another bridge render and a promise completion cannot replay this id.
    if (!activity.claim('references', request.id, 'pending', 'inserting')) return;
    const finish = (accepted: unknown): void => {
      const latest = activity.getSnapshot().references.find(value => value.id === request.id);
      if (latest?.status !== 'inserting') return;
      if (accepted === true) activity.remove('references', request.id);
      else blocked('referenceStale');
    };
    try {
      const result = context.bail('slash/input-insert-text', {
        text: `${input.draft && !/\s$/.test(input.draft) ? ' ' : ''}${request.mentions.join(' ')} `,
        span: { start: end, end, draftRev: input.draftRev }, continue: false,
      });
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void (result as PromiseLike<unknown>).then(finish, () => finish(false));
      } else finish(result);
    } catch { finish(false); }
  }, [state.references, input, session.openState, session.removed, sessionId]);

  if (!requests.length) return null;
  return (
    <div style={{ padding: 10, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)', fontSize: 12 }}>
      {requests.map(request => (
        <div key={request.id} role="status" data-fm-reference-status={request.status}>
          <span>{t(request.error || 'referenceWaiting')}</span>
          <div style={{ overflowWrap: 'anywhere', maxHeight: 100, overflow: 'auto' }}>{request.mentions.join(' ')}</div>
          {request.status === 'blocked' ? (
            <ui.Button
              variant="primary" size="sm" type="button"
              disabled={session.removed || session.openState !== 'open' || input.phase !== 'plain'}
              onClick={() => activity.put('references', { ...request, status: 'pending', error: null, updatedAt: Date.now() })}
              data-fm-reference-action="retry"
            >{t('referenceRetry')}</ui.Button>
          ) : null}
          <ui.Button
            variant="ghost" size="sm" type="button" disabled={request.status === 'inserting'}
            onClick={() => activity.remove('references', request.id)}
            data-fm-reference-action="cancel"
          >{t('cancel')}</ui.Button>
        </div>
      ))}
    </div>
  );
}
