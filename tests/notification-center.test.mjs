/**
 * Notification centre: the shipped Client against the real Host.
 *
 * The subject is the built `dist/client.js` mounted on the real v2 router (see
 * `client-harness.mjs`), so these cases exercise the plugin-owned notification
 * store and the event sources that feed it end to end. Two contracts are pinned
 * here that no unit test can prove on its own:
 *
 *  - the store the panel renders is the store the plugin created for that apply,
 *    so a remounted view keeps its history while a rebuilt plugin starts empty;
 *  - every migrated event (path copy, clipboard summary, operation result,
 *    directory fallback, ordinary failure, degradation, task terminal state)
 *    reaches that store *instead of* a banner, while confirmations and form
 *    validation stay where the user acts.
 *
 * Assertions read `data-fm-*` attributes and the store snapshot, never prose, so
 * a translation change cannot make a case pass or fail by accident.
 *
 * Run `npm run build` first; the Client tests never compile sources.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { act, clickRootCrumb, editorEdit, editorProps, node, nodes, setup, textOf, uiBoundary } from './client-harness.mjs';
import { loadClientModule } from './client-module-loader.mjs';

const notificationsModule = () => loadClientModule('notifications');
const eventsModule = () => loadClientModule('notificationEvents');

const bodyOf = init => (init?.body ? JSON.parse(init.body) : {});
const opCount = (view, op) => view.requests.filter(request => bodyOf(request.init).op === op).length;

/** Nodes still rendering a pre-notification banner, whatever its id. */
const legacyBanners = view => view.renderer.root.findAll(entry =>
  typeof entry.type === 'string'
  && (entry.props['data-fm-notice-dismiss'] !== undefined
    || entry.props['data-fm-path-copy-result'] !== undefined
    || entry.props['data-fm-operation-result'] !== undefined)).length;

/** The plugin-owned store, reached exactly like the panel reaches it. */
function storeOf(view) {
  const store = view.notifications;
  assert.ok(store, 'the panel must receive the plugin-owned notification store');
  for (const method of ['publish', 'markRead', 'remove', 'clear', 'subscribe', 'dispose', 'getSnapshot']) {
    assert.equal(typeof store[method], 'function', `the notification store must expose ${method}()`);
  }
  return store;
}
const entriesOf = view => storeOf(view).getSnapshot().entries;
const unreadOf = view => storeOf(view).getSnapshot().unreadCount;
const withCode = (view, code) => entriesOf(view).filter(entry => entry.code === code);
// A refused path copy is identified by the manual-copy action it carries; the
// entry is also expected to run through the error level.
const manualCopies = view => entriesOf(view).filter(entry => entry.action?.kind === 'manual-copy');
/** The rendered row of one event: an element type is not a prop, so match it directly. */
const articleRow = (view, id) => view.renderer.root.findAll(entry => entry.type === 'article' && entry.props['data-fm-notification-id'] === id);
/**
 * Closed overlays stay mounted, and an open surface makes the main panel inert.
 * User interactions must target the reachable surface, even though the sole
 * notification entry remains rendered in the main header. Structural absence
 * checks deliberately use the full tree instead of these reachability helpers.
 */
function reachable(instance) {
  for (let current = instance; current; current = current.parent) {
    if (current.props?.hidden === true) return false;
    if (current.props?.inert !== undefined && current.props.inert !== false) return false;
    if (current.props?.['data-fm-overlay-open'] === false) return false;
  }
  return true;
}
const reachableNodes = (view, props) => view.renderer.root.findAll(entry => typeof entry.type === 'string'
  && Object.entries(props).every(([key, value]) => entry.props[key] === value) && reachable(entry));
function reachableNode(view, props) {
  const found = reachableNodes(view, props);
  assert.equal(found.length, 1, `expected exactly one reachable ${JSON.stringify(props)}, got ${found.length}`);
  return found[0];
}
async function clickReachable(view, props) {
  const target = reachableNode(view, props);
  await act(async () => { await target.props.onClick(); await view.settle(); });
}
const openOverlays = (view, name) => view.renderer.root.findAll(entry => typeof entry.type === 'string'
  && entry.props['data-fm-overlay'] === name && entry.props['data-fm-overlay-open'] === true).length;
const notificationEntryOf = view => {
  const isEntry = entry => entry.type === 'button' && entry.props['data-fm-action'] === 'notifications';
  const buttons = view.renderer.root.findAll(isEntry);
  assert.equal(buttons.length, 1, 'the entire mounted panel must render exactly one notification entry');
  assert.equal(node(view.renderer, { className: 'fm-main-header' }).findAll(isEntry).length, 1,
    'the sole notification entry belongs to the main header');
  for (const surface of ['viewer', 'tasks']) {
    assert.equal(node(view.renderer, { 'data-fm-overlay': surface }).findAll(isEntry).length, 0,
      `${surface} must not render a notification entry, even inside a hidden or inert overlay`);
  }
  return buttons[0];
};
const countProp = view => notificationEntryOf(view).props['data-fm-notification-count'];
const liveText = view => {
  const regions = view.renderer.root.findAll(entry => typeof entry.type === 'string' && entry.props['data-fm-notification-live'] !== undefined);
  assert.ok(regions.length >= 1, 'the polite live region must exist');
  const texts = [...new Set(regions.map(entry => textOf(entry)))];
  assert.equal(texts.length, 1, 'every mounted live region announces the same thing');
  return texts[0];
};
const checkbox = (view, name) => node(view.renderer, { type: 'checkbox', 'aria-label': `选择: ${name}` });
const draftOf = (view, filename) => {
  const document = view.documents.getSnapshot().documents.find(item => item.path.endsWith(filename));
  assert.ok(document, `the ${filename} document must be open`);
  return document.draft;
};

// Only the public provider boundary is simulated; a real OS clipboard is a
// browser-verification item.
function installWriter(t, writer) {
  const original = uiBoundary.writeClipboard;
  uiBoundary.writeClipboard = writer;
  t.after(() => { uiBoundary.writeClipboard = original; });
}

const acceptWrite = (t, calls = []) => installWriter(t, async text => { calls.push(text); return true; });

