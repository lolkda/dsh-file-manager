import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import yauzl from 'yauzl';
import { createManager } from '../dist/host/manager.js';
import { createTransferService } from '../dist/host/transfers.js';

async function fixture(t, options = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-zip-'));
  const root = path.join(base, 'root'); await mkdir(root);
  const manager = createManager();
  let service;
  t.after(async () => { await service?.close(); await manager.close(); await rm(base, { recursive: true, force: true }); });
  const grant = await manager.addRoot({ path: root });
  service = createTransferService({ manager: options.wrapManager ? options.wrapManager(manager) : manager, ...options });
  return { base, root, manager, grant, service };
}
const download = (service, task) => service.handleDownload(new Request(`http://local/api/file-manager/v2/download?taskId=${task.id}`));
async function unzip(bytes) {
  const archive = await promisify(yauzl.fromBuffer)(bytes, { lazyEntries: true, strictFileNames: true });
  const entries = new Map();
  try {
    await new Promise((resolve, reject) => {
      archive.on('error', reject); archive.on('end', resolve);
      archive.on('entry', entry => {
        if (entry.fileName.endsWith('/')) { entries.set(entry.fileName, null); archive.readEntry(); return; }
        archive.openReadStream(entry, async (error, stream) => {
          if (error) { reject(error); return; }
          try { entries.set(entry.fileName, Buffer.concat(await Array.fromAsync(stream))); archive.readEntry(); }
          catch (failure) { reject(failure); }
        });
      });
      archive.readEntry();
    });
  } finally { archive.close(); }
  return entries;
}

// Omitting explicit directory records would silently lose the empty directory.
test('directory downloads contain a valid ZIP with Unicode hierarchy and empty directories', async t => {
  const { root, service, grant } = await fixture(t);
  assert.equal(typeof service.handleDownload, 'function', 'directory streaming is not implemented');
  await mkdir(path.join(root, '资料/empty'), { recursive: true });
  await mkdir(path.join(root, '资料/nested'));
  const bytes = Buffer.from([0, 255, 13, 10, 128]);
  await writeFile(path.join(root, '资料/nested/字节.bin'), bytes);
  const task = await service.begin({ direction: 'download', rootId: grant.id, path: '资料' });
  const response = await download(service, task);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  const entries = await unzip(Buffer.from(await response.arrayBuffer()));
  assert.deepEqual([...entries.keys()], ['资料/', '资料/empty/', '资料/nested/', '资料/nested/字节.bin']);
  assert.deepEqual(entries.get('资料/nested/字节.bin'), bytes);
  assert.equal(entries.get('资料/empty/'), null);
  assert.equal(service.get(task.id).status, 'completed');
  assert.equal(service.get(task.id).completion, 'server-stream-finished');
  assert.deepEqual(await readdir(root), ['资料'], 'ZIP generation must not leave a temporary archive');
});

test('a selected empty root directory is downloadable without authorizing its absolute path', async t => {
  const { service, grant } = await fixture(t);
  assert.equal(typeof service.handleDownload, 'function');
  const task = await service.begin({ direction: 'download', rootId: grant.id, path: '' });
  const entries = await unzip(Buffer.from(await (await download(service, task)).arrayBuffer()));
  assert.deepEqual([...entries.keys()], ['root/']);
});

test('ZIP preflight rejects links rather than silently following or omitting them', async t => {
  const { root, base, service, grant } = await fixture(t);
  assert.equal(typeof service.handleDownload, 'function');
  await mkdir(path.join(root, 'tree'));
  await writeFile(path.join(base, 'outside'), 'outside');
  await symlink(path.join(base, 'outside'), path.join(root, 'tree/link'));
  await assert.rejects(service.begin({ direction: 'download', rootId: grant.id, path: 'tree' }), { code: 'UNSUPPORTED_ENTRY' });
  assert.deepEqual(service.list(), []);
});

test('ZIP preflight enforces actual file bytes and recursive entry limits', async t => {
  const { root, service, grant } = await fixture(t, { limits: { maxFileBytes: 4, maxTaskBytes: 6, maxTaskEntries: 3 } });
  assert.equal(typeof service.handleDownload, 'function');
  await mkdir(path.join(root, 'tree'));
  await writeFile(path.join(root, 'tree/a'), '12345');
  await assert.rejects(service.begin({ direction: 'download', rootId: grant.id, path: 'tree' }), { code: 'TOO_LARGE' });
  await writeFile(path.join(root, 'tree/a'), '1234');
  await writeFile(path.join(root, 'tree/b'), '123');
  await assert.rejects(service.begin({ direction: 'download', rootId: grant.id, path: 'tree' }), { code: 'TOO_LARGE' });
  await writeFile(path.join(root, 'tree/a'), ''); await writeFile(path.join(root, 'tree/b'), '');
  await mkdir(path.join(root, 'tree/c'));
  await assert.rejects(service.begin({ direction: 'download', rootId: grant.id, path: 'tree' }), { code: 'TOO_LARGE' });
});

