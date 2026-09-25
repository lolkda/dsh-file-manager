/**
 * Frozen-contract tests for `src/contracts`.
 *
 * These tests are the executable form of `docs/CONTRACT.md`. They are built from
 * three kinds of assertion:
 *
 * 1. **Freeze** — the op list, the mutation classification, the Host error-code
 *    list, the limit defaults, the envelope sizes and the v2 route table are
 *    asserted literally, so a later change cannot quietly weaken them.
 * 2. **Behavior** — every op accepts a valid sample and rejects invalid ones;
 *    version tokens separate metadata snapshots from content versions; public
 *    views drop recovery proof; error normalization keeps cancellation distinct
 *    from I/O failure.
 * 3. **Oracle** — while the pre-port JavaScript still exists, the frozen lists are
 *    cross-checked against it: every code it mints and every op it dispatches must
 *    be covered, and the mutation classification is verified by calling the legacy
 *    handler without a request id. When that safety net is removed, the same tests
 *    fall back to the frozen literals instead of passing vacuously.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');

async function load(relative) {
  try {
    return await import(new URL(relative, import.meta.url));
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes('/dist/contracts/')) {
      throw new Error('dist/contracts is missing: run `npm run build` (or `npx tsc -p tsconfig.host.json`) before the contract tests.');
    }
    throw error;
  }
}

/**
 * The engine that owns path grammar: the ported build when it exists, otherwise
 * the pre-port JavaScript that still acts as the safety net.
 */
async function loadEngine() {
  for (const candidate of ['../dist/host/manager.js', '../host/manager.js']) {
    if (!existsSync(fileURLToPath(new URL(candidate, import.meta.url)))) continue;
    const module = await import(new URL(candidate, import.meta.url));
    if (typeof module.createManager === 'function') return module;
  }
  return undefined;
}

const errors = await load('../dist/contracts/errors.js');
const limits = await load('../dist/contracts/limits.js');
const views = await load('../dist/contracts/views.js');
const protocol = await load('../dist/contracts/protocol.js');

const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const WEAK = '1700000000:4242:17:1700000000000000000:1700000000000000001';
const STRONG = `${WEAK}:${'a'.repeat(64)}`;
const ISO = '2025-01-01T00:00:00.000Z';

/** Read the legacy implementation files that still act as the safety net. */
function legacySources() {
  const files = ['index.js', 'contracts/errors.js'];
  const host = path.join(root, 'host');
  if (existsSync(host)) {
    for (const name of readdirSync(host)) if (name.endsWith('.js')) files.push(`host/${name}`);
  }
  return files
    .map(name => path.join(root, name))
    .filter(file => existsSync(file))
    .map(file => readFileSync(file, 'utf8'));
}

/* ------------------------------------------------------------------ *
 * 1. Freeze
 * ------------------------------------------------------------------ */

test('the frozen control op list is exactly the documented set', () => {
  assert.deepEqual([...protocol.CONTROL_OPS], [
    'bootstrap', 'roots.list', 'roots.add', 'roots.remove',
    'entries.list', 'entries.stat', 'entries.reference', 'text.read',
    'entries.create-file', 'entries.create-directory', 'entries.rename',
    'delete.prepare', 'delete.commit', 'activities.dismiss',
    'tasks.start', 'tasks.list', 'tasks.get', 'tasks.cancel', 'tasks.retry',
    'transfers.begin', 'transfers.list', 'transfers.get', 'transfers.cancel', 'transfers.retry',
  ]);
  assert.deepEqual([...protocol.TEXT_OPS], ['save']);
  assert.deepEqual([...protocol.MUTATION_OPS], [
    'roots.add', 'roots.remove', 'entries.create-file', 'entries.create-directory', 'entries.rename',
    'delete.commit', 'activities.dismiss', 'tasks.start', 'tasks.cancel', 'tasks.retry',
    'transfers.begin', 'transfers.cancel', 'transfers.retry',
  ]);
});

test('every control op has exactly one result schema', () => {
  assert.deepEqual(Object.keys(protocol.CONTROL_RESULTS).sort(), [...protocol.CONTROL_OPS].sort());
});

test('the frozen Host error-code list cannot shrink', () => {
  const baseline = [
    'ALREADY_EXISTS', 'ATOMIC_RENAME_UNCERTAIN', 'CANCELLED', 'CHECKSUM_MISMATCH', 'CLEANUP_FAILED',
    'CONFIRMATION_REQUIRED', 'DIRECTORY_CHANGED', 'DIRECTORY_CONFLICT', 'FEATURE_UNAVAILABLE',
    'FILE_MANAGER_UNAVAILABLE', 'HISTORY_REVISION_EXHAUSTED', 'INCOMPLETE_DOWNLOAD', 'INITIALIZATION_FAILED',
    'INTERRUPTED', 'INVALID_CURSOR', 'INVALID_MANIFEST', 'INVALID_PATH', 'INVALID_REQUEST', 'INVALID_STATE',
    'INVALID_TEXT', 'IO_ERROR', 'ITEM_NOT_FOUND', 'ITEM_NOT_READY', 'LINE_ENDING_MAPPING_LIMIT',
    'NO_FAILED_ITEMS', 'NO_SPACE', 'NOT_DIRECTORY', 'NOT_FOUND', 'PATH_CHANGED', 'PERMISSION_DENIED',
    'PERSISTENCE_FAILED', 'PLAN_EXPIRED', 'PLAN_NOT_FOUND', 'RECOVERY_REQUIRED', 'REQUEST_ID_REUSED',
    'RESOURCE_CLOSED', 'ROOT_CHANGED', 'ROOT_NOT_FOUND', 'ROOT_OPERATION_NOT_ALLOWED', 'ROOT_UNAVAILABLE',
    'SAME_ENTRY', 'SELF_DESCENDANT', 'SERVICE_STOPPED', 'SIZE_MISMATCH', 'SOURCE_DELETE_FAILED',
    'STRONG_VERSION_REQUIRED', 'TASK_BUSY', 'TASK_CHANGED', 'TASK_NOT_FOUND', 'TASK_PERSISTENCE_FAILED',
    'TOO_LARGE', 'TOO_MANY_REQUESTS', 'UNREPRESENTABLE_REFERENCE', 'UNSUPPORTED_ATOMIC_RENAME',
    'UNSUPPORTED_ENCODING', 'UNSUPPORTED_ENTRY', 'UNSUPPORTED_PLATFORM', 'VERSION_CONFLICT', 'VERSION_REQUIRED',
  ];
  const frozen = new Set(errors.HOST_ERROR_CODES);
  for (const code of baseline) assert.ok(frozen.has(code), `${code} must stay in HOST_ERROR_CODES`);
  for (const code of errors.HOST_ERROR_CODES) assert.match(code, /^[A-Z][A-Z0-9_]+$/, `${code} must be a stable code`);
});