test('the store orders newest first, counts unread and marks read selectively', async t => {
  const view = await setup(t, {});
  const store = storeOf(view);
  assert.deepEqual(entriesOf(view), []);
  assert.equal(unreadOf(view), 0);

  const first = store.publish({ level: 'success', title: 'one' });
  const second = store.publish({ level: 'warning', title: 'two' });
  const third = store.publish({ level: 'error', title: 'three', code: 'IO_ERROR' });
  const snapshot = store.getSnapshot();
  assert.deepEqual(snapshot.entries.map(entry => entry.id), [third, second, first], 'newest is first, even in the same millisecond');
  assert.equal(snapshot.unreadCount, 3);
  assert.equal(snapshot.entries.every(entry => entry.read === false), true);
  const stamps = snapshot.entries.map(entry => entry.createdAt);
  assert.equal(stamps.every(stamp => typeof stamp === 'number'), true, 'createdAt is epoch milliseconds');
  assert.deepEqual([...stamps].sort((left, right) => right - left), stamps, 'the list is ordered by createdAt');
  assert.equal(snapshot.entries[0].code, 'IO_ERROR');

  store.markRead([first, 'no-such-notification']);
  assert.equal(store.getSnapshot().unreadCount, 2, 'unknown ids are ignored');
  assert.equal(store.getSnapshot().entries.find(entry => entry.id === first).read, true);
  store.markRead();
  assert.equal(store.getSnapshot().unreadCount, 0);
  assert.equal(store.getSnapshot().entries.every(entry => entry.read === true), true);
});

test('the store keeps the newest hundred entries and reports the published id', async t => {
  const { createNotificationStore, NOTIFICATION_LIMIT } = await notificationsModule();
  assert.equal(NOTIFICATION_LIMIT, 100, 'the documented limit is frozen');
  const store = createNotificationStore();
  const ids = [];
  for (let index = 0; index < NOTIFICATION_LIMIT + 5; index += 1) ids.push(store.publish({ level: 'info', title: `event ${index}` }));
  const { entries, unreadCount } = store.getSnapshot();
  assert.equal(entries.length, NOTIFICATION_LIMIT);
  assert.equal(entries[0].id, ids.at(-1), 'publish returns the id of the new entry');
  assert.equal(entries.some(entry => entry.id === ids[0]), false, 'the oldest entry is evicted first');
  assert.equal(unreadCount, NOTIFICATION_LIMIT);

  store.markRead();
  store.remove(entries[0].id);
  assert.equal(store.getSnapshot().entries.length, NOTIFICATION_LIMIT - 1);
  store.remove('no-such-notification');
  assert.equal(store.getSnapshot().entries.length, NOTIFICATION_LIMIT - 1, 'removing an unknown id is a no-op');
  store.clear();
  assert.deepEqual(store.getSnapshot().entries, []);
  assert.equal(store.getSnapshot().unreadCount, 0);
});

test('a repeated dedupe key is ignored, and the bookkeeping stays bounded', async t => {
  const { createNotificationStore } = await notificationsModule();
  const store = createNotificationStore({ dedupeLimit: 2 });
  const first = store.publish({ level: 'info', title: 'watching', dedupeKey: 'watch:reconnecting' });
  const again = store.publish({ level: 'info', title: 'watching', dedupeKey: 'watch:reconnecting' });
  assert.equal(again, first, 'a duplicate returns the entry that already exists');
  assert.equal(store.getSnapshot().entries.length, 1, 'a status-shaped repeat never stacks');
  assert.equal(store.getSnapshot().unreadCount, 1);

  store.publish({ level: 'info', title: 'polling', dedupeKey: 'watch:polling' });
  store.publish({ level: 'info', title: 'disconnected', dedupeKey: 'watch:disconnected' });
  store.publish({ level: 'info', title: 'watching', dedupeKey: 'watch:reconnecting' });
  assert.equal(store.getSnapshot().entries.length, 4,
    'once the bounded dedupe ring forgets a key, a later event is a new entry');

  store.clear();
  store.publish({ level: 'info', title: 'watching', dedupeKey: 'watch:disconnected' });
  assert.equal(store.getSnapshot().entries.length, 0, 'clearing entries does not clear the dedupe keys');
});

test('subscribers hear real changes only and a disposed store is inert', async t => {
  const { createNotificationStore } = await notificationsModule();
  const store = createNotificationStore();
  let calls = 0;
  const unsubscribe = store.subscribe(() => { calls += 1; });
  const id = store.publish({ level: 'success', title: 'one' });
  assert.equal(calls, 1);
  store.markRead();
  assert.equal(calls, 2);
  store.markRead();
  assert.equal(calls, 2, 'marking already-read entries changes nothing and notifies nobody');
  store.remove(id);
  assert.equal(calls, 3);
  unsubscribe();
  store.publish({ level: 'success', title: 'two' });
  assert.equal(calls, 3, 'an unsubscribed listener is not called again');

  store.dispose();
  assert.deepEqual(store.getSnapshot().entries, []);
  const afterDispose = store.subscribe(() => { calls += 1; });
  assert.equal(typeof afterDispose, 'function');
  assert.equal(store.publish({ level: 'success', title: 'three' }), '', 'a disposed store is a safe no-op');
  assert.deepEqual(store.getSnapshot().entries, []);
  assert.equal(calls, 3);
  afterDispose();
});

test('only the main header owns a notification entry while viewer and tasks stay entry-free', async t => {
  const view = await setup(t, { tasks: true });
  assert.equal(countProp(view), '0');
  assert.equal(reachable(notificationEntryOf(view)), true);

  await clickReachable(view, { 'data-fm-entry': 'directory', 'data-fm-path': 'folder' });
  await clickReachable(view, { 'data-fm-entry': 'file', 'data-fm-path': 'folder/hello.txt' });
  assert.equal(openOverlays(view, 'viewer'), 1);
  assert.equal(reachable(notificationEntryOf(view)), false, 'the main entry is inert while editing, not duplicated into the viewer');
  assert.equal(reachableNodes(view, { 'data-fm-action': 'notifications' }).length, 0);

  await clickReachable(view, { 'data-fm-action': 'back-to-files' });
  assert.equal(reachable(notificationEntryOf(view)), true);
  await clickReachable(view, { 'data-fm-action': 'show-tasks' });
  assert.equal(openOverlays(view, 'tasks'), 1);
  assert.equal(reachable(notificationEntryOf(view)), false, 'the task surface also has no duplicate entry');
  await clickReachable(view, { 'data-fm-action': 'close-tasks' });
  assert.equal(reachable(notificationEntryOf(view)), true);
});

