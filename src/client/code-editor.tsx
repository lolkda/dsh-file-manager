/**
 * The file editor: one CodeMirror view that previews and edits the same text.
 *
 * It is a display component. The file manager's document store stays the only
 * authority for drafts, versions and conflicts, so this component holds no
 * document state of its own:
 *
 *  - `value` is the normalized draft the owner wants rendered, and it is
 *    authoritative. Re-supplying the identical text never rebuilds the view or
 *    moves the caret, and an edit the user makes is reported through `onChange`
 *    once — the render that follows must not dispatch again.
 *  - A different `documentId` is a different document: the view is rebuilt so an
 *    undo stack can never reach across files.
 *  - Everything else — mode, grammar, budget — is a *configuration* change on the
 *    live view, so switching preview/edit or crossing the highlight budget keeps
 *    the text, the selection and the history.
 *
 * Two independent degradations exist, and they are not the same thing:
 *
 *  - **Budget.** A document over 1 MiB of UTF-8, or with a line over 20 000
 *    UTF-16 units, keeps the editor and loses only the grammar. The text stays
 *    complete and editable, and the reason is shown.
 *  - **Failure.** A missing DOM capability, a broken grammar or a crashing
 *    plugin falls back to a native control so the draft is still readable and
 *    editable. The view is destroyed rather than left half-built.
 *
 * A container React never attached (a renderer without a host node) is neither:
 * the ref is simply null, no view is created, and no failure is reported.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { EditorState, Annotation, Compartment, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import type { LanguageSupport } from '@codemirror/language';
import type { Translate } from './i18n.js';
import {
  LANGUAGE_DISPLAY_NAMES, classifyHighlightBudget, createHighlightExtension,
  dialectFor, languageExtensionFor, languageIdFor, type HighlightState,
} from './code-languages.js';

// The editor namespace carries the highlight budget too, so the panel and the
// acceptance suites can ask the same questions this component answers internally
// instead of re-deriving them.
export { HIGHLIGHT_MAX_BYTES, HIGHLIGHT_MAX_LINE_UNITS, classifyHighlightBudget } from './code-languages.js';

/** The one empty extension, shared so "no grammar" keeps a stable identity. */
const NO_GRAMMAR: Extension = [];

/**
 * The grammar extension to install for a document.
 *
 * A document over the highlight budget keeps the editor and loses only the
 * grammar, so this is the single place that decides it: installing the grammar
 * and merely *labelling* the state as limited would leave the text highlighted.
 *
 * @param support - The language support for the hint, when the hint has one.
 * @param value - The draft about to be rendered.
 * @returns The extension, or the shared empty extension.
 */
function highlightGrammar(support: LanguageSupport | null, value: string): Extension {
  if (support === null) return NO_GRAMMAR;
  return classifyHighlightBudget(value) === 'active' ? support.extension : NO_GRAMMAR;
}

export interface CodeEditorProps {
  /** Identity of the open document; a new value rebuilds the view. */
  readonly documentId: string;
  /** The file path, used for the accessible name and JS/TS dialect selection. */
  readonly path: string;
  /** The normalized draft to render. Authoritative. */
  readonly value: string;
  readonly mode: 'preview' | 'edit';
  readonly canWrite: boolean;
  /** The grammar hint the host derived from the filename, if it could. */
  readonly languageHint: string | undefined;
  readonly ariaLabel: string;
  readonly t: Translate;
  /** Reports a user edit. Never called for a programmatic synchronisation. */
  readonly onChange: (text: string) => void;
  /** Reports Ctrl/Cmd-S from an editable surface. */
  readonly onSave: () => void;
}

/** Marks a transaction this component dispatched itself, so it is not an edit. */
const externalSync = Annotation.define<boolean>();

/**
 * The editor theme, built once on first use.
 *
 * Lazy because the extension is only meaningful with a real view, and because
 * the shipped bundle is also evaluated in environments that never mount one.
 * Colours are host tokens only, so light/dark switching stays the theme
 * package's business.
 */
