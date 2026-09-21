import assert from 'node:assert/strict';
import { access, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { act, loadClient, node, nodes, setup, textOf, uiBoundary, React, TestRenderer, snapshotBoundary } from './client-harness.mjs';

// ABI/component tests use React's official renderer and the real Host handlers.
// They are not visual previews or substitutes for installed Web UI verification.
test('Client contributes an additive sidebar icon and independent main panel', async t => {
  const client = await loadClient(async () => new Response(JSON.stringify({ ok: true, value: { roots: [], workspaces: [] } })));
  t.after(client.dispose);
  assert.ok(client.cells.has('sidebar.panellist:file-manager'));
  assert.ok(client.cells.has('main:file-manager'));
  assert.equal(client.cells.has('main:conversation'), false);
  assert.equal(client.cells.has('root:undefined'), false);
});

test('the standalone panel browses a subdirectory without a Session binding', async t => {
  const view = await setup(t);
  await view.click({ 'data-fm-entry': 'directory', 'data-fm-path': 'folder' });
  const files = nodes(view.renderer, { 'data-fm-entry': 'file' });
  assert.equal(files.length, 1);
  assert.equal(files[0].props['data-fm-path'], 'folder/hello.txt');
});

test('row selection keeps an accessible name without repeating the filename as visible text', async t => {
  const view = await setup(t, { tasks: true });
  const row = node(view.renderer, { className: 'fm-entryline' });
  const checkbox = node(view.renderer, { type: 'checkbox', 'aria-label': '选择: folder' });
  assert.equal(textOf(row), 'folder', 'selection instructions must not become a second visible filename');
  act(() => checkbox.props.onChange({ target: { checked: true } }));
  assert.equal(node(view.renderer, { type: 'checkbox', 'aria-label': '选择: folder' }).props.checked, true);
  assert.equal(nodes(view.renderer, { 'data-fm-path': 'folder/hello.txt' }).length, 0, 'selection must not enter the directory');
  assert.equal(node(view.renderer, { 'data-fm-action': 'copy' }).props.disabled, false);
});

test('long Unicode filenames have one visible label and a complete accessible selection name', async t => {
  const filename = `${'较长的文件名称_'.repeat(6)}结尾.txt`;
  const view = await setup(t, { seed: root => writeFile(path.join(root, filename), 'data') });
  const row = nodes(view.renderer, { className: 'fm-entryline' }).find(item => item.findAllByProps({ 'data-fm-path': filename }).length > 0);
  assert.ok(row);
  assert.equal(textOf(row).split(filename).length - 1, 1, 'the checkbox must not repeat a long filename in the visible row');
  assert.equal(node(view.renderer, { type: 'checkbox', 'aria-label': `选择: ${filename}` }).props.checked, false);
});

for (const action of ['new-file', 'new-directory', 'rename']) {
  test(`${action} uses the shared themed Input inside its own portal content scope`, async t => {
    const view = await setup(t);
    if (action === 'rename') await view.openHello();
    await view.click({ 'data-fm-action': action });
    const dialog = view.renderer.root.findAllByType(uiBoundary.Modal).find(item => item.props.open);
    assert.ok(dialog);
    assert.equal(dialog.props.contentClassName, 'dsh-fm-dialog', 'portaled fields cannot depend on a .dsh-fm ancestor');
    assert.equal(dialog.findAllByType(uiBoundary.Input).length, 1, 'the field must use the public self-styled Input rather than an unstyled native input');
    assert.equal(dialog.findAll(item => item.type === 'label' && item.props.className === 'fm-field').length, 1);
    assert.equal(node(view.renderer, { 'data-fm-name': true }).props['aria-label'], '名称');
  });
}

test('the add-directory input defaults to slash without a workspace candidate', async t => {
  const view = await setup(t);
  assert.equal(node(view.renderer, { 'data-fm-add-path': true }).props.value, '/');
  assert.equal(view.manager.listRoots().length, 1, 'a default input must not automatically grant filesystem access');
});

test('bootstrap leaves slash as the default while still listing workspace candidates', async t => {
  const view = await setup(t, { controlOptions: { workspaces: () => [{ id: 'workspace-a', path: '/workspace/specific/project', title: 'Project' }] } });
  assert.equal(node(view.renderer, { 'data-fm-add-path': true }).props.value, '/');
  assert.equal(nodes(view.renderer, { value: '/workspace/specific/project' }).filter(item => item.type === 'option').length, 1);
});

test('a delayed bootstrap cannot overwrite an already entered directory path', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const view = await setup(t, {
    settleInitial: false,
    controlOptions: { workspaces: () => [{ id: 'workspace-a', path: '/workspace/specific/project', title: 'Project' }] },
    intercept: async (url, init, route) => {
      const response = await route(url, init);
      if (init.body && JSON.parse(init.body).op === 'bootstrap') await gate;
      return response;
    },
  });
  act(() => node(view.renderer, { 'data-fm-add-path': true }).props.onChange({ target: { value: '/chosen/by/user' } }));
  await act(async () => { release(); while (view.pending.size) await Promise.all([...view.pending]); });
  assert.equal(node(view.renderer, { 'data-fm-add-path': true }).props.value, '/chosen/by/user');
});

test('the directory form adds an explicit root without changing existing grants', async t => {
  const view = await setup(t);
  act(() => node(view.renderer, { 'data-fm-add-path': true }).props.onChange({ target: { value: path.join(view.root, 'folder') } }));
  await act(async () => {
    await node(view.renderer, { 'data-fm-add-root': true }).props.onSubmit({ preventDefault() {} });
    while (view.pending.size) await Promise.all([...view.pending]);
  });
  assert.equal((await view.manager.listRoots()).length, 2);
  assert.equal(nodes(view.renderer, { 'data-fm-root': true }).length, 2);
});