test('copying a path publishes one success notification inside the click', async t => {
  let observed = null;
  let called = false;
  let view;
  installWriter(t, async text => { called = true; observed = text; return true; });
  view = await setup(t, {});
  const before = view.requests.length;

  const click = reachableNode(view, { 'data-fm-action': 'copy-directory-path' }).props.onClick;
  const pending = click();
  assert.equal(called, true, 'the clipboard write starts inside the click call stack');
  await act(async () => { await pending; await view.settle(); });
  assert.equal(legacyBanners(view), 0, 'the copy banner is gone, not merely hidden');
  assert.equal(unreadOf(view), 1);
  assert.equal(countProp(view), '1');
  assert.deepEqual(entriesOf(view).map(entry => entry.level), ['success']);
  assert.equal(entriesOf(view)[0].code, undefined, 'a success carries no failure code');
  assert.equal(observed, view.root);
  assert.equal(unreadOf(view), 1, 'the success event lands once the write answers');
  assert.equal(view.requests.length, before, 'copying a path never talks to the Host');

  await view.select('folder');
  await view.click({ 'data-fm-action': 'copy-selected-paths' });
  assert.equal(unreadOf(view), 2, 'each user action is its own event, never deduplicated away');
  assert.deepEqual(entriesOf(view).map(entry => entry.level), ['success', 'success']);
  assert.equal(view.requests.length, before);
});

test('a refused clipboard write keeps the full text in the notification detail', async t => {
  installWriter(t, async () => false);
  // Long enough to expose a silent cap, short enough for the filesystem (255 bytes).
  const longName = '很长的中文目录名称'.repeat(8);
  const view = await setup(t, {
    seed: async root => {
      await mkdir(path.join(root, longName));
      await writeFile(path.join(root, '中文 " spaced @ file.txt'), 'x');
    },
  });

  await view.select(longName);
  await view.click({ 'data-fm-action': 'copy-selected-paths' });
  assert.equal(legacyBanners(view), 0);
  const failed = manualCopies(view);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].level, 'error');
  assert.equal(failed[0].code, 'PATH_COPY_FAILED', 'the diagnostic code core exports for a refused copy');
  const longPath = path.join(view.root, longName);
  assert.ok(Buffer.byteLength(longPath, 'utf8') > 200, 'the fixture path must be long enough to expose a silent cap');
  assert.deepEqual(failed[0].action, { kind: 'manual-copy', text: longPath },
    'the fallback text is the exact requested path, never truncated or escaped');
  const failedId = manualCopies(view)[0].id;
  const detail = articleRow(view, failedId)
    .flatMap(row => row.findAll(entry => typeof entry.type === 'string' && entry.props['data-fm-path-copy-text'] !== undefined));
  assert.equal(detail.length, 1, 'the event carries exactly one manual-copy field');
  const textarea = detail;
  assert.equal(textarea[0].props.readOnly, true);
  assert.equal(textarea[0].props.value, longPath);

  await view.select(longName, false);
  await view.select('中文 " spaced @ file.txt');
  await view.click({ 'data-fm-action': 'copy-selected-paths' });
  const second = manualCopies(view)[0];
  assert.deepEqual(second.action, { kind: 'manual-copy', text: path.join(view.root, '中文 " spaced @ file.txt') },
    'a name full of quoting hazards is preserved byte for byte');

  // A line feed in a name keeps the entry unaddressable (R18), so the byte fidelity
  // of a multi-line manual text is pinned at the store boundary instead.
  storeOf(view).publish({ level: 'error', title: 'injected', action: { kind: 'manual-copy', text: 'first\nsecond line' } });
  const injected = entriesOf(view).find(entry => entry.action?.kind === 'manual-copy' && entry.action.text.includes('\n'));
  assert.ok(injected, 'the store keeps a multi-line manual text');
  assert.deepEqual(injected.action.text, 'first\nsecond line', 'line feeds survive byte for byte');
  assert.equal(entriesOf(view).some(entry => entry.level === 'success'), false, 'a failure never reports success');
});

test('an ordinary failure becomes a notification while the form keeps its own error', async t => {
  let failListings = false;
  const view = await setup(t, {
    intercept: async (url, init, route) => {
      if (failListings && bodyOf(init).op === 'entries.list') {
        return new Response(JSON.stringify({ ok: false, error: { code: 'IO_ERROR', message: 'boom' } }),
          { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return route(url, init);
    },
  });

  failListings = true;
  await view.click({ 'data-fm-entry': 'directory', 'data-fm-path': 'folder' });
  assert.equal(legacyBanners(view), 0, 'the panel-level error banner is gone');
  const failures = withCode(view, 'IO_ERROR');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].level, 'error');
  assert.equal(failures[0].action, undefined, 'a plain transport failure has nowhere to navigate');
  assert.equal(view.runtime.location.path, '', 'a failed listing never moves the view');

  failListings = false;
  const beforeForm = entriesOf(view).length;
  await view.click({ 'data-fm-action': 'new-directory' });
  await act(async () => { node(view.renderer, { 'data-fm-name': true }).props.onChange({ target: { value: 'folder' } }); });
  await view.click({ 'data-fm-action': 'name-submit' });
  const inlineErrors = view.renderer.root.findAll(entry => typeof entry.type === 'string' && entry.props.role === 'alert');
  assert.ok(inlineErrors.length >= 1, 'a form validation error still appears where the user is typing');
  assert.equal(entriesOf(view).length, beforeForm, 'a dialog error stays in the dialog, never in the history');
});

test('dangerous confirmations stay in place and publish nothing', async t => {
  const view = await setup(t, {});
  await view.openHello();
  const before = entriesOf(view).length;

  await view.click({ 'data-fm-action': 'delete' });
  const acknowledge = node(view.renderer, { 'aria-label': '我确认永久删除不可恢复' });
  assert.equal(node(view.renderer, { 'data-fm-action': 'delete-confirm' }).props.disabled, true,
    'permanent deletion still requires the explicit acknowledgement');
  await view.click({ 'data-fm-action': 'delete-cancel' });
  assert.equal(entriesOf(view).length, before, 'opening and cancelling a confirmation is not an event');
  assert.equal(opCount(view, 'delete.commit'), 0);
});

test('a committed operation result becomes one notification instead of a banner', async t => {
  const view = await setup(t, {});
  await view.openHello();
  await view.click({ 'data-fm-action': 'delete' });
  await act(async () => {
    node(view.renderer, { 'aria-label': '我确认永久删除不可恢复' }).props.onChange({ target: { checked: true } });
  });
  await view.click({ 'data-fm-action': 'delete-confirm' });

  assert.equal(legacyBanners(view), 0, 'the operation-result banner is gone');
  const results = withCode(view, 'OPERATION_RESULT');
  assert.equal(results.length, 1);
  assert.equal(results[0].level, 'success');
  assert.ok(Array.isArray(results[0].details) && results[0].details.length >= 1, 'the summary lists one line per target');
  assert.equal(opCount(view, 'delete.commit'), 1);
});

test('the clipboard summary is a notification and clearing it keeps the clipboard usable', async t => {
  const writer = [];
  acceptWrite(t, writer);
  const view = await setup(t, { tasks: true });
  await clickReachable(view, { 'data-fm-entry': 'directory', 'data-fm-path': 'folder' });
  await view.select('hello.txt');
  await clickReachable(view, { 'data-fm-entry': 'file', 'data-fm-path': 'folder/hello.txt' });
  await clickReachable(view, { 'data-fm-action': 'back-to-files' });
  // Handler-level clipboard fixture: react-test-renderer has no native <details>
  // state. This checks business-state isolation, not opening the More menu.
  await view.click({ 'data-fm-action': 'copy' });

  assert.equal(legacyBanners(view), 0, 'the clipboard banner is gone');
  const summaries = withCode(view, 'CLIPBOARD_ITEMS');
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].level, 'info');
  assert.equal(node(view.renderer, { 'data-fm-action': 'paste' }).props.disabled, false);
  const clipboard = view.activity.getSnapshot().clipboard;
  assert.ok(clipboard, 'the clipboard lives in the activity store, not in a notification');

  const before = view.requests.length;
  await clickReachable(view, { 'data-fm-action': 'notifications' });
  await clickReachable(view, { 'data-fm-action': 'notifications-clear' });
  assert.deepEqual(entriesOf(view), []);
  assert.deepEqual(view.activity.getSnapshot().clipboard, clipboard, 'clearing events never clears the clipboard payload');
  assert.equal(node(view.renderer, { 'data-fm-action': 'paste' }).props.disabled, false);
  assert.equal(view.requests.length, before, 'clearing notifications is a memory-only action');
});

