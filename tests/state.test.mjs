import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { LIMIT_DEFAULTS, resolveLimits } from '../dist/contracts/limits.js';
import { createManager } from '../dist/host/manager.js';

async function stateModule() {
  let module;
  try { module = await import('../dist/host/state.js'); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND' || error.url !== new URL('../dist/host/state.js', import.meta.url).href) throw error; }
  assert.equal(typeof module?.openOperationState, 'function', 'the operation journal adapter is missing');
  return module;
}

// The profile adapter that owned the root-grant store is retired: the browsing
// root is opened by the manager itself and nothing about it is durable. These
// unit tests use an in-memory journal boundary; they do not prove the deployed
// backend's naming or disk contract. runtime-storage.test.mjs does that.
function journalProfile() {
  const tables = new Map();
  let failNext = false;
  return {
    failOnce() { failNext = true; },
    ctx: { storageDomain: { async open(spec) {
      return {
        table(name) {
          if (!tables.has(name)) tables.set(name, new Map());
          const table = tables.get(name);
          return {
            entries: () => table.entries(),
            async put(key, value) {
              if (failNext) { failNext = false; throw new Error('journal unavailable'); }
              table.set(key, spec.tables[name].valueSchema.parse(structuredClone(value)));
            },
          };
        },
        async close() {},
      };
    } } },
  };
}
const copyRecord = () => ({ id: 'copy-1', operation: 'move', status: 'running', items: [{ id: 'i1', source: { rootId: 'root', path: 'file' }, checkpoint: { phase: 'published', sha256: 'opaque-hash', destination: { rootId: 'root', path: 'new' } } }] });

test('operation journals retain private recovery checkpoints across reopening', async () => {
  const module = await stateModule();
  assert.equal(typeof module.openOperationState, 'function', 'the operation journal adapter is missing');
  const fixture = journalProfile();
  const first = await module.openOperationState(fixture.ctx);
  await first.taskOptions.persistTask(copyRecord());
  await first.close();
  const second = await module.openOperationState(fixture.ctx);
  assert.deepEqual(second.taskOptions.initialTasks[0].items[0].checkpoint, copyRecord().items[0].checkpoint);
  await second.close();
});

test('operation journals restore upload state without stripping private metadata', async () => {
  const module = await stateModule();
  assert.equal(typeof module.openOperationState, 'function', 'the operation journal adapter is missing');
  const fixture = journalProfile();
  const state = await module.openOperationState(fixture.ctx);
  const transfer = { id: 'transfer-1', type: 'transfer', direction: 'upload', rootId: 'root', path: '', status: 'running', items: [{ id: 'i1', kind: 'file', path: 'file', size: 1, privateRecovery: { version: 'v1' } }], privateContainerIdentity: '1:2' };
  await state.transferOptions.persistTasks([transfer]);
  await state.close();
  const reopened = await module.openOperationState(fixture.ctx);
  assert.deepEqual(reopened.transferOptions.initialTasks[0], transfer);
  await reopened.close();
});

test('a failed journal write is not cached as durable and can be retried', async () => {
  const module = await stateModule();
  assert.equal(typeof module.openOperationState, 'function', 'the operation journal adapter is missing');
  const fixture = journalProfile();
  const state = await module.openOperationState(fixture.ctx);
  fixture.failOnce();
  await assert.rejects(state.taskOptions.persistTask(copyRecord()), /journal unavailable/);
  await state.taskOptions.persistTask(copyRecord());
  await state.close();
  const reopened = await module.openOperationState(fixture.ctx);
  assert.equal(reopened.taskOptions.initialTasks.length, 1);
  await reopened.close();
});

test('journal writes capture an immutable request-time checkpoint snapshot', async () => {
  const module = await stateModule();
  const fixture = journalProfile();
  const state = await module.openOperationState(fixture.ctx);
  const record = copyRecord();
  const saving = state.taskOptions.persistTask(record);
  record.items[0].checkpoint.sha256 = 'later mutation';
  await saving;
  await state.close();
  const reopened = await module.openOperationState(fixture.ctx);
  assert.equal(reopened.taskOptions.initialTasks[0].items[0].checkpoint.sha256, 'opaque-hash');
  await reopened.close();
});

test('the root-grant storage adapter is retired, not merely unused', async () => {
  const module = await stateModule();
  assert.equal('openProfileState' in module, false, 'the profile storage adapter must be gone');
  assert.equal('ProfileState' in module, false, 'its contract type must be gone too');
});

test('a manager needs no storage service: the root is opened, not restored', async () => {
  // `createManager` takes no plugin context at all. Nothing about the root can
  // be read back from disk, so a fresh process always opens the directory it is
  // configured with and never inherits another process's locations.
  assert.equal(createManager.length <= 1, true, 'the manager factory takes only its own options');
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-no-root-store-'));
  const manager = createManager({ rootPath: base });
  try {
    const root = manager.getRoot();
    assert.match(root.id, /^[0-9a-f]{32}$/);
    assert.equal(root.path, base);
    assert.deepEqual(await manager.list({ rootId: root.id, path: '' }), {
      rootId: root.id, path: '', entries: [], unaddressable: [], total: 0, nextCursor: null,
    });
  } finally {
    await manager.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('the resolved profile limits are the caller\'s to carry into the manager', async () => {
  const limits = resolveLimits({ maxTextBytes: 4096, maxVerificationBytes: 8192, deletePlanTtlMs: 60000 });
  assert.equal(limits.maxTextBytes, 4096);
  assert.equal(limits.maxVerificationBytes, 8192);
  assert.equal(limits.deletePlanTtlMs, 60000);
  assert.equal(limits.transferConcurrency, LIMIT_DEFAULTS.transferConcurrency, 'unset limits keep their contract defaults');
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-limited-'));
  const manager = createManager({
    rootPath: base, maxTextBytes: limits.maxTextBytes, maxVerificationBytes: limits.maxVerificationBytes, deletePlanTtlMs: limits.deletePlanTtlMs,
  });
  try {
    await writeFile(path.join(base, 'small.txt'), 'ok');
    await writeFile(path.join(base, 'large.txt'), 'x'.repeat(limits.maxTextBytes + 1));
    assert.equal((await manager.readText({ rootId: manager.getRoot().id, path: 'small.txt' })).text, 'ok');
    await assert.rejects(manager.readText({ rootId: manager.getRoot().id, path: 'large.txt' }),
      { code: 'TOO_LARGE' }, 'the resolved limits really reach the manager');
  } finally {
    await manager.close();
    await rm(base, { recursive: true, force: true });
  }
});