test('all text snapshots use the control POST rather than the unsupported text GET route', async t => {
  const view = await setup(t);
  await view.openHello();
  assert.equal(view.requests.some(item => item.url.startsWith('/api/file-manager/text') && item.init.method === 'GET'), false);
  assert.ok(view.requests.some(item => item.url === '/api/file-manager/control' && JSON.parse(item.init.body).op === 'text.read'));
  assert.equal(textOf(node(view.renderer, { 'data-fm-preview': 'text' })), '<script>not executable</script>\n你好');
  await view.click({ 'data-fm-action': 'edit' });
  act(() => node(view.renderer, { 'data-fm-editor': true }).props.onChange({ target: { value: 'verified after save' } }));
  await view.click({ 'data-fm-action': 'save' });
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), 'verified after save');
  assert.ok(view.requests.filter(item => item.url === '/api/file-manager/control' && JSON.parse(item.init.body).op === 'text.read').length >= 2, 'save receipt verification also requires the working control snapshot route');
  assert.equal(nodes(view.renderer, { 'data-fm-document-state': 'clean' }).length, 1);
});

test('editing and saving through the text route preserves UTF-8 BOM and CRLF', async t => {
  const view = await setup(t, { seed: root => writeFile(path.join(root, 'folder/hello.txt'), '\ufeff第一行\r\n第二行\r\n') });
  await view.openHello();
  await view.click({ 'data-fm-action': 'edit' });
  act(() => node(view.renderer, { 'data-fm-editor': true }).props.onChange({ target: { value: '已修改\n第二行\n' } }));
  await view.click({ 'data-fm-action': 'save' });
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), '\ufeff已修改\r\n第二行\r\n');
  assert.equal(node(view.renderer, { 'data-fm-editor': true }).props.value, '已修改\n第二行\n');
  assert.equal(node(view.renderer, { 'data-fm-document-state': 'clean' }).children.length > 0, true);
  const request = view.requests.find(item => item.url === '/api/file-manager/text' && item.init.method === 'POST' && JSON.parse(item.init.body).op === 'save');
  const payload = JSON.parse(request.init.body);
  assert.equal(payload.op, 'save');
  assert.equal(typeof payload.requestId, 'string');
  assert.equal(typeof payload.expectedVersion, 'string');
});

test('an unsaved draft survives unmounting and remounting the standalone main panel', async t => {
  const view = await setup(t);
  await view.openHello();
  await view.click({ 'data-fm-action': 'edit' });
  act(() => node(view.renderer, { 'data-fm-editor': true }).props.onChange({ target: { value: '面板切换保留' } }));
  view.unmount();
  await view.mount();
  assert.equal(node(view.renderer, { 'data-fm-editor': true }).props.value, '面板切换保留');
  assert.equal(node(view.renderer, { 'data-fm-document-state': 'dirty' }).children.length > 0, true);
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), '<script>not executable</script>\n你好');
});

test('a save conflict exposes disk and local text without overwriting either', async t => {
  const view = await setup(t);
  await view.openHello();
  await view.click({ 'data-fm-action': 'edit' });
  act(() => node(view.renderer, { 'data-fm-editor': true }).props.onChange({ target: { value: '本地草稿' } }));
  await writeFile(path.join(view.root, 'folder/hello.txt'), '外部写入');
  await view.click({ 'data-fm-action': 'save' });
  assert.equal(node(view.renderer, { 'data-fm-editor': true }).props.value, '本地草稿');
  assert.equal(textOf(node(view.renderer, { 'data-fm-conflict': 'disk' })), '外部写入');
  assert.equal(textOf(node(view.renderer, { 'data-fm-conflict': 'draft' })), '本地草稿');
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), '外部写入');
  await view.click({ 'data-fm-action': 'rebase' });
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), '外部写入');
  await view.click({ 'data-fm-action': 'save' });
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), '本地草稿');
});

test('manual refresh flags external changes without replacing a dirty editor', async t => {
  const view = await setup(t);
  await view.openHello();
  await view.click({ 'data-fm-action': 'edit' });
  act(() => node(view.renderer, { 'data-fm-editor': true }).props.onChange({ target: { value: 'keep draft' } }));
  await writeFile(path.join(view.root, 'folder/hello.txt'), 'external');
  await view.click({ 'data-fm-action': 'refresh' });
  assert.equal(node(view.renderer, { 'data-fm-editor': true }).props.value, 'keep draft');
  assert.equal(nodes(view.renderer, { 'data-fm-external-change': true }).length, 1);
});

test('closing a dirty editor supports cancel and explicit discard without a disk write', async t => {
  const view = await setup(t);
  await view.openHello();
  await view.click({ 'data-fm-action': 'edit' });
  act(() => node(view.renderer, { 'data-fm-editor': true }).props.onChange({ target: { value: 'do not lose silently' } }));
  await view.click({ 'data-fm-action': 'close-document' });
  assert.equal(view.renderer.root.findAllByType(uiBoundary.Modal).some(modal => modal.props.open), true);
  await view.click({ 'data-fm-action': 'close-cancel' });
  assert.equal(node(view.renderer, { 'data-fm-editor': true }).props.value, 'do not lose silently');
  await view.click({ 'data-fm-action': 'close-document' });
  await view.click({ 'data-fm-action': 'close-discard' });
  assert.equal(nodes(view.renderer, { 'data-fm-editor': true }).length, 0);
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), '<script>not executable</script>\n你好');
});

test('saving from the close prompt closes only after the exact snapshot is verified', async t => {
  const view = await setup(t);
  await view.openHello();
  await view.click({ 'data-fm-action': 'edit' });
  act(() => node(view.renderer, { 'data-fm-editor': true }).props.onChange({ target: { value: 'save before close' } }));
  await view.click({ 'data-fm-action': 'close-document' });
  await view.click({ 'data-fm-action': 'close-save' });
  assert.equal(nodes(view.renderer, { 'data-fm-editor': true }).length, 0);
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), 'save before close');
});

test('typing while a save is in flight remains dirty after its receipt arrives', async t => {
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const saving = new Promise(resolve => { started = resolve; });
  const view = await setup(t, { intercept: async (url, init, route) => {
    const response = await route(url, init);
    if (url === '/api/file-manager/text' && init.method === 'POST' && JSON.parse(init.body).op === 'save') { started(); await gate; }
    return response;
  } });
  await view.openHello();
  await view.click({ 'data-fm-action': 'edit' });
  act(() => node(view.renderer, { 'data-fm-editor': true }).props.onChange({ target: { value: 'submitted' } }));
  let save;
  await act(async () => { save = node(view.renderer, { 'data-fm-action': 'save' }).props.onClick(); await saving; });
  act(() => node(view.renderer, { 'data-fm-editor': true }).props.onChange({ target: { value: 'newer typing' } }));
  await act(async () => { release(); await save; });
  await view.flush();
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), 'submitted');
  assert.equal(node(view.renderer, { 'data-fm-editor': true }).props.value, 'newer typing');
  assert.equal(nodes(view.renderer, { 'data-fm-document-state': 'dirty' }).length, 1);
});

