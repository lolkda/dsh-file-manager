import assert from 'node:assert/strict';
import { watch as nativeWatch } from 'node:fs';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createManager } from '../dist/host/manager.js';
import * as plugin from '../dist/index.js';

async function watchModule() {
  let module;
  try { module = await import('../dist/host/watch.js'); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND' || error.url !== new URL('../dist/host/watch.js', import.meta.url).href) throw error; }
  assert.equal(typeof module?.createWatchService, 'function', 'the OS watch service is missing');
  return module;
}
function events(t) {
  const buffered = [];
  const waits = new Set();
  t.after(() => { for (const wait of waits) clearTimeout(wait.timer); });
  return {
    receive(event) {
      const match = [...waits].find(wait => wait.predicate(event));
      if (match) { waits.delete(match); clearTimeout(match.timer); match.resolve(event); }
      else buffered.push(event);
    },
    next(predicate) {
      const index = buffered.findIndex(predicate);
      if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const wait = { predicate, resolve, timer: null };
        wait.timer = setTimeout(() => { waits.delete(wait); reject(new Error('Expected filesystem event was not observed.')); }, 2500);
        waits.add(wait);
      });
    },
  };
}
async function fixture(t, options = {}) {
  const { createWatchService } = await watchModule();
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-watch-'));
  const manager = createManager();
  const grant = await manager.addRoot({ path: root });
  const service = createWatchService({ manager, pollIntervalMs: 30, debounceMs: 5, ...options });
  t.after(async () => { await service.close(); await manager.close(); await rm(root, { recursive: true, force: true }); });
  return { root, manager, grant, service, target: { rootId: grant.id, path: '' } };
}

test('an external file creation invalidates the watched directory without fs/observed', async t => {
  const { root, service, target, manager } = await fixture(t);
  const stream = events(t);
  const release = await service.subscribe([target], stream.receive);
  t.after(release);
  assert.equal((await stream.next(event => event.kind === 'watch-status')).status, 'watching');
  const next = stream.next(event => event.kind === 'invalidate' && event.reason === 'watch');
  await writeFile(path.join(root, 'external.txt'), 'outside the manager');
  assert.equal((await next).rootId, target.rootId);
  assert.ok((await manager.list(target)).entries.some(entry => entry.name === 'external.txt'));
});

test('an editor-style atomic replacement triggers a fresh directory observation', async t => {
  const { root, service, target } = await fixture(t);
  await writeFile(path.join(root, 'file'), 'old');
  const stream = events(t);
  const release = await service.subscribe([target], stream.receive);
  t.after(release);
  const next = stream.next(event => event.kind === 'invalidate' && event.reason === 'watch');
  await writeFile(path.join(root, '.replacement'), 'new');
  await rename(path.join(root, '.replacement'), path.join(root, 'file'));
  await next;
  assert.equal(await readFile(path.join(root, 'file'), 'utf8'), 'new');
});

test('unsupported native watching falls back to periodic reconciliation', async t => {
  const { root, service, target } = await fixture(t, { watchFactory() { throw Object.assign(new Error('unsupported'), { code: 'ENOSYS' }); } });
  const stream = events(t);
  const release = await service.subscribe([target], stream.receive);
  t.after(release);
  assert.equal((await stream.next(event => event.kind === 'watch-status')).status, 'polling');
  await writeFile(path.join(root, 'polled'), 'seen');
  const event = await stream.next(value => value.kind === 'invalidate' && value.reason === 'reconcile');
  assert.equal(event.path, '');
});

test('revoking a root disables its observation instead of following an ungranted path', async t => {
  const { manager, grant, service, target } = await fixture(t);
  const stream = events(t);
  const release = await service.subscribe([target], stream.receive);
  t.after(release);
  await manager.removeRoot({ rootId: grant.id });
  const event = await stream.next(value => value.kind === 'watch-status' && value.status === 'unavailable');
  assert.equal(event.rootId, grant.id);
});

