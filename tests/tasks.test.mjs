import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createManager } from '../host/manager.js';

const tasksModule = await import('../host/tasks.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const terminal = task => ['completed', 'failed', 'partial', 'cancelled'].includes(task.status);
const absent = filename => stat(filename).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; });

async function fixture(t, options = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-tasks-'));
  const source = path.join(base, 'source');
  const target = path.join(base, 'target');
  await mkdir(source); await mkdir(target);
  const manager = createManager();
  const sourceRoot = await manager.addRoot({ path: source });
  const targetRoot = await manager.addRoot({ path: target });
  let service;
  const events = new EventEmitter();
  const saved = new Map();
  t.after(async () => { await service?.close(); await manager.close(); await rm(base, { recursive: true, force: true }); });
  assert.equal(typeof tasksModule.createTaskService, 'function', 'createTaskService has not been implemented');
  service = tasksModule.createTaskService({
    manager,
    ...options,
    async persistTask(task) {
      await writeFile(path.join(base, 'task.json'), JSON.stringify(task));
      saved.set(task.id, structuredClone(task));
      await options.persistTask?.(task);
    },
    onChange(task) { events.emit('change', task); options.onChange?.(task); },
  });
  async function item(relative, rootId = sourceRoot.id) {
    const entry = await manager.io.stat({ rootId, path: relative });
    return { rootId, path: relative, expectedVersion: entry.version };
  }
  async function wait(id) {
    return new Promise((resolve, reject) => {
      const listener = task => { if (task.id === id && terminal(task)) { events.off('change', listener); resolve(task); } };
      events.on('change', listener);
      service.get({ taskId: id }).then(listener, error => { events.off('change', listener); reject(error); });
    });
  }
  async function start(items, operation = 'copy', rest = {}) {
    return service.start({ operation, items, destination: { rootId: targetRoot.id, path: '' }, conflict: 'skip', ...rest });
  }
  return { base, source, target, sourceRoot, targetRoot, manager, service, saved, item, wait, start };
}

// Removing digest-checked staging would expose partial data and fail this real-FS assertion.
test('copy tasks publish binary bytes and ordinary modes without changing the source', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const bytes = Buffer.from([0, 255, 17, 42]);
  await writeFile(path.join(f.source, 'file'), bytes);
  await chmod(path.join(f.source, 'file'), 0o750);
  const task = await f.wait((await f.start([await f.item('file')])).id);
  assert.equal(task.status, 'completed');
  assert.equal(task.items[0].status, 'completed');
  assert.deepEqual(await readFile(path.join(f.target, 'file')), bytes);
  assert.deepEqual(await readFile(path.join(f.source, 'file')), bytes);
  assert.equal((await stat(path.join(f.target, 'file'))).mode & 0o777, 0o750);
  assert.equal(task.progress.bytes, bytes.length);
  assert.deepEqual(await readdir(f.target), ['file']);
  assert.equal(f.saved.get(task.id).status, 'completed');
});

test('directory copies retain nested files and empty directories while deduplicating descendant selections', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.source, 'folder/empty'), { recursive: true });
  await writeFile(path.join(f.source, 'folder/file'), 'content');
  const task = await f.wait((await f.start([await f.item('folder/file'), await f.item('folder'), await f.item('folder')])).id);
  assert.equal(task.status, 'completed');
  assert.equal(task.items.length, 1);
  assert.equal(await readFile(path.join(f.target, 'folder/file'), 'utf8'), 'content');
  assert.deepEqual(await readdir(path.join(f.target, 'folder/empty')), []);
  assert.deepEqual(await readdir(f.target), ['folder']);
});

test('same-filesystem moves use a checked rename and remove the old name', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'file'), 'content');
  const task = await f.wait((await f.start([await f.item('file')], 'move')).id);
  assert.equal(task.status, 'completed');
  assert.equal(task.items[0].result.method, 'rename');
  assert.equal(task.items[0].result.sourceRemoved, true);
  assert.equal(await absent(path.join(f.source, 'file')), true);
  assert.equal(await readFile(path.join(f.target, 'file'), 'utf8'), 'content');
});