test('a Host without the write capability cannot expose active mutation controls', async t => {
  const view = await setup(t, { intercept: async (url, init, route) => {
    const response = await route(url, init);
    if (init.body && JSON.parse(init.body).op === 'bootstrap') {
      const envelope = await response.json();
      envelope.value.capabilities.write = false;
      return new Response(JSON.stringify(envelope));
    }
    return response;
  } });
  await view.openHello();
  const edit = nodes(view.renderer, { 'data-fm-action': 'edit' });
  assert.ok(edit.length === 0 || edit[0].props.disabled);
  assert.equal(view.requests.some(item => item.init.method === 'POST' && item.url === '/api/file-manager/text'), false);
  assert.equal(view.requests.some(item => item.url.startsWith('/api/file-manager/text')), false, 'old read-only Hosts have only the control route');
  assert.equal(textOf(node(view.renderer, { 'data-fm-preview': 'text' })), '<script>not executable</script>\n你好');
});

test('new file creation publishes an empty file in the browsed directory', async t => {
  const view = await setup(t);
  await view.click({ 'data-fm-entry': 'directory', 'data-fm-path': 'folder' });
  await view.click({ 'data-fm-action': 'new-file' });
  act(() => node(view.renderer, { 'data-fm-name': true }).props.onChange({ target: { value: '新文件.txt' } }));
  await view.click({ 'data-fm-action': 'name-submit' });
  assert.equal(await readFile(path.join(view.root, 'folder/新文件.txt'), 'utf8'), '');
  assert.equal(nodes(view.renderer, { 'data-fm-path': 'folder/新文件.txt' }).length, 1);
  assert.equal(textOf(node(view.renderer, { 'data-fm-preview': 'text' })), '');
});

test('new directory creation refuses to replace an existing name', async t => {
  const view = await setup(t);
  await view.click({ 'data-fm-action': 'new-directory' });
  act(() => node(view.renderer, { 'data-fm-name': true }).props.onChange({ target: { value: 'folder' } }));
  await view.click({ 'data-fm-action': 'name-submit' });
  assert.ok(nodes(view.renderer, { role: 'alert' }).some(element => textOf(element).includes('已存在')));
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), '<script>not executable</script>\n你好');
  act(() => node(view.renderer, { 'data-fm-name': true }).props.onChange({ target: { value: '新目录' } }));
  await view.click({ 'data-fm-action': 'name-submit' });
  assert.equal((await stat(path.join(view.root, '新目录'))).isDirectory(), true);
});

test('renaming a selected edited file relocates its unsaved draft', async t => {
  const view = await setup(t);
  await view.openHello();
  await view.click({ 'data-fm-action': 'edit' });
  act(() => node(view.renderer, { 'data-fm-editor': true }).props.onChange({ target: { value: '草稿跟随重命名' } }));
  await view.click({ 'data-fm-action': 'rename' });
  assert.ok(view.requests.some(item => item.init.body && JSON.parse(item.init.body).op === 'entries.stat' && JSON.parse(item.init.body).path === 'folder/hello.txt'), 'rename confirmation must capture a strong source version');
  act(() => node(view.renderer, { 'data-fm-name': true }).props.onChange({ target: { value: '改名.txt' } }));
  await view.click({ 'data-fm-action': 'name-submit' });
  await assert.rejects(access(path.join(view.root, 'folder/hello.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(view.root, 'folder/改名.txt'), 'utf8'), '<script>not executable</script>\n你好');
  assert.equal(node(view.renderer, { 'data-fm-editor': true }).props.value, '草稿跟随重命名');
  await view.click({ 'data-fm-action': 'save' });
  assert.equal(await readFile(path.join(view.root, 'folder/改名.txt'), 'utf8'), '草稿跟随重命名');
});

test('removing a root entry opens an explicit non-deleting confirmation and cancellation revokes nothing', async t => {
  const view = await setup(t);
  await view.click({ title: '只移除这个入口，不删除磁盘文件' });
  assert.equal(view.manager.listRoots().length, 1, 'the sidebar action must not revoke a grant before confirmation');
  const dialog = view.renderer.root.findAllByType(uiBoundary.Modal).find(item => item.props.open);
  assert.ok(dialog);
  assert.match(dialog.props.description, /不会删除.*磁盘/);
  assert.ok(textOf(node(view.renderer, { 'data-fm-remove-root-preview': true })).includes(view.root));
  const staleConfirm = node(view.renderer, { 'data-fm-action': 'remove-root-confirm' }).props.onClick;
  await view.click({ 'data-fm-action': 'remove-root-cancel' });
  await act(async () => { await staleConfirm(); });
  assert.equal(view.manager.listRoots().length, 1);
  await access(path.join(view.root, 'folder/hello.txt'));
  assert.equal(view.requests.some(item => item.init.body && JSON.parse(item.init.body).op === 'roots.remove'), false);
});

test('confirmed root removal revokes only its entry and preserves disk files and the dirty draft', async t => {
  const view = await setup(t);
  await view.openHello(); await view.click({ 'data-fm-action': 'edit' });
  act(() => node(view.renderer, { 'data-fm-editor': true }).props.onChange({ target: { value: 'retained after grant removal' } }));
  const rootId = view.manager.listRoots()[0].id;
  await view.click({ title: '只移除这个入口，不删除磁盘文件' });
  await view.click({ 'data-fm-action': 'remove-root-confirm' });
  assert.equal(view.manager.listRoots().length, 0);
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), '<script>not executable</script>\n你好');
  assert.equal(node(view.renderer, { 'data-fm-editor': true }).props.value, 'retained after grant removal');
  assert.equal(nodes(view.renderer, { 'data-fm-missing': true }).length, 1);
  const removals = view.requests.filter(item => item.init.body && JSON.parse(item.init.body).op === 'roots.remove');
  assert.equal(removals.length, 1);
  assert.equal(JSON.parse(removals[0].init.body).rootId, rootId);
  assert.equal(view.requests.some(item => item.init.body && JSON.parse(item.init.body).op === 'delete.commit'), false);
});

test('permanent deletion shows a cancellable preparation dialog before the server manifest arrives', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const preparing = new Promise(resolve => { started = resolve; });
  t.after(() => release());
  const view = await setup(t, { intercept: async (url, init, route) => {
    const response = await route(url, init);
    if (init.body && JSON.parse(init.body).op === 'delete.prepare') { started(); await gate; }
    return response;
  } });
  await view.openHello();
  let operation;
  await act(async () => { operation = node(view.renderer, { 'data-fm-action': 'delete' }).props.onClick(); await preparing; });
  assert.equal(nodes(view.renderer, { 'data-fm-delete-phase': 'preparing' }).length, 1);
  assert.equal(node(view.renderer, { 'data-fm-action': 'delete-cancel' }).props.disabled, false);
  assert.equal(node(view.renderer, { 'data-fm-action': 'delete-confirm' }).props.disabled, true);
  assert.equal(node(view.renderer, { 'aria-label': '我确认永久删除不可恢复' }).props.disabled, true);
  act(() => node(view.renderer, { 'aria-label': '我确认永久删除不可恢复' }).props.onChange({ target: { checked: true } }));
  await act(async () => { await node(view.renderer, { 'data-fm-action': 'delete-confirm' }).props.onClick(); });
  assert.equal(view.requests.some(item => item.init.body && JSON.parse(item.init.body).op === 'delete.commit'), false);
  await act(async () => { release(); await operation; });
  assert.equal(nodes(view.renderer, { 'data-fm-delete-phase': 'ready' }).length, 1);
  assert.equal(node(view.renderer, { 'aria-label': '我确认永久删除不可恢复' }).props.checked, false, 'acknowledgement before the manifest exists cannot authorize deletion');
  assert.equal(node(view.renderer, { 'data-fm-action': 'delete-confirm' }).props.disabled, true);
  await access(path.join(view.root, 'folder/hello.txt'));
});