test('limit defaults, envelope sizes and route table are frozen', () => {
  assert.deepEqual({ ...limits.LIMIT_DEFAULTS }, {
    maxTextBytes: 5 * 1024 ** 2,
    maxFileBytes: 2 * 1024 ** 3,
    maxTaskBytes: 10 * 1024 ** 3,
    maxTaskEntries: 10000,
    transferConcurrency: 2,
    pollIntervalMs: 2000,
    deletePlanTtlMs: 300000,
    maxVerificationBytes: 10 * 1024 ** 3,
  });
  assert.equal(limits.CONTROL_ENVELOPE_BYTES, 256 * 1024);
  assert.equal(limits.MANIFEST_ENVELOPE_BYTES, 16 * 1024 ** 2);
  assert.deepEqual([...limits.MANIFEST_OPS], ['tasks.start', 'tasks.retry', 'transfers.begin']);
  assert.equal(limits.HEAVY_IO_QUEUE_LIMIT, 64);
  assert.equal(limits.SMALL_BODY_ADMISSION, 8);
  assert.equal(limits.LARGE_BODY_ADMISSION, 2);
  assert.equal(limits.SETTINGS_NAMESPACE, 'local-file-manager');
  assert.equal(limits.STORAGE_NAMESPACE, 'local_file_manager');
  assert.equal(limits.OPERATIONS_STORAGE_NAMESPACE, 'local_file_manager_operations');
  assert.equal(limits.WIRE_STAGE, 'basic-management');
  assert.deepEqual({ ...protocol.ROUTES }, {
    control: { path: '/api/file-manager/v2/control', methods: ['POST'], requestBody: 'streaming' },
    manifest: { path: '/api/file-manager/v2/manifest', methods: ['POST'], requestBody: 'streaming' },
    text: { path: '/api/file-manager/v2/text', methods: ['POST'], requestBody: 'streaming' },
    upload: { path: '/api/file-manager/v2/upload', methods: ['POST'], requestBody: 'streaming' },
    download: { path: '/api/file-manager/v2/download', methods: ['GET'], requestBody: 'buffered' },
    events: { path: '/api/file-manager/v2/events', methods: ['POST'], requestBody: 'streaming' },
  });
  for (const legacy of protocol.LEGACY_ROUTES) assert.equal(legacy.startsWith('/api/file-manager/') && !legacy.includes('/v2/'), true);
  assert.equal(protocol.routeEnvelopeBytes('control'), limits.CONTROL_ENVELOPE_BYTES);
  assert.equal(protocol.routeEnvelopeBytes('manifest'), limits.MANIFEST_ENVELOPE_BYTES);
  assert.equal(protocol.routeAdmission('control'), limits.SMALL_BODY_ADMISSION);
  assert.equal(protocol.routeAdmission('download'), limits.LARGE_BODY_ADMISSION);
});

test('the public limits DTO covers exactly the frozen limit names', () => {
  assert.deepEqual([...protocol.PUBLIC_LIMIT_NAMES].sort(), Object.keys(limits.LIMIT_DEFAULTS).sort());
  const view = protocol.publicLimitsOf({ ...limits.LIMIT_DEFAULTS });
  assert.deepEqual(view, { ...limits.LIMIT_DEFAULTS });
});

/* ------------------------------------------------------------------ *
 * 2. Oracle against the pre-port implementation
 * ------------------------------------------------------------------ */

test('the frozen op list covers every operation the legacy wire dispatcher routes', () => {
  // Only `index.js` defines the wire contract. A service-level switch (for
  // example `transfers.dismiss`) is an internal capability, not a wire op; the
  // Host exposes history closing exclusively through `activities.dismiss`.
  const dispatcher = path.join(root, 'index.js');
  if (!existsSync(dispatcher)) {
    // The safety net is gone: the freeze assertion above is the remaining guarantee.
    assert.equal(protocol.CONTROL_OPS.length, 24);
    assert.equal(protocol.isMutationOp('transfers.dismiss'), false);
    return;
  }
  const source = readFileSync(dispatcher, 'utf8');
  const dispatched = new Set([...source.matchAll(/case '([a-z][a-z.-]*)':/g)].map(match => match[1]));
  assert.ok(dispatched.size > 0, 'the legacy dispatcher must still list its operations');
  const known = new Set([...protocol.CONTROL_OPS, ...protocol.TEXT_OPS]);
  for (const op of dispatched) assert.ok(known.has(op), `${op} is dispatched but not in the frozen op list`);
  const serviceOnly = new Set();
  for (const file of readdirSync(path.join(root, 'host'))) {
    if (!file.endsWith('.js')) continue;
    const hostSource = readFileSync(path.join(root, 'host', file), 'utf8');
    for (const match of hostSource.matchAll(/case '(transfers\.[a-z]+)':/g)) serviceOnly.add(match[1]);
  }
  for (const op of serviceOnly) {
    if (dispatched.has(op)) continue;
    assert.equal(protocol.CONTROL_OPS.includes(op), false, `${op} is service-only and must not become a wire op implicitly`);
  }
});

test('the frozen error-code list covers every code the legacy implementation mints', () => {
  const sources = legacySources();
  const minted = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/(?:fail|new FileManagerError)\(\s*'([A-Z][A-Z0-9_]+)'/g)) minted.add(match[1]);
  }
  if (minted.size === 0) {
    assert.ok(errors.HOST_ERROR_CODES.includes('VERSION_CONFLICT'));
    return;
  }
  for (const code of minted) assert.ok(errors.isHostErrorCode(code), `${code} is minted but missing from HOST_ERROR_CODES`);
});

test('mutation classification matches the shipped dispatcher requirement', async () => {
  // The oracle is the shipped implementation itself. A missing build must fail
  // loudly instead of degrading into a frozen-constant check that proves nothing.
  for (const artifact of ['dist/index.js', 'dist/host/manager.js', 'dist/host/tasks.js', 'dist/host/transfers.js', 'dist/host/watch.js']) {
    assert.ok(existsSync(path.join(root, artifact)), `${artifact} is missing; run npm run build before the suite`);
  }
  const { createControlHandler } = await import(new URL('../dist/index.js', import.meta.url));
  const { createManager } = await import(new URL('../dist/host/manager.js', import.meta.url));
  const { createTaskService } = await import(new URL('../dist/host/tasks.js', import.meta.url));
  const { createTransferService } = await import(new URL('../dist/host/transfers.js', import.meta.url));
  const { createWatchService } = await import(new URL('../dist/host/watch.js', import.meta.url));
  const manager = createManager();
  const tasks = createTaskService({ manager });
  const transfers = createTransferService({ manager });
  const watcher = createWatchService({ manager });
  const handler = createControlHandler({ manager, tasks, transfers, watcher, workspaces: () => [] });
  try {
    const call = async payload => {
      const response = await handler(new Request('http://localhost/api/file-manager/control', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      }));
      return { status: response.status, body: await response.json() };
    };
    for (const op of protocol.CONTROL_OPS) {
      // The oracle is a difference, not a fixed message: removing the request id
      // must change the outcome for exactly the mutation operations. Pinning the
      // dispatcher's wording would only re-test the contract layer's phrasing.
      const without = { ...validRequests[op] };
      delete without.requestId;
      const withId = { ...validRequests[op], requestId: 'oracle-request-id-0001' };
      const a = await call(without);
      const b = await call(withId);
      if (protocol.isMutationOp(op)) {
        assert.equal(a.status, 400, `${op} is a mutation, so a missing request id must be refused (got ${a.status})`);
        assert.equal(a.body?.error?.code, 'INVALID_REQUEST', `${op} must refuse a missing request id with INVALID_REQUEST`);
        const stillRefusedForId = b.status === 400 && b.body?.error?.code === 'INVALID_REQUEST'
          && typeof b.body.error.message === 'string' && b.body.error.message.includes('requestId');
        assert.equal(stillRefusedForId, false, `${op} must not refuse a request that carries a request id`);
      } else {
        assert.deepEqual(a, b, `${op} is a read operation, so its outcome must not depend on a request id`);
      }
    }
  } finally {
    await watcher.close();
    await transfers.close();
    await tasks.close();
    await manager.close();
  }
});

/* ------------------------------------------------------------------ *
 * 3. Request admission
 * ------------------------------------------------------------------ */

