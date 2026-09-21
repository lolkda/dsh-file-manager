import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { act, loadClient, node, nodes, setup, textOf } from './client-harness.mjs';

// These are activity-model and actual React component tests, not a mock page.
// Wire snapshots below exercise Client contract races independently of the
// real-service filesystem cases added after the service handshake.
const taskSnapshot = (change = {}) => ({
  id: 'task-a', operation: 'copy', status: 'completed', dismissed: false, historyRevision: 0, canDismiss: true,
  updatedAt: '2026-01-01T00:00:01.000Z', createdAt: '2026-01-01T00:00:00.000Z',
  items: [{ id: 'item-a', source: { rootId: 'root', path: 'source.txt' }, destination: { rootId: 'root', path: 'target.txt' }, status: 'completed', attempts: 1 }],
  progress: { total: 1, completed: 1, failed: 0, skipped: 0, cancelled: 0, bytes: 4, totalBytes: 4 },
  ...change,
});
const transferSnapshot = (change = {}) => ({
  id: 'transfer-a', type: 'transfer', direction: 'upload', rootId: 'root', path: '', status: 'completed',
  dismissed: false, historyRevision: 0, canDismiss: true, updatedAt: 1000, createdAt: 0,
  bytesTransferred: 4, bytesTotal: 4, itemsTotal: 1, itemsCompleted: 1,
  items: [{ id: 'upload-a', path: 'upload.txt', kind: 'file', size: 4, status: 'completed', committed: true, bytesTransferred: 4 }],
  ...change,
});
const getActivity = client => client.cells.get('main:file-manager').options.inject().activity;
async function activityFixture(t) {
  const client = await loadClient(() => { throw new Error('The activity store must not perform I/O.'); });
  t.after(client.dispose);
  return getActivity(client);
}

test('activity history rejects an older revision even when its timestamp is newer', async t => {
  const activity = await activityFixture(t);
  activity.put('tasks', taskSnapshot({ status: 'running', historyRevision: 2, canDismiss: false }));
  activity.put('tasks', taskSnapshot({ dismissed: true, historyRevision: 1, canDismiss: false, updatedAt: '2026-01-01T00:00:09.000Z' }));
  const current = activity.getSnapshot().tasks[0];
  assert.equal(current.historyRevision, 2);
  assert.equal(current.status, 'running');
  assert.equal(current.dismissed, false);
});

test('a newer retry revision replaces dismissed history even with an older timestamp', async t => {
  const activity = await activityFixture(t);
  activity.put('transfers', transferSnapshot({ dismissed: true, historyRevision: 3, canDismiss: false, updatedAt: 9000 }));
  activity.put('transfers', transferSnapshot({ status: 'queued', historyRevision: 4, canDismiss: false, updatedAt: 1000 }));
  const current = activity.getSnapshot().transfers[0];
  assert.equal(current.historyRevision, 4);
  assert.equal(current.dismissed, false);
  assert.equal(current.status, 'queued');
});

test('small dismissal receipts merge without erasing item results or transfer metadata', async t => {
  const activity = await activityFixture(t);
  const original = transferSnapshot();
  activity.put('transfers', original);
  activity.put('transfers', { id: original.id, status: 'completed', dismissed: true, historyRevision: 1, canDismiss: false }, { partial: true });
  const current = activity.getSnapshot().transfers[0];
  assert.equal(current.dismissed, true);
  assert.equal(current.historyRevision, 1);
  assert.equal(current.items, original.items);
  assert.equal(current.direction, 'upload');
  assert.equal(current.bytesTotal, 4);
  assert.equal(current.updatedAt, 1000);
});

test('legacy task snapshots default to visible history revision zero', async t => {
  const activity = await activityFixture(t);
  const { dismissed, historyRevision, ...legacy } = taskSnapshot();
  activity.put('tasks', legacy);
  assert.equal(activity.getSnapshot().tasks[0].historyRevision, 0);
  assert.equal(activity.getSnapshot().tasks[0].dismissed, false);
});

test('same-revision history cannot silently undo a confirmed dismissal', async t => {
  const activity = await activityFixture(t);
  activity.put('tasks', taskSnapshot({ dismissed: true, historyRevision: 1, canDismiss: false }));
  activity.put('tasks', taskSnapshot({ historyRevision: 1, updatedAt: '2026-01-01T00:00:09.000Z' }));
  assert.equal(activity.getSnapshot().tasks[0].dismissed, true);
});

test('same-revision progress and finalization updates are preserved', async t => {
  const activity = await activityFixture(t);
  activity.put('tasks', taskSnapshot({ status: 'cancelled', canDismiss: false }));
  activity.put('tasks', taskSnapshot({ status: 'cancelled', canDismiss: true }));
  assert.equal(activity.getSnapshot().tasks[0].canDismiss, true);
});