test('skip conflicts leave both original files intact and report a skipped item', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'file'), 'source');
  await writeFile(path.join(f.target, 'file'), 'target');
  const task = await f.wait((await f.start([await f.item('file')])).id);
  assert.equal(task.items[0].status, 'skipped');
  assert.equal(await readFile(path.join(f.target, 'file'), 'utf8'), 'target');
  assert.equal(await readFile(path.join(f.source, 'file'), 'utf8'), 'source');
});

test('rename conflicts choose an unused suffix rather than silently overwriting', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'file.txt'), 'source');
  await writeFile(path.join(f.target, 'file.txt'), 'target');
  const task = await f.wait((await f.start([await f.item('file.txt')], 'copy', { conflict: 'rename' })).id);
  assert.equal(task.status, 'completed');
  assert.equal(task.items[0].destination.path, 'file (1).txt');
  assert.equal(await readFile(path.join(f.target, 'file.txt'), 'utf8'), 'target');
  assert.equal(await readFile(path.join(f.target, 'file (1).txt'), 'utf8'), 'source');
});

test('overwrite requires the selected destination version and never merges directories', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'file'), 'source');
  await writeFile(path.join(f.target, 'file'), 'target');
  const stale = (await f.manager.io.stat({ rootId: f.targetRoot.id, path: 'file' })).version;
  await writeFile(path.join(f.target, 'file'), 'external');
  const task = await f.wait((await f.start([{ ...await f.item('file'), expectedTargetVersion: stale }], 'copy', { conflict: 'overwrite' })).id);
  assert.equal(task.status, 'failed');
  assert.equal(task.items[0].error.code, 'VERSION_CONFLICT');
  assert.equal(await readFile(path.join(f.target, 'file'), 'utf8'), 'external');
  await mkdir(path.join(f.source, 'folder')); await mkdir(path.join(f.target, 'folder'));
  const directory = await f.wait((await f.start([await f.item('folder')], 'copy', { conflict: 'overwrite' })).id);
  assert.equal(directory.items[0].error.code, 'DIRECTORY_CONFLICT');
  assert.deepEqual((await readdir(f.target)).sort(), ['file', 'folder']);
});

test('an explicit current-version overwrite publishes the source contents', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'file'), 'source');
  await writeFile(path.join(f.target, 'file'), 'target');
  const expectedTargetVersion = (await f.manager.io.stat({ rootId: f.targetRoot.id, path: 'file' })).version;
  const task = await f.wait((await f.start([{ ...await f.item('file'), expectedTargetVersion }], 'copy', { conflict: 'overwrite' })).id);
  assert.equal(task.status, 'completed');
  assert.equal(await readFile(path.join(f.target, 'file'), 'utf8'), 'source');
});

test('a source version conflict creates no destination or owned staging remnants', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'file'), 'old');
  const item = await f.item('file');
  await writeFile(path.join(f.source, 'file'), 'external');
  const task = await f.wait((await f.start([item])).id);
  assert.equal(task.items[0].error.code, 'VERSION_CONFLICT');
  assert.deepEqual(await readdir(f.target), []);
});

test('moving a directory into its own subtree is rejected across overlapping root grants', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.source, 'folder/inside'), { recursive: true });
  const nested = await f.manager.addRoot({ path: path.join(f.source, 'folder/inside') });
  const task = await f.wait((await f.start([await f.item('folder')], 'move', { destination: { rootId: nested.id, path: '' } })).id);
  assert.equal(task.items[0].error.code, 'SELF_DESCENDANT');
  assert.deepEqual(await readdir(path.join(f.source, 'folder')), ['inside']);
});

test('retry runs only failed items and accepts an explicit new source version', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'good'), 'good');
  const task = await f.wait((await f.start([await f.item('good'), { rootId: f.sourceRoot.id, path: 'missing', expectedVersion: 'missing' }])).id);
  assert.equal(task.status, 'partial');
  assert.deepEqual(task.items.map(item => item.status), ['completed', 'failed']);
  await writeFile(path.join(f.target, 'good'), 'external target');
  await writeFile(path.join(f.source, 'missing'), 'recovered');
  const failed = task.items.find(item => item.status === 'failed');
  const version = (await f.item('missing')).expectedVersion;
  const retried = await f.wait((await f.service.retry({ taskId: task.id, items: [{ id: failed.id, expectedVersion: version }] })).id);
  assert.equal(retried.status, 'completed');
  assert.equal(retried.items[0].attempts, 1);
  assert.equal(retried.items[1].attempts, 2);
  assert.equal(await readFile(path.join(f.target, 'good'), 'utf8'), 'external target');
  assert.equal(await readFile(path.join(f.target, 'missing'), 'utf8'), 'recovered');
});

