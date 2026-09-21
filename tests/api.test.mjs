import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createManager } from '../host/manager.js';

async function plugin() {
  let module;
  try { module = await import('../index.js'); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  assert.equal(typeof module?.createControlHandler, 'function', 'the authenticated file-manager route adapter is missing');
  return module;
}

function request(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) payload = { requestId: randomUUID(), ...payload };
  return new Request('http://localhost/api/file-manager/control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
}

test('control bootstrap provides roots and workspace candidates without any Session', async () => {
  const { createControlHandler } = await plugin();
  const handler = createControlHandler({ manager: createManager(), workspaces: () => [{ id: 'w1', path: '/candidate', title: 'Workspace' }] });
  const response = await handler(request({ op: 'bootstrap' }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.value.roots, []);
  assert.deepEqual(body.value.workspaces, [{ id: 'w1', path: '/candidate', title: 'Workspace' }]);
});

test('control route adds a grant then lists its real filesystem contents', async t => {
  const { createControlHandler } = await plugin();
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'example.txt'), 'hello');
  const handler = createControlHandler({ manager: createManager(), workspaces: () => [] });
  const added = await (await handler(request({ op: 'roots.add', path: root }))).json();
  assert.equal(added.ok, true);
  const listing = await (await handler(request({ op: 'entries.list', rootId: added.value.id, path: '' }))).json();
  assert.deepEqual(listing.value.entries.map(entry => entry.name), ['example.txt']);
});

test('invalid control payloads return a bounded business failure rather than an exception', async () => {
  const { createControlHandler } = await plugin();
  const handler = createControlHandler({ manager: createManager(), workspaces: () => [] });
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
  const handler = createControlHandler({ manager: createManager(), workspaces: () => [] });
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
    settings: {
      value: undefined,
      register(ns, schema) { this.value = schema(); },
      get() { return this.value; },
    },
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
  assert.deepEqual(routes.map(route => route.path), ['/api/file-manager/control', '/api/file-manager/text', '/api/file-manager/upload', '/api/file-manager/download', '/api/file-manager/events']);
  assert.deepEqual(routes[0].methods, ['POST']);
  assert.equal(routes[0].requestBody, 'streaming');
  assert.equal((await routes[0].fetch(request({ op: 'bootstrap' }))).status, 200);
  for (const dispose of disposers.reverse()) await dispose?.();
  assert.deepEqual(routes, []);
});
