import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { act, clickRootCrumb, editorEdit, editorNodes, editorProps, node, nodes, setup, textOf, uiBoundary } from './client-harness.mjs';

const overlay = (view, name) => node(view.renderer, { 'data-fm-overlay': name });
const action = name => ({ 'data-fm-action': name });
/** The per-document tab X addresses its document exactly; the window X never does. */
const tabClose = view => id => node(view.renderer, { 'data-fm-action': 'close-document', 'data-fm-close-document': id });
const windowClose = view => node(view.renderer, action('close-viewer'));
const preview = view => view.click({ 'data-fm-entry': 'file', 'data-fm-path': 'folder/hello.txt' });
const folder = view => view.click({ 'data-fm-entry': 'directory', 'data-fm-path': 'folder' });
const header = view => node(view.renderer, { className: 'fm-overlay-header fm-viewer-header' });
function hostParent(element) {
  let parent = element.parent;
  while (parent && typeof parent.type !== 'string') parent = parent.parent;
  return parent;
}

test('single writable file has one filename header with save and independent tab/window close, no visible path/action row', async t => {
  const view = await setup(t);
  await folder(view); await preview(view);
  const bar = header(view);
  assert.equal(textOf(bar).split('hello.txt').length - 1, 1);
  assert.equal(textOf(bar).includes('folder/hello.txt'), false);
  assert.equal(bar.findAllByType('nav').length, 1, 'the tab row renders even for a single document');
  assert.equal(bar.findAll(candidate => candidate.props.className === 'fm-viewer-title').length, 0,
    'the tab row is the only filename surface, so no second title renders beside it');
  const tab = node(view.renderer, { 'data-fm-tab': 'document-1' });
  // Class tokens, never one exact string: the single open document is active, so
  // its container carries the active marker next to the base class. The container
  // is where the active state lives; the switch button keeps its own marker and
  // the `aria-current` announcement.
  const wrapperClasses = String(hostParent(tab).props.className).split(/\s+/u).filter(Boolean);
  assert.equal(wrapperClasses.includes('fm-tab'), true, 'the switch button sits inside its per-document span');
  assert.equal(wrapperClasses.includes('fm-active'), true,
    'the active document marks its own container, not only the switch button');
  assert.equal(hostParent(tabClose(view)('document-1')), hostParent(tab), 'switch and close share one per-document span');
  assert.notEqual(hostParent(tabClose(view)('document-1')), tab, 'the close button is a sibling of the switch button, never nested in it');
  assert.equal(tab.findAllByType('button').length, 1, 'a tab renders exactly one switch button');
  const close = tabClose(view)('document-1');
  assert.equal(close.props.title, '关闭文档: folder/hello.txt', 'the close name names its exact document path');
  assert.equal(close.props['aria-label'], '关闭文档: folder/hello.txt');
  assert.equal(close.findAllByType(uiBoundary.IconCloseOutlineRegular).length, 1);
  assert.equal(hostParent(node(view.renderer, action('save'))), bar);
  assert.equal(bar.findAll(candidate => candidate.type === 'button').at(-1), windowClose(view),
    'the window close is the last header control');
  assert.equal(windowClose(view).props['aria-label'], '关闭编辑器');
  assert.equal(windowClose(view).props.title, '关闭编辑器');
  assert.equal(node(view.renderer, { className: 'fm-preview' }).findAll(candidate => candidate.props.className === 'fm-pathbar').length, 0);
  assert.equal(editorProps(view.renderer).canWrite, true);
  const save = node(view.renderer, action('save'));
  assert.equal(save.parent.props.variant, 'ghost');
  assert.equal(save.props.disabled, true);
  editorEdit(view, 'direct edit');
  assert.equal(node(view.renderer, action('save')).props.disabled, false);
  const documents = view.client.cells.get('main:file-manager').options.inject().documents;
  assert.equal('editing' in documents.getSnapshot().documents[0], false);
  // The tab X destroys exactly this document even when it is the only one.
  await view.click({ 'data-fm-action': 'close-document', 'data-fm-close-document': 'document-1' });
  await view.click(action('close-discard'));
  assert.equal(documents.getSnapshot().documents.length, 0);
});