test('the directory upload fallback is a notification while the control stays usable', async t => {
  const view = await setup(t, { transfers: true });
  await view.click({ 'data-fm-action': 'upload-directory' });
  assert.equal(legacyBanners(view), 0, 'the directory-fallback banner is gone');
  const fallbacks = withCode(view, 'DIRECTORY_FALLBACK');
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].level, 'warning');
  assert.equal(node(view.renderer, { 'data-fm-action': 'upload-directory' }).props.disabled, false);

  await view.click({ 'data-fm-action': 'upload-directory' });
  assert.equal(withCode(view, 'DIRECTORY_FALLBACK').length, 2, 'a repeated user action is a new event');
});

test('the read-only degradation keeps a compact chip and adds one notification', async t => {
  const view = await setup(t, {
    readOnly: true,
    degraded: { scope: 'operations', code: 'IO_ERROR', message: 'journal unavailable', readOnly: true },
  });
  const chip = nodes(view.renderer, { 'data-fm-degraded': 'operations' });
  assert.equal(chip.length, 1, 'the compact status must stay in place, not only in the history');
  assert.equal(chip[0].props.role, 'status');
  const degraded = entriesOf(view).filter(entry => typeof entry.dedupeKey === 'string' && entry.dedupeKey.startsWith('degraded:'));
  assert.equal(degraded.length, 1);
  assert.equal(degraded[0].level, 'error');
  assert.equal(node(view.renderer, { 'data-fm-action': 'new-file' }).props.disabled, true, 'write gates are unchanged');
});

test('an unopenable root is reported once, with no location surface to navigate to', async t => {
  const view = await setup(t, {
    intercept: async (url, init, route) => {
      const response = await route(url, init);
      if (bodyOf(init).op === 'bootstrap') {
        const payload = await response.json();
        payload.value.root = null;
        payload.value.degraded = { scope: 'filesystem', code: 'ROOT_UNAVAILABLE', message: 'The browsing root could not be opened.', readOnly: false };
        return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
      }
      return response;
    },
  });
  const chip = nodes(view.renderer, { 'data-fm-degraded': 'filesystem' });
  assert.equal(chip.length, 1, 'the compact chip explains why nothing can be browsed');
  const degraded = entriesOf(view).filter(entry => typeof entry.dedupeKey === 'string' && entry.dedupeKey.startsWith('degraded:filesystem:'));
  assert.equal(degraded.length, 1, 'the event is reported exactly once');
  assert.equal(degraded[0].level, 'error');
  assert.equal(degraded[0].action, undefined, 'there is no directory-location surface left to navigate to');
  assert.equal(nodes(view.renderer, { 'data-fm-no-root': 'unavailable' }).length, 1, 'the list area explains the missing root');
  assert.equal(view.renderer.root.findAll(entry => 'data-fm-history-unavailable' in entry.props).length >= 1, true,
    'unavailable history is stated as unavailable, never as an empty list');
  assert.equal(node(view.renderer, { 'data-fm-action': 'new-file' }).props.disabled, true, 'write gates are closed while the root is unusable');
  assert.equal(node(view.renderer, { 'data-fm-action': 'upload-files' }).props.disabled, true);
  // No browsing and no history: a filesystem degradation issues nothing but bootstrap.
  const asked = view.requests.filter(item => item.init?.body && ['entries.list', 'tasks.list', 'transfers.list'].includes(JSON.parse(item.init.body).op));
  assert.deepEqual(asked, [], 'an unusable root must not produce listing or history requests');
  assert.equal(view.requests.every(item => item.init?.body === undefined || String(JSON.parse(item.init.body).op) !== 'roots.list'), true);
});

