import type { ReactNode } from 'react';
import type { Translate } from './i18n.js';
import type { UiPrimitives } from './ui.js';

/** Dismisses presentation only; callers retain operation and safety state. */
export function Notice({ t, ui, id, onDismiss, children, error = false }: {
  t: Translate; ui: UiPrimitives; id: string; onDismiss(): void; children: ReactNode; error?: boolean;
}): ReactNode {
  return (
    <div className={`${error ? 'fm-error' : 'fm-notice'} fm-dismissible-notice`} role={error ? 'alert' : 'status'}>
      <div className="fm-notice-content">{children}</div>
      <ui.Button variant="ghost" size="sm" type="button" className="fm-notice-close"
        aria-label={t('dismissNotice')} title={t('dismissNotice')} onClick={onDismiss} data-fm-notice-dismiss={id}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </ui.Button>
    </div>
  );
}