const validRequests = {
  bootstrap: { op: 'bootstrap' },
  'roots.list': { op: 'roots.list' },
  'roots.add': { op: 'roots.add', path: '/tmp', requestId: 'roots-add-request' },
  'roots.remove': { op: 'roots.remove', rootId: 'root-1', requestId: 'roots-remove-request' },
  'entries.list': { op: 'entries.list', rootId: 'root-1', path: '', limit: 200 },
  'entries.stat': { op: 'entries.stat', rootId: 'root-1', path: 'nested/file.txt' },
  'entries.reference': { op: 'entries.reference', rootId: 'root-1', path: 'nested' },
  'text.read': { op: 'text.read', rootId: 'root-1', path: 'file.txt' },
  'entries.create-file': { op: 'entries.create-file', rootId: 'root-1', path: 'new.txt', requestId: 'create-file-request' },
  'entries.create-directory': { op: 'entries.create-directory', rootId: 'root-1', path: 'new-dir', requestId: 'create-dir-request' },
  'entries.rename': { op: 'entries.rename', rootId: 'root-1', path: 'old.txt', name: 'new.txt', expectedVersion: WEAK, requestId: 'rename-request' },
  'delete.prepare': { op: 'delete.prepare', items: [{ rootId: 'root-1', path: 'file.txt' }] },
  'delete.commit': { op: 'delete.commit', scope: 'selected-trees', planId: 'plan-1', confirmed: true, requestId: 'delete-commit-request' },
  'activities.dismiss': {
    op: 'activities.dismiss', requestId: 'dismiss-request',
    items: [{ kind: 'transfer', taskId: 'task-1', expectedHistoryRevision: 0 }],
  },
  'tasks.start': {
    op: 'tasks.start', operation: 'copy', destination: { rootId: 'root-1', path: 'dest' },
    items: [{ rootId: 'root-1', path: 'source.txt', expectedVersion: STRONG, conflict: 'overwrite', expectedTargetVersion: STRONG }],
    requestId: 'tasks-start-request',
  },
  'tasks.list': { op: 'tasks.list' },
  'tasks.get': { op: 'tasks.get', taskId: 'task-1' },
  'tasks.cancel': { op: 'tasks.cancel', taskId: 'task-1', requestId: 'tasks-cancel-request' },
  'tasks.retry': { op: 'tasks.retry', taskId: 'task-1', items: [{ id: 'item-1', conflict: 'skip' }], requestId: 'tasks-retry-request' },
  'transfers.begin': {
    op: 'transfers.begin', direction: 'upload', rootId: 'root-1', path: '',
    items: [{ path: 'file.txt', kind: 'file', size: 3 }], requestId: 'transfers-begin-request',
  },
  'transfers.list': { op: 'transfers.list' },
  'transfers.get': { op: 'transfers.get', taskId: 'task-1' },
  'transfers.cancel': { op: 'transfers.cancel', taskId: 'task-1', requestId: 'transfers-cancel-request' },
  'transfers.retry': { op: 'transfers.retry', taskId: 'task-1', requestId: 'transfers-retry-request' },
};

test('every op accepts its documented request shape', () => {
  assert.deepEqual(Object.keys(validRequests).sort(), [...protocol.CONTROL_OPS].sort());
  for (const op of protocol.CONTROL_OPS) {
    const parsed = protocol.parseControlRequest(validRequests[op]);
    assert.equal(parsed.op, op);
  }
  const download = protocol.parseControlRequest({
    op: 'transfers.begin', direction: 'download', rootId: 'root-1', path: 'file.txt', expectedVersion: STRONG,
    requestId: 'transfers-download-request',
  });
  assert.equal(download.direction, 'download');
  const text = protocol.parseTextRequest({ op: 'save', rootId: 'root-1', path: 'file.txt', text: 'draft', expectedVersion: STRONG, requestId: 'text-save-request' });
  assert.equal(text.op, 'save');
  const events = protocol.parseEventRequest({ targets: [{ rootId: 'root-1', path: '' }] });
  assert.equal(events.targets.length, 1);
});

