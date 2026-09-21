import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createManager } from '../host/manager.js';

const implementation = await import('../host/transfers.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('/host/transfers.js')) return {};
  throw error;
});

async function fixture(t, options = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-transfer-'));
  const root = path.join(base, 'root');
  await mkdir(root);
  const manager = createManager();
  let service;
  t.after(async () => { await service?.close(); await manager.close(); await rm(base, { recursive: true, force: true }); });
  const grant = await manager.addRoot({ path: root });
  assert.equal(typeof implementation.createTransferService, 'function', 'createTransferService must be implemented');
  service = implementation.createTransferService({ manager: options.wrapManager ? options.wrapManager(manager) : manager, ...options });
  return { base, root, manager, grant, service };
}

// Removing parent inference would lose empty ancestors and undercount the entry limit.
test('upload manifests preserve explicit empty directories and infer missing ancestors', async t => {
  const { service, grant, root } = await fixture(t);
  const task = await service.begin({
    direction: 'upload', rootId: grant.id, path: '',
    items: [{ path: '资料/笔记.txt', kind: 'file', size: 6 }, { path: '资料/空目录', kind: 'directory' }],
  });
  assert.equal(task.type, 'transfer');
  assert.equal(task.status, 'queued');
  assert.equal(task.bytesTotal, 6);
  assert.equal(task.itemsTotal, 3);
  assert.deepEqual(task.items.map(item => [item.path, item.kind, item.status, item.committed]), [
    ['资料', 'directory', 'pending', false],
    ['资料/笔记.txt', 'file', 'pending', false],
    ['资料/空目录', 'directory', 'pending', false],
  ]);
  assert.equal(new Set(task.items.map(item => item.id)).size, 3);
  assert.deepEqual(await readdir(root), [], 'manifest creation must not publish files or directories');
  task.items[0].status = 'completed';
  assert.equal(service.get(task.id).items[0].status, 'pending', 'callers must not mutate stored task state');
});

const uploadInput = (grant, items = [{ path: 'file.bin', kind: 'file', size: 4 }]) => ({ direction: 'upload', rootId: grant.id, path: '', items });

// Removing path validation would admit traversal, duplicate aliases or file ancestors.
test('manifest validation rejects unsafe paths and contradictory entries before accepting a task', async t => {
  const { service, grant, root } = await fixture(t);
  for (const badPath of ['../escape', '/absolute', 'a//b', 'a/./b', 'a/../b', 'C:drive', 'a\\b', 'bad\u0000name', '']) {
    await assert.rejects(service.begin(uploadInput(grant, [{ path: badPath, kind: 'file', size: 1 }])), { code: 'INVALID_PATH' }, JSON.stringify(badPath));
  }
  await assert.rejects(service.begin(uploadInput(grant, [{ path: 'a', kind: 'file', size: 0 }, { path: 'a/b', kind: 'file', size: 0 }])), { code: 'INVALID_MANIFEST' });
  await assert.rejects(service.begin(uploadInput(grant, [{ path: 'a', kind: 'file', size: 0 }, { path: 'a', kind: 'file', size: 0 }])), { code: 'INVALID_MANIFEST' });
  await assert.rejects(service.begin(uploadInput(grant, [{ path: 'link', kind: 'symlink', size: 0 }])), { code: 'UNSUPPORTED_ENTRY' });
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(service.list(), []);
});

// Limits must be Host-enforced even if browser hints and manifest totals are forged.
test('configured file, aggregate and inferred-entry limits reject oversized manifests', async t => {
  const { service, grant } = await fixture(t, { limits: { maxFileBytes: 4, maxTaskBytes: 6, maxTaskEntries: 3 } });
  await assert.rejects(service.begin(uploadInput(grant, [{ path: 'large', kind: 'file', size: 5 }])), { code: 'TOO_LARGE' });
  await assert.rejects(service.begin(uploadInput(grant, [{ path: 'a', kind: 'file', size: 4 }, { path: 'b', kind: 'file', size: 3 }])), { code: 'TOO_LARGE' });
  await assert.rejects(service.begin(uploadInput(grant, [{ path: 'a/b/c/d', kind: 'file', size: 0 }])), { code: 'TOO_LARGE' });
  for (const size of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
    await assert.rejects(service.begin(uploadInput(grant, [{ path: 'bad', kind: 'file', size }])), { code: 'INVALID_MANIFEST' });
  }
  assert.equal((await service.begin(uploadInput(grant, [{ path: 'a/b', kind: 'file', size: 4 }]))).bytesTotal, 4);
});

