import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { act, editorEdit, node, nodes, setup, snapshotBoundary, textOf } from './client-harness.mjs';

// Shipped Client + actual Host router. These checks establish interaction and
// rendered structure, not browser geometry or mobile touch-target dimensions.
const action = name => ({ 'data-fm-action': name });
const row = (kind, relative) => ({ 'data-fm-entry': kind, 'data-fm-path': relative });
const checked = (view, name) => node(view.renderer, { type: 'checkbox', 'aria-label': `选择: ${name}` }).props.checked;
const files = view => node(view.renderer, { className: 'fm-files' });
const bodyOf = request => JSON.parse(request.init.body ?? '{}');
const hasClass = (element, name) => String(element.props.className ?? '').split(/\s+/).includes(name);
function hostParent(element) {
  let parent = element.parent;
  while (parent && typeof parent.type !== 'string') parent = parent.parent;
  return parent;
}
const GROUPS = {
  create: ['new-file', 'new-directory'],
  upload: ['upload-files', 'upload-directory'],
  more: ['rename', 'delete', 'copy', 'copy-selected-paths', 'cut', 'paste', 'download', 'reference', 'clear-selection'],
};
const groupedActions = Object.values(GROUPS).flat();
const assertDisabled = (view, names, disabled) => {
  for (const name of names) assert.equal(node(view.renderer, action(name)).props.disabled, disabled, name);
};

test('compact toolbar has three native action disclosures and no selection mode, without duplicate controls', async t => {
  const view = await setup(t, { tasks: true, transfers: true });
  const toolbar = files(view).findAll(candidate => typeof candidate.type === 'string' && hasClass(candidate, 'fm-file-toolbar'));
  assert.equal(toolbar.length, 1);
  assert.equal(nodes(view.renderer, action('up')).length, 0);
  assert.equal(files(view).findAll(candidate => typeof candidate.type === 'string' && hasClass(candidate, 'fm-directory-navigation')).length, 0);
  for (const [name, actions] of Object.entries(GROUPS)) {
    const group = node(view.renderer, { 'data-fm-action-group': name });
    assert.equal(group.type, 'details');
    assert.equal(hostParent(group), toolbar[0]);
    assert.equal(group.findAllByType('summary').length, 1);
    const summary = group.findByType('summary');
    assert.ok(textOf(summary).length > 1);
    const chevron = summary.findByType('svg');
    assert.equal(chevron.props['aria-hidden'], 'true');
    assert.equal(chevron.props.width, 14);
    assert.equal(chevron.props.height, 14);
    assert.deepEqual(group.findAll(candidate => candidate.type === 'button').map(candidate => candidate.props['data-fm-action']), actions);
    for (const name of actions) assert.equal(nodes(view.renderer, action(name)).length, 1, name);
  }
  assert.equal(nodes(view.renderer, action('selection-mode')).length, 0);
  assert.equal('data-fm-selection-mode' in files(view).props, false);
  assert.equal(files(view).findAllByType('input').filter(item => item.props.type === 'checkbox').length, 1);
  const copy = node(view.renderer, action('copy-directory-path'));
  const refresh = node(view.renderer, action('refresh'));
  assert.equal(hostParent(copy), hostParent(refresh));
  assert.ok(hasClass(hostParent(copy), 'fm-breadcrumb-bar'));
  assert.equal(files(view).findAll(candidate => candidate.type === 'div' && candidate.props.className === 'fm-scroll').length, 1);
});

