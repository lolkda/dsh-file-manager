import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { act, clickRootCrumb, node, setup, textOf } from './client-harness.mjs';

// Shipped Client + real Host: dismissal changes presentation, never the
// clipboard operation or an already-committed filesystem mutation.
// Every migrated hint is now an event in the plugin-owned history. These cases
// keep their original behaviours — dismissing presentation never touches the
// operation, the clipboard payload or an already-committed mutation — and assert
// that no banner node comes back.
const entriesOf = view => view.notifications.getSnapshot().entries;
const eventsWithCode = (view, code) => entriesOf(view).filter(entry => entry.code === code);
const legacyBanners = view => view.renderer.root.findAll(entry => typeof entry.type === 'string'
  && (entry.props['data-fm-notice-dismiss'] !== undefined || entry.props['data-fm-operation-result'] !== undefined)).length;
const dismissNewest = view => view.click({ 'data-fm-action': 'notification-dismiss', 'data-fm-notification-id': entriesOf(view)[0].id });

test('directory fallback notice can be dismissed and returns for the next directory selection', async t => {
  const view = await setup(t, { transfers: true });
  await view.click({ 'data-fm-action': 'upload-directory' });
  assert.equal(legacyBanners(view), 0, 'the fallback hint is no longer a banner in the file list');
  assert.equal(eventsWithCode(view, 'DIRECTORY_FALLBACK').length, 1);
  // The hint moved into the event history: it is readable in the drawer, and the
  // file list no longer renders a banner node for it.
  assert.match(textOf(node(view.renderer, { 'data-fm-overlay': 'notifications' })), /无法识别空目录/);
  await dismissNewest(view);
  assert.deepEqual(entriesOf(view), []);
  assert.equal(node(view.renderer, { 'data-fm-action': 'upload-directory' }).props.disabled, false);
  await view.click({ 'data-fm-action': 'upload-directory' });
  assert.equal(eventsWithCode(view, 'DIRECTORY_FALLBACK').length, 1, 'a fresh attempt is a fresh event');
});

test('closing the clipboard notice retains a usable paste and a new copy shows it again', async t => {
  const view = await setup(t, { tasks: true });
  await view.openHello();
  await view.click({ 'data-fm-action': 'copy' });
  assert.equal(legacyBanners(view), 0, 'the clipboard banner is gone');
  assert.equal(eventsWithCode(view, 'CLIPBOARD_ITEMS').length, 1);
  await dismissNewest(view);
  assert.deepEqual(entriesOf(view), []);
  assert.equal(node(view.renderer, { 'data-fm-action': 'paste' }).props.disabled, false);
  await clickRootCrumb(view);
  assert.deepEqual(entriesOf(view), [], 'navigation must not undo dismissal');
  await view.click({ 'data-fm-action': 'paste' });
  await view.click({ 'data-fm-action': 'paste-confirm' });
  const [task] = await view.tasks.list();
  assert.ok(task, 'closing the notice must not clear the clipboard payload');
  await view.waitForTask(task.id);
  assert.equal(await readFile(path.join(view.root, 'hello.txt'), 'utf8'), '<script>not executable</script>\n你好');
  await access(path.join(view.root, 'folder/hello.txt'));
  await view.openHello();
  await view.click({ 'data-fm-action': 'copy' });
  assert.equal(eventsWithCode(view, 'CLIPBOARD_ITEMS').length, 1, 'a fresh clipboard action gets a fresh event');
});

test('dismissing a completed deletion result neither repeats nor reverses the deletion', async t => {
  const view = await setup(t);
  await view.openHello();
  await view.click({ 'data-fm-action': 'delete' });
  await act(async () => {
    node(view.renderer, { 'aria-label': '我确认永久删除不可恢复' }).props.onChange({ target: { checked: true } });
  });
  await view.click({ 'data-fm-action': 'delete-confirm' });
  assert.equal(legacyBanners(view), 0, 'the operation-result banner is gone');
  assert.equal(eventsWithCode(view, 'OPERATION_RESULT').length, 1);
  const commits = () => view.requests.filter(({ init }) => init.body && JSON.parse(init.body).op === 'delete.commit').length;
  const count = commits();
  assert.equal(count, 1);
  await assert.rejects(access(path.join(view.root, 'folder/hello.txt')), { code: 'ENOENT' });
  await dismissNewest(view);
  assert.deepEqual(entriesOf(view), []);
  assert.equal(commits(), count);
  await assert.rejects(access(path.join(view.root, 'folder/hello.txt')), { code: 'ENOENT' });
  await access(path.join(view.root, 'folder'));
});

test('ordinary errors can be dismissed without suppressing a subsequent error', async t => {
  let failListing = false;
  const view = await setup(t, { intercept: async (url, init, route) => {
    if (failListing && init.body && JSON.parse(init.body).op === 'entries.list') {
      return new Response(JSON.stringify({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'Notice dismissal test failure' } }), {
        status: 403, headers: { 'content-type': 'application/json' },
      });
    }
    return route(url, init);
  } });
  failListing = true;
  await view.click({ 'data-fm-action': 'refresh' });
  assert.equal(legacyBanners(view), 0, 'the error banner is gone');
  assert.equal(eventsWithCode(view, 'PERMISSION_DENIED').length, 1);
  await dismissNewest(view);
  assert.deepEqual(entriesOf(view), []);
  assert.equal(node(view.renderer, { 'data-fm-action': 'refresh' }).props.disabled, false);
  await view.click({ 'data-fm-action': 'refresh' });
  assert.equal(eventsWithCode(view, 'PERMISSION_DENIED').length, 1, 'a later error is not suppressed by an earlier dismissal');
});
