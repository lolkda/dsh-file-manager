/**
 * Notification core: the store and the event observer.
 *
 * These are pure unit tests over the shipped bundle — no DOM, no Host. They pin
 * the contract the UI and the QA suites rely on: newest-first bounded storage,
 * one notification per source event, silence for history, a new notification per
 * retry generation, and a dispose that really releases everything.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadClient, loadClientModule } from './client-module-loader.mjs';

const notifications = () => loadClientModule('notifications');
const events = () => loadClientModule('notificationEvents');
const activity = () => loadClientModule('activity');

/** A deterministic translator: readable labels for the keys the core uses. */
const LABELS = {
  copy: 'Copy', cut: 'Cut', uploadFiles: 'Upload files', download: 'Download', tasks: 'Tasks',
  'status.completed': 'Completed', 'status.failed': 'Failed', 'status.partial': 'Partially completed',
  'status.cancelled': 'Cancelled', 'status.interrupted': 'Interrupted', 'status.running': 'Running',
  referenceWaiting: 'Waiting',
};
const t = key => LABELS[key] ?? key;

const task = (id, status = 'running', historyRevision = 1, extra = {}) => ({ id, status, historyRevision, updatedAt: 100, ...extra });

test('publishing keeps the newest first and counts unread entries', async () => {
  const { createNotificationStore } = await notifications();
  const store = createNotificationStore({ now: () => 1000 });
  const first = store.publish({ level: 'success', title: 'one' });
  const second = store.publish({ level: 'info', title: 'two' });
  assert.notEqual(first, second);
  const snapshot = store.getSnapshot();
  assert.deepEqual(snapshot.entries.map(entry => entry.title), ['two', 'one'], 'newest first');
  assert.deepEqual(snapshot.entries.map(entry => entry.read), [false, false]);
  assert.equal(snapshot.unreadCount, 2);
  assert.equal(snapshot.entries[0].createdAt, 1000);
  assert.equal(snapshot.entries[0].id, second);
});

test('the snapshot and its records are frozen and stable between changes', async () => {
  const { createNotificationStore } = await notifications();
  const store = createNotificationStore();
  const empty = store.getSnapshot();
  assert.equal(store.getSnapshot(), empty, 'an unchanged store must return the same reference');
  store.publish({ level: 'success', title: 'one' });
  const next = store.getSnapshot();
  assert.notEqual(next, empty);
  assert.equal(store.getSnapshot(), next);
  assert.equal(Object.isFrozen(next), true);
  assert.equal(Object.isFrozen(next.entries), true);
  assert.equal(Object.isFrozen(next.entries[0]), true);
  assert.throws(() => { next.entries[0].title = 'mutated'; }, TypeError);
});

test('stored details and action are copies, so later caller mutations cannot leak in', async () => {
  const { createNotificationStore } = await notifications();
  const store = createNotificationStore();
  const details = ['first', 'second'];
  const action = { kind: 'manual-copy', text: 'line one\nline two' };
  store.publish({ level: 'error', title: 'failed', details, action });
  details.push('third');
  action.text = 'changed';
  const entry = store.getSnapshot().entries[0];
  assert.deepEqual(entry.details, ['first', 'second']);
  assert.deepEqual(entry.action, { kind: 'manual-copy', text: 'line one\nline two' });
});

test('the store keeps only whitelisted navigation data', async () => {
  const { createNotificationStore } = await notifications();
  const store = createNotificationStore();
  const onClick = () => { throw new Error('a stored callback must never be reachable'); };
  store.publish({
    level: 'info', title: 'navigate',
    action: { kind: 'surface', surface: 'tasks', onClick, node: { evil: true } },
  });
  const [entry] = store.getSnapshot().entries;
  assert.deepEqual(entry.action, { kind: 'surface', surface: 'tasks' });
  assert.deepEqual(Object.keys(entry.action), ['kind', 'surface'], 'an extra field never survives into the history');
  assert.equal('onClick' in entry.action, false);
  assert.equal('node' in entry.action, false);
  const manual = createNotificationStore();
  manual.publish({ level: 'error', title: 'copy failed', action: { kind: 'manual-copy', text: 'a\nb', retry: onClick } });
  assert.deepEqual(Object.keys(manual.getSnapshot().entries[0].action), ['kind', 'text']);
});

