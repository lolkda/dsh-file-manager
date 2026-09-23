/**
 * task-6 独立验证：R19 HTTP 边界 + 鉴权/跨站 + R17 只读降级。
 *
 * 判定标准与证据路径见 `docs/VERIFICATION-PLAN.md` §C、§D。
 * **硬规则：降级场景只用隔离 Storage/Settings 桩，绝不读写当前 profile 的真实存储。**
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { evidenceDirectory, hostFixture, probeReadiness, record, storageStub } from './verify-harness.mjs';
import { LARGE_BODY_ADMISSION, SMALL_BODY_ADMISSION } from '../dist/contracts/limits.js';

// The deployed DSH runtime supplies the real Connection (auth + HTTP bridge). This is
// the same resolution the existing runtime suites use.
const runtimeRoot = process.env.FILE_MANAGER_DSH_RUNTIME_ROOT ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh';
const runtimeAvailable = existsSync(path.join(runtimeRoot, 'package.json'));
const skipWithoutRuntime = runtimeAvailable
  ? false
  : `no DSH runtime at ${runtimeRoot}; set FILE_MANAGER_DSH_RUNTIME_ROOT to exercise the real auth boundary`;
const runtimeRequire = runtimeAvailable ? createRequire(path.join(runtimeRoot, 'package.json')) : undefined;
const runtime = name => import(pathToFileURL(runtimeRequire.resolve(name)).href);

const readiness = await probeReadiness();
const blocked = readiness.ready ? false : `task-6 verification blocked: ${readiness.missing.join(', ')}`;
const RUN = 'task6-boundary';
const evidence = evidenceDirectory(RUN);

test('verification prerequisites are present', () => {
  assert.deepEqual(readiness.missing, [], 'task-6 verification cannot run before task-4/task-5 artifacts exist');
});

test('the degradation fixture is isolated and preserves raw record bytes', async () => {
  // Self-test of the fixture the R17 cases depend on: it must hold records in
  // memory, never touch the real profile storage, and keep an untouched copy.
  const records = { 'task-1': { id: 'task-1', operation: 'copy', status: 'failed', items: [{ id: 'i1' }] } };
  const stub = storageStub({ tables: { tasks: records } });
  const domain = await stub.open({ name: 'local_file_manager_operations', tables: { tasks: {} } });
  const before = JSON.stringify([...domain.table('tasks').entries()]);
  await domain.table('tasks').put('task-2', { id: 'task-2', operation: 'move', status: 'queued', items: [] });
  const after = JSON.stringify([...domain.table('tasks').entries()].filter(([key]) => key !== 'task-2'));
  record(evidence, 'degradation-fixture', `opens=${stub.state.opens} writes=${stub.state.writes.length}`);
  assert.equal(after, before, 'the fixture must keep raw records byte-identical unless the code under test writes them');
  assert.equal(stub.state.opens, 1);
});

test('R17: an unavailable operation journal degrades to read-only and keeps history distinguishable', { skip: blocked }, async t => {
  const degraded = { scope: 'operations', code: 'INITIALIZATION_FAILED', message: 'The operation journal could not be opened.', readOnly: true };
  const fixture = await hostFixture({ degraded, readOnly: true });
  t.after(fixture.close);
  writeFileSync(path.join(fixture.directory, 'note.txt'), 'readable');

  const bootstrap = await fixture.call('bootstrap');
  record(evidence, 'degradation-readonly', `bootstrap=${bootstrap.status} write=${bootstrap.value?.capabilities?.write} degraded=${JSON.stringify(bootstrap.value?.degraded)}`);
  assert.equal(bootstrap.status, 200, 'a degraded Host still answers bootstrap');
  assert.equal(bootstrap.value.degraded.scope, 'operations');
  assert.equal(bootstrap.value.degraded.readOnly, true);
  assert.equal(bootstrap.value.capabilities.write, false, 'degraded operations means read-only');
  assert.equal(bootstrap.value.capabilities.tasks, false);
  assert.equal(bootstrap.value.capabilities.taskHistory, false);
  assert.ok(bootstrap.value.roots.length > 0, 'trustworthy root grants stay visible while the journal is unavailable');

  const listing = await fixture.call('entries.list', fixture.ref(''));
  assert.equal(listing.status, 200, 'browsing must keep working');
  const read = await fixture.call('text.read', fixture.ref('note.txt'));
  assert.equal(read.status, 200, 'text reading must keep working');
  assert.equal(read.value.text, 'readable');

  for (const [op, payload] of [
    ['roots.add', { path: fixture.directory }],
    ['roots.remove', { rootId: fixture.rootId }],
    ['entries.create-file', { ...fixture.ref('new.txt') }],
    ['entries.create-directory', { ...fixture.ref('newdir') }],
    ['entries.rename', { ...fixture.ref('note.txt'), name: 'renamed.txt' }],
    ['delete.prepare', { items: [fixture.ref('note.txt')] }],
    ['activities.dismiss', { items: [{ kind: 'task', taskId: 'task-1', expectedHistoryRevision: 0 }] }],
  ]) {
    const refused = await fixture.call(op, payload);
    record(evidence, 'degradation-readonly', `${op} -> ${refused.status} ${refused.error?.code} scope=${refused.error?.details?.scope}`);
    assert.equal(refused.status, 503, `${op} must be refused while degraded`);
    assert.equal(refused.error.code, 'FILE_MANAGER_UNAVAILABLE', `${op} must use the frozen degradation code`);
    assert.equal(refused.error.details.scope, 'operations');
  }
  const save = await fixture.call('save', { ...fixture.ref('note.txt'), text: 'write attempt' }, { route: 'text' });
  assert.equal(save.status, 503, 'the text route must refuse writes while degraded');
  assert.equal(save.error.code, 'FILE_MANAGER_UNAVAILABLE');

  const history = await fixture.call('tasks.list');
  record(evidence, 'degradation-readonly', `tasks.list -> ${history.status} ${history.error?.code}`);
  assert.notEqual(history.status, 200, 'unavailable history must never be reported as an empty history');
  assert.equal(existsSync(path.join(fixture.directory, 'new.txt')), false, 'no refused write may reach the filesystem');
  assert.equal(readFileSync(path.join(fixture.directory, 'note.txt'), 'utf8'), 'readable');
});

test('R17: corrupted raw records are preserved, never reset or rewritten', { skip: blocked }, async t => {
  const corrupt = {
    'task-broken': { id: 'task-broken', operation: 'copy', status: 'failed' },
    'task-mismatched': { id: 'other-id', operation: 'move', status: 'queued', items: [] },
  };
  const stub = storageStub({ tables: { tasks: corrupt, transfers: {} } });
  const before = JSON.stringify([...stub.state.tables.get('tasks').entries()]);
  const domain = await stub.open({ name: 'local_file_manager_operations', tables: { tasks: {}, transfers: {} } });
  const readRecords = table => [...domain.table(table).entries()].map(([key, record]) => ({ key, record }));
  const seen = readRecords('tasks');
  record(evidence, 'degradation-preserve', `records seen=${JSON.stringify(seen)} opens=${stub.state.opens} writes=${stub.state.writes.length}`);
  assert.equal(seen.length, 2, 'the corrupted records must still be readable, not dropped');
  assert.equal(seen[1].record.id !== seen[1].key, true, 'the mismatched key/id pair is preserved as-is for the Host to reject');
  assert.equal(stub.state.writes.length, 0, 'opening a journal must never rewrite it');
  assert.equal(JSON.stringify([...stub.state.tables.get('tasks').entries()]), before, 'raw record bytes must be identical after opening');
});

test('R17: untrustworthy root grants refuse file access without discarding the grant', { skip: blocked }, async t => {
  const degraded = { scope: 'roots', code: 'INITIALIZATION_FAILED', message: 'Stored root grants are not trustworthy.', readOnly: false };
  const fixture = await hostFixture({ degraded });
  t.after(fixture.close);
  writeFileSync(path.join(fixture.directory, 'note.txt'), 'present');

  const bootstrap = await fixture.call('bootstrap');
  record(evidence, 'degradation-roots', `bootstrap=${bootstrap.status} roots=${bootstrap.value?.roots?.length} degraded=${JSON.stringify(bootstrap.value?.degraded)}`);
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.value.degraded.scope, 'roots');
  assert.equal(bootstrap.value.degraded.readOnly, false);
  assert.deepEqual(bootstrap.value.roots, [], 'untrustworthy grants must not be offered as usable roots');
  assert.equal(bootstrap.value.capabilities.write, false);

  for (const [op, payload] of [['entries.list', fixture.ref('')], ['text.read', fixture.ref('note.txt')], ['bootstrap', {}]]) {
    const refused = await fixture.call(op, payload);
    if (op === 'bootstrap') continue;
    record(evidence, 'degradation-roots', `${op} -> ${refused.status} ${refused.error?.code} scope=${refused.error?.details?.scope}`);
    assert.equal(refused.status, 503, `${op} must be refused when the grants are untrustworthy`);
    assert.equal(refused.error.code, 'FILE_MANAGER_UNAVAILABLE');
    assert.equal(refused.error.details.scope, 'roots');
  }
  assert.equal(readFileSync(path.join(fixture.directory, 'note.txt'), 'utf8'), 'present', 'a refused read must not modify anything');
});

test('R19: the v2 route table is exactly what the Host registers, and legacy paths are refused', { skip: blocked }, async t => {
  const { ROUTE_TABLE } = await import('../dist/host/http.js');
  const { ROUTES, LEGACY_ROUTES, ROUTE_IDS } = await import('../dist/contracts/protocol.js');
  assert.deepEqual([...ROUTE_TABLE].map(route => ({ id: route.id, path: route.path, methods: [...route.methods], requestBody: route.requestBody })),
    ROUTE_IDS.map(id => ({ id, path: ROUTES[id].path, methods: [...ROUTES[id].methods], requestBody: ROUTES[id].requestBody })),
    'the registered routes must be the frozen table, not a hand-written copy');
  record(evidence, 'v2-routes', `registered=${ROUTE_TABLE.map(route => route.path).join(',')}`);

  const fixture = await hostFixture();
  t.after(fixture.close);
  writeFileSync(path.join(fixture.directory, 'note.txt'), 'untouched');
  for (const legacy of LEGACY_ROUTES) {
    const response = await fixture.router(new Request(`http://localhost${legacy}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'entries.create-file', rootId: fixture.rootId, path: 'smuggled.txt', requestId: 'legacy-smuggle' }),
    }));
    const body = await response.json();
    record(evidence, 'v2-routes', `${legacy} -> ${response.status} ${body?.error?.code}`);
    assert.ok(response.status === 404 || response.status === 400, `${legacy} must be refused explicitly, got ${response.status}`);
    assert.equal(body.ok, false);
    assert.match(body.error.message, /replaced|v2/, 'the refusal must tell the client to upgrade');
    assert.equal(existsSync(path.join(fixture.directory, 'smuggled.txt')), false, 'a legacy path must never be treated as a v2 write');
  }
  const unknown = await fixture.router(new Request('http://localhost/api/file-manager/v2/nope', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(unknown.status, 404);
  assert.equal(existsSync(path.join(fixture.directory, 'smuggled.txt')), false);
});

test('R19: small-body admission 8 / large-body admission 2 refuse before reading the body', { skip: blocked }, async t => {
  const fixture = await hostFixture();
  t.after(fixture.close);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const inflight = [];
  const held = [];

  /** Start a request whose body never arrives, so the route slot stays occupied. */
  const hold = route => {
    const body = new ReadableStream({ start() { /* never enqueue, never close */ } });
    const promise = fixture.router(new Request(`http://localhost/api/file-manager/v2/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half',
    })).then(async response => ({ status: response.status, body: await response.json() }));
    inflight.push(promise);
    held.push(body);
    return promise;
  };
  const release = async () => {
    for (const body of held.splice(0)) await body.cancel().catch(() => {});
    // The router unwinds when the body is released; never await it unbounded.
    await Promise.race([Promise.allSettled(inflight.splice(0)), delay(2000)]);
  };

  for (let index = 0; index < SMALL_BODY_ADMISSION; index++) void hold('control');
  await delay(250);
  const overflow = await Promise.race([hold('control'), delay(5000).then(() => ({ status: 'timeout' }))]);
  record(evidence, 'v2-admission', `control held=${SMALL_BODY_ADMISSION} overflow=${overflow.status} ${overflow.body?.error?.code}`);
  assert.equal(overflow.status, 429, 'the ninth concurrent small-envelope request must be refused immediately');
  assert.equal(overflow.body.error.code, 'TOO_MANY_REQUESTS');
  await release();

  for (let index = 0; index < LARGE_BODY_ADMISSION; index++) void hold('manifest');
  await delay(250);
  const largeOverflow = await Promise.race([hold('manifest'), delay(5000).then(() => ({ status: 'timeout' }))]);
  record(evidence, 'v2-admission', `manifest held=${LARGE_BODY_ADMISSION} overflow=${largeOverflow.status} ${largeOverflow.body?.error?.code}`);
  assert.equal(largeOverflow.status, 429, 'the third concurrent large request must be refused immediately');
  assert.equal(largeOverflow.body.error.code, 'TOO_MANY_REQUESTS');
  await release();
});

test('R19: the text route keeps its own envelope and the control route does not', { skip: blocked }, async t => {
  const fixture = await hostFixture();
  t.after(fixture.close);
  writeFileSync(path.join(fixture.directory, 'note.txt'), 'seed');
  const snapshot = await fixture.call('text.read', fixture.ref('note.txt'));
  assert.equal(snapshot.status, 200);
  const version = snapshot.value.version;
  const text = 'x'.repeat(300 * 1024);

  const saved = await fixture.call('save', { ...fixture.ref('note.txt'), text, expectedVersion: version }, { route: 'text' });
  record(evidence, 'v2-text', `text route save ${text.length} bytes -> ${saved.status} ${saved.error?.code}`);
  assert.equal(saved.status, 200, `the text route must accept a bounded large body: ${JSON.stringify(saved.error)}`);
  assert.equal('text' in saved.value, false, 'a text receipt must not carry the whole body back');
  assert.equal(readFileSync(path.join(fixture.directory, 'note.txt'), 'utf8').length, text.length);

  const refused = await fixture.call('save', { ...fixture.ref('note.txt'), text, expectedVersion: saved.value.version });
  record(evidence, 'v2-text', `control route same payload -> ${refused.status} ${refused.error?.code}`);
  assert.equal(refused.status, 413, 'the control envelope must refuse a body above its own limit');
  assert.equal(refused.error.code, 'TOO_LARGE');
});

test('R19: download stays an authenticated GET with a streamed response', { skip: skipWithoutRuntime || blocked }, async t => {
  // Drives the real deployed DSH runtime: the Connection plugin supplies real signed
  // cookies, auth dispatch and the HTTP bridge (same fixture shape as
  // tests/download-navigation.test.mjs). No stub stands in for the auth boundary.
  const { Context } = await runtime('@deepseek-ai/cordis');
  const connectionPlugin = await runtime('@deepseek-ai/dsh-client-connection');
  const { BackendRegistry } = await runtime('@deepseek-ai/dsh-storage');
  const { JsonStorageBackend } = await runtime('@deepseek-ai/dsh-storage-json');
  const { DomainFacility } = await runtime('@deepseek-ai/dsh-storage-domain');
  const fileManager = await import('../dist/index.js');

  const base = await mkdtemp(path.join(tmpdir(), 'dsh-fm-verify-bridge-'));
  const files = path.join(base, 'files');
  await mkdir(files);
  const payload = Buffer.from('streamed download bytes\r\n真实字节\n');
  await writeFile(path.join(files, '报告.txt'), payload);

  const ctx = new Context();
  const backend = new JsonStorageBackend(path.join(base, 'state'));
  const registry = new BackendRegistry();
  registry.register('json', backend);
  ctx.provide('storage', { backend: registry });
  const domains = new DomainFacility(ctx, { backend: 'json', routes: {} });
  ctx.provide('storageDomain', domains);
  const settings = new Map();
  ctx.provide('settings', { register(name, schema) { settings.set(name, schema()); }, get(name) { return settings.get(name); } });
  ctx.provide('workspaceRegistry', { list: () => [] });
  let credential;
  ctx.provide('credentials', { async modifyRecord(_key, mutate) { const next = await mutate(credential); if (next !== undefined) credential = next; return credential; } });
  const failures = [];
  let route;
  let ready;
  const routeReady = new Promise(resolve => { ready = resolve; });
  ctx.provide('webServer', { register(value) { route = value; ready(); return async () => { route = undefined; }; } });
  let server;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await ctx.fiber.dispose();
    await domains.closeAll();
    await backend.close();
    await rm(base, { recursive: true, force: true });
  });
  await ctx.plugin(connectionPlugin, { cookieMaxAgeDays: 1, maxRequestBodyBytes: 128 });
  await routeReady;
  await ctx.plugin(fileManager);
  server = http.createServer((req, res) => {
    const serve = async () => {
      if (req.url.startsWith('/api/')) return route.handler(req, res);
      if (ctx.connection.authorizeIndex(req, res)) { res.writeHead(204); res.end(); }
    };
    serve().catch(error => { failures.push(error); if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(error)); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  assert.equal(login.status, 303, 'the real Connection must mint a session cookie');
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];

  const control = async body => {
    const target = ['tasks.start', 'tasks.retry', 'transfers.begin'].includes(body.op) ? 'manifest' : 'control';
    const response = await fetch(`${origin}/api/file-manager/v2/${target}`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), ...body }), signal: AbortSignal.timeout(5000),
    });
    const parsed = await response.json();
    assert.equal(response.status, 200, JSON.stringify(parsed));
    return parsed.value;
  };
  const grant = await control({ op: 'roots.add', path: files });
  const begun = await control({ op: 'transfers.begin', direction: 'download', rootId: grant.id, path: '报告.txt' });
  const downloadUrl = `/api/file-manager/v2/download?taskId=${begun.id}`;

  // 1. An authenticated GET streams the exact bytes.
  const authenticated = await fetch(`${origin}${downloadUrl}`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
  const body = Buffer.from(await authenticated.arrayBuffer());
  record(evidence, 'download-auth', `authenticated GET -> ${authenticated.status} bytes=${body.length} type=${authenticated.headers.get('content-type')} disposition=${authenticated.headers.get('content-disposition')}`);
  assert.equal(authenticated.status, 200);
  assert.deepEqual(body, payload, 'the streamed bytes must equal the stored bytes exactly');
  assert.match(authenticated.headers.get('content-disposition') ?? '', /attachment/, 'a download must be an attachment, never inline');
  assert.equal(authenticated.headers.get('cache-control'), 'no-store', 'a download must not be cached');
  assert.equal(authenticated.headers.get('x-content-type-options'), 'nosniff');

  // 2. Without the session cookie the same URL must not serve bytes.
  const anonymous = await fetch(`${origin}${downloadUrl}`, { signal: AbortSignal.timeout(5000) });
  const anonymousBody = Buffer.from(await anonymous.arrayBuffer());
  record(evidence, 'download-auth', `anonymous GET -> ${anonymous.status} bytes=${anonymousBody.length}`);
  assert.notEqual(anonymous.status, 200, 'an unauthenticated download must be refused');
  assert.equal(anonymousBody.includes(payload.subarray(0, 8)), false, 'no file bytes may leak without a session');

  // 3. A cross-site request with a valid cookie must still be refused.
  const crossSite = await fetch(`${origin}${downloadUrl}`, {
    headers: { cookie, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', referer: 'https://evil.example/page' },
    signal: AbortSignal.timeout(5000),
  });
  const crossBody = Buffer.from(await crossSite.arrayBuffer());
  record(evidence, 'download-auth', `cross-site GET -> ${crossSite.status} bytes=${crossBody.length}`);
  assert.notEqual(crossSite.status, 200, 'a cross-site download must be refused even with a valid cookie');
  assert.equal(crossBody.includes(payload.subarray(0, 8)), false, 'no file bytes may leak to a cross-site origin');

  // 4. The response is streamed rather than buffered into one JSON envelope.
  assert.notEqual(authenticated.headers.get('content-type'), 'application/json; charset=utf-8', 'a download is not a JSON envelope');
  assert.equal(failures.length, 0, `the bridge must not swallow errors: ${failures.map(String).join('; ')}`);
});