test('cancelling deletion preparation prevents a late manifest from reopening or deleting anything', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const preparing = new Promise(resolve => { started = resolve; });
  t.after(() => release());
  const view = await setup(t, { intercept: async (url, init, route) => {
    const response = await route(url, init);
    if (init.body && JSON.parse(init.body).op === 'delete.prepare') { started(); await gate; }
    return response;
  } });
  await view.openHello();
  let operation;
  await act(async () => { operation = node(view.renderer, { 'data-fm-action': 'delete' }).props.onClick(); await preparing; });
  await act(async () => { await node(view.renderer, { 'data-fm-action': 'delete-cancel' }).props.onClick(); });
  assert.equal(nodes(view.renderer, { role: 'dialog' }).length, 0);
  await act(async () => { release(); await operation; });
  assert.equal(nodes(view.renderer, { role: 'dialog' }).length, 0);
  assert.equal(view.requests.some(item => item.init.body && JSON.parse(item.init.body).op === 'delete.commit'), false);
  await access(path.join(view.root, 'folder/hello.txt'));
});

test('a cancelled ready deletion cannot be committed through its stale confirmation callback', async t => {
  const view = await setup(t);
  await view.openHello(); await view.click({ 'data-fm-action': 'delete' });
  act(() => node(view.renderer, { 'aria-label': '我确认永久删除不可恢复' }).props.onChange({ target: { checked: true } }));
  const staleConfirm = node(view.renderer, { 'data-fm-action': 'delete-confirm' }).props.onClick;
  await view.click({ 'data-fm-action': 'delete-cancel' });
  await act(async () => { await staleConfirm(); });
  await access(path.join(view.root, 'folder/hello.txt'));
  assert.equal(view.requests.some(item => item.init.body && JSON.parse(item.init.body).op === 'delete.commit'), false);
});

test('a deletion preparation failure remains visible inside the open confirmation dialog', async t => {
  const view = await setup(t);
  await view.openHello();
  await rm(path.join(view.root, 'folder/hello.txt'));
  await view.click({ 'data-fm-action': 'delete' });
  const dialog = node(view.renderer, { role: 'dialog', 'aria-label': '永久删除这些条目？' });
  assert.equal(nodes(view.renderer, { 'data-fm-delete-phase': 'failed' }).length, 1);
  assert.ok(dialog.findAllByProps({ role: 'alert' }).length > 0);
  assert.equal(node(view.renderer, { 'data-fm-action': 'delete-confirm' }).props.disabled, true);
  assert.equal(view.requests.some(item => item.init.body && JSON.parse(item.init.body).op === 'delete.commit'), false);
});

test('a response without a reviewable deletion manifest never enables commit', async t => {
  const view = await setup(t, { intercept: async (url, init, route) => {
    const response = await route(url, init);
    if (init.body && JSON.parse(init.body).op === 'delete.prepare') {
      const result = await response.json();
      delete result.value.entries;
      return new Response(JSON.stringify(result));
    }
    return response;
  } });
  await view.openHello(); await view.click({ 'data-fm-action': 'delete' });
  act(() => node(view.renderer, { 'aria-label': '我确认永久删除不可恢复' }).props.onChange({ target: { checked: true } }));
  await view.click({ 'data-fm-action': 'delete-confirm' });
  await access(path.join(view.root, 'folder/hello.txt'));
  assert.equal(view.requests.some(item => item.init.body && JSON.parse(item.init.body).op === 'delete.commit'), false);
  assert.equal(nodes(view.renderer, { 'data-fm-delete-phase': 'failed' }).length, 1);
});

test('permanent deletion requires acknowledgement and cancellation never deletes', async t => {
  const view = await setup(t);
  await view.openHello();
  await view.click({ 'data-fm-action': 'delete' });
  assert.ok(textOf(node(view.renderer, { 'data-fm-delete-preview': true })).includes('folder/hello.txt'));
  assert.equal(node(view.renderer, { 'data-fm-action': 'delete-confirm' }).props.disabled, true);
  await view.click({ 'data-fm-action': 'delete-confirm' });
  await access(path.join(view.root, 'folder/hello.txt'));
  assert.equal(view.requests.some(item => item.init.body && JSON.parse(item.init.body).op === 'delete.commit'), false);
  await view.click({ 'data-fm-action': 'delete-cancel' });
  await access(path.join(view.root, 'folder/hello.txt'));
  await view.click({ 'data-fm-action': 'delete' });
  act(() => node(view.renderer, { 'aria-label': '我确认永久删除不可恢复' }).props.onChange({ target: { checked: true } }));
  await view.click({ 'data-fm-action': 'delete-confirm' });
  await view.flush();
  await assert.rejects(access(path.join(view.root, 'folder/hello.txt')), { code: 'ENOENT' });
  assert.equal(nodes(view.renderer, { 'data-fm-missing': true }).length, 1);
});