test('multiple document tabs replace the title within the header; each tab X closes only its own document', async t => {
  const view = await setup(t, { seed: root => writeFile(path.join(root, 'folder', 'other.txt'), 'other') });
  await folder(view); await preview(view);
  editorEdit(view, 'inactive dirty draft');
  await view.click(action('back-to-files'));
  await view.click({ 'data-fm-path': 'folder/other.txt' });
  const bar = header(view);
  const tabs = node(view.renderer, { className: 'fm-tabs fm-viewer-tabs' });
  assert.equal(hostParent(tabs), bar);
  assert.equal(bar.findAll(candidate => candidate.props.className === 'fm-viewer-title').length, 0);
  assert.equal(nodes(view.renderer, { 'data-fm-tab': 'document-1' }).length, 1);
  assert.equal(nodes(view.renderer, { 'data-fm-tab': 'document-2' }).length, 1);
  assert.equal(tabs.findAllByType('button').length, 4, 'two switch buttons plus two sibling close buttons');
  assert.match(tabs.findAllByType('button')[0].props.title, /folder\/hello.txt$/);
  assert.equal(textOf(tabs).split('hello.txt').length - 1, 1);
  // The tab X of the inactive dirty document opens the confirmation naming that
  // document, and cancelling keeps both the document and the active selection.
  await view.click({ 'data-fm-action': 'close-document', 'data-fm-close-document': 'document-1' });
  assert.equal(view.renderer.root.findAllByType(uiBoundary.Modal).some(modal => modal.props.open), true,
    'the dirty confirmation opened for the inactive tab');
  assert.equal(textOf(node(view.renderer, { className: 'dsh-fm-dialog' })).includes('folder/hello.txt'), true,
    'the confirmation names the document the tab X targeted, not the active one');
  await view.click(action('close-cancel'));
  const documents = view.client.cells.get('main:file-manager').options.inject().documents;
  assert.equal(documents.getSnapshot().documents.length, 2);
  assert.equal(editorProps(view.renderer).path, 'folder/other.txt');
  assert.equal(documents.getSnapshot().documents.find(item => item.id === 'document-1').draft, 'inactive dirty draft');
  // Discarding removes exactly that document; the active document never moved.
  await view.click({ 'data-fm-action': 'close-document', 'data-fm-close-document': 'document-1' });
  await view.click(action('close-discard'));
  assert.equal(documents.getSnapshot().documents.length, 1);
  assert.equal(editorProps(view.renderer).path, 'folder/other.txt', 'closing the inactive tab keeps the active document');
  assert.equal(nodes(view.renderer, { 'data-fm-tab': 'document-1' }).length, 0);
  assert.equal(nodes(view.renderer, { 'data-fm-tab': 'document-2' }).length, 1);
  // The remaining tab X closes its own document; the last close hides the window.
  await view.click({ 'data-fm-action': 'close-document', 'data-fm-close-document': 'document-2' });
  assert.equal(documents.getSnapshot().documents.length, 0);
  assert.equal(nodes(view.renderer, { 'data-fm-tab': 'document-2' }).length, 0);
  assert.equal(overlay(view, 'viewer').props.hidden, true, 'closing the last document hides the editor window');
});

test('the window close hides the editor and keeps every document, draft and instance mounted', async t => {
  const view = await setup(t, { seed: root => writeFile(path.join(root, 'folder', 'other.txt'), 'other') });
  await folder(view); await preview(view);
  // The user flow stays reachable: hide the viewer, then open the second file
  // from the visible list before re-entering the editor with both documents.
  await view.click(action('back-to-files'));
  await view.click({ 'data-fm-path': 'folder/other.txt' });
  editorEdit(view, 'window-hide draft');
  const original = editorNodes(view.renderer)[0];
  await view.click(action('close-viewer'));
  assert.equal(overlay(view, 'viewer').props.hidden, true);
  assert.equal(node(view.renderer, { className: 'fm-base' }).props.inert, undefined);
  assert.equal(editorNodes(view.renderer)[0], original, 'the editor instance stays mounted through a window close');
  assert.equal(editorProps(view.renderer).value, 'window-hide draft');
  const documents = view.client.cells.get('main:file-manager').options.inject().documents;
  assert.equal(documents.getSnapshot().documents.length, 2, 'no document is destroyed by the window close');
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), '<script>not executable</script>\n你好');
  assert.equal(await readFile(path.join(view.root, 'folder/other.txt'), 'utf8'), 'other', 'the window close never writes to disk');
  // Re-entry from the already-open document resumes the same mounted editor.
  await view.click(action('open-documents'));
  assert.equal(overlay(view, 'viewer').props.hidden, false);
  assert.equal(editorNodes(view.renderer)[0], original);
  assert.equal(editorProps(view.renderer).value, 'window-hide draft');
  assert.equal(editorProps(view.renderer).path, 'folder/other.txt');
});