async function historyPanel(t, options = {}) {
  const events = [];
  const view = await setup(t, {
    tasks: true, transfers: true, globals: options.globals,
    intercept: async (url, init, route) => {
      const input = typeof init.body === 'string' ? JSON.parse(init.body) : null;
      if (url === '/api/file-manager/events' && options.watch) {
        const stream = { signal: init.signal, cancelled: false };
        const body = new ReadableStream({ start(controller) { stream.controller = controller; }, cancel() { stream.cancelled = true; } });
        events.push(stream);
        return new Response(body);
      }
      if (input?.op === 'activities.dismiss' && options.onDismiss) return new Response(JSON.stringify({ ok: true, value: await options.onDismiss(input) }));
      const response = await route(url, init);
      if (input?.op === 'bootstrap') {
        const envelope = await response.json();
        envelope.value.capabilities.taskHistory = options.supported !== false;
        if (options.watch) envelope.value.capabilities.watch = true;
        return new Response(JSON.stringify(envelope));
      }
      return response;
    },
  });
  const activity = getActivity(view.client);
  act(() => {
    for (const record of options.taskRecords ?? []) activity.put('tasks', record);
    for (const record of options.transferRecords ?? []) activity.put('transfers', record);
  });
  return { view, activity, events };
}
const dismissal = item => ({ kind: item.kind, taskId: item.taskId, outcome: 'dismissed', task: {
  id: item.taskId, status: 'completed', dismissed: true, historyRevision: item.expectedHistoryRevision + 1, canDismiss: false,
} });
const closeButton = (view, kind, id) => nodes(view.renderer, { 'data-fm-history-action': 'dismiss', 'data-fm-history-kind': kind, 'data-fm-history-id': id });

test('only quiescent visible terminal cards expose close controls', async t => {
  const { view } = await historyPanel(t, {
    taskRecords: [taskSnapshot(), taskSnapshot({ id: 'running', status: 'running', canDismiss: true, dismissed: true }), taskSnapshot({ id: 'settling', status: 'cancelled', canDismiss: false })],
    transferRecords: [transferSnapshot({ status: 'failed' }), transferSnapshot({ id: 'hidden', dismissed: true, canDismiss: false })],
  });
  assert.equal(closeButton(view, 'task', 'task-a').length, 1);
  assert.equal(closeButton(view, 'transfer', 'transfer-a').length, 1, 'failed cards remain visible until an explicit close');
  assert.equal(closeButton(view, 'task', 'running').length, 0);
  assert.equal(closeButton(view, 'task', 'settling').length, 0);
  assert.equal(nodes(view.renderer, { 'data-fm-task-id': 'running', 'data-fm-task-status': 'running' }).length, 1, 'bad dismissed flags must never hide active tasks');
  assert.equal(nodes(view.renderer, { 'data-fm-transfer-id': 'hidden', 'data-fm-transfer-status': 'completed' }).length, 0);
  assert.equal(nodes(view.renderer, { 'data-fm-active-count': 2 }).length, 1);
});

test('unsupported history capability never exposes a local-only close action', async t => {
  const { view } = await historyPanel(t, { supported: false, taskRecords: [taskSnapshot()] });
  assert.equal(closeButton(view, 'task', 'task-a').length, 0);
  const clear = nodes(view.renderer, { 'data-fm-history-action': 'clear' });
  assert.ok(clear.length === 0 || clear[0].props.disabled);
});

test('single-card closing applies a small persisted receipt and cannot be undone by stale refresh', async t => {
  const requests = [];
  const { view, activity } = await historyPanel(t, { taskRecords: [taskSnapshot()], onDismiss: async input => {
    requests.push(input); return { results: input.items.map(dismissal) };
  } });
  await view.click({ 'data-fm-history-action': 'dismiss', 'data-fm-history-kind': 'task', 'data-fm-history-id': 'task-a' });
  assert.equal(requests.length, 1);
  assert.equal(typeof requests[0].requestId, 'string');
  assert.deepEqual(requests[0].items, [{ kind: 'task', taskId: 'task-a', expectedHistoryRevision: 0 }]);
  assert.equal(activity.getSnapshot().tasks[0].items.length, 1);
  assert.equal(nodes(view.renderer, { 'data-fm-task-id': 'task-a', 'data-fm-task-status': 'completed' }).length, 0);
  act(() => activity.put('tasks', taskSnapshot({ updatedAt: '2026-01-01T00:00:09.000Z' })));
  assert.equal(nodes(view.renderer, { 'data-fm-task-id': 'task-a', 'data-fm-task-status': 'completed' }).length, 0);
});