// Removing explicit overwrite authorization must make this test fail.
test('manifest overwrites require a file version and never allow directory merges', async t => {
  const { service, grant } = await fixture(t);
  await assert.rejects(service.begin(uploadInput(grant, [{ path: 'file', kind: 'file', size: 0, conflict: 'overwrite' }])), { code: 'VERSION_REQUIRED' });
  await assert.rejects(service.begin(uploadInput(grant, [{ path: 'folder', kind: 'directory', conflict: 'overwrite', expectedVersion: 'v' }])), { code: 'INVALID_MANIFEST' });
  await assert.rejects(service.begin(uploadInput(grant, [{ path: 'file', kind: 'file', size: 0, conflict: 'merge' }])), { code: 'INVALID_MANIFEST' });
});

// An unpersisted begin must not become a usable phantom task.
test('task control persists boundaries and reports cancellation without fake commits', async t => {
  const persisted = [];
  const progress = [];
  const { service, grant } = await fixture(t, {
    persistTasks: async tasks => { persisted.push(structuredClone(tasks)); },
    onProgress: task => progress.push(task),
  });
  const task = await service.control({ op: 'transfers.begin', ...uploadInput(grant) });
  assert.equal(persisted.at(-1)[0].id, task.id);
  const cancelled = await service.control({ op: 'transfers.cancel', taskId: task.id });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.items[0].status, 'cancelled');
  assert.equal(cancelled.items[0].committed, false);
  assert.equal(persisted.at(-1)[0].status, 'cancelled');
  assert.equal(progress.at(-1).status, 'cancelled');
  assert.deepEqual(await service.control({ op: 'transfers.list' }), [cancelled]);
  assert.deepEqual(await service.control({ op: 'transfers.get', taskId: task.id }), cancelled);
});

test('failed initial task persistence refuses acceptance', async t => {
  const { service, grant } = await fixture(t, { persistTasks: async () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); } });
  await assert.rejects(service.begin(uploadInput(grant)), { code: 'ENOSPC' });
  assert.deepEqual(service.list(), []);
});

test('closing the service cancels queued tasks and rejects new uploads', async t => {
  const { service, grant } = await fixture(t);
  const task = await service.begin(uploadInput(grant));
  await service.close();
  assert.equal(service.get(task.id).status, 'cancelled');
  await assert.rejects(service.begin(uploadInput(grant)), { code: 'SERVICE_STOPPED' });
});

test('restored unfinished tasks are interrupted rather than advertised as resumed', async t => {
  const first = await fixture(t);
  const queued = await first.service.begin(uploadInput(first.grant));
  const second = await fixture(t, { initialTasks: [queued] });
  const restored = second.service.get(queued.id);
  assert.equal(restored.status, 'interrupted');
  assert.equal(restored.items[0].status, 'failed');
  assert.equal(restored.items[0].error.code, 'INTERRUPTED');
  assert.equal(restored.items[0].committed, false);
});