test('closing the active tab switches to the remaining document', async t => {
  const view = await setup(t, { seed: root => writeFile(path.join(root, 'folder', 'other.txt'), 'other') });
  await folder(view); await preview(view);
  await view.click(action('back-to-files'));
  await view.click({ 'data-fm-path': 'folder/other.txt' });
  // The active tab X closes the active document; the successor is the other one.
  await view.click({ 'data-fm-action': 'close-document', 'data-fm-close-document': 'document-2' });
  assert.equal(editorProps(view.renderer).path, 'folder/hello.txt', 'the viewer stays open on the remaining document');
  assert.equal(nodes(view.renderer, { 'data-fm-tab': 'document-2' }).length, 0);
  assert.equal(nodes(view.renderer, { 'data-fm-tab': 'document-1' }).length, 1);
});

// Built Client with the real Host routes. Geometry and physical input are separate browser checks.
test('list is the default main view; viewer and tasks are hidden without unmounting', async t => {
  const view = await setup(t, { tasks: true, transfers: true });
  for (const name of ['viewer', 'tasks', 'notifications']) {
    assert.equal(overlay(view, name).props.hidden, true);
    assert.equal(overlay(view, name).props['data-fm-overlay-open'], false);
  }
  assert.equal(node(view.renderer, { className: 'fm-base' }).props.inert, undefined);
  await view.click(action('show-tasks'));
  assert.equal(overlay(view, 'tasks').props.hidden, false);
  assert.equal(node(view.renderer, { className: 'fm-base' }).props.inert, '');
  const tasksHeader = nodes(view.renderer, { className: 'fm-overlay-header' }).find(bar => bar.findByProps({ 'data-fm-action': 'close-tasks' }));
  assert.ok(tasksHeader, 'the tasks overlay renders a header');
  assert.equal(tasksHeader.findAllByType('button').length, 1, 'the task header keeps only its close button');
  assert.equal(textOf(tasksHeader.findAllByType('button')[0]), '关闭');
  assert.equal(tasksHeader.findAll(candidate => candidate.props['data-fm-action'] === 'notifications').length, 0,
    'the task header never carries the notification entry');
  assert.equal(nodes(view.renderer, { 'data-fm-action': 'notifications' }).length, 1,
    'the mounted panel keeps only the main notification entry while tasks are open');
  await view.click(action('close-tasks'));
  assert.equal(overlay(view, 'tasks').props.hidden, true);
  assert.equal(node(view.renderer, { className: 'fm-base' }).props.inert, undefined, 'closing the task panel restores the file list');
  // The notifications drawer is reachable from its own entry, and the
  // directory-location drawer is not hidden — it no longer exists.
  assert.equal(nodes(view.renderer, { 'data-fm-action': 'notifications' }).length, 1,
    'closing tasks preserves exactly one notification entry');
  assert.equal(node(view.renderer, { className: 'fm-main-header' }).findAll(candidate => candidate.props['data-fm-action'] === 'notifications' && typeof candidate.type === 'string').length, 1,
    'the main list keeps its notification entry');
  assert.equal(overlay(view, 'viewer').findAll(candidate => candidate.props['data-fm-action'] === 'notifications' && typeof candidate.type === 'string').length, 0,
    'the mounted viewer never renders a notification entry');
  assert.deepEqual(nodes(view.renderer, { 'data-fm-overlay': 'roots' }), []);
  assert.deepEqual(nodes(view.renderer, { 'data-fm-action': 'locations' }), []);
  assert.deepEqual(nodes(view.renderer, { 'data-fm-action': 'close-roots' }), []);
});

