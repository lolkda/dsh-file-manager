import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createManager } from '../dist/host/manager.js';
import { createTransferService } from '../dist/host/transfers.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, options = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-transfer-history-'));
  const root = path.join(base, 'root');
  const journal = path.join(base, 'history.json');
  await mkdir(root);
  const manager = createManager();
  const grant = await manager.addRoot({ path: root });
  const services = [];
  const writes = [];
  const progress = [];
  const persistTasks = async records => {
    await options.beforePersist?.(records);
    await writeFile(journal, JSON.stringify(records));
    writes.push(structuredClone(records));
  };
  const create = (initialTasks = []) => {
    const service = createTransferService({
      manager, initialTasks, persistTasks,
      onProgress(task) { progress.push(task); options.onProgress?.(task); },
    });
    services.push(service);
    return service;
  };
  t.after(async () => {
    try { await Promise.all(services.map(service => service.close())); }
    finally { try { await manager.close(); } finally { await rm(base, { recursive: true, force: true }); } }
  });
  return { root, journal, manager, grant, service: create(), create, writes, progress,
    readJournal: async () => JSON.parse(await readFile(journal, 'utf8')) };
}

const upload = (fixture, items = [{ path: 'file.bin', kind: 'file', size: 4 }]) => fixture.service.begin({ direction: 'upload', rootId: fixture.grant.id, path: '', items });
const uploadRequest = (task, item = task.items[0], body = 'data', signal) => new Request(`http://local/api/file-manager/v2/upload?taskId=${task.id}&itemId=${item.id}`, { method: 'POST', body, duplex: 'half', signal });
const downloadRequest = task => new Request(`http://local/api/file-manager/v2/download?taskId=${task.id}`);
const requireDismiss = service => assert.equal(typeof service.dismiss, 'function', 'transfer history dismissal is not implemented');
const hide = (service, task) => service.dismiss({ taskId: task.id, expectedHistoryRevision: task.historyRevision });
async function completedUpload(f) {
  const task = await upload(f);
  const response = await f.service.handleUpload(uploadRequest(task));
  assert.equal(response.status, 200);
  return f.service.get(task.id);
}

// A public canDismiss projection must never become persisted task authority.
test('new transfer records expose history defaults without persisting derived eligibility', async t => {
  const f = await fixture(t);
  const task = await upload(f);
  assert.equal(task.dismissed, false);
  assert.equal(task.historyRevision, 0);
  assert.equal(task.canDismiss, false);
  const [saved] = await f.readJournal();
  assert.equal(saved.dismissed, false);
  assert.equal(saved.historyRevision, 0);
  assert.equal(Object.hasOwn(saved, 'canDismiss'), false);
  task.dismissed = true; task.historyRevision = 99; task.canDismiss = true;
  assert.equal(f.service.get(task.id).dismissed, false);
  assert.equal(f.service.list()[0].historyRevision, 0);
});

test('dismissing a completed upload changes only durable history metadata', async t => {
  const f = await fixture(t);
  requireDismiss(f.service);
  const task = await completedUpload(f);
  assert.equal(task.canDismiss, true);
  const hidden = await hide(f.service, task);
  assert.equal(hidden.dismissed, true);
  assert.equal(hidden.historyRevision, 1);
  assert.equal(hidden.canDismiss, false);
  assert.equal(hidden.status, 'completed');
  assert.deepEqual(hidden.items, task.items);
  assert.equal(await readFile(path.join(f.root, 'file.bin'), 'utf8'), 'data');
  assert.deepEqual(await readdir(f.root), ['file.bin']);
  assert.equal(f.service.list().length, 1, 'dismissal must retain the record rather than delete it');
  assert.equal((await f.readJournal())[0].dismissed, true);
});

for (const kind of ['file', 'zip']) test(`a completed ${kind} download becomes dismissible only after its response finishes`, async t => {
  const f = await fixture(t);
  requireDismiss(f.service);
  await mkdir(path.join(f.root, 'tree'));
  await mkdir(path.join(f.root, 'tree/empty'));
  await writeFile(path.join(f.root, 'tree/file'), Buffer.from([0, 255, 4]));
  const task = await f.service.begin({ direction: 'download', rootId: f.grant.id, path: kind === 'file' ? 'tree/file' : 'tree' });
  const response = await f.service.handleDownload(downloadRequest(task));
  assert.equal(f.service.get(task.id).canDismiss, false);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (kind === 'zip') assert.equal(bytes.readUInt16LE(), 0x4b50);
  else assert.deepEqual(bytes, Buffer.from([0, 255, 4]));
  const ended = f.service.get(task.id);
  assert.equal(ended.canDismiss, true);
  assert.equal(f.progress.at(-1).canDismiss, true, 'native downloads need a final observable eligibility transition');
  const hidden = await hide(f.service, ended);
  assert.equal(hidden.dismissed, true);
  assert.equal(hidden.completion, 'server-stream-finished');
  assert.equal(hidden.items.every(item => !item.committed), true);
  assert.deepEqual(await readFile(path.join(f.root, 'tree/file')), Buffer.from([0, 255, 4]));
});