function uploadRequest(task, item, body = null, signal) {
  return new Request(`http://local/api/file-manager/upload?taskId=${task.id}&itemId=${item.id}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body, duplex: 'half', signal,
  });
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const reply = async response => ({ status: response.status, ...await response.json() });
const fileItem = task => task.items.find(item => item.kind === 'file');

// Transforming uploads as text, buffering incomplete content into its destination,
// or automatically unpacking ZIP uploads would each violate these byte assertions.
test('raw upload publishes exact binary ZIP bytes without extracting them', async t => {
  const { service, grant, root } = await fixture(t);
  assert.equal(typeof service.handleUpload, 'function', 'the raw upload endpoint must exist');
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 255, 254, 128, 13, 10]);
  const task = await service.begin(uploadInput(grant, [{ path: '档案.zip', kind: 'file', size: bytes.length }]));
  const result = await reply(await service.handleUpload(uploadRequest(task, task.items[0], bytes)));
  assert.equal(result.status, 200);
  assert.equal(result.value.status, 'completed');
  assert.equal(result.value.items[0].committed, true);
  assert.deepEqual(await readFile(path.join(root, '档案.zip')), bytes);
  assert.deepEqual(await readdir(root), ['档案.zip']);
  await writeFile(path.join(root, '档案.zip'), 'later change');
  const duplicate = await reply(await service.handleUpload(uploadRequest(task, task.items[0], bytes)));
  assert.equal(duplicate.status, 200);
  assert.equal(await readFile(path.join(root, '档案.zip'), 'utf8'), 'later change', 'duplicate POST must not write twice');
});

test('a child upload creates task-owned ancestors and preserves an explicit empty directory', async t => {
  const { service, grant, root } = await fixture(t);
  assert.equal(typeof service.handleUpload, 'function');
  const task = await service.begin(uploadInput(grant, [{ path: 'tree/deep/data', kind: 'file', size: 3 }, { path: 'tree/empty', kind: 'directory' }]));
  const response = await reply(await service.handleUpload(uploadRequest(task, fileItem(task), Buffer.from('abc'))));
  assert.equal(response.ok, true);
  const empty = task.items.find(item => item.path === 'tree/empty');
  const finished = await reply(await service.handleUpload(uploadRequest(task, empty)));
  assert.equal(finished.value.status, 'completed');
  assert.equal(await readFile(path.join(root, 'tree/deep/data'), 'utf8'), 'abc');
  assert.deepEqual(await readdir(path.join(root, 'tree/empty')), []);
  assert.deepEqual((await readdir(root)).sort(), ['tree']);
});

test('existing manifest directories are not silently merged even when descendants are absent', async t => {
  const { service, grant, root } = await fixture(t);
  assert.equal(typeof service.handleUpload, 'function');
  await mkdir(path.join(root, 'existing'));
  const task = await service.begin(uploadInput(grant, [{ path: 'existing/new', kind: 'file', size: 1 }]));
  const response = await reply(await service.handleUpload(uploadRequest(task, fileItem(task), 'a')));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'ALREADY_EXISTS');
  assert.deepEqual(await readdir(path.join(root, 'existing')), []);
});

test('skipping a conflicting directory skips its whole subtree without merging', async t => {
  const { service, grant, root } = await fixture(t);
  assert.equal(typeof service.handleUpload, 'function');
  await mkdir(path.join(root, 'existing'));
  const task = await service.begin(uploadInput(grant, [{ path: 'existing', kind: 'directory', conflict: 'skip' }, { path: 'existing/new', kind: 'file', size: 1 }]));
  const response = await reply(await service.handleUpload(uploadRequest(task, fileItem(task), 'a')));
  assert.equal(response.ok, true);
  assert.ok(response.value.items.every(item => item.status === 'skipped'));
  assert.deepEqual(await readdir(path.join(root, 'existing')), []);
});

test('a streaming overwrite rechecks the version and never publishes stale data', async t => {
  const started = deferred();
  const { service, grant, manager, root } = await fixture(t, { onProgress: task => { if (task.bytesTransferred > 0) started.resolve(); } });
  assert.equal(typeof service.handleUpload, 'function');
  await writeFile(path.join(root, 'file'), 'original');
  const before = await manager.io.stat({ rootId: grant.id, path: 'file' });
  const task = await service.begin(uploadInput(grant, [{ path: 'file', kind: 'file', size: 4, conflict: 'overwrite', expectedVersion: before.version }]));
  let source;
  const uploading = service.handleUpload(uploadRequest(task, task.items[0], new ReadableStream({ start(controller) { source = controller; controller.enqueue(Buffer.from('ab')); } })));
  await started.promise;
  assert.equal(await readFile(path.join(root, 'file'), 'utf8'), 'original');
  await writeFile(path.join(root, 'file'), 'external');
  source.enqueue(Buffer.from('cd')); source.close();
  const response = await reply(await uploading);
  assert.equal(response.error.code, 'VERSION_CONFLICT');
  assert.equal(response.value.items[0].committed, false);
  assert.equal(await readFile(path.join(root, 'file'), 'utf8'), 'external');
  assert.deepEqual(await readdir(root), ['file']);
});

test('actual byte limits and truncated bodies fail without a destination or staging leak', async t => {
  const { service, grant, root } = await fixture(t, { limits: { maxFileBytes: 4, maxTaskBytes: 4 } });
  assert.equal(typeof service.handleUpload, 'function');
  const oversized = await service.begin(uploadInput(grant, [{ path: 'large', kind: 'file', size: 4 }]));
  const over = await reply(await service.handleUpload(uploadRequest(oversized, oversized.items[0], '12345')));
  assert.equal(over.error.code, 'TOO_LARGE');
  const truncated = await service.begin(uploadInput(grant));
  const short = await reply(await service.handleUpload(uploadRequest(truncated, truncated.items[0], '12')));
  assert.equal(short.error.code, 'SIZE_MISMATCH');
  assert.equal(short.value.status, 'failed');
  assert.deepEqual(await readdir(root), []);
});

test('cancelling a blocked upload releases its reader and cleans only uncommitted staging', { timeout: 5000 }, async t => {
  const started = deferred();
  let readerCancelled = false;
  const { service, grant, root } = await fixture(t, { onProgress: task => { if (task.bytesTransferred > 4) started.resolve(); } });
  assert.equal(typeof service.handleUpload, 'function');
  const task = await service.begin(uploadInput(grant, [{ path: 'good', kind: 'file', size: 4 }, { path: 'partial', kind: 'file', size: 4 }]));
  await service.handleUpload(uploadRequest(task, task.items[0], 'done'));
  const uploading = service.handleUpload(uploadRequest(task, task.items[1], new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('ab')); }, cancel() { readerCancelled = true; },
  })));
  await started.promise;
  const cancelled = await service.cancel(task.id);
  const response = await reply(await uploading);
  assert.equal(response.error.code, 'CANCELLED');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.items[0].status, 'completed');
  assert.equal(cancelled.items[0].committed, true);
  assert.equal(cancelled.items[1].committed, false);
  assert.equal(readerCancelled, true);
  assert.deepEqual(await readdir(root), ['good']);
});

test('request disconnection aborts staging while retaining a truthful failed task', { timeout: 5000 }, async t => {
  const started = deferred();
  const controller = new AbortController();
  const { service, grant, root } = await fixture(t, { onProgress: task => { if (task.bytesTransferred) started.resolve(); } });
  assert.equal(typeof service.handleUpload, 'function');
  const task = await service.begin(uploadInput(grant));
  const uploading = service.handleUpload(uploadRequest(task, task.items[0], new ReadableStream({ start(s) { s.enqueue(Buffer.from('a')); } }), controller.signal));
  await started.promise;
  controller.abort();
  const response = await reply(await uploading);
  assert.equal(response.error.code, 'CANCELLED');
  assert.notEqual(response.value.status, 'completed');
  assert.deepEqual(await readdir(root), []);
});

test('ENOSPC after a real staging write fails and cleans the uncommitted file', async t => {
  const { service, grant, root } = await fixture(t, { wrapManager: manager => ({
    ...manager, io: { ...manager.io, async createStagedFile(input) {
      const stage = await manager.io.createStagedFile(input);
      return { ...stage, async write(bytes) { await stage.write(bytes); throw Object.assign(new Error('full'), { code: 'ENOSPC' }); } };
    } },
  }) });
  assert.equal(typeof service.handleUpload, 'function');
  const task = await service.begin(uploadInput(grant));
  const response = await reply(await service.handleUpload(uploadRequest(task, task.items[0], 'data')));
  assert.equal(response.status, 507);
  assert.equal(response.error.code, 'NO_SPACE');
  assert.equal(response.value.items[0].committed, false);
  assert.deepEqual(await readdir(root), []);
});

test('default concurrency admits only two active uploads and cancellation drains queued work', { timeout: 5000 }, async t => {
  const two = deferred();
  let maximum = 0;
  const { service, grant, root } = await fixture(t, { onProgress: task => {
    const count = task.items.filter(item => item.status === 'running').length;
    maximum = Math.max(maximum, count); if (count === 2) two.resolve();
  } });
  assert.equal(typeof service.handleUpload, 'function');
  const task = await service.begin(uploadInput(grant, ['a', 'b', 'c'].map(name => ({ path: name, kind: 'file', size: 1 }))));
  const requests = task.items.map(item => service.handleUpload(uploadRequest(task, item, new ReadableStream())));
  await two.promise;
  assert.equal(service.get(task.id).items.filter(item => item.status === 'running').length, 2);
  await service.cancel(task.id);
  await Promise.all(requests);
  assert.equal(maximum, 2);
  assert.deepEqual(await readdir(root), []);
});

test('retry resets failed items only and never replays successful file publication', async t => {
  const { service, grant, root } = await fixture(t);
  assert.equal(typeof service.handleUpload, 'function');
  const task = await service.begin(uploadInput(grant, [{ path: 'good', kind: 'file', size: 4 }, { path: 'bad', kind: 'file', size: 4 }]));
  await service.handleUpload(uploadRequest(task, task.items[0], 'good'));
  await service.handleUpload(uploadRequest(task, task.items[1], 'no'));
  const retry = await service.control({ op: 'transfers.retry', taskId: task.id });
  assert.equal(retry.items[0].status, 'completed');
  assert.equal(retry.items[1].status, 'pending');
  await writeFile(path.join(root, 'good'), 'external');
  const response = await reply(await service.handleUpload(uploadRequest(task, task.items[1], 'done')));
  assert.equal(response.value.status, 'completed');
  assert.equal(await readFile(path.join(root, 'good'), 'utf8'), 'external');
  assert.equal(await readFile(path.join(root, 'bad'), 'utf8'), 'done');
});

const downloadRequest = (task, signal) => new Request(`http://local/api/file-manager/download?taskId=${task.id}`, { signal });

// Applying text decoding, claiming browser persistence, or eager whole-file reads
// would break the literal bytes and state-transition assertions here.
test('raw downloads stream exact bytes and report only server-side completion', async t => {
  const { service, grant, root } = await fixture(t);
  assert.equal(typeof service.handleDownload, 'function', 'the download endpoint must exist');
  const bytes = Buffer.from([0, 255, 128, 10, 13, 254, 239, 187, 191]);
  await writeFile(path.join(root, '中文.bin'), bytes);
  const task = await service.begin({ direction: 'download', rootId: grant.id, path: '中文.bin' });
  const response = await service.handleDownload(downloadRequest(task));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''%E4%B8%AD%E6%96%87.bin/);
  assert.notEqual(service.get(task.id).status, 'completed');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const finished = service.get(task.id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.completion, 'server-stream-finished');
  assert.equal(finished.items[0].committed, false, 'a server cannot assert a browser disk commit');
  assert.equal(finished.bytesTransferred, bytes.length);
});

test('a download whose source changed after planning returns a version conflict', async t => {
  const { service, manager, grant, root } = await fixture(t);
  assert.equal(typeof service.handleDownload, 'function');
  await writeFile(path.join(root, 'file'), 'old');
  const task = await service.begin({ direction: 'download', rootId: grant.id, path: 'file' });
  // Atomic replacement gives a deterministically distinct metadata version even
  // on filesystems whose timestamp granularity can coalesce immediate writes.
  await writeFile(path.join(root, 'replacement'), 'new');
  await rename(path.join(root, 'replacement'), path.join(root, 'file'));
  assert.notEqual((await manager.io.stat({ rootId: grant.id, path: 'file' })).version, task.items[0].version);
  const response = await reply(await service.handleDownload(downloadRequest(task)));
  assert.equal(response.error.code, 'VERSION_CONFLICT');
  assert.equal(response.value.status, 'failed');
});

test('consumer cancellation closes a real raw source and does not report completion', { timeout: 5000 }, async t => {
  let opened = 0; let closed = 0;
  const { service, grant, root } = await fixture(t, { wrapManager: manager => ({ ...manager, io: { ...manager.io, async openRead(input) {
    const source = await manager.io.openRead(input); opened++;
    let done = false;
    return { ...source, async close() { if (!done) { done = true; closed++; } await source.close(); } };
  } } }) });
  assert.equal(typeof service.handleDownload, 'function');
  await writeFile(path.join(root, 'large'), Buffer.alloc(512 * 1024, 7));
  const task = await service.begin({ direction: 'download', rootId: grant.id, path: 'large' });
  const response = await service.handleDownload(downloadRequest(task));
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.ok(first.value.byteLength < 512 * 1024, 'the first chunk must not buffer the whole file');
  await reader.cancel();
  assert.equal(opened, 1); assert.equal(closed, 1);
  assert.notEqual(service.get(task.id).status, 'completed');
  assert.equal(service.get(task.id).completion, undefined);
});

test('closing with an unread download response releases its stream and concurrency permit', { timeout: 5000 }, async t => {
  let closed = 0;
  const { service, grant, root } = await fixture(t, { wrapManager: manager => ({ ...manager, io: { ...manager.io, async openRead(input) {
    const source = await manager.io.openRead(input);
    return { ...source, async close() { closed++; await source.close(); } };
  } } }) });
  assert.equal(typeof service.handleDownload, 'function');
  await writeFile(path.join(root, 'large'), Buffer.alloc(512 * 1024, 2));
  const task = await service.begin({ direction: 'download', rootId: grant.id, path: 'large' });
  const response = await service.handleDownload(downloadRequest(task));
  await service.close();
  assert.equal(closed, 1);
  assert.equal(service.get(task.id).status, 'cancelled');
  await assert.rejects(response.arrayBuffer(), { code: 'CANCELLED' });
});

// Without destination identity binding, a replacement container would inherit
// an upload planned for another directory before its first stream started.
test('a replaced destination container does not inherit a planned upload', async t => {
  const { service, grant, root } = await fixture(t);
  await mkdir(path.join(root, 'target'));
  const task = await service.begin({ ...uploadInput(grant), path: 'target' });
  await rename(path.join(root, 'target'), path.join(root, 'old-target'));
  await mkdir(path.join(root, 'target'));
  const response = await reply(await service.handleUpload(uploadRequest(task, task.items[0], 'data')));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'PATH_CHANGED');
  assert.deepEqual(await readdir(path.join(root, 'target')), []);
  assert.deepEqual(await readdir(path.join(root, 'old-target')), []);
});