test('toolbar declarations keep touch targets, content-sized wrapping and mobile popovers within the toolbar', async t => {
  const view = await setup(t);
  const css = textOf(view.renderer.root.findByType('style'));
  const declarations = selector => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rules = [...css.matchAll(new RegExp(`${escaped}\\{([^}]*)\\}`, 'g'))];
    assert.ok(rules.length, `missing declaration rule ${selector}`);
    return rules.at(-1)[1];
  };
  assert.match(declarations('.dsh-fm button,.dsh-fm summary'), /min-height:44px;min-width:44px/);
  assert.match(css, /\.dsh-fm \.fm-file-toolbar\{[^}]*flex-wrap:wrap/);
  const mobileToolbar = declarations('.dsh-fm .fm-file-toolbar');
  assert.match(mobileToolbar, /order:2/);
  assert.match(mobileToolbar, /justify-content:flex-start;gap:4px/);
  assert.match(mobileToolbar, /safe-area-inset-bottom/);
  assert.match(declarations('.dsh-fm .fm-file-toolbar>.fm-action-group'), /position:static;flex:0 0 auto/);
  assert.match(declarations('.dsh-fm .fm-file-toolbar>button'), /flex:0 0 auto/);
  assert.match(declarations('.dsh-fm .fm-file-toolbar>.fm-action-group>summary'), /gap:4px/);
  assert.match(declarations('.dsh-fm .fm-file-toolbar .fm-action-popover'), /bottom:calc\(100% \+ 8px\);left:8px;max-width:calc\(100% - 16px\)/);
  assert.match(declarations('.dsh-fm .fm-action-group'), /position:relative;flex:none/);
  assert.match(declarations('.dsh-fm .fm-action-popover'), /position:absolute;top:calc\(100% \+ 4px\);left:0/);
  assert.doesNotMatch(css, /\.dsh-fm \.fm-file-toolbar \[data-fm-action-group=more\]>\.fm-action-popover\{left:auto;right:0\}/, 'desktop More shares the default left anchor after removing Up');
  assert.match(declarations('.dsh-fm .fm-file-toolbar [data-fm-action-group=more]>.fm-action-popover'), /left:auto;right:8px/);
});

test('direct checkbox selection and clear support zero/one/many without reads, navigation or inserted list rows', async t => {
  const view = await setup(t, { seed: root => writeFile(path.join(root, 'top.txt'), 'top') });
  const before = view.requests.length;
  const section = files(view);
  const scroll = node(view.renderer, { className: 'fm-scroll' });
  const children = section.children;
  assertDisabled(view, ['clear-selection'], true);
  await view.click(action('clear-selection'));
  await view.select('folder');
  assert.equal(checked(view, 'folder'), true);
  assertDisabled(view, ['clear-selection'], false);
  await view.select('top.txt');
  assert.equal(checked(view, 'top.txt'), true);
  await view.click(action('clear-selection'));
  assert.equal(checked(view, 'folder'), false);
  assert.equal(checked(view, 'top.txt'), false);
  assertDisabled(view, ['clear-selection', 'rename', 'delete', 'copy', 'copy-selected-paths', 'cut', 'reference'], true);
  assert.equal(view.requests.length, before, 'selection and clearing must remain local');
  assert.equal(files(view), section);
  assert.equal(node(view.renderer, { className: 'fm-scroll' }), scroll);
  assert.deepEqual(section.children, children, 'selection must not insert a row before the listing');
  await view.click(row('directory', 'folder'));
  assert.equal(nodes(view.renderer, row('file', 'folder/hello.txt')).length, 1);
  assert.equal(bodyOf(view.requests.filter(request => bodyOf(request).op === 'entries.list').at(-1)).path, 'folder');
});

test('ordinary preview never replaces checkbox selection and clearing retains the editor draft and task clipboard', async t => {
  const view = await setup(t, { tasks: true, seed: root => writeFile(path.join(root, 'folder', 'other.txt'), 'other') });
  await view.click(row('directory', 'folder'));
  await view.select('other.txt');
  await view.click(row('file', 'folder/hello.txt'));
  assert.equal(checked(view, 'other.txt'), true);
  assert.equal(checked(view, 'hello.txt'), false);
  editorEdit(view, 'draft survives clearing selection');
  await view.click(action('back-to-files'));
  await view.click(action('copy'));
  const injected = view.client.cells.get('main:file-manager').options.inject();
  const clipboard = injected.activity.getSnapshot().clipboard;
  const before = view.requests.length;
  await view.click(action('clear-selection'));
  assert.equal(checked(view, 'other.txt'), false);
  assert.equal(view.requests.length, before);
  assert.equal(injected.activity.getSnapshot().clipboard, clipboard);
  assert.equal(injected.documents.getSnapshot().documents[0].draft, 'draft survives clearing selection');
  await view.select('hello.txt');
  await view.click(row('file', 'folder/hello.txt'));
  assert.equal(checked(view, 'hello.txt'), true);
  assert.equal(checked(view, 'other.txt'), false);
});