test('a stale deletion preview cannot remove replacement content', async t => {
  const view = await setup(t);
  await view.openHello();
  await view.click({ 'data-fm-action': 'delete' });
  await writeFile(path.join(view.root, 'folder/hello.txt'), 'replacement must survive');
  act(() => node(view.renderer, { 'aria-label': '我确认永久删除不可恢复' }).props.onChange({ target: { checked: true } }));
  await view.click({ 'data-fm-action': 'delete-confirm' });
  await view.flush();
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), 'replacement must survive');
  assert.ok(nodes(view.renderer, { role: 'alert' }).length > 0);
});

test('an externally deleted file remains an invalid draft and cannot be recreated by save', async t => {
  const view = await setup(t);
  await view.openHello();
  await view.click({ 'data-fm-action': 'edit' });
  act(() => node(view.renderer, { 'data-fm-editor': true }).props.onChange({ target: { value: 'retain after deletion' } }));
  await rm(path.join(view.root, 'folder/hello.txt'));
  await view.click({ 'data-fm-action': 'refresh' });
  assert.equal(node(view.renderer, { 'data-fm-editor': true }).props.value, 'retain after deletion');
  assert.equal(node(view.renderer, { 'data-fm-action': 'save' }).props.disabled, true);
  await view.click({ 'data-fm-action': 'save' });
  await assert.rejects(access(path.join(view.root, 'folder/hello.txt')), { code: 'ENOENT' });
});

test('copy clipboard survives panel remount and publishes through the real task service', async t => {
  const view = await setup(t, { tasks: true });
  await view.openHello();
  await view.click({ 'data-fm-action': 'copy' });
  view.unmount(); await view.mount();
  await view.click({ 'data-fm-root': true });
  await view.click({ 'data-fm-action': 'paste' });
  await view.click({ 'data-fm-action': 'paste-confirm' });
  const [task] = await view.tasks.list();
  assert.ok(task);
  await view.waitForTask(task.id);
  await view.click({ 'data-fm-action': 'refresh-tasks' });
  assert.equal(await readFile(path.join(view.root, 'hello.txt'), 'utf8'), '<script>not executable</script>\n你好');
  await access(path.join(view.root, 'folder/hello.txt'));
  assert.equal(node(view.renderer, { 'data-fm-task-id': task.id, 'data-fm-task-status': 'completed' }).props['data-fm-task-status'], 'completed');
});

test('an overwrite paste binds the reviewed destination version and refuses a later replacement', async t => {
  const view = await setup(t, { tasks: true, seed: root => writeFile(path.join(root, 'hello.txt'), 'original destination') });
  await view.openHello(); await view.click({ 'data-fm-action': 'copy' });
  await view.click({ 'data-fm-root': true });
  await view.click({ 'data-fm-action': 'paste' });
  act(() => node(view.renderer, { 'data-fm-conflict-policy': 0 }).props.onChange({ target: { value: 'overwrite' } }));
  await writeFile(path.join(view.root, 'hello.txt'), 'replacement destination');
  await view.click({ 'data-fm-action': 'paste-confirm' });
  const [task] = await view.tasks.list();
  const finished = await view.waitForTask(task.id);
  await view.click({ 'data-fm-action': 'refresh-tasks' });
  assert.equal(finished.status, 'failed');
  assert.equal(await readFile(path.join(view.root, 'hello.txt'), 'utf8'), 'replacement destination');
  assert.ok(textOf(node(view.renderer, { 'data-fm-task-id': task.id, 'data-fm-task-status': 'failed' })).includes('失败'));
});

test('directory paste offers skip or rename but never an implicit overwrite merge', async t => {
  const view = await setup(t, { tasks: true });
  act(() => node(view.renderer, { 'aria-label': '选择: folder' }).props.onChange({ target: { checked: true } }));
  await view.click({ 'data-fm-action': 'copy' });
  await view.click({ 'data-fm-action': 'paste' });
  const policy = node(view.renderer, { 'data-fm-conflict-policy': 0 });
  assert.equal(policy.findAllByType('option').some(option => option.props.value === 'overwrite'), false);
  act(() => policy.props.onChange({ target: { value: 'rename' } }));
  act(() => node(view.renderer, { 'data-fm-paste-name': 0 }).props.onChange({ target: { value: 'folder-copy' } }));
  await view.click({ 'data-fm-action': 'paste-confirm' });
  const [task] = await view.tasks.list(); await view.waitForTask(task.id);
  assert.equal(await readFile(path.join(view.root, 'folder-copy/hello.txt'), 'utf8'), '<script>not executable</script>\n你好');
});

test('a cut task relocates the file while retaining and relocating its unsaved draft', async t => {
  const view = await setup(t, { tasks: true });
  await view.openHello(); await view.click({ 'data-fm-action': 'edit' });
  act(() => node(view.renderer, { 'data-fm-editor': true }).props.onChange({ target: { value: 'draft travels with the file' } }));
  await view.click({ 'data-fm-action': 'cut' });
  await view.click({ 'data-fm-root': true });
  await view.click({ 'data-fm-action': 'paste' }); await view.click({ 'data-fm-action': 'paste-confirm' });
  const [task] = await view.tasks.list(); await view.waitForTask(task.id);
  await view.click({ 'data-fm-action': 'refresh-tasks' });
  await assert.rejects(access(path.join(view.root, 'folder/hello.txt')), { code: 'ENOENT' });
  assert.equal(node(view.renderer, { 'data-fm-editor': true }).props.value, 'draft travels with the file');
  await view.click({ 'data-fm-action': 'save' });
  assert.equal(await readFile(path.join(view.root, 'hello.txt'), 'utf8'), 'draft travels with the file');
});