// Returning from a skip branch must not suppress a persistence error from its
// finally block, then accidentally allow children to merge into the old tree.
test('a failed skip receipt cannot permit children to merge into an existing directory', async t => {
  const { service, grant, root } = await fixture(t, { persistTasks: async tasks => {
    if (tasks.some(task => task.items.some(item => item.status === 'skipped'))) throw Object.assign(new Error('metadata full'), { code: 'ENOSPC' });
  } });
  await mkdir(path.join(root, 'existing'));
  const task = await service.begin(uploadInput(grant, [{ path: 'existing', kind: 'directory', conflict: 'skip' }, { path: 'existing/new', kind: 'file', size: 4 }]));
  const response = await reply(await service.handleUpload(uploadRequest(task, fileItem(task), 'data')));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'PERSISTENCE_FAILED');
  assert.deepEqual(await readdir(path.join(root, 'existing')), []);
});

test('revoking a root during streaming prevents publication and cleans held-parent staging', { timeout: 5000 }, async t => {
  const started = deferred();
  const { service, manager, grant, root } = await fixture(t, { onProgress: task => { if (task.bytesTransferred) started.resolve(); } });
  const task = await service.begin(uploadInput(grant));
  let source;
  const sending = service.handleUpload(uploadRequest(task, task.items[0], new ReadableStream({ start(controller) { source = controller; controller.enqueue(Buffer.from('a')); } })));
  await started.promise;
  await manager.removeRoot({ rootId: grant.id });
  source.enqueue(Buffer.from('bcd')); source.close();
  const response = await reply(await sending);
  assert.equal(response.error.code, 'ROOT_NOT_FOUND');
  assert.equal(response.value.items[0].committed, false);
  assert.deepEqual(await readdir(root), []);
});

