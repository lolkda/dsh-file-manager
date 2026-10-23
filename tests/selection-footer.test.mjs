import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { act, loadClient, node, nodes, setup, textOf } from './client-harness.mjs';
import { assertNoDomErrors, installDom, mountInto } from './editor-dom-harness.mjs';

const statusSelector = { 'data-fm-list-status': true };
const clearSelector = { 'data-fm-action': 'clear-selection' };
const status = view => node(view.renderer, statusSelector);

// This is the shipped panel with the real Host router, not a footer component stub.
test('the existing list status preserves entries/loading semantics across zero one many and clear', async t => {
  const view = await setup(t, { seed: root => writeFile(path.join(root, 'other.txt'), 'other') });
  const original = status(view);
  const parent = original.parent;
  assert.equal(parent.type, 'footer');
  assert.equal(parent.props.className, 'fm-list-footer');
  assert.equal(original.props.role, 'status');
  assert.equal(original.props['aria-live'], 'polite');
  assert.equal(textOf(original), '2 / 2 项');
  assert.equal(nodes(view.renderer, statusSelector).length, 1);
  const before = view.requests.length;
  await view.select('folder');
  assert.equal(status(view), original);
  assert.equal(textOf(original), '2 / 2 项 · 已选 1 项');
  await view.select('other.txt');
  assert.equal(status(view), original);
  assert.equal(textOf(original), '2 / 2 项 · 已选 2 项');
  await view.click(clearSelector);
  assert.equal(status(view), original);
  assert.equal(status(view).parent, parent);
  assert.equal(textOf(original), '2 / 2 项');
  assert.equal(view.requests.length, before, 'selection and clear are local, not navigation or reads');
  assert.equal(parent.findAll(item => typeof item.type === 'string' && item.props.role === 'status').length, 1);
});

test('status only counts effective current-list entries, never an unavailable selected path', async t => {
  const view = await setup(t);
  const original = status(view);
  const selectFolder = node(view.renderer, { type: 'checkbox', 'aria-label': '选择: folder' }).props.onChange;
  await view.click({ 'data-fm-entry': 'directory', 'data-fm-path': 'folder' });
  // Replay a stale checkbox callback from the previous listing. The selected set
  // may contain the stale path, but the panel must use selectedEntries like actions do.
  await act(async () => selectFolder({ target: { checked: true } }));
  assert.equal(status(view), original);
  assert.equal(textOf(original), '1 / 1 项');
  await view.select('hello.txt');
  assert.equal(textOf(original), '1 / 1 项 · 已选 1 项');
});

test('readonly capability degradation still permits selection feedback and clearing', async t => {
  const view = await setup(t, { intercept: async (url, init, route) => {
    const response = await route(url, init);
    if (init.body && JSON.parse(init.body).op === 'bootstrap') {
      const body = await response.json();
      body.value.capabilities = { ...body.value.capabilities, write: false, tasks: false, transfers: false, references: false };
      body.value.degraded = { scope: 'writes', code: 'READ_ONLY', message: 'Read-only fixture', readOnly: true };
      return Response.json(body);
    }
    return response;
  } });
  const original = status(view);
  await view.select('folder');
  assert.equal(textOf(original), '1 / 1 项 · 已选 1 项');
  assert.equal(node(view.renderer, { 'data-fm-action': 'delete' }).props.disabled, true);
  assert.equal(node(view.renderer, clearSelector).props.disabled, false);
  await view.click(clearSelector);
  assert.equal(status(view), original);
  assert.equal(textOf(original), '1 / 1 项');
});

test('busy refresh keeps the same live status and loading text alongside its selection count', async t => {
  let hold = false;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const view = await setup(t, { intercept: async (url, init, route) => {
    if (hold && init.body && JSON.parse(init.body).op === 'entries.list') await pending;
    return route(url, init);
  } });
  const original = status(view);
  await view.select('folder');
  hold = true;
  let refresh;
  await act(async () => { refresh = node(view.renderer, { 'data-fm-action': 'refresh' }).props.onClick(); });
  assert.equal(status(view), original);
  assert.equal(textOf(original), '正在加载… · 已选 1 项');
  assert.equal(node(view.renderer, clearSelector).props.disabled, true);
  await act(async () => { release(); await refresh; await view.settle(); });
  assert.equal(status(view), original);
  assert.equal(textOf(original), '1 / 1 项');
});