test('returning to files to read notifications keeps the draft and restores the dirty editor', async t => {
  acceptWrite(t);
  const view = await setup(t, {});
  await clickReachable(view, { 'data-fm-entry': 'directory', 'data-fm-path': 'folder' });
  await view.select('hello.txt');
  await clickReachable(view, { 'data-fm-entry': 'file', 'data-fm-path': 'folder/hello.txt' });
  editorEdit(view, 'draft kept across the drawer');
  await clickReachable(view, { 'data-fm-action': 'back-to-files' });
  assert.equal(openOverlays(view, 'viewer'), 0);
  assert.equal(draftOf(view, 'hello.txt'), 'draft kept across the drawer');
  // Both events come from the visible directory-path control, not a closed menu.
  await clickReachable(view, { 'data-fm-action': 'copy-directory-path' });
  await clickReachable(view, { 'data-fm-action': 'copy-directory-path' });
  assert.equal(unreadOf(view), 2);
  const newest = entriesOf(view)[0];
  assert.equal(liveText(view), newest.title, 'the polite live region carries the newest unread title');
  assert.equal(openOverlays(view, 'notifications'), 0, 'a new event never opens the drawer by itself');

  const before = view.requests.length;
  await clickReachable(view, { 'data-fm-action': 'notifications' });
  assert.equal(openOverlays(view, 'notifications'), 1);
  assert.equal(unreadOf(view), 0, 'opening the drawer reads what it shows');
  assert.equal(countProp(view), '0');
  assert.equal(liveText(view), newest.title, 'reading the drawer neither replays nor clears the announcement');
  assert.equal(view.requests.length, before, 'the drawer is memory-only');
  assert.equal(view.runtime.location.path, 'folder', 'the location is preserved');
  assert.equal(checkbox(view, 'hello.txt').props.checked, true, 'the selection is preserved');
  assert.equal(draftOf(view, 'hello.txt'), 'draft kept across the drawer');
  const row = articleRow(view, entriesOf(view)[0].id);
  assert.equal(row.length, 1, 'the drawer shows exactly one row per event, not one per control');
  assert.equal(row[0].findAll(entry => typeof entry.type === 'string' && entry.props['data-fm-action'] === 'notification-dismiss').length, 1,
    'the row carries exactly one dismiss control');

  await clickReachable(view, { 'data-fm-action': 'close-notifications' });
  await clickReachable(view, { 'data-fm-action': 'open-documents' });
  assert.equal(openOverlays(view, 'viewer'), 1);
  assert.equal(editorProps(view.renderer)?.value, 'draft kept across the drawer');
  assert.equal(reachableNodes(view, { 'data-fm-document-state': 'dirty' }).length, 1);
  assert.equal(reachableNode(view, { 'data-fm-action': 'save' }).props.disabled, false);
  assert.equal(view.requests.length, before, 'reading history and resuming a draft never reloads or saves it');
});

test('save success and failure remain in history and clearing them preserves a resumable draft', async t => {
  let failSave = false;
  const view = await setup(t, {
    intercept: async (url, init, route) => {
      if (failSave && bodyOf(init).op === 'save') {
        return Response.json({ ok: false, error: { code: 'IO_ERROR', message: 'save refused' } }, { status: 500 });
      }
      return route(url, init);
    },
  });
  await clickReachable(view, { 'data-fm-entry': 'directory', 'data-fm-path': 'folder' });
  await clickReachable(view, { 'data-fm-entry': 'file', 'data-fm-path': 'folder/hello.txt' });
  editorEdit(view, 'saved text');
  await clickReachable(view, { 'data-fm-action': 'save' });
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), 'saved text');
  assert.equal(reachableNodes(view, { 'data-fm-document-state': 'clean' }).length, 1);
  assert.equal(withCode(view, 'DOCUMENT_SAVED').length, 1);
  assert.equal(withCode(view, 'DOCUMENT_SAVED')[0].level, 'success');
  assert.equal(unreadOf(view), 1);

  editorEdit(view, 'unsaved text after failure');
  failSave = true;
  await clickReachable(view, { 'data-fm-action': 'save' });
  assert.equal(withCode(view, 'IO_ERROR').length, 1);
  assert.equal(withCode(view, 'IO_ERROR')[0].level, 'error');
  assert.equal(withCode(view, 'DOCUMENT_SAVED').length, 1, 'a refused save never reports another success');
  assert.equal(unreadOf(view), 2);
  assert.equal(openOverlays(view, 'notifications'), 0, 'save outcomes do not open history automatically');
  assert.equal(editorProps(view.renderer)?.value, 'unsaved text after failure');
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), 'saved text');
  const ids = entriesOf(view).map(entry => entry.id);
  const before = view.requests.length;

  await clickReachable(view, { 'data-fm-action': 'back-to-files' });
  assert.equal(countProp(view), '2', 'the main entry shows both unread save outcomes');
  await clickReachable(view, { 'data-fm-action': 'notifications' });
  assert.deepEqual(entriesOf(view).map(entry => entry.id), ids, 'returning to files preserves both outcomes');
  for (const id of ids) assert.equal(articleRow(view, id).length, 1, 'each save outcome has exactly one history row');
  assert.equal(unreadOf(view), 0);
  await clickReachable(view, { 'data-fm-action': 'notifications-clear' });
  assert.deepEqual(entriesOf(view), []);
  assert.equal(countProp(view), '0');
  assert.equal(draftOf(view, 'hello.txt'), 'unsaved text after failure');
  await clickReachable(view, { 'data-fm-action': 'close-notifications' });
  await clickReachable(view, { 'data-fm-action': 'open-documents' });
  assert.equal(editorProps(view.renderer)?.value, 'unsaved text after failure');
  assert.equal(reachableNodes(view, { 'data-fm-document-state': 'dirty' }).length, 1);
  assert.equal(reachableNode(view, { 'data-fm-action': 'save' }).props.disabled, false);
  assert.equal(view.requests.length, before, 'clearing history and resuming the draft is memory-only');

  failSave = false;
  await clickReachable(view, { 'data-fm-action': 'save' });
  assert.equal(await readFile(path.join(view.root, 'folder/hello.txt'), 'utf8'), 'unsaved text after failure');
  assert.equal(reachableNodes(view, { 'data-fm-document-state': 'clean' }).length, 1);
  assert.equal(withCode(view, 'DOCUMENT_SAVED').length, 1, 'a fresh save still publishes after history is cleared');
});