let theme: Extension | null = null;
function editorTheme(): Extension {
  theme ??= EditorView.theme({
    '&': {
      height: '100%',
      backgroundColor: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
    },
    // The panel's own editor surface draws one focus ring inside the box; the
    // base theme's dotted outline would be a second, literal-coloured one.
    '&.cm-focused': {
      outline: '2px solid var(--dsw-alias-brand-primary)',
      outlineOffset: '-2px',
    },
    '.cm-scroller': {
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
      fontSize: '12px',
      lineHeight: '1.7',
      overflow: 'auto',
    },
    '.cm-content': { padding: '16px', tabSize: '2', caretColor: 'var(--dsw-alias-label-primary)' },
    '.cm-line': { padding: '0' },
    '.cm-cursor': { borderLeftColor: 'var(--dsw-alias-label-primary)' },
    '.cm-selectionBackground': { backgroundColor: 'var(--dsw-alias-interactive-bg-hover)' },
  });
  return theme;
}

/** The message shown for a state that needs explaining, or null when none does. */
function noteMessage(state: HighlightState, t: Translate): string | null {
  if (state === 'plain') return t('code.language.plaintext');
  if (state === 'limited') return t('code.highlightLimited');
  if (state === 'error') return t('code.highlightUnavailable');
  return null;
}

