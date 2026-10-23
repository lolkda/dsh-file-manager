/**
 * Explicitly confirmed compatible rename: the Client boundary.
 *
 * The subject is the shipped Client bundle against the real v2 Host (see
 * `client-harness.mjs`). This portable suite does not require an NFS mount: the
 * kernel refusing `renameat2(RENAME_NOREPLACE)` is the one answer it reproduces at
 * the protocol boundary — the same way the deletion suite answers a manifest it
 * has to observe — so it can run anywhere. A real NFS mount is verified separately
 * by the Lead. Every other request, including the compatibility rename itself, is
 * routed to the real Host and really renames a file in a temporary granted root.
 *
 * The contract these tests pin down:
 *   - the first submit of one rename attempt is always the strict one: no
 *     `allowNonExclusiveRename`, and it carries the version captured when the
 *     dialog opened;
 *   - only the rename *request's* own refusal may offer the downgrade, and only
 *     when the Host said `UNSUPPORTED_ATOMIC_RENAME` *and* marked it
 *     `details.compatibilityAvailable === true`. A later step of the same
 *     submission, another action's failure, or the shared panel error slot can
 *     never open it — a failure after a committed rename is shown in the dialog
 *     with no compatibility entry at all;
 *   - the risk is stated in plain words and the acknowledgement starts unchecked:
 *     after the Host's last check another NFS client or process may create a
 *     same-named file or empty directory, and the plain rename would replace it.
 *     The wording never claims the plain rename is not atomic — it is atomic, it
 *     just cannot promise no-replace;
 *   - the compatibility action is its own control, never the Enter key and never
 *     the primary submit. It sends `allowNonExclusiveRename: true` with a *new*
 *     request id and the *same* source version, so nothing bypasses the version
 *     guard by re-reading the source;
 *   - the acknowledgement and the offer belong to one attempt: a name edit, a
 *     cancel, a reopen, any later failure and a completed submit all discard them,
 *     and two submits in one tick can never send two renames;
 *   - a confirmed compatible rename keeps the reviewed document draft and
 *     refreshes the listing, exactly like the strict path.
 */

import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { act, editorEdit, editorProps, node, nodes, setup, textOf } from './client-harness.mjs';
import { loadClientModule } from './client-module-loader.mjs';

/** The acknowledgement label is the control's accessible name in both cases. */
const ACK = '我已了解：最后一次检查之后由其他客户端创建的同名文件或空目录可能被替换';
const RISK_BLOCK = { 'data-fm-rename-compatibility': true };
const COMPAT_ACTION = { 'data-fm-action': 'rename-compatibility' };
const STRICT_ACTION = { 'data-fm-action': 'name-submit' };
const CANCEL_ACTION = { 'data-fm-action': 'name-cancel' };
const NAME_INPUT = { 'data-fm-name': true };

const reply = (payload, status = 500) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

/** The one downgrade the Host may authorize: a filesystem without no-replace. */
const NOT_ATOMIC = () => ({
  status: 501,
  payload: {
    ok: false,
    error: {
      code: 'UNSUPPORTED_ATOMIC_RENAME',
      message: 'This filesystem cannot guarantee atomic no-replace rename.',
      details: { compatibilityAvailable: true },
    },
  },
});

/** A helper that could not be started: same code, and deliberately no marker. */
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

/** An unconfirmed outcome: even a stray marker must not unlock the downgrade. */
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
 * Observes every rename and answers the ones a decision names.
 *
 * `decide(attemptNumber, body)` returns either `'route'` (the real Host handles
 * it) or one of the refusal shapes above. The stat answer is captured so the
 * version the dialog bound can be compared with the versions actually sent.
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
    strict: () => attempts.filter(item => item.allowNonExclusiveRename !== true),
    compatible: () => attempts.filter(item => item.allowNonExclusiveRename === true),
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

const acknowledge = async view => {
  await act(async () => { node(view.renderer, { 'aria-label': ACK }).props.onChange({ target: { checked: true } }); });
};

const compatBlock = view => nodes(view.renderer, RISK_BLOCK);
const compatButton = view => nodes(view.renderer, COMPAT_ACTION)[0];
const acknowledged = view => node(view.renderer, { 'aria-label': ACK }).props.checked;
const alertsIn = element => element.findAll(item => item.props.role === 'alert');
/** One open dialog by its own title, so a stale shared error can be looked for inside it. */
const dialogByTitle = (view, title) => view.renderer.root
  .findAll(item => item.props.role === 'dialog' && item.props['aria-label'] === title).at(-1) ?? null;