test('invalid control payloads are rejected at the contract boundary', () => {
  const rejected = [
    null, undefined, 'bootstrap', 7, [], {}, { op: 'unknown' }, { op: 12 },
    { op: 'entries.list' },
    { op: 'entries.stat', rootId: 'root-1' },
    { op: 'entries.stat', rootId: 'root-1', path: 42 },
    { op: 'entries.list', rootId: 'root-1', limit: 0 },
    { op: 'entries.list', rootId: 'root-1', limit: 501 },
    { op: 'roots.remove', rootId: 'root-1' },
    { op: 'roots.remove', rootId: 'root-1', requestId: 'short' },
    { op: 'delete.prepare', items: [] },
    { op: 'delete.prepare', items: [{ path: 'file.txt' }] },
    { op: 'activities.dismiss', requestId: 'dismiss-request', items: [] },
    { op: 'activities.dismiss', requestId: 'dismiss-request', items: [{ kind: 'disk-file', taskId: 'task-1', expectedHistoryRevision: 0 }] },
    { op: 'activities.dismiss', requestId: 'dismiss-request', items: [{ kind: 'task', taskId: 'task-1', expectedHistoryRevision: -1 }] },
    { op: 'activities.dismiss', requestId: 'dismiss-request', items: [{ kind: 'task', taskId: 'task-1', expectedHistoryRevision: 0.5 }] },
    { op: 'activities.dismiss', requestId: 'dismiss-request', items: [{ kind: 'task', taskId: '', expectedHistoryRevision: 0 }] },
    { op: 'activities.dismiss', requestId: 'dismiss-request', items: [{ kind: 'task', taskId: 'task-1', expectedHistoryRevision: 0, path: '/must-not-be-consumed' }] },
    { op: 'tasks.start', operation: 'delete', items: [{ rootId: 'root-1', path: 'a', expectedVersion: STRONG }], destination: { rootId: 'root-1', path: '' }, requestId: 'tasks-start-request' },
    { op: 'tasks.start', operation: 'copy', items: [], destination: { rootId: 'root-1', path: '' }, requestId: 'tasks-start-request' },
    { op: 'tasks.retry', taskId: 'task-1', items: [{ id: 'item-1', rootId: 'root-2' }], requestId: 'tasks-retry-request' },
    { op: 'transfers.begin', direction: 'sideways', rootId: 'root-1', path: '', requestId: 'transfers-begin-request' },
    { op: 'transfers.begin', direction: 'upload', rootId: 'root-1', path: '', items: [{ path: 'a', kind: 'file', size: -1 }], requestId: 'transfers-begin-request' },
  ];
  for (const payload of rejected) {
    assert.throws(() => protocol.parseControlRequest(payload), (error) => {
      assert.equal(error.code, 'INVALID_REQUEST', `payload ${JSON.stringify(payload)?.slice(0, 120)} must be refused`);
      assert.equal(error.status, 400);
      return true;
    });
  }
  assert.throws(() => protocol.parseTextRequest({ op: 'create', rootId: 'root-1', path: 'a', text: '' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => protocol.parseTextRequest({ op: 'save', rootId: 'root-1', path: 'a', text: '' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => protocol.parseEventRequest({ targets: Array.from({ length: 129 }, () => ({ rootId: 'r', path: '' })) }), { code: 'INVALID_REQUEST' });
});

test('the engine owns path grammar so the wire keeps INVALID_PATH', async () => {
  // The contract admits every path shape; the grammar (traversal, absolute form,
  // dot segments, backslashes, length) is enforced by the engine, which answers
  // INVALID_PATH / 400 and keeps its specific Client wording.
  const malformed = ['../escape', 'nested/../../escape', 'a//b', '/absolute', 'C:/windows', 'bad\u0000name', 'back\\slash'];
  for (const path of malformed) {
    assert.equal(protocol.parseControlRequest({ op: 'entries.stat', rootId: 'root-1', path }).path, path);
    assert.notEqual(views.entryPathViolation(path), undefined, `${JSON.stringify(path)} must be documented as invalid`);
  }
  assert.equal(protocol.parseControlRequest({ op: 'roots.add', path: 'relative/path', requestId: 'roots-add-request' }).path, 'relative/path');
  assert.equal(protocol.parseControlRequest({ op: 'entries.rename', rootId: 'root-1', path: 'a', name: 'nested/name', requestId: 'rename-request' }).name, 'nested/name');
  assert.equal(views.entryPathViolation(''), undefined, 'the empty path is the granted root');
  assert.notEqual(views.entryPathViolation('', false), undefined);
  assert.notEqual(views.transferPathViolation('del\u007fname'), undefined);

  // Cross-check the documented grammar against the engine that implements it.
  const engine = await loadEngine();
  if (!engine) {
    // Both the ported and the pre-port engine are gone: the freeze assertion above stands.
    assert.equal(typeof views.entryPathViolation, 'function');
    return;
  }
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-fm-contract-paths-'));
  const manager = engine.createManager();
  try {
    await writeFile(path.join(directory, 'file.txt'), 'content');
    const grant = await manager.addRoot({ path: directory });
    for (const path of malformed) {
      await assert.rejects(manager.list({ rootId: grant.id, path }), { code: 'INVALID_PATH' }, `engine must refuse ${JSON.stringify(path)}`);
      await assert.rejects(manager.readText({ rootId: grant.id, path }), { code: 'INVALID_PATH' }, `engine must refuse reading ${JSON.stringify(path)}`);
    }
    await assert.rejects(manager.addRoot({ path: 'relative/path' }), { code: 'INVALID_PATH' });
    await assert.rejects(manager.rename({ rootId: grant.id, path: 'file.txt', name: 'nested/name', expectedVersion: '1:2:3:4:5' }), { code: 'INVALID_PATH' });
    await assert.rejects(manager.readText({ rootId: grant.id, path: '' }), { code: 'UNSUPPORTED_ENTRY' }, 'the root itself is not a text file');
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('semantic refusals that already have a business code stay with the Host', () => {
  // The contract admits these so the transfer/history engines keep their own
  // codes: an empty manifest and a directory overwrite are INVALID_MANIFEST/422,
  // and an oversized close batch is TOO_LARGE/413.
  assert.equal(protocol.parseControlRequest({ op: 'transfers.begin', direction: 'upload', rootId: 'root-1', path: '', items: [], requestId: 'transfers-begin-request' }).items.length, 0);
  assert.equal(protocol.parseControlRequest({
    op: 'transfers.begin', direction: 'upload', rootId: 'root-1', path: '',
    items: [{ path: 'a', kind: 'directory', size: 0, conflict: 'overwrite' }], requestId: 'transfers-begin-request',
  }).items[0].conflict, 'overwrite');
  const oversized = protocol.parseControlRequest({
    op: 'activities.dismiss', requestId: 'dismiss-request',
    items: Array.from({ length: 257 }, (_, index) => ({ kind: 'task', taskId: `task-${index}`, expectedHistoryRevision: 0 })),
  });
  assert.equal(oversized.items.length, 257);
});

test('the contract leaves version-token failures to the Host business codes', () => {
  // Absent tokens are admitted here and refused by the Host with its own code,
  // so the existing VERSION_REQUIRED / STRONG_VERSION_REQUIRED behaviour is kept.
  assert.equal(protocol.parseControlRequest({ op: 'entries.rename', rootId: 'root-1', path: 'a', name: 'b', requestId: 'rename-request' }).expectedVersion, undefined);
  assert.equal(protocol.parseTextRequest({ op: 'save', rootId: 'root-1', path: 'a', text: '', requestId: 'text-save-request' }).expectedVersion, undefined);
  assert.equal(protocol.parseControlRequest({ op: 'transfers.begin', direction: 'upload', rootId: 'root-1', path: '', items: [{ path: 'a', kind: 'file', size: 1, conflict: 'overwrite' }], requestId: 'transfers-begin-request' }).items[0].expectedVersion, undefined);
});

/* ------------------------------------------------------------------ *
 * 4. Version tokens
 * ------------------------------------------------------------------ */

test('metadata snapshots and content versions are different tokens', () => {
  assert.equal(views.isMetadataVersion(WEAK), true);
  assert.equal(views.isContentVersion(WEAK), false, 'a listing stamp is never a content version');
  assert.equal(views.isContentVersion(STRONG), true);
  assert.equal(views.isMetadataVersion(STRONG), false);
  assert.equal(views.metadataVersionOf(STRONG), WEAK);
  assert.equal(views.metadataVersionOf(WEAK), WEAK);
  assert.equal(views.requireEntryVersion(WEAK), WEAK);
  assert.equal(views.requireContentVersion(STRONG), STRONG);
});

test('a weak or malformed token can never satisfy a strong-version requirement', () => {
  for (const value of [WEAK, '', 'not-a-version', `${WEAK}:short`, `${WEAK}:${'A'.repeat(64)}`, undefined, 42]) {
    assert.throws(() => views.requireContentVersion(value), { code: 'STRONG_VERSION_REQUIRED', status: 409 });
  }
  for (const value of [undefined, null, '', 'nope', `${WEAK}:${'a'.repeat(63)}`]) {
    assert.throws(() => views.requireEntryVersion(value), { code: 'VERSION_REQUIRED', status: 409 });
  }
});

/* ------------------------------------------------------------------ *
 * 5. Error normalization
 * ------------------------------------------------------------------ */

test('an explicit failure keeps its code, status and details', () => {
  const original = new errors.FileManagerError('PLAN_EXPIRED', 'The deletion confirmation expired.', 409, { committed: true });
  assert.equal(errors.normalizeError(original), original);
  assert.deepEqual(views.toPublicError(original), {
    code: 'PLAN_EXPIRED', message: 'The deletion confirmation expired.', details: { committed: true },
  });
  assert.equal(errors.fail instanceof Function, true);
  assert.throws(() => errors.fail('CONFIRMATION_REQUIRED', 'Permanent deletion requires explicit confirmation.'), (error) => {
    assert.equal(error.name, 'FileManagerError');
    assert.equal(error.code, 'CONFIRMATION_REQUIRED');
    assert.equal(error.status, 400);
    assert.deepEqual(error.details, {});
    return true;
  });
});

test('system errno codes map to stable codes without leaking host details', () => {
  const mapped = [
    ['ENOENT', 'NOT_FOUND', 404],
    ['EACCES', 'PERMISSION_DENIED', 403],
    ['EPERM', 'PERMISSION_DENIED', 403],
    ['ENOTDIR', 'NOT_DIRECTORY', 422],
    ['ELOOP', 'UNSUPPORTED_ENTRY', 422],
    ['EEXIST', 'ALREADY_EXISTS', 409],
    ['ENOSPC', 'NO_SPACE', 507],
  ];
  for (const [errno, code, status] of mapped) {
    const failure = errors.normalizeError(Object.assign(new Error('raw'), { code: errno, details: { committed: true, path: '/secret', syscall: 'open' } }));
    assert.equal(failure.code, code, `${errno} must map to ${code}`);
    assert.equal(failure.status, status);
    assert.deepEqual(failure.details, { committed: true }, 'only whitelisted details may survive');
  }
  assert.equal(errors.normalizeError(Object.assign(new Error('quota'), { code: 'EDQUOT' })).code, 'IO_ERROR', 'the control profile keeps the legacy errno table');
  assert.equal(errors.normalizeError(Object.assign(new Error('quota'), { code: 'EDQUOT' }), { profile: 'transfer' }).code, 'NO_SPACE');
  assert.equal(errors.normalizeError(new Error('mystery')).code, 'IO_ERROR');
  assert.equal(errors.normalizeError(new Error('mystery')).status, 500);
  assert.equal(errors.normalizeError({ weird: true }).code, 'IO_ERROR');
});

test('cancellation never degrades into an ordinary I/O failure', () => {
  const abortError = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
  assert.equal(errors.normalizeError(abortError).code, 'CANCELLED');
  assert.equal(errors.normalizeError(abortError).status, 499);
  assert.equal(errors.normalizeError(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })).code, 'CANCELLED');
  assert.equal(errors.isCancellationCode('CANCELLED'), true);
  assert.equal(errors.isCancellationCode('ABORT_ERR'), true);
  assert.equal(errors.isCancellationCode('IO_ERROR'), false);
  assert.equal(errors.isCancellationError(abortError), true);
  const controller = new AbortController();
  controller.abort();
  assert.equal(errors.normalizeError(new Error('unclassified'), { signal: controller.signal }).code, 'CANCELLED');
  assert.equal(errors.normalizeError(Object.assign(new Error('gone'), { code: 'ENOENT' }), { signal: controller.signal }).code, 'NOT_FOUND');
  const deliberate = new errors.FileManagerError('CANCELLED', 'The read was cancelled.', 499);
  assert.equal(errors.normalizeError(deliberate), deliberate);
  assert.deepEqual(views.toPublicError(deliberate), { code: 'CANCELLED', message: 'The read was cancelled.', details: {} });
});

test('an unmapped errno becomes the closed-set IO_ERROR with its cause preserved', () => {
  // The wire code set is closed: a client can never branch on an unbounded set of
  // errno values. The raw errno survives in `details.cause` for diagnosis.
  const unmapped = errors.normalizeError(Object.assign(new Error('raw io failure'), { code: 'EIO', details: { committed: true } }));
  assert.equal(unmapped.code, 'IO_ERROR', 'EIO has no mapping and must not leak as a wire code');
  assert.equal(unmapped.status, 500);
  assert.deepEqual(unmapped.details, { committed: true, cause: 'EIO' });
  assert.deepEqual(views.toPublicError(Object.assign(new Error('raw'), { code: 'EXDEV' })).details, { cause: 'EXDEV' });
  assert.equal(errors.isUnmappedErrno('EIO'), true);
  assert.equal(errors.isUnmappedErrno('ENOSPC'), false, 'a mapped errno is not "unmapped"');
  assert.equal(errors.isUnmappedErrno('ENOENT'), false);
  assert.equal(errors.isUnmappedErrno('EDQUOT'), true, 'EDQUOT is unmapped in the control profile');
  assert.equal(errors.isUnmappedErrno('EDQUOT', 'transfer'), false, 'the transfer profile maps EDQUOT');
  assert.equal(errors.isErrnoCode('ENOSPC'), true, 'a mapped errno is still an errno, not a Host code');
  assert.equal(errors.isErrnoCode('VERSION_CONFLICT'), false, 'a Host business code is never an errno');

  // Mapped errnos keep their stable code and do not gain a cause entry.
  assert.deepEqual(errors.normalizeError(Object.assign(new Error('full'), { code: 'ENOSPC' })).details, {});

  // A persisted record carrying a raw errno is normalized on projection too.
  const stored = views.toPublicError({ code: 'EIO', message: 'stored raw failure', details: { committed: true } });
  assert.equal(stored.code, 'IO_ERROR');
  assert.deepEqual(stored.details, { committed: true, cause: 'EIO' });
  const storedFull = views.toPublicError({ code: 'ENOSPC', message: 'stored disk full', details: {} });
  assert.equal(storedFull.code, 'NO_SPACE', 'a mapped errno in a stored record maps to its stable code');
  assert.equal(storedFull.status, undefined, 'the DTO carries no status; the HTTP status does');
  assert.deepEqual(storedFull.details, {});
});

test('the public error DTO is bounded and JSON-only', () => {
  const parsed = views.PublicErrorSchema.parse({ code: 'IO_ERROR', message: 'failed', details: { committed: true, nested: { list: [1, 'a', null] } } });
  assert.deepEqual(parsed.details, { committed: true, nested: { list: [1, 'a', null] } });
  assert.equal(views.PublicErrorSchema.safeParse({ code: 'IO_ERROR', message: 'failed' }).success, false, 'details are always present');
  assert.equal(views.PublicErrorSchema.safeParse({ code: 'io_error', message: 'failed', details: {} }).success, false);
  assert.equal(views.PublicErrorSchema.safeParse({ code: 'IO_ERROR', message: '', details: {} }).success, false);
  assert.equal(views.PublicErrorSchema.safeParse({ code: 'IO_ERROR', message: 'failed', details: { cause: new Error('x') } }).success, false);
  assert.throws(
    () => views.toPublicError(new errors.FileManagerError('IO_ERROR', 'failed', 500, { cause: new Error('nested') })),
    { code: 'INVALID_STATE', status: 500 },
    'a non-serializable detail is an internal fault, not a wire payload',
  );
});

/* ------------------------------------------------------------------ *
 * 6. Public views drop recovery proof
 * ------------------------------------------------------------------ */

function taskRecord() {
  return {
    id: 'task-1', operation: 'copy', status: 'failed', createdAt: ISO, updatedAt: ISO,
    dismissed: false, historyRevision: 2, canDismiss: true, cancelRequested: true,
    destination: { rootId: 'root-1', path: 'dest' }, conflict: 'skip',
    progress: { total: 1, completed: 0, failed: 1, skipped: 0, cancelled: 0, bytes: 3, totalBytes: 10 },
    persistenceError: { code: 'PERSISTENCE_FAILED', message: 'receipt not persisted', details: { committed: true } },
    items: [{
      id: 'item-1', conflict: 'overwrite', name: 'renamed.txt', attempts: 2, bytesTransferred: 3,
      source: { rootId: 'root-1', path: 'source.txt', expectedVersion: STRONG },
      expectedTargetVersion: STRONG,
      destination: { rootId: 'root-1', path: 'dest/renamed.txt' },
      status: 'failed',
      checkpoint: {
        phase: 'published', removed: ['source.txt'], targetParent: { rootId: 'root-1', path: 'dest', identity: '1:2' },
        manifest: [{ rootId: 'root-1', path: 'source.txt', sha256: 'b'.repeat(64) }],
        receipt: { identity: '1:2', version: STRONG },
      },
      measured: { entries: 1, bytes: 10 },
      result: {
        destination: {
          rootId: 'root-1', path: 'dest/renamed.txt', kind: 'file', size: 3, modifiedAt: ISO,
          version: STRONG, identity: '1:2', mode: 420, metadataVersion: WEAK, sha256: 'b'.repeat(64), bytes: 3,
        },
        bytes: 3, sourceRemoved: false, method: 'copy',
      },
      error: { code: 'SOURCE_DELETE_FAILED', message: 'source cleanup did not complete', details: { committed: true, sourceRemoved: false, bothCopiesExist: true, cause: 'EIO', removedPaths: [] } },
    }],
  };
}

test('a public task view keeps progress and the committed summary and drops recovery proof', () => {
  const view = views.toPublicTask(taskRecord());
  assert.deepEqual(view.progress, { total: 1, completed: 0, failed: 1, skipped: 0, cancelled: 0, bytes: 3, totalBytes: 10 });
  assert.equal(view.canDismiss, true);
  assert.equal(view.cancelRequested, true);
  assert.equal(view.historyRevision, 2);
  assert.equal(view.persistenceError.code, 'PERSISTENCE_FAILED');
  assert.deepEqual(view.items[0].result, {
    destination: { rootId: 'root-1', path: 'dest/renamed.txt', kind: 'file', size: 3, modifiedAt: ISO, version: STRONG, mode: 420 },
    bytes: 3, sourceRemoved: false, method: 'copy',
  });
  assert.deepEqual(view.items[0].error.details, { committed: true, sourceRemoved: false, bothCopiesExist: true, cause: 'EIO', removedPaths: [] });
  assert.equal(views.leaksRecoveryProof(view), undefined, 'no checkpoint, manifest, identity or digest may cross this boundary');
  const serialized = JSON.stringify(view);
  for (const field of ['checkpoint', 'measured', 'identity', 'sha256', 'metadataVersion', 'targetManifest', 'targetParent', 'manifest', 'receipt']) {
    assert.equal(serialized.includes(`"${field}"`), false, `${field} must not appear in a public task view`);
  }
});

test('a public transfer view keeps progress and drops verification handles', () => {
  const view = views.toPublicTransfer({
    id: 'transfer-1', type: 'transfer', direction: 'download', rootId: 'root-1', path: 'tree',
    status: 'partial', createdAt: 1700000000000, updatedAt: 1700000000001,
    dismissed: false, historyRevision: 1, canDismiss: true, bytesTransferred: 4, bytesTotal: 8,
    itemsTotal: 2, itemsCompleted: 1, wireBytesTransferred: 512, downloadKind: 'zip', downloadName: 'tree.zip',
    completion: 'server-stream-finished', destinationIdentity: '1:2', cancelRequested: true,
    error: { code: 'CHECKSUM_MISMATCH', message: 'archived member changed', details: { committed: false } },
    items: [
      {
        id: 'item-1', path: 'tree/a.txt', archivePath: 'tree/a.txt', kind: 'file', size: 4, mode: 420,
        modifiedAt: ISO, version: STRONG, identity: '1:3', sha256: 'c'.repeat(64),
        status: 'completed', bytesTransferred: 4, committed: true,
      },
      { id: 'item-2', path: 'tree/b.txt', kind: 'file', size: 4, status: 'failed', bytesTransferred: 0, committed: false, conflict: 'error', error: { code: 'VERSION_CONFLICT', message: 'changed', details: {} } },
    ],
  });
  assert.equal(view.itemsTotal, 2);
  assert.equal(view.itemsCompleted, 1);
  assert.equal(view.completion, 'server-stream-finished');
  assert.equal(view.downloadKind, 'zip');
  assert.equal(view.items[0].committed, true);
  assert.equal(view.items[1].error.code, 'VERSION_CONFLICT');
  assert.equal(view.items[1].archivePath, undefined, 'an upload item carries no archive path');
  assert.equal(views.leaksRecoveryProof(view), undefined);
  const serialized = JSON.stringify(view);
  for (const field of ['destinationIdentity', 'identity', 'sha256', 'version', 'mode', 'modifiedAt']) {
    assert.equal(serialized.includes(`"${field}"`), false, `${field} must not appear in a public transfer view`);
  }
});

test('a closed history record returns exactly the five documented fields', () => {
  const receipt = views.toActivityDismissedReceipt('transfer', 'transfer-1', {
    id: 'transfer-1', status: 'completed', dismissed: true, historyRevision: 1, canDismiss: false,
    items: [{ id: 'item-1', checkpoint: { phase: 'published' } }], bytesTotal: 8, checkpoint: { private: true },
  });
  assert.deepEqual(Object.keys(receipt.task).sort(), ['canDismiss', 'dismissed', 'historyRevision', 'id', 'status']);
  assert.equal(views.leaksRecoveryProof(receipt), undefined);
  const rejected = views.toActivityRejectedReceipt('task', 'task-1', new errors.FileManagerError('TASK_BUSY', 'Wait for the task to finish.', 409));
  assert.deepEqual(rejected, { kind: 'task', taskId: 'task-1', outcome: 'rejected', error: { code: 'TASK_BUSY', message: 'Wait for the task to finish.', details: {} } });
  assert.equal(protocol.ActivityDismissResultSchema.safeParse({ results: [receipt, rejected] }).success, true);
});

test('storage degradation is a required, discriminated bootstrap field (R17)', () => {
  const healthy = { ...validBootstrapView(), degraded: null };
  assert.equal(protocol.BootstrapViewSchema.safeParse(healthy).success, true);
  const operations = protocol.BootstrapViewSchema.parse({
    ...healthy,
    capabilities: { ...healthy.capabilities, write: false, tasks: false, transfers: false, taskHistory: false },
    degraded: { scope: 'operations', code: 'INITIALIZATION_FAILED', message: 'The operation journal could not be opened.', readOnly: true },
  });
  assert.equal(operations.degraded.scope, 'operations');
  assert.equal(operations.degraded.readOnly, true);
  const roots = protocol.BootstrapViewSchema.parse({
    ...healthy, roots: [],
    capabilities: { ...healthy.capabilities, write: false, references: false },
    degraded: { scope: 'roots', code: 'INITIALIZATION_FAILED', message: 'Stored root grants are not trustworthy.', readOnly: false },
  });
  assert.deepEqual(roots.roots, []);

  // `null` is the only healthy signal: an absent field is not.
  const withoutField = { ...healthy };
  delete withoutField.degraded;
  assert.equal(protocol.BootstrapViewSchema.safeParse(withoutField).success, false, 'degraded is always reported');
  // The union forbids the illegal combinations a boolean flag would allow.
  for (const degraded of [
    { scope: 'operations', code: 'X', message: 'm', readOnly: false },
    { scope: 'roots', code: 'X', message: 'm', readOnly: true },
    { scope: 'history', code: 'X', message: 'm', readOnly: true },
    { scope: 'operations', code: 'X', message: 'm' },
    { scope: 'operations', code: '', message: 'm', readOnly: true },
    { scope: 'operations', code: 'X', message: '', readOnly: true },
    { scope: 'operations', code: 'X', message: 'm', readOnly: true, extra: 1 },
  ]) {
    assert.equal(protocol.BootstrapViewSchema.safeParse({ ...healthy, degraded }).success, false, JSON.stringify(degraded));
  }
  // The refusal code is the existing one; no new code is minted for degradation.
  assert.ok(errors.isHostErrorCode('FILE_MANAGER_UNAVAILABLE'));
  assert.equal(errors.normalizeError(new errors.FileManagerError('FILE_MANAGER_UNAVAILABLE', 'unavailable', 503, { scope: 'operations' })).status, 503);
});

function validBootstrapView() {
  return {
    roots: [{ id: 'root-1', provider: 'host-local', path: '/srv/data', label: 'data', identity: '1:2', createdAt: ISO }],
    workspaces: [{ id: 'w1', path: '/candidate', title: 'Workspace' }],
    version: manifest.version,
    stage: 'basic-management',
    limits: { ...limits.LIMIT_DEFAULTS },
    capabilities: { write: true, persistentRoots: true, tasks: true, transfers: true, watch: true, references: true, taskHistory: true },
    degraded: null,
  };
}

test('unaddressable listing entries are structurally non-executable (R18)', () => {
  const unaddressable = { name: 'bad\\name', kind: 'file', reason: 'The name contains a backslash and cannot be addressed.' };
  const listing = {
    rootId: 'root-1', path: '', entries: [
      { name: 'a.txt', path: 'a.txt', kind: 'file', size: 1, modifiedAt: ISO, version: WEAK, mode: 420 },
    ],
    unaddressable: [unaddressable],
    total: 1, nextCursor: null,
  };
  const parsed = protocol.EntriesListResultSchema.parse(listing);
  // A real assertion: the projected entry carries exactly three keys and no path.
  assert.deepEqual(Object.keys(parsed.unaddressable[0]).sort(), ['kind', 'name', 'reason']);
  assert.equal('path' in parsed.unaddressable[0], false, 'an unaddressable entry must have no path field at all');
  assert.equal(JSON.stringify(parsed.unaddressable).includes('path'), false);

  // Strict shape: a path smuggled in is refused, and so is a missing or oversized reason.
  assert.equal(protocol.EntriesListResultSchema.safeParse({ ...listing, unaddressable: [{ ...unaddressable, path: 'bad%5Cname' }] }).success, false);
  assert.equal(protocol.EntriesListResultSchema.safeParse({ ...listing, unaddressable: [{ name: 'a', kind: 'file' }] }).success, false);
  assert.equal(protocol.EntriesListResultSchema.safeParse({ ...listing, unaddressable: [{ name: 'a', kind: 'file', reason: '' }] }).success, false);
  assert.equal(protocol.EntriesListResultSchema.safeParse({ ...listing, unaddressable: [{ name: 'a', kind: 'file', reason: 'x'.repeat(201) }] }).success, false);
  assert.equal(protocol.EntriesListResultSchema.safeParse({ ...listing, unaddressable: [{ name: '', kind: 'file', reason: 'r' }] }).success, false);
  assert.equal(protocol.EntriesListResultSchema.safeParse({ ...listing, unaddressable: [{ name: 'a', kind: 'fifo', reason: 'r' }] }).success, false);

  // The sibling array is part of the frozen result, not an optional extra.
  const withoutSiblings = { ...listing };
  delete withoutSiblings.unaddressable;
  assert.equal(protocol.EntriesListResultSchema.safeParse(withoutSiblings).success, false, 'unaddressable is always reported');

  // `entries` may only contain addressable paths: those names belong in the sibling array.
  for (const name of ['bad\\name', 'bad\u0000name']) {
    assert.equal(protocol.EntriesListResultSchema.safeParse({
      ...listing, entries: [{ name, path: name, kind: 'file', size: 1, modifiedAt: ISO, version: WEAK, mode: 420 }],
    }).success, false, `${JSON.stringify(name)} must not appear in entries`);
  }

  // The projector cannot invent a path either.
  const projected = views.toUnaddressableEntry({ name: unaddressable.name, kind: unaddressable.kind, reason: unaddressable.reason, path: 'leaked', identity: '1:2' });
  assert.deepEqual(projected, unaddressable);
  assert.equal(views.leaksRecoveryProof(projected), undefined);
  assert.throws(() => views.toUnaddressableEntry({ name: 'a', kind: 'file' }), { code: 'INVALID_STATE', status: 500 });

  // The engine, not a new code, reports the refusal.
  assert.ok(errors.isHostErrorCode('UNREPRESENTABLE_REFERENCE'));
});

test('an echoed version is only required to be a non-empty string', () => {
  // The engine accepts any non-empty echoed version (`versionOf`), so the public
  // projection must accept it too: one such record must never make the whole
  // history unreadable (R13/R17).
  const echoed = taskRecord();
  echoed.items[0].source.expectedVersion = 'missing';
  echoed.items[0].expectedTargetVersion = 'not-a-version';
  const view = views.toPublicTask(echoed);
  assert.equal(view.items[0].source.expectedVersion, 'missing', 'an echoed version is replayed verbatim');
  assert.equal(view.items[0].expectedTargetVersion, 'not-a-version');
  assert.deepEqual(view.items[0].result.destination.version, STRONG, 'a Host-minted receipt token keeps its grammar');

  // The same rule holds for the upload overwrite version on a transfer record.
  const transfer = views.toPublicTransfer({
    id: 'transfer-1', type: 'transfer', direction: 'upload', rootId: 'root-1', path: '',
    status: 'failed', createdAt: 1700000000000, updatedAt: 1700000000001,
    dismissed: false, historyRevision: 0, canDismiss: true,
    bytesTransferred: 0, bytesTotal: 1, itemsTotal: 1, itemsCompleted: 0,
    items: [{ id: 'item-1', path: 'a.txt', kind: 'file', size: 1, status: 'failed', bytesTransferred: 0, committed: false, conflict: 'overwrite', expectedVersion: 'v1' }],
  });
  assert.equal(transfer.items[0].expectedVersion, 'v1');

  // Empty is not a legal echo, so the boundary really is `min(1)`.
  const empty = taskRecord();
  empty.items[0].source.expectedVersion = '';
  assert.throws(() => views.toPublicTask(empty), { code: 'INVALID_STATE', status: 500 });
  const missing = taskRecord();
  delete missing.items[0].source.expectedVersion;
  assert.throws(() => views.toPublicTask(missing), { code: 'INVALID_STATE', status: 500 });
  const wrongType = taskRecord();
  wrongType.items[0].source.expectedVersion = 42;
  assert.throws(() => views.toPublicTask(wrongType), { code: 'INVALID_STATE', status: 500 });

  // Host-minted tokens stay strict: the strong/weak distinction is unchanged.
  const minted = taskRecord();
  minted.items[0].result.destination.version = 'not-a-token';
  assert.throws(() => views.toPublicTask(minted), { code: 'INVALID_STATE', status: 500 }, 'a Host-minted receipt version must match the token grammar');
  const weakReceipt = taskRecord();
  weakReceipt.items[0].result.destination.version = WEAK;
  assert.equal(views.toPublicTask(weakReceipt).items[0].result.destination.version, WEAK, 'a weak Host-minted stamp is still a legal token');

  // And the request side follows the same rule: the contract admits the echo, the
  // engine answers with its own code (VERSION_REQUIRED / STRONG_VERSION_REQUIRED /
  // VERSION_CONFLICT) when it really matters.
  const accepted = protocol.parseControlRequest({
    op: 'tasks.start', operation: 'copy', destination: { rootId: 'root-1', path: 'dest' },
    items: [{ rootId: 'root-1', path: 'a', expectedVersion: 'missing', conflict: 'overwrite', expectedTargetVersion: 'not-a-version' }],
    requestId: 'tasks-start-request',
  });
  assert.equal(accepted.items[0].expectedVersion, 'missing');
  assert.equal(accepted.items[0].expectedTargetVersion, 'not-a-version');
  for (const payload of [
    { op: 'entries.rename', rootId: 'root-1', path: 'a', name: 'b', expectedVersion: '', requestId: 'rename-request' },
    { op: 'tasks.retry', taskId: 'task-1', items: [{ id: 'i', expectedVersion: '' }], requestId: 'tasks-retry-request' },
    { op: 'transfers.begin', direction: 'upload', rootId: 'root-1', path: '', items: [{ path: 'a', kind: 'file', size: 1, conflict: 'overwrite', expectedVersion: '' }], requestId: 'transfers-begin-request' },
  ]) {
    assert.throws(() => protocol.parseControlRequest(payload), { code: 'INVALID_REQUEST', status: 400 }, JSON.stringify(payload).slice(0, 80));
  }
});

test('a stored record missing a required public field is reported, never silently trimmed', () => {
  const incomplete = taskRecord();
  delete incomplete.progress;
  assert.throws(() => views.toPublicTask(incomplete), { code: 'INVALID_STATE', status: 500 });
  const brokenItem = taskRecord();
  delete brokenItem.items[0].source.expectedVersion;
  assert.throws(() => views.toPublicTask(brokenItem), { code: 'INVALID_STATE', status: 500 });
  const wrongStatus = taskRecord();
  wrongStatus.items[0].status = 'finished';
  assert.throws(() => views.toPublicTask(wrongStatus), { code: 'INVALID_STATE', status: 500 });
});

test('root, listing, stat and text views expose their documented fields only', () => {
  const descriptor = views.toRootDescriptor({
    id: 'root-1', provider: 'host-local', path: '/srv/data', label: 'data', identity: '1:2', createdAt: ISO,
    secret: 'must-not-leak',
  });
  assert.deepEqual(descriptor, { id: 'root-1', provider: 'host-local', path: '/srv/data', label: 'data', identity: '1:2', createdAt: ISO });
  const snapshot = views.toEntrySnapshot({
    name: 'a.txt', path: 'a.txt', kind: 'file', size: 3, modifiedAt: ISO, version: WEAK, mode: 420,
    identity: '1:3', sha256: 'd'.repeat(64),
  });
  assert.deepEqual(Object.keys(snapshot).sort(), ['kind', 'mode', 'modifiedAt', 'name', 'path', 'size', 'version']);
  const stat = views.toEntryStat({
    rootId: 'root-1', path: 'a.txt', name: 'a.txt', kind: 'file', size: 3, modifiedAt: ISO, version: STRONG,
    identity: '1:3', mode: 420, metadataVersion: WEAK, sha256: 'd'.repeat(64),
  });
  assert.equal(stat.version, STRONG);
  assert.equal(stat.sha256, 'd'.repeat(64));
  const receipt = views.toTextReceipt({
    rootId: 'root-1', path: 'a.txt', text: 'body', bytes: 4, version: STRONG, encoding: 'utf-8', bom: false,
    newline: 'lf', mode: 420,
  });
  assert.equal('text' in receipt, false, 'a replayable receipt must not retain the whole body');
  assert.deepEqual(Object.keys(receipt).sort(), ['bom', 'bytes', 'encoding', 'mode', 'newline', 'path', 'rootId', 'version']);
});

test('the deletion plan and its outcome keep only the documented fields', () => {
  const plan = views.toDeletePlan({
    id: 'plan-1', scope: 'selected-trees', targets: [{ rootId: 'root-1', path: 'tree', extra: true }], entryCount: 1,
    expiresAt: 1700000000000, permanent: true,
    entries: [{ rootId: 'root-1', path: 'tree', kind: 'directory', size: 0, version: WEAK, identity: '1:2', children: ['a'] }],
    promise: null, result: null,
  });
  assert.deepEqual(plan, {
    id: 'plan-1', scope: 'selected-trees', targets: [{ rootId: 'root-1', path: 'tree' }], entryCount: 1, expiresAt: 1700000000000,
    permanent: true, entries: [{ rootId: 'root-1', path: 'tree', kind: 'directory', size: 0, version: WEAK }],
  });
  const outcome = views.toDeleteCommitResult({
    id: 'plan-1', status: 'partial',
    results: [
      { rootId: 'root-1', path: 'tree/a', status: 'completed', removed: true, identity: '1:3' },
      { rootId: 'root-1', path: 'tree/b', status: 'failed', removed: false, error: { code: 'VERSION_CONFLICT', message: 'changed', details: { secret: true } } },
    ],
  });
  assert.deepEqual(outcome.results[1].error, { code: 'VERSION_CONFLICT', message: 'changed' });
  assert.equal(JSON.stringify(outcome).includes('secret'), false);
  assert.equal(JSON.stringify(outcome).includes('identity'), false);
});

/* ------------------------------------------------------------------ *
 * 7. Event frames
 * ------------------------------------------------------------------ */

test('every documented SSE frame parses and unknown frames are refused', () => {
  const frames = [
    { kind: 'ready', reason: 'connected', seq: 1 },
    { kind: 'ready', reason: 'overflow', seq: 2 },
    { kind: 'heartbeat', seq: 3 },
    { kind: 'invalidate', reason: 'recovered', rootId: 'root-1', path: '', seq: 4 },
    { kind: 'watch-status', status: 'polling', code: 'WATCH_UNAVAILABLE', rootId: 'root-1', path: 'nested', seq: 5 },
    { kind: 'task', taskId: 'task-1', summary: { status: 'running', progress: { total: 1, completed: 0, failed: 0, skipped: 0, cancelled: 0, bytes: 0, totalBytes: 1 }, updatedAt: ISO }, seq: 6 },
    { kind: 'transfer', taskId: 'transfer-1', summary: { status: 'running', bytesTransferred: 1, bytesTotal: 2, itemsCompleted: 0, itemsTotal: 1 }, seq: 7 },
    { kind: 'error', code: 'IO_ERROR', seq: 8 },
    { kind: 'closed', seq: 9 },
  ];
  for (const frame of frames) assert.equal(protocol.EventFrameSchema.safeParse(frame).success, true, JSON.stringify(frame));
  assert.equal(protocol.EventFrameSchema.safeParse({ kind: 'nope', seq: 1 }).success, false);
  assert.equal(protocol.EventFrameSchema.safeParse({ kind: 'heartbeat' }).success, false, 'every frame carries a sequence number');
  assert.equal(protocol.EventFrameSchema.safeParse({ kind: 'watch-status', status: 'broken', rootId: 'r', path: '', seq: 1 }).success, false);
});

/* ------------------------------------------------------------------ *
 * 8. Limits
 * ------------------------------------------------------------------ */

test('configured limits are validated instead of clamped', () => {
  assert.deepEqual({ ...limits.resolveLimits() }, { ...limits.LIMIT_DEFAULTS });
  assert.equal(limits.resolveLimits({ transferConcurrency: 8 }).transferConcurrency, 8);
  assert.equal(limits.resolveLimits({ maxVerificationBytes: 10 * 1024 ** 3 }).maxVerificationBytes, 10 * 1024 ** 3);
  for (const configured of [
    { transferConcurrency: 0 }, { transferConcurrency: 9 }, { transferConcurrency: 2.5 },
    { maxTextBytes: 0 }, { maxTextBytes: 32 * 1024 ** 2 + 1 },
    { maxTaskEntries: 0 }, { maxTaskEntries: 100001 },
    { pollIntervalMs: 249 }, { pollIntervalMs: 60001 },
    { deletePlanTtlMs: 999 }, { deletePlanTtlMs: 600001 },
    { maxVerificationBytes: 0 }, { maxFileBytes: -1 },
  ]) {
    assert.throws(() => limits.resolveLimits(configured), { code: 'INVALID_STATE', status: 500 }, JSON.stringify(configured));
  }
  assert.equal(limits.textEnvelopeBytes(limits.LIMIT_DEFAULTS.maxTextBytes), limits.LIMIT_DEFAULTS.maxTextBytes * 6 + 65536);
});

/* ------------------------------------------------------------------ *
 * 9. Package-level contract freeze
 * ------------------------------------------------------------------ */

test('the wire protocol is the one the package ships', () => {
  assert.equal(manifest.name, '@lolkda/dsh-file-manager');
  assert.equal(protocol.ROUTES.control.path.startsWith('/api/file-manager/v2/'), true);
  assert.equal(limits.WIRE_STAGE, 'basic-management');
  assert.equal(protocol.ResponseEnvelopeSchema.safeParse({ ok: true, value: { any: 'thing' } }).success, true);
  assert.equal(protocol.ResponseEnvelopeSchema.safeParse({ ok: false, error: { code: 'INVALID_REQUEST', message: 'no', details: {} } }).success, true);
  assert.equal(protocol.ResponseEnvelopeSchema.safeParse({ ok: false, error: { code: 'INVALID_REQUEST', message: 'no' } }).success, false);
  assert.equal(existsSync(dist), true, 'the contract tests run against built artifacts in dist/');
});
