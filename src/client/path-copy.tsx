/**
 * Copying a *path* to the browser clipboard.
 *
 * The write starts inside the click's user activation, so the text goes through
 * the caller's `writeClipboard` before any other async work. The outcome is
 * reported to the plugin-level notifier instead of a local banner: the notice
 * that used to sit above the file list is gone, and the notification store
 * outlives the panel, so a copy that finishes after unmount is still reported
 * (without touching React state of an unmounted component).
 */

import { useEffect, useRef, useState } from 'react';
import type { ClipboardWriter } from './ui.js';
import type { Translate } from './i18n.js';
import type { NotificationInput } from './notifications.js';

/** Host roots and entry paths are already canonical; never resolve link targets. */
export function absoluteEntryPath(rootPath: string, entryPath: string): string {
  const prefix = rootPath.replace(/\/+$/, '');
  return entryPath ? `${prefix}/${entryPath}` : prefix || '/';
}

export type CopyOutcome = { readonly status: 'copied'; readonly count: number; readonly text: string }
  | { readonly status: 'failed'; readonly count: number; readonly text: string };

/** Stable diagnostic code for a failed path copy, searchable the same way on every surface. */
export const PATH_COPY_FAILED_CODE = 'PATH_COPY_FAILED';

/**
 * The notification for one copy attempt. A failure keeps the exact text so the
 * user can copy it by hand: it is never truncated to fit a display limit.
 */
export function pathCopyNotification(t: Translate, outcome: CopyOutcome): NotificationInput {
  if (outcome.status === 'copied') {
    return {
      level: 'success',
      title: t(outcome.count === 1 ? 'pathCopied' : 'pathsCopied', { count: outcome.count }),
    };
  }
  return {
    level: 'error',
    title: t('pathCopyFailed'),
    action: { kind: 'manual-copy', text: outcome.text },
    code: PATH_COPY_FAILED_CODE,
  };
}

/** Browser text clipboard only: independent of the file-task clipboard and API. */
export function usePathCopy(writeClipboard?: ClipboardWriter, report?: (outcome: CopyOutcome) => void): {
  readonly pending: boolean;
  copy(paths: readonly string[]): Promise<void>;
} {
  const [pending, setPending] = useState(false);
  const alive = useRef(false);
  const attempt = useRef<symbol | null>(null);
  useEffect(() => {
    alive.current = true;
    // The in-flight attempt is intentionally not cancelled here: the store is
    // plugin-owned, and a copy that lands after unmount must still be reported.
    return () => { alive.current = false; };
  }, []);

  const copy = async (paths: readonly string[]): Promise<void> => {
    if (!alive.current || attempt.current || paths.length === 0) return;
    const ticket = Symbol();
    attempt.current = ticket;
    // The exact requested text travels with the outcome, so a failure can offer
    // the full manual copy (every path, in order, one per line).
    const text = paths.join('\n');
    setPending(true);
    try {
      // Start inside the click's user activation, before any other async work.
      // Missing APIs and synchronous failures use the same manual fallback.
      const accepted = writeClipboard ? await writeClipboard(text) : false;
      report?.({ status: accepted === true ? 'copied' : 'failed', count: paths.length, text });
    } catch {
      report?.({ status: 'failed', count: paths.length, text });
    } finally {
      if (alive.current && attempt.current === ticket) {
        attempt.current = null;
        setPending(false);
      }
    }
  };

  return { pending, copy };
}
