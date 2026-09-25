import assert from 'node:assert/strict';
import { access, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { act, editorContainers, editorCount, editorEdit, editorProps, loadClient, node, nodes, setup, textOf, uiBoundary, React, TestRenderer, snapshotBoundary } from './client-harness.mjs';
import { loadClientModule } from './client-module-loader.mjs';

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
  assert.equal(view.requests.some(item => item.url.startsWith('/api/file-manager/v2/text') && item.init.method === 'GET'), false);
  assert.ok(view.requests.some(item => item.url === '/api/file-manager/v2/control' && JSON.parse(item.init.body).op === 'text.read'));
  assert.equal(editorProps(view.renderer)?.value, '<script>not executable</script>\n你好');
  await view.click({ 'data-fm-action': 'edit' });
  editorEdit(view, 'verified after save');
  await view.click({ 'data-fm-action': 'save' });
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), 'verified after save');
  assert.ok(view.requests.filter(item => item.url === '/api/file-manager/v2/control' && JSON.parse(item.init.body).op === 'text.read').length >= 2, 'save receipt verification also requires the working control snapshot route');
  assert.equal(nodes(view.renderer, { 'data-fm-document-state': 'clean' }).length, 1);
});

test('editing and saving through the text route preserves UTF-8 BOM and CRLF', async t => {
  const view = await setup(t, { seed: root => writeFile(path.join(root, 'folder/hello.txt'), '\ufeff第一行\r\n第二行\r\n') });
  await view.openHello();
  await view.click({ 'data-fm-action': 'edit' });
  editorEdit(view, '已修改\n第二行\n');
  await view.click({ 'data-fm-action': 'save' });
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), '\ufeff已修改\r\n第二行\r\n');
  assert.equal(editorProps(view.renderer)?.value, '已修改\n第二行\n');
  assert.equal(node(view.renderer, { 'data-fm-document-state': 'clean' }).children.length > 0, true);
  const request = view.requests.find(item => item.url === '/api/file-manager/v2/text' && item.init.method === 'POST' && JSON.parse(item.init.body).op === 'save');
  const payload = JSON.parse(request.init.body);
  assert.equal(payload.op, 'save');
  assert.equal(typeof payload.requestId, 'string');
  assert.equal(typeof payload.expectedVersion, 'string');
});

test('an unsaved draft survives unmounting and remounting the standalone main panel', async t => {
  const view = await setup(t);
  await view.openHello();
  await view.click({ 'data-fm-action': 'edit' });
  editorEdit(view, '面板切换保留');
  view.unmount();
  await view.mount();
  assert.equal(editorProps(view.renderer)?.value, '面板切换保留');
  assert.equal(node(view.renderer, { 'data-fm-document-state': 'dirty' }).children.length > 0, true);
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), '<script>not executable</script>\n你好');
});

test('a save conflict exposes disk and local text without overwriting either', async t => {
  const view = await setup(t);
  await view.openHello();
  await view.click({ 'data-fm-action': 'edit' });
  editorEdit(view, '本地草稿');
  await writeFile(path.join(view.root, 'folder/hello.txt'), '外部写入');
  await view.click({ 'data-fm-action': 'save' });
  assert.equal(editorProps(view.renderer)?.value, '本地草稿');
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
  editorEdit(view, 'keep draft');
  await writeFile(path.join(view.root, 'folder/hello.txt'), 'external');
  await view.click({ 'data-fm-action': 'refresh' });
  assert.equal(editorProps(view.renderer)?.value, 'keep draft');
  assert.equal(nodes(view.renderer, { 'data-fm-external-change': true }).length, 1);
});

test('closing a dirty editor supports cancel and explicit discard without a disk write', async t => {
  const view = await setup(t);
  await view.openHello();
  await view.click({ 'data-fm-action': 'edit' });
  editorEdit(view, 'do not lose silently');
  await view.click({ 'data-fm-action': 'close-document' });
  assert.equal(view.renderer.root.findAllByType(uiBoundary.Modal).some(modal => modal.props.open), true);
  await view.click({ 'data-fm-action': 'close-cancel' });
  assert.equal(editorProps(view.renderer)?.value, 'do not lose silently');
  await view.click({ 'data-fm-action': 'close-document' });
  await view.click({ 'data-fm-action': 'close-discard' });
  assert.equal(editorCount(view.renderer), 0);
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), '<script>not executable</script>\n你好');
});

