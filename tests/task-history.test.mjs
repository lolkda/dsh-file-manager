import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createManager } from '../dist/host/manager.js';
import { createTaskService } from '../dist/host/tasks.js';

const terminal = task => ['completed', 'partial', 'failed', 'cancelled'].includes(task.status);
const turn = () => new Promise(resolve => setImmediate(resolve));
const requireDismiss = service => assert.equal(typeof service.dismiss, 'function', 'persistent task dismissal is missing');

async function fixture(t, { beforePersist, onChange, limits } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-task-history-'));
  const source = path.join(base, 'source');
  const target = path.join(base, 'target');
  const journal = path.join(base, 'journal');
  await Promise.all([source, target, journal].map(directory => mkdir(directory)));
  await writeFile(path.join(source, 'a'), 'AAA');
  const manager = createManager();
  const sourceRoot = await manager.addRoot({ path: source });
  const targetRoot = await manager.addRoot({ path: target });
  const services = new Set();
  const managers = new Set([manager]);
  const releases = new Set();
  const events = new EventEmitter();
  const notifications = [];
  const writes = [];
  const durable = new Map();
  const journalPath = id => path.join(journal, `${id}.json`);
  async function persist(record) {
    const snapshot = structuredClone(record);
    await beforePersist?.(snapshot);
    await writeFile(journalPath(snapshot.id), JSON.stringify(snapshot));
    durable.set(snapshot.id, structuredClone(snapshot));
    writes.push(snapshot);
  }
  const service = createTaskService({ manager, limits, persistTask: persist, onChange(task) {
    notifications.push(structuredClone(task));
    events.emit('change', task);
    onChange?.(task);
  } });
  services.add(service);
  t.after(async () => {
    for (const release of releases) release();
    for (const item of services) await item.close();
    for (const item of managers) await item.close();
    await rm(base, { recursive: true, force: true });
  });
  function block() {
    let entered;
    let release;
    const reached = new Promise(resolve => { entered = resolve; });
    const waiting = new Promise(resolve => { release = resolve; });
    releases.add(release);
    return { reached, release, async pause() { entered(); await waiting; } };
  }
  async function item(relative = 'a') {
    const ref = { rootId: sourceRoot.id, path: relative };
    return { ...ref, expectedVersion: (await manager.stat(ref)).version };
  }
  const missing = () => ({ rootId: sourceRoot.id, path: 'missing', expectedVersion: 'missing' });
  async function start(items, operation = 'copy') {
    return service.start({ operation, items: items ?? [await item()], destination: { rootId: targetRoot.id, path: '' }, conflict: 'skip' });
  }
  async function finish(started) {
    const task = await started;
    await new Promise((resolve, reject) => {
      const receive = current => {
        if (current.id === task.id && terminal(current) && current.canDismiss === true) { events.off('change', receive); resolve(); }
      };
      events.on('change', receive);
      service.get({ taskId: task.id }).then(receive, error => { events.off('change', receive); reject(error); });
    });
    return service.get({ taskId: task.id });
  }
  return { base, source, target, journalPath, manager, service, sourceRoot, targetRoot, services, managers, notifications, writes, durable, persist, block, item, missing, start, finish };
}

// Replacing the derived state with a persisted flag would make an active terminal task dismissible.
test('new tasks expose stable history defaults and notify when terminal cleanup releases activity', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const accepted = await f.start();
  assert.equal(accepted.dismissed, false);
  assert.equal(accepted.historyRevision, 0);
  assert.equal(accepted.canDismiss, false);
  const done = await f.finish(accepted);
  assert.equal(done.canDismiss, true);
  const terminalFrames = f.notifications.filter(task => task.id === done.id && terminal(task));
  assert.equal(terminalFrames[0].canDismiss, false, 'the terminal journal notification still owns an active worker');
  assert.equal(terminalFrames.at(-1).canDismiss, true, 'clients must observe the final activity release');
  assert.ok(f.writes.every(record => !Object.hasOwn(record, 'canDismiss')));
});

