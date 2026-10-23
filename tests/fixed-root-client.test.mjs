/**
 * The fixed browsing root, observed through the shipped Client.
 *
 * Directory locations used to be a Client-side surface: an entry that opened a
 * drawer, a form that added a path, per-root status rows and an explicit
 * re-authorization flow. All of it is gone, and this suite pins what the panel
 * does instead:
 *
 *  - the one root from `bootstrap` is the only browsing root, and it is addressed
 *    by id so a Host whose directory was replaced cannot be silently re-bound;
 *  - a Host with no usable root explains itself and asks for nothing else;
 *  - a startup location that has vanished may fall back to the root once, while an
 *    ordinary navigation failure keeps the position, the crumbs and the selection;
 *  - clipboard entries and open drafts that name another root are retired or
 *    marked, and the retirement never depends on having a draft open.
 */

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { act, node, nodes, setup, textOf } from './client-harness.mjs';

const action = name => ({ 'data-fm-action': name });
const bodyOf = request => request.init?.body ? JSON.parse(request.init.body) : null;
const opsOf = view => view.requests.map(bodyOf).map(body => body?.op).filter(op => typeof op === 'string');
const listsOf = view => view.requests.map(bodyOf).filter(body => body?.op === 'entries.list');
const notificationsOf = (view, code) => view.notifications.getSnapshot().entries.filter(entry => entry.code === code);
const allText = view => view.renderer.root.findAll(entry => typeof entry.type === 'string')
  .map(entry => typeof entry.props.children === 'string' ? entry.props.children : '').join('\n');
const seedRootFile = async root => { await writeFile(path.join(root, 'top.txt'), 'seed\n'); };

test('the panel has no directory-location surface and never asks for one', async t => {
  const view = await setup(t, { tasks: true, transfers: true, seed: seedRootFile });
  // Browse, select, navigate back and refresh: every gesture a location surface
  // used to sit next to stays inside the single root.
  await view.select('top.txt');
  await view.click({ 'data-fm-action': 'refresh' });
  await view.click({ 'data-fm-entry': 'directory', 'data-fm-path': 'folder' });
  await view.click({ 'data-fm-entry': 'file', 'data-fm-path': 'folder/hello.txt' });

  for (const name of ['locations', 'empty-locations', 'close-roots', 'refresh-root-status', 'add-root']) {
    assert.deepEqual(nodes(view.renderer, action(name)), [], `${name} must no longer exist`);
  }
  const hooks = new Set();
  for (const entry of view.renderer.root.findAll(entry => typeof entry.type === 'string')) {
    for (const name of Object.keys(entry.props)) {
      if (name.startsWith('data-fm-') && /root|location|workspace|reauthorize/.test(name)) hooks.add(name);
    }
  }
  // `data-fm-no-root` is the one surviving hook: it marks the empty-list
  // placeholder, and nothing in this fixture renders it.
  assert.deepEqual([...hooks].sort(), [], 'no removed location hook may remain');
  assert.deepEqual(opsOf(view).filter(op => op.startsWith('roots.')), [], 'no location op is ever sent');
});

test('the bootstrap root is the only browsing root, addressed by its own id', async t => {
  const view = await setup(t);
  const root = view.manager.getRoot();
  const first = listsOf(view);
  assert.equal(first.length, 1, 'the first listing is the single startup listing');
  assert.equal(first[0].rootId, root.id);
  assert.equal(first[0].path, '');
  assert.deepEqual(view.runtime.location, { rootId: root.id, path: '' });

  await view.click({ 'data-fm-entry': 'directory', 'data-fm-path': 'folder' });
  assert.deepEqual(view.runtime.location, { rootId: root.id, path: 'folder' }, 'navigation changes the path only');
  const crumbs = nodes(view.renderer, { className: 'fm-crumbs' })[0].findAllByType('button');
  assert.equal(crumbs.length, 2, 'the breadcrumb row starts at the root itself');
  assert.equal(textOf(crumbs[0]), root.label);
  for (const body of listsOf(view)) assert.equal(body.rootId, root.id, 'every listing stays on the fixed root');
});

test('an unopenable root lists nothing, explains itself once and disables every write', async t => {
  const view = await setup(t, {
    tasks: true,
    transfers: true,
    degraded: { scope: 'filesystem', code: 'ROOT_UNAVAILABLE', message: 'The Host directory could not be opened.', readOnly: false },
  });
  assert.deepEqual(opsOf(view), ['bootstrap'],
    'a degraded filesystem is asked for neither a listing nor a history: the Host would refuse all of it');

  const placeholder = nodes(view.renderer, { 'data-fm-no-root': 'unavailable' });
  assert.equal(placeholder.length, 1, 'the empty list says why it is empty');
  assert.equal(textOf(placeholder[0]), view.client.client.i18n.zh.emptyRoots);
  assert.equal(nodes(view.renderer, { 'data-fm-degraded': 'filesystem' }).length, 1, 'the degradation has its compact indicator');
  assert.equal(nodes(view.renderer, { 'data-fm-history-unavailable': true }).length, 1, 'the missing history is stated, not silently empty');

  const reported = notificationsOf(view, 'ROOT_UNAVAILABLE');
  assert.equal(reported.length, 1, 'the reason is reported exactly once');
  assert.equal(reported[0].action, undefined, 'there is no destination that could fix a root the Host could not open');
  assert.match(reported[0].message, /could not be opened/);
  assert.doesNotMatch(allText(view), /Add|添加路径/, 'the panel must not offer a way to add a directory');

  for (const name of ['new-file', 'new-directory', 'upload-files', 'paste', 'delete', 'refresh']) {
    assert.equal(node(view.renderer, action(name)).props.disabled, true, `${name} must be disabled without a root`);
  }
});

