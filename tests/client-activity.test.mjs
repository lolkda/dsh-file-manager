import assert from 'node:assert/strict';
import test from 'node:test';
import { loadClientModule } from './client-module-loader.mjs';

const activity = () => loadClientModule('activity');

const task = (id, status = 'running', historyRevision = 1, extra = {}) => ({ id, status, historyRevision, updatedAt: 100, ...extra });
const find = (store, kind, id) => store.getSnapshot()[kind].find(record => record.id === id);

test('publishing a record replaces it by id and keeps the newest last', async () => {
  const { createActivityStore } = await activity();
  const store = createActivityStore();
  assert.equal(store.put('tasks', task('a')), true);
  assert.equal(store.put('tasks', task('b')), true);
  assert.equal(store.put('tasks', task('a', 'completed', 1, { updatedAt: 200 })), true);
  const ids = store.getSnapshot().tasks.map(record => record.id);
  assert.deepEqual(ids, ['b', 'a']);
  assert.equal(find(store, 'tasks', 'a').status, 'completed');
});

test('a partial update is refused for a record the store never held', async () => {
  const { createActivityStore } = await activity();
  const store = createActivityStore();
  assert.equal(store.put('tasks', task('missing'), { partial: true }), false);
  assert.equal(store.getSnapshot().tasks.length, 0);
});

test('a stale history revision cannot hide a newer retry', async () => {
  const { createActivityStore } = await activity();
  const store = createActivityStore();
  store.put('tasks', task('a', 'completed', 4, { dismissed: true, updatedAt: 400 }));
  assert.equal(find(store, 'tasks', 'a').dismissed, true);
  assert.equal(store.put('tasks', task('a', 'completed', 3, { dismissed: true, updatedAt: 500 })), false, 'an older revision must be dropped');
  assert.equal(find(store, 'tasks', 'a').historyRevision, 4);
  assert.equal(store.put('tasks', task('a', 'running', 5, { dismissed: false, updatedAt: 600 })), true);
  assert.equal(find(store, 'tasks', 'a').dismissed, false, 'a newer revision revives a card that a previous dismissal had hidden');
});

test('refreshing an already closed record does not bring it back', async () => {
  const { createActivityStore } = await activity();
  const store = createActivityStore();
  store.put('tasks', task('a', 'completed', 2, { dismissed: true, updatedAt: 200 }));
  assert.equal(store.put('tasks', task('a', 'completed', 2, { dismissed: false, updatedAt: 300 })), true);
  assert.equal(find(store, 'tasks', 'a').dismissed, true, 'the same revision cannot undo a dismissal');
});

test('a running record is never hidden by a dismissal flag', async () => {
  const { createActivityStore } = await activity();
  const store = createActivityStore();
  store.put('tasks', task('a', 'running', 2, { dismissed: true, updatedAt: 200 }));
  assert.equal(find(store, 'tasks', 'a').dismissed, false);
});

test('an out-of-order update for the same revision is dropped', async () => {
  const { createActivityStore } = await activity();
  const store = createActivityStore();
  store.put('tasks', task('a', 'running', 1, { updatedAt: 500 }));
  assert.equal(store.put('tasks', task('a', 'completed', 1, { updatedAt: 400 })), false);
  assert.equal(find(store, 'tasks', 'a').status, 'running');
  assert.equal(store.put('tasks', task('a', 'completed', 1, { updatedAt: 500 })), true);
});

test('a partial update merges into the stored record instead of replacing it', async () => {
  const { createActivityStore } = await activity();
  const store = createActivityStore();
  store.put('tasks', task('a', 'running', 1, { progress: 10 }));
  assert.equal(store.put('tasks', task('a', 'completed', 2, { dismissed: true }), { partial: true }), true);
  assert.equal(find(store, 'tasks', 'a').progress, 10);
  assert.equal(find(store, 'tasks', 'a').dismissed, true);
});

test('references keep their payload and are dropped on removal', async () => {
  const { createActivityStore } = await activity();
  const store = createActivityStore();
  store.put('references', { id: 'r1', status: 'pending', updatedAt: 1, sessionId: 's1', mentions: ['@a'] });
  assert.equal(store.put('references', { id: 'r1', status: 'blocked', updatedAt: 2, sessionId: 's1', mentions: ['@a'] }), true);
  assert.equal(find(store, 'references', 'r1').status, 'blocked');
  store.remove('references', 'r1');
  assert.equal(store.getSnapshot().references.length, 0);
});

test('a claim is granted once and never revives a cancelled request', async () => {
  const { createActivityStore } = await activity();
  const store = createActivityStore();
  store.put('references', { id: 'r1', status: 'pending', updatedAt: 1 });
  assert.equal(store.claim('references', 'r1', 'pending', 'inserting'), true);
  assert.equal(store.claim('references', 'r1', 'pending', 'inserting'), false, 'a second render must not replay the same insertion');
  assert.equal(find(store, 'references', 'r1').status, 'inserting');
  store.remove('references', 'r1');
  assert.equal(store.claim('references', 'r1', 'pending', 'inserting'), false, 'a late response must not recreate a cancelled request');
  assert.equal(store.getSnapshot().references.length, 0);
});

