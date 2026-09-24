/**
 * Independent DOM acceptance harness for the code editor (task-5).
 *
 * The subject is always the shipped artifact `dist/client.js`, read the way the
 * browser module table reads it (`window.__ModuleLoader__`) and mounted with
 * jsdom + react-dom into a real element tree. Nothing here compiles `src/` or
 * fakes an editor: a missing editor export, a missing CodeMirror DOM or a view
 * that cannot be reached is a hard failure, never a skip.
 *
 * Three measured constraints this file encodes (verified against the pinned
 * @codemirror/view 6.43.13 and jsdom 26.1.0 before these tests were written):
 *
 *  1. The view is reached through CodeMirror's public `EditorView.findFromDOM`.
 *     `findFromDOM` internally does `dom.querySelector('.cm-content')` and then
 *     `Tile.get(content)`, and `Tile.get` is `return dom.cmTile` (measured in the
 *     installed @codemirror/view 6.43.13 dist at lines 1828-1830, with the
 *     `dom.cmTile = this` assignment at 1761/1787). It therefore reads a plain own
 *     property of the DOM node, and the `.root` getter it uses runs in the owning
 *     copy's own closure. Measured on a deliberately duplicated package copy: a
 *     view created by copy A is resolved by copy B's `findFromDOM` as well.
 *     Reading the `cmTile` back-pointer directly is therefore NOT needed, and the
 *     harness uses the public API instead; a cross-check against the back-pointer
 *     keeps that claim honest for the bundle's inlined copy once it exists.
 *  2. CodeMirror renders only the viewport, so the DOM holds a small slice of a
 *     large document (measured: 5000 lines -> 36 `.cm-line` nodes). Document text
 *     is therefore read from the real view state, never from DOM text.
 *  3. jsdom cannot drive CodeMirror typing: with a real DOM selection installed,
 *     `beforeinput`, `input` and printable `keydown` never move the document, and
 *     mutating `.cm-content` text makes CodeMirror's DOM observer replace the
 *     whole document with the rendered subset (measured 211669 -> 1267 chars).
 *     Edits are driven through the real view's own `dispatch`; real keyboard and
 *     IME input stays a browser-verification item (SPEC R21.11).
 *
 * This module is shared infrastructure, deliberately free of assertions about
 * behaviour: the acceptance assertions live in `tests/editor-dom.test.mjs` so a
 * bug in this file cannot make a behaviour test pass.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import React from 'react';
import { EditorView } from '@codemirror/view';
import { JSDOM, VirtualConsole } from 'jsdom';

const require = createRequire(import.meta.url);

/**
 * Globals a browser has that CodeMirror and the shipped bundle read bare. The
 * list is explicit on purpose: this harness never installs globals as a side
 * effect of being imported, and a suite that wants a hostile environment (no
 * `requestAnimationFrame`) can ask for one instead of losing that ability.
 */
const GLOBAL_NAMES = [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLDivElement', 'HTMLStyleElement',
  'Element', 'Node', 'Document', 'DocumentFragment', 'Text', 'Event', 'InputEvent',
  'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'CompositionEvent', 'MutationObserver',
  'NodeFilter', 'NodeList', 'HTMLCollection', 'Range', 'DOMRect', 'DOMTokenList',
  'SVGElement', 'StyleSheet', 'CSSStyleSheet',
];

/**
 * A stand-in for the browser module table's `@deepseek-ai/dsh-client-ui-primitives`.
 * The editor under test does not use these primitives; a suite that mounted the
 * whole panel here would reach one of these and fail loudly instead of silently
 * rendering nothing.
 */
const RESTRICTED_PRIMITIVES = new Proxy({}, {
  get(_target, name) {
    if (name === 'then') return undefined;
    return () => { throw new Error(`this DOM suite must not render the panel UI primitive ${String(name)}`); };
  },
});

/**
 * Number of live environments and the globals snapshot taken before the first one.
 *
 * `node:test` runs `after` hooks in registration order, so a nested environment is
 * torn down before the environment it was installed inside. Snapshotting per install
 * would then hand a closed window (or `undefined`) back as the global for every
 * later test; one outermost snapshot, applied when the last environment goes away,
 * is the only order-independent rule.
 */