test('symlink locations have direct checkboxes but their name rows remain disabled and are never followed', async t => {
  const view = await setup(t, { seed: root => symlink('folder/hello.txt', path.join(root, 'link')) });
  assert.equal(node(view.renderer, row('symlink', 'link')).props.disabled, true);
  assert.equal(node(view.renderer, { 'aria-label': '选择: link' }).props.disabled, false);
  const before = view.requests.length;
  await view.select('link');
  assert.equal(checked(view, 'link'), true);
  await act(async () => { node(view.renderer, row('symlink', 'link')).props.onClick(); });
  assert.equal(view.requests.length, before);
  await view.click(action('clear-selection'));
  assert.equal(checked(view, 'link'), false);
  assert.equal(view.requests.length, before);
  assert.equal(node(view.renderer, row('symlink', 'link')).props.disabled, true);
});

test('grouped actions preserve zero/single/multi-selection and clipboard admission gates', async t => {
  const sessions = snapshotBoundary({ ids: ['target'], byId: { target: { id: 'target', displayTitle: 'Target session', running: false } }, phase: 'ready' });
  const view = await setup(t, { tasks: true, transfers: true, mainProps: { useSessions: sessions.use }, seed: root => writeFile(path.join(root, 'second.txt'), 'second') });
  assertDisabled(view, ['new-file', 'new-directory', 'upload-files', 'upload-directory', 'download'], false);
  assertDisabled(view, ['rename', 'delete', 'copy', 'copy-selected-paths', 'cut', 'reference', 'paste', 'clear-selection'], true);
  await view.select('folder');
  assertDisabled(view, ['rename', 'delete', 'copy', 'copy-selected-paths', 'cut', 'reference', 'download', 'clear-selection'], false);
  assertDisabled(view, ['paste'], true);
  await view.click(action('copy'));
  assertDisabled(view, ['paste'], false);
  await view.select('second.txt');
  assertDisabled(view, ['rename', 'download'], true);
  assertDisabled(view, ['delete', 'copy', 'copy-selected-paths', 'cut', 'reference', 'paste', 'clear-selection'], false);
});

test('read-only capability degradation keeps groups discoverable but mutation/transfer/reference actions disabled', async t => {
  const view = await setup(t, { tasks: true, transfers: true, intercept: async (url, init, route) => {
    const response = await route(url, init);
    if (bodyOf({ init }).op !== 'bootstrap') return response;
    const envelope = await response.json();
    envelope.value.capabilities = { ...envelope.value.capabilities, write: false, tasks: false, transfers: false, references: false };
    return Response.json(envelope);
  } });
  await view.select('folder');
  assertDisabled(view, groupedActions.filter(name => !['copy-selected-paths', 'clear-selection'].includes(name)), true);
  assertDisabled(view, ['copy-selected-paths', 'copy-directory-path', 'clear-selection'], false);
  const before = view.requests.length;
  await view.click(action('clear-selection'));
  assert.equal(checked(view, 'folder'), false);
  assert.equal(view.requests.length, before);
  assertDisabled(view, ['clear-selection'], true);
  for (const name of Object.keys(GROUPS)) assert.equal(node(view.renderer, { 'data-fm-action-group': name }).type, 'details');
});