test('malformed notification data is refused instead of stored', async () => {
  const { createNotificationStore } = await notifications();
  const store = createNotificationStore();
  for (const input of [
    { level: 'info', title: 'x', action: { kind: 'run' } },
    { level: 'info', title: 'x', action: { kind: 'surface', surface: 'nowhere' } },
    { level: 'info', title: 'x', action: { kind: 'surface' } },
    { level: 'info', title: 'x', action: { kind: 'manual-copy', text: 42 } },
    { level: 'info', title: 'x', action: { kind: 'manual-copy' } },
    { level: 'info', title: 'x', action: 'surface' },
    { level: 'info', title: 'x', details: 'not-an-array' },
    { level: 'info', title: 'x', details: ['ok', { text: 'object' }] },
    { level: 'info', title: 'x', message: { text: 'object' } },
    { level: 'info', title: 'x', code: 7 },
  ]) {
    assert.throws(() => store.publish(input), TypeError, JSON.stringify(input));
  }
  assert.deepEqual(store.getSnapshot().entries, [], 'nothing malformed is ever stored');
});

test('the manual-copy text is preserved in full, never truncated', async () => {
  const { createNotificationStore } = await notifications();
  const store = createNotificationStore();
  const text = Array.from({ length: 200 }, (_, index) => `/srv/data/a directory with spaces/file-${index}.txt`).join('\n');
  store.publish({ level: 'error', title: 'failed', action: { kind: 'manual-copy', text } });
  const entry = store.getSnapshot().entries[0];
  assert.equal(entry.action.kind, 'manual-copy');
  assert.equal(entry.action.text, text);
  assert.equal(entry.action.text.split('\n').length, 200);
});

test('storage is bounded to the newest entries and reports the entry it created', async () => {
  const { createNotificationStore, NOTIFICATION_LIMIT } = await notifications();
  assert.equal(NOTIFICATION_LIMIT, 100);
  const store = createNotificationStore({ limit: 3 });
  const ids = ['a', 'b', 'c', 'd'].map(title => store.publish({ level: 'info', title }));
  assert.equal(new Set(ids).size, 4);
  const snapshot = store.getSnapshot();
  assert.deepEqual(snapshot.entries.map(entry => entry.title), ['d', 'c', 'b'], 'the oldest entry is evicted');
  assert.equal(snapshot.unreadCount, 3);
  const capped = createNotificationStore();
  for (let index = 0; index < NOTIFICATION_LIMIT + 5; index++) capped.publish({ level: 'info', title: `entry-${index}` });
  assert.equal(capped.getSnapshot().entries.length, NOTIFICATION_LIMIT);
  assert.equal(capped.getSnapshot().entries[0].title, `entry-${NOTIFICATION_LIMIT + 4}`);
});

test('an evicted unread entry stops being counted', async () => {
  const { createNotificationStore } = await notifications();
  const store = createNotificationStore({ limit: 2 });
  store.publish({ level: 'info', title: 'old' });
  store.publish({ level: 'info', title: 'middle' });
  store.markRead();
  store.publish({ level: 'info', title: 'newest' });
  assert.equal(store.getSnapshot().unreadCount, 1);
  store.publish({ level: 'info', title: 'evicts the read one' });
  assert.deepEqual(store.getSnapshot().entries.map(entry => entry.title), ['evicts the read one', 'newest']);
  assert.equal(store.getSnapshot().unreadCount, 2);
});

test('one dedupe key yields exactly one notification', async () => {
  const { createNotificationStore } = await notifications();
  const store = createNotificationStore();
  const first = store.publish({ level: 'success', title: 'done', dedupeKey: 'task:t1:1:completed' });
  const again = store.publish({ level: 'success', title: 'done', dedupeKey: 'task:t1:1:completed', code: 'IGNORED' });
  assert.equal(again, first, 'a repeat returns the entry it already has');
  assert.equal(store.getSnapshot().entries.length, 1);
  assert.equal(store.getSnapshot().unreadCount, 1, 'a repeat never adds an unread entry');
  assert.equal(store.getSnapshot().entries[0].code, undefined, 'a repeat never rewrites the stored record');
  store.markRead();
  store.publish({ level: 'success', title: 'done', dedupeKey: 'task:t1:1:completed' });
  assert.equal(store.getSnapshot().unreadCount, 0, 'a repeat never resurrects a read entry');
});