test('cancellation marks unexecuted items without publishing a partial move', { timeout: 10000 }, async t => {
  let announce;
  let release;
  const reached = new Promise(resolve => { announce = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let first = true;
  const f = await fixture(t, { async persistTask(task) {
    if (first && task.items.some(item => item.status === 'running')) { first = false; announce(); await gate; }
  } });
  await writeFile(path.join(f.source, 'a'), 'a'); await writeFile(path.join(f.source, 'b'), 'b');
  const task = await f.start([await f.item('a'), await f.item('b')], 'move');
  await reached;
  const cancelling = f.service.cancel({ taskId: task.id });
  release();
  await cancelling;
  const done = await f.wait(task.id);
  assert.equal(done.status, 'cancelled');
  assert.deepEqual(done.items.map(item => item.status), ['cancelled', 'cancelled']);
  assert.deepEqual(await readdir(f.target), []);
  assert.deepEqual((await readdir(f.source)).sort(), ['a', 'b']);
});

test('configured task limits reject oversized trees without publishing them', { timeout: 10000 }, async t => {
  const f = await fixture(t, { limits: { maxFileBytes: 3, maxTaskBytes: 5, maxTaskEntries: 2 } });
  await writeFile(path.join(f.source, 'large'), 'four');
  const task = await f.wait((await f.start([await f.item('large')])).id);
  assert.equal(task.items[0].error.code, 'TOO_LARGE');
  assert.deepEqual(await readdir(f.target), []);
});

test('task restore retains completed receipts and marks interrupted work without rerunning it', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'file'), 'original');
  const done = await f.wait((await f.start([await f.item('file')])).id);
  const completed = structuredClone(f.saved.get(done.id));
  const interrupted = structuredClone(completed);
  interrupted.id = 'interrupted';
  interrupted.status = 'running';
  interrupted.items[0].status = 'running';
  delete interrupted.items[0].checkpoint;
  delete interrupted.items[0].result;
  await writeFile(path.join(f.target, 'file'), 'external');
  const restored = tasksModule.createTaskService({ manager: f.manager, initialTasks: [completed, interrupted] });
  t.after(() => restored.close());
  assert.equal((await restored.list()).length, 2);
  assert.equal((await restored.get({ taskId: done.id })).items[0].attempts, 1);
  const recovered = await restored.get({ taskId: 'interrupted' });
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.items[0].error.code, 'INTERRUPTED');
  assert.equal(await readFile(path.join(f.target, 'file'), 'utf8'), 'external');
});

test('a task is not started when its initial persistence fails', { timeout: 10000 }, async t => {
  let location;
  const f = await fixture(t, { persistTask: () => writeFile(path.join(location, 'missing/state'), 'data') });
  location = f.base;
  await writeFile(path.join(f.source, 'file'), 'original');
  await assert.rejects(f.start([await f.item('file')]), { code: 'ENOENT' });
  assert.deepEqual(await f.service.list(), []);
  assert.deepEqual(await readdir(f.target), []);
});

test('a post-rename persistence failure reports committed state rather than an untouched source', { timeout: 10000 }, async t => {
  let location;
  const f = await fixture(t, { persistTask: task => task.items.some(item => item.checkpoint?.phase === 'renamed')
    ? writeFile(path.join(location, 'missing/state'), 'data') : undefined });
  location = f.base;
  await writeFile(path.join(f.source, 'file'), 'original');
  const task = await f.wait((await f.start([await f.item('file')], 'move')).id);
  assert.equal(task.items[0].status, 'failed');
  assert.equal(task.items[0].error.details.committed, true);
  assert.equal(task.items[0].result.sourceRemoved, true);
  assert.equal(await absent(path.join(f.source, 'file')), true);
  assert.equal(await readFile(path.join(f.target, 'file'), 'utf8'), 'original');
});

test('failed retry persistence retains the preceding failure receipt and does not queue work', { timeout: 10000 }, async t => {
  let failRetry = false;
  let location;
  const f = await fixture(t, { persistTask: task => failRetry && task.status === 'queued'
    ? writeFile(path.join(location, 'missing/state'), 'data') : undefined });
  location = f.base;
  const before = await f.wait((await f.start([{ rootId: f.sourceRoot.id, path: 'missing', expectedVersion: 'missing' }])).id);
  failRetry = true;
  await assert.rejects(f.service.retry({ taskId: before.id, items: [{ id: before.items[0].id, name: 'new-name' }] }), { code: 'ENOENT' });
  const after = await f.service.get({ taskId: before.id });
  assert.equal(after.status, 'failed');
  assert.deepEqual(after.items, before.items);
  assert.deepEqual(await readdir(f.target), []);
});

test('concurrent retries cannot enqueue the same failed item twice', { timeout: 10000 }, async t => {
  let announce;
  let release;
  let gateRetry = false;
  const reached = new Promise(resolve => { announce = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { async persistTask(task) {
    if (gateRetry && task.status === 'queued') { gateRetry = false; announce(); await gate; }
  } });
  const before = await f.wait((await f.start([{ rootId: f.sourceRoot.id, path: 'file', expectedVersion: 'missing' }])).id);
  await writeFile(path.join(f.source, 'file'), 'recovered');
  const request = { taskId: before.id, items: [{ id: before.items[0].id, expectedVersion: (await f.item('file')).expectedVersion }] };
  gateRetry = true;
  const first = f.service.retry(request);
  await reached;
  const second = f.service.retry(request);
  release();
  const results = await Promise.allSettled([first, second]);
  await f.wait(before.id);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'TASK_BUSY');
  assert.equal(await readFile(path.join(f.target, 'file'), 'utf8'), 'recovered');
});