test('a notification action reopens the surface it belongs to and keeps the context', async t => {
  acceptWrite(t);
  const view = await setup(t, {});
  await clickReachable(view, { 'data-fm-entry': 'directory', 'data-fm-path': 'folder' });
  await view.select('hello.txt');
  await clickReachable(view, { 'data-fm-entry': 'file', 'data-fm-path': 'folder/hello.txt' });
  editorEdit(view, 'draft survives navigation');
  await clickReachable(view, { 'data-fm-action': 'back-to-files' });
  const store = storeOf(view);
  const tasksId = store.publish({ level: 'warning', title: 'task needs you', action: { kind: 'surface', surface: 'tasks' } });
  const viewerId = store.publish({ level: 'info', title: 'file changed', action: { kind: 'surface', surface: 'viewer' } });
  // The removed location surface is not merely unreachable: it cannot even be
  // published, so a stale caller fails loudly instead of silently navigating.
  assert.throws(() => store.publish({ level: 'info', title: 'root changed', action: { kind: 'surface', surface: 'roots' } }),
    /Unknown notification surface: roots/);

  await clickReachable(view, { 'data-fm-action': 'notifications' });
  await clickReachable(view, { 'data-fm-notification-id': tasksId, 'data-fm-action': 'notification-action' });
  assert.equal(openOverlays(view, 'tasks'), 1);
  assert.equal(openOverlays(view, 'notifications'), 0);
  assert.equal(view.runtime.location.path, 'folder');
  assert.equal(draftOf(view, 'hello.txt'), 'draft survives navigation');

  // The task header no longer carries the notification entry: close the
  // surface first, then reach the history from the main header.
  await view.click({ 'data-fm-action': 'close-tasks' });
  await clickReachable(view, { 'data-fm-action': 'notifications' });
  await clickReachable(view, { 'data-fm-notification-id': viewerId, 'data-fm-action': 'notification-action' });
  assert.equal(openOverlays(view, 'viewer'), 1);
  assert.equal(openOverlays(view, 'notifications'), 0);
  assert.equal(draftOf(view, 'hello.txt'), 'draft survives navigation');
});

test('dismissing one notification removes only that entry', async t => {
  const view = await setup(t, {});
  const store = storeOf(view);
  const first = store.publish({ level: 'info', title: 'one' });
  const second = store.publish({ level: 'info', title: 'two' });
  await clickReachable(view, { 'data-fm-action': 'notifications' });
  await clickReachable(view, { 'data-fm-notification-id': second, 'data-fm-action': 'notification-dismiss' });
  assert.deepEqual(entriesOf(view).map(entry => entry.id), [first]);
  assert.equal(nodes(view.renderer, { 'data-fm-notification-id': second }).length, 0);
  assert.equal(unreadOf(view), 0, 'the remaining entry stays read');
});

test('an outcome the user gets in the same turn is announced through the panel itself', async t => {
  const view = await setup(t, { tasks: true });
  assert.equal(typeof view.reportTerminal, 'function', 'the panel must receive the terminal reporter');
  const id = view.reportTerminal('task', { id: 'same-turn', status: 'completed', updatedAt: 1, historyRevision: 0 });
  assert.equal(typeof id, 'string');
  const announced = entriesOf(view).filter(entry => String(entry.dedupeKey) === 'terminal:tasks:same-turn:0:completed');
  assert.equal(announced.length, 1, 'a terminal state the user just caused is never missed');
  assert.equal(announced[0].level, 'success');
  assert.deepEqual(announced[0].action, { kind: 'surface', surface: 'tasks' });
  view.reportTerminal('task', { id: 'same-turn', status: 'completed', updatedAt: 2, historyRevision: 0 });
  assert.equal(entriesOf(view).filter(entry => String(entry.dedupeKey).startsWith('terminal:tasks:same-turn:')).length, 1,
    'the same generation is never announced twice');
});

test('a remounted view keeps the history while a rebuilt plugin starts empty', async t => {
  acceptWrite(t);
  const view = await setup(t, {});
  await view.click({ 'data-fm-action': 'copy-directory-path' });
  assert.equal(entriesOf(view).length, 1);

  view.unmount();
  await view.mount();
  assert.equal(entriesOf(view).length, 1, 'the store belongs to the plugin, not to the view');
  assert.equal(countProp(view), '1');

  await view.reloadClient();
  assert.deepEqual(entriesOf(view), [], 'a rebuilt plugin starts with no history');
  assert.equal(unreadOf(view), 0);
});

test('task history that existed before the plugin is never announced', async t => {
  const view = await setup(t, {
    tasks: true,
    taskOptions: {
      initialTasks: [{
        id: 'historic-task', operation: 'copy', status: 'completed',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        historyRevision: 0, conflict: 'skip', destination: { rootId: 'root', path: '' },
        items: [{
          id: 'item-1', status: 'completed', attempts: 1,
          source: { rootId: 'root', path: 'a.txt', expectedVersion: '1:2:3:4:5' },
          destination: { rootId: 'root', path: 'b.txt' },
        }],
      }],
    },
  });
  assert.equal(entriesOf(view).filter(entry => String(entry.dedupeKey).startsWith('terminal:')).length, 0,
    'an already-finished task is history, not a new completion');
});

test('the terminal observer is silent for imported history and exact for a live generation', async t => {
  const { createActivityStore } = await loadClientModule('activity');
  const { createNotificationStore } = await notificationsModule();
  const { createNotificationEvents, reportTerminalNotification } = await eventsModule();
  const translate = key => key;

  const activity = createActivityStore();
  const store = createNotificationStore();
  // The observer subscribes while nothing is known yet, exactly like the plugin:
  // past tasks are then imported asynchronously by the panel.
  const observer = createNotificationEvents({ notifications: store, activity, t: translate });
  activity.put('tasks', { id: 'imported', status: 'completed', updatedAt: 1, historyRevision: 0 });
  assert.equal(store.getSnapshot().entries.length, 0,
    'a terminal state imported into an empty store is history, even though this observer never saw it running');

  activity.put('tasks', { id: 'live', status: 'running', updatedAt: 2, historyRevision: 0 });
  assert.equal(store.getSnapshot().entries.length, 0, 'progress is not a result');
  activity.put('tasks', { id: 'live', status: 'completed', updatedAt: 3, historyRevision: 0 });
  assert.equal(store.getSnapshot().entries.length, 1, 'a transition into a terminal state is announced');
  activity.put('tasks', { id: 'live', status: 'completed', updatedAt: 4, historyRevision: 0 });
  assert.equal(store.getSnapshot().entries.length, 1, 'a repeated poll frame for one generation adds nothing');
  activity.put('tasks', { id: 'live', status: 'completed', updatedAt: 5, historyRevision: 1 });
  assert.equal(store.getSnapshot().entries.length, 2, 'a retry is a new generation and a new event');
  assert.equal(String(store.getSnapshot().entries[0].dedupeKey).startsWith('terminal:tasks:live:1:'), true);

  const levels = { completed: 'success', partial: 'warning', cancelled: 'info', interrupted: 'warning', failed: 'error' };
  for (const [status, level] of Object.entries(levels)) {
    activity.put('transfers', { id: `run-${status}`, status: 'running', updatedAt: 10, historyRevision: 0 });
    activity.put('transfers', { id: `run-${status}`, status, updatedAt: 11, historyRevision: 0 });
    const entry = store.getSnapshot().entries.find(candidate => String(candidate.dedupeKey).startsWith(`terminal:transfers:run-${status}:`));
    assert.ok(entry, `${status} must be announced`);
    assert.equal(entry.level, level);
    assert.deepEqual(entry.action, { kind: 'surface', surface: 'tasks' });
  }

  // The outcome the user asked for and got in the same turn is reported by the
  // UI itself, because the observer deliberately stays quiet on a first sighting.
  const before = store.getSnapshot().entries.length;
  const helper = reportTerminalNotification(store, translate, 'task', { id: 'direct', status: 'failed', updatedAt: 20, historyRevision: 0 });
  assert.equal(typeof helper, 'string');
  assert.equal(store.getSnapshot().entries.length, before + 1);
  activity.put('tasks', { id: 'direct', status: 'failed', updatedAt: 20, historyRevision: 0 });
  assert.equal(store.getSnapshot().entries.length, before + 1, 'the observer never doubles the helper');
  reportTerminalNotification(store, translate, 'task', { id: 'direct', status: 'failed', updatedAt: 21, historyRevision: 0 });
  assert.equal(store.getSnapshot().entries.length, before + 1, 'the helper and the observer share one key');
  assert.equal(reportTerminalNotification(store, translate, 'task', { id: 'running', status: 'running', updatedAt: 22 }), null);

  observer.dispose();
  const afterDispose = store.getSnapshot().entries.length;
  activity.put('tasks', { id: 'post-dispose', status: 'running', updatedAt: 30, historyRevision: 0 });
  activity.put('tasks', { id: 'post-dispose', status: 'completed', updatedAt: 31, historyRevision: 0 });
  assert.equal(store.getSnapshot().entries.length, afterDispose, 'a disposed observer publishes nothing');
});

