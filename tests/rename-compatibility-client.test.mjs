/**
 * Direct compatible rename: the Client boundary.
 *
 * The subject is the shipped Client bundle against the real v2 Host (see
 * `client-harness.mjs`). The contract is intentionally simpler than the old
 * explicit-confirmation flow:
 *   - the rename dialog only offers Cancel and Confirm name;
 *   - the first and only rename request carries `allowNonExclusiveRename: true`
 *     plus the source version captured when the dialog opened;
 *   - the Host still tries atomic no-replace first and only falls back when the
 *     filesystem itself proves it cannot enforce that guarantee;
 *   - helper startup failures, permission errors and uncertain outcomes are
 *     reported in the dialog and never trigger a fallback;
 *   - create, copy, move, upload and publish never inherit the rename exception.
 */

import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { act, editorEdit, editorProps, node, nodes, setup, textOf } from './client-harness.mjs';
import { loadClientModule } from './client-module-loader.mjs';

const COMPAT_BLOCK = { 'data-fm-rename-compatibility': true };
const COMPAT_ACTION = { 'data-fm-action': 'rename-compatibility' };
const STRICT_ACTION = { 'data-fm-action': 'name-submit' };
const CANCEL_ACTION = { 'data-fm-action': 'name-cancel' };
const NAME_INPUT = { 'data-fm-name': true };

const reply = (payload, status = 500) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

/** A helper that could not be started: same unsupported code, no compatibility marker. */
const HELPER_UNSTARTABLE = () => ({
  status: 501,
  payload: {
    ok: false,
    error: {
      code: 'UNSUPPORTED_ATOMIC_RENAME',
      message: 'The atomic rename helper could not be started; no unsafe fallback was attempted.',
      details: { cause: 'ENOENT' },
    },
  },
});

/** An unconfirmed outcome must never be retried as a plain rename. */
const UNCERTAIN = () => ({
  status: 500,
  payload: {
    ok: false,
    error: {
      code: 'ATOMIC_RENAME_UNCERTAIN',
      message: 'The rename outcome could not be confirmed.',
      details: { outcome: 'unknown', compatibilityAvailable: true },
    },
  },
});

/**
 * Observes every rename and optionally answers it instead of routing to the
 * real Host. The stat answer is captured so the version the dialog bound can be
 * compared with the versions actually sent.
 */
const renameBoundary = decide => {
  const attempts = [];
  const stats = [];
  const intercept = async (url, init, route) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (body && body.op === 'entries.stat') {
      const response = await route(url, init);
      stats.push(await response.clone().json());
      return response;
    }
    if (!body || body.op !== 'entries.rename') return route(url, init);
    attempts.push(body);
    const answer = decide(attempts.length, body);
    if (!answer || answer === 'route') return route(url, init);
    return reply(answer.payload, answer.status);
  };
  return {
    intercept,
    attempts,
    stats,
    /** The version the rename dialog captured from `entries.stat`. */
    sourceVersion: () => stats.at(-1)?.value?.version,
  };
};

const openRenameDialog = async view => {
  await view.openHello();
  await view.click({ 'data-fm-action': 'rename' });
};

const setName = async (view, value) => {
  await act(async () => { node(view.renderer, NAME_INPUT).props.onChange({ target: { value } }); });
};

const compatBlock = view => nodes(view.renderer, COMPAT_BLOCK);
const compatAction = view => nodes(view.renderer, COMPAT_ACTION);
const alertsIn = element => element.findAll(item => item.props.role === 'alert');
/** One open dialog by its own title, so a stale shared error can be looked for inside it. */
const dialogByTitle = (view, title) => view.renderer.root
  .findAll(item => item.props.role === 'dialog' && item.props['aria-label'] === title).at(-1) ?? null;
const renameDialog = view => dialogByTitle(view, '重命名');

const sourcePath = path.join('folder', 'hello.txt');

test('the rename dialog has no compatibility UI and the first submit authorizes the fallback', async t => {
  const boundary = renameBoundary(() => 'route');
  const view = await setup(t, { intercept: boundary.intercept });
  await openRenameDialog(view);

  assert.equal(compatBlock(view).length, 0, 'there is no compatibility risk block');
  assert.equal(compatAction(view).length, 0, 'there is no separate compatibility button');
  assert.equal(nodes(view.renderer, { 'aria-label': '我已了解：最后一次检查之后由其他客户端创建的同名文件或空目录可能被替换' }).length, 0,
    'there is no acknowledgement checkbox');

  await setName(view, '改名.txt');
  assert.equal(node(view.renderer, STRICT_ACTION).props.disabled, false, 'a non-empty name enables Confirm name');
  await view.click(STRICT_ACTION);

  assert.equal(boundary.attempts.length, 1, 'a single confirm sends exactly one rename');
  const [rename] = boundary.attempts;
  assert.equal(rename.allowNonExclusiveRename, true, 'the first and only rename request authorizes the compatible fallback');
  assert.equal(rename.expectedVersion, boundary.sourceVersion(), 'the request carries the version captured when the dialog opened');
  assert.ok(typeof rename.requestId === 'string' && rename.requestId.length > 0, 'the request has a request id');

  await assert.rejects(access(path.join(view.root, sourcePath)), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(view.root, 'folder', '改名.txt'), 'utf8'), '<script>not executable</script>\n你好');
  assert.equal(nodes(view.renderer, NAME_INPUT).length, 0, 'a completed rename closes the dialog');
});