test('an old closing receipt cannot hide a newly retried execution', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { started = resolve; });
  t.after(() => release());
  const { view, activity } = await historyPanel(t, { taskRecords: [taskSnapshot()], onDismiss: async input => { started(); await gate; return { results: input.items.map(dismissal) }; } });
  let closing;
  await act(async () => { closing = node(view.renderer, { 'data-fm-history-action': 'dismiss', 'data-fm-history-kind': 'task', 'data-fm-history-id': 'task-a' }).props.onClick(); await pending; });
  act(() => activity.put('tasks', taskSnapshot({ status: 'running', historyRevision: 2, canDismiss: false })));
  await act(async () => { release(); await closing; });
  assert.equal(activity.getSnapshot().tasks[0].historyRevision, 2);
  assert.equal(nodes(view.renderer, { 'data-fm-task-id': 'task-a', 'data-fm-task-status': 'running' }).length, 1);
});

test('clear-ended preserves rejected cards and never submits active or finalizing records', async t => {
  const batches = [];
  const { view } = await historyPanel(t, {
    taskRecords: [taskSnapshot(), taskSnapshot({ id: 'failure', status: 'failed' }), taskSnapshot({ id: 'active', status: 'running', canDismiss: false }), taskSnapshot({ id: 'tail', status: 'cancelled', canDismiss: false })],
    transferRecords: [transferSnapshot()],
    onDismiss: async input => { batches.push(input.items); return { results: input.items.map(item => item.taskId === 'failure' ? { kind: item.kind, taskId: item.taskId, outcome: 'rejected', error: { code: 'TASK_BUSY', message: 'Still settling.', details: {} } } : dismissal(item)) }; },
  });
  await view.click({ 'data-fm-history-action': 'clear' });
  assert.deepEqual(batches.flat().map(item => item.taskId).sort(), ['failure', 'task-a', 'transfer-a']);
  assert.equal(nodes(view.renderer, { 'data-fm-task-id': 'failure', 'data-fm-task-status': 'failed' }).length, 1);
  assert.equal(nodes(view.renderer, { 'data-fm-task-id': 'active', 'data-fm-task-status': 'running' }).length, 1);
  assert.equal(nodes(view.renderer, { 'data-fm-task-id': 'tail', 'data-fm-task-status': 'cancelled' }).length, 1);
  assert.equal(nodes(view.renderer, { 'data-fm-task-id': 'task-a', 'data-fm-task-status': 'completed' }).length, 0);
  assert.ok(textOf(node(view.renderer, { 'data-fm-history-errors': true })).includes('failure'));
});

test('clear-ended captures its click-time set and splits requests into at most 256 records', async t => {
  const batches = [];
  let activity;
  const fixture = await historyPanel(t, { taskRecords: Array.from({ length: 257 }, (_, index) => taskSnapshot({ id: `task-${index}` })), onDismiss: async input => {
    batches.push(input.items);
    if (batches.length === 1) activity.put('tasks', taskSnapshot({ id: 'later-completion' }));
    return { results: input.items.map(dismissal) };
  } });
  activity = fixture.activity;
  await fixture.view.click({ 'data-fm-history-action': 'clear' });
  assert.deepEqual(batches.map(batch => batch.length), [256, 1]);
  assert.equal(batches.flat().some(item => item.taskId === 'later-completion'), false);
  assert.equal(nodes(fixture.view.renderer, { 'data-fm-task-id': 'later-completion', 'data-fm-task-status': 'completed' }).length, 1);
});

test('finalizing terminal activities keep refreshing until canDismiss becomes true', async t => {
  const intervals = new Set();
  const { activity } = await historyPanel(t, { taskRecords: [taskSnapshot({ status: 'cancelled', canDismiss: false })], globals: {
    setInterval(callback, delay) { const timer = { callback, delay }; intervals.add(timer); return timer; },
    clearInterval(timer) { intervals.delete(timer); },
  } });
  assert.equal(intervals.size, 1, 'terminal status alone must not stop finalization polling');
  act(() => activity.put('tasks', taskSnapshot({ status: 'cancelled', canDismiss: true })));
  assert.equal(intervals.size, 0);
});

test('collapsing keeps task counts, editor state and event subscription alive', async t => {
  const { view, events } = await historyPanel(t, { watch: true, taskRecords: [taskSnapshot({ status: 'running', canDismiss: false })] });
  await view.openHello(); await view.click({ 'data-fm-action': 'edit' });
  act(() => node(view.renderer, { 'data-fm-editor': true }).props.onChange({ target: { value: 'draft remains mounted' } }));
  const stream = events.at(-1);
  await view.click({ 'data-fm-history-action': 'toggle' });
  assert.equal(node(view.renderer, { 'data-fm-task-cards': true }).props.hidden, true);
  assert.equal(node(view.renderer, { 'data-fm-history-action': 'toggle' }).props['aria-expanded'], false);
  assert.equal(nodes(view.renderer, { 'data-fm-active-count': 1 }).length, 1);
  assert.equal(stream.signal.aborted, false);
  assert.equal(stream.cancelled, false);
  assert.equal(node(view.renderer, { 'data-fm-editor': true }).props.value, 'draft remains mounted');
  await view.click({ 'data-fm-history-action': 'toggle' });
  assert.equal(node(view.renderer, { 'data-fm-task-cards': true }).props.hidden, false);
});