test('saving from the close prompt closes only after the exact snapshot is verified', async t => {
  const view = await setup(t);
  await view.openHello();
  await view.click({ 'data-fm-action': 'edit' });
  editorEdit(view, 'save before close');
  await view.click({ 'data-fm-action': 'close-document' });
  await view.click({ 'data-fm-action': 'close-save' });
  assert.equal(editorCount(view.renderer), 0);
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), 'save before close');
});

test('typing while a save is in flight remains dirty after its receipt arrives', async t => {
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const saving = new Promise(resolve => { started = resolve; });
  const view = await setup(t, { intercept: async (url, init, route) => {
    const response = await route(url, init);
    if (url === '/api/file-manager/v2/text' && init.method === 'POST' && JSON.parse(init.body).op === 'save') { started(); await gate; }
    return response;
  } });
  await view.openHello();
  await view.click({ 'data-fm-action': 'edit' });
  editorEdit(view, 'submitted');
  let save;
  await act(async () => { save = node(view.renderer, { 'data-fm-action': 'save' }).props.onClick(); await saving; });
  editorEdit(view, 'newer typing');
  await act(async () => { release(); await save; });
  await view.flush();
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), 'submitted');
  assert.equal(editorProps(view.renderer)?.value, 'newer typing');
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
  assert.equal(view.requests.some(item => item.init.method === 'POST' && item.url === '/api/file-manager/v2/text'), false);
  assert.equal(view.requests.some(item => item.url.startsWith('/api/file-manager/v2/text')), false, 'old read-only Hosts have only the control route');
  assert.equal(editorProps(view.renderer)?.value, '<script>not executable</script>\n你好');
});

