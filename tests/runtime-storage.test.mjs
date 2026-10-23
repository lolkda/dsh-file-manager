import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { LIMIT_DEFAULTS } from '../dist/contracts/limits.js';
import { openOperationState } from '../dist/host/state.js';
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

/**
 * The deployed plugin browses the filesystem root, so a fixture addresses its
 * isolated directory the way a user would: by a path relative to `/`. Every
 * write below therefore still lands inside the temporary tree, never in `/`.
 */
const fromRoot = absolute => path.relative('/', absolute);

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

/** Send one control request through a booted Host. */
async function call(instance, payload) {
  const route = ['tasks.start', 'tasks.retry', 'transfers.begin'].includes(payload.op) ? 'manifest' : 'control';
  const response = await instance.routes.get(`/api/file-manager/v2/${route}`).fetch(new Request(`http://localhost/api/file-manager/v2/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.value;
}

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
  const send = (instance, payload) => call(instance, { requestId: `history-runtime-${++requestSerial}`, ...payload });
  const first = boot();
  await apply(first.ctx, {});
  const rootId = (await send(first, { op: 'bootstrap' })).root.id;
  const retained = fromRoot(path.join(files, 'retained.txt'));
  await send(first, { op: 'entries.create-file', rootId, path: retained });
  const task = await send(first, { op: 'transfers.begin', direction: 'download', rootId, path: retained });
  const response = await first.routes.get('/api/file-manager/v2/download').fetch(new Request(`http://localhost/api/file-manager/v2/download?taskId=${task.id}`));
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  const closed = await send(first, { op: 'activities.dismiss', items: [{ kind: 'transfer', taskId: task.id, expectedHistoryRevision: 0 }] });
  assert.equal(closed.results[0].outcome, 'dismissed');
  await first.close();
  const second = boot();
  await apply(second.ctx, {});
  const stored = await send(second, { op: 'transfers.get', taskId: task.id });
  assert.equal(stored.dismissed, true);
  assert.equal(stored.historyRevision, 1);
  assert.equal(stored.status, 'completed');
  assert.equal(stored.completion, 'server-stream-finished');
  assert.equal(await readFile(path.join(files, 'retained.txt'), 'utf8'), '');
  assert.equal((await send(second, { op: 'bootstrap' })).capabilities.taskHistory, true);
});

test('a failed journal initialization disables file operations without aborting Host startup', { skip: skipWithoutRuntime }, async t => {
  const { boot } = await fixture(t);
  const instance = boot();
  const originalOpen = instance.ctx.storageDomain.open.bind(instance.ctx.storageDomain);
  let opens = 0;
  const opened = [];
  const messages = [];
  instance.ctx.logger.error = message => messages.push(message);
  instance.ctx.storageDomain.open = async spec => {
    opened.push(spec.name);
    if (++opens === 1) throw Object.assign(new Error('injected damaged journal medium'), { code: 'malformed-medium' });
    return originalOpen(spec);
  };
  await assert.doesNotReject(() => apply(instance.ctx), 'optional file management storage failure must not abort the whole Host');
  assert.equal(instance.ctx.storageDomain.get('local_file_manager'), undefined, 'no directory-location store is opened any more');
  assert.deepEqual(opened, ['local_file_manager_operations'], 'the browsing root itself is never durable');
  const control = instance.routes.get('/api/file-manager/v2/control');
  assert.ok(control, 'the degraded state must remain observable');
  const send = async (op, extra = {}) => {
    const response = await control.fetch(new Request('http://localhost/api/file-manager/v2/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, path: 'new.txt', requestId: 'failed-storage-request', ...extra }) }));
    return { status: response.status, body: await response.json() };
  };
  // The client must be able to explain the degradation, so bootstrap still answers.
  const bootstrap = await send('bootstrap');
  assert.equal(bootstrap.status, 200, JSON.stringify(bootstrap.body));
  assert.deepEqual(bootstrap.body.value.degraded, {
    scope: 'operations', code: 'malformed-medium',
    message: 'The operation journal is unavailable; the file manager is read-only.', readOnly: true,
  });
  assert.equal(bootstrap.body.value.root.path, '/', 'the browsing root is still reported while the journal is degraded');
  assert.equal(bootstrap.body.value.capabilities.write, false);
  assert.equal(bootstrap.body.value.capabilities.tasks, false);
  // Writes are refused with the degradation scope, and the journal is never reset.
  const refused = await send('entries.create-file');
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, 'FILE_MANAGER_UNAVAILABLE');
  assert.equal(refused.body.error.details.scope, 'operations');
  assert.ok(messages.some(message => String(message).includes('malformed-medium')));
  assert.equal(instance.routes.has('/api/file-manager/v2/upload'), true, 'the v2 surface stays mounted');
  const upload = await instance.routes.get('/api/file-manager/v2/upload').fetch(new Request('http://localhost/api/file-manager/v2/upload?taskId=missing&itemId=missing', { method: 'POST', body: 'x' }));
  assert.equal(upload.status, 503, 'transfers are not composed while the journal is unavailable');
});

test('the deployed storage is never asked for directory locations', { skip: skipWithoutRuntime }, async t => {
  const { boot } = await fixture(t);
  const first = boot();
  const opened = [];
  const originalOpen = first.ctx.storageDomain.open.bind(first.ctx.storageDomain);
  first.ctx.storageDomain.open = async spec => { opened.push(spec.name); return originalOpen(spec); };
  await apply(first.ctx, {});
  assert.deepEqual(opened, ['local_file_manager_operations']);
  assert.equal(first.ctx.storageDomain.get('local_file_manager'), undefined);
  assert.ok(first.ctx.storageDomain.get('local_file_manager_operations'), 'the operation journal is the only durable state');
  await first.close();
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

test('the mounted Host browses the filesystem root and restarts without any stored location', { skip: skipWithoutRuntime }, async t => {
  const { boot } = await fixture(t);
  const first = boot();
  await assert.doesNotReject(() => apply(first.ctx, { maxTextBytes: 4096 }), 'a valid Host composition must not fail during storage initialization');
  assert.equal(first.routes.size, 6, 'the frozen v2 route table registers six routes');
  const before = await call(first, { op: 'bootstrap' });
  assert.equal(before.root.path, '/');
  assert.equal(before.root.label, '/');
  assert.match(before.root.identity, /^\d+:\d+$/);
  assert.equal('roots' in before, false, 'the removed roots array must not come back');
  assert.equal('workspaces' in before, false, 'no workspace candidate is offered as a location');
  assert.equal('persistentRoots' in before.capabilities, false, 'locations are no longer persisted');
  assert.equal(before.capabilities.write, true);
  assert.equal(before.capabilities.tasks, true);
  assert.equal(before.capabilities.transfers, true);
  assert.equal(before.limits.maxTextBytes, 4096, 'the Loader config row is what the mounted surface serves');
  // The real `/` is browsed read-only; nothing here ever writes to it.
  const listing = await call(first, { op: 'entries.list', rootId: before.root.id, path: '' });
  assert.equal(listing.rootId, before.root.id);
  assert.equal(listing.path, '');
  assert.ok(listing.total > 0, 'the process filesystem root really lists');
  assert.ok(listing.entries.some(entry => entry.name === 'etc' && entry.kind === 'directory'), 'a real root directory is listed');
  assert.ok(listing.entries.every(entry => entry.name && entry.path === entry.name), 'every entry is addressed relative to the root');
  await first.close();
  // A cold restart re-opens the same directory, so the same identity yields the
  // same id even though nothing about the root survived on disk.
  const second = boot();
  await apply(second.ctx, { maxTextBytes: 4096 });
  const after = await call(second, { op: 'bootstrap' });
  assert.equal(after.root.id, before.root.id);
  assert.equal(after.root.identity, before.root.identity);
  assert.equal(LIMIT_DEFAULTS.maxTextBytes, 5 * 1024 ** 2, 'unset limits keep their contract defaults');
});
