import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { loadClientModule } from './client-module-loader.mjs';
import { act, assertNoDomErrors, editorViewOf, flushDom, installDom, mountInto, setEditorText } from './editor-dom-harness.mjs';

// The shipped Panel and CodeMirror in a real DOM. Public stores seed documents;
// the UI primitive adapter and read-only bootstrap stub are not visual/Host proof.
// Disk writes/close confirmations have separate real-Host integration coverage.
async function setup(t) {
  const env = installDom();
  const previousFetch = globalThis.fetch;
  const cells = new Map();
  const disposers = [];
  const requests = [];
  let mounted;
  t.after(async () => {
    try {
      await mounted?.unmount();
      for (const dispose of disposers.reverse()) await dispose?.();
      assertNoDomErrors(env);
    } finally {
      globalThis.fetch = previousFetch;
      env.restore();
    }
  });
  const dictionaries = new Map();
  const ctx = {
    locale: {
      register(namespace, locale, dictionary) { dictionaries.set(`${namespace}:${locale}`, dictionary); return () => {}; },
      bind(namespace) { return (key, values) => (dictionaries.get(`${namespace}:zh-CN`)?.[key] ?? key)
        .replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? '')); },
    },
    slots: {
      inject(_name, callback) { const dispose = callback(); disposers.push(dispose); return dispose; },
      register(options, component) { cells.set(`${options.name}:${options.key ?? options.id}`, { options, component }); return () => {}; },
    },
    effect(callback) { const dispose = callback(); disposers.push(dispose); return dispose; },
    uiWorkspace: { openSession() {} },
  };
  globalThis.fetch = env.window.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    if (request.op === 'bootstrap') return Response.json({ ok: true, value: {
      root: { id: 'dom-root', label: '/', path: '/', identity: '1:1' },
      capabilities: { write: true, watch: false, tasks: false, transfers: false }, limits: {},
    } });
    if (request.op === 'entries.list') return Response.json({ ok: true, value: { entries: [], total: 0, nextCursor: null } });
    assert.fail(`unexpected request in close-only DOM suite: ${request.op}`);
  };
  (await loadClientModule('apply'))(ctx);
  const panel = cells.get('main:file-manager');
  const props = panel.options.inject();
  const first = props.documents.open({ rootId: 'dom-root', path: 'first/same.txt', version: 'first', text: 'first' });
  const second = props.documents.open({ rootId: 'dom-root', path: 'second/same.txt', version: 'second', text: 'second' });
  const container = env.document.createElement('div');
  env.body.append(container);
  mounted = await mountInto(container, React.createElement(panel.component, { t: ctx.locale.bind('local-file-manager'), ...props }));
  await flushDom(40);
  const one = selector => {
    const nodes = [...container.querySelectorAll(selector)].filter(node => !node.closest('[hidden],[inert]'));
    assert.equal(nodes.length, 1, `expected exactly one reachable ${selector}`);
    assert.equal(nodes[0].matches(':disabled'), false, `${selector} must be enabled`);
    return nodes[0];
  };
  const click = async element => { await act(async () => { element.click(); }); };
  await click(one('[data-fm-action="open-documents"]'));
  return { ...env, container, first, second, documents: props.documents, requests, one, click };
}

const tabClose = id => `[data-fm-close-document="${id}"]`;
const viewerCard = '[data-fm-overlay="viewer"] .fm-overlay-card';

/* ---------------------------------------------------------------------------
 * Tab container structure and the local tab-X icon contract.
 *
 * The container — not the switch button alone — carries the active state, and
 * the tab X gets a compact local icon size the window X must never inherit.
 * jsdom proves structure, the declared rule and the cascade result; the rendered
 * geometry of the rounded container stays a browser-verification item.
 * ------------------------------------------------------------------------- */