test('a Host without a browsing root still synchronizes its history once and lists nothing', async t => {
  const view = await setup(t, {
    tasks: true,
    transfers: true,
    intercept: async (url, init, route) => {
      const response = await route(url, init);
      const body = bodyOf({ init });
      if (body?.op !== 'bootstrap') return response;
      const envelope = await response.json();
      envelope.value.root = null;
      return Response.json(envelope);
    },
  });
  const ops = opsOf(view);
  assert.equal(ops.filter(op => op === 'entries.list').length, 0, 'nothing can be listed without a root');
  assert.equal(ops.filter(op => op === 'tasks.list').length, 1, 'a broken directory must not hide the tasks the user waits on');
  assert.equal(ops.filter(op => op === 'transfers.list').length, 1);
  assert.equal(nodes(view.renderer, { 'data-fm-no-root': 'unavailable' }).length, 1);
  assert.equal(nodes(view.renderer, { 'data-fm-degraded': 'filesystem' }).length, 0, 'a missing root is not a claimed degradation');
});

test('a clipboard for another root is cleared even with no draft open', async t => {
  const view = await setup(t);
  view.activity.clipboard({ operation: 'copy', items: [{ rootId: 'root-from-another-host', path: 'file.txt', version: '1:2:3' }] });
  assert.equal(view.documents.getSnapshot().documents.length, 0, 'this case deliberately has no open draft');
  await view.mount();
  assert.equal(view.activity.getSnapshot().clipboard, null, 'an entry that cannot be pasted here must not survive');
  assert.equal(node(view.renderer, action('paste')).props.disabled, true);
});

test('a clipboard for the current root stays usable across a remount', async t => {
  const view = await setup(t, { tasks: true });
  const rootId = view.manager.getRoot().id;
  const clipboard = { operation: 'copy', items: [{ rootId, path: 'folder/hello.txt', version: '1:2:3' }] };
  view.activity.clipboard(clipboard);
  await view.mount();
  assert.deepEqual(view.activity.getSnapshot().clipboard, clipboard, 'a paste target inside this root is untouched');
  assert.equal(node(view.renderer, action('paste')).props.disabled, false);
});

test('an edited draft bound to another root is marked missing and keeps its unsaved text', async t => {
  const view = await setup(t);
  const id = view.documents.open({
    rootId: 'root-from-another-host', path: 'remote.txt', text: 'text as it is on disk',
    bytes: 21, version: '1:2:3:4:5', encoding: 'utf-8', bom: false, newline: 'lf', mode: 0o644,
  });
  view.documents.edit(id, 'text the user typed and never saved');
  const [typed] = view.documents.getSnapshot().documents;
  assert.equal(typed.dirty, true, 'the case needs a real unsaved edit, not a clean snapshot');
  assert.equal(typed.missing, false);

  await view.mount();
  const [document] = view.documents.getSnapshot().documents;
  assert.equal(document.path, 'remote.txt');
  assert.equal(document.missing, true, 'a draft that names an unreachable root must be marked');
  assert.equal(document.dirty, true, 'marking must not make an unsaved edit look saved');
  assert.equal(document.draft, 'text the user typed and never saved', 'marking is not discarding: the user text stays');
  assert.equal(document.saving, false);
});

test('a NOT_FOUND during ordinary navigation keeps the position and the selection', async t => {
  const view = await setup(t, {
    seed: seedRootFile,
    intercept: async (url, init, route) => {
      const body = bodyOf({ init });
      if (body?.op === 'entries.list' && body.path === 'folder') {
        return Response.json({ ok: false, error: { code: 'NOT_FOUND', message: 'The directory no longer exists.' } }, { status: 404 });
      }
      return route(url, init);
    },
  });
  const rootId = view.manager.getRoot().id;
  await view.select('top.txt');
  const before = view.requests.length;
  await view.click({ 'data-fm-entry': 'directory', 'data-fm-path': 'folder' });
  const asked = listsOf({ requests: view.requests.slice(before) });
  assert.deepEqual(asked.map(body => body.path), ['folder'],
    'a failure the user asked for is reported as-is; only a startup location recovers to the root');
  assert.deepEqual(view.runtime.location, { rootId, path: '' }, 'the failed navigation does not move the panel');
  assert.equal(node(view.renderer, { type: 'checkbox', 'aria-label': '选择: top.txt' }).props.checked, true, 'the selection survives');
  assert.equal(notificationsOf(view, 'NOT_FOUND').length, 1, 'the failure is reported');
});