test('retrying a failed task recovers a transient I/O failure against the same selected source', async t => {
  let failOnce = true;
  const view = await setup(t, { tasks: true, wrapTaskManager: manager => ({ ...manager, io: { ...manager.io, createStagedFile: async (...args) => {
    if (failOnce) { failOnce = false; throw Object.assign(new Error('Injected disk full'), { code: 'ENOSPC' }); }
    return manager.io.createStagedFile(...args);
  } } }) });
  await view.openHello(); await view.click({ 'data-fm-action': 'copy' }); await view.click({ 'data-fm-root': true });
  await view.click({ 'data-fm-action': 'paste' }); await view.click({ 'data-fm-action': 'paste-confirm' });
  const [task] = await view.tasks.list();
  assert.equal((await view.waitForTask(task.id)).status, 'failed');
  await view.click({ 'data-fm-action': 'refresh-tasks' });
  await view.click({ 'data-fm-task-action': 'retry', 'data-fm-task-id': task.id });
  assert.equal((await view.waitForTask(task.id)).status, 'completed');
  assert.equal(await readFile(path.join(view.root, 'hello.txt'), 'utf8'), '<script>not executable</script>\n你好');
  assert.equal((await view.tasks.get({ taskId: task.id })).items[0].attempts, 2);
});

test('cancelling a queued copy stops uncommitted publication and leaves the source intact', { timeout: 5000 }, async t => {
  let entered;
  const starting = new Promise(resolve => { entered = resolve; });
  const view = await setup(t, { tasks: true, wrapTaskManager: manager => ({ ...manager, io: { ...manager.io, createStagedFile: async input => {
    entered();
    await new Promise(resolve => { if (input.signal.aborted) resolve(); else input.signal.addEventListener('abort', resolve, { once: true }); });
    return manager.io.createStagedFile(input);
  } } }) });
  await view.openHello(); await view.click({ 'data-fm-action': 'copy' }); await view.click({ 'data-fm-root': true });
  await view.click({ 'data-fm-action': 'paste' }); await view.click({ 'data-fm-action': 'paste-confirm' });
  await starting;
  const [task] = await view.tasks.list();
  await view.click({ 'data-fm-task-action': 'cancel', 'data-fm-task-id': task.id });
  assert.equal((await view.waitForTask(task.id)).status, 'cancelled');
  await assert.rejects(access(path.join(view.root, 'hello.txt')), { code: 'ENOENT' });
  await access(path.join(view.root, 'folder/hello.txt'));
});

test('file upload streams exact binary bytes and leaves ZIP content unexpanded', async t => {
  const view = await setup(t, { transfers: true });
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 255, 1, 2]);
  await act(async () => { await node(view.renderer, { 'data-fm-upload-files': true }).props.onChange({ target: { files: [new File([bytes], '附件.zip')], value: 'chosen' } }); });
  await view.flush();
  await view.click({ 'data-fm-action': 'upload-confirm' });
  assert.deepEqual(await readFile(path.join(view.root, '附件.zip')), Buffer.from(bytes));
  const [transfer] = view.transfers.list();
  assert.equal(transfer.status, 'completed');
  assert.equal(nodes(view.renderer, { 'data-fm-transfer-id': transfer.id, 'data-fm-transfer-status': 'completed' }).length, 1);
});

test('directory picker uploads nested files and explicitly empty directories', async t => {
  const directory = (name, children) => ({ name, kind: 'directory', async *entries() { for (const child of children) yield [child.name, child]; } });
  const chosen = directory('项目', [directory('空目录', []), directory('子目录', [{ name: '资料.txt', kind: 'file', getFile: async () => new File(['资料'], '资料.txt') }])]);
  const view = await setup(t, { transfers: true, window: { showDirectoryPicker: async () => chosen } });
  await view.click({ 'data-fm-action': 'upload-directory' });
  await view.click({ 'data-fm-action': 'upload-confirm' });
  assert.equal((await stat(path.join(view.root, '项目/空目录'))).isDirectory(), true);
  assert.equal(await readFile(path.join(view.root, '项目/子目录/资料.txt'), 'utf8'), '资料');
  assert.equal(view.transfers.list()[0].items.some(item => item.path === '项目/空目录' && item.status === 'completed'), true);
});

test('upload overwrite checks the reviewed target version before publishing', async t => {
  const view = await setup(t, { transfers: true, seed: root => writeFile(path.join(root, 'upload.txt'), 'original') });
  await act(async () => { await node(view.renderer, { 'data-fm-upload-files': true }).props.onChange({ target: { files: [new File(['incoming'], 'upload.txt')], value: '' } }); });
  await view.flush();
  act(() => node(view.renderer, { 'data-fm-upload-policy': 0 }).props.onChange({ target: { value: 'overwrite' } }));
  await writeFile(path.join(view.root, 'upload.txt'), 'replacement');
  await view.click({ 'data-fm-action': 'upload-confirm' });
  assert.equal(await readFile(path.join(view.root, 'upload.txt'), 'utf8'), 'replacement');
  assert.equal(view.transfers.list()[0].status, 'failed');
});

test('retrying an upload retains File handles across panel remount and skips completed files', async t => {
  let failed = false;
  const view = await setup(t, { transfers: true, wrapTransferManager: manager => ({ ...manager, io: { ...manager.io, createStagedFile: async (...args) => {
    if (args[0].path === 'second.txt' && !failed) { failed = true; throw Object.assign(new Error('Injected full filesystem'), { code: 'ENOSPC' }); }
    return manager.io.createStagedFile(...args);
  } } }) });
  await act(async () => { await node(view.renderer, { 'data-fm-upload-files': true }).props.onChange({ target: { files: [new File(['first'], 'first.txt'), new File(['second'], 'second.txt')], value: '' } }); });
  await view.flush(); await view.click({ 'data-fm-action': 'upload-confirm' });
  const [task] = view.transfers.list();
  assert.equal(task.status, 'partial');
  assert.equal(node(view.renderer, { 'data-fm-transfer-action': 'retry', 'data-fm-transfer-id': task.id }).props.disabled, false, 'settled uploads must enable retry without requiring a remount');
  const rootId = view.manager.listRoots()[0].id;
  const original = await view.manager.stat({ rootId, path: 'first.txt' });
  view.unmount(); await view.mount();
  await view.click({ 'data-fm-transfer-action': 'retry', 'data-fm-transfer-id': task.id });
  assert.equal(view.transfers.get(task.id).status, 'completed');
  assert.equal((await view.manager.stat({ rootId, path: 'first.txt' })).version, original.version);
  assert.equal(await readFile(path.join(view.root, 'second.txt'), 'utf8'), 'second');
});

