/**
 * The removal surface of the fixed browsing root, over the real v2 routes.
 *
 * Directory locations used to be a first-class wire concept: a grant store, a
 * status query and an explicit recovery flow. They are gone, and this suite pins
 * what "gone" has to mean at the Host boundary — the routes refuse them, nothing
 * about a root survives on disk, the one root the Host opens is the only
 * addressable one, and a root that changes identity is refused instead of
 * silently re-bound.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { resolveLimits } from '../dist/contracts/limits.js';
import { createManager } from '../dist/host/manager.js';
import { createFileManagerRouter, createUnavailableHandler, ROUTE_TABLE } from '../dist/host/http.js';
import { createRequestLedger } from '../dist/host/requests.js';
import { apply, VERSION } from '../dist/index.js';

const RETIRED_OPS = ['roots.list', 'roots.status', 'roots.add', 'roots.reauthorize', 'roots.remove'];

const request = (payload, route = 'control') => new Request(`http://localhost/api/file-manager/v2/${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), ...payload }),
});

async function hostFixture(t, { readOnly = false, degraded = null } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-fixed-root-'));
  const root = path.join(base, 'root');
  await mkdir(root);
  await writeFile(path.join(root, 'note.txt'), 'content');
  const manager = createManager({ rootPath: root });
  const router = createFileManagerRouter({
    manager, ledger: createRequestLedger(), limits: resolveLimits(),
    ...(readOnly ? { readOnly: true } : {}),
    ...(degraded ? { degraded } : {}),
  });
  t.after(async () => { await manager.close(); await rm(base, { recursive: true, force: true }); });
  const call = async payload => {
    const response = await router(request(payload));
    return { status: response.status, body: await response.json() };
  };
  return { base, root, manager, router, call, rootId: manager.getRoot().id };
}

test('bootstrap reports exactly one root and no location surface', async t => {
  const { call, rootId, root } = await hostFixture(t);
  const bootstrap = await call({ op: 'bootstrap' });
  assert.equal(bootstrap.status, 200);
  const view = bootstrap.body.value;
  assert.equal(view.root.id, rootId);
  assert.equal(view.root.path, root);
  assert.equal(view.root.label, path.basename(root));
  assert.match(view.root.identity, /^\d+:\d+$/);
  assert.deepEqual(Object.keys(view.root).sort(), ['id', 'identity', 'label', 'path']);
  assert.equal('roots' in view, false);
  assert.equal('workspaces' in view, false);
  assert.equal('persistentRoots' in view.capabilities, false);
  assert.equal(view.stage, 'basic-management');
  assert.equal(view.version, VERSION);
  assert.equal(view.degraded, null);
  const listing = await call({ op: 'entries.list', rootId: view.root.id, path: '' });
  assert.deepEqual(listing.body.value.entries.map(entry => entry.name), ['note.txt']);
});

test('every retired directory-location operation is refused and changes nothing', async t => {
  const { call, rootId, root, manager } = await hostFixture(t);
  for (const op of RETIRED_OPS) {
    const refused = await call({ op, path: root, rootId, expectedIdentity: manager.getRoot().identity, confirmed: true });
    assert.equal(refused.status, 400, `${op} must be an unknown operation`);
    assert.equal(refused.body.error.code, 'INVALID_REQUEST', `${op} must not reach a handler`);
  }
  assert.equal(manager.getRoot().id, rootId, 'a refused request must not move the root');
  assert.deepEqual(await readdir(root), ['note.txt'], 'a refused request must not touch the filesystem');
});

test('an id from another process or directory is refused over the wire', async t => {
  const { call, rootId } = await hostFixture(t);
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-other-root-'));
  const elsewhere = createManager({ rootPath: base });
  t.after(async () => { await elsewhere.close(); await rm(base, { recursive: true, force: true }); });
  for (const foreign of ['root-1', `${rootId}-stale`, elsewhere.getRoot().id]) {
    const listing = await call({ op: 'entries.list', rootId: foreign, path: '' });
    assert.equal(listing.status, 404, `${foreign} must not address the fixed root`);
    assert.equal(listing.body.error.code, 'ROOT_NOT_FOUND');
    const write = await call({ op: 'entries.create-file', rootId: foreign, path: 'new.txt' });
    assert.equal(write.status, 404);
    assert.equal(write.body.error.code, 'ROOT_NOT_FOUND');
  }
});

test('a root replaced during the Host lifetime is refused, not re-bound, over the wire', async t => {
  const { call, rootId, root, base } = await hostFixture(t);
  await rename(root, path.join(base, 'root-old'));
  await mkdir(root);
  await writeFile(path.join(root, 'new.txt'), 'not the opened root');
  for (const op of ['entries.list', 'text.read', 'entries.stat']) {
    const refused = await call({ op, rootId, path: op === 'entries.list' ? '' : 'note.txt' });
    assert.equal(refused.status, 409, `${op} must refuse a replaced root`);
    assert.equal(refused.body.error.code, 'ROOT_CHANGED');
  }
  assert.equal((await call({ op: 'bootstrap' })).body.value.root.id, rootId, 'bootstrap keeps reporting the opened root');
});

test('a read-only Host still browses its root and cannot manage locations', async t => {
  const { call, rootId } = await hostFixture(t, {
    readOnly: true,
    degraded: { scope: 'operations', code: 'INITIALIZATION_FAILED', message: 'The operation journal is unavailable.', readOnly: true },
  });
  const bootstrap = await call({ op: 'bootstrap' });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.body.value.degraded.scope, 'operations');
  assert.deepEqual(bootstrap.body.value.degraded, {
    scope: 'operations', code: 'INITIALIZATION_FAILED', message: 'The operation journal is unavailable.', readOnly: true,
  });
  assert.equal(bootstrap.body.value.capabilities.write, false);
  const listing = await call({ op: 'entries.list', rootId, path: '' });
  assert.equal(listing.status, 200, 'browsing and reading stay available');
  const refused = await call({ op: 'entries.create-file', rootId, path: 'new.txt' });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, 'FILE_MANAGER_UNAVAILABLE');
  assert.equal(refused.body.error.details.scope, 'operations');
});

test('a filesystem degradation answers bootstrap with a null root and refuses every operation', async t => {
  const degraded = {
    scope: 'filesystem', code: 'ROOT_UNAVAILABLE',
    message: 'The browsing root could not be opened. File operations are disabled; inspect the Host log.', readOnly: false,
  };
  const handler = createUnavailableHandler(degraded, { route: 'control', version: VERSION, limits: resolveLimits() });
  const bootstrap = await handler(request({ op: 'bootstrap' }));
  assert.equal(bootstrap.status, 200, 'a client must still be able to ask why nothing works');
  const view = (await bootstrap.json()).value;
  assert.equal(view.root, null, 'there is no root to browse when the root itself could not be opened');
  assert.equal(view.degraded.scope, 'filesystem');
  assert.deepEqual(view.capabilities, {
    write: false, tasks: false, transfers: false, watch: false, references: false, taskHistory: false,
  });
  assert.equal('persistentRoots' in view.capabilities, false);

  for (const payload of [{ op: 'entries.list', rootId: 'root-1', path: '' }, { op: 'roots.list' }, { op: 'bootstrap-not' }]) {
    const refused = await handler(request(payload));
    assert.equal(refused.status, 503, JSON.stringify(payload));
    const body = await refused.json();
    assert.equal(body.error.code, 'FILE_MANAGER_UNAVAILABLE');
    assert.equal(body.error.details.scope, 'filesystem');
  }
  // Every other route is refused too: only the control route may explain itself.
  for (const route of ROUTE_TABLE) {
    if (route.id === 'control') continue;
    const refused = await createUnavailableHandler(degraded, { route: route.id, version: VERSION, limits: resolveLimits() })(request({ op: 'bootstrap' }));
    assert.equal(refused.status, 503, `${route.id} must be refused while the root is unusable`);
  }
});

test('the default root is the filesystem root and is referenced without a doubled slash', async t => {
  const manager = createManager();
  t.after(() => manager.close());
  const root = manager.getRoot();
  assert.equal(root.path, '/');
  assert.equal(root.label, '/');
  const router = createFileManagerRouter({ manager, ledger: createRequestLedger(), limits: resolveLimits() });
  const call = async payload => {
    const response = await router(request(payload));
    return { status: response.status, body: await response.json() };
  };
  // `/` makes path concatenation the interesting case: a naive join emits `//`.
  const listing = await call({ op: 'entries.list', rootId: root.id, path: '' });
  assert.equal(listing.status, 200);
  assert.ok(listing.body.value.entries.some(entry => entry.name === 'etc'));
  const directory = await call({ op: 'entries.reference', rootId: root.id, path: 'etc' });
  assert.equal(directory.body.value.absolutePath, '/etc', 'a child of the root has exactly one separator');
  assert.equal(directory.body.value.mention, '@/etc/');
  const itself = await call({ op: 'entries.reference', rootId: root.id, path: '' });
  assert.equal(itself.body.value.absolutePath, '/', 'the root itself is referenced as `/`, never as `//`');
  assert.equal(itself.body.value.mention, '@/');
  assert.equal(JSON.stringify(itself.body.value).includes('//'), false);
});

test('an isolated root is referenced through its canonical path', async t => {
  const { call, root, rootId } = await hostFixture(t);
  await mkdir(path.join(root, 'folder'));
  const reference = await call({ op: 'entries.reference', rootId, path: 'folder' });
  const canonical = await realpath(root);
  assert.equal(reference.body.value.absolutePath, `${canonical}/folder`);
  assert.equal(reference.body.value.mention, `@${canonical}/folder/`);
  assert.equal(canonical.includes('//'), false);
});

test('a damaged legacy root store neither blocks startup nor gets rewritten', async () => {
  // The bytes a previous release wrote for directory locations. Nothing in the
  // plugin may read, migrate, clean or repair them, and asking for that store at
  // all is a defect — the manager opens its root from the filesystem instead.
  const legacy = {
    revision: 7,
    roots: [{ id: 'root-old', provider: 'host-local', path: '/srv/gone', label: 'gone', identity: '4242:9', createdAt: '2026-01-01T00:00:00.000Z' }],
  };
  const legacyBytes = JSON.stringify(legacy);
  const opened = [];
  const routes = [];
  const disposers = [];
  const ctx = {
    connection: { fetch: { register(route) { routes.push(route); return async () => routes.splice(routes.indexOf(route), 1); } } },
    workspaceRegistry: { list: () => [] },
    logger: { warn() {}, error() {} },
    storageDomain: {
      async open(spec) {
        opened.push(spec.name);
        // The retired namespace is not merely ignored: reading it must fail loudly,
        // so the plugin can never quietly depend on it again.
        if (spec.name === 'local_file_manager') {
          throw Object.assign(new Error('injected damaged medium for the retired root store'), { code: 'EIO' });
        }
        let state = structuredClone(spec.global.initial);
        const tables = new Map();
        return {
          global: { get: () => state, async set(next) { state = spec.global.schema.parse(next); } },
          table(name) {
            if (!tables.has(name)) tables.set(name, new Map());
            const records = tables.get(name);
            return { entries: () => records.entries(), async put(key, value) { records.set(key, spec.tables[name].valueSchema.parse(value)); } };
          },
          async close() {},
        };
      },
    },
    effect(callback) { const dispose = callback(); disposers.push(dispose); return dispose; },
  };
  await assert.doesNotReject(() => apply(ctx), 'a damaged legacy root store must not abort Host startup');
  assert.deepEqual(opened, ['local_file_manager_operations'], 'the operation journal is the only durable state the plugin opens');
  const control = routes.find(route => route.path.endsWith('/control'));
  const bootstrap = await control.fetch(request({ op: 'bootstrap' }));
  const view = (await bootstrap.json()).value;
  assert.equal(bootstrap.status, 200);
  assert.equal(view.degraded, null, 'the journal opened, so nothing is degraded');
  assert.equal(view.root.path, '/', 'the root comes from the filesystem, not from the damaged store');
  assert.equal(view.capabilities.tasks, true);
  assert.equal(JSON.stringify(legacy), legacyBytes, 'the legacy bytes are left exactly as found');
  for (const dispose of disposers.reverse()) await dispose?.();
});