export function CodeEditor(props: CodeEditorProps): ReactNode {
  const { mode, canWrite, value, ariaLabel, t } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** Latest props, readable from CodeMirror callbacks that outlive a render. */
  const propsRef = useRef(props);
  propsRef.current = props;
  /** The draft a composition deferred; applied once the composition ends. */
  const pendingRef = useRef<string | null>(null);
  const composingRef = useRef(false);
  /** The draft the owner was last told about, so the same text is never reported twice. */
  const reportedRef = useRef<string | null>(null);
  /** Set while this component is applying an incoming value itself. */
  const applyingRef = useRef<'incoming' | null>(null);
  /**
   * Text the fallback must show instead of `value`.
   *
   * Null means "use the incoming prop", which is the truth in the failures that
   * never committed anything: the prop is the draft the component failed to
   * apply, and it is also all there is when no view was ever created.
   */
  const salvagedRef = useRef<string | null>(null);
  /**
   * The incoming draft that was on screen when {@link salvagedRef} was taken.
   *
   * The salvage only bridges the window in which the owner's prop has not caught
   * up with the view. Any later prop — the owner re-supplying a draft, or the user
   * typing into the fallback — makes this stale, and the prop takes over again.
   */
  const salvagedForPropRef = useRef<string | null>(null);
  /** The document the refs above currently belong to. */
  const ownerRef = useRef<string | null>(null);
  const [compositionTick, setCompositionTick] = useState(0);
  /** The document that failed, so another document starts clean. */
  const [failedDocument, setFailedDocument] = useState<string | null>(null);
  const [compartments] = useState(() => ({
    language: new Compartment(),
    editable: new Compartment(),
    readOnly: new Compartment(),
    attributes: new Compartment(),
  }));

  const failed = failedDocument !== null && failedDocument === props.documentId;
  const languageId = languageIdFor(props.languageHint);
  const dialect = dialectFor(props.languageHint, props.path);
  const state: HighlightState = failed
    ? 'error'
    : dialect === null
      ? 'plain'
      : classifyHighlightBudget(props.value);
  // Stable identity while the decision is unchanged, so a keystroke that does
  // not cross the budget reconfigures nothing.
  const support = dialect === null ? null : languageExtensionFor(props.languageHint, props.path);
  const grammar = highlightGrammar(support, props.value);
  const editable = mode === 'edit' && canWrite;
  const readOnly = mode !== 'edit' || !canWrite;
  const note = noteMessage(state, t);
  // A language label only where there is a language to name; in the plain state
  // the note already says the document has no grammar, and repeating it would
  // show the same sentence twice.
  const label = dialect === null ? null : t('code.language', { language: LANGUAGE_DISPLAY_NAMES[languageId] ?? languageId });

  /**
   * Degrades the document that owns `failedView` to the readable fallback.
   *
   * The cause decides which draft survives, because the two kinds of failure
   * leave different drafts standing:
   *
   *  - `incoming`: the component failed to apply the owner's new draft, so that
   *    draft is still the target and the prop is what the fallback shows.
   *  - `transaction`: a transaction the component did not initiate failed, so
   *    nothing was committed and the newest text is the one the view still holds
   *    — which may be *ahead* of the prop, because React has not rendered the
   *    owner's update yet.
   *  - `capability` / `construction`: there is no view to salvage anything from,
   *    so the incoming prop is the only draft there is.
   *
   * A failure belongs to the *view instance* that produced it, not to a document
   * id: `A → B → A` makes the id equal again, so an id check alone would let a
   * failure from the superseded A view mark the new one. `null` means the failure
   * happened before any view existed, during this very mount.
   *
   * @param cause - Where the failure came from.
   * @param failedView - The view that failed, or null before one existed.
   */
  function degrade(cause: 'capability' | 'construction' | 'incoming' | 'transaction', failedView: EditorView | null): void {
    if (failedView !== null && viewRef.current !== failedView) return;
    const current = propsRef.current;
    if (cause === 'transaction') {
      const committed = failedView === null ? current.value : failedView.state.doc.toString();
      salvagedRef.current = committed;
      salvagedForPropRef.current = current.value;
      // Reporting is an edit event, so it is only ever right for a surface the
      // user can type into, and only when the owner has not already been told
      // this draft: degrading must never manufacture an edit of its own.
      if (current.mode === 'edit' && current.canWrite
        && committed !== current.value && committed !== reportedRef.current) {
        reportedRef.current = committed;
        current.onChange(committed);
      }
    } else {
      salvagedRef.current = null;
      salvagedForPropRef.current = null;
    }
    setFailedDocument(current.documentId);
  }

  // Mount, and rebuild on a document change. A null host means "not attached":
  // react-test-renderer and any renderer without host nodes leave the ref null,
  // and that is not a failure to report.
  useEffect(() => {
    const host = hostRef.current;
    const owner = propsRef.current.documentId;
    if (ownerRef.current !== owner) {
      // A different document means a different view, and a view that has just been
      // created has failed at nothing: the previous document's failure is dropped
      // here, which is what lets `A → healthy B → A` start over with a new view
      // instead of inheriting a verdict. The same reset covers a deferred draft and
      // an unfinished composition, which would otherwise defer every
      // synchronisation of the new document forever.
      ownerRef.current = owner;
      composingRef.current = false;
      pendingRef.current = null;
      salvagedRef.current = null;
      salvagedForPropRef.current = null;
      setFailedDocument(null);
    }
    if (host === null || failed) return undefined;
    const viewWindow = host.ownerDocument?.defaultView;
    // Preflight the capabilities the view needs on construction. Failing here
    // means CodeMirror never touches the DOM, so there is no half-built view,
    // observer or listener to clean up.
    if (!viewWindow || typeof viewWindow.requestAnimationFrame !== 'function' || typeof viewWindow.cancelAnimationFrame !== 'function') {
      degrade('capability', null);
      return undefined;
    }
    const initialSupport = languageExtensionFor(propsRef.current.languageHint, propsRef.current.path);
    const initialGrammar = highlightGrammar(initialSupport, propsRef.current.value);
    // A grammar is only consulted when it is actually installed: a broken parser
    // must not degrade a document that was never going to be highlighted.
    if (initialGrammar !== NO_GRAMMAR) {
      try {
        initialSupport?.language.parser.parse('');
      } catch {
        // A grammar that cannot parse at all is unusable; treat it like a
        // missing capability rather than letting it crash the first edit.
        degrade('capability', null);
        return undefined;
      }
    }
    // Per view, never per component: the same component serves several documents
    // in a row, and a component-wide flag would be reset by the next mount, which
    // would let a superseded view's handlers report into the current document
    // again. Each mount closes over its own object and the cleanup closes only it.
    const alive = { current: true };

    let view: EditorView;
    try {
      view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: propsRef.current.value,
          extensions: [
            compartments.language.of(initialGrammar),
            compartments.editable.of(EditorView.editable.of(editable)),
            compartments.readOnly.of(EditorState.readOnly.of(readOnly)),
            compartments.attributes.of(surfaceAttributes(propsRef.current.ariaLabel)),
            // The stylesheet renders tabs two columns wide, so the state has to
            // agree; changing only the CSS would leave tabs at the default four.
            EditorState.tabSize.of(2),
            createHighlightExtension(),
            history(),
            keymap.of([saveKeyBinding(() => propsRef.current, alive), ...defaultKeymap, ...historyKeymap]),
            EditorView.updateListener.of(update => {
              if (!alive.current) return;
              if (!update.docChanged) return;
              const current = propsRef.current;
              // Only an editable surface can report an edit: a preview or a Host
              // without the write capability cannot have produced one.
              if (current.mode !== 'edit' || !current.canWrite) return;
              if (update.transactions.some(transaction => transaction.annotation(externalSync) === true)) return;
              const text = update.state.doc.toString();
              reportedRef.current = text;
              current.onChange(text);
            }),
            // Covers crashes raised from view and plugin code once the view is
            // live; a failed dispatch is caught by the guard below instead.
            EditorView.exceptionSink.of(() => { degrade('transaction', view); }),
            editorTheme(),
          ],
        }),
      });
    } catch {
      destroyPartialView(host);
      degrade('construction', null);
      return undefined;
    }
    viewRef.current = view;
    guardDispatch(view, () => { degrade(applyingRef.current === 'incoming' ? 'incoming' : 'transaction', view); });
    return () => {
      // Closed before the view goes away, so a handler the old view left behind
      // cannot reach the owner through this component any more.
      alive.current = false;
      viewRef.current = null;
      composingRef.current = false;
      pendingRef.current = null;
      // A view that already crashed may refuse to tear itself down; the DOM is
      // released by React either way, and swallowing the second failure would
      // otherwise mask it as a render error.
      try {
        view.destroy();
      } catch {
        destroyPartialView(host);
      }
    };
    // `propsRef` deliberately keeps the initial configuration out of the deps:
    // later changes reconfigure the live view instead of rebuilding it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.documentId, failed, compartments]);

  // Grammar, mode, editability and the accessible name are configuration, not
  // identity: reconfiguring keeps the text, the selection and the undo history,
  // and the accessible name follows a rename or a locale change instead of
  // sticking to whatever it was at mount.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    try {
      view.dispatch({
        effects: [
          compartments.language.reconfigure(grammar),
          compartments.editable.reconfigure(EditorView.editable.of(editable)),
          compartments.readOnly.reconfigure(EditorState.readOnly.of(readOnly)),
          compartments.attributes.reconfigure(surfaceAttributes(ariaLabel)),
        ],
      });
    } catch {
      degrade('transaction', view);
    }
    // `grammar` has a stable identity while the decision is unchanged, so typing
    // inside the budget dispatches nothing.
  }, [ariaLabel, compartments, editable, grammar, readOnly, state]);

  // The draft is authoritative, but a re-supplied identical value is not a change
  // and must not disturb the caret or the history. A composition in progress is
  // never overwritten; it is applied once the composition ends.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    if (composingRef.current || view.composing) {
      pendingRef.current = value;
      return;
    }
    pendingRef.current = null;
    if (view.state.doc.toString() === value) return;
    // Marked as this component's own dispatch, so a failure here keeps the
    // incoming draft rather than the text the view still holds.
    applyingRef.current = 'incoming';
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: [externalSync.of(true)],
      });
    } catch {
      degrade('incoming', view);
    } finally {
      applyingRef.current = null;
    }
  }, [compositionTick, props.documentId, value]);

  // Track compositions on the component's own node: CodeMirror's flag is not the
  // only signal, and the deferred draft has to be applied when composition ends.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;
    const start = (): void => { composingRef.current = true; };
    const end = (): void => {
      composingRef.current = false;
      setCompositionTick(tick => tick + 1);
    };
    host.addEventListener('compositionstart', start, true);
    host.addEventListener('compositionend', end, true);
    return () => {
      host.removeEventListener('compositionstart', start, true);
      host.removeEventListener('compositionend', end, true);
    };
  }, [failed, props.documentId]);

  // The salvage only stands in for the owner's draft while the prop has not caught
  // up with the view that produced it. Any later prop — the owner re-supplying a
  // draft, or the user typing into the fallback — takes over again, so a failure
  // can never mask text that came after it.
  const fallbackValue = salvagedRef.current !== null && salvagedForPropRef.current === value
    ? salvagedRef.current
    : value;

  return (
    <div
      className="fm-code"
      data-fm-code
      data-fm-code-mode={mode}
      data-fm-code-language={languageId}
      data-fm-code-highlight={state}
    >
      {label === null ? null : <span className="fm-code-language">{label}</span>}
      {note === null ? null : <span className="fm-code-note" data-fm-code-note={state}>{note}</span>}
      {/* The fallback owns the whole editor area: a mount point left in place
          would keep claiming `flex: 1` as an empty box and squeeze the control
          the user actually has to type into. */}
      {state === 'error' ? null : <div className="fm-code-mount" ref={hostRef} />}
      {state !== 'error' ? null : mode === 'edit'
        ? (
          <textarea
            className="fm-editor" data-fm-code-fallback="edit" value={fallbackValue} readOnly={!canWrite}
            spellCheck={false} aria-label={ariaLabel}
            onChange={event => {
              // The fallback stands in for the same surface as the editor, so it
              // reports on the same condition: without the write capability there
              // is no edit to report.
              if (!canWrite) return;
              reportedRef.current = event.target.value;
              props.onChange(event.target.value);
            }}
            onKeyDown={event => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                event.preventDefault();
                if (canWrite) props.onSave();
              }
            }}
          />
        )
        : <pre data-fm-code-fallback="preview">{fallbackValue}</pre>}
    </div>
  );
}