let activeEnvironments = 0;
let outermost = null;

/**
 * Install a jsdom window as the global browser environment.
 *
 * @param options - `raf: false` installs no `requestAnimationFrame`, which is the
 *   deterministic way to make CodeMirror's own constructor fail; a missing global
 *   `Window` is not an option because CodeMirror reads it bare and would fail
 *   asynchronously instead of where the failure is observable.
 * @returns the window, document, collected jsdom errors and an idempotent restore.
 */
export function installDom({ raf = true, pretendToBeVisual = raf } = {}) {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual, virtualConsole });
  const window = dom.window;
  const isOutermost = activeEnvironments === 0;
  if (isOutermost) outermost = new Map();
  activeEnvironments += 1;
  let restored = false;

  const set = (name, value) => {
    if (isOutermost && !outermost.has(name)) outermost.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
  };

  for (const name of GLOBAL_NAMES) if (name in window) set(name, window[name]);
  // CodeMirror's isScrolledToBottom reads a bare `Window` (dist line 779:
  // `if (elt instanceof Window)`) with no typeof guard, and reaches it from a
  // requestAnimationFrame measure callback. Without this global the editor mounts
  // and then throws asynchronously, which would be attributed to the wrong code.
  set('Window', window.constructor);
  set('getComputedStyle', window.getComputedStyle.bind(window));
  set('getSelection', typeof window.getSelection === 'function' ? window.getSelection.bind(window) : undefined);
  if (raf) {
    set('requestAnimationFrame', window.requestAnimationFrame.bind(window));
    set('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
  } else {
    set('requestAnimationFrame', undefined);
    set('cancelAnimationFrame', undefined);
  }
  set('IS_REACT_ACT_ENVIRONMENT', true);

  const handle = {
    dom, window, document: window.document, body: window.document.body, errors,
    /** Drain jsdom's microtask/rAF work so errors raised after a render surface. */
    settle: ms => new Promise(resolve => window.setTimeout(resolve, ms)),
    restore() {
      if (restored) return;
      restored = true;
      activeEnvironments -= 1;
      // Only the outermost environment hands the globals back. `node:test` runs a
      // test's `after` hooks in registration order (FIFO), so a nested environment
      // is restored *before* the one it was installed inside; restoring per install
      // would leave a closed window (or `undefined`) as the global for every later
      // test. The snapshot below is therefore the state from before the first
      // install, and it is applied once, when the last environment goes away.
      if (activeEnvironments === 0 && outermost !== null) {
        for (const [name, descriptor] of outermost) {
          if (descriptor === undefined) delete globalThis[name];
          else Object.defineProperty(globalThis, name, descriptor);
        }
        outermost = null;
      }
      window.close();
    },
    /** Alias kept for callers that read more naturally as `cleanup()`. */
    cleanup() { this.restore(); },
  };
  return handle;
}

/**
 * Load the shipped Client module and return its exports.
 *
 * @param windowLike - the jsdom window the loader contract is installed on, so the
 *   bundle is evaluated in exactly the environment the suites assert against.
 */
export async function loadShippedClient(windowLike = globalThis.window) {
  let source;
  try {
    source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');
  } catch {
    assert.fail('dist/client.js is missing: run `npm run build` before the DOM acceptance suite');
  }
  assert.ok(windowLike && typeof windowLike === 'object', 'the shipped bundle needs a window to register its module loader on');
  let definition;
  const loader = { load(value) { definition = value; } };
  Object.defineProperty(windowLike, '__ModuleLoader__', { value: loader, writable: true, configurable: true });
  const previousWindow = globalThis.window;
  globalThis.window = windowLike;
  try {
    vm.runInThisContext(source, { filename: 'dist/client.js' });
  } finally {
    globalThis.window = previousWindow;
  }
  assert.ok(definition, 'dist/client.js must register itself through window.__ModuleLoader__');
  assert.equal(definition.id, '@lolkda/dsh-file-manager');
  return definition.factory(name => {
    if (name === 'react') return require('react');
    if (name === 'react/jsx-runtime') return require('react/jsx-runtime');
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return RESTRICTED_PRIMITIVES;
    // Anything else would have to be inlined by the build: the browser module
    // table provides nothing else, so an unresolved require is a build defect.
    assert.fail(`the shipped bundle required ${name}, which the browser module table does not provide`);
  });
}