test('dismissing a completed copy changes only durable history and keeps files and private recovery proof', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  requireDismiss(f.service);
  const done = await f.finish(f.start());
  const before = structuredClone(f.durable.get(done.id));
  const sourceVersion = (await f.manager.stat({ rootId: f.sourceRoot.id, path: 'a' })).version;
  const targetVersion = (await f.manager.stat({ rootId: f.targetRoot.id, path: 'a' })).version;
  const hidden = await f.service.dismiss({ taskId: done.id, expectedHistoryRevision: done.historyRevision });
  assert.equal(hidden.dismissed, true);
  assert.equal(hidden.historyRevision, 1);
  assert.equal(hidden.canDismiss, false);
  assert.equal(hidden.status, done.status);
  assert.equal(hidden.items[0].attempts, done.items[0].attempts);
  assert.equal(Object.hasOwn(hidden.items[0], 'checkpoint'), false);
  const saved = JSON.parse(await readFile(f.journalPath(done.id), 'utf8'));
  assert.equal(saved.dismissed, true);
  assert.equal(saved.historyRevision, 1);
  assert.equal(Object.hasOwn(saved, 'canDismiss'), false);
  assert.equal(JSON.stringify(saved.items[0].checkpoint), JSON.stringify(before.items[0].checkpoint));
  assert.equal((await f.service.list()).length, 1, 'dismissal must not erase the historical record');
  assert.equal((await f.manager.stat({ rootId: f.sourceRoot.id, path: 'a' })).version, sourceVersion);
  assert.equal((await f.manager.stat({ rootId: f.targetRoot.id, path: 'a' })).version, targetVersion);
  assert.equal(await readFile(path.join(f.source, 'a'), 'utf8'), 'AAA');
  assert.equal(await readFile(path.join(f.target, 'a'), 'utf8'), 'AAA');
});

for (const status of ['failed', 'partial', 'cancelled']) {
  test(`a quiescent ${status} task may be dismissed without retrying or cancelling its items`, { timeout: 10000 }, async t => {
    let gate;
    let held = false;
    const f = await fixture(t, { async beforePersist(task) {
      if (status === 'cancelled' && !held && task.items.some(item => item.status === 'running')) { held = true; await gate.pause(); }
    } });
    requireDismiss(f.service);
    gate = f.block();
    const inputs = status === 'failed' ? [f.missing()] : status === 'partial' ? [await f.item(), f.missing()] : [await f.item()];
    const accepted = await f.start(inputs);
    if (status === 'cancelled') {
      await gate.reached;
      const cancelling = f.service.cancel({ taskId: accepted.id });
      gate.release(); await cancelling;
    }
    const done = await f.finish(accepted);
    assert.equal(done.status, status);
    const sourceEntries = await readdir(f.source);
    const targetEntries = await readdir(f.target);
    const before = structuredClone(f.durable.get(done.id));
    const hidden = await f.service.dismiss({ taskId: done.id, expectedHistoryRevision: done.historyRevision });
    assert.equal(hidden.dismissed, true);
    assert.equal(hidden.status, status);
    assert.deepEqual(hidden.items, done.items);
    assert.deepEqual(f.durable.get(done.id).items, before.items);
    assert.deepEqual(await readdir(f.source), sourceEntries);
    assert.deepEqual(await readdir(f.target), targetEntries);
  });
}

test('a terminal status with its final save still active cannot be dismissed', { timeout: 10000 }, async t => {
  let gate;
  let held = false;
  const f = await fixture(t, { async beforePersist(task) {
    if (!held && task.status === 'completed') { held = true; await gate.pause(); }
  } });
  requireDismiss(f.service);
  gate = f.block();
  const accepted = await f.start();
  await gate.reached;
  const pending = await f.service.get({ taskId: accepted.id });
  assert.equal(pending.status, 'completed');
  assert.equal(pending.canDismiss, false);
  await assert.rejects(f.service.dismiss({ taskId: accepted.id, expectedHistoryRevision: pending.historyRevision }), { code: 'TASK_BUSY' });
  gate.release();
  const done = await f.finish(accepted);
  assert.equal(done.canDismiss, true);
  assert.equal(done.dismissed, false);
});

test('queued and running tasks are never dismissed as if they had finished', { timeout: 10000 }, async t => {
  let held = false;
  const f = await fixture(t, { limits: { transferConcurrency: 1 } });
  requireDismiss(f.service);
  const gate = f.block();
  const openRead = f.manager.io.openRead;
  f.manager.io.openRead = async options => {
    const source = await openRead(options);
    if (!held && options.rootId === f.sourceRoot.id && options.path === 'a') { held = true; await gate.pause(); }
    return source;
  };
  const running = await f.start();
  await gate.reached;
  const queued = await f.start([f.missing()]);
  for (const task of [running, queued]) {
    assert.equal((await f.service.get({ taskId: task.id })).canDismiss, false);
    await assert.rejects(f.service.dismiss({ taskId: task.id, expectedHistoryRevision: 0 }), { code: 'TASK_BUSY' });
  }
  gate.release();
  await f.finish(running); await f.finish(queued);
});