/**
 * The save shortcut for the live editor.
 *
 * Reads through `getProps` rather than the render that installed the binding,
 * because the binding outlives that render. A preview consumes the key without
 * reporting a save, so the browser's own save dialog never appears either.
 *
 * `alive` belongs to the view this binding was installed into. A document switch
 * closes the old view, and the binding that outlives it must not reach the owner:
 * a component-wide flag would be reset by the next mount and let this one through.
 *
 * @param getProps - Reads the current props.
 * @param alive - The liveness flag of the view that owns this binding.
 * @returns The key binding to install in the editor keymap.
 */
function saveKeyBinding(
  getProps: () => CodeEditorProps,
  alive: { current: boolean },
): { key: string; preventDefault: boolean; run: () => boolean } {
  return {
    key: 'Mod-s',
    preventDefault: true,
    run: () => {
      // `false` says this handler is gone rather than "not handled yet".
      if (!alive.current) return false;
      const current = getProps();
      if (current.mode === 'edit' && current.canWrite) current.onSave();
      return true;
    },
  };
}

/**
 * The attributes the editing surface carries.
 *
 * CodeMirror only sets `contenteditable="false"` for a non-editable view, which
 * leaves a preview unreachable from the keyboard: it is not focusable, so it
 * cannot be read into, scrolled or selected with the keyboard, and the accessible
 * name on it can never be announced. A declared `tabindex` makes it a normal tab
 * stop without intercepting the Tab key. Whether a real browser then tabs into it
 * has not been verified here — this environment has no browser, and jsdom's
 * `focus()` succeeds on any element, so it cannot tell the two apart.
 *
 * @param ariaLabel - The accessible name for the surface.
 * @returns The content-attribute extension, shared by the mount and reconfigure paths.
 */