test('returning preserves the mounted editor, directly editable draft, selected paths and directory', async t => {
  const view = await setup(t);
  await view.openHello();
  const original = editorNodes(view.renderer)[0];
  assert.equal(editorProps(view.renderer).canWrite, true);
  editorEdit(view, 'draft retained across viewer visibility');
  assert.equal(nodes(view.renderer, action('edit')).length, 0);
  assert.equal(nodes(view.renderer, action('expand-viewer')).length, 0);
  assert.doesNotMatch(overlay(view, 'viewer').props.className, /fm-overlay-expanded/);
  await view.click(action('back-to-files'));
  assert.equal(overlay(view, 'viewer').props.hidden, true);
  assert.equal(node(view.renderer, { className: 'fm-base' }).props.inert, undefined);
  assert.equal(editorNodes(view.renderer)[0], original);
  assert.equal(editorProps(view.renderer).value, 'draft retained across viewer visibility');
  assert.equal(node(view.renderer, { 'aria-label': '选择: hello.txt' }).props.checked, true);
  await view.click(action('open-documents'));
  assert.equal(overlay(view, 'viewer').props.hidden, false);
  assert.equal(editorNodes(view.renderer)[0], original);
  assert.equal(editorProps(view.renderer).value, 'draft retained across viewer visibility');
  assert.equal(editorProps(view.renderer).path, 'folder/hello.txt');
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), '<script>not executable</script>\n你好');
});

test('closing a dirty file still requires a decision, cancelling keeps the viewer and discard destroys that document', async t => {
  const view = await setup(t);
  await folder(view); await preview(view);
  editorEdit(view, 'unsaved');
  await view.click({ 'data-fm-action': 'close-document', 'data-fm-close-document': 'document-1' });
  assert.equal(node(view.renderer, action('close-cancel')).props.disabled, false);
  assert.equal(overlay(view, 'viewer').findByProps({ className: 'fm-overlay-card' }).props.inert, '');
  await view.click(action('close-cancel'));
  assert.equal(overlay(view, 'viewer').props.hidden, false);
  assert.equal(editorProps(view.renderer).value, 'unsaved');
  await view.click({ 'data-fm-action': 'close-document', 'data-fm-close-document': 'document-1' });
  await view.click(action('close-discard'));
  assert.equal(overlay(view, 'viewer').props.hidden, true);
  assert.equal(editorNodes(view.renderer).length, 0);
});

test('late text reads never reopen a viewer the user has already hidden with the window close', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let held = false;
  const view = await setup(t, { intercept: async (url, init, route) => {
    const response = await route(url, init);
    if (typeof init.body === 'string' && JSON.parse(init.body).op === 'text.read') { held = true; await gate; }
    return response;
  } });
  await folder(view);
  await act(async () => { node(view.renderer, { 'data-fm-path': 'folder/hello.txt' }).props.onClick(); });
  assert.equal(overlay(view, 'viewer').props.hidden, false);
  assert.equal(nodes(view.renderer, { 'data-fm-file-attempt': 'loading' }).length, 1);
  act(() => windowClose(view).props.onClick());
  await act(async () => { release(); await view.settle(); });
  assert.equal(held, true);
  assert.equal(overlay(view, 'viewer').props.hidden, true);
  assert.equal(nodes(view.renderer, { 'data-fm-file-attempt': 'loading' }).length, 0,
    'the hidden viewer no longer holds a stale loading attempt');
  const documents = view.client.cells.get('main:file-manager').options.inject().documents;
  assert.equal(documents.getSnapshot().documents.length, 0, 'the late read must not add a document');
  // With no surviving document there is nothing to resume: the entry stays
  // disabled and the window must not come back on its own.
  assert.equal(node(view.renderer, action('open-documents')).props.disabled, true);
  assert.equal(overlay(view, 'viewer').props.hidden, true, 'an invalidated late read never reopens the viewer');
});