/** The element the editor component marks as its host, or a hard failure. */
export function editorHostOf(element) {
  const host = element.matches?.('[data-fm-code]') ? element : element.querySelector?.('[data-fm-code]');
  assert.ok(host, 'the shipped editor must render its host element marked with data-fm-code');
  return host;
}

/**
 * The real `EditorView` behind the rendered editor.
 *
 * Uses CodeMirror's public `EditorView.findFromDOM`, which resolves through the
 * `cmTile` own property of the content node. The back-pointer is cross-checked
 * and the view must own the rendered node, so a stale or foreign object cannot
 * satisfy a behaviour assertion.
 */
export function editorViewOf(element) {
  const content = element.matches?.('.cm-content') ? element : element.querySelector?.('.cm-content');
  assert.ok(content, 'the shipped editor must render a real CodeMirror .cm-content element');
  const view = EditorView.findFromDOM(content);
  assert.ok(view && typeof view.dispatch === 'function',
    'EditorView.findFromDOM(.cm-content) must resolve the live view of the rendered editor');
  assert.equal(view.dom.contains(content), true, 'the resolved view must own the rendered content node');
  assert.equal(content.cmTile?.root?.view, view,
    'the public lookup and the content node back-pointer must resolve to the same real view');
  return view;
}

/** The full document text, read from the real view (the DOM holds only the viewport). */
export function readEditorText(element) {
  return editorViewOf(element).state.doc.toString();
}

/** React's own `act`, so a suite can wrap a whole render/dispatch/read sequence. */
export const act = React.act;

/**
 * Replace the document through the real view's own API.
 *
 * This is how an edit is injected into the shipped component: jsdom cannot type
 * into CodeMirror, and mutating the DOM text would make CodeMirror's observer
 * treat the rendered subset as the whole document.
 *
 * Runs inside `act`, because the resulting `onChange` state update commits a
 * React render: an unwrapped dispatch would be observed half-applied.
 */
export async function setEditorText(element, text) {
  assert.equal(typeof text, 'string', 'editor text must be a string');
  const view = editorViewOf(element);
  await act(async () => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); });
  return true;
}

/**
 * Dispatch a CodeMirror transaction through the real view, inside `act`.
 *
 * An object spec is passed to `view.dispatch` unchanged (so `changes`,
 * `selection` and `annotations` all stay available); a function receives the real
 * view and returns the spec. The view is a live CodeMirror view, not a stand-in.
 */
export async function dispatchEditor(element, specOrFn) {
  const view = editorViewOf(element);
  await act(async () => {
    view.dispatch(typeof specOrFn === 'function' ? specOrFn(view) : specOrFn);
  });
  return true;
}

/**
 * Mount React content with react-dom into a real container.
 *
 * `act` semantics are fixed here: `render()` and `unmount()` both commit inside
 * `act`, and `IS_REACT_ACT_ENVIRONMENT` is true, so an editor created in an effect
 * is fully mounted before the caller observes the DOM. `react-dom/client` is
 * imported only after the jsdom globals exist, so the renderer never captures a
 * document-less environment.
 */
export async function mountInto(container, reactElement) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import('react-dom/client');
  assert.equal(typeof act, 'function', 'React 18.3 must expose act() for real DOM commits');
  const root = createRoot(container);
  const render = async next => { await act(async () => { root.render(next); }); };
  await render(reactElement);
  return {
    render,
    async unmount() { await act(async () => { root.unmount(); }); },
  };
}

/** Wait for jsdom timers/rAF work to settle inside the act environment. */
export async function flushDom(ms = 30) {
  await React.act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
}

/** Fail when the environment raised an error jsdom reported (never silent). */
export function assertNoDomErrors(handle) {
  assert.equal(handle.errors.length, 0,
    `jsdom reported ${handle.errors.length} error(s): ${handle.errors.map(error => String(error?.message ?? error)).join(' | ')}`);
}