function surfaceAttributes(ariaLabel: string): Extension {
  return EditorView.contentAttributes.of({ 'aria-label': ariaLabel, tabindex: '0' });
}

/**
 * Guard every dispatch entry point on the view this component owns.
 *
 * A grammar that throws raises out of `EditorState.update`, and that throw is
 * synchronous: CodeMirror's `exceptionSink` only sees failures raised by the
 * plugin and view machinery it wraps itself, so a parser crash would otherwise
 * escape into the page. CodeMirror's own input handling dispatches through the
 * same instance method, which makes this the one boundary that covers typing as
 * well as the component's own updates. Degrading here keeps the draft and turns
 * the crash into a readable fallback instead of an unhandled exception.
 *
 * @param view - The view this component created and therefore owns.
 * @param onFailure - Called when a dispatch throws.
 */
function guardDispatch(view: EditorView, onFailure: () => void): void {
  const original = view.dispatch.bind(view);
  const guarded = (...specs: Parameters<typeof original>): void => {
    try {
      original(...specs);
    } catch {
      onFailure();
    }
  };
  // `dispatch` is overloaded (one transaction, an array, or a list of specs) and
  // one runtime wrapper covers all three shapes, so it is installed with one
  // cast instead of three overload stubs that would each have to forward.
  view.dispatch = guarded as unknown as EditorView['dispatch'];
}

/**
 * Best-effort cleanup after a failed construction.
 *
 * CodeMirror can fail after it has already appended its DOM and registered a
 * document observer, and the throw means the caller never receives the instance
 * to destroy. `findFromDOM` resolves a view that got as far as its content node,
 * so it is destroyed when reachable; whatever remains is removed from the host.
 */
function destroyPartialView(host: HTMLElement): void {
  try {
    EditorView.findFromDOM(host)?.destroy();
  } catch {
    // A view too incomplete to destroy is handled by removing its DOM below.
  }
  host.replaceChildren();
}