const TAB_ACTIVE_CLASS = 'fm-active';
const TAB_ICON_MAX_PX = 12;
const viewerTabs = dom => [...dom.container.querySelectorAll('.fm-viewer-tabs>.fm-tab')];
const wrapperOf = (dom, id) => dom.one(`[data-fm-tab="${id}"]`).parentElement;
const activeMarked = wrapper => wrapper.classList.contains(TAB_ACTIVE_CLASS);
/** Panel-stylesheet rules matching `element`, flattened out of their at-rules. */
const panelRulesMatching = (dom, element) => {
  const style = dom.container.querySelector('.dsh-fm>style');
  assert.ok(style?.sheet, 'the panel must ship its stylesheet as a real <style> sheet');
  const rules = [];
  const walk = list => {
    for (const rule of list) {
      if (rule.cssRules?.length) walk([...rule.cssRules]);
      else rules.push(rule);
    }
  };
  walk([...style.sheet.cssRules]);
  return rules.filter(rule => {
    if (!rule.selectorText) return false;
    try { return element.matches(rule.selectorText); } catch { return false; }
  });
};
/** The sizes those matched rules actually declare, selector by selector. */
const declaredSizes = rules => rules.flatMap(rule => {
  const sizes = {};
  if (rule.style.width) sizes.width = rule.style.width;
  if (rule.style.height) sizes.height = rule.style.height;
  return Object.keys(sizes).length ? [{ selector: rule.selectorText, ...sizes }] : [];
});
const computedSize = (dom, element) => {
  const { width, height } = dom.window.getComputedStyle(element);
  return { width, height };
};
/**
 * The tab icon as the shipped host Button renders it: the icon node is wrapped in
 * the button's own box, so the svg is a grandchild — `<button><span class="icon">
 * <svg/></span></button>`. This suite's UI boundary stub renders it as a direct
 * child instead, so a `>svg` rule passes here and misses in the browser.
 */
const HOST_BUTTON_ICON = '<span class="icon"><svg width="16" height="16" viewBox="0 0 16 16"></svg></span>';

