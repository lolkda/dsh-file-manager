import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createControlHandler } from '../dist/index.js';
import { createManager } from '../dist/host/manager.js';
import { createTaskService } from '../dist/host/tasks.js';
import { createTransferService } from '../dist/host/transfers.js';

const request = payload => new Request('http://localhost/api/file-manager/v2/control', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-history-api-'));
  const manager = createManager();
  let tasks; let transfers;
  t.after(async () => {
    const errors = [];
    for (const cleanup of [() => transfers?.close(), () => tasks?.close(), () => manager.close(), () => rm(root, { recursive: true, force: true })]) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'History fixture cleanup failed.');
  });
  const grant = await manager.addRoot({ path: root });
  const ref = value => ({ rootId: grant.id, path: value });
  const source = await manager.createFile({ ...ref('source.txt'), text: 'do not delete or re-run this file\n' });
  await manager.createDirectory(ref('destination'));
  const destination = await manager.stat(ref('destination'));
  const checkpoint = { targetParent: { ...ref('destination'), identity: destination.identity }, removed: ['source/previous-item'] };
  const savedTasks = new Map();
  const savedTransfers = new Map();
  let rejectTaskSave = false;
  tasks = createTaskService({ manager,
    initialTasks: [{ id: 'stopped-copy', operation: 'copy', destination: ref('destination'), status: 'failed', conflict: 'skip', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', items: [{ id: 'copy-item', source: { ...ref('source.txt'), expectedVersion: source.version }, destination: ref('destination/source.txt'), status: 'failed', attempts: 1, checkpoint, error: { code: 'RECOVERY_REQUIRED', message: 'Retain the recovery proof.' } }] }],
    async persistTask(record) {
      if (rejectTaskSave) throw Object.assign(new Error('injected storage failure'), { code: 'EIO' });
      savedTasks.set(record.id, structuredClone(record));
    },
  });
  await tasks.list();
  transfers = createTransferService({ manager, async persistTasks(records) { for (const record of records) savedTransfers.set(record.id, structuredClone(record)); } });
  const completed = await transfers.begin({ direction: 'download', ...ref('source.txt') });
  const downloaded = await transfers.handleDownload(new Request(`http://localhost/api/file-manager/v2/download?taskId=${completed.id}`));
  assert.equal(await downloaded.text(), 'do not delete or re-run this file\n');
  const queued = await transfers.begin({ direction: 'download', ...ref('source.txt') });
  const control = createControlHandler({ manager, tasks, transfers, workspaces: () => [] });
  const call = payload => control(request({ requestId: randomUUID(), ...payload }));
  const item = (kind, taskId, expectedHistoryRevision = 0) => ({ kind, taskId, expectedHistoryRevision });
  return { root, manager, tasks, transfers, completed, queued, call, control, item, savedTasks, savedTransfers, checkpoint, rejectTaskSave: () => { rejectTaskSave = true; } };
}

test('bootstrap advertises task-history actions only when composed services implement them', async t => {
  const f = await fixture(t);
  assert.equal((await (await f.call({ op: 'bootstrap' })).json()).value.capabilities.taskHistory, true);
  const readOnly = createControlHandler({ manager: f.manager, workspaces: () => [] });
  assert.equal((await (await readOnly(request({ op: 'bootstrap' }))).json()).value.capabilities.taskHistory, false);
});

test('closing a download through the API returns a bounded receipt and leaves its file intact', async t => {
  const f = await fixture(t);
  const response = await f.call({ op: 'activities.dismiss', items: [f.item('transfer', f.completed.id)] });
  assert.equal(response.status, 200);
  const { results } = (await response.json()).value;
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'dismissed');
  assert.deepEqual(Object.keys(results[0].task).sort(), ['canDismiss', 'dismissed', 'historyRevision', 'id', 'status']);
  assert.equal(results[0].task.dismissed, true);
  assert.equal(results[0].task.historyRevision, 1);
  assert.equal(f.transfers.get(f.completed.id).dismissed, true);
  assert.equal(f.savedTransfers.get(f.completed.id).dismissed, true);
  assert.equal(await readFile(path.join(f.root, 'source.txt'), 'utf8'), 'do not delete or re-run this file\n');
  assert.equal(f.transfers.get(f.queued.id).status, 'queued');
});