test('dismissal remains visible and busy until its exact metadata write succeeds', { timeout: 10000 }, async t => {
  let gate;
  let armed = false;
  const f = await fixture(t, { async beforePersist(task) { if (armed && task.dismissed) { armed = false; await gate.pause(); } } });
  requireDismiss(f.service);
  const done = await f.finish(f.start());
  gate = f.block(); armed = true;
  const hiding = f.service.dismiss({ taskId: done.id, expectedHistoryRevision: 0 });
  await gate.reached;
  const pending = await f.service.get({ taskId: done.id });
  assert.equal(pending.dismissed, false);
  assert.equal(pending.historyRevision, 0);
  assert.equal(pending.canDismiss, false);
  assert.equal(JSON.parse(await readFile(f.journalPath(done.id), 'utf8')).dismissed, false);
  await assert.rejects(f.service.dismiss({ taskId: done.id, expectedHistoryRevision: 0 }), { code: 'TASK_BUSY' });
  gate.release();
  const hidden = await hiding;
  assert.equal(hidden.dismissed, true);
  assert.equal(hidden.historyRevision, 1);
  assert.equal(hidden.canDismiss, false);
  assert.equal(f.notifications.filter(task => task.id === done.id).at(-1).canDismiss, false);
});

test('a failed dismissal write preserves the previous raw record and never emits a hidden state', { timeout: 10000 }, async t => {
  let base;
  let denied = false;
  const f = await fixture(t, { async beforePersist(task) {
    if (denied && task.dismissed) await writeFile(path.join(base, 'missing-journal/state.json'), JSON.stringify(task));
  } });
  base = f.base;
  requireDismiss(f.service);
  const done = await f.finish(f.start());
  const before = await readFile(f.journalPath(done.id), 'utf8');
  const offset = f.notifications.length;
  denied = true;
  await assert.rejects(f.service.dismiss({ taskId: done.id, expectedHistoryRevision: 0 }), { code: 'ENOENT' });
  assert.deepEqual(await f.service.get({ taskId: done.id }), done);
  assert.equal(await readFile(f.journalPath(done.id), 'utf8'), before);
  assert.equal(f.notifications.slice(offset).some(task => task.dismissed), false);
  assert.equal(f.notifications.at(-1).canDismiss, true);
});

test('repeated durable dismissal is idempotent but stale first-time dismissal is rejected', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  requireDismiss(f.service);
  const done = await f.finish(f.start());
  const writes = f.writes.length;
  await assert.rejects(f.service.dismiss({ taskId: done.id, expectedHistoryRevision: 9 }), { code: 'TASK_CHANGED' });
  assert.equal(f.writes.length, writes);
  const first = await f.service.dismiss({ taskId: done.id, expectedHistoryRevision: 0 });
  const written = f.writes.length;
  const repeated = await f.service.dismiss({ taskId: done.id, expectedHistoryRevision: 0 });
  assert.deepEqual(repeated, first);
  assert.equal(f.writes.length, written);
  assert.equal(repeated.historyRevision, 1);
});

test('a retry atomically reopens hidden history and invalidates old dismiss callbacks', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  requireDismiss(f.service);
  const failed = await f.finish(f.start([f.missing()]));
  const hidden = await f.service.dismiss({ taskId: failed.id, expectedHistoryRevision: 0 });
  assert.equal(hidden.historyRevision, 1);
  const accepted = await f.service.retry({ taskId: failed.id });
  assert.equal(accepted.historyRevision, 2);
  assert.equal(accepted.dismissed, false);
  assert.equal(accepted.canDismiss, false);
  const retried = await f.finish(accepted);
  assert.equal(retried.items[0].attempts, 2);
  assert.equal(retried.historyRevision, 2);
  assert.equal(retried.dismissed, false);
  await assert.rejects(f.service.dismiss({ taskId: failed.id, expectedHistoryRevision: 0 }), { code: 'TASK_CHANGED' });
  await assert.rejects(f.service.dismiss({ taskId: failed.id, expectedHistoryRevision: 1 }), { code: 'TASK_CHANGED' });
  const closedAgain = await f.service.dismiss({ taskId: failed.id, expectedHistoryRevision: 2 });
  assert.equal(closedAgain.historyRevision, 3);
});