test('failure after physical publication preserves committed truth and cannot be retried as a rollback', async t => {
  const { service, grant, root } = await fixture(t, { wrapManager: manager => ({ ...manager, io: { ...manager.io, async createStagedFile(input) {
    const stage = await manager.io.createStagedFile(input);
    return { ...stage, async commit(validation) {
      await stage.commit(validation);
      throw Object.assign(new Error('post publication failure'), { code: 'EIO', details: { committed: true } });
    } };
  } } }) });
  const task = await service.begin(uploadInput(grant));
  const response = await reply(await service.handleUpload(uploadRequest(task, task.items[0], 'data')));
  assert.equal(response.ok, false);
  assert.equal(response.value.items[0].committed, true);
  assert.equal(await readFile(path.join(root, 'file.bin'), 'utf8'), 'data');
  const retry = await service.control({ op: 'transfers.retry', taskId: task.id });
  assert.equal(retry.items[0].status, 'failed');
  assert.equal(retry.items[0].committed, true);
  assert.deepEqual(await readdir(root), ['file.bin']);
});

test('successful uploads persist state boundaries rather than every byte chunk', async t => {
  let writes = 0;
  const { service, grant } = await fixture(t, { persistTasks: async () => { writes++; } });
  const task = await service.begin(uploadInput(grant, [{ path: 'file', kind: 'file', size: 20 }]));
  const response = await reply(await service.handleUpload(uploadRequest(task, task.items[0], new ReadableStream({ start(controller) {
    for (let index = 0; index < 20; index++) controller.enqueue(Buffer.from([index]));
    controller.close();
  } }))));
  assert.equal(response.ok, true);
  assert.equal(writes, 3, 'acceptance, running and terminal boundaries only');
});