test('a late text read after returning to the list keeps the document without reopening the viewer', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let held = false;
  const view = await setup(t, { intercept: async (url, init, route) => {
    const response = await route(url, init);
    if (typeof init.body === 'string' && JSON.parse(init.body).op === 'text.read') { held = true; await gate; }
    return response;
  } });
  await folder(view);
  await act(async () => { node(view.renderer, { 'data-fm-path': 'folder/hello.txt' }).props.onClick(); });
  assert.equal(overlay(view, 'viewer').props.hidden, false);
  assert.equal(nodes(view.renderer, { 'data-fm-file-attempt': 'loading' }).length, 1);
  act(() => node(view.renderer, action('back-to-files')).props.onClick());
  await act(async () => { release(); await view.settle(); });
  assert.equal(held, true);
  // Back-to-files is a hide-only exit: the read still lands as a document, but
  // the viewer stays hidden until the user re-enters through open-documents.
  assert.equal(overlay(view, 'viewer').props.hidden, true);
  const documents = view.client.cells.get('main:file-manager').options.inject().documents;
  assert.equal(documents.getSnapshot().documents.length, 1, 'the returned-from read still becomes an open document');
  assert.equal(nodes(view.renderer, { 'data-fm-file-attempt': 'loading' }).length, 0);
  await view.click(action('open-documents'));
  assert.equal(overlay(view, 'viewer').props.hidden, false);
  assert.equal(editorProps(view.renderer).path, 'folder/hello.txt');
});

test('an unreadable file shows its own failure, never stale content; download targets it rather than selection', async t => {
  const view = await setup(t, { transfers: true, seed: root => writeFile(path.join(root, 'folder/data.bin'), Buffer.from([0, 255, 128])) });
  await view.openHello();
  await view.click(action('back-to-files'));
  await view.click({ 'data-fm-path': 'folder/data.bin' });
  assert.equal(nodes(view.renderer, { 'data-fm-file-attempt': 'failed' }).length, 1);
  assert.equal(node(view.renderer, { className: 'fm-preview' }).props.hidden, true);
  assert.equal(node(view.renderer, { 'aria-label': '选择: hello.txt' }).props.checked, true);
  const before = view.requests.length;
  await view.click(action('download-viewed-file'));
  const download = view.requests.slice(before).map(request => typeof request.init.body === 'string' ? JSON.parse(request.init.body) : {}).find(body => body.op === 'transfers.begin');
  assert.equal(download.path, 'folder/data.bin');
  assert.equal(download.direction, 'download');
  assert.equal(typeof download.expectedVersion, 'string');
  assert.equal(node(view.renderer, { 'aria-label': '选择: hello.txt' }).props.checked, true);
  await view.click({ 'aria-label': '关闭' });
  const documents = view.client.cells.get('main:file-manager').options.inject().documents;
  const existing = documents.getSnapshot().documents[0].id;
  assert.equal(overlay(view, 'viewer').props.hidden, false, 'closing the dialog returns to the failed attempt, not the editor');
  assert.equal(nodes(view.renderer, { 'data-fm-file-attempt': 'failed' }).length, 1);
  // With only the failed attempt in flight, the header shows the attempt title;
  // the window X is the document-free way out and clears the attempt state.
  assert.equal(header(view).findAll(candidate => candidate.props.className === 'fm-viewer-title').length, 1);
  await view.click(action('close-viewer'));
  assert.equal(overlay(view, 'viewer').props.hidden, true);
  assert.equal(nodes(view.renderer, { 'data-fm-file-attempt': 'failed' }).length, 0);
  await view.click(action('open-documents'));
  assert.equal(documents.getSnapshot().documents[0].id, existing);
  assert.equal(editorProps(view.renderer).path, 'folder/hello.txt');
});