test('cancelling an in-flight upload aborts its body without publishing a destination', { timeout: 5000 }, async t => {
  let entered;
  const starting = new Promise(resolve => { entered = resolve; });
  const view = await setup(t, { transfers: true, wrapTransferManager: manager => ({ ...manager, io: { ...manager.io, createStagedFile: async input => {
    entered();
    await new Promise(resolve => { if (input.signal.aborted) resolve(); else input.signal.addEventListener('abort', resolve, { once: true }); });
    return manager.io.createStagedFile(input);
  } } }) });
  await act(async () => { await node(view.renderer, { 'data-fm-upload-files': true }).props.onChange({ target: { files: [new File(['payload'], 'cancelled.txt')], value: '' } }); });
  let sending;
  await act(async () => { sending = node(view.renderer, { 'data-fm-action': 'upload-confirm' }).props.onClick(); await starting; });
  const [task] = view.transfers.list();
  await view.click({ 'data-fm-transfer-action': 'cancel', 'data-fm-transfer-id': task.id });
  await act(async () => { await sending; });
  assert.equal(view.transfers.get(task.id).status, 'cancelled');
  await assert.rejects(access(path.join(view.root, 'cancelled.txt')), { code: 'ENOENT' });
});

test('download uses the native streaming URL rather than buffering a file into the panel', async t => {
  const view = await setup(t, { transfers: true });
  await view.openHello(); await view.click({ 'data-fm-action': 'download' });
  const request = view.requests.find(item => item.init.body && JSON.parse(item.init.body).op === 'transfers.begin');
  assert.ok(view.requests.some(item => item.init.body && JSON.parse(item.init.body).op === 'entries.stat' && JSON.parse(item.init.body).path === 'folder/hello.txt'), 'download must acquire a strong stat snapshot rather than trusting the listing token');
  assert.equal(JSON.parse(request.init.body).expectedVersion, (await view.manager.io.stat({ rootId: view.manager.listRoots()[0].id, path: 'folder/hello.txt' })).version, 'download selection must use an opaque strong stat version');
  const link = node(view.renderer, { 'data-fm-download': true });
  assert.ok(link.props.href.startsWith('/api/file-manager/download?taskId='));
  assert.equal(view.requests.some(request => request.url.startsWith('/api/file-manager/download')), false);
  assert.ok(textOf(node(view.renderer, { 'data-fm-download-note': true })).includes('浏览器'));
});

async function referenceFixture(t, options = {}) {
  const input = snapshotBoundary({ draft: 'already @older-file end', draftRev: 7, phase: 'plain', occurrences: [{ start: 8, length: '@older-file'.length }], ...options.input });
  const session = snapshotBoundary({ openState: 'open', removed: false, ...options.session });
  const catalog = snapshotBoundary({ ids: ['other', 'target'], byId: { other: { id: 'other', displayTitle: 'Other session', running: false }, target: { id: 'target', displayTitle: 'Target session', running: false } }, phase: 'ready' });
  const opened = [];
  const insertions = [];
  let deny = Boolean(options.deny);
  const view = await setup(t, { mainProps: { useSessions: catalog.use }, context: {
    uiWorkspace: { openSession(id) { opened.push(id); } },
    sessions: { scope(id) { return { bail(event, payload) {
      insertions.push({ id, event, payload });
      const snapshot = input.get();
      const end = snapshot.draft.length - snapshot.occurrences.reduce((total, occurrence) => total + occurrence.length - 1, 0);
      if (deny || id !== 'target' || snapshot.phase !== 'plain' || payload.span.draftRev !== snapshot.draftRev || payload.span.start !== end || payload.span.end !== end) return false;
      input.update({ draft: snapshot.draft + payload.text, draftRev: snapshot.draftRev + 1 });
      return true;
    } }; } },
  } });
  const bridges = [];
  t.after(() => { for (const renderer of bridges) act(() => renderer.unmount()); });
  view.mountBridge = async (sessionId = 'target') => {
    const bridge = view.client.cells.get('conversation.composer.dock:file-manager-reference-bridge');
    assert.ok(bridge, 'the documented session-scoped reference bridge is missing');
    let renderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(bridge.component, { t: view.client.t, sessionId, useInput: input.use, useSession: session.use, ...bridge.options.inject?.() })); });
    bridges.push(renderer);
    return renderer;
  };
  view.queueReference = async () => {
    await view.openHello(); await view.click({ 'data-fm-action': 'reference' });
    act(() => node(view.renderer, { 'data-fm-reference-session': true }).props.onChange({ target: { value: 'target' } }));
    await view.click({ 'data-fm-action': 'reference-confirm' });
  };
  return { view, input, session, opened, insertions, allow() { deny = false; } };
}

test('reference insertion targets only the chosen session and preserves existing reference coordinates', async t => {
  const { view, input, opened, insertions } = await referenceFixture(t);
  await view.mountBridge('other');
  await view.queueReference();
  assert.equal(insertions.length, 0);
  assert.deepEqual(opened, ['target']);
  assert.equal(nodes(view.renderer, { 'data-fm-reference-request': 'target' }).length, 1, 'a target that never mounts must leave a visible retryable request in Files');
  await view.mountBridge('target');
  assert.equal(insertions.length, 1);
  const insertion = insertions[0];
  assert.equal(insertion.id, 'target');
  assert.equal(insertion.event, 'slash/input-insert-text');
  assert.equal(insertion.payload.continue, false);
  assert.equal(insertion.payload.span.draftRev, 7);
  assert.equal(input.get().draft, `already @older-file end @${view.root}/folder/hello.txt `);
  assert.equal(input.get().occurrences[0].length, '@older-file'.length);
  await view.mountBridge('target');
  assert.equal(insertions.length, 1, 'a consumed request must not replay after bridge remount');
});