test('subscriptions share one OS watcher and release it with the last subscriber', async t => {
  let opened = 0;
  let closed = 0;
  const { service, target } = await fixture(t, { watchFactory(address, options, listener) {
    opened++;
    const watcher = nativeWatch(address, options, listener);
    return { on: (...args) => watcher.on(...args), close() { closed++; watcher.close(); } };
  } });
  const first = await service.subscribe([target], () => {});
  const second = await service.subscribe([target, target], () => {});
  assert.equal(opened, 1);
  await first();
  assert.equal(closed, 0);
  await second();
  assert.equal(closed, 1);
  await second();
  assert.equal(closed, 1);
});

async function readEvent(reader, predicate) {
  const decoder = new TextDecoder();
  for (let index = 0; index < 100; index++) {
    const { value, done } = await reader.read();
    assert.equal(done, false, 'the stream ended before the expected event');
    const frame = JSON.parse(decoder.decode(value).trim().replace(/^data:\s*/, ''));
    if (predicate(frame)) return frame;
  }
  assert.fail('too many unrelated events before the expected frame');
}

test('the event response carries OS invalidations and task events with per-connection sequence numbers', async t => {
  const module = await watchModule();
  assert.equal(typeof module.createEventHub, 'function', 'the event broadcast hub is missing');
  assert.equal(typeof plugin.createEventHandler, 'function', 'the event response adapter is missing');
  const { root, service, target } = await fixture(t);
  const hub = module.createEventHub();
  const controller = new AbortController();
  const handler = plugin.createEventHandler({ watcher: service, events: hub });
  const response = await handler(new Request('http://localhost/api/file-manager/v2/events', { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targets: [target] }) }));
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = response.body.getReader();
  const deadline = setTimeout(() => controller.abort(), 2500);
  try {
    const ready = await readEvent(reader, event => event.kind === 'ready');
    assert.equal(ready.seq, 1);
    await readEvent(reader, event => event.kind === 'watch-status' && event.status === 'watching');
    hub.publish({ kind: 'task', taskId: 'task-1' });
    const task = await readEvent(reader, event => event.kind === 'task');
    assert.equal(task.taskId, 'task-1');
    await writeFile(path.join(root, 'event.txt'), 'new');
    const changed = await readEvent(reader, event => event.kind === 'invalidate' && event.reason === 'watch');
    assert.ok(changed.seq > task.seq);
  } finally { clearTimeout(deadline); controller.abort(); await reader.cancel(); hub.close(); }
});

test('an overloaded event consumer receives an explicit resynchronization frame', async t => {
  const module = await watchModule();
  assert.equal(typeof module.createEventHub, 'function', 'the event broadcast hub is missing');
  assert.equal(typeof plugin.createEventHandler, 'function', 'the event response adapter is missing');
  const { service } = await fixture(t);
  const hub = module.createEventHub();
  const handler = plugin.createEventHandler({ watcher: service, events: hub, maxQueuedEvents: 4 });
  const response = await handler(new Request('http://localhost/api/file-manager/v2/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targets: [] }) }));
  const reader = response.body.getReader();
  try {
    await readEvent(reader, event => event.kind === 'ready');
    for (let index = 0; index < 20; index++) hub.publish({ kind: 'task', taskId: String(index) });
    assert.equal((await readEvent(reader, event => event.kind === 'ready' && event.reason === 'overflow')).reason, 'overflow');
  } finally { await reader.cancel(); hub.close(); }
});

test('an aborted subscription releases its watcher without another request', async t => {
  let closed = 0;
  const { service, target } = await fixture(t, { watchFactory(address, options, listener) {
    const watcher = nativeWatch(address, options, listener);
    return { on: (...args) => watcher.on(...args), close() { closed++; watcher.close(); } };
  } });
  const controller = new AbortController();
  const release = await service.subscribe([target], () => {}, { signal: controller.signal });
  controller.abort();
  await release();
  assert.equal(closed, 1);
});