test('breadcrumbs navigate exact parent levels while the dedicated up action is absent', async t => {
  const view = await setup(t, { seed: root => mkdir(path.join(root, 'folder', 'child')) });
  assert.equal(nodes(view.renderer, action('up')).length, 0);
  assert.equal(files(view).findAll(candidate => candidate.type === 'nav' && candidate.props.className === 'fm-crumbs').length, 1);
  const rootCrumb = () => node(view.renderer, { 'aria-label': '路径' }).findAllByType('button')[0];
  const before = view.requests.length;
  await act(async () => { rootCrumb().props.onClick(); await view.settle(); });
  assert.equal(view.requests.length, before + 1);
  assert.equal(bodyOf(view.requests.at(-1)).path, '');
  await view.click(row('directory', 'folder'));
  await view.click(row('directory', 'folder/child'));
  const crumbs = node(view.renderer, { 'aria-label': '路径' }).findAllByType('button');
  assert.equal(crumbs.length, 3);
  await act(async () => { crumbs[1].props.onClick(); await view.settle(); });
  let listings = view.requests.map(bodyOf).filter(body => body.op === 'entries.list');
  assert.equal(listings.at(-1).path, 'folder');
  assert.equal(nodes(view.renderer, row('directory', 'folder/child')).length, 1);
  await act(async () => { rootCrumb().props.onClick(); await view.settle(); });
  listings = view.requests.map(bodyOf).filter(body => body.op === 'entries.list');
  assert.equal(listings.at(-1).path, '');
  assert.equal(nodes(view.renderer, action('up')).length, 0);
});

test('an unopenable root disables file actions and exposes no locations entry', async t => {
  const view = await setup(t, { intercept: async (url, init, route) => {
    const response = await route(url, init);
    if (bodyOf({ init }).op !== 'bootstrap') return response;
    const envelope = await response.json();
    envelope.value.root = null;
    envelope.value.degraded = { scope: 'filesystem', code: 'ROOT_UNAVAILABLE', message: 'The browsing root could not be opened.', readOnly: false };
    return Response.json(envelope);
  } });
  assert.equal(nodes(view.renderer, { 'data-fm-notice-dismiss': 'error' }).length, 0);
  assertDisabled(view, [...groupedActions, 'copy-directory-path', 'refresh'], true);
  // Nothing to open: the locations entry and its drawer are gone, and the panel
  // says why the list is empty instead of offering a way to add a directory.
  assert.deepEqual(nodes(view.renderer, { 'data-fm-action': 'empty-locations' }), []);
  assert.deepEqual(nodes(view.renderer, { 'data-fm-overlay': 'roots' }), []);
  assert.equal(nodes(view.renderer, { 'data-fm-no-root': 'unavailable' }).length, 1);
});

test('pending directory navigation disables every grouped action and clearing control', async t => {
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { started = resolve; });
  t.after(() => release());
  const view = await setup(t, { tasks: true, transfers: true, intercept: async (url, init, route) => {
    const body = bodyOf({ init });
    if (body.op === 'entries.list' && body.path === 'folder') { started(); await gate; }
    return route(url, init);
  } });
  let navigation;
  await act(async () => { navigation = node(view.renderer, row('directory', 'folder')).props.onClick(); await waiting; });
  assertDisabled(view, [...groupedActions, 'copy-directory-path', 'refresh'], true);
  const before = view.requests.length;
  await act(async () => { node(view.renderer, action('clear-selection')).props.onClick(); });
  assert.equal(view.requests.length, before);
  await act(async () => { release(); await navigation; await view.settle(); });
  assertDisabled(view, ['clear-selection'], true);
});

test('a saving selected document retains rename/delete/copy/cut gates inside the more disclosure', async t => {
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { started = resolve; });
  t.after(() => release());
  const view = await setup(t, { tasks: true, intercept: async (url, init, route) => {
    const response = await route(url, init);
    if (url === '/api/file-manager/v2/text' && init.method === 'POST' && bodyOf({ init }).op === 'save') { started(); await gate; }
    return response;
  } });
  await view.openHello();
  editorEdit(view, 'saving selected file');
  let saving;
  await act(async () => { saving = node(view.renderer, action('save')).props.onClick(); await waiting; });
  assertDisabled(view, ['rename', 'delete', 'copy', 'cut', 'copy-selected-paths', 'clear-selection'], true);
  await act(async () => { release(); await saving; await view.settle(); });
  assertDisabled(view, ['rename', 'delete', 'copy', 'cut', 'copy-selected-paths', 'clear-selection'], false);
});