test('each accepted retry increments history even if the previous attempt was not dismissed', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  requireDismiss(f.service);
  const failed = await f.finish(f.start([f.missing()]));
  const accepted = await f.service.retry({ taskId: failed.id });
  assert.equal(accepted.historyRevision, 1);
  const done = await f.finish(accepted);
  assert.equal(done.dismissed, false);
  assert.equal(done.historyRevision, 1);
});

test('retry cannot interleave with an uncommitted dismissal', { timeout: 10000 }, async t => {
  let gate;
  let armed = false;
  const f = await fixture(t, { async beforePersist(task) { if (armed && task.dismissed) { armed = false; await gate.pause(); } } });
  requireDismiss(f.service);
  const failed = await f.finish(f.start([f.missing()]));
  gate = f.block(); armed = true;
  const hiding = f.service.dismiss({ taskId: failed.id, expectedHistoryRevision: 0 });
  await gate.reached;
  await assert.rejects(f.service.retry({ taskId: failed.id }), { code: 'TASK_BUSY' });
  gate.release();
  const hidden = await hiding;
  assert.equal(hidden.historyRevision, 1);
  assert.equal(hidden.items[0].attempts, 1);
});

test('already hidden history cannot bypass a pending retry metadata lock', { timeout: 10000 }, async t => {
  let gate;
  let armed = false;
  const f = await fixture(t, { async beforePersist(task) {
    if (armed && task.status === 'queued') { armed = false; await gate.pause(); }
  } });
  requireDismiss(f.service);
  const failed = await f.finish(f.start([f.missing()]));
  await f.service.dismiss({ taskId: failed.id, expectedHistoryRevision: 0 });
  gate = f.block(); armed = true;
  const retrying = f.service.retry({ taskId: failed.id });
  await gate.reached;
  const pending = await f.service.get({ taskId: failed.id });
  assert.equal(pending.dismissed, true, 'the previous durable state stays visible while retry acceptance is pending');
  assert.equal(pending.historyRevision, 1);
  assert.equal(pending.canDismiss, false);
  await assert.rejects(f.service.dismiss({ taskId: failed.id, expectedHistoryRevision: 0 }), { code: 'TASK_BUSY' });
  gate.release();
  await f.finish(await retrying);
});

test('failed retry acceptance cannot clear a durable hidden flag or advance its revision', { timeout: 10000 }, async t => {
  let base;
  let denied = false;
  const f = await fixture(t, { async beforePersist(task) {
    if (denied && task.status === 'queued') await writeFile(path.join(base, 'missing-journal/state.json'), JSON.stringify(task));
  } });
  base = f.base;
  requireDismiss(f.service);
  const failed = await f.finish(f.start([f.missing()]));
  const hidden = await f.service.dismiss({ taskId: failed.id, expectedHistoryRevision: 0 });
  const before = await readFile(f.journalPath(failed.id), 'utf8');
  const offset = f.notifications.length;
  denied = true;
  await assert.rejects(f.service.retry({ taskId: failed.id }), { code: 'ENOENT' });
  assert.deepEqual(await f.service.get({ taskId: failed.id }), hidden);
  assert.equal(await readFile(f.journalPath(failed.id), 'utf8'), before);
  assert.equal(f.notifications.slice(offset).some(task => !task.dismissed || task.historyRevision !== 1), false);
  assert.equal(f.notifications.at(-1).canDismiss, false);
});