test('a manual action has no key, so doing it twice reports twice', async () => {
  const { createNotificationStore } = await notifications();
  const store = createNotificationStore();
  store.publish({ level: 'success', title: 'Copied' });
  store.publish({ level: 'success', title: 'Copied' });
  assert.deepEqual(store.getSnapshot().entries.map(entry => entry.title), ['Copied', 'Copied']);
});

test('removing and clearing entries keeps the dedupe memory', async () => {
  const { createNotificationStore } = await notifications();
  const store = createNotificationStore();
  const id = store.publish({ level: 'info', title: 'first', dedupeKey: 'k1' });
  store.remove(id);
  assert.deepEqual(store.getSnapshot().entries, []);
  assert.equal(store.publish({ level: 'info', title: 'first', dedupeKey: 'k1' }), id, 'a removed entry is not re-announced');
  assert.deepEqual(store.getSnapshot().entries, [], 'and it is not restored either');
  const second = store.publish({ level: 'info', title: 'second', dedupeKey: 'k2' });
  store.clear();
  assert.deepEqual(store.getSnapshot().entries, []);
  assert.equal(store.getSnapshot().unreadCount, 0);
  assert.equal(store.publish({ level: 'info', title: 'second', dedupeKey: 'k2' }), second, 'a cleared entry is not re-announced either');
  assert.deepEqual(store.getSnapshot().entries, [], 'clearing stays cleared while the same event repeats');
  // A genuinely new event after a clear is reported normally.
  assert.ok(store.publish({ level: 'info', title: 'third', dedupeKey: 'k3' }));
  assert.deepEqual(store.getSnapshot().entries.map(entry => entry.title), ['third']);
  assert.equal(store.getSnapshot().unreadCount, 1);
});

test('the dedupe memory itself is bounded, so long sessions cannot grow it', async () => {
  const { createNotificationStore } = await notifications();
  const store = createNotificationStore({ limit: 10, dedupeLimit: 2 });
  store.publish({ level: 'info', title: 'a', dedupeKey: 'a' });
  store.publish({ level: 'info', title: 'b', dedupeKey: 'b' });
  store.publish({ level: 'info', title: 'c', dedupeKey: 'c' });
  store.publish({ level: 'info', title: 'b again', dedupeKey: 'b' });
  assert.equal(store.getSnapshot().entries.length, 3, 'a recent key still suppresses its repeat');
  store.publish({ level: 'info', title: 'a again', dedupeKey: 'a' });
  assert.deepEqual(store.getSnapshot().entries.filter(entry => entry.dedupeKey === 'a').map(entry => entry.title), ['a again', 'a'],
    'the oldest key is forgotten once the ring evicts it');
});

test('reading, removing and clearing only touch notification records', async () => {
  const { createNotificationStore } = await notifications();
  const store = createNotificationStore();
  const one = store.publish({ level: 'error', title: 'one' });
  store.publish({ level: 'error', title: 'two' });
  let commits = 0;
  const unsubscribe = store.subscribe(() => { commits++; });
  store.markRead([one]);
  assert.deepEqual(store.getSnapshot().entries.map(entry => entry.read), [false, true], 'only the requested entry is read');
  assert.equal(store.getSnapshot().unreadCount, 1);
  assert.equal(commits, 1);
  store.markRead([one]);
  assert.equal(commits, 1, 'reading an already-read entry does not notify subscribers');
  store.markRead(['missing-id']);
  assert.equal(commits, 1, 'an unknown id changes nothing');
  store.markRead();
  assert.equal(store.getSnapshot().unreadCount, 0);
  store.remove('missing-id');
  assert.equal(store.getSnapshot().entries.length, 2);
  store.remove(one);
  assert.deepEqual(store.getSnapshot().entries.map(entry => entry.title), ['two']);
  unsubscribe();
  store.clear();
  assert.equal(commits, 3, 'no listener fired after it unsubscribed');
});

test('subscribers take no argument and unsubscribing stops delivery', async () => {
  const { createNotificationStore } = await notifications();
  const store = createNotificationStore();
  const seen = [];
  const unsubscribe = store.subscribe((...args) => { seen.push(args); });
  store.publish({ level: 'info', title: 'one' });
  assert.deepEqual(seen, [[]]);
  unsubscribe();
  store.publish({ level: 'info', title: 'two' });
  assert.equal(seen.length, 1);
});