const renameDialog = view => dialogByTitle(view, '重命名');

const sourcePath = path.join('folder', 'hello.txt');

test('the first rename stays strict and the reviewed compatibility offer is explicit', async t => {
  const boundary = renameBoundary(() => NOT_ATOMIC());
  const view = await setup(t, { intercept: boundary.intercept });
  await openRenameDialog(view);
  await setName(view, '改名.txt');
  await view.click(STRICT_ACTION);

  assert.equal(boundary.attempts.length, 1, 'one submit sends exactly one rename');
  assert.equal('allowNonExclusiveRename' in boundary.attempts[0], false, 'the first submit never authorizes the compatible rename');
  assert.equal(boundary.attempts[0].expectedVersion, boundary.sourceVersion(), 'the strict rename binds the version the dialog captured');
  assert.equal(boundary.stats.length, 1, 'the dialog captures the source version once');

  assert.equal(compatBlock(view).length, 1, 'the reviewed downgrade is offered only after the Host refused the atomic rename');
  const risk = textOf(node(view.renderer, RISK_BLOCK));
  assert.match(risk, /其他 NFS 客户端/, 'the risk names the other writers it is about');
  assert.match(risk, /进程/);
  assert.match(risk, /同名文件或空目录/, 'the risk names what can be replaced');
  assert.match(risk, /最后(一次)?检查/, 'the risk says when the replacement window opens');
  assert.match(risk, /替换/, 'the risk says the entry can be replaced');
  assert.match(risk, /丢失/, 'the risk says that content is lost');
  assert.ok(!/非原子|不是原子/.test(risk), 'the downgrade is still an atomic rename — it just cannot promise no-replace');

  assert.equal(acknowledged(view), false, 'the acknowledgement always starts unchecked');
  assert.equal(compatButton(view).props.disabled, true, 'the compatibility action needs the acknowledgement first');
  assert.notEqual(compatButton(view).props.disabled, node(view.renderer, STRICT_ACTION).props.disabled,
    'the compatibility action is its own control with its own gate');

  await access(path.join(view.root, sourcePath));
  await assert.rejects(access(path.join(view.root, 'folder', '改名.txt')), { code: 'ENOENT' },
    'a refused rename changed nothing on disk');
});

test('the compatibility rename is a new request id with the original source version and it really renames', async t => {
  const boundary = renameBoundary(attempt => (attempt === 1 ? NOT_ATOMIC() : 'route'));
  const view = await setup(t, { intercept: boundary.intercept });
  await openRenameDialog(view);
  await setName(view, '改名.txt');
  await view.click(STRICT_ACTION);
  await acknowledge(view);
  await view.click(COMPAT_ACTION);

  assert.equal(boundary.attempts.length, 2, 'the compatibility action submits once more');
  const [strict, compatible] = boundary.attempts;
  assert.equal(compatible.allowNonExclusiveRename, true, 'only the acknowledged action authorizes the compatible rename');
  assert.notEqual(compatible.requestId, strict.requestId, 'the downgrade is a new request id, never a replay of the refused one');
  assert.equal(compatible.expectedVersion, strict.expectedVersion, 'the source version is the one captured, not a refreshed one');
  assert.equal(compatible.expectedVersion, boundary.sourceVersion());
  assert.equal(boundary.stats.length, 1, 'nothing re-reads the source to bypass the version guard');
  assert.equal(compatible.path, sourcePath);
  assert.equal(compatible.name, '改名.txt');

  await assert.rejects(access(path.join(view.root, sourcePath)), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(view.root, 'folder', '改名.txt'), 'utf8'), '<script>not executable</script>\n你好',
    'the confirmed compatible rename is a real rename');
  assert.equal(nodes(view.renderer, { 'data-fm-path': 'folder/改名.txt' }).length, 1, 'the listing shows the new name');
  assert.equal(compatBlock(view).length, 0, 'a completed submit discards the offer');
  assert.equal(nodes(view.renderer, NAME_INPUT).length, 0, 'a completed submit closes the dialog');
});