test('the clipboard holds and clears one reviewed operation', async () => {
  const { createActivityStore } = await activity();
  const store = createActivityStore();
  assert.equal(store.getSnapshot().clipboard, null);
  store.clipboard({ operation: 'copy', items: [{ rootId: 'root', path: 'a.txt', version: 'v1' }] });
  assert.equal(store.getSnapshot().clipboard.operation, 'copy');
  assert.equal(store.getSnapshot().clipboard.items.length, 1);
  store.clipboard(null);
  assert.equal(store.getSnapshot().clipboard, null);
});

test('collapsing the task list is independent of the records it shows', async () => {
  const { createActivityStore } = await activity();
  const store = createActivityStore();
  store.put('tasks', task('a'));
  assert.equal(store.getSnapshot().tasksCollapsed, false);
  store.collapse(true);
  assert.equal(store.getSnapshot().tasksCollapsed, true);
  assert.equal(store.getSnapshot().tasks.length, 1);
  store.collapse('yes');
  assert.equal(store.getSnapshot().tasksCollapsed, false, 'collapse only accepts a literal true');
});

test('a history operation reports its pending state and its failures', async () => {
  const { createActivityStore } = await activity();
  const store = createActivityStore();
  store.history(true, []);
  assert.equal(store.getSnapshot().historyPending, true);
  store.history(false, [{ kind: 'task', taskId: 'a', error: { code: 'TASK_CHANGED' } }]);
  assert.equal(store.getSnapshot().historyPending, false);
  assert.deepEqual(store.getSnapshot().historyFailures.map(failure => failure.taskId), ['a']);
  store.history(false, []);
  assert.equal(store.getSnapshot().historyFailures.length, 0);
});

test('every commit produces a new frozen snapshot for useSyncExternalStore', async () => {
  const { createActivityStore } = await activity();
  const store = createActivityStore();
  const before = store.getSnapshot();
  store.put('tasks', task('a'));
  const after = store.getSnapshot();
  assert.notEqual(before, after);
  assert.equal(Object.isFrozen(after), true);
  assert.equal(Object.isFrozen(after.tasks), true);
  assert.equal(Object.isFrozen(after.tasks[0]), true);
  assert.equal(before.tasks.length, 0, 'a published snapshot must never be mutated in place');
});

test('subscribers are notified once per commit and can detach', async () => {
  const { createActivityStore } = await activity();
  const store = createActivityStore();
  let changes = 0;
  const unsubscribe = store.subscribe(() => { changes++; });
  store.put('tasks', task('a'));
  assert.equal(changes, 1);
  store.put('tasks', task('a', 'running', 1, { updatedAt: 999 }));
  assert.equal(changes, 2);
  unsubscribe();
  store.put('tasks', task('b'));
  assert.equal(changes, 2);
});

test('visibility follows the task status, not the dismissal flag alone', async () => {
  const { isActivityRunning, isActivityVisible, canDismissActivity } = await activity();
  assert.equal(isActivityRunning({ id: 'a', status: 'queued' }), true);
  assert.equal(isActivityRunning({ id: 'a', status: 'completed' }), false);
  assert.equal(isActivityVisible({ id: 'a', status: 'running', dismissed: true }), true, 'an active task is always visible');
  assert.equal(isActivityVisible({ id: 'a', status: 'completed', dismissed: true }), false);
  assert.equal(isActivityVisible({ id: 'a', status: 'completed' }), true);

  const capability = { taskHistory: true };
  assert.equal(canDismissActivity({ id: 'a', status: 'completed', canDismiss: true }, capability), true);
  assert.equal(canDismissActivity({ id: 'a', status: 'running', canDismiss: true }, capability), false);
  assert.equal(canDismissActivity({ id: 'a', status: 'completed', canDismiss: false }, capability), false, 'the Host decides whether a card may be closed');
  assert.equal(canDismissActivity({ id: 'a', status: 'completed', canDismiss: true, dismissed: true }, capability), false);
  assert.equal(canDismissActivity({ id: 'a', status: 'completed', canDismiss: true }, { taskHistory: false }), false, 'without Host history support nothing may be closed');
});

test('activity counters separate work in progress from closable cards', async () => {
  const { activityCounts } = await activity();
  const capabilities = { taskHistory: true };
  const tasks = [
    { id: 'a', status: 'running' },
    { id: 'b', status: 'completed', canDismiss: true },
    { id: 'c', status: 'completed', dismissed: true, canDismiss: true },
  ];
  const transfers = [
    { id: 'd', status: 'failed', canDismiss: false },
    { id: 'e', status: 'completed', canDismiss: true },
  ];
  const counts = activityCounts({ tasks, transfers }, capabilities);
  assert.equal(counts.active, 2, 'running work and cards the Host refuses to close both need attention');
  assert.equal(counts.closable, 2);
  assert.deepEqual(counts.visibleTasks.map(record => record.id), ['a', 'b']);
  assert.deepEqual(counts.visibleTransfers.map(record => record.id), ['d', 'e']);
});