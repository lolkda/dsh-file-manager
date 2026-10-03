import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import yauzl from 'yauzl';
import { createManager } from '../dist/host/manager.js';
import { createHeavyIoScheduler } from '../dist/host/scheduler.js';
import { createTransferService } from '../dist/host/transfers.js';

async function fixture(t, scheduler = createHeavyIoScheduler({ concurrency: 1 })) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-download-scheduler-'));
  const manager = createManager({ scheduler });
  const service = createTransferService({ manager, scheduler });
  const grant = await manager.addRoot({ path: root });
  t.after(async () => {
    await service.close();
    await manager.close();
    await rm(root, { recursive: true, force: true });
  });
  // Bound regressions without leaving a deadlocked scheduler in test cleanup.
  const signal = AbortSignal.any([t.signal, AbortSignal.timeout(3000)]);
  const begin = selected => service.begin({ direction: 'download', rootId: grant.id, path: selected }, signal);
  const download = task => service.handleDownload(new Request(`http://local/download?taskId=${task.id}`, { signal }));
  return { root, manager, service, grant, scheduler, signal, begin, download };
}

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

for (const kind of ['file', 'zip']) {
  test(`${kind} download planning and streaming reuse one shared permit until verified EOF`, { timeout: 5000 }, async t => {
    const f = await fixture(t);
    const bytes = Buffer.alloc(256 * 1024, 0x83);
    await mkdir(path.join(f.root, 'tree'));
    await mkdir(path.join(f.root, 'tree', 'empty'));
    await writeFile(path.join(f.root, 'tree', 'a.bin'), bytes);
    await writeFile(path.join(f.root, 'tree', 'b.bin'), 'second lazy member');
    const task = await f.begin(kind === 'zip' ? 'tree' : 'tree/a.bin');
    assert.equal(f.scheduler.status().active, 0, 'planning must release its shared permit');
    const response = await f.download(task);
    assert.equal(response.status, 200);
    assert.equal(f.scheduler.status().active, 1, 'opening the response must not release the stream permit');
    assert.equal(f.scheduler.status().queued, 0, 'nested file reads must not wait behind their own transfer');
    let competitorStarted = false;
    const competitor = f.scheduler.run(() => { competitorStarted = true; }, { signal: f.signal });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(competitorStarted, false, 'an unread HTTP response still owns its permit');
    assert.equal(f.scheduler.status().queued, 1);
    const received = Buffer.from(await response.arrayBuffer());
    if (kind === 'file') assert.deepEqual(received, bytes);
    else {
      const entries = await unzip(received);
      assert.deepEqual([...entries.keys()], ['tree/', 'tree/a.bin', 'tree/b.bin', 'tree/empty/']);
      assert.deepEqual(entries.get('tree/a.bin'), bytes);
      assert.equal(entries.get('tree/b.bin').toString(), 'second lazy member');
      assert.equal(entries.get('tree/empty/'), null);
    }
    await competitor;
    assert.equal(f.service.get(task.id).status, 'completed');
    assert.equal(f.service.get(task.id).completion, 'server-stream-finished');
    assert.equal(f.scheduler.status().active, 0);
    assert.equal(f.scheduler.status().queued, 0);
    assert.equal(f.scheduler.status().peak, 1);
  });

  test(`cancelling an unread ${kind} download releases the shared permit before cancellation returns`, { timeout: 5000 }, async t => {
    const f = await fixture(t);
    await mkdir(path.join(f.root, 'tree'));
    await writeFile(path.join(f.root, 'tree', 'a.bin'), Buffer.alloc(256 * 1024));
    await writeFile(path.join(f.root, 'tree', 'b.bin'), Buffer.alloc(256 * 1024));
    const task = await f.begin(kind === 'zip' ? 'tree' : 'tree/a.bin');
    const response = await f.download(task);
    assert.equal(response.status, 200);
    assert.equal(f.scheduler.status().active, 1);
    const cancelled = await f.service.cancel(task.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(f.scheduler.status().active, 0);
    assert.equal(f.scheduler.status().queued, 0);
    assert.equal(await f.scheduler.run(() => 'available', { signal: f.signal }), 'available');
    await assert.rejects(response.arrayBuffer());
  });
}

test('cancelling a download queued behind other heavy work releases its queue slot', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'file'), 'payload');
  const task = await f.begin('file');
  const held = await f.scheduler.acquire();
  t.after(() => held.release());
  try {
    const downloading = f.download(task);
    assert.equal(f.scheduler.status().queued, 1);
    assert.equal((await f.service.cancel(task.id)).status, 'cancelled');
    assert.equal((await downloading).status, 499);
    assert.equal(f.scheduler.status().queued, 0);
    assert.equal(f.scheduler.status().active, 1, 'cancellation must not free another operation’s permit');
  } finally { held.release(); }
  assert.equal(f.scheduler.status().active, 0);
});

test('openRead releases its permit when content verification rejects before returning a source', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'file'), 'payload');
  const ref = { rootId: f.grant.id, path: 'file', signal: f.signal };
  const entry = await f.manager.io.stat({ ...ref, metadataOnly: true });
  await assert.rejects(f.manager.io.openRead({ ...ref, expectedVersion: `${entry.version}:${'0'.repeat(64)}` }), { code: 'VERSION_CONFLICT' });
  assert.equal(f.scheduler.status().active, 0, 'failed source initialization must release its acquired permit');
  assert.equal(f.scheduler.status().queued, 0);
  const source = await f.manager.io.openRead(ref);
  assert.equal(f.scheduler.status().active, 1);
  await source.close();
  await source.close();
  assert.equal(f.scheduler.status().active, 0);
});

test('openRead releases its permit when aborted immediately after acquisition', { timeout: 5000 }, async t => {
  const scheduler = createHeavyIoScheduler({ concurrency: 1 });
  const abort = new AbortController();
  const observed = {
    ...scheduler,
    async acquire(options) {
      const permit = await scheduler.acquire(options);
      abort.abort();
      return permit;
    },
  };
  const f = await fixture(t, observed);
  await writeFile(path.join(f.root, 'file'), 'payload');
  await assert.rejects(f.manager.io.openRead({ rootId: f.grant.id, path: 'file', signal: abort.signal }), { code: 'CANCELLED' });
  assert.equal(scheduler.status().active, 0, 'aborted source initialization must release its acquired permit');
  assert.equal(scheduler.status().queued, 0);
});