test('failed uploads may be hidden without discarding their failure or published-result evidence', async t => {
  const f = await fixture(t);
  requireDismiss(f.service);
  const task = await upload(f);
  const response = await f.service.handleUpload(uploadRequest(task, task.items[0], 'bad'));
  assert.equal(response.status, 400);
  const failed = f.service.get(task.id);
  assert.equal(failed.canDismiss, true);
  const hidden = await hide(f.service, failed);
  assert.equal(hidden.status, 'failed');
  assert.deepEqual(hidden.items[0].error, failed.items[0].error);
  assert.equal(hidden.items[0].committed, false);
  assert.deepEqual(await readdir(f.root), []);
});

test('queued transfers reject dismissal without cancelling pending work', async t => {
  const f = await fixture(t);
  requireDismiss(f.service);
  const task = await upload(f);
  await assert.rejects(hide(f.service, task), { code: 'TASK_BUSY' });
  assert.equal(f.service.get(task.id).status, 'queued');
  assert.equal(f.service.get(task.id).items[0].status, 'pending');
  assert.equal(f.service.get(task.id).dismissed, false);
});

test('legacy interrupted records default history fields and retain every private recovery field', async t => {
  const f = await fixture(t);
  requireDismiss(f.service);
  await completedUpload(f);
  const [raw] = await f.readJournal();
  delete raw.dismissed; delete raw.historyRevision;
  raw.canDismiss = true;
  raw.status = 'running'; raw.items[0].status = 'running';
  raw.privateCheckpoint = { phase: 'published', destination: { version: 'keep-full-proof' }, removed: [] };
  raw.items[0].privateReceipt = { sha256: raw.items[0].sha256, detail: ['do', 'not', 'strip'] };
  await f.service.close();
  const restored = f.create([raw]);
  const interrupted = restored.get(raw.id);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.dismissed, false);
  assert.equal(interrupted.historyRevision, 0);
  assert.equal(interrupted.canDismiss, true);
  await hide(restored, interrupted);
  const [saved] = await f.readJournal();
  assert.deepEqual(saved.privateCheckpoint, raw.privateCheckpoint);
  assert.deepEqual(saved.items[0].privateReceipt, raw.items[0].privateReceipt);
  assert.equal(Object.hasOwn(saved, 'canDismiss'), false);
});

test('dismissal is revision checked and idempotent only after the hidden record is published', async t => {
  const f = await fixture(t);
  requireDismiss(f.service);
  const task = await completedUpload(f);
  const writes = f.writes.length;
  for (const expectedHistoryRevision of [undefined, -1, 0.5, '0', 1]) {
    await assert.rejects(f.service.dismiss({ taskId: task.id, expectedHistoryRevision }), { code: 'TASK_CHANGED' });
  }
  assert.equal(f.writes.length, writes);
  const hidden = await hide(f.service, task);
  const again = await f.service.dismiss({ taskId: task.id, expectedHistoryRevision: 999 });
  assert.deepEqual(again, hidden);
  assert.equal(f.writes.length, writes + 1);
  assert.equal(again.historyRevision, 1);
});

test('failed dismissal persistence retains the preceding raw receipt and remains retryable', async t => {
  let deny = false;
  const f = await fixture(t, { beforePersist: async records => {
    if (deny && records.some(record => record.dismissed)) throw Object.assign(new Error('journal full'), { code: 'ENOSPC' });
  } });
  requireDismiss(f.service);
  const task = await completedUpload(f);
  const before = await f.readJournal();
  deny = true;
  await assert.rejects(hide(f.service, task), { code: 'ENOSPC' });
  assert.deepEqual(await f.readJournal(), before);
  assert.deepEqual(f.service.get(task.id), task);
  deny = false;
  assert.equal((await hide(f.service, task)).dismissed, true);
});