test('invalid input is refused instead of stored as an unrenderable record', async () => {
  const { createNotificationStore } = await notifications();
  const store = createNotificationStore();
  assert.throws(() => store.publish({ level: 'catastrophe', title: 'x' }), TypeError);
  assert.throws(() => store.publish({ level: 'info', title: '' }), TypeError);
  assert.throws(() => store.publish({ level: 'info' }), TypeError);
  assert.deepEqual(store.getSnapshot().entries, []);
});

test('a disposed store releases everything and stays a safe no-op', async () => {
  const { createNotificationStore } = await notifications();
  const store = createNotificationStore();
  store.publish({ level: 'info', title: 'before' });
  let commits = 0;
  const unsubscribe = store.subscribe(() => { commits++; });
  store.dispose();
  assert.deepEqual(store.getSnapshot(), { entries: [], unreadCount: 0 });
  assert.equal(store.publish({ level: 'info', title: 'after' }), '', 'a disposed store never mints an id');
  assert.equal(commits, 0, 'subscribers are released without being called');
  assert.doesNotThrow(() => { store.markRead(); store.remove('n1'); store.clear(); store.dispose(); unsubscribe(); });
  assert.deepEqual(store.getSnapshot(), { entries: [], unreadCount: 0 });
  // A rebuild is a brand-new store: nothing survives a plugin reload.
  const rebuilt = createNotificationStore();
  assert.deepEqual(rebuilt.getSnapshot(), { entries: [], unreadCount: 0 });
});

test('loading the store never publishes: history is silent until an event happens', async () => {
  const { createNotificationStore } = await notifications();
  const store = createNotificationStore();
  store.publish({ level: 'success', title: 'Copied' });
  store.markRead();
  assert.equal(store.getSnapshot().unreadCount, 0);
  assert.equal(store.getSnapshot().entries.length, 1);
});

/* ------------------------------------------------------------------ *
 * Event observer
 * ------------------------------------------------------------------ */

test('task and transfer terminal transitions are announced once', async () => {
  const { createNotificationStore } = await notifications();
  const { createActivityStore } = await activity();
  const { createNotificationEvents } = await events();
  const store = createNotificationStore();
  const activityStore = createActivityStore();
  const observer = createNotificationEvents({ notifications: store, activity: activityStore, t });
  activityStore.put('tasks', task('t1', 'running'));
  assert.equal(store.getSnapshot().entries.length, 0, 'a running task is not an event');
  activityStore.put('tasks', task('t1', 'completed', 1, { operation: 'copy' }));
  assert.deepEqual(store.getSnapshot().entries.map(entry => [entry.level, entry.title, entry.action]), [
    ['success', 'Copy · Completed', { kind: 'surface', surface: 'tasks' }],
  ]);
  // The same terminal state published again (poll, SSE, re-render) stays one entry.
  activityStore.put('tasks', task('t1', 'completed', 1, { operation: 'copy', updatedAt: 200 }));
  assert.equal(store.getSnapshot().entries.length, 1);
  activityStore.put('transfers', { id: 'u1', status: 'running', direction: 'upload', updatedAt: 300 });
  assert.equal(store.getSnapshot().entries.length, 1, 'a running transfer is not an event');
  activityStore.put('transfers', { id: 'u1', status: 'failed', direction: 'upload', updatedAt: 400 });
  assert.deepEqual(store.getSnapshot().entries.map(entry => entry.title), ['Upload files · Failed', 'Copy · Completed']);
  assert.equal(store.getSnapshot().entries[0].level, 'error');
  observer.dispose();
});

test('history imported after the observer starts is never announced', async () => {
  const { createNotificationStore } = await notifications();
  const { createActivityStore } = await activity();
  const { createNotificationEvents } = await events();
  const store = createNotificationStore();
  const activityStore = createActivityStore();
  // The real client creates this observer while the activity store is still
  // empty; the panel imports past work later through tasks.list/transfers.list.
  const observer = createNotificationEvents({ notifications: store, activity: activityStore, t });
  assert.deepEqual(store.getSnapshot().entries, []);
  activityStore.put('tasks', task('old-1', 'completed', 1, { operation: 'copy' }));
  activityStore.put('tasks', task('old-2', 'failed'));
  activityStore.put('transfers', { id: 'old-3', status: 'interrupted', direction: 'download', updatedAt: 10 });
  assert.deepEqual(store.getSnapshot().entries, [], 'an asynchronous history import is not a new event');
  activityStore.put('tasks', task('old-1', 'completed', 1, { operation: 'copy', updatedAt: 500 }));
  assert.deepEqual(store.getSnapshot().entries, [], 'and a poll refreshing that history is not one either');
  // A live transition after the import is still an event.
  activityStore.put('tasks', task('live', 'running'));
  activityStore.put('tasks', task('live', 'completed'));
  assert.deepEqual(store.getSnapshot().entries.map(entry => entry.title), ['Tasks · Completed']);
  observer.dispose();
});