test('an unchecked acknowledgement and the Enter key can never authorize the compatible rename', async t => {
  const boundary = renameBoundary(() => NOT_ATOMIC());
  const view = await setup(t, { intercept: boundary.intercept });
  await openRenameDialog(view);
  await setName(view, '改名.txt');
  await view.click(STRICT_ACTION);

  await act(async () => { compatButton(view).props.onClick(); await view.settle(); });
  assert.equal(boundary.attempts.length, 1, 'an unchecked acknowledgement sends nothing');

  await acknowledge(view);
  assert.equal(acknowledged(view), true);
  await act(async () => {
    node(view.renderer, NAME_INPUT).props.onKeyDown({ key: 'Enter', preventDefault() {} });
    await view.settle();
  });
  assert.equal(boundary.attempts.length, 2, 'Enter submits');
  assert.equal('allowNonExclusiveRename' in boundary.attempts[1], false, 'Enter can never authorize the compatible rename');
  assert.equal(acknowledged(view), false, 'that failure discarded the acknowledgement');
  assert.equal(compatBlock(view).length, 1, 'the same refusal may still be offered for review');
});

test('changing the name, cancelling or reopening discards the acknowledgement and the offer', async t => {
  const boundary = renameBoundary(() => NOT_ATOMIC());
  const view = await setup(t, { intercept: boundary.intercept });
  await openRenameDialog(view);
  await setName(view, '改名.txt');
  await view.click(STRICT_ACTION);
  await acknowledge(view);

  await setName(view, '另一个名字.txt');
  assert.equal(nodes(view.renderer, { 'aria-label': ACK }).length, 0,
    'an edited name never inherits an acknowledgement: the offer is withdrawn with it');
  assert.equal(compatBlock(view).length, 0, 'the offer belonged to the reviewed name, so it is withdrawn too');

  await view.click(CANCEL_ACTION);
  assert.equal(nodes(view.renderer, NAME_INPUT).length, 0);

  await view.click({ 'data-fm-action': 'rename' });
  assert.equal(compatBlock(view).length, 0, 'a reopened dialog starts from the strict path again');
  assert.equal(boundary.compatible().length, 0, 'nothing in that sequence sent a compatible rename');
});

test('a later failure of any other kind withdraws the compatibility offer', async t => {
  const boundary = renameBoundary(attempt => (attempt === 1 ? NOT_ATOMIC() : {
    status: 409,
    payload: { ok: false, error: { code: 'VERSION_CONFLICT', message: 'The source changed before rename.' } },
  }));
  const view = await setup(t, { intercept: boundary.intercept });
  await openRenameDialog(view);
  await setName(view, '改名.txt');
  await view.click(STRICT_ACTION);
  await acknowledge(view);

  await view.click(STRICT_ACTION);
  assert.equal(boundary.attempts.length, 2);
  assert.equal(nodes(view.renderer, { 'aria-label': ACK }).length, 0,
    'a later failure clears the acknowledgement together with the offer');
  assert.equal(compatBlock(view).length, 0, 'a different failure withdraws the offer entirely');
  assert.equal(nodes(view.renderer, COMPAT_ACTION).length, 0, 'and with it the compatibility action');
  assert.match(textOf(renameDialog(view)), /已变化/);
});

test('a helper that failed to start or an unconfirmed outcome never offers a compatible rename', async t => {
  for (const [name, answer] of [['a helper that could not be started', HELPER_UNSTARTABLE()], ['an unconfirmed outcome', UNCERTAIN()]]) {
    const boundary = renameBoundary(() => answer);
    const view = await setup(t, { intercept: boundary.intercept });
    await openRenameDialog(view);
    await setName(view, '改名.txt');
    await view.click(STRICT_ACTION);

    assert.equal(boundary.attempts.length, 1);
    assert.equal(compatBlock(view).length, 0, `${name} must never unlock the plain rename`);
    assert.equal(nodes(view.renderer, COMPAT_ACTION).length, 0, `${name} offers no compatibility control`);
    assert.equal(alertsIn(renameDialog(view)).length, 1, `${name} is still reported where the user is`);
  }

  // The uncertain outcome carries the marker on purpose above: the code, not the
  // marker alone, decides. Its wording must send the user to the filesystem.
  const { zh } = await loadClientModule('i18n');
  assert.match(zh['error.ATOMIC_RENAME_UNCERTAIN'], /检查源与目标/, 'the uncertain outcome must require inspecting the source and the destination first');
  assert.match(zh['error.ATOMIC_RENAME_UNCERTAIN'], /不允许/, 'and must refuse the compatible rename outright');
});