test('malformed persisted history flags are rejected rather than silently defaulted', async t => {
  const f = await fixture(t);
  await completedUpload(f);
  const [raw] = await f.readJournal();
  for (const patch of [{ dismissed: 'false' }, { dismissed: null }, { historyRevision: -1 }, { historyRevision: 1.5 }, { historyRevision: null }, { historyRevision: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => f.create([{ ...raw, ...patch }]), { code: 'INVALID_STATE' });
  }
});

test('history revisions cannot overflow on dismissal or retry acceptance', async t => {
  const f = await fixture(t);
  requireDismiss(f.service);
  await completedUpload(f);
  const [raw] = await f.readJournal();
  raw.historyRevision = Number.MAX_SAFE_INTEGER;
  await f.service.close();
  const restored = f.create([raw]);
  const before = restored.get(raw.id);
  await assert.rejects(hide(restored, before), { code: 'HISTORY_REVISION_EXHAUSTED' });
  await assert.rejects(restored.retry(raw.id), { code: 'HISTORY_REVISION_EXHAUSTED' });
  assert.deepEqual(restored.get(raw.id), before);
});

const outcome = promise => promise.then(value => ({ value }), error => ({ error }));

test('cancelled status cannot hide or retry a transfer while its final cancellation receipt is pending', { timeout: 5000 }, async t => {
  const started = deferred(); const tail = deferred(); const release = deferred();
  let cancellationWrites = 0;
  const f = await fixture(t, {
    onProgress(task) { if (task.bytesTransferred) started.resolve(); },
    async beforePersist(records) {
      if (records[0].status === 'cancelled' && ++cancellationWrites === 2) { tail.resolve(); await release.promise; }
    },
  });
  const task = await upload(f);
  const sending = f.service.handleUpload(uploadRequest(task, task.items[0], new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('ab')); } })));
  await started.promise;
  const cancelling = f.service.cancel(task.id);
  await tail.promise;
  await sending; // The stream has left inFlight, but cancel() still owes its last persist.
  const during = f.service.get(task.id);
  const dismissing = outcome(hide(f.service, during));
  const retrying = outcome(f.service.retry(task.id));
  release.resolve();
  const cancelled = await cancelling;
  const [dismissed, retried] = await Promise.all([dismissing, retrying]);
  assert.equal(during.status, 'cancelled');
  assert.equal(during.canDismiss, false);
  assert.equal(dismissed.error?.code, 'TASK_BUSY');
  assert.equal(retried.error?.code, 'TASK_BUSY');
  assert.equal(cancelled.canDismiss, true);
  assert.equal(f.progress.at(-1).canDismiss, true);
  assert.equal((await hide(f.service, f.service.get(task.id))).dismissed, true);
  assert.deepEqual(await readdir(f.root), []);
});

test('a terminal download remains ineligible until its final stream receipt is durable', { timeout: 5000 }, async t => {
  const entered = deferred(); const release = deferred();
  const f = await fixture(t, { async beforePersist(records) {
    if (records[0].direction === 'download' && records[0].status === 'completed') { entered.resolve(); await release.promise; }
  } });
  await writeFile(path.join(f.root, 'file'), 'data');
  const task = await f.service.begin({ direction: 'download', rootId: f.grant.id, path: 'file' });
  const response = await f.service.handleDownload(downloadRequest(task));
  const reading = response.arrayBuffer();
  await entered.promise;
  try {
    const during = f.service.get(task.id);
    assert.equal(during.status, 'completed');
    assert.equal(during.canDismiss, false);
    await assert.rejects(hide(f.service, during), { code: 'TASK_BUSY' });
  } finally { release.resolve(); await reading; }
  assert.equal(f.service.get(task.id).canDismiss, true);
});

test('pending dismissal excludes retry and cancel until its hidden revision is published', { timeout: 5000 }, async t => {
  const entered = deferred(); const release = deferred();
  const f = await fixture(t, { async beforePersist(records) {
    if (records.some(record => record.dismissed)) { entered.resolve(); await release.promise; }
  } });
  const task = await completedUpload(f);
  const dismissing = hide(f.service, task);
  await entered.promise;
  const before = f.service.get(task.id);
  const retrying = outcome(f.service.retry(task.id));
  const cancelling = outcome(f.service.cancel(task.id));
  release.resolve();
  const hidden = await dismissing;
  const [retried, cancelled] = await Promise.all([retrying, cancelling]);
  assert.equal(before.dismissed, false);
  assert.equal(before.canDismiss, false);
  assert.equal(retried.error?.code, 'TASK_BUSY');
  assert.equal(cancelled.error?.code, 'TASK_BUSY');
  assert.equal(hidden.dismissed, true);
  assert.equal(f.service.get(task.id).dismissed, true);
  assert.equal((await f.readJournal())[0].historyRevision, 1);
});