test('closing a loading viewer invalidates its late read without closing the previous document', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const view = await setup(t, { seed: root => writeFile(path.join(root, 'folder', 'other.txt'), 'other'), intercept: async (url, init, route) => {
    const response = await route(url, init);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (body.op === 'text.read' && body.path === 'folder/other.txt') await gate;
    return response;
  } });
  await folder(view); await preview(view);
  editorEdit(view, 'previous draft');
  await view.click(action('back-to-files'));
  act(() => node(view.renderer, { 'data-fm-path': 'folder/other.txt' }).props.onClick());
  assert.equal(nodes(view.renderer, { 'data-fm-file-attempt': 'loading' }).length, 1);
  // The window X stays enabled while a read is in flight; hiding clears the
  // attempt so the late response can neither add a document nor reopen the view.
  assert.equal('disabled' in windowClose(view).props, false);
  act(() => windowClose(view).props.onClick());
  await act(async () => { release(); await view.settle(); });
  const documents = view.client.cells.get('main:file-manager').options.inject().documents;
  assert.equal(documents.getSnapshot().documents.length, 1);
  assert.equal(documents.getSnapshot().documents[0].draft, 'previous draft');
  assert.equal(overlay(view, 'viewer').props.hidden, true);
  assert.equal(nodes(view.renderer, { 'data-fm-file-attempt': 'loading' }).length, 0);
});

test('read-only viewer has no writable edit action and return does not send any write', async t => {
  const view = await setup(t, { intercept: async (url, init, route) => {
    const response = await route(url, init);
    if (typeof init.body === 'string' && JSON.parse(init.body).op === 'bootstrap') {
      const envelope = await response.json(); envelope.value.capabilities.write = false;
      return Response.json(envelope);
    }
    return response;
  } });
  await folder(view); await preview(view);
  assert.equal(nodes(view.renderer, action('edit')).length, 0);
  assert.equal(nodes(view.renderer, action('save')).length, 0);
  assert.equal(node(view.renderer, { 'data-fm-code-mode': 'preview' }).props['data-fm-code-mode'], 'preview');
  const before = view.requests.length;
  await view.click(action('back-to-files'));
  await view.click(action('open-documents'));
  assert.equal(view.requests.length, before);
  assert.equal(editorProps(view.renderer).canWrite, false);
});

test('task updates remain discoverable but never force the task panel open or dismiss history', async t => {
  const view = await setup(t, { tasks: true, transfers: true });
  const activity = view.client.cells.get('main:file-manager').options.inject().activity;
  act(() => activity.put('tasks', {
    id: 'failed-background', status: 'failed', operation: 'copy', updatedAt: 1000,
    historyRevision: 0, canDismiss: true, dismissed: false,
    items: [{ id: 'item', status: 'failed', source: { rootId: 'root', path: 'sample.txt' } }],
  }));
  assert.equal(overlay(view, 'tasks').props.hidden, true);
  assert.equal(node(view.renderer, action('show-tasks')).props.className, 'fm-task-attention');
  assert.equal(nodes(view.renderer, { 'data-fm-task-id': 'failed-background', 'data-fm-task-status': 'failed' }).length, 1);
  const before = view.requests.length;
  await view.click(action('show-tasks'));
  const tasksHeader = nodes(view.renderer, { className: 'fm-overlay-header' }).find(bar => bar.findByProps({ 'data-fm-action': 'close-tasks' }));
  assert.ok(tasksHeader, 'the tasks overlay renders a header');
  assert.equal(tasksHeader.findAllByType('button').length, 1, 'the task header keeps only its close button');
  const tasksClose = tasksHeader.findAllByType('button')[0];
  assert.equal(textOf(tasksClose), '关闭');
  assert.equal(tasksClose.props['data-fm-action'], 'close-tasks');
  assert.equal(tasksHeader.findAll(candidate => candidate.props['data-fm-action'] === 'notifications').length, 0,
    'the task header never carries the notification entry');
  await view.click(action('close-tasks'));
  assert.equal(activity.getSnapshot().tasks[0].dismissed, false);
  assert.equal(view.requests.length, before, 'opening and closing the task panel sends no request');
});

test('root navigation returns to the root without any locations panel', async t => {
  const view = await setup(t);
  await folder(view);
  await clickRootCrumb(view);
  assert.deepEqual(nodes(view.renderer, { 'data-fm-overlay': 'roots' }), [], 'no locations drawer exists to dismiss');
  assert.deepEqual(nodes(view.renderer, { 'data-fm-action': 'close-roots' }), []);
  assert.equal(view.runtime.location.path, '', 'the root crumb returns to the root');
  assert.equal(nodes(view.renderer, { 'data-fm-path': 'folder' }).length, 1, 'the root listing still shows the folder');
});