test('a failed terminal download receipt does not retain a success completion marker', async t => {
  const { service, grant, root } = await fixture(t, { persistTasks: async tasks => {
    if (tasks.some(task => task.status === 'completed')) throw Object.assign(new Error('metadata full'), { code: 'ENOSPC' });
  } });
  await writeFile(path.join(root, 'file'), 'content');
  const task = await service.begin({ direction: 'download', rootId: grant.id, path: 'file' });
  const response = await service.handleDownload(downloadRequest(task));
  await assert.rejects(response.arrayBuffer(), { code: 'PERSISTENCE_FAILED' });
  assert.equal(service.get(task.id).status, 'failed');
  assert.equal(service.get(task.id).completion, undefined);
});

test('shutdown waits for initial persistence and cancels a transfer accepted during closing', async t => {
  const entered = deferred(); const gate = deferred();
  const { service, grant } = await fixture(t, { persistTasks: async () => { entered.resolve(); await gate.promise; } });
  const beginning = service.begin(uploadInput(grant));
  await entered.promise;
  const closing = service.close();
  gate.resolve();
  const task = await beginning; await closing;
  assert.equal(task.status, 'cancelled');
  assert.equal(service.get(task.id).items[0].status, 'cancelled');
});

test('failed retry persistence preserves the preceding task receipt and cannot expose pending work', async t => {
  let deny = false;
  const { service, grant } = await fixture(t, { persistTasks: async () => {
    if (deny) throw Object.assign(new Error('metadata full'), { code: 'ENOSPC' });
  } });
  const task = await service.begin(uploadInput(grant));
  await service.handleUpload(uploadRequest(task, task.items[0], 'bad'));
  const before = service.get(task.id);
  deny = true;
  try {
    await assert.rejects(service.retry(task.id), { code: 'ENOSPC' });
    assert.deepEqual(service.get(task.id), before);
  } finally { deny = false; }
});