async function copyHello(view) {
  await view.openHello();
  await view.click({ 'data-fm-action': 'copy' });
  await view.click({ 'data-fm-root': true });
  await view.click({ 'data-fm-action': 'paste' });
  await view.click({ 'data-fm-action': 'paste-confirm' });
  const [task] = await view.tasks.list();
  await view.waitForTask(task.id);
  await view.click({ 'data-fm-action': 'refresh-tasks' });
  return view.tasks.get({ taskId: task.id });
}
async function uploadText(view, name = 'history-upload.txt') {
  await view.click({ 'data-fm-root': true });
  await act(async () => { await node(view.renderer, { 'data-fm-upload-files': true }).props.onChange({ target: { files: [new File(['upload history'], name)], value: '' } }); });
  await view.click({ 'data-fm-action': 'upload-confirm' });
  return view.transfers.list()[0];
}

test('real task dismissal persists across a fresh Client load without removing copied files or recovery records', async t => {
  const journal = new Map();
  const view = await setup(t, { tasks: true, transfers: true, taskOptions: { persistTask: async record => { journal.set(record.id, structuredClone(record)); } } });
  const task = await copyHello(view);
  assert.equal(task.canDismiss, true);
  await view.click({ 'data-fm-history-action': 'dismiss', 'data-fm-history-kind': 'task', 'data-fm-history-id': task.id });
  const saved = await view.tasks.get({ taskId: task.id });
  assert.equal(saved.dismissed, true);
  assert.equal(saved.historyRevision, 1);
  assert.equal(journal.get(task.id).dismissed, true);
  assert.equal(journal.get(task.id).items.length, 1);
  assert.equal(await readFile(path.join(view.root, 'hello.txt'), 'utf8'), '<script>not executable</script>\n你好');
  await access(path.join(view.root, 'folder/hello.txt'));
  await view.reloadClient();
  assert.equal(nodes(view.renderer, { 'data-fm-task-id': task.id, 'data-fm-task-status': 'completed' }).length, 0);
});

test('real transfer dismissal survives a fresh Client load and retains the uploaded file', async t => {
  let journal = [];
  const view = await setup(t, { tasks: true, transfers: true, transferOptions: { persistTasks: async records => { journal = structuredClone(records); } } });
  const task = await uploadText(view);
  assert.equal(task.canDismiss, true);
  await view.click({ 'data-fm-history-action': 'dismiss', 'data-fm-history-kind': 'transfer', 'data-fm-history-id': task.id });
  assert.equal(view.transfers.get(task.id).dismissed, true);
  assert.equal(journal.find(record => record.id === task.id).historyRevision, 1);
  assert.equal(journal.find(record => record.id === task.id).items.length, 1);
  assert.equal(await readFile(path.join(view.root, 'history-upload.txt'), 'utf8'), 'upload history');
  await view.reloadClient();
  assert.equal(nodes(view.renderer, { 'data-fm-transfer-id': task.id, 'data-fm-transfer-status': 'completed' }).length, 0);
});

test('real mixed history clearing retains a failed-persistence card while closing successful records', async t => {
  const view = await setup(t, { tasks: true, transfers: true, taskOptions: { persistTask: async record => {
    if (record.dismissed) throw Object.assign(new Error('Injected history persistence failure'), { code: 'ENOSPC' });
  } } });
  const task = await copyHello(view);
  const transfer = await uploadText(view);
  await view.click({ 'data-fm-history-action': 'clear' });
  assert.equal((await view.tasks.get({ taskId: task.id })).dismissed, false);
  assert.equal(view.transfers.get(transfer.id).dismissed, true);
  assert.equal(nodes(view.renderer, { 'data-fm-task-id': task.id, 'data-fm-task-status': 'completed' }).length, 1);
  assert.equal(nodes(view.renderer, { 'data-fm-transfer-id': transfer.id, 'data-fm-transfer-status': 'completed' }).length, 0);
  assert.ok(textOf(node(view.renderer, { 'data-fm-history-errors': true })).includes(task.id));
  await access(path.join(view.root, 'hello.txt'));
  await access(path.join(view.root, 'history-upload.txt'));
});