test('shipped list CSS keeps checkbox labels permanently available and scopes footer hiding to its note', async t => {
  const view = await setup(t);
  const css = textOf(view.renderer.root.findByType('style'));
  assert.equal(css.includes('data-fm-selection-mode'), false, 'no narrow mode-dependent hiding or single-column layout remains');
  assert.match(css, /\.fm-selection-control\{[^}]*min-width:44px;min-height:44px/);
  assert.match(css, /input\.fm-selection\[type=checkbox\]\{[^}]*width:16px;height:16px/);
  assert.match(css, /\.fm-entryline\{[^}]*grid-template-columns:44px minmax\(0,1fr\)/);
  assert.equal(/\.fm-selection-control[^{}]*\{[^}]*display:none/.test(css), false);
  assert.match(css, /\.fm-list-footer\{[^}]*height:32px;min-height:32px[^}]*flex-wrap:nowrap/);
  assert.match(css, /\.fm-list-status\{[^}]*white-space:nowrap/);
  assert.match(css, /\.fm-list-footer>\.fm-footer-note\{display:none\}/);
  assert.equal(css.includes('footer span:last-child'), false);
});

// Real DOM node/scroll retention; jsdom cannot prove rendered footer height or hitboxes.
for (const [locale, expected] of [['zh-CN', '已选 2 项'], ['en', '2 selected']]) {
  test(`DOM list status stays mounted and preserves scroll across selection and clear (${locale})`, async t => {
    const env = installDom();
    let client;
    let mounted;
    t.after(async () => {
      try { await mounted?.unmount(); await client?.dispose(); assertNoDomErrors(env); }
      finally { env.restore(); }
    });
    const entries = [
      { name: 'a.txt', path: 'a.txt', kind: 'file', size: 1 },
      { name: 'b.txt', path: 'b.txt', kind: 'file', size: 1 },
    ];
    const fetch = async (_url, init = {}) => {
      const op = init.body ? JSON.parse(init.body).op : '';
      if (op === 'bootstrap') return Response.json({ ok: true, value: {
        root: { id: 'root', path: '/work', label: 'root', identity: '1:2' }, capabilities: {}, limits: {},
      } });
      if (op === 'entries.list') return Response.json({ ok: true, value: { rootId: 'root', path: '', entries, total: 2, nextCursor: null, unaddressable: [] } });
      throw new Error(`Unexpected panel request: ${op}`);
    };
    client = await loadClient(fetch);
    globalThis.window = env.window;
    const registration = client.cells.get('main:file-manager');
    const translator = (key, values) => {
      const dictionary = client.client.i18n[locale === 'en' ? 'en' : 'zh'];
      const value = dictionary[key] ?? key;
      return values ? value.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? '')) : value;
    };
    const container = env.document.createElement('div');
    env.body.append(container);
    mounted = await mountInto(container, React.createElement(registration.component, { t: translator, ...registration.options.inject() }));
    await act(async () => { await new Promise(resolve => setImmediate(resolve)); });
    const status = container.querySelector('[data-fm-list-status]');
    const footer = status.parentElement;
    const scroll = container.querySelector('.fm-scroll');
    scroll.scrollTop = 73;
    const checkboxes = [...container.querySelectorAll('input.fm-selection')];
    assert.equal(checkboxes.length, 2);
    for (const checkbox of checkboxes) await act(async () => checkbox.click());
    assert.equal(container.querySelector('[data-fm-list-status]'), status);
    assert.equal(status.parentElement, footer);
    assert.ok(status.textContent.endsWith(expected), status.textContent);
    assert.equal(scroll.scrollTop, 73);
    await act(async () => container.querySelector('[data-fm-action="clear-selection"]').click());
    assert.equal(container.querySelector('[data-fm-list-status]'), status);
    assert.equal(status.parentElement, footer);
    assert.equal(scroll.scrollTop, 73);
    assert.equal(checkboxes.every(checkbox => !checkbox.checked), true);
  });
}