test('Enter submits the same direct-compatible rename once', async t => {
  const boundary = renameBoundary(() => 'route');
  const view = await setup(t, { intercept: boundary.intercept });
  await openRenameDialog(view);
  await setName(view, '回车改名.txt');

  await act(async () => {
    node(view.renderer, NAME_INPUT).props.onKeyDown({ key: 'Enter', preventDefault() {} });
    await view.settle();
  });

  assert.equal(boundary.attempts.length, 1, 'Enter sends exactly one rename');
  assert.equal(boundary.attempts[0].allowNonExclusiveRename, true, 'Enter carries the same compatibility authorization');
  await access(path.join(view.root, 'folder', '回车改名.txt'));
});

test('a helper that cannot start reports an error without offering a fallback', async t => {
  const boundary = renameBoundary(() => HELPER_UNSTARTABLE());
  const view = await setup(t, { intercept: boundary.intercept });
  await openRenameDialog(view);
  await setName(view, '改名.txt');
  await view.click(STRICT_ACTION);

  assert.equal(boundary.attempts.length, 1, 'a failed helper does not trigger a second request');
  assert.equal(boundary.attempts[0].allowNonExclusiveRename, true, 'the request itself still carries the direct authorization');
  assert.equal(compatBlock(view).length, 0);
  assert.equal(compatAction(view).length, 0);
  assert.equal(alertsIn(renameDialog(view)).length, 1, 'the failure is shown in the rename dialog');
  assert.match(textOf(renameDialog(view)), /重命名未能完成/);
  await access(path.join(view.root, sourcePath));
});

test('an uncertain outcome stays uncertain and never opens a compatibility path', async t => {
  const boundary = renameBoundary(() => UNCERTAIN());
  const view = await setup(t, { intercept: boundary.intercept });
  await openRenameDialog(view);
  await setName(view, '改名.txt');
  await view.click(STRICT_ACTION);

  assert.equal(boundary.attempts.length, 1);
  assert.equal(compatBlock(view).length, 0);
  assert.equal(compatAction(view).length, 0);
  assert.equal(alertsIn(renameDialog(view)).length, 1);
  assert.match(textOf(renameDialog(view)), /检查源与目标/);
  await access(path.join(view.root, sourcePath));
});

test('two clicks in one tick still send one rename request', async t => {
  const boundary = renameBoundary(() => 'route');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const view = await setup(t, { intercept: async (url, init, route) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (body && body.op === 'entries.rename') {
      const response = await boundary.intercept(url, init, route);
      await gate;
      return response;
    }
    return boundary.intercept(url, init, route);
  } });
  t.after(release);
  await openRenameDialog(view);
  await setName(view, '双击.txt');

  await act(async () => {
    const button = node(view.renderer, STRICT_ACTION);
    button.props.onClick();
    button.props.onClick();
  });
  assert.equal(boundary.attempts.length, 1, 'the first click owns the attempt');

  await act(async () => { release(); await view.settle(); });
  assert.equal(boundary.attempts.length, 1, 'the burst produced one request');
  await access(path.join(view.root, 'folder', '双击.txt'));
});

test('a direct-compatible rename keeps the reviewed draft and refreshes the listing', async t => {
  const boundary = renameBoundary(() => 'route');
  const view = await setup(t, { intercept: boundary.intercept });
  await view.openHello();
  editorEdit(view, '草稿跟随重命名');

  await view.click({ 'data-fm-action': 'rename' });
  await setName(view, '改名.txt');
  await view.click(STRICT_ACTION);

  assert.equal(editorProps(view.renderer)?.value, '草稿跟随重命名', 'the draft followed the rename');
  assert.equal(await readFile(path.join(view.root, 'folder', '改名.txt'), 'utf8'), '<script>not executable</script>\n你好');
  await view.click({ 'data-fm-action': 'save' });
  assert.equal(await readFile(path.join(view.root, 'folder', '改名.txt'), 'utf8'), '草稿跟随重命名');
  assert.equal(nodes(view.renderer, { 'data-fm-path': 'folder/改名.txt' }).length, 1);
});

test('a rename failure that lands after the view is gone is still recorded', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const boundary = renameBoundary(() => HELPER_UNSTARTABLE());
  const view = await setup(t, { intercept: async (url, init, route) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (body && body.op === 'entries.rename') {
      const response = await boundary.intercept(url, init, route);
      await gate;
      return response;
    }
    return boundary.intercept(url, init, route);
  } });
  t.after(release);
  await openRenameDialog(view);
  await setName(view, '改名.txt');
  await act(async () => { node(view.renderer, STRICT_ACTION).props.onClick(); });
  assert.equal(boundary.attempts.length, 1, 'the rename is in flight');

  view.unmount();
  await act(async () => { release(); await view.settle(); });
  assert.ok(view.notifications.getSnapshot().entries.some(entry => entry.code === 'UNSUPPORTED_ATOMIC_RENAME'),
    'a confirmed rename with no dialog left to speak through is recorded in the history');
});

test('the language catalogs no longer describe a compatibility confirmation flow', async t => {
  const { en, zh } = await loadClientModule('i18n');
  for (const key of ['renameCompatibilityTitle', 'renameCompatibilityRisk', 'renameCompatibilityAck', 'renameCompatibilitySubmit']) {
    assert.equal(en[key], undefined, `${key} must be removed from the English catalog`);
    assert.equal(zh[key], undefined, `${key} must be removed from the Chinese catalog`);
  }
  for (const [language, dictionary] of [['en', en], ['zh', zh]]) {
    const unsupported = dictionary['error.UNSUPPORTED_ATOMIC_RENAME'];
    assert.ok(unsupported, `${language} still needs a rename failure message`);
    assert.ok(!/atomic|原子|compatible|兼容/i.test(unsupported),
      `${language} must not explain a compatibility warning that no longer exists`);
    assert.match(dictionary['error.ATOMIC_RENAME_UNCERTAIN'], /inspect|检查/i, `${language} must require inspecting the source and the destination`);
  }
  void t;
});