test('busy input keeps the reference request for an explicit retry instead of writing a draft', async t => {
  const { view, input, insertions } = await referenceFixture(t, { input: { phase: 'submitting' } });
  const bridge = await view.mountBridge();
  await view.queueReference();
  assert.equal(insertions.length, 0);
  assert.equal(nodes(bridge, { 'data-fm-reference-status': 'blocked' }).length, 1);
  act(() => input.update({ phase: 'plain' }));
  assert.equal(insertions.length, 0, 'becoming idle must not silently retry a refused insertion');
  await act(async () => { await node(bridge, { 'data-fm-reference-action': 'retry' }).props.onClick(); });
  assert.equal(insertions.length, 1);
  assert.ok(input.get().draft.includes(view.root));
});

test('a stale draft revision response cannot consume the reference request', async t => {
  const { view, input, insertions, allow } = await referenceFixture(t, { deny: true });
  const bridge = await view.mountBridge();
  await view.queueReference();
  assert.equal(input.get().draft, 'already @older-file end');
  assert.equal(nodes(bridge, { 'data-fm-reference-status': 'blocked' }).length, 1);
  allow();
  act(() => input.update({ draft: 'newer draft', draftRev: 8, occurrences: [] }));
  await act(async () => { await node(bridge, { 'data-fm-reference-action': 'retry' }).props.onClick(); });
  assert.equal(insertions.at(-1).payload.span.draftRev, 8);
  assert.equal(input.get().draft, `newer draft @${view.root}/folder/hello.txt `);
});

test('a removed target session cannot receive a queued file reference', async t => {
  const { view, insertions } = await referenceFixture(t, { session: { removed: true } });
  const bridge = await view.mountBridge(); await view.queueReference();
  assert.equal(insertions.length, 0);
  assert.equal(nodes(bridge, { 'data-fm-reference-status': 'blocked' }).length, 1);
});

test('a Host invalidation refreshes the directory while preserving an edited draft', { timeout: 5000 }, async t => {
  const streams = [];
  let observed;
  const reread = new Promise(resolve => { observed = resolve; });
  let changed = false;
  const view = await setup(t, { intercept: async (url, init, route) => {
    if (url === '/api/file-manager/events') {
      const stream = { signal: init.signal, cancelled: false };
      const body = new ReadableStream({ start(controller) { stream.controller = controller; }, cancel() { stream.cancelled = true; } });
      streams.push(stream);
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    const response = await route(url, init);
    if (init.body && JSON.parse(init.body).op === 'bootstrap') { const result = await response.json(); result.value.capabilities.watch = true; return new Response(JSON.stringify(result)); }
    if (changed && url === '/api/file-manager/control' && JSON.parse(init.body).op === 'text.read') observed();
    return response;
  } });
  await view.openHello(); await view.click({ 'data-fm-action': 'edit' });
  act(() => node(view.renderer, { 'data-fm-editor': true }).props.onChange({ target: { value: 'dirty stays' } }));
  assert.ok(streams.length > 0, 'the panel never subscribed to Host events');
  await writeFile(path.join(view.root, 'folder/hello.txt'), 'external event');
  changed = true;
  await act(async () => {
    streams.at(-1).controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ kind: 'invalidate', seq: 1, rootId: view.manager.listRoots()[0].id, path: 'folder', reason: 'watch' })}\n\n`));
    await reread;
  });
  await view.flush();
  assert.equal(node(view.renderer, { 'data-fm-editor': true }).props.value, 'dirty stays');
  assert.equal(nodes(view.renderer, { 'data-fm-external-change': true }).length, 1);
  const last = streams.at(-1);
  view.unmount();
  assert.equal(last.signal.aborted, true);
  assert.equal(last.cancelled, true);
});

test('a closed event connection is shown as disconnected instead of claiming live observation', async t => {
  const view = await setup(t, { intercept: async (url, init, route) => {
    if (url === '/api/file-manager/events') return new Response(new ReadableStream({ start(controller) { controller.close(); } }));
    const response = await route(url, init);
    if (init.body && JSON.parse(init.body).op === 'bootstrap') { const result = await response.json(); result.value.capabilities.watch = true; return new Response(JSON.stringify(result)); }
    return response;
  } });
  assert.equal(nodes(view.renderer, { 'data-fm-watch': 'disconnected' }).length, 1);
});

test('event frames spanning UTF-8 chunks are decoded exactly and in order', async t => {
  const client = await loadClient(() => { throw new Error('No HTTP request is expected.'); });
  t.after(client.dispose);
  assert.equal(typeof client.client.consumeEvents, 'function', 'the bounded event-stream reader is missing');
  const encoded = new TextEncoder().encode('data: {"kind":"ready","seq":1}\n\ndata: {"kind":"invalidate","rootId":"r","path":"中文","seq":2}\r\n\r\n');
  const frames = [];
  const body = new ReadableStream({ start(controller) { for (const byte of encoded) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  await client.client.consumeEvents(new Response(body), { onFrame: frame => frames.push(frame) });
  assert.deepEqual(JSON.parse(JSON.stringify(frames)), [{ kind: 'ready', seq: 1 }, { kind: 'invalidate', rootId: 'r', path: '中文', seq: 2 }]);
  assert.equal(body.locked, false);
});

test('aborting event observation cancels its reader even while waiting for another chunk', async t => {
  const client = await loadClient(() => { throw new Error('No HTTP request is expected.'); });
  t.after(client.dispose);
  assert.equal(typeof client.client.consumeEvents, 'function', 'the event-stream cleanup is missing');
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const controller = new AbortController();
  const reading = client.client.consumeEvents(new Response(body), { signal: controller.signal, onFrame() {} });
  controller.abort();
  await reading;
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test('an oversized event frame fails rather than growing memory without a bound', async t => {
  const client = await loadClient(() => { throw new Error('No HTTP request is expected.'); });
  t.after(client.dispose);
  assert.equal(typeof client.client.consumeEvents, 'function', 'bounded event decoding is missing');
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: ' + 'x'.repeat(300000))); }, cancel() { cancelled = true; } });
  await assert.rejects(client.client.consumeEvents(new Response(body), { onFrame() {} }), { code: 'EVENT_STREAM_INVALID' });
  assert.equal(cancelled, true);
});

test('opening a file displays literal text without executing HTML or sending a prompt', async t => {
  const view = await setup(t);
  await view.openHello();
  assert.equal(textOf(node(view.renderer, { 'data-fm-preview': 'text' })), '<script>not executable</script>\n你好');
  assert.equal(view.renderer.root.findAllByType('script').length, 0);
});