test('a terminal record first sighted as finished stays silent unless the UI reports it', async () => {
  const { createNotificationStore } = await notifications();
  const { createActivityStore } = await activity();
  const { createNotificationEvents } = await events();
  const store = createNotificationStore();
  const activityStore = createActivityStore();
  const observer = createNotificationEvents({ notifications: store, activity: activityStore, t });
  // A user action that comes back already finished: the observer cannot tell it
  // apart from imported history, so it stays silent.
  const refused = { ...task('fast-failure', 'failed'), operation: 'move' };
  activityStore.put('tasks', refused);
  assert.deepEqual(store.getSnapshot().entries, [], 'the observer never guesses that a first sighting is fresh');
  // The UI knows the record came from its own mutation, so it reports it.
  const id = observer.reportTerminal('task', refused);
  assert.ok(id);
  assert.deepEqual(store.getSnapshot().entries.map(entry => entry.title), ['Cut · Failed']);
  assert.deepEqual(store.getSnapshot().entries[0].action, { kind: 'surface', surface: 'tasks' });
  // The observer knows the record now, so a later poll adds nothing.
  activityStore.put('tasks', { ...refused, updatedAt: 900 });
  assert.equal(store.getSnapshot().entries.length, 1);
  observer.dispose();
});

test('a retry generation notifies again while repeats never do', async () => {
  const { createNotificationStore } = await notifications();
  const { createActivityStore } = await activity();
  const { createNotificationEvents } = await events();
  const store = createNotificationStore();
  const activityStore = createActivityStore();
  const observer = createNotificationEvents({ notifications: store, activity: activityStore, t });
  activityStore.put('tasks', task('t2', 'running', 1));
  activityStore.put('tasks', task('t2', 'failed', 1));
  assert.equal(store.getSnapshot().entries.length, 1);
  activityStore.put('tasks', task('t2', 'failed', 1));
  assert.equal(store.getSnapshot().entries.length, 1, 'the same generation is not re-announced');
  activityStore.put('tasks', task('t2', 'queued', 2));
  assert.equal(store.getSnapshot().entries.length, 1, 'a reopened task is not a result');
  activityStore.put('tasks', task('t2', 'failed', 2));
  assert.equal(store.getSnapshot().entries.length, 2, 'the retry is a new generation');
  observer.dispose();
});

test('a closed card is not re-announced', async () => {
  const { createNotificationStore } = await notifications();
  const { createActivityStore } = await activity();
  const { createNotificationEvents } = await events();
  const store = createNotificationStore();
  const activityStore = createActivityStore();
  const observer = createNotificationEvents({ notifications: store, activity: activityStore, t });
  activityStore.put('tasks', task('t3', 'running'));
  activityStore.put('tasks', { ...task('t3', 'completed'), dismissed: true });
  assert.deepEqual(store.getSnapshot().entries, []);
  observer.dispose();
});

test('a direct terminal result and the observer together produce one notification', async () => {
  const { createNotificationStore } = await notifications();
  const { createActivityStore } = await activity();
  const { createNotificationEvents } = await events();
  const store = createNotificationStore();
  const activityStore = createActivityStore();
  const observer = createNotificationEvents({ notifications: store, activity: activityStore, t });
  const record = task('t4', 'failed', 3, { operation: 'copy' });
  // The UI reports what it already holds, before storing the record.
  const id = observer.reportTerminal('task', record);
  assert.ok(id);
  activityStore.put('tasks', record);
  assert.equal(store.getSnapshot().entries.length, 1);
  assert.equal(store.getSnapshot().entries[0].title, 'Copy · Failed');
  // Non-terminal observations are refused rather than guessed.
  assert.equal(observer.reportTerminal('task', task('t5', 'running')), null);
  observer.dispose();
  assert.equal(observer.reportTerminal('task', task('t6', 'failed')), null, 'a disposed observer reports nothing');
});