test('a failure from another action never opens the compatibility offer', async t => {
  let failListing = false;
  const view = await setup(t, { intercept: async (url, init, route) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (failListing && body && body.op === 'entries.list') return reply(NOT_ATOMIC().payload, NOT_ATOMIC().status);
    return route(url, init);
  } });
  await view.openHello();
  failListing = true;
  await view.click({ 'data-fm-action': 'refresh' });
  failListing = false;
  assert.ok(view.notifications.getSnapshot().entries.some(entry => entry.code === 'UNSUPPORTED_ATOMIC_RENAME'),
    'the other action really did fail with the downgradable code');

  await view.click({ 'data-fm-action': 'rename' });
  assert.equal(compatBlock(view).length, 0, 'the shared error slot can never open the compatibility offer');
  assert.equal(nodes(view.renderer, COMPAT_ACTION).length, 0);
  assert.equal(alertsIn(renameDialog(view)).length, 0, 'and the name dialog shows only its own attempt, not a stale failure');

  await setName(view, '改名.txt');
  await view.click(STRICT_ACTION);
  assert.equal(compatBlock(view).length, 0, 'a strict success needs no offer at all');
  assert.equal(await readFile(path.join(view.root, 'folder', '改名.txt'), 'utf8'), '<script>not executable</script>\n你好');
});

test('a double submit cannot send two compatibility requests', async t => {
  const boundary = renameBoundary(attempt => (attempt === 1 ? NOT_ATOMIC() : 'route'));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const view = await setup(t, { intercept: async (url, init, route) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (body && body.op === 'entries.rename' && body.allowNonExclusiveRename === true) {
      const response = await boundary.intercept(url, init, route);
      await gate;
      return response;
    }
    return boundary.intercept(url, init, route);
  } });
  t.after(release);
  await openRenameDialog(view);
  await setName(view, '改名.txt');
  await view.click(STRICT_ACTION);
  await acknowledge(view);

  // Two clicks in one tick: a stale `busy` closure must not let the second pass.
  await act(async () => {
    const button = compatButton(view);
    button.props.onClick();
    button.props.onClick();
  });
  assert.equal(boundary.compatible().length, 1, 'one acknowledged action sends exactly one compatible rename');
  assert.equal(acknowledged(view), false, 'the acknowledgement ends with the submission it was given for');
  assert.equal(compatButton(view).props.disabled, true, 'the compatibility action is disabled while its request is in flight');
  assert.equal(node(view.renderer, STRICT_ACTION).props.disabled, true, 'so is the strict submit');
  assert.equal(node(view.renderer, { 'aria-label': ACK }).props.disabled, true, 'and the acknowledgement it depends on');

  await act(async () => { compatButton(view).props.onClick(); release(); });
  await view.flush();
  assert.equal(boundary.compatible().length, 1, 'the burst still produced one request');
  assert.equal(await readFile(path.join(view.root, 'folder', '改名.txt'), 'utf8'), '<script>not executable</script>\n你好');
});

test('a compatible rename keeps the reviewed draft and refreshes the listing', async t => {
  const boundary = renameBoundary(attempt => (attempt === 1 ? NOT_ATOMIC() : 'route'));
  const view = await setup(t, { intercept: boundary.intercept });
  await view.openHello();
  editorEdit(view, '草稿跟随兼容重命名');

  await view.click({ 'data-fm-action': 'rename' });
  await setName(view, '兼容改名.txt');
  await view.click(STRICT_ACTION);
  await acknowledge(view);
  await view.click(COMPAT_ACTION);

  assert.equal(editorProps(view.renderer)?.value, '草稿跟随兼容重命名', 'the draft followed the compatible rename');
  assert.equal(await readFile(path.join(view.root, 'folder', '兼容改名.txt'), 'utf8'), '<script>not executable</script>\n你好');
  await view.click({ 'data-fm-action': 'save' });
  assert.equal(await readFile(path.join(view.root, 'folder', '兼容改名.txt'), 'utf8'), '草稿跟随兼容重命名');
  assert.equal(nodes(view.renderer, { 'data-fm-path': 'folder/兼容改名.txt' }).length, 1);
});

