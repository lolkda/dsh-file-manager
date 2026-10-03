import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { act, node, nodes, setup, textOf } from './client-harness.mjs';

// Shipped Client + real Host: dismissal changes presentation, never the
// clipboard operation or an already-committed filesystem mutation.
const dismiss = kind => ({ 'data-fm-notice-dismiss': kind });
const visible = (view, kind) => nodes(view.renderer, dismiss(kind)).length;

test('directory fallback notice can be dismissed and returns for the next directory selection', async t => {
  const view = await setup(t, { transfers: true });
  await view.click({ 'data-fm-action': 'upload-directory' });
  assert.equal(visible(view, 'directory-fallback'), 1);
  assert.match(textOf(view.renderer.root), /无法识别空目录/);
  await view.click(dismiss('directory-fallback'));
  assert.equal(visible(view, 'directory-fallback'), 0);
  assert.doesNotMatch(textOf(view.renderer.root), /无法识别空目录/);
  assert.equal(node(view.renderer, { 'data-fm-action': 'upload-directory' }).props.disabled, false);
  await view.click({ 'data-fm-action': 'upload-directory' });
  assert.equal(visible(view, 'directory-fallback'), 1);
  assert.match(textOf(view.renderer.root), /无法识别空目录/);
});

test('closing the clipboard notice retains a usable paste and a new copy shows it again', async t => {
  const view = await setup(t, { tasks: true });
  await view.openHello();
  await view.click({ 'data-fm-action': 'copy' });
  assert.equal(visible(view, 'clipboard'), 1);
  await view.click(dismiss('clipboard'));
  assert.equal(visible(view, 'clipboard'), 0);
  assert.equal(node(view.renderer, { 'data-fm-action': 'paste' }).props.disabled, false);
  await view.click({ 'data-fm-root': true });
  assert.equal(visible(view, 'clipboard'), 0, 'navigation must not undo dismissal');
  await view.click({ 'data-fm-action': 'paste' });
  await view.click({ 'data-fm-action': 'paste-confirm' });
  const [task] = await view.tasks.list();
  assert.ok(task, 'closing the notice must not clear the clipboard payload');
  await view.waitForTask(task.id);
  assert.equal(await readFile(path.join(view.root, 'hello.txt'), 'utf8'), '<script>not executable</script>\n你好');
  await access(path.join(view.root, 'folder/hello.txt'));
  await view.openHello();
  await view.click({ 'data-fm-action': 'copy' });
  assert.equal(visible(view, 'clipboard'), 1, 'a fresh clipboard action gets a fresh notice');
});

test('dismissing a completed deletion result neither repeats nor reverses the deletion', async t => {
  const view = await setup(t);
  await view.openHello();
  await view.click({ 'data-fm-action': 'delete' });
  await act(async () => {
    node(view.renderer, { 'aria-label': '我确认永久删除不可恢复' }).props.onChange({ target: { checked: true } });
  });
  await view.click({ 'data-fm-action': 'delete-confirm' });
  assert.equal(visible(view, 'operation-result'), 1);
  assert.equal(nodes(view.renderer, { 'data-fm-operation-result': 'completed' }).length, 1);
  const commits = () => view.requests.filter(({ init }) => init.body && JSON.parse(init.body).op === 'delete.commit').length;
  const count = commits();
  assert.equal(count, 1);
  await assert.rejects(access(path.join(view.root, 'folder/hello.txt')), { code: 'ENOENT' });
  await view.click(dismiss('operation-result'));
  assert.equal(visible(view, 'operation-result'), 0);
  assert.equal(nodes(view.renderer, { 'data-fm-operation-result': 'completed' }).length, 0);
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
  assert.equal(visible(view, 'error'), 1);
  await view.click(dismiss('error'));
  assert.equal(visible(view, 'error'), 0);
  assert.equal(node(view.renderer, { 'data-fm-action': 'refresh' }).props.disabled, false);
  await view.click({ 'data-fm-action': 'refresh' });
  assert.equal(visible(view, 'error'), 1);
});
