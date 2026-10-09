import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { act, node, nodes, setup, textOf } from './client-harness.mjs';

const current = { 'data-fm-action': 'copy-directory-path' };
const selected = { 'data-fm-action': 'copy-selected-paths' };
const result = status => ({ 'data-fm-path-copy-result': status });
const manual = { 'data-fm-path-copy-text': true };
const dismiss = { 'data-fm-notice-dismiss': 'path-copy' };
const browser = writeText => ({ navigator: { clipboard: { writeText } } });
const openFolder = view => view.click({ 'data-fm-entry': 'directory', 'data-fm-path': 'folder' });
const preview = view => view.click({ 'data-fm-entry': 'file', 'data-fm-path': 'folder/hello.txt' });

// The shipped bundle + real Host router, with only browser clipboard I/O stubbed.
test('current directory copy ignores selection, makes no requests and has an accessible compact entry', async t => {
  const copied = [];
  const view = await setup(t, { window: browser(async text => { copied.push(text); }) });
  const control = node(view.renderer, current);
  assert.equal(control.props['aria-label'], '复制当前目录路径');
  assert.equal(control.props.title, '复制当前目录路径');
  assert.equal(node(view.renderer, selected).props.disabled, true);
  await view.click(current);
  assert.equal(copied.pop(), view.root);
  await openFolder(view);
  await view.select('hello.txt');
  const before = view.requests.length;
  await view.click(current);
  assert.equal(copied.pop(), `${view.root}/folder`);
  assert.equal(view.requests.length, before);
  assert.equal(textOf(node(view.renderer, result('copied'))), '已复制');
  await view.click(dismiss);
  assert.equal(nodes(view.renderer, result('copied')).length, 0);
  await view.click(current);
  assert.equal(nodes(view.renderer, result('copied')).length, 1);
});

test('opening a preview neither checks a file nor replaces existing checkbox selection', async t => {
  const copied = [];
  const view = await setup(t, {
    window: browser(async text => { copied.push(text); }),
    seed: root => writeFile(path.join(root, 'folder', 'other.txt'), 'other'),
  });
  await openFolder(view);
  await preview(view);
  assert.equal(node(view.renderer, { 'aria-label': '选择: hello.txt' }).props.checked, false);
  assert.equal(node(view.renderer, selected).props.disabled, true);
  await view.select('other.txt');
  await preview(view);
  assert.equal(node(view.renderer, { 'aria-label': '选择: other.txt' }).props.checked, true);
  assert.equal(node(view.renderer, { 'aria-label': '选择: hello.txt' }).props.checked, false);
  await view.click(selected);
  assert.deepEqual(copied, [`${view.root}/folder/other.txt`]);
  await view.select('other.txt', false);
  assert.equal(node(view.renderer, selected).props.disabled, true);
});

test('multi-selection copies files, directories and link locations in listing order without quoting', async t => {
  const copied = [];
  const file = '中文 " spaced @ file.txt';
  const view = await setup(t, { window: browser(async text => { copied.push(text); }), seed: async root => {
    await writeFile(path.join(root, 'folder', file), 'text');
    await mkdir(path.join(root, 'folder', 'child dir'));
    await symlink('hello.txt', path.join(root, 'folder', 'link'));
  } });
  await openFolder(view);
  const entries = nodes(view.renderer, { className: 'fm-selection' }).map(item => item.props['aria-label'].slice('选择: '.length));
  for (const name of [...entries].reverse()) await view.select(name);
  const before = view.requests.length;
  await view.click(selected);
  assert.equal(view.requests.length, before, 'copy must not stat entries or follow a symlink');
  assert.deepEqual(copied, [entries.map(name => `${view.root}/folder/${name}`).join('\n')]);
  assert.equal(textOf(node(view.renderer, result('copied'))), `已复制 ${entries.length} 条路径`);
  assert.equal(copied[0].endsWith('\n'), false);
  await view.click(current);
  assert.equal(copied.at(-1), `${view.root}/folder`);
});

test('known paths remain copyable when entries have disappeared from disk', async t => {
  const copied = [];
  const view = await setup(t, { window: browser(async text => { copied.push(text); }) });
  await openFolder(view);
  await view.select('hello.txt');
  const file = path.join(view.root, 'folder', 'hello.txt');
  assert.equal(file, `${view.root}/folder/hello.txt`);
  await unlink(file);
  const before = view.requests.length;
  await view.click(selected);
  assert.deepEqual(copied, [file]);
  assert.equal(view.requests.length, before);
});