test('the module-level reporter shares the observer key', async () => {
  const { createNotificationStore } = await notifications();
  const { createActivityStore } = await activity();
  const { createNotificationEvents, reportTerminalNotification } = await events();
  const store = createNotificationStore();
  const activityStore = createActivityStore();
  const observer = createNotificationEvents({ notifications: store, activity: activityStore, t });
  const record = { id: 'u9', status: 'cancelled', direction: 'download', updatedAt: 10 };
  const first = reportTerminalNotification(store, t, 'transfer', record, { message: '3 items' });
  assert.ok(first);
  assert.equal(observer.reportTerminal('transfer', record), first, 'both entry points resolve to one event');
  activityStore.put('transfers', record);
  assert.equal(store.getSnapshot().entries.length, 1);
  assert.equal(store.getSnapshot().entries[0].level, 'info');
  assert.equal(store.getSnapshot().entries[0].message, '3 items');
  observer.dispose();
});

test('a new reference request is an info event and its failure is a warning', async () => {
  const { createNotificationStore } = await notifications();
  const { createActivityStore } = await activity();
  const { createNotificationEvents } = await events();
  const store = createNotificationStore();
  const activityStore = createActivityStore();
  const observer = createNotificationEvents({ notifications: store, activity: activityStore, t });
  const reference = (status, updatedAt, extra = {}) => ({ id: 'r1', status, updatedAt, sessionId: 's1', mentions: ['@/srv/data/a.txt'], ...extra });
  activityStore.put('references', reference('pending', 1));
  let [entry] = store.getSnapshot().entries;
  assert.equal(entry.level, 'info', 'asking to insert a reference is an event, not a failure');
  assert.equal(entry.title, 'Waiting', 'the translated "waiting for the session" wording');
  assert.deepEqual(entry.action, { kind: 'surface', surface: 'tasks' }, 'the user can navigate to where it is handled');
  assert.deepEqual(entry.details, ['@/srv/data/a.txt'], 'the requested mentions are context, not the reason');
  assert.equal(entry.message, undefined);
  assert.equal(entry.code, 'REFERENCE_PENDING', 'a stable code lets every surface search the same event');
  activityStore.put('references', reference('pending', 1));
  assert.equal(store.getSnapshot().entries.length, 1, 'a repeated render is not a new request');
  activityStore.put('references', reference('blocked', 2, { error: 'referenceBusy' }));
  [entry] = store.getSnapshot().entries;
  assert.equal(entry.level, 'warning');
  assert.equal(entry.title, 'referenceBusy', 'the reason is the translated error');
  assert.equal(entry.code, undefined, 'only the documented codes are attached');
  assert.deepEqual(entry.details, ['@/srv/data/a.txt']);
  assert.equal(store.getSnapshot().entries.length, 2);
  activityStore.put('references', reference('blocked', 2, { error: 'referenceBusy' }));
  assert.equal(store.getSnapshot().entries.length, 2, 'a repeated frame is not a new failure');
  activityStore.put('references', reference('blocked', 3, { error: 'referenceStale' }));
  assert.equal(store.getSnapshot().entries.length, 3, 'a retried attempt that fails again is a new event');
  activityStore.remove('references', 'r1');
  assert.equal(store.getSnapshot().entries.length, 3, 'a successful insertion adds nothing');
  observer.dispose();
});

test('disposing the observer releases the activity subscription', async () => {
  const { createNotificationStore } = await notifications();
  const { createActivityStore } = await activity();
  const { createNotificationEvents } = await events();
  const store = createNotificationStore();
  const activityStore = createActivityStore();
  const observer = createNotificationEvents({ notifications: store, activity: activityStore, t });
  observer.dispose();
  activityStore.put('tasks', task('late', 'completed'));
  assert.deepEqual(store.getSnapshot().entries, [], 'nothing is published after the plugin unloads');
  assert.doesNotThrow(() => observer.dispose());
});

test('a disposed store keeps the observer silent instead of throwing', async () => {
  const { createNotificationStore } = await notifications();
  const { createActivityStore } = await activity();
  const { createNotificationEvents } = await events();
  const store = createNotificationStore();
  const activityStore = createActivityStore();
  const observer = createNotificationEvents({ notifications: store, activity: activityStore, t });
  store.dispose();
  assert.doesNotThrow(() => activityStore.put('tasks', task('after-dispose', 'completed')));
  assert.deepEqual(store.getSnapshot(), { entries: [], unreadCount: 0 });
  observer.dispose();
});