test('a failure after the rename committed stays in the dialog and offers no downgrade', async t => {
  const boundary = renameBoundary(attempt => (attempt === 1 ? NOT_ATOMIC() : 'route'));
  const view = await setup(t, { intercept: async (url, init, route) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    // The same code and marker as the rename refusal, but produced by the
    // follow-up read: only the rename request itself may authorize the downgrade.
    if (body && body.op === 'text.read' && body.path === 'folder/改名.txt') return reply(NOT_ATOMIC().payload, NOT_ATOMIC().status);
    return boundary.intercept(url, init, route);
  } });
  await view.openHello();
  editorEdit(view, '草稿跟随');
  await view.click({ 'data-fm-action': 'rename' });
  await setName(view, '改名.txt');
  await view.click(STRICT_ACTION);
  await acknowledge(view);
  await view.click(COMPAT_ACTION);

  await access(path.join(view.root, 'folder', '改名.txt'));
  await assert.rejects(access(path.join(view.root, sourcePath)), { code: 'ENOENT' }, 'the compatible rename itself committed');
  assert.equal(nodes(view.renderer, NAME_INPUT).length, 1, 'the dialog that owns the outcome is the one still showing it');
  assert.equal(alertsIn(renameDialog(view)).length, 1, 'the follow-up failure is reported where the user submitted it');
  assert.match(textOf(renameDialog(view)), /无法保证原子不覆盖/);
  assert.equal(compatBlock(view).length, 0, 'a follow-up failure can never offer the downgrade, even with the same code');
  assert.equal(nodes(view.renderer, COMPAT_ACTION).length, 0);
  assert.equal(view.notifications.getSnapshot().entries.some(entry => entry.code === 'UNSUPPORTED_ATOMIC_RENAME'), false,
    'the dialog owned that failure, so the shared history stayed untouched');
  assert.equal(editorProps(view.renderer)?.value, '草稿跟随', 'the draft is retained when the document cannot follow the rename');
  assert.equal(nodes(view.renderer, { 'data-fm-missing': true }).length, 1, 'and it is marked unavailable instead of pointing at a path that is gone');
});

test('a rename failure that lands after the view is gone is still recorded', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const boundary = renameBoundary(() => NOT_ATOMIC());
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

test('a created file that cannot be read is reported in the dialog that created it', async t => {
  const view = await setup(t, { intercept: async (url, init, route) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (body && body.op === 'text.read' && body.path === 'folder/新文件.txt') {
      return reply({ ok: false, error: { code: 'IO_ERROR', message: 'disk unavailable' } }, 500);
    }
    return route(url, init);
  } });
  await view.click({ 'data-fm-entry': 'directory', 'data-fm-path': 'folder' });
  await view.click({ 'data-fm-action': 'new-file' });
  await setName(view, '新文件.txt');
  await view.click(STRICT_ACTION);

  assert.equal(await readFile(path.join(view.root, 'folder', '新文件.txt'), 'utf8'), '', 'the file itself was created');
  const dialog = dialogByTitle(view, '新建文件');
  assert.equal(alertsIn(dialog).length, 1, 'the failure is reported where the user typed the name');
  assert.match(textOf(dialog), /文件系统操作失败/);
  assert.equal(nodes(view.renderer, NAME_INPUT).length, 1, 'the dialog stays so the outcome is not lost');
  assert.equal(view.notifications.getSnapshot().entries.some(entry => entry.code === 'IO_ERROR'), false,
    'a dialog-owned failure stays out of the shared history');
});

test('both languages explain the unsupported and the uncertain rename', async t => {
  const { en, zh } = await loadClientModule('i18n');
  for (const key of ['renameCompatibilityTitle', 'renameCompatibilityRisk', 'renameCompatibilityAck', 'renameCompatibilitySubmit']) {
    assert.ok(en[key], `${key} is missing from the English catalog`);
    assert.ok(zh[key], `${key} is missing from the Chinese catalog`);
  }
  for (const [language, dictionary] of [['en', en], ['zh', zh]]) {
    const unsupported = dictionary['error.UNSUPPORTED_ATOMIC_RENAME'];
    assert.match(unsupported, /atomic|原子/i, `${language} must name the atomic guarantee the Host could not give`);
    assert.match(unsupported, /no-replace|不覆盖/, `${language} must name the no-replace promise that is missing`);
    assert.match(unsupported, /If |如/, `${language} must not promise a compatibility control that may not exist in this context`);
    assert.match(unsupported, /risk|风险/i, `${language} must send the user to the risk notice of any compatible action`);
    assert.match(dictionary['error.ATOMIC_RENAME_UNCERTAIN'], /inspect|检查/i, `${language} must require inspecting the source and the destination`);
  }
  assert.match(en.renameCompatibilityRisk, /NFS/, 'the English risk names the other writers');
  assert.match(en.renameCompatibilityRisk, /empty director/, 'the English risk names the empty directory a plain rename would replace');
  assert.ok(!/not atomic/i.test(en.renameCompatibilityRisk), 'the downgrade is atomic; only no-replace is unavailable');
  assert.match(zh['error.UNSUPPORTED_ATOMIC_RENAME'], /兼容/, 'the Chinese refusal points at the reviewed downgrade');
  void t;
});