test('read-only degradation still allows both path-copy actions', async t => {
  const copied = [];
  const view = await setup(t, { window: browser(async text => { copied.push(text); }), intercept: async (url, init, route) => {
    const response = await route(url, init);
    if (init.body && JSON.parse(init.body).op === 'bootstrap') {
      const body = await response.json();
      body.value.capabilities = { ...body.value.capabilities, write: false, tasks: false, transfers: false, references: false };
      body.value.degraded = { scope: 'writes', code: 'READ_ONLY', message: 'Read-only fixture', readOnly: true };
      return Response.json(body);
    }
    return response;
  } });
  await openFolder(view);
  await view.select('hello.txt');
  assert.equal(node(view.renderer, { 'data-fm-action': 'copy' }).props.disabled, true);
  assert.equal(node(view.renderer, { 'data-fm-action': 'rename' }).props.disabled, true);
  assert.equal(node(view.renderer, current).props.disabled, false);
  assert.equal(node(view.renderer, selected).props.disabled, false);
  const before = view.requests.length;
  await view.click(current);
  await view.click(selected);
  assert.deepEqual(copied, [`${view.root}/folder`, `${view.root}/folder/hello.txt`]);
  assert.equal(view.requests.length, before);
});

test('filesystem root formatting preserves / without generating //', async t => {
  const copied = [];
  const view = await setup(t, { window: browser(async text => { copied.push(text); }), intercept: async (url, init, route) => {
    const response = await route(url, init);
    if (init.body && JSON.parse(init.body).op === 'bootstrap') {
      const body = await response.json();
      // Only presentation metadata changes; all real filesystem access stays in the fixture root.
      body.value.roots = body.value.roots.map(root => ({ ...root, path: '/' }));
      return Response.json(body);
    }
    return response;
  } });
  await view.click(current);
  await view.select('folder');
  await view.click(selected);
  await openFolder(view);
  await view.select('hello.txt');
  await view.click(current);
  await view.click(selected);
  assert.deepEqual(copied, ['/', '/folder', '/folder', '/folder/hello.txt']);
});

for (const [name, window] of [
  ['missing clipboard API', { navigator: {} }],
  ['synchronous throw', browser(() => { throw new Error('blocked'); })],
  ['asynchronous rejection', browser(async () => { throw new Error('denied'); })],
]) {
  test(`${name} exposes complete readonly text and never reports success`, async t => {
    const view = await setup(t, { window });
    await view.click(current);
    assert.equal(nodes(view.renderer, result('copied')).length, 0);
    assert.equal(nodes(view.renderer, result('failed')).length, 1);
    const field = node(view.renderer, manual);
    assert.equal(field.props.value, view.root);
    assert.equal(field.props.readOnly, true);
    assert.equal(field.props['aria-label'], '手动复制的路径文本');
    assert.match(textOf(node(view.renderer, result('failed'))), /手动复制/);
    await view.click(dismiss);
    assert.equal(nodes(view.renderer, manual).length, 0);
    await view.click(current);
    assert.equal(nodes(view.renderer, manual).length, 1);
  });
}

test('a failed multi-path copy preserves every path; a later success clears the fallback', async t => {
  let denied = true;
  const view = await setup(t, { window: browser(async () => { if (denied) throw new Error('denied'); }), seed: root => writeFile(path.join(root, 'other.txt'), '') });
  await view.select('other.txt');
  await view.select('folder');
  await view.click(selected);
  assert.equal(node(view.renderer, manual).props.value, `${view.root}/folder\n${view.root}/other.txt`);
  denied = false;
  await view.click(current);
  assert.equal(nodes(view.renderer, manual).length, 0);
  assert.equal(nodes(view.renderer, result('failed')).length, 0);
  assert.equal(nodes(view.renderer, result('copied')).length, 1);
});

test('pending clipboard write serializes clicks and reports success only after completion', async t => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  t.after(() => resolve());
  const copied = [];
  const view = await setup(t, { window: browser(text => { copied.push(text); return pending; }) });
  await view.select('folder');
  const click = node(view.renderer, current).props.onClick;
  act(() => { click(); click(); });
  assert.deepEqual(copied, [view.root], 'the write starts in the click call stack, exactly once');
  assert.equal(node(view.renderer, current).props.disabled, true);
  assert.equal(node(view.renderer, selected).props.disabled, true);
  assert.equal(nodes(view.renderer, result('copied')).length, 0);
  await act(async () => { resolve(); await pending; });
  assert.equal(node(view.renderer, current).props.disabled, false);
  assert.equal(node(view.renderer, selected).props.disabled, false);
  assert.equal(nodes(view.renderer, result('copied')).length, 1);
});

test('an old copy completion after remount cannot reopen a notice', async t => {
  let reject;
  const pending = new Promise((_, fail) => { reject = fail; });
  const view = await setup(t, { window: browser(() => pending) });
  act(() => node(view.renderer, current).props.onClick());
  view.unmount();
  await view.mount();
  await act(async () => { reject(new Error('late rejection')); await pending.catch(() => {}); });
  assert.equal(nodes(view.renderer, result('failed')).length, 0);
  assert.equal(nodes(view.renderer, result('copied')).length, 0);
  assert.equal(node(view.renderer, current).props.disabled, false);
});

