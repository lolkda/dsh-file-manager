import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { LIMIT_DEFAULTS, resolveLimits } from '../dist/contracts/limits.js';
import { openOperationState, openProfileState } from '../dist/host/state.js';
import { createManager } from '../dist/host/manager.js';
import { apply } from '../dist/index.js';

// Resolve the deployed implementation, not a duplicate in-memory persistence fake.
// Set FILE_MANAGER_DSH_RUNTIME_ROOT when testing another DSH installation. A machine
// or runner without one reports an explicit skip instead of crashing the whole file.
const runtimeRoot = process.env.FILE_MANAGER_DSH_RUNTIME_ROOT ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh';
const runtimeAvailable = existsSync(path.join(runtimeRoot, 'package.json'));
const skipWithoutRuntime = runtimeAvailable ? false : `no DSH runtime at ${runtimeRoot}; set FILE_MANAGER_DSH_RUNTIME_ROOT to run this suite against a real installation`;
const runtimeRequire = runtimeAvailable ? createRequire(path.join(runtimeRoot, 'package.json')) : undefined;
const runtime = name => import(pathToFileURL(runtimeRequire.resolve(name)).href);
const [{ BackendRegistry } = {}, { JsonStorageBackend } = {}, { DomainFacility } = {}] = runtimeAvailable ? await Promise.all([
  runtime('@deepseek-ai/dsh-storage'), runtime('@deepseek-ai/dsh-storage-json'), runtime('@deepseek-ai/dsh-storage-domain'),
]) : [];

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-real-storage-'));
  const files = path.join(base, 'files');
  await mkdir(files);
  const instances = new Set();
  t.after(async () => {
    for (const instance of instances) await instance.close();
    await rm(base, { recursive: true, force: true });
  });
  function boot() {
    const backend = new JsonStorageBackend(path.join(base, 'state'));
    const registry = new BackendRegistry();
    registry.register('json', backend);
    const emitter = new EventEmitter();
    const disposers = [];
    const routes = new Map();
    const ctx = {
      storage: { backend: registry },
      emit: emitter.emit.bind(emitter),
      logger: { warn: console.warn, error: console.error },
      workspaceRegistry: { list: () => [] },
      connection: { fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path); } } },
      effect(callback) { const dispose = callback(); disposers.push(dispose); return dispose; },
    };
    const domains = new DomainFacility(ctx, { backend: 'json', routes: {} });
    ctx.storageDomain = domains;
    let closing;
    const instance = {
      ctx, routes,
      close() {
        return closing ??= (async () => {
          for (const dispose of disposers.reverse()) await dispose?.();
          await domains.closeAll();
          await backend.close();
          instances.delete(instance);
        })();
      },
    };
    instances.add(instance);
    return instance;
  }
  return { base, files, boot };
}

const record = () => ({ id: 'move-1', operation: 'move', status: 'failed', items: [{ id: 'item-1', checkpoint: { targetParent: { rootId: 'root-1', path: '', identity: '1:2' }, removed: ['source/b'] } }] });