test('ZIP lazily opens one real file at a time instead of holding every source descriptor', async t => {
  let active = 0; let maximum = 0;
  const { root, service, grant } = await fixture(t, { wrapManager: manager => ({ ...manager, io: { ...manager.io, async openRead(input) {
    const source = await manager.io.openRead(input); active++; maximum = Math.max(maximum, active);
    let closed = false;
    return { ...source, async close() { if (!closed) { closed = true; active--; } await source.close(); } };
  } } }) });
  assert.equal(typeof service.handleDownload, 'function');
  await mkdir(path.join(root, 'many'));
  for (let index = 0; index < 6; index++) await writeFile(path.join(root, `many/${index}`), Buffer.alloc(128 * 1024, index));
  const task = await service.begin({ direction: 'download', rootId: grant.id, path: 'many' });
  const response = await download(service, task);
  const entries = await unzip(Buffer.from(await response.arrayBuffer()));
  assert.equal(entries.size, 7);
  assert.equal(maximum, 1); assert.equal(active, 0);
});

test('ZIP cancellation closes the current source and reports incomplete transfer', { timeout: 5000 }, async t => {
  let active = 0;
  const { root, service, grant } = await fixture(t, { wrapManager: manager => ({ ...manager, io: { ...manager.io, async openRead(input) {
    const source = await manager.io.openRead(input); active++;
    let closed = false;
    return { ...source, async close() { if (!closed) { closed = true; active--; } await source.close(); } };
  } } }) });
  assert.equal(typeof service.handleDownload, 'function');
  await mkdir(path.join(root, 'tree'));
  await writeFile(path.join(root, 'tree/large'), Buffer.alloc(2 * 1024 * 1024, 7));
  const task = await service.begin({ direction: 'download', rootId: grant.id, path: 'tree' });
  const response = await download(service, task);
  const reader = response.body.getReader();
  await reader.read(); await reader.cancel();
  assert.equal(active, 0);
  assert.notEqual(service.get(task.id).status, 'completed');
  assert.equal(service.get(task.id).completion, undefined);
});

test('retrying a download starts a new complete stream including previously sent members', async t => {
  const { root, service, grant } = await fixture(t);
  await mkdir(path.join(root, 'tree'));
  await writeFile(path.join(root, 'tree/a'), 'a'); await writeFile(path.join(root, 'tree/b'), 'b');
  const task = await service.begin({ direction: 'download', rootId: grant.id, path: 'tree' });
  await (await download(service, task)).arrayBuffer();
  const retry = await service.control({ op: 'transfers.retry', taskId: task.id });
  assert.equal(retry.status, 'queued');
  assert.ok(retry.items.every(item => item.status === 'pending'));
  assert.equal(retry.bytesTransferred, 0);
  assert.equal(retry.wireBytesTransferred, 0);
  assert.equal(retry.completion, undefined);
  const entries = await unzip(Buffer.from(await (await download(service, task)).arrayBuffer()));
  assert.deepEqual([...entries.keys()], ['tree/', 'tree/a', 'tree/b']);
  assert.equal(entries.get('tree/a').toString(), 'a');
});

test('a source modified during ZIP streaming errors the response and cannot claim completion', { timeout: 5000 }, async t => {
  const { root, service, grant } = await fixture(t);
  await mkdir(path.join(root, 'tree'));
  await writeFile(path.join(root, 'tree/file'), Buffer.alloc(4 * 1024 * 1024, 1));
  const task = await service.begin({ direction: 'download', rootId: grant.id, path: 'tree' });
  const response = await download(service, task);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  while (service.get(task.id).bytesTransferred === 0) assert.equal((await reader.read()).done, false);
  await writeFile(path.join(root, 'tree/file'), Buffer.alloc(4 * 1024 * 1024, 2));
  await assert.rejects((async () => { while (!(await reader.read()).done) {} })(), { code: 'VERSION_CONFLICT' });
  assert.notEqual(service.get(task.id).status, 'completed');
  assert.equal(service.get(task.id).completion, undefined);
});

test('every ZIP file member binds a strong content fingerprint rather than a listing stamp', async t => {
  const { root, service, grant } = await fixture(t);
  await mkdir(path.join(root, 'tree'));
  await writeFile(path.join(root, 'tree/a'), 'AAA');
  await writeFile(path.join(root, 'tree/b'), 'BBB');
  const task = await service.begin({ direction: 'download', rootId: grant.id, path: 'tree' });
  const a = task.items.find(item => item.path === 'tree/a');
  const b = task.items.find(item => item.path === 'tree/b');
  assert.ok(a.version.endsWith(`:${createHash('sha256').update('AAA').digest('hex')}`));
  assert.ok(b.version.endsWith(`:${createHash('sha256').update('BBB').digest('hex')}`));
  await writeFile(path.join(root, 'tree/b'), 'CCC');
  const response = await download(service, task);
  await assert.rejects(response.arrayBuffer(), { code: 'VERSION_CONFLICT' });
  assert.notEqual(service.get(task.id).status, 'completed');
});