test('a saved startup subdirectory that is gone falls back to the root listing once', async t => {
  const view = await setup(t, { initialLocation: current => ({ rootId: current.manager.getRoot().id, path: 'gone' }) });
  assert.deepEqual(listsOf(view).map(body => body.path), ['gone', ''],
    'the restored directory is asked for first, then the root, and nothing else');
  const rootId = view.manager.getRoot().id;
  assert.deepEqual(view.runtime.location, { rootId, path: '' });
  assert.equal(nodes(view.renderer, { 'data-fm-entry': 'directory', 'data-fm-path': 'folder' }).length, 1,
    'the root listing is what the user sees');
});

test('a NOT_FOUND that lands after the panel is gone does not fall back to the root', async t => {
  let entered; let release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const view = await setup(t, {
    settleInitial: false,
    initialLocation: current => ({ rootId: current.manager.getRoot().id, path: 'gone' }),
    intercept: async (url, init, route) => {
      const body = bodyOf({ init });
      if (body?.op === 'entries.list' && body.path === 'gone') {
        entered();
        await gate;
        return Response.json({ ok: false, error: { code: 'NOT_FOUND', message: 'The saved directory is gone.' } }, { status: 404 });
      }
      return route(url, init);
    },
  });
  await started;
  view.unmount();
  release();
  await act(async () => { await view.settle(); });
  assert.deepEqual(listsOf(view).map(body => body.path), ['gone'],
    'the recovery belongs to a live view: a late answer must not move a panel the user already left');
});

for (const [code, status] of [['PERMISSION_DENIED', 403], ['ROOT_CHANGED', 409]]) {
  test(`a ${code} on the restored directory keeps the position and still synchronizes the history`, async t => {
    const view = await setup(t, {
      tasks: true,
      transfers: true,
      initialLocation: current => ({ rootId: current.manager.getRoot().id, path: 'restricted' }),
      intercept: async (url, init, route) => {
        const body = bodyOf({ init });
        if (body?.op === 'entries.list' && body.path === 'restricted') {
          return Response.json({ ok: false, error: { code, message: 'The restored directory cannot be listed.' } }, { status });
        }
        return route(url, init);
      },
    });
    const rootId = view.manager.getRoot().id;
    assert.deepEqual(listsOf(view).map(body => body.path), ['restricted'],
      'only NOT_FOUND may recover a restored directory, and never for another failure');
    assert.deepEqual(view.runtime.location, { rootId, path: 'restricted' },
      'the panel keeps the directory the user restored instead of jumping to the root');
    const ops = opsOf(view);
    assert.equal(ops.filter(op => op === 'tasks.list').length, 1, 'a broken directory must not also hide the task history');
    assert.equal(ops.filter(op => op === 'transfers.list').length, 1);
    assert.equal(notificationsOf(view, code).length, 1, 'the failure is reported with its own code');
  });
}

test('a replaced root starts at the new root and never shows the previous path', async t => {
  const view = await setup(t, {
    initialLocation: { rootId: 'root-from-a-previous-process', path: 'folder' },
    intercept: async (url, init, route) => {
      const body = bodyOf({ init });
      if (body?.op === 'entries.list') {
        return Response.json({ ok: false, error: { code: 'ROOT_CHANGED', message: 'The Host directory is no longer the one this file manager opened.' } }, { status: 409 });
      }
      return route(url, init);
    },
  });
  const rootId = view.manager.getRoot().id;
  const asked = listsOf(view);
  assert.deepEqual(asked.map(body => body.path), [''], 'the previous path is not even requested');
  assert.equal(asked[0].rootId, rootId, 'the client re-reads the root it was just told about');
  assert.deepEqual(view.runtime.location, { rootId, path: '' }, 'the new root is never rendered with the old path');
  assert.deepEqual(nodes(view.renderer, { className: 'fm-crumb' }), [], 'no breadcrumb can name a directory that was not loaded');

  const reported = notificationsOf(view, 'ROOT_CHANGED');
  assert.equal(reported.length, 1);
  const { en, zh } = view.client.client.i18n;
  const guidance = en['error.ROOT_CHANGED'];
  assert.equal(reported[0].title, zh['error.ROOT_CHANGED']);
  assert.doesNotMatch(guidance, /reopen|panel/i, 'the fix is not a gesture the panel can perform');
  assert.match(guidance, /reload|restart/i, 'the fix belongs to the plugin or Host lifetime');
  assert.doesNotMatch(zh['error.ROOT_CHANGED'], /重新打开|面板/);
  assert.match(zh['error.ROOT_CHANGED'], /重新加载|重启/);
});
