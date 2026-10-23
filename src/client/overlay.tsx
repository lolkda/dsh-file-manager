import { useEffect, useRef, type ReactNode } from 'react';

export interface OverlayProps {
  readonly name: string;
  readonly title: string;
  readonly open: boolean;
  readonly suspended?: boolean;
  readonly drawer?: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

const overlayLayers = new WeakMap<Document, HTMLElement[]>();
const focusSelector = 'button,input,select,textarea,a[href],summary,[tabindex],[contenteditable="true"]';

function available(element: HTMLElement): boolean {
  if (element.matches(':disabled,input[type="hidden"]') || element.closest('[hidden],[inert]')) return false;
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    const style = parent.ownerDocument.defaultView?.getComputedStyle(parent);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
    if (parent.tagName === 'DETAILS' && !parent.hasAttribute('open')) {
      const summary = parent.querySelector(':scope > summary');
      if (!summary?.contains(element)) return false;
    }
  }
  return true;
}

function focusable(element: HTMLElement): HTMLElement[] {
  return Array.from(element.querySelectorAll<HTMLElement>(focusSelector))
    .filter(item => item.tabIndex >= 0 && available(item));
}

function observeComposition(element: HTMLElement): { guards: (event: KeyboardEvent) => boolean; dispose: () => void } {
  let composing = false;
  let ended = false;
  const start = (): void => { composing = true; ended = false; };
  const end = (): void => { composing = false; ended = true; };
  const release = (): void => { ended = false; };
  element.addEventListener('compositionstart', start, true);
  element.addEventListener('compositionend', end, true);
  element.addEventListener('keyup', release, true);
  return {
    guards(event) {
      const guarded = composing || ended || event.isComposing || event.keyCode === 229;
      ended = false;
      return guarded;
    },
    dispose() {
      element.removeEventListener('compositionstart', start, true);
      element.removeEventListener('compositionend', end, true);
      element.removeEventListener('keyup', release, true);
    },
  };
}

/** Keeps content mounted: hiding a viewer must not destroy editor undo history. */
export function Overlay({ name, title, open, suspended = false, drawer = false, onClose, children }: OverlayProps): ReactNode {
  const card = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;

  useEffect(() => {
    const element = card.current;
    if (!open || !element) return;
    const doc = element.ownerDocument;
    const previous = doc.activeElement as HTMLElement | null;
    const layers = overlayLayers.get(doc) ?? [];
    overlayLayers.set(doc, layers);
    layers.push(element);
    const composition = observeComposition(element);
    if (!suspendedRef.current && !element.contains(doc.activeElement)) {
      (focusable(element)[0] ?? element).focus({ preventScroll: true });
    }
    const keydown = (event: KeyboardEvent): void => {
      const composing = composition.guards(event);
      if (suspendedRef.current || layers.at(-1) !== element || event.defaultPrevented || composing
        || event.ctrlKey || event.altKey || event.metaKey) return;
      const target = event.target as Element | null;
      // A portaled or nested child dialog/menu owns its keys, not the viewer behind it.
      if (!target || !element.contains(target) || target.closest('[role="dialog"],[role="menu"]') !== element) return;
      if (event.key === 'Escape' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) close.current();
      } else if (event.key === 'Tab') {
        const items = focusable(element);
        const first = items[0] ?? element;
        const last = items.at(-1) ?? element;
        if (doc.activeElement === element || !element.contains(doc.activeElement)
          || (event.shiftKey ? doc.activeElement === first : doc.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus({ preventScroll: true });
        }
      }
    };
    // React's delegated child handlers run at the root before this document listener.
    doc.addEventListener('keydown', keydown);
    return () => {
      composition.dispose();
      doc.removeEventListener('keydown', keydown);
      const wasTop = layers.at(-1) === element;
      layers.splice(layers.indexOf(element), 1);
      if (layers.length === 0) overlayLayers.delete(doc);
      if (wasTop && !suspendedRef.current && previous?.isConnected && available(previous)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [open]);

  return (
    <div className={`fm-overlay${drawer ? ' fm-overlay-drawer' : ''}`}
      hidden={!open} data-fm-overlay={name} data-fm-overlay-open={open}>
      <div className="fm-overlay-mask" aria-hidden="true" onClick={() => {
        const element = card.current;
        if (!suspendedRef.current && element && overlayLayers.get(element.ownerDocument)?.at(-1) === element) close.current();
      }} />
      <div ref={card} className="fm-overlay-card" role="dialog" aria-modal={open && !suspended ? true : undefined}
        aria-label={title} tabIndex={-1} data-shortcut-modal="other" {...(suspended ? { inert: '' } : {})}>
        {children}
      </div>
    </div>
  );
}

/** Native disclosure preserves ordinary button semantics and touch discoverability. */
export function ActionGroup({ label, name, children }: { label: string; name: string; children: ReactNode }): ReactNode {
  const root = useRef<HTMLDetailsElement>(null);
  const composition = useRef<ReturnType<typeof observeComposition> | null>(null);
  const closeSiblings = (element: HTMLDetailsElement): void => {
    for (const sibling of element.parentElement?.children ?? []) {
      if (sibling !== element && sibling.matches('details[data-fm-action-group]')) {
        (sibling as HTMLDetailsElement).open = false;
      }
    }
  };
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const doc = element.ownerDocument;
    composition.current = observeComposition(element);
    const outside = (event: PointerEvent): void => {
      if (element.open && !event.composedPath().includes(element)) element.open = false;
    };
    doc.addEventListener('pointerdown', outside);
    return () => {
      composition.current?.dispose();
      composition.current = null;
      doc.removeEventListener('pointerdown', outside);
    };
  }, []);
  return (
    <details ref={root} className="fm-action-group" data-fm-action-group={name}
      onToggle={event => { if (event.currentTarget.open) closeSiblings(event.currentTarget); }}
      onKeyDown={event => {
        const composing = composition.current?.guards(event.nativeEvent);
        if (!composing && !event.defaultPrevented && !event.ctrlKey && !event.altKey && !event.metaKey
          && event.key === 'Escape' && !event.shiftKey && event.currentTarget.open) {
          event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false;
          event.currentTarget.querySelector('summary')?.focus({ preventScroll: true });
        }
      }}
      onClick={event => {
        const element = event.currentTarget;
        const target = event.target as Element;
        if (target.closest('details') !== element) return;
        if (target.closest('summary') && !element.open) closeSiblings(element);
        const button = target.closest('button');
        if (button && !button.matches(':disabled')) {
          element.open = false;
          // Return a now-hidden action's focus, but never replace focus chosen by the action.
          if (button.contains(element.ownerDocument.activeElement)) element.querySelector('summary')?.focus({ preventScroll: true });
        }
      }}>
      <summary>{label}<svg className="fm-action-chevron" width={14} height={14} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      </svg></summary>
      <div className="fm-action-popover">{children}</div>
    </details>
  );
}