for (const operation of ['copy', 'cut']) {
  test(`path copying preserves the ${operation} task clipboard and the subsequent paste`, async t => {
    const view = await setup(t, { tasks: true, window: browser(async () => {}) });
    await view.openHello();
    await view.click({ 'data-fm-action': operation });
    const before = view.requests.length;
    await view.click(current);
    await view.click(selected);
    assert.equal(view.requests.length, before);
    assert.equal(node(view.renderer, { 'data-fm-action': 'paste' }).props.disabled, false);
    await view.click({ 'data-fm-root': true });
    await view.click({ 'data-fm-action': 'paste' });
    await view.click({ 'data-fm-action': 'paste-confirm' });
    const [task] = await view.tasks.list();
    assert.ok(task);
    assert.equal(task.operation, operation === 'cut' ? 'move' : 'copy');
    const done = await view.waitForTask(task.id);
    assert.equal(done.status, 'completed');
    assert.equal(await readFile(path.join(view.root, 'hello.txt'), 'utf8'), '<script>not executable</script>\n你好');
    assert.equal(view.requests.some(item => item.init.body && JSON.parse(item.init.body).op === 'references.prepare'), false);
  });
}

test('without roots both copy actions are disabled', async t => {
  const copied = [];
  const view = await setup(t, { window: browser(async text => { copied.push(text); }), intercept: async (url, init, route) => {
    const response = await route(url, init);
    if (init.body && JSON.parse(init.body).op === 'bootstrap') {
      const body = await response.json();
      body.value.roots = [];
      return Response.json(body);
    }
    return response;
  } });
  assert.equal(nodes(view.renderer, { 'data-fm-notice-dismiss': 'error' }).length, 0, 'bootstrap must succeed, not merely leave controls disabled after an error');
  assert.equal(node(view.renderer, current).props.disabled, true);
  assert.equal(node(view.renderer, selected).props.disabled, true);
  await view.click(current);
  await view.click(selected);
  assert.deepEqual(copied, []);
});

// jsdom selection semantics only; no claim about OS clipboard permissions or pixels.
test('manual fallback in the shipped DOM retains literal text and selects it on focus', async t => {
  const { installDom } = await import('./editor-dom-harness.mjs');
  const { loadClient } = await import('./client-harness.mjs');
  const env = installDom();
  const { createRoot } = await import('react-dom/client');
  const React = await import('react');
  const rootPath = '/work/中文 "<script>" & spaced';
  const fetch = async (url, init) => {
    const op = init.body ? JSON.parse(init.body).op : '';
    if (op === 'bootstrap') return Response.json({ ok: true, value: { roots: [{ id: 'root', path: rootPath, label: 'root' }], workspaces: [], capabilities: {}, limits: {} } });
    if (op === 'entries.list') return Response.json({ ok: true, value: { rootId: 'root', path: '', entries: [], total: 0, nextCursor: null, unaddressable: [] } });
    throw new Error(`Unexpected request: ${url} ${op}`);
  };
  const client = await loadClient(fetch, { window: { navigator: env.window.navigator } });
  // Keep a real DOM window for React; do not spread jsdom's storage getters.
  globalThis.window = env.window;
  const registration = client.cells.get('main:file-manager');
  const mount = env.document.createElement('div');
  env.body.append(mount);
  const renderer = createRoot(mount);
  t.after(async () => { await act(async () => renderer.unmount()); await client.dispose(); env.restore(); });
  await act(async () => {
    renderer.render(React.createElement(registration.component, { t: client.t, ...registration.options.inject?.() }));
    await new Promise(resolve => setImmediate(resolve));
  });
  await act(async () => mount.querySelector('[data-fm-action="copy-directory-path"]').click());
  const textarea = mount.querySelector('[data-fm-path-copy-text]');
  assert.ok(textarea);
  assert.equal(textarea.value, rootPath);
  assert.equal(textarea.readOnly, true);
  assert.equal(mount.querySelectorAll('script').length, 0);
  await act(async () => textarea.focus());
  assert.equal(textarea.selectionStart, 0);
  assert.equal(textarea.selectionEnd, rootPath.length);
});

// Regression for a changing directory: navigation failure must retain the copy target.
test('failed navigation leaves current-directory copy bound to the displayed directory', async t => {
  const copied = [];
  const view = await setup(t, { window: browser(async text => { copied.push(text); }), intercept: (url, init, route) => {
    const body = init.body ? JSON.parse(init.body) : {};
    if (body.op === 'entries.list' && body.path === 'folder') return Response.json({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'test' } }, { status: 403 });
    return route(url, init);
  } });
  await openFolder(view);
  await view.click(current);
  assert.deepEqual(copied, [view.root]);
});