test('terminal levels follow the outcome instead of always being success', async () => {
  const { createNotificationStore } = await notifications();
  const { createActivityStore } = await activity();
  const { createNotificationEvents } = await events();
  const store = createNotificationStore();
  const activityStore = createActivityStore();
  const observer = createNotificationEvents({ notifications: store, activity: activityStore, t });
  for (const [status, level] of [['completed', 'success'], ['partial', 'warning'], ['failed', 'error'], ['cancelled', 'info'], ['interrupted', 'warning']]) {
    activityStore.put('tasks', task(`level-${status}`, 'running'));
    activityStore.put('tasks', task(`level-${status}`, status));
    assert.equal(store.getSnapshot().entries[0].level, level, `${status} must map to ${level}`);
  }
  observer.dispose();
});

test('a history import larger than the cache never hides a live transition', async () => {
  const { createNotificationStore } = await notifications();
  const { createActivityStore } = await activity();
  const { createNotificationEvents } = await events();
  const store = createNotificationStore();
  const activityStore = createActivityStore();
  const observer = createNotificationEvents({ notifications: store, activity: activityStore, t });
  // A task that is genuinely running before a long history load arrives: the
  // bounded cache must not forget it while the import is being scanned.
  activityStore.put('tasks', task('live-task', 'running', 1));
  for (let index = 0; index < 1200; index++) activityStore.put('tasks', task(`history-${index}`, 'completed', 1));
  assert.deepEqual(store.getSnapshot().entries, [], 'imported history is not announced');
  activityStore.put('tasks', task('live-task', 'completed', 1));
  assert.deepEqual(store.getSnapshot().entries.map(entry => entry.title), ['Tasks · Completed'],
    'the live transition survives the import');
  observer.dispose();
});

test('a new generation that finishes without a queued frame is announced once', async () => {
  const { createNotificationStore } = await notifications();
  const { createActivityStore } = await activity();
  const { createNotificationEvents } = await events();
  const store = createNotificationStore();
  const activityStore = createActivityStore();
  const observer = createNotificationEvents({ notifications: store, activity: activityStore, t });
  activityStore.put('tasks', task('g1', 'running', 1));
  activityStore.put('tasks', task('g1', 'failed', 1));
  assert.equal(store.getSnapshot().entries.length, 1);
  activityStore.put('tasks', task('g1', 'failed', 1, { updatedAt: 150 }));
  assert.equal(store.getSnapshot().entries.length, 1, 'the same generation is not re-announced');
  activityStore.put('tasks', task('g1', 'failed', 2));
  assert.equal(store.getSnapshot().entries.length, 2, 'a higher revision is a new generation, queued frame or not');
  activityStore.put('tasks', task('g1', 'failed', 2, { updatedAt: 250 }));
  assert.equal(store.getSnapshot().entries.length, 2, 'and a repeat of that generation is not');
  // A dismissal bumps the history revision: closing a card is not a result.
  activityStore.put('tasks', { ...task('g1', 'failed', 3), dismissed: true });
  assert.equal(store.getSnapshot().entries.length, 2, 'a dismissed card is never re-announced');
  observer.dispose();
});

test('a failed path copy keeps the full manual text and a searchable code', async () => {
  const client = await loadClient();
  assert.equal(typeof client.pathCopyNotification, 'function', 'the copy notification builder is exported');
  assert.equal(client.PATH_COPY_FAILED_CODE, 'PATH_COPY_FAILED');
  const paths = Array.from({ length: 120 }, (_, index) => `/srv/data/a directory with spaces/file-${index}.txt`);
  const failed = client.pathCopyNotification(t, { status: 'failed', count: paths.length, text: paths.join('\n') });
  assert.equal(failed.level, 'error');
  assert.equal(failed.code, 'PATH_COPY_FAILED');
  assert.deepEqual(Object.keys(failed.action), ['kind', 'text']);
  assert.equal(failed.action.text, paths.join('\n'), 'the manual text is byte-identical, never truncated');
  assert.equal(failed.action.text.split('\n').length, 120);
  const copied = client.pathCopyNotification(t, { status: 'copied', count: 2, text: 'a\nb' });
  assert.equal(copied.level, 'success');
  assert.equal(copied.code, undefined);
  assert.equal(copied.action, undefined);
});
