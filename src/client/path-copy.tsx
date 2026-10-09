import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Translate } from './i18n.js';
import { Notice } from './notice.js';
import type { UiPrimitives } from './ui.js';

/** Host roots and entry paths are already canonical; never resolve link targets. */
export function absoluteEntryPath(rootPath: string, entryPath: string): string {
  const prefix = rootPath.replace(/\/+$/, '');
  return entryPath ? `${prefix}/${entryPath}` : prefix || '/';
}

type CopyResult = { readonly status: 'copied'; readonly count: number }
  | { readonly status: 'failed'; readonly text: string };

/** Browser text clipboard only: independent of the file-task clipboard and API. */
export function usePathCopy(): {
  readonly pending: boolean;
  readonly result: CopyResult | null;
  copy(paths: readonly string[]): Promise<void>;
  dismiss(): void;
} {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<CopyResult | null>(null);
  const alive = useRef(false);
  const attempt = useRef<symbol | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; attempt.current = null; };
  }, []);

  const copy = async (paths: readonly string[]): Promise<void> => {
    if (!alive.current || attempt.current || paths.length === 0) return;
    const ticket = Symbol();
    attempt.current = ticket;
    const text = paths.join('\n');
    setResult(null);
    setPending(true);
    try {
      // Start inside the click's user activation, before any other async work.
      // Missing APIs and synchronous failures use the same manual fallback.
      await window.navigator.clipboard.writeText(text);
      if (alive.current && attempt.current === ticket) setResult({ status: 'copied', count: paths.length });
    } catch {
      if (alive.current && attempt.current === ticket) setResult({ status: 'failed', text });
    } finally {
      if (alive.current && attempt.current === ticket) {
        attempt.current = null;
        setPending(false);
      }
    }
  };

  return { pending, result, copy, dismiss: () => setResult(null) };
}

export function PathCopyNotice({ t, ui, result, dismiss }: {
  t: Translate; ui: UiPrimitives; result: CopyResult | null; dismiss(): void;
}): ReactNode {
  if (!result) return null;
  return (
    <Notice t={t} ui={ui} id="path-copy" error={result.status === 'failed'} onDismiss={dismiss}>
      <div data-fm-path-copy-result={result.status}>
        {result.status === 'copied'
          ? t(result.count === 1 ? 'pathCopied' : 'pathsCopied', { count: result.count })
          : <>
            <div>{t('pathCopyFailed')}</div>
            <textarea
              className="fm-path-copy-text" readOnly value={result.text} rows={Math.min(4, result.text.split('\n').length)}
              wrap="off" spellCheck={false} aria-label={t('pathCopyManual')} data-fm-path-copy-text
              onFocus={event => event.currentTarget.select()}
            />
          </>}
      </div>
    </Notice>
  );
}