test('legacy defaults and unknown checkpoint fields survive dismissal and cold reopening', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  requireDismiss(f.service);
  const done = await f.finish(f.start());
  const legacy = structuredClone(f.durable.get(done.id));
  delete legacy.dismissed; delete legacy.historyRevision;
  legacy.canDismiss = false;
  legacy.items[0].checkpoint.futureProof = { bytes: [0, 255, 17], text: '原始\u0000证明', canDismiss: 'private-field-must-stay' };
  const checkpointBytes = JSON.stringify(legacy.items[0].checkpoint);
  await writeFile(f.journalPath(done.id), JSON.stringify(legacy));
  const grants = f.manager.listRoots();
  await f.service.close(); await f.manager.close();
  const firstManager = createManager({ initialRoots: grants });
  f.managers.add(firstManager);
  const initialFrames = [];
  const first = createTaskService({ manager: firstManager, initialTasks: [JSON.parse(await readFile(f.journalPath(done.id), 'utf8'))], persistTask: f.persist, onChange: task => initialFrames.push(task) });
  f.services.add(first);
  const restored = await first.get({ taskId: done.id });
  assert.equal(initialFrames.length, 1, 'restoring the first durable record must still publish its snapshot');
  assert.equal(initialFrames[0].historyRevision, 0);
  assert.equal(restored.dismissed, false);
  assert.equal(restored.historyRevision, 0);
  assert.equal(restored.canDismiss, true);
  assert.equal(Object.hasOwn(f.durable.get(done.id), 'canDismiss'), false);
  await first.dismiss({ taskId: done.id, expectedHistoryRevision: 0 });
  assert.equal(JSON.stringify(f.durable.get(done.id).items[0].checkpoint), checkpointBytes);
  await first.close(); await firstManager.close();
  const secondManager = createManager({ initialRoots: grants });
  f.managers.add(secondManager);
  const second = createTaskService({ manager: secondManager, initialTasks: [JSON.parse(await readFile(f.journalPath(done.id), 'utf8'))], persistTask: f.persist });
  f.services.add(second);
  const reopened = await second.get({ taskId: done.id });
  assert.equal(reopened.dismissed, true);
  assert.equal(reopened.historyRevision, 1);
  assert.equal(reopened.canDismiss, false);
  assert.equal((await second.list()).length, 1);
  assert.equal(JSON.stringify(f.durable.get(done.id).items[0].checkpoint), checkpointBytes);
  assert.ok(f.writes.every(record => !Object.hasOwn(record, 'canDismiss')));
  assert.equal(await readFile(path.join(f.source, 'a'), 'utf8'), 'AAA');
  assert.equal(await readFile(path.join(f.target, 'a'), 'utf8'), 'AAA');
});

test('shutdown drains an accepted dismissal and rejects newly submitted metadata writes', { timeout: 10000 }, async t => {
  let gate;
  let armed = false;
  const f = await fixture(t, { async beforePersist(task) { if (armed && task.dismissed) { armed = false; await gate.pause(); } } });
  requireDismiss(f.service);
  const done = await f.finish(f.start());
  gate = f.block(); armed = true;
  const hiding = f.service.dismiss({ taskId: done.id, expectedHistoryRevision: 0 });
  await gate.reached;
  let closed = false;
  const closing = f.service.close().then(() => { closed = true; });
  await turn();
  assert.equal(closed, false);
  await assert.rejects(f.service.dismiss({ taskId: done.id, expectedHistoryRevision: 0 }), { code: 'SERVICE_STOPPED' });
  gate.release();
  await hiding; await closing;
  const persisted = JSON.parse(await readFile(f.journalPath(done.id), 'utf8'));
  assert.equal(persisted.dismissed, true);
  assert.equal(persisted.historyRevision, 1);
});

test('invalid stored history values are rejected instead of becoming legacy defaults', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  requireDismiss(f.service);
  const done = await f.finish(f.start());
  const record = structuredClone(f.durable.get(done.id));
  for (const fields of [
    { dismissed: 'false' }, { dismissed: null },
    { historyRevision: -1 }, { historyRevision: 0.5 }, { historyRevision: '0' },
    { historyRevision: null }, { historyRevision: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => {
      const unexpected = createTaskService({ manager: f.manager, initialTasks: [{ ...record, ...fields }], persistTask: f.persist });
      f.services.add(unexpected);
    }, { code: 'INVALID_STATE' });
  }
});

test('dismiss and retry refuse a history counter that cannot advance safely', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  requireDismiss(f.service);
  const failed = await f.finish(f.start([f.missing()]));
  const record = { ...structuredClone(f.durable.get(failed.id)), dismissed: false, historyRevision: Number.MAX_SAFE_INTEGER };
  await f.service.close();
  const restored = createTaskService({ manager: f.manager, initialTasks: [record], persistTask: f.persist });
  f.services.add(restored);
  await restored.get({ taskId: failed.id });
  const before = await readFile(f.journalPath(failed.id), 'utf8');
  await assert.rejects(restored.dismiss({ taskId: failed.id, expectedHistoryRevision: Number.MAX_SAFE_INTEGER }), { code: 'HISTORY_REVISION_EXHAUSTED' });
  await assert.rejects(restored.retry({ taskId: failed.id }), { code: 'HISTORY_REVISION_EXHAUSTED' });
  assert.equal((await restored.get({ taskId: failed.id })).historyRevision, Number.MAX_SAFE_INTEGER);
  assert.equal(await readFile(f.journalPath(failed.id), 'utf8'), before);
});
