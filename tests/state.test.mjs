import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { LIMIT_DEFAULTS, resolveLimits } from '../dist/contracts/limits.js';
import { createManager } from '../dist/host/manager.js';

async function stateModule() {
  let module;
  try { module = await import('../dist/host/state.js'); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND' || error.url !== new URL('../dist/host/state.js', import.meta.url).href) throw error; }
  assert.equal(typeof module?.openProfileState, 'function', 'the profile storage adapter is missing');
  return module;
}

// Adapter unit tests use an in-memory service boundary; they do not prove the
// deployed backend's naming or disk contract. runtime-storage.test.mjs does that.
// The adapter takes the already-resolved limits, so no settings service is faked:
// DSH 0.1.7-rc.1 has no runtime namespace registration to fake.
function profile() {
  const records = new Map();
  let closeCount = 0;
  let lastSpec;
  return {
    get closeCount() { return closeCount; },
    get spec() { return lastSpec; },
    ctx: {
      storageDomain: {
        async open(spec) {
          lastSpec = spec;
          if (!records.has(spec.name)) records.set(spec.name, structuredClone(spec.global.initial));
          spec.global.schema.parse(records.get(spec.name));
          return {
            global: {
              get: () => structuredClone(records.get(spec.name)),
              async set(value) { records.set(spec.name, spec.global.schema.parse(value)); },
            },
            async close() { closeCount++; },
          };
        },
      },
    },
  };
}

test('profile storage restores explicit grants after the Host adapter is reopened', async t => {
  const { openProfileState } = await stateModule();
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-domain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = profile();
  const limits = resolveLimits();
  const first = await openProfileState(fixture.ctx, limits);
  const manager = createManager(first.managerOptions);
  const grant = await manager.addRoot({ path: root });
  await first.close();
  const reopened = await openProfileState(fixture.ctx, limits);
  const restored = createManager(reopened.managerOptions);
  assert.equal(restored.listRoots()[0].id, grant.id);
  await restored.removeRoot({ rootId: grant.id });
  await reopened.close();
  const third = await openProfileState(fixture.ctx, limits);
  assert.deepEqual(createManager(third.managerOptions).listRoots(), []);
  await third.close();
  assert.equal(fixture.closeCount, 3);
});

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

test('the resolved profile limits reach the manager options', async () => {
  const { openProfileState } = await stateModule();
  const fixture = profile();
  const limits = resolveLimits({ maxTextBytes: 4096, maxVerificationBytes: 8192, deletePlanTtlMs: 60000 });
  const state = await openProfileState(fixture.ctx, limits);
  assert.equal(state.managerOptions.maxTextBytes, 4096);
  assert.equal(state.managerOptions.maxVerificationBytes, 8192);
  assert.equal(state.managerOptions.deletePlanTtlMs, 60000);
  assert.equal(limits.transferConcurrency, LIMIT_DEFAULTS.transferConcurrency, 'unset limits keep their contract defaults');
  await state.close();
});

test('profile schema rejects corrupt grants instead of quietly treating them as empty', async () => {
  const { openProfileState } = await stateModule();
  const fixture = profile();
  const state = await openProfileState(fixture.ctx, resolveLimits());
  const invalid = { revision: 1, roots: [{ id: 'root', provider: 'ssh', path: '/same-spelling', identity: '1:2', label: 'not-local', createdAt: new Date().toISOString() }] };
  assert.equal(fixture.spec.global.schema.safeParse(invalid).success, false);
  await state.close();
});