test('a stalled reference is announced and clearing notifications keeps its control', async t => {
  const view = await setup(t, { tasks: true });
  await act(async () => {
    view.activity.put('references', { id: 'ref-1', sessionId: 'session-1', status: 'blocked', mentions: ['@a.txt'], updatedAt: 1 });
    await view.settle();
  });
  // A pending reference is a warning the user can navigate to and clear up; the
  // control that resolves it lives in the task drawer.
  const warnings = entriesOf(view).filter(entry => String(entry.dedupeKey).startsWith('reference:ref-1:'));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, 'warning');
  assert.deepEqual(warnings[0].action, { kind: 'surface', surface: 'tasks' });
  assert.deepEqual(warnings[0].details, ['@a.txt'], 'the requested mentions travel as details, not as the reason');
  assert.equal(warnings[0].code, undefined, 'a blocked reference is not the pending diagnostic');

  await view.click({ 'data-fm-action': 'show-tasks' });
  const pending = view.renderer.root.findAll(entry => typeof entry.type === 'string'
    && entry.props['data-fm-pending-references'] !== undefined && reachable(entry));
  assert.equal(pending.length, 1, 'the pending reference control lives in the task drawer');
  assert.equal(String(pending[0].props['data-fm-pending-references']), '1');
  assert.equal(nodes(view.renderer, { 'data-fm-action': 'reference-retry' }).length, 1);

  // The task header no longer repeats the notification entry, so leave the
  // drawer before reaching the history from the main header.
  await view.click({ 'data-fm-action': 'close-tasks' });
  await clickReachable(view, { 'data-fm-action': 'notifications' });
  await clickReachable(view, { 'data-fm-action': 'notifications-clear' });
  await clickReachable(view, { 'data-fm-action': 'close-notifications' });
  await clickReachable(view, { 'data-fm-action': 'show-tasks' });
  assert.equal(nodes(view.renderer, { 'data-fm-action': 'reference-retry' }).length, 1,
    'clearing events never removes the control that handles the pending reference');
});

test('a reference that is still pending is an informational event with its own code', async t => {
  const view = await setup(t, { tasks: true });
  await act(async () => {
    view.activity.put('references', { id: 'ref-2', sessionId: 'session-2', status: 'pending', mentions: ['@b.txt'], updatedAt: 1 });
    await view.settle();
  });
  const pending = entriesOf(view).filter(entry => String(entry.dedupeKey).startsWith('reference:ref-2:'));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].level, 'info');
  assert.equal(pending[0].code, 'REFERENCE_PENDING');
  assert.deepEqual(pending[0].action, { kind: 'surface', surface: 'tasks' });
  assert.deepEqual(pending[0].details, ['@b.txt']);
});

test('a removed or cleared event keeps its key so a replay cannot revive it', async t => {
  const { createNotificationStore } = await notificationsModule();
  const store = createNotificationStore();
  const first = store.publish({ level: 'info', title: 'watching', dedupeKey: 'watch:one' });
  store.remove(first);
  assert.deepEqual(store.getSnapshot().entries, []);
  const replay = store.publish({ level: 'info', title: 'watching', dedupeKey: 'watch:one' });
  assert.equal(replay, first, 'a repeated frame returns the id the event already has');
  assert.deepEqual(store.getSnapshot().entries, [],
    'closing an event must not let the same frame bring it back');
  assert.equal(store.getSnapshot().unreadCount, 0);

  const second = store.publish({ level: 'info', title: 'polling', dedupeKey: 'watch:two' });
  assert.notEqual(second, first);
  store.clear();
  assert.equal(store.publish({ level: 'info', title: 'polling', dedupeKey: 'watch:two' }), second,
    'clearing the list keeps the same memory');
  assert.deepEqual(store.getSnapshot().entries, []);
  const fresh = store.publish({ level: 'success', title: 'copied' });
  assert.equal(store.getSnapshot().entries.length, 1, 'a new action without a key is never swallowed');
  assert.notEqual(fresh, first);
});