test('an accepted retry reopens hidden history and rejects callbacks from every older generation', { timeout: 5000 }, async t => {
  const entered = deferred(); const release = deferred();
  let pauseRetry = false;
  const f = await fixture(t, { async beforePersist(records) {
    if (pauseRetry && records[0].historyRevision === 2 && !records[0].dismissed) { entered.resolve(); await release.promise; }
  } });
  const original = await upload(f);
  await f.service.handleUpload(uploadRequest(original, original.items[0], 'bad'));
  const failed = f.service.get(original.id);
  const hidden = await hide(f.service, failed);
  assert.equal(hidden.historyRevision, 1);
  pauseRetry = true;
  const retrying = f.service.retry(original.id);
  await entered.promise;
  try {
    assert.equal(f.service.get(original.id).dismissed, true, 'retry is unpublished until persistence succeeds');
    await assert.rejects(hide(f.service, hidden), { code: 'TASK_BUSY' });
  } finally { release.resolve(); }
  const retry = await retrying;
  pauseRetry = false;
  assert.equal(retry.dismissed, false); assert.equal(retry.historyRevision, 2);
  await assert.rejects(hide(f.service, hidden), { code: 'TASK_CHANGED' });
  await f.service.handleUpload(uploadRequest(retry));
  const completed = f.service.get(retry.id);
  assert.equal(completed.canDismiss, true);
  await assert.rejects(hide(f.service, failed), { code: 'TASK_CHANGED' });
  assert.equal((await hide(f.service, completed)).historyRevision, 3);
});

test('failed retry persistence cannot clear a previously durable dismissal marker', async t => {
  let deny = false;
  const f = await fixture(t, { async beforePersist(records) {
    if (deny && records[0].historyRevision === 2) throw Object.assign(new Error('journal full'), { code: 'ENOSPC' });
  } });
  const task = await upload(f);
  await f.service.handleUpload(uploadRequest(task, task.items[0], 'bad'));
  const hidden = await hide(f.service, f.service.get(task.id));
  const raw = await f.readJournal();
  deny = true;
  await assert.rejects(f.service.retry(task.id), { code: 'ENOSPC' });
  assert.deepEqual(f.service.get(task.id), hidden);
  assert.deepEqual(await f.readJournal(), raw);
});

test('service close drains an accepted history write and refuses new dismissals', { timeout: 5000 }, async t => {
  const entered = deferred(); const release = deferred();
  const f = await fixture(t, { async beforePersist(records) {
    if (records[0].dismissed) { entered.resolve(); await release.promise; }
  } });
  const task = await completedUpload(f);
  const dismissing = hide(f.service, task);
  await entered.promise;
  let stopped = false;
  const closing = f.service.close().then(() => { stopped = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    await assert.rejects(hide(f.service, task), { code: 'SERVICE_STOPPED' });
  } finally { release.resolve(); }
  await Promise.all([dismissing, closing]);
  const saved = await f.readJournal();
  assert.equal(saved[0].dismissed, true);
  const reopened = f.create(saved);
  assert.equal(reopened.get(task.id).dismissed, true);
  assert.equal(reopened.get(task.id).historyRevision, 1);
  assert.equal(reopened.get(task.id).canDismiss, false);
  assert.equal(await readFile(path.join(f.root, 'file.bin'), 'utf8'), 'data');
});

test('concurrent dismissal attempts cannot publish two history revisions', { timeout: 5000 }, async t => {
  const entered = deferred(); const release = deferred();
  const f = await fixture(t, { async beforePersist(records) {
    if (records[0].dismissed) { entered.resolve(); await release.promise; }
  } });
  const task = await completedUpload(f);
  const first = hide(f.service, task);
  await entered.promise;
  try { await assert.rejects(hide(f.service, task), { code: 'TASK_BUSY' }); }
  finally { release.resolve(); }
  assert.equal((await first).historyRevision, 1);
  assert.equal(f.writes.filter(records => records[0].dismissed).length, 1);
});

test('closing one record retains unrelated private records and excludes every derived field from storage', async t => {
  const f = await fixture(t);
  for (const name of ['a', 'b']) {
    const task = await upload(f, [{ path: name, kind: 'file', size: 4 }]);
    await f.service.handleUpload(uploadRequest(task));
  }
  const raw = await f.readJournal();
  raw[0].recoveryProof = { source: ['keep', 'all'], checkpoint: { phase: 'published' } };
  raw[1].privateContext = { version: 'opaque', metadata: [1, 2, 3] };
  raw[1].items[0].privateCheckpoint = { identity: 'must-survive', removed: [] };
  await f.service.close();
  const restored = f.create(raw);
  await hide(restored, restored.get(raw[0].id));
  const saved = await f.readJournal();
  assert.deepEqual(saved[0].recoveryProof, raw[0].recoveryProof);
  assert.deepEqual(saved[1], raw[1]);
  assert.equal(saved.some(record => Object.hasOwn(record, 'canDismiss')), false);
});