test('concurrent retry controls share one acceptance and reject bodies until persistence completes', async t => {
  const entered = deferred(); const gate = deferred();
  let block = false; let retryWrites = 0;
  const { service, grant, root } = await fixture(t, { persistTasks: async tasks => {
    if (block && tasks.some(task => task.status === 'queued')) { retryWrites++; entered.resolve(); await gate.promise; }
  } });
  const task = await service.begin(uploadInput(grant));
  await service.handleUpload(uploadRequest(task, task.items[0], 'bad'));
  block = true;
  const first = service.retry(task.id);
  await entered.promise;
  const second = service.retry(task.id);
  const sending = service.handleUpload(uploadRequest(task, task.items[0], 'data'));
  gate.resolve();
  await Promise.all([first, second]);
  block = false;
  const response = await reply(await sending);
  assert.equal(retryWrites, 1);
  assert.equal(response.error?.code, 'TASK_BUSY');
  assert.deepEqual(await readdir(root), []);
});

// Lead-approved breaking contract: metadata equality is not content equality.
test('uploads explicitly refuse metadata-only overwrite authorization', async t => {
  const { service, grant, root } = await fixture(t);
  await writeFile(path.join(root, 'target'), 'old');
  const entry = await stat(path.join(root, 'target'), { bigint: true });
  const weak = `${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeNs}:${entry.ctimeNs}`;
  const task = await service.begin(uploadInput(grant, [{ path: 'target', kind: 'file', size: 3, conflict: 'overwrite', expectedVersion: weak }]));
  const response = await reply(await service.handleUpload(uploadRequest(task, task.items[0], 'new')));
  assert.equal(response.ok, false, 'weak overwrite authorization must never be silently promoted');
  assert.equal(response.status, 409);
  assert.equal(await readFile(path.join(root, 'target'), 'utf8'), 'old');
  assert.deepEqual(await readdir(root), ['target']);
});