test('batch closing reports each rejection without cancelling active work or dropping recovery proofs', async t => {
  const f = await fixture(t);
  const response = await f.call({ op: 'activities.dismiss', items: [f.item('task', 'stopped-copy'), f.item('transfer', f.queued.id), f.item('transfer', 'not-a-task'), f.item('transfer', f.completed.id)] });
  assert.equal(response.status, 200);
  const { results } = (await response.json()).value;
  assert.deepEqual(results.map(result => result.outcome), ['dismissed', 'rejected', 'rejected', 'dismissed']);
  assert.equal(results[1].error.code, 'TASK_BUSY');
  assert.equal(results[2].error.code, 'TASK_NOT_FOUND');
  assert.equal(f.transfers.get(f.queued.id).status, 'queued');
  assert.deepEqual(f.savedTasks.get('stopped-copy').items[0].checkpoint, f.checkpoint);
  assert.equal((await f.tasks.get({ taskId: 'stopped-copy' })).dismissed, true);
  assert.equal('checkpoint' in (await f.tasks.get({ taskId: 'stopped-copy' })).items[0], false, 'small public receipts must not leak private recovery state');
});

test('all batch descriptors are validated before any record is closed', async t => {
  const f = await fixture(t);
  const good = f.item('transfer', f.completed.id);
  const invalid = [
    { kind: 'disk-file', taskId: f.completed.id, expectedHistoryRevision: 0 },
    { ...good, expectedHistoryRevision: -1 },
    { ...good, expectedHistoryRevision: 0.5 },
    { ...good, taskId: '' },
    { ...good, path: '/must-not-be-consumed' },
  ];
  for (const item of invalid) {
    const response = await f.call({ op: 'activities.dismiss', items: [good, item] });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
    assert.notEqual(f.transfers.get(f.completed.id).dismissed, true);
  }
});

test('oversized and duplicate close batches are rejected without partial effects', async t => {
  const f = await fixture(t);
  const good = f.item('transfer', f.completed.id);
  const oversized = await f.call({ op: 'activities.dismiss', items: Array.from({ length: 257 }, (_, index) => ({ ...good, taskId: `task-${index}` })) });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, 'TOO_LARGE');
  const duplicate = await f.call({ op: 'activities.dismiss', items: [good, good] });
  assert.equal(duplicate.status, 400);
  assert.notEqual(f.transfers.get(f.completed.id).dismissed, true);
});

test('close request ids protect retries from repeated or conflicting metadata mutations', async t => {
  const f = await fixture(t);
  const payload = { op: 'activities.dismiss', items: [f.item('transfer', f.completed.id)] };
  const absent = await f.control(request(payload));
  assert.equal(absent.status, 400);
  assert.notEqual(f.transfers.get(f.completed.id).dismissed, true);
  const accepted = { ...payload, requestId: 'history-close-request' };
  const first = await f.control(request(accepted));
  assert.equal(first.status, 200);
  const receipt = await first.json();
  assert.deepEqual(await (await f.control(request(accepted))).json(), receipt);
  assert.equal(f.transfers.get(f.completed.id).historyRevision, 1);
  const reused = await f.control(request({ ...accepted, items: [f.item('task', 'stopped-copy')] }));
  assert.equal(reused.status, 409);
  assert.equal((await reused.json()).error.code, 'REQUEST_ID_REUSED');
});

test('a stale close action cannot hide a newly retried and completed download', async t => {
  const f = await fixture(t);
  await f.transfers.retry(f.completed.id);
  await (await f.transfers.handleDownload(new Request(`http://localhost/api/file-manager/v2/download?taskId=${f.completed.id}`))).text();
  const response = await f.call({ op: 'activities.dismiss', items: [f.item('transfer', f.completed.id, 0)] });
  assert.equal(response.status, 200);
  const result = (await response.json()).value.results[0];
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.error.code, 'TASK_CHANGED');
  assert.notEqual(f.transfers.get(f.completed.id).dismissed, true);
});

test('one persistence failure leaves that record visible while independent closes succeed', async t => {
  const f = await fixture(t);
  f.rejectTaskSave();
  const response = await f.call({ op: 'activities.dismiss', items: [f.item('task', 'stopped-copy'), f.item('transfer', f.completed.id)] });
  assert.equal(response.status, 200);
  const { results } = (await response.json()).value;
  assert.equal(results[0].outcome, 'rejected');
  assert.equal(results[1].outcome, 'dismissed');
  assert.notEqual((await f.tasks.get({ taskId: 'stopped-copy' })).dismissed, true);
  assert.notEqual(f.savedTasks.get('stopped-copy').dismissed, true);
  assert.equal(f.transfers.get(f.completed.id).dismissed, true);
});