test('closing an inactive tab through its icon keeps the active document and focus inside the viewer', async t => {
  const dom = await setup(t);
  const close = dom.one(tabClose(dom.first));
  const switchButton = dom.one(`[data-fm-tab="${dom.first}"]`);
  const card = dom.one(viewerCard);
  const beforeRequests = dom.requests.length;
  assert.equal(dom.container.querySelectorAll('button button').length, 0);
  assert.equal(close.parentElement, switchButton.parentElement, 'switch and close are sibling controls');
  assert.equal(close.getAttribute('aria-label'), '关闭文档: first/same.txt');
  assert.equal(dom.one(tabClose(dom.second)).getAttribute('aria-label'), '关闭文档: second/same.txt');
  close.focus();
  assert.equal(dom.document.activeElement, close);
  await act(async () => { close.querySelector('svg').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  assert.deepEqual(dom.documents.getSnapshot().documents.map(doc => doc.id), [dom.second]);
  assert.equal(dom.documents.getSnapshot().activeId, dom.second);
  assert.equal(dom.document.activeElement, dom.one('[data-fm-action="close-viewer"]'));
  assert.equal(card.contains(dom.document.activeElement), true);
  // CodeMirror is also focusable after the header, so the window X is not the
  // last focus target. Escape from the repaired focus proves the overlay still
  // receives keyboard events; jsdom does not simulate native Tab navigation.
  const escape = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await act(async () => { dom.document.activeElement.dispatchEvent(escape); });
  assert.equal(escape.defaultPrevented, true, 'keyboard events still reach the viewer after removing a tab');
  assert.equal(dom.container.querySelector('[data-fm-overlay="viewer"]').hidden, true);
  assert.equal(dom.documents.getSnapshot().activeId, dom.second);
  assert.equal(dom.requests.length, beforeRequests, 'closing a clean tab or hiding the viewer sends no request');
});

test('closing the active tab chooses the remaining document and closing the last tab hides the viewer', async t => {
  const dom = await setup(t);
  const close = dom.one(tabClose(dom.second));
  close.focus();
  await dom.click(close);
  assert.equal(dom.documents.getSnapshot().activeId, dom.first);
  assert.equal(dom.container.querySelector('[data-fm-overlay="viewer"]').hidden, false);
  assert.equal(dom.document.activeElement, dom.one('[data-fm-action="close-viewer"]'));
  await dom.click(dom.one(tabClose(dom.first)));
  assert.equal(dom.documents.getSnapshot().documents.length, 0);
  assert.equal(dom.container.querySelector('[data-fm-overlay="viewer"]').hidden, true);
  assert.equal(dom.container.querySelector('.fm-base').hasAttribute('inert'), false);
});

test('window X hides and restores the same dirty CodeMirror view without modifying documents or sending requests', async t => {
  const dom = await setup(t);
  const editor = dom.one('.cm-editor');
  const view = editorViewOf(editor);
  await setEditorText(editor, 'draft preserved by window close');
  const snapshot = dom.documents.getSnapshot();
  assert.equal(snapshot.documents.find(doc => doc.id === dom.second).dirty, true);
  const beforeRequests = dom.requests.length;
  await dom.click(dom.one('[data-fm-action="close-viewer"]'));
  assert.equal(dom.container.querySelector('[data-fm-overlay="viewer"]').hidden, true);
  assert.equal(dom.documents.getSnapshot(), snapshot, 'hiding never mutates document store state');
  assert.equal(editor.isConnected, true, 'hiding never unmounts CodeMirror');
  assert.equal(dom.container.querySelector('.cm-editor'), editor);
  await dom.click(dom.one('[data-fm-action="open-documents"]'));
  assert.equal(dom.one('.cm-editor'), editor);
  assert.equal(editorViewOf(editor), view);
  assert.equal(view.state.doc.toString(), 'draft preserved by window close');
  assert.equal(dom.documents.getSnapshot(), snapshot);
  assert.equal(dom.requests.length, beforeRequests);
});

test('each tab container holds exactly two independent sibling buttons and never nests one in the other', async t => {
  const dom = await setup(t);
  assert.equal(viewerTabs(dom).length, 2, 'one container per open document');
  for (const id of [dom.first, dom.second]) {
    const wrapper = wrapperOf(dom, id);
    assert.equal(wrapper.matches('button'), false, 'the container is not a control itself');
    const buttons = [...wrapper.querySelectorAll('button')];
    assert.equal(buttons.length, 2, 'a tab holds exactly the switch and its close button');
    assert.deepEqual(
      buttons.map(button => button.dataset.fmTab ?? button.dataset.fmCloseDocument),
      [id, id],
      'switch then close, both addressing this very document',
    );
    const [switchButton, closeButton] = buttons;
    assert.equal(switchButton.parentElement, wrapper);
    assert.equal(closeButton.parentElement, wrapper);
    assert.equal(switchButton.contains(closeButton), false, 'the close button is never inside the switch button');
    assert.equal(closeButton.contains(switchButton), false, 'the switch button is never inside the close button');
    assert.equal(closeButton.querySelectorAll('svg[data-host-icon="IconCloseOutlineRegular"]').length, 1,
      'the tab X stays the host primitive icon, not an inline replacement');
  }
});

test('the active tab container carries the active class and activating another tab moves it', async t => {
  const dom = await setup(t);
  const activeOf = () => viewerTabs(dom).filter(activeMarked);
  assert.equal(dom.documents.getSnapshot().activeId, dom.second, 'the last opened document is active');
  assert.equal(activeOf().length, 1, 'exactly one tab container is the active one');
  assert.equal(activeOf()[0], wrapperOf(dom, dom.second));
  assert.equal(activeMarked(wrapperOf(dom, dom.first)), false, 'the inactive container stays unmarked');
  // The switch button keeps the announcement hook: the container is presentational.
  assert.equal(dom.one(`[data-fm-tab="${dom.second}"]`).getAttribute('aria-current'), 'true');
  assert.equal(dom.one(`[data-fm-tab="${dom.first}"]`).getAttribute('aria-current'), null);
  await dom.click(dom.one(`[data-fm-tab="${dom.first}"]`));
  assert.equal(dom.documents.getSnapshot().activeId, dom.first);
  assert.equal(activeOf().length, 1, 'the marker never duplicates');
  assert.equal(activeOf()[0], wrapperOf(dom, dom.first), 'the marker moved to the newly active tab');
  assert.equal(activeMarked(wrapperOf(dom, dom.second)), false, 'the previously active tab lost the marker');
  assert.equal(dom.one(`[data-fm-tab="${dom.first}"]`).getAttribute('aria-current'), 'true');
  assert.equal(dom.one(`[data-fm-tab="${dom.second}"]`).getAttribute('aria-current'), null);
  // Removing the active tab re-renders the strip: exactly one container stays marked.
  await dom.click(dom.one(tabClose(dom.first)));
  assert.deepEqual(dom.documents.getSnapshot().documents.map(doc => doc.id), [dom.second]);
  assert.equal(viewerTabs(dom).length, 1);
  assert.equal(activeMarked(wrapperOf(dom, dom.second)), true);
  assert.equal(activeOf().length, 1);
});

test('the tab X takes a compact local icon size that never reaches the window X', async t => {
  const dom = await setup(t);
  const windowIcon = dom.one('[data-fm-action="close-viewer"]').querySelector('svg');
  assert.ok(windowIcon, 'the window close renders the host icon');
  for (const id of [dom.first, dom.second]) {
    const icon = wrapperOf(dom, id).querySelector(`${tabClose(id)} svg`);
    assert.ok(icon, `the tab X of ${id} renders its icon`);
    const size = computedSize(dom, icon);
    assert.match(size.width, /^\d+(\.\d+)?px$/u, `the tab X icon declares a local pixel size, got "${size.width}"`);
    assert.equal(size.height, size.width, 'the tab X icon is square');
    const px = Number.parseFloat(size.width);
    assert.ok(px > 0 && px <= TAB_ICON_MAX_PX, `the tab X icon stays compact (0 < size <= ${TAB_ICON_MAX_PX}px), got ${size.width}`);
    // A local contract, not a coincidence: a panel rule matching this very icon
    // declares that size, and it must not reach the window X.
    const declared = declaredSizes(panelRulesMatching(dom, icon));
    assert.ok(declared.length > 0, `a panel rule must declare the tab X size of ${id}`);
    for (const rule of declared) {
      if (rule.width !== undefined) assert.equal(rule.width, size.width, `${rule.selector} declares the computed width`);
      if (rule.height !== undefined) assert.equal(rule.height, size.height, `${rule.selector} declares the computed height`);
      assert.equal(windowIcon.matches(rule.selector), false, `${rule.selector} must not match the window X`);
    }
    // The window X is out of scope: no panel rule may declare a size for it (the
    // host theme owns its real size) and it never inherits the compact tab value.
    assert.notEqual(computedSize(dom, windowIcon).width, size.width, 'the window X must not inherit the compact tab-X size');
    assert.notEqual(computedSize(dom, windowIcon).height, size.height, 'the window X must not inherit the compact tab-X size');
  }
  assert.deepEqual(declaredSizes(panelRulesMatching(dom, windowIcon)), [],
    'no panel rule may declare an icon size for the window X');
});

test('clicking the tab container itself switches nothing, closes nothing and opens no dialog', async t => {
  const dom = await setup(t);
  const before = dom.documents.getSnapshot();
  const beforeRequests = dom.requests.length;
  const wrapper = wrapperOf(dom, dom.first);
  await act(async () => { wrapper.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  assert.equal(dom.documents.getSnapshot().activeId, before.activeId, 'the container is not a second switch control');
  assert.deepEqual(dom.documents.getSnapshot().documents.map(doc => doc.id), before.documents.map(doc => doc.id));
  assert.equal(dom.container.querySelectorAll('.dsh-fm-dialog').length, 0, 'no close confirmation opened');
  assert.equal(dom.container.querySelector('[data-fm-overlay="viewer"]').hidden, false, 'the viewer stayed open');
  assert.equal(dom.requests.length, beforeRequests, 'a click on the container is not an operation');
});

test('the tab X size rule reaches the icon even where the host Button wraps it in its icon box', async t => {
  const dom = await setup(t);
  // Same names and ancestor chain as the shipped strip, with the icon nested the
  // way the host Button nests it.
  const hostShaped = dom.document.createElement('div');
  hostShaped.className = 'dsh-fm';
  hostShaped.innerHTML = [
    '<nav class="fm-tabs fm-viewer-tabs"><span class="fm-tab fm-active">',
    '<button data-fm-tab="document-1">same.txt</button>',
    `<button data-fm-action="close-document" data-fm-close-document="document-1">${HOST_BUTTON_ICON}</button>`,
    `<button data-fm-action="close-viewer">${HOST_BUTTON_ICON}</button>`,
    '</span></nav>',
  ].join('');
  const tabIcon = hostShaped.querySelector('[data-fm-close-document] svg');
  const windowIcon = hostShaped.querySelector('[data-fm-action="close-viewer"] svg');
  assert.equal(tabIcon.parentElement.matches('button'), false, 'the probe must mirror the host nesting, not the stub');
  const declared = declaredSizes(panelRulesMatching(dom, tabIcon));
  assert.ok(declared.length > 0, 'a panel rule must size the tab X icon once the host icon box is between button and svg');
  for (const rule of declared) {
    assert.equal(windowIcon.matches(rule.selector), false, `${rule.selector} must not match the window X`);
  }
  assert.deepEqual(declaredSizes(panelRulesMatching(dom, windowIcon)), [],
    'no panel rule may declare an icon size for the window X');
});