test('shutdown waits for an accepted task persistence boundary and cancels its not-yet-started work', { timeout: 10000 }, async t => {
  let announce;
  let release;
  let first = true;
  const reached = new Promise(resolve => { announce = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { async persistTask(task) {
    if (first && task.status === 'queued') { first = false; announce(); await gate; }
  } });
  await writeFile(path.join(f.source, 'file'), 'original');
  const starting = f.start([await f.item('file')]);
  await reached;
  const closing = f.service.close();
  const closedBeforeAcceptance = await Promise.race([closing.then(() => true), new Promise(resolve => setImmediate(() => resolve(false)))]);
  release();
  const accepted = await starting;
  await closing;
  assert.equal(closedBeforeAcceptance, false);
  assert.equal((await f.service.get({ taskId: accepted.id })).status, 'cancelled');
  assert.deepEqual(await readdir(f.target), []);
});

async function crossVolume(t, f) {
  let target;
  try { target = await mkdtemp('/dev/shm/dsh-file-manager-exdev-'); }
  catch (error) { if (['ENOENT', 'EACCES', 'EROFS'].includes(error.code)) { t.skip('A writable second filesystem is unavailable.'); return null; } throw error; }
  t.after(() => rm(target, { recursive: true, force: true }));
  if ((await stat(target)).dev === (await stat(f.source)).dev) { t.skip('The available directories are on the same filesystem.'); return null; }
  const root = await f.manager.addRoot({ path: target });
  return { target, root };
}

for (const corruption of ['empty', 'wrong-target']) {
  test(`incomplete ${corruption} recovery proof cannot authorize deletion of the surviving source`, { timeout: 10000 }, async t => {
    let source;
    let denied = false;
    const f = await fixture(t, { async persistTask(task) {
      if (!denied && task.items.some(item => item.checkpoint?.phase === 'published')) { denied = true; await chmod(source, 0o500); }
    } });
    source = f.source;
    const volume = await crossVolume(t, f);
    if (!volume) return;
    await writeFile(path.join(source, 'file'), 'original');
    const failed = await f.wait((await f.start([await f.item('file')], 'move', { destination: { rootId: volume.root.id, path: '' } })).id);
    await chmod(source, 0o700);
    assert.equal(failed.items[0].error.code, 'SOURCE_DELETE_FAILED');
    const record = structuredClone(f.saved.get(failed.id));
    await rm(path.join(volume.target, 'file'));
    if (corruption === 'empty') record.items[0].checkpoint.targetManifest = [];
    else {
      await mkdir(path.join(volume.target, 'file'));
      await writeFile(path.join(volume.target, 'file/other'), 'original');
      record.items[0].checkpoint.targetManifest = [await f.manager.io.stat({ rootId: volume.root.id, path: 'file/other' })];
    }
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const restored = tasksModule.createTaskService({ manager: f.manager, initialTasks: [record], onChange(task) {
      if (terminal(task) && task.items[0].attempts > failed.items[0].attempts) finish(task);
    } });
    t.after(() => restored.close());
    await restored.retry({ taskId: failed.id });
    const retried = await done;
    assert.equal(retried.items[0].status, 'failed');
    assert.equal(retried.items[0].error.code, 'RECOVERY_REQUIRED');
    assert.equal(await readFile(path.join(source, 'file'), 'utf8'), 'original');
    if (corruption === 'empty') assert.equal(await absent(path.join(volume.target, 'file')), true);
    else assert.equal((await stat(path.join(volume.target, 'file'))).isDirectory(), true);
  });
}

for (const mode of ['live', 'retry', 'restore']) {
  test(`EXDEV ${mode} cleanup retains the next source when its published target disappears between removals`, { timeout: 10000 }, async t => {
    let base;
    let target;
    let attacked = false;
    let failFirstPublication = mode !== 'live';
    async function persistTask(task) {
      const checkpoint = task.items[0].checkpoint;
      if (failFirstPublication && checkpoint?.phase === 'published') {
        failFirstPublication = false;
        // A real journal failure pauses this move before cleanup, leaving a durable publication proof.
        await writeFile(path.join(base, 'missing-journal/task.json'), JSON.stringify(task));
      }
      if (!attacked && checkpoint?.removed?.includes('tree/b')) {
        attacked = true;
        await rm(path.join(target, 'tree/a'));
      }
    }
    const f = await fixture(t, { persistTask });
    base = f.base;
    const volume = await crossVolume(t, f);
    if (!volume) return;
    target = volume.target;
    await mkdir(path.join(f.source, 'tree'));
    await writeFile(path.join(f.source, 'tree/a'), 'AAA');
    await writeFile(path.join(f.source, 'tree/b'), 'BBB');
    let done = await f.wait((await f.start([await f.item('tree')], 'move', { destination: { rootId: volume.root.id, path: '' } })).id);
    if (mode !== 'live') {
      assert.equal(done.status, 'failed');
      assert.deepEqual(f.saved.get(done.id).items[0].checkpoint.removed, []);
      assert.equal(await readFile(path.join(f.source, 'tree/b'), 'utf8'), 'BBB');
      if (mode === 'retry') done = await f.wait((await f.service.retry({ taskId: done.id })).id);
      else {
        const record = structuredClone(f.saved.get(done.id));
        await f.service.close();
        let finish;
        const settled = new Promise(resolve => { finish = resolve; });
        const restored = tasksModule.createTaskService({ manager: f.manager, initialTasks: [record], persistTask, onChange(task) {
          if (terminal(task) && task.items[0].attempts > record.items[0].attempts) finish(task);
        } });
        t.after(() => restored.close());
        await restored.retry({ taskId: record.id });
        done = await settled;
      }
    }
    assert.equal(attacked, true, 'the target must disappear after the first source was removed');
    const surviving = await readFile(path.join(f.source, 'tree/a'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    assert.equal(surviving, 'AAA', 'the only remaining AAA bytes must not be deleted after their target disappeared');
    assert.equal(done.status, 'failed');
    assert.equal(done.items[0].error.code, 'SOURCE_DELETE_FAILED');
    assert.deepEqual(done.items[0].error.details.removedPaths, ['tree/b']);
    assert.equal(done.items[0].error.details.committed, true);
    assert.equal(done.items[0].result.sourceRemoved, false);
    assert.equal(await absent(path.join(f.source, 'tree/b')), true);
    assert.equal(await absent(path.join(target, 'tree/a')), true);
    assert.equal(await readFile(path.join(target, 'tree/b'), 'utf8'), 'BBB');
  });
}

for (const mutation of ['content-changed', 'container-replaced', 'ancestor-replaced']) {
  test(`EXDEV cleanup rechecks ${mutation} proof at each source removal`, { timeout: 10000 }, async t => {
    let target;
    let targetRootId;
    let attacked = false;
    let originalFileVersion;
    let currentFileVersion;
    let originalParentIdentity;
    let currentParentIdentity;
    const f = await fixture(t, { async persistTask(task) {
      if (attacked || !task.items[0].checkpoint?.removed?.includes('tree/z')) return;
      attacked = true;
      const fileRef = { rootId: targetRootId, path: 'holder/tree/branch/leaf/a' };
      originalFileVersion = (await f.manager.io.stat(fileRef)).version;
      if (mutation === 'content-changed') await writeFile(path.join(target, fileRef.path), 'XXX');
      else {
        const parentPath = mutation === 'container-replaced' ? 'holder' : 'holder/tree/branch';
        const childName = mutation === 'container-replaced' ? 'tree' : 'leaf';
        originalParentIdentity = (await f.manager.io.stat({ rootId: targetRootId, path: parentPath })).identity;
        await rename(path.join(target, parentPath), path.join(target, `${parentPath}-old`));
        await mkdir(path.join(target, parentPath));
        await rename(path.join(target, `${parentPath}-old`, childName), path.join(target, parentPath, childName));
        currentParentIdentity = (await f.manager.io.stat({ rootId: targetRootId, path: parentPath })).identity;
      }
      currentFileVersion = (await f.manager.io.stat(fileRef)).version;
    } });
    const volume = await crossVolume(t, f);
    if (!volume) return;
    target = volume.target;
    targetRootId = volume.root.id;
    await mkdir(path.join(target, 'holder'));
    await mkdir(path.join(f.source, 'tree/branch/leaf'), { recursive: true });
    await writeFile(path.join(f.source, 'tree/branch/leaf/a'), 'AAA');
    await writeFile(path.join(f.source, 'tree/z'), 'ZZZ');
    const done = await f.wait((await f.start([await f.item('tree')], 'move', { destination: { rootId: targetRootId, path: 'holder' } })).id);
    assert.equal(attacked, true);
    if (mutation !== 'content-changed') {
      assert.equal(currentFileVersion, originalFileVersion, 'moving ancestor directories leaves the leaf strong version unchanged');
      assert.notEqual(currentParentIdentity, originalParentIdentity);
    }
    const surviving = await readFile(path.join(f.source, 'tree/branch/leaf/a'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    assert.equal(surviving, 'AAA', 'a changed target proof must stop deletion of its still-existing source');
    assert.equal(done.items[0].error.code, 'SOURCE_DELETE_FAILED');
    assert.deepEqual(done.items[0].error.details.removedPaths, ['tree/z']);
    assert.equal(done.items[0].result.sourceRemoved, false);
    assert.equal(await absent(path.join(f.source, 'tree/z')), true);
    assert.equal(await readFile(path.join(target, 'holder/tree/z'), 'utf8'), 'ZZZ');
    assert.equal(await readFile(path.join(target, 'holder/tree/branch/leaf/a'), 'utf8'), mutation === 'content-changed' ? 'XXX' : 'AAA');
  });
}

test('real EXDEV moves verify and publish the complete copy before removing source files', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const volume = await crossVolume(t, f);
  if (!volume) return;
  await mkdir(path.join(f.source, 'folder/empty'), { recursive: true });
  await writeFile(path.join(f.source, 'folder/file'), 'content');
  const task = await f.wait((await f.start([await f.item('folder')], 'move', { destination: { rootId: volume.root.id, path: '' } })).id);
  assert.equal(task.status, 'completed');
  assert.equal(task.items[0].result.method, 'copy-delete');
  assert.equal(task.items[0].result.sourceRemoved, true);
  assert.equal(await absent(path.join(f.source, 'folder')), true);
  assert.equal(await readFile(path.join(volume.target, 'folder/file'), 'utf8'), 'content');
  assert.deepEqual(await readdir(path.join(volume.target, 'folder/empty')), []);
  assert.deepEqual(await readdir(volume.target), ['folder']);
});

test('a failed EXDEV source cleanup can be retried without recopying its committed destination', { timeout: 10000 }, async t => {
  let source;
  let denied = false;
  const f = await fixture(t, { async persistTask(task) {
    if (!denied && task.items.some(item => item.checkpoint?.phase === 'published')) {
      denied = true; await chmod(source, 0o500);
    }
  } });
  source = f.source;
  const volume = await crossVolume(t, f);
  if (!volume) return;
  await writeFile(path.join(f.source, 'file'), 'original');
  const task = await f.wait((await f.start([await f.item('file')], 'move', { destination: { rootId: volume.root.id, path: '' } })).id);
  await chmod(source, 0o700);
  assert.equal(task.items[0].error.code, 'SOURCE_DELETE_FAILED');
  assert.equal(task.items[0].error.details.bothCopiesExist, true);
  const published = await f.manager.io.stat({ rootId: volume.root.id, path: 'file' });
  const retried = await f.wait((await f.service.retry({ taskId: task.id })).id);
  assert.equal(retried.status, 'completed');
  assert.equal(retried.items[0].attempts, 2);
  assert.equal(retried.items[0].result.sourceRemoved, true);
  assert.equal(await absent(path.join(source, 'file')), true);
  assert.equal((await f.manager.io.stat({ rootId: volume.root.id, path: 'file' })).version, published.version);
});

test('cancellation after EXDEV publication preserves the source and reports the committed target', { timeout: 10000 }, async t => {
  let announce;
  let release;
  let first = true;
  const published = new Promise(resolve => { announce = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { async persistTask(task) {
    if (first && task.items.some(item => item.checkpoint?.phase === 'published')) { first = false; announce(); await gate; }
  } });
  const volume = await crossVolume(t, f);
  if (!volume) return;
  await writeFile(path.join(f.source, 'file'), 'original');
  const task = await f.start([await f.item('file')], 'move', { destination: { rootId: volume.root.id, path: '' } });
  await published;
  const cancelling = f.service.cancel({ taskId: task.id });
  release(); await cancelling;
  const done = await f.wait(task.id);
  assert.equal(done.status, 'cancelled');
  assert.equal(done.items[0].status, 'failed');
  assert.equal(done.items[0].error.details.committed, true);
  assert.equal(done.items[0].result.sourceRemoved, false);
  assert.equal(await readFile(path.join(f.source, 'file'), 'utf8'), 'original');
  assert.equal(await readFile(path.join(volume.target, 'file'), 'utf8'), 'original');
  assert.deepEqual(await readdir(volume.target), ['file']);
});

test('EXDEV cleanup detects source changes after publication and retry never overwrites the committed target', { timeout: 10000 }, async t => {
  let source;
  let changed = false;
  const f = await fixture(t, { async persistTask(task) {
    if (!changed && task.items.some(item => item.checkpoint?.phase === 'published')) {
      changed = true;
      await writeFile(path.join(source, 'file'), 'external source');
    }
  } });
  source = f.source;
  const volume = await crossVolume(t, f);
  if (!volume) return;
  await writeFile(path.join(f.source, 'file'), 'original');
  const task = await f.wait((await f.start([await f.item('file')], 'move', { destination: { rootId: volume.root.id, path: '' } })).id);
  assert.equal(task.status, 'failed');
  assert.equal(task.items[0].error.code, 'SOURCE_DELETE_FAILED');
  assert.equal(task.items[0].error.details.committed, true);
  assert.equal(task.items[0].result.sourceRemoved, false);
  assert.equal(await readFile(path.join(f.source, 'file'), 'utf8'), 'external source');
  assert.equal(await readFile(path.join(volume.target, 'file'), 'utf8'), 'original');
  await writeFile(path.join(volume.target, 'file'), 'external target');
  const retried = await f.wait((await f.service.retry({ taskId: task.id })).id);
  assert.equal(retried.items[0].status, 'failed');
  assert.equal(await readFile(path.join(f.source, 'file'), 'utf8'), 'external source');
  assert.equal(await readFile(path.join(volume.target, 'file'), 'utf8'), 'external target');
});