test('download plans carry strong fingerprints and reject same-size content changes', async t => {
  const { service, grant, root } = await fixture(t);
  await writeFile(path.join(root, 'file'), 'old');
  const task = await service.begin({ direction: 'download', rootId: grant.id, path: 'file' });
  const digest = createHash('sha256').update('old').digest('hex');
  assert.ok(task.items[0].version.endsWith(`:${digest}`), 'raw download selection must include its content fingerprint');
  await writeFile(path.join(root, 'file'), 'new');
  const response = await reply(await service.handleDownload(downloadRequest(task)));
  assert.equal(response.status, 409);
  assert.equal(response.error.code, 'VERSION_CONFLICT');
});

test('closing also drains an in-progress fingerprint plan before releasing the service', async t => {
  const entered = deferred(); const gate = deferred();
  const { service, grant, root } = await fixture(t, { wrapManager: manager => ({ ...manager, io: { ...manager.io, async stat(input) {
    if (input.path === 'file') { entered.resolve(); await gate.promise; }
    return manager.io.stat(input);
  } } }) });
  await writeFile(path.join(root, 'file'), 'content');
  const beginning = service.begin({ direction: 'download', rootId: grant.id, path: 'file' });
  const rejected = assert.rejects(beginning, error => ['SERVICE_STOPPED', 'CANCELLED'].includes(error.code));
  await entered.promise;
  let finished = false;
  const closing = service.close().then(() => { finished = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false, 'shutdown must join planning work, not only accepted task streams');
  } finally { gate.resolve(); await rejected; await closing; }
});

test('strong fingerprint planning shares the configured two-transfer concurrency budget', async t => {
  const entered = deferred(); const gate = deferred();
  let active = 0; let maximum = 0;
  const { service, grant, root } = await fixture(t, { wrapManager: manager => ({ ...manager, io: { ...manager.io, async stat(input) {
    if (!['a', 'b', 'c'].includes(input.path)) return manager.io.stat(input);
    active++; maximum = Math.max(maximum, active); if (active === 2) entered.resolve();
    try { await gate.promise; return await manager.io.stat(input); }
    finally { active--; }
  } } }) });
  for (const name of ['a', 'b', 'c']) await writeFile(path.join(root, name), name);
  const planning = ['a', 'b', 'c'].map(name => service.begin({ direction: 'download', rootId: grant.id, path: name }));
  await entered.promise;
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(maximum, 2);
  } finally { gate.resolve(); await Promise.all(planning); }
  assert.equal(active, 0);
});
