import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createManager } from '../dist/host/manager.js';

async function plugin() {
  let module;
  try { module = await import('../dist/index.js'); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  assert.equal(typeof module?.createControlHandler, 'function', 'the authenticated file-manager route adapter is missing');
  return module;
}

function request(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) payload = { requestId: randomUUID(), ...payload };
  return new Request('http://localhost/api/file-manager/v2/control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
}

test('control bootstrap reports the single root without any Session', async t => {
  const { createControlHandler } = await plugin();
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = createManager({ rootPath: root });
  t.after(() => manager.close());
  const handler = createControlHandler({ manager });
  const response = await handler(request({ op: 'bootstrap' }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.value.root.path, root);
  assert.equal(body.value.root.id, manager.getRoot().id);
  assert.equal('roots' in body.value, false);
  assert.equal('workspaces' in body.value, false);
});

test('control route lists the real filesystem contents of the fixed root', async t => {
  const { createControlHandler } = await plugin();
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'example.txt'), 'hello');
  const manager = createManager({ rootPath: root });
  t.after(() => manager.close());
  const handler = createControlHandler({ manager });
  const listing = await (await handler(request({ op: 'entries.list', rootId: manager.getRoot().id, path: '' }))).json();
  assert.deepEqual(listing.value.entries.map(entry => entry.name), ['example.txt']);
});

test('invalid control payloads return a bounded business failure rather than an exception', async () => {
  const { createControlHandler } = await plugin();
  const handler = createControlHandler({ manager: createManager() });
  for (const payload of [null, [], {}, { op: 'unknown' }]) {
    const response = await handler(request(payload));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'INVALID_REQUEST');
    assert.equal('stack' in body.error, false);
  }
});

test('root-scope errors retain their stable code and HTTP status', async () => {
  const { createControlHandler } = await plugin();
  const handler = createControlHandler({ manager: createManager() });
  const response = await handler(request({ op: 'entries.list', rootId: 'ungranted', path: '' }));
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, 'ROOT_NOT_FOUND');
});

test('Host plugin mounts exact authenticated Fetch routes and contributes no Agent tool', async () => {
  const module = await plugin();
  assert.equal(typeof module.apply, 'function');
  const routes = [];
  const disposers = [];
  const ctx = {
    connection: { fetch: { register(route) { routes.push(route); return async () => routes.splice(routes.indexOf(route), 1); } } },
    workspaceRegistry: { list: () => [] },
    storageDomain: { async open(spec) {
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
    } },
    effect(callback) { const dispose = callback(); disposers.push(dispose); return dispose; },
  };
  await module.apply(ctx);
  assert.deepEqual(routes.map(route => route.path), [
    '/api/file-manager/v2/control', '/api/file-manager/v2/manifest', '/api/file-manager/v2/text',
    '/api/file-manager/v2/upload', '/api/file-manager/v2/download', '/api/file-manager/v2/events',
  ]);
  assert.deepEqual(routes[0].methods, ['POST']);
  assert.equal(routes[0].requestBody, 'streaming');
  assert.equal(routes[4].requestBody, 'buffered', 'download keeps GET with a buffered request body');
  assert.equal((await routes[0].fetch(request({ op: 'bootstrap' }))).status, 200);
  for (const dispose of disposers.reverse()) await dispose?.();
  assert.deepEqual(routes, []);
});


/* ------------------------------------------------------------------ *
 * The removed directory locations over the authenticated control route
 *
 * The browser no longer manages locations, so the wire must not keep a
 * back door: every retired `roots.*` operation is an unknown operation, and the
 * one root the Host opened stays the only addressable one.
 * ------------------------------------------------------------------ */

test('every retired directory-location operation is refused as an unknown operation', async t => {
  const { createControlHandler } = await plugin();
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-removed-roots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = createManager({ rootPath: root });
  t.after(() => manager.close());
  const grant = manager.getRoot();
  const handler = createControlHandler({ manager });
  const retired = [
    { op: 'roots.list' },
    { op: 'roots.status' },
    { op: 'roots.add', path: root, requestId: 'retired-roots-add-request' },
    { op: 'roots.remove', rootId: grant.id, requestId: 'retired-roots-remove-request' },
    { op: 'roots.reauthorize', rootId: grant.id, expectedIdentity: grant.identity, confirmed: true, requestId: 'retired-roots-reauthorize-request' },
  ];
  for (const payload of retired) {
    const response = await handler(request(payload));
    assert.equal(response.status, 400, JSON.stringify(payload));
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'INVALID_REQUEST');
  }
  // A refused request never touches the root, and no storage of locations exists.
  assert.equal(manager.getRoot().id, grant.id);
  const listing = await (await handler(request({ op: 'entries.list', rootId: grant.id, path: '' }))).json();
  assert.deepEqual(listing.value.entries, []);
});

test('an id from any other process or directory is refused with ROOT_NOT_FOUND', async t => {
  const { createControlHandler } = await plugin();
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-foreign-root-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  const other = path.join(base, 'other');
  await mkdir(root); await mkdir(other);
  await writeFile(path.join(root, 'example.txt'), 'hello');
  const manager = createManager({ rootPath: root });
  const elsewhere = createManager({ rootPath: other });
  t.after(async () => { await manager.close(); await elsewhere.close(); });
  const handler = createControlHandler({ manager });
  const foreign = ['ungranted', elsewhere.getRoot().id, `${manager.getRoot().id}-stale`];
  for (const rootId of foreign) {
    const response = await handler(request({ op: 'entries.list', rootId, path: '' }));
    assert.equal(response.status, 404, rootId);
    assert.equal((await response.json()).error.code, 'ROOT_NOT_FOUND');
  }
  const text = await handler(request({ op: 'text.read', rootId: `${manager.getRoot().id}-stale`, path: 'example.txt' }));
  assert.equal(text.status, 404);
  assert.equal((await text.json()).error.code, 'ROOT_NOT_FOUND');
  const written = await handler(request({ op: 'entries.create-file', rootId: 'ungranted', path: 'new.txt', requestId: 'foreign-root-write-request' }));
  assert.equal(written.status, 404);
  assert.equal((await written.json()).error.code, 'ROOT_NOT_FOUND');
  assert.deepEqual((await readdir(root)).sort(), ['example.txt'], 'a refused id must never create anything');
});