test('a confirmed persistent failure after unmount is still recorded while the plugin lives', async t => {
  let answer;
  const gate = new Promise(resolve => { answer = resolve; });
  const failure = () => Response.json({ ok: false, error: { code: 'IO_ERROR', message: 'journal unavailable' } }, { status: 500 });
  // Never leave the Host request unreleased: an assertion failure mid-test must not
  // hang the suite on a pending fetch.
  t.after(() => { answer(failure()); });
  let confirmed = false;
  const view = await setup(t, {
    intercept: async (url, init, route) => {
      if (bodyOf(init).op === 'delete.commit') { confirmed = true; return gate; }
      return route(url, init);
    },
  });
  await view.openHello();
  await view.click({ 'data-fm-action': 'delete' });
  await act(async () => {
    node(view.renderer, { 'aria-label': '我确认永久删除不可恢复' }).props.onChange({ target: { checked: true } });
  });
  const confirm = node(view.renderer, { 'data-fm-action': 'delete-confirm' }).props.onClick;
  act(() => { confirm(); });
  assert.equal(confirmed, true, 'the persistent mutation is confirmed before the view goes away');

  view.unmount();
  const afterUnmount = view.requests.length;
  await act(async () => {
    answer(failure());
    // The expected refusal is a Host answer; allSettled keeps any other rejection
    // from being swallowed while the assertions below still run.
    await Promise.allSettled([view.settle()]);
  });
  const failures = withCode(view, 'IO_ERROR');
  assert.equal(failures.length, 1, 'the plugin still records the answer it was waiting for');
  assert.equal(failures[0].level, 'error');
  assert.equal(view.requests.length, afterUnmount, 'a dead view issues no follow-up request');
  await view.mount();
  assert.equal(openOverlays(view, 'notifications'), 0, 'the late failure never reopens the interface by itself');
});

test('a late failure is dropped once the plugin itself is gone', async t => {
  let answer;
  const gate = new Promise(resolve => { answer = resolve; });
  t.after(() => { answer(Response.json({ ok: false, error: { code: 'IO_ERROR', message: 'late' } }, { status: 500 })); });
  const view = await setup(t, {
    intercept: async (url, init, route) => (bodyOf(init).op === 'delete.commit' ? gate : route(url, init)),
  });
  await view.openHello();
  await view.click({ 'data-fm-action': 'delete' });
  await act(async () => {
    node(view.renderer, { 'aria-label': '我确认永久删除不可恢复' }).props.onChange({ target: { checked: true } });
  });
  act(() => { node(view.renderer, { 'data-fm-action': 'delete-confirm' }).props.onClick(); });
  view.unmount();
  await view.client.dispose();
  await act(async () => { answer(Response.json({ ok: false, error: { code: 'IO_ERROR', message: 'late' } }, { status: 500 })); });
  assert.deepEqual(entriesOf(view), [], 'a disposed plugin records nothing');
});

test('a terminal answer to the action itself is announced by that action, exactly once', async t => {
  acceptWrite(t);
  let view;
  const view$ = () => view;
  const view0 = await setup(t, {
    tasks: true,
    intercept: async (url, init, route) => {
      const response = await route(url, init);
      if (bodyOf(init).op !== 'tasks.start') return response;
      // Boundary fixture, controlling response *timing* only: the real task engine
      // starts the task, this test waits for it to finish, and the Panel is then
      // handed the engine's own terminal record as the answer to its own request.
      // That is the "the user gets the outcome in the same turn" case, so the
      // action's reportTerminal path — not the background observer — must publish.
      const started = await response.clone().json();
      const terminal = await view$().waitForTask(started.value.id);
      return Response.json({ ok: true, value: terminal });
    },
  });
  view = view0;

  await view.openHello();
  await view.click({ 'data-fm-action': 'copy' });
  await clickRootCrumb(view);
  await view.click({ 'data-fm-action': 'paste' });
  await view.click({ 'data-fm-action': 'paste-confirm' });

  const [task] = await view.tasks.list();
  assert.ok(task, 'the paste really started a task');
  const announced = () => entriesOf(view).filter(entry => String(entry.dedupeKey).startsWith(`terminal:tasks:${task.id}:`));
  assert.equal(announced().length, 1,
    'the terminal answer the action received is announced by the action, before any polling');
  assert.equal(announced()[0].level, 'success');
  assert.deepEqual(announced()[0].action, { kind: 'surface', surface: 'tasks' });

  await view.flush();
  assert.equal(announced().length, 1, 'the background observer yields on the same identity');
  assert.equal(entriesOf(view).some(entry => entry.code === 'IO_ERROR'), false);
});

test('a task that ends while the panel is open is announced once from a real event frame', async t => {
  acceptWrite(t);
  const streams = [];
  let refreshSeen = () => {};
  const refreshed = new Promise(resolve => { refreshSeen = resolve; });
  const taskReads = () => opCount(view, 'tasks.get') + opCount(view, 'tasks.list');
  let view;
  view = await setup(t, {
    tasks: true,
    intercept: async (url, init, route) => {
      if (bodyOf(init).op === 'tasks.get') refreshSeen();
      if (String(url).includes('/v2/events')) {
        // The Host's live stream, driven frame by frame: this is the real
        // transport, not a stub of the panel's own handler.
        const stream = { controller: null, signal: init.signal };
        streams.push(stream);
        return new Response(new ReadableStream({ start(controller) { stream.controller = controller; }, cancel() {} }),
          { headers: { 'content-type': 'text/event-stream' } });
      }
      return route(url, init);
    },
  });
  assert.ok(streams.length > 0, 'the panel subscribes to Host events');

  await view.openHello();
  await view.click({ 'data-fm-action': 'copy' });
  await clickRootCrumb(view);
  await view.click({ 'data-fm-action': 'paste' });
  await view.click({ 'data-fm-action': 'paste-confirm' });
  const [task] = await view.tasks.list();
  assert.ok(task, 'the paste really started a task');
  const announced = () => entriesOf(view).filter(entry => String(entry.dedupeKey).startsWith(`terminal:tasks:${task.id}:`));
  assert.equal(announced().length, 0, 'a task that is still running is not an outcome');

  const finished = await view.waitForTask(task.id);
  assert.equal(finished.status, 'completed', 'the real engine finished the task');
  const readsBefore = taskReads();
  const frame = payload => streams.at(-1).controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
  await act(async () => { frame({ kind: 'task', taskId: task.id, seq: 1 }); await refreshed; });
  await view.flush();

  assert.ok(taskReads() > readsBefore, 'the frame makes the panel refresh that task from the Host');
  assert.equal(announced().length, 1, 'the pushed terminal state is announced exactly once');
  assert.equal(announced()[0].level, 'success');
  assert.deepEqual(announced()[0].action, { kind: 'surface', surface: 'tasks' });

  // A replayed frame (same seq) and an unchanged state (new seq) must not stack.
  await act(async () => { frame({ kind: 'task', taskId: task.id, seq: 1 }); await view.flush(); });
  await act(async () => { frame({ kind: 'task', taskId: task.id, seq: 2 }); await view.flush(); });
  await view.flush();
  assert.equal(announced().length, 1, 'a replayed frame and an unchanged state never add a second event');
});