test('history metadata rejects invalid flags and revisions before modifying deployed storage', { skip: skipWithoutRuntime }, async t => {
  const { boot } = await fixture(t);
  const instance = boot();
  const state = await openOperationState(instance.ctx);
  const task = { ...record(), dismissed: false, historyRevision: 0 };
  const transfer = { id: 'history-transfer', type: 'transfer', direction: 'download', rootId: 'root-1', path: 'file', status: 'completed', items: [], dismissed: false, historyRevision: 0 };
  await state.taskOptions.persistTask(task);
  await state.transferOptions.persistTasks([transfer]);
  for (const invalid of [{ dismissed: 'closed' }, { historyRevision: -1 }, { historyRevision: 1.5 }, { historyRevision: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(() => state.taskOptions.persistTask({ ...task, ...invalid }), 'invalid task visibility metadata must not be accepted');
    await assert.rejects(() => state.transferOptions.persistTasks([{ ...transfer, ...invalid }]), 'invalid transfer visibility metadata must not be accepted');
  }
  await state.close(); await instance.close();
  const reopenedInstance = boot();
  const reopened = await openOperationState(reopenedInstance.ctx);
  assert.deepEqual(reopened.taskOptions.initialTasks, [task]);
  assert.deepEqual(reopened.transferOptions.initialTasks, [transfer]);
  await reopened.close();
});

test('closed history metadata survives cold JSON reopening without removing private recovery proofs', { skip: skipWithoutRuntime }, async t => {
  const { boot } = await fixture(t);
  const first = boot();
  const state = await openOperationState(first.ctx);
  const task = { ...record(), dismissed: true, historyRevision: 1 };
  const transfer = { id: 'closed-transfer', type: 'transfer', direction: 'upload', rootId: 'root-1', path: '', status: 'interrupted', items: [{ id: 'item-1', path: 'file', committed: true, identity: '7:9' }], dismissed: true, historyRevision: 3 };
  await state.taskOptions.persistTask(task);
  await state.transferOptions.persistTasks([transfer]);
  await state.close(); await first.close();
  const second = boot();
  const reopened = await openOperationState(second.ctx);
  assert.deepEqual(reopened.taskOptions.initialTasks, [task]);
  assert.deepEqual(reopened.transferOptions.initialTasks, [transfer]);
  assert.deepEqual(reopened.taskOptions.initialTasks[0].items[0].checkpoint, record().items[0].checkpoint);
  await reopened.close();
});

test('a dismissed real download remains dismissed after Host teardown and cold reopening', { skip: skipWithoutRuntime }, async t => {
  const { files, boot } = await fixture(t);
  let requestSerial = 0;
  const call = async (instance, payload) => {
    const route = ['tasks.start', 'tasks.retry', 'transfers.begin'].includes(payload.op) ? 'manifest' : 'control';
    const response = await instance.routes.get(`/api/file-manager/v2/${route}`).fetch(new Request(`http://localhost/api/file-manager/v2/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: `history-runtime-${++requestSerial}`, ...payload }),
    }));
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body.value;
  };
  const first = boot(); await apply(first.ctx);
  const grant = await call(first, { op: 'roots.add', path: files });
  await call(first, { op: 'entries.create-file', rootId: grant.id, path: 'retained.txt' });
  const task = await call(first, { op: 'transfers.begin', direction: 'download', rootId: grant.id, path: 'retained.txt' });
  const response = await first.routes.get('/api/file-manager/v2/download').fetch(new Request(`http://localhost/api/file-manager/v2/download?taskId=${task.id}`));
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  const closed = await call(first, { op: 'activities.dismiss', items: [{ kind: 'transfer', taskId: task.id, expectedHistoryRevision: 0 }] });
  assert.equal(closed.results[0].outcome, 'dismissed');
  await first.close();
  const second = boot(); await apply(second.ctx);
  const stored = await call(second, { op: 'transfers.get', taskId: task.id });
  assert.equal(stored.dismissed, true);
  assert.equal(stored.historyRevision, 1);
  assert.equal(stored.status, 'completed');
  assert.equal(stored.completion, 'server-stream-finished');
  assert.equal(await readFile(path.join(files, 'retained.txt'), 'utf8'), '');
  assert.equal((await call(second, { op: 'bootstrap' })).capabilities.taskHistory, true);
});

test('a failed journal initialization disables file operations without aborting Host startup', { skip: skipWithoutRuntime }, async t => {
  const { files, boot } = await fixture(t);
  const instance = boot();
  const originalOpen = instance.ctx.storageDomain.open.bind(instance.ctx.storageDomain);
  let opens = 0;
  const messages = [];
  instance.ctx.logger.error = message => messages.push(message);
  instance.ctx.storageDomain.open = async spec => {
    if (++opens === 2) throw Object.assign(new Error('injected damaged journal medium'), { code: 'malformed-medium' });
    return originalOpen(spec);
  };
  await assert.doesNotReject(() => apply(instance.ctx), 'optional file management storage failure must not abort the whole Host');
  assert.ok(instance.ctx.storageDomain.get('local_file_manager'), 'trustworthy root grants keep serving reads while the journal is unavailable');
  const control = instance.routes.get('/api/file-manager/v2/control');
  assert.ok(control, 'the degraded state must remain observable');
  const send = async (op, extra = {}) => {
    const response = await control.fetch(new Request('http://localhost/api/file-manager/v2/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, path: files, requestId: 'failed-storage-request', ...extra }) }));
    return { status: response.status, body: await response.json() };
  };
  // The client must be able to explain the degradation, so bootstrap still answers.
  const bootstrap = await send('bootstrap');
  assert.equal(bootstrap.status, 200, JSON.stringify(bootstrap.body));
  assert.deepEqual(bootstrap.body.value.degraded, {
    scope: 'operations', code: 'malformed-medium',
    message: 'The operation journal is unavailable; the file manager is read-only.', readOnly: true,
  });
  assert.equal(bootstrap.body.value.capabilities.write, false);
  assert.equal(bootstrap.body.value.capabilities.tasks, false);
  // Writes are refused with the degradation scope, and the journal is never reset.
  const refused = await send('roots.add');
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, 'FILE_MANAGER_UNAVAILABLE');
  assert.equal(refused.body.error.details.scope, 'operations');
  assert.ok(messages.some(message => String(message).includes('malformed-medium')));
  assert.equal(instance.routes.has('/api/file-manager/v2/upload'), true, 'the v2 surface stays mounted');
  const upload = await instance.routes.get('/api/file-manager/v2/upload').fetch(new Request('http://localhost/api/file-manager/v2/upload?taskId=missing&itemId=missing', { method: 'POST', body: 'x' }));
  assert.equal(upload.status, 503, 'transfers are not composed while the journal is unavailable');
});

test('the deployed JSON storage accepts root metadata and restores an explicit grant after a cold reopen', { skip: skipWithoutRuntime }, async t => {
  const { files, boot } = await fixture(t);
  const first = boot();
  let state;
  await assert.doesNotReject(async () => { state = await openProfileState(first.ctx, resolveLimits()); }, 'root storage declarations must satisfy the deployed backend contract');
  assert.equal(state.managerOptions.maxTextBytes, LIMIT_DEFAULTS.maxTextBytes, 'the adapter carries the caller-resolved limits');
  const manager = createManager(state.managerOptions);
  const grant = await manager.addRoot({ path: files });
  await manager.close();
  await state.close();
  await first.close();
  const second = boot();
  const reopened = await openProfileState(second.ctx, resolveLimits());
  const restored = createManager(reopened.managerOptions);
  assert.equal(restored.listRoots()[0].id, grant.id);
  await restored.close();
  await reopened.close();
});

test('the deployed JSON storage durably preserves operation checkpoints and transfer metadata', { skip: skipWithoutRuntime }, async t => {
  const { boot } = await fixture(t);
  const first = boot();
  let state;
  await assert.doesNotReject(async () => { state = await openOperationState(first.ctx); }, 'journal storage declarations must satisfy the deployed backend contract');
  const transfer = { id: 'transfer-1', type: 'transfer', direction: 'upload', rootId: 'root-1', path: '', status: 'interrupted', items: [{ id: 'file-1', kind: 'file', path: 'file', size: 3, committed: false }] };
  await state.taskOptions.persistTask(record());
  await state.transferOptions.persistTasks([transfer]);
  await state.close();
  await first.close();
  const second = boot();
  const reopened = await openOperationState(second.ctx);
  assert.deepEqual(reopened.taskOptions.initialTasks[0], record());
  assert.deepEqual(reopened.transferOptions.initialTasks[0], transfer);
  await reopened.close();
});

test('the full Host plugin mounts against deployed storage and persists its root through teardown and restart', { skip: skipWithoutRuntime }, async t => {
  const { files, boot } = await fixture(t);
  const first = boot();
  await assert.doesNotReject(() => apply(first.ctx, { maxTextBytes: 4096 }), 'a valid Host composition must not fail during storage initialization');
  assert.equal(first.routes.size, 6, 'the frozen v2 route table registers six routes');
  const call = async (instance, payload) => {
    const response = await instance.routes.get('/api/file-manager/v2/control').fetch(new Request('http://localhost/api/file-manager/v2/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }));
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body.value;
  };
  const grant = await call(first, { op: 'roots.add', path: files, requestId: 'runtime-root-add' });
  await call(first, { op: 'entries.create-file', rootId: grant.id, path: 'created.txt', requestId: 'runtime-file-create' });
  assert.equal(await readFile(path.join(files, 'created.txt'), 'utf8'), '');
  await first.close();
  const second = boot();
  await apply(second.ctx, { maxTextBytes: 4096 });
  const bootstrap = await call(second, { op: 'bootstrap' });
  assert.equal(bootstrap.roots[0].id, grant.id);
  assert.equal(bootstrap.capabilities.persistentRoots, true);
  assert.equal(bootstrap.capabilities.tasks, true);
  assert.equal(bootstrap.capabilities.transfers, true);
  assert.equal(bootstrap.limits.maxTextBytes, 4096, 'the Loader config row is what the mounted surface serves');
});