test('new file creation publishes an empty file in the browsed directory', async t => {
  const view = await setup(t);
  await view.click({ 'data-fm-entry': 'directory', 'data-fm-path': 'folder' });
  await view.click({ 'data-fm-action': 'new-file' });
  act(() => node(view.renderer, { 'data-fm-name': true }).props.onChange({ target: { value: '新文件.txt' } }));
  await view.click({ 'data-fm-action': 'name-submit' });
  assert.equal(await readFile(path.join(view.root, 'folder/新文件.txt'), 'utf8'), '');
  assert.equal(nodes(view.renderer, { 'data-fm-path': 'folder/新文件.txt' }).length, 1);
  assert.equal(editorProps(view.renderer)?.value, '');
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
  editorEdit(view, '草稿跟随重命名');
  await view.click({ 'data-fm-action': 'rename' });
  assert.ok(view.requests.some(item => item.init.body && JSON.parse(item.init.body).op === 'entries.stat' && JSON.parse(item.init.body).path === 'folder/hello.txt'), 'rename confirmation must capture a strong source version');
  act(() => node(view.renderer, { 'data-fm-name': true }).props.onChange({ target: { value: '改名.txt' } }));
  await view.click({ 'data-fm-action': 'name-submit' });
  await assert.rejects(access(path.join(view.root, 'folder/hello.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(view.root, 'folder/改名.txt'), 'utf8'), '<script>not executable</script>\n你好');
  assert.equal(editorProps(view.renderer)?.value, '草稿跟随重命名');
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
  editorEdit(view, 'retained after grant removal');
  const rootId = view.manager.listRoots()[0].id;
  await view.click({ title: '只移除这个入口，不删除磁盘文件' });
  await view.click({ 'data-fm-action': 'remove-root-confirm' });
  assert.equal(view.manager.listRoots().length, 0);
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), '<script>not executable</script>\n你好');
  assert.equal(editorProps(view.renderer)?.value, 'retained after grant removal');
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
  // The dialog deliberately does not echo the manifest: the server-held plan
  // still binds every version, so acknowledgement and the confirmation button
  // remain the only gate (asserted below), not a review of a printed list.
  assert.equal(nodes(view.renderer, { 'data-fm-delete-preview': true }).length, 0, 'the manifest must not be listed in the dialog');
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
  editorEdit(view, 'retain after deletion');
  await rm(path.join(view.root, 'folder/hello.txt'));
  await view.click({ 'data-fm-action': 'refresh' });
  assert.equal(editorProps(view.renderer)?.value, 'retain after deletion');
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
  await view.click({ 'data-fm-conflict-policy': 0 });
  await view.click({ role: 'menuitem', 'data-menu-item': 'overwrite' });
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
  await view.click({ 'data-fm-conflict-policy': 0 });
  const policy = view.renderer.root.findByType(uiBoundary.Menu);
  assert.equal(policy.props.items.some(option => option.id === 'overwrite'), false);
  await view.click({ role: 'menuitem', 'data-menu-item': 'rename' });
  act(() => node(view.renderer, { 'data-fm-paste-name': 0 }).props.onChange({ target: { value: 'folder-copy' } }));
  await view.click({ 'data-fm-action': 'paste-confirm' });
  const [task] = await view.tasks.list(); await view.waitForTask(task.id);
  assert.equal(await readFile(path.join(view.root, 'folder-copy/hello.txt'), 'utf8'), '<script>not executable</script>\n你好');
});

test('a cut task relocates the file while retaining and relocating its unsaved draft', async t => {
  const view = await setup(t, { tasks: true });
  await view.openHello(); await view.click({ 'data-fm-action': 'edit' });
  editorEdit(view, 'draft travels with the file');
  await view.click({ 'data-fm-action': 'cut' });
  await view.click({ 'data-fm-root': true });
  await view.click({ 'data-fm-action': 'paste' }); await view.click({ 'data-fm-action': 'paste-confirm' });
  const [task] = await view.tasks.list(); await view.waitForTask(task.id);
  await view.click({ 'data-fm-action': 'refresh-tasks' });
  await assert.rejects(access(path.join(view.root, 'folder/hello.txt')), { code: 'ENOENT' });
  assert.equal(editorProps(view.renderer)?.value, 'draft travels with the file');
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
  // The review control is the shared themed Menu (tests/upload-ui.test.mjs owns
  // its UI contract); this case keeps the policy's own guarantee: the version
  // the user reviewed is the one the begin request binds.
  const reviewed = (await view.manager.io.stat({ rootId: view.manager.listRoots()[0].id, path: 'upload.txt' })).version;
  assert.equal(node(view.renderer, { 'data-fm-upload-policy': 0 }).type, 'button', 'the upload policy control is the shared themed menu trigger');
  await view.click({ 'data-fm-upload-policy': 0 });
  await view.click({ role: 'menuitem', 'data-menu-item': 'overwrite' });
  await writeFile(path.join(view.root, 'upload.txt'), 'replacement');
  await view.click({ 'data-fm-action': 'upload-confirm' });
  const begun = view.requests.find(item => item.init.body && JSON.parse(item.init.body).op === 'transfers.begin');
  assert.equal(JSON.parse(begun.init.body).items[0].expectedVersion, reviewed, 'an overwrite upload must carry the version the review bound');
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
  assert.ok(link.props.href.startsWith('/api/file-manager/v2/download?taskId='));
  assert.equal(view.requests.some(request => request.url.startsWith('/api/file-manager/v2/download')), false);
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
    if (url === '/api/file-manager/v2/events') {
      const stream = { signal: init.signal, cancelled: false };
      const body = new ReadableStream({ start(controller) { stream.controller = controller; }, cancel() { stream.cancelled = true; } });
      streams.push(stream);
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    const response = await route(url, init);
    if (init.body && JSON.parse(init.body).op === 'bootstrap') { const result = await response.json(); result.value.capabilities.watch = true; return new Response(JSON.stringify(result)); }
    if (changed && url === '/api/file-manager/v2/control' && JSON.parse(init.body).op === 'text.read') observed();
    return response;
  } });
  await view.openHello(); await view.click({ 'data-fm-action': 'edit' });
  editorEdit(view, 'dirty stays');
  assert.ok(streams.length > 0, 'the panel never subscribed to Host events');
  await writeFile(path.join(view.root, 'folder/hello.txt'), 'external event');
  changed = true;
  await act(async () => {
    streams.at(-1).controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ kind: 'invalidate', seq: 1, rootId: view.manager.listRoots()[0].id, path: 'folder', reason: 'watch' })}\n\n`));
    await reread;
  });
  await view.flush();
  assert.equal(editorProps(view.renderer)?.value, 'dirty stays');
  assert.equal(nodes(view.renderer, { 'data-fm-external-change': true }).length, 1);
  const last = streams.at(-1);
  view.unmount();
  assert.equal(last.signal.aborted, true);
  assert.equal(last.cancelled, true);
});

test('a closed event connection is shown as disconnected instead of claiming live observation', async t => {
  const view = await setup(t, { intercept: async (url, init, route) => {
    if (url === '/api/file-manager/v2/events') return new Response(new ReadableStream({ start(controller) { controller.close(); } }));
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
  assert.equal(editorProps(view.renderer)?.value, '<script>not executable</script>\n你好');
  assert.equal(view.renderer.root.findAllByType('script').length, 0);
});

/* ------------------------------------------------------------------ *
 * Targeted regressions for the interaction defects fixed by this port.
 * ------------------------------------------------------------------ */

const controlBody = init => JSON.parse(String(init.body ?? '{}'));
const envelope = value => new Response(JSON.stringify({ ok: true, value }), { headers: { 'content-type': 'application/json' } });
const entry = (name, kind = 'file') => ({ name, path: name, kind, size: 3, modifiedAt: '2024-01-01T00:00:00.000Z', version: '1:1:1:1:1', mode: 0o644 });

test('two appends in the same frame never reuse one page cursor', async t => {
  const cursors = [];
  const pages = {
    '': { entries: [entry('a.txt')], total: 3, nextCursor: 'cursor-1' },
    'cursor-1': { entries: [entry('b.txt')], total: 3, nextCursor: 'cursor-2' },
    'cursor-2': { entries: [entry('c.txt')], total: 3, nextCursor: null },
  };
  const view = await setup(t, {
    intercept: (url, init, route) => {
      if (!String(url).includes('/v2/control')) return route(url, init);
      const body = controlBody(init);
      if (body.op !== 'entries.list') return route(url, init);
      cursors.push(body.cursor ?? null);
      const page = pages[body.cursor ?? ''];
      assert.ok(page, `unexpected cursor ${body.cursor}`);
      return envelope({ rootId: body.rootId, path: body.path ?? '', entries: page.entries, total: page.total, nextCursor: page.nextCursor, unaddressable: [] });
    },
  });
  assert.deepEqual(cursors, [null], 'the first page is requested without a cursor');
  await act(async () => {
    const more = node(view.renderer, { 'data-fm-action': 'more' });
    more.props.onClick();
    more.props.onClick();
    while (view.pending.size) await Promise.all([...view.pending]);
  });
  assert.equal(new Set(cursors).size, cursors.length, `a cursor must never be requested twice: ${JSON.stringify(cursors)}`);
  const paths = nodes(view.renderer, { 'data-fm-entry': 'file' }).map(element => element.props['data-fm-path']);
  assert.equal(new Set(paths).size, paths.length, 'a page must not be merged twice');
  assert.equal(paths.includes('b.txt'), true, 'the second page still loads');
});

test('a late deletion manifest cannot reopen a cancelled dialog or submit anything', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const commits = [];
  const view = await setup(t, {
    intercept: async (url, init, route) => {
      if (!String(url).includes('/v2/control')) return route(url, init);
      const body = controlBody(init);
      if (body.op === 'delete.prepare') { await held; return envelope({ id: 'plan-1', targets: body.items, entryCount: 1, expiresAt: Date.now() + 60000, permanent: true, entries: [{ rootId: body.items[0].rootId, path: body.items[0].path, kind: 'file', size: 3, version: '1:1:1:1:1' }] }); }
      if (body.op === 'delete.commit') commits.push(body);
      return route(url, init);
    },
  });
  const checkbox = node(view.renderer, { type: 'checkbox', 'aria-label': '选择: folder' });
  await act(async () => { checkbox.props.onChange({ target: { checked: true } }); });
  await act(async () => { node(view.renderer, { 'data-fm-action': 'delete' }).props.onClick(); });
  assert.ok(nodes(view.renderer, { 'data-fm-delete-phase': 'preparing' }).length > 0, 'the dialog must open while the manifest is prepared');
  await act(async () => { node(view.renderer, { 'data-fm-action': 'delete-cancel' }).props.onClick(); });
  assert.equal(nodes(view.renderer, { 'data-fm-delete-phase': 'preparing' }).length, 0, 'cancelling closes the dialog');
  release();
  await view.flush();
  assert.equal(nodes(view.renderer, { 'data-fm-delete-phase': 'ready' }).length, 0, 'a late manifest must not reopen the cancelled dialog');
  assert.deepEqual(commits, [], 'nothing may be submitted after the attempt was cancelled');
});

test('the optional session hook may appear after mount without breaking hook order', async t => {
  const view = await setup(t, { mainProps: { useSessions: undefined } });
  const panel = view.client.cells.get('main:file-manager');
  const checkbox = node(view.renderer, { type: 'checkbox', 'aria-label': '选择: folder' });
  await act(async () => { checkbox.props.onChange({ target: { checked: true } }); });
  assert.equal(node(view.renderer, { 'data-fm-action': 'reference' }).props.disabled, true, 'without a session registry there is nothing to reference');
  const sessions = snapshotBoundary({ ids: ['s1'], byId: { s1: { id: 's1', displayTitle: 'Session one' } } });
  await act(async () => {
    view.renderer.update(React.createElement(panel.component, { t: view.client.t, ...panel.options.inject?.(), useSessions: sessions.use }));
  });
  assert.equal(nodes(view.renderer, { 'data-fm-root': true }).length, 1, 'the panel still renders after the hook becomes available');
  assert.equal(node(view.renderer, { 'data-fm-action': 'reference' }).props.disabled, false, 'the session catalog is now in use');
});

test('a ready frame triggers a resynchronization of the open directory', async t => {
  let listed = 0;
  let events;
  const view = await setup(t, {
    intercept: async (url, init, route) => {
      if (String(url).includes('/v2/events')) {
        events = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"kind":"ready","reason":"connected","seq":1}\n\n')); } });
        return new Response(events, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (String(url).includes('/v2/control') && controlBody(init).op === 'entries.list') listed++;
      return route(url, init);
    },
  });
  const before = listed;
  await view.flush();
  // The Client coalesces a resynchronization behind its watcher debounce, so the
  // listing a `ready` frame causes is not in flight yet when the requests that
  // are already pending have settled.
  await view.waitFor(() => listed > before);
  assert.equal(listed > before, true, 'the ready frame must resynchronize the directory instead of trusting stale state');
});

test('an unrepresentable entry name is shown without an executable path', async t => {
  const view = await setup(t, { seed: root => writeFile(path.join(root, 'bad\\name.txt'), 'x') });
  assert.equal(nodes(view.renderer, { 'data-fm-entry': 'directory', 'data-fm-path': 'folder' }).length, 1, 'one special name must not break the listing');
  assert.equal(nodes(view.renderer, { 'data-fm-entry': 'file', 'data-fm-path': 'bad\\name.txt' }).length, 0, 'an unaddressable entry must never carry an executable path');
  assert.equal(nodes(view.renderer, { type: 'checkbox', 'aria-label': '选择: bad\\name.txt' }).length, 0, 'an unaddressable entry cannot be selected');
  const block = nodes(view.renderer, { 'data-fm-unaddressable-name': 'bad\\name.txt' });
  assert.equal(block.length, 1, 'the unaddressable entry is still shown for review');
  assert.ok(textOf(block[0]).length > 'bad\\name.txt'.length, 'the reason is shown next to the name');
});

/** A complete running task view: the panel renders its progress as it arrives. */
const runningTask = updatedAt => ({
  id: 'r10', operation: 'copy', status: 'running', dismissed: false, historyRevision: 0, canDismiss: false,
  updatedAt, createdAt: '2026-01-01T00:00:00.000Z',
  items: [{ id: 'item-r10', source: { rootId: 'root', path: 'source.txt' }, destination: { rootId: 'root', path: 'target.txt' }, status: 'running', attempts: 1 }],
  progress: { total: 1, completed: 0, failed: 0, skipped: 0, cancelled: 0, bytes: 0, totalBytes: 4 },
});

test('applying the Client again after a release never accumulates timers or event streams', async t => {
  const intervals = new Set();
  const view = await setup(t, {
    tasks: true,
    globals: {
      setInterval(callback, delay) { const timer = { callback, delay }; intervals.add(timer); return timer; },
      clearInterval(timer) { intervals.delete(timer); },
    },
  });
  // A re-applied Client owns a fresh store, so the activity store is read
  // through the current application rather than captured once.
  const activity = () => view.client.cells.get('main:file-manager').options.inject().activity;
  const streams = () => view.requests.filter(item => item.url === '/api/file-manager/v2/events');
  const live = () => streams().filter(stream => stream.init.signal.aborted !== true);
  // A running activity is what keeps a poll timer alive, so the timer count is
  // only meaningful once one exists.
  act(() => activity().put('tasks', runningTask('2026-01-01T00:00:01.000Z')));
  const opened = streams().length;
  assert.equal(live().length, 1, 'a mounted panel owns exactly one live subscription');
  assert.equal(intervals.size, 1, 'a running activity owns exactly one poll timer');

  view.unmount();
  assert.equal(intervals.size, 0, 'unmounting the panel must release its timers');
  assert.equal(live().length, 0, 'unmounting the panel must release its subscription');

  await view.reloadClient();
  act(() => activity().put('tasks', runningTask('2026-01-01T00:00:02.000Z')));
  assert.equal(streams().length, opened * 2, 'a re-applied Client opens the same number of subscriptions, not one more per application');
  assert.equal(live().length, 1, 'a re-applied Client keeps exactly one live subscription');
  assert.equal(intervals.size, 1, 'a re-applied Client keeps exactly one poll timer');

  view.unmount();
  await view.client.dispose();
  assert.equal(intervals.size, 0, 'disposing the application must leave no timer behind');
  assert.equal(live().length, 0, 'disposing the application must leave no subscription behind');
});

// The panel carries its own stylesheet. The TypeScript port once rendered an
// empty `<style>` element, so the whole panel lost its layout while every other
// assertion still passed; this is the assertion that would have caught it.
test('the panel ships its own stylesheet instead of rendering an empty style element', async t => {
  const view = await setup(t);
  const styles = view.renderer.root.findAll(candidate => candidate.type === 'style');
  assert.equal(styles.length, 1, 'the panel must render exactly one stylesheet');
  const css = textOf(styles[0]);
  assert.ok(css.includes('.dsh-fm{'), 'the stylesheet must define the panel root layout');
  assert.ok(css.includes('.dsh-fm .fm-layout'), 'the stylesheet must define the panel grid');
  assert.ok(css.includes('.dsh-fm-dialog'), 'dialog styling must travel with the panel');
  assert.ok(css.length > 1000, `an empty or truncated stylesheet breaks the layout (got ${css.length} characters)`);
});

/* ------------------------------------------------------------------ *
 * Code editor integration: the first RED batch.
 *
 * Every case fails on the business rule it names — never on a missing export,
 * never inside a helper — so the integration signal cannot be masked by a
 * build-level error.
 *
 * Subject: the panel→component boundary. Under React's test renderer no host ref
 * is ever attached, so CodeMirror is not constructed and the component runs its
 * documented no-view lifecycle: the React container and its `data-fm-code*` marks
 * render, the failure fallback stays unreachable. Editor internals — the real
 * `.cm-content`, its colour spans and actual typing — belong to the independent
 * jsdom suite; asserting them here would be false green.
 * ------------------------------------------------------------------ */

/** The open document's metadata footer, told apart from the panel footer. */
const documentFooter = view => view.renderer.root.findAll(item => item.type === 'footer')
  .find(item => item.findAll(candidate => 'data-fm-document-state' in candidate.props).length > 0);
/** The `data-fm-code*` marks the editor container declares. */
const codeMarks = view => editorContainers(view.renderer)[0]?.props;
/**
 * The visible status note nodes. The frozen contract renders them only while the
 * highlight state is not `active`, so `active` must have none and `plain`/
 * `limited`/`error` must have exactly one whose own `data-fm-code-note` mirrors
 * the container's `data-fm-code-highlight`.
 */
const noteNodes = view => view.renderer.root.findAll(item => typeof item.type === 'string' && item.props.className === 'fm-code-note');
/**
 * The constant language label. It exists only when there is a language name to
 * show, so a plain-text file has none: in that state the reason note already
 * carries the whole message, and a second node could only repeat it.
 */
const codeLabels = view => view.renderer.root.findAll(item => typeof item.type === 'string' && item.props.className === 'fm-code-language');

test('an opened file renders exactly one code editor declared as preview', async t => {
  const view = await setup(t);
  await view.openHello();
  assert.equal(editorCount(view.renderer), 1, 'an opened file must render exactly one code editor');
  assert.equal(codeMarks(view)?.['data-fm-code-mode'], 'preview', 'a file opens in preview mode');
});

test('the editor renders the LF-normalized draft while the footer keeps the disk metadata', async t => {
  const view = await setup(t, { seed: root => writeFile(path.join(root, 'folder/hello.txt'), '第一行\r\n第二行\r\n') });
  await view.openHello();
  assert.equal(editorProps(view.renderer)?.value, '第一行\n第二行\n', 'the editor must render the LF-normalized draft the document store owns');
  await view.click({ 'data-fm-action': 'edit' });
  assert.equal(editorProps(view.renderer)?.value, '第一行\n第二行\n', 'entering edit mode must not rewrite the text');
  assert.equal(codeMarks(view)?.['data-fm-code-mode'], 'edit', 'edit mode must be declared on the editor container');
  assert.match(textOf(documentFooter(view)), /CRLF/, 'the metadata footer must keep reporting the disk line ending');
});

test('a Host that cannot write renders a non-writable editor', async t => {
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
  assert.equal(editorProps(view.renderer)?.canWrite, false, 'a read-only Host must render a non-writable editor');
});

test('a degraded Host stays read-only even when it still advertises write', async t => {
  const view = await setup(t, { intercept: async (url, init, route) => {
    const response = await route(url, init);
    if (init.body && JSON.parse(init.body).op === 'bootstrap') {
      const envelope = await response.json();
      envelope.value.degraded = { scope: 'operations', code: 'INITIALIZATION_FAILED', message: 'The operation journal could not be opened.', readOnly: true };
      return new Response(JSON.stringify(envelope));
    }
    return response;
  } });
  await view.openHello();
  assert.equal(editorProps(view.renderer)?.canWrite, false, 'a degraded Host must not render a writable editor');
  const edit = nodes(view.renderer, { 'data-fm-action': 'edit' });
  assert.ok(edit.length === 0 || edit[0].props.disabled === true, 'a degraded Host must not offer its edit entry point');
  assert.equal(view.requests.some(item => item.url === '/api/file-manager/v2/text'), false, 'a degraded Host must not receive a text write');
});

test('the editor save callback writes the current draft to disk', async t => {
  const view = await setup(t);
  await view.openHello();
  await view.click({ 'data-fm-action': 'edit' });
  assert.ok(editorProps(view.renderer), 'an opened file must render the code editor before its callback is exercised');
  editorEdit(view, 'saved from the editor callback');
  const onSave = editorProps(view.renderer).onSave;
  assert.equal(typeof onSave, 'function', 'the editor must receive the panel save callback');
  await act(async () => { onSave(); await view.settle(); });
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), 'saved from the editor callback');
});

test('a missing DOM never revives a native text control or the failure fallback', async t => {
  const view = await setup(t);
  await view.openHello();
  await view.click({ 'data-fm-action': 'edit' });
  assert.equal(view.renderer.root.findAll(item => item.type === 'textarea').length, 0, 'the legacy textarea editor must not come back');
  assert.equal(nodes(view.renderer, { 'data-fm-code-fallback': 'edit' }).length, 0, 'a missing DOM must not be reported as an editor failure');
  assert.notEqual(codeMarks(view)?.['data-fm-code-highlight'], 'error', 'a missing DOM must not degrade the highlight state to error');
});

test('an unmapped suffix declares the plaintext language and a plain highlight note', async t => {
  const { zh } = await loadClientModule('i18n');
  const view = await setup(t);
  await view.openHello();
  assert.equal(codeMarks(view)?.['data-fm-code-language'], 'plaintext', 'a suffix the Host does not map must declare the plaintext language');
  assert.equal(codeMarks(view)?.['data-fm-code-highlight'], 'plain', 'plain text is not an error state');
  assert.equal(codeLabels(view).length, 0, 'a plain-text file has no language name, so it must not render a language label');
  const notes = noteNodes(view);
  assert.equal(notes.length, 1, 'a non-active highlight must be explained by exactly one visible note');
  assert.equal(notes[0].props['data-fm-code-note'], 'plain', 'the note must mirror the highlight state it explains');
  assert.equal(textOf(notes[0]), zh['code.language.plaintext'], 'the note must resolve to the shipped message, not the raw key');
});

test('a Host-mapped suffix declares the active highlight without a note node', async t => {
  const view = await setup(t, { seed: root => writeFile(path.join(root, 'hello.ts'), 'const answer = 42;\n') });
  await view.click({ 'data-fm-entry': 'file', 'data-fm-path': 'hello.ts' });
  assert.equal(editorProps(view.renderer)?.languageHint, 'typescript', 'the panel must pass the Host grammar hint through unchanged');
  assert.equal(codeMarks(view)?.['data-fm-code-language'], 'typescript', 'the container must declare the resolved grammar');
  assert.equal(codeMarks(view)?.['data-fm-code-highlight'], 'active', 'a supported grammar must not sit in a degraded highlight state');
  assert.equal(noteNodes(view).length, 0, 'an active highlight must not render a status note');
});

test('the language label resolves the language name into the shipped message', async t => {
  const view = await setup(t, { seed: root => writeFile(path.join(root, 'hello.ts'), 'const answer = 42;\n') });
  await view.click({ 'data-fm-entry': 'file', 'data-fm-path': 'hello.ts' });
  const labels = codeLabels(view);
  assert.equal(labels.length, 1, 'a recognized language must render exactly one language label');
  const label = textOf(labels[0]);
  assert.notEqual(label, 'code.language', 'the label must resolve to the shipped message, not the raw key');
  assert.equal(label.includes('{language}'), false, 'the label must be formatted with the language name');
});

/* ------------------------------------------------------------------ *
 * R21 layout contract. Stretching .cm-editor alone is not enough: CodeMirror
 * mounts into an unmarked .fm-code-mount child, so a missing flex/min-height
 * there lets the panel clip the editor instead of scrolling it. These cases read
 * the declarations the shipped stylesheet actually carries.
 * ------------------------------------------------------------------ */

/** The declaration block of one exact selector in the shipped stylesheet. */
const declarationBlock = (css, selector) =>
  new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

const shippedCss = view => textOf(view.renderer.root.findAll(candidate => candidate.type === 'style')[0]);

test('the shipped stylesheet carries the editor fill chain down to the mount', async t => {
  const view = await setup(t);
  const css = shippedCss(view);
  const mount = declarationBlock(css, '.dsh-fm [data-fm-code] .fm-code-mount');
  assert.match(mount, /display:flex/, 'the mount must lay out its editor child');
  assert.match(mount, /flex:1/, 'the mount must take the space the status rows leave');
  assert.match(mount, /min-height:0/, 'the mount must be allowed to shrink below its content');
  assert.match(mount, /min-width:0/, 'the mount must not force the preview column wider');
  assert.match(mount, /overflow:hidden/, 'the mount must not overflow the panel column');
  assert.match(declarationBlock(css, '.dsh-fm [data-fm-code] .cm-editor'), /flex:1/, 'the editor must fill the mount');
});

test('the shipped stylesheet aligns the editor status rows with the code padding', async t => {
  const view = await setup(t);
  const rows = declarationBlock(shippedCss(view), '.dsh-fm .fm-code-language,.dsh-fm .fm-code-note');
  assert.match(rows, /padding:6px 16px 0/, 'the status rows must line up with the 16px code padding');
});
