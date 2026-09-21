import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import yauzl from 'yauzl';

// Test the actual installed production module while retaining this project's
// dev-only assertion/ZIP tools when FILE_MANAGER_TEST_PACKAGE_ROOT is supplied.
const fileManager = await import(process.env.FILE_MANAGER_TEST_PACKAGE_ROOT
  ? pathToFileURL(path.join(process.env.FILE_MANAGER_TEST_PACKAGE_ROOT, 'index.js')).href
  : new URL('../index.js', import.meta.url).href);

// This suite drives the real deployed DSH runtime. A runner or a fresh clone that
// has none cannot resolve it, so it reports an explicit skip instead of crashing
// the whole file; set FILE_MANAGER_DSH_RUNTIME_ROOT to point at an installation.
const runtimeRoot = process.env.FILE_MANAGER_DSH_RUNTIME_ROOT ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh';
const runtimeAvailable = existsSync(path.join(runtimeRoot, 'package.json'));
const skipWithoutRuntime = runtimeAvailable ? false : `no DSH runtime at ${runtimeRoot}; set FILE_MANAGER_DSH_RUNTIME_ROOT to run this suite against a real installation`;
const runtimeRequire = runtimeAvailable ? createRequire(path.join(runtimeRoot, 'package.json')) : undefined;
const runtime = name => import(pathToFileURL(runtimeRequire.resolve(name)).href);
const [{ Context } = {}, connectionPlugin, { BackendRegistry } = {}, { JsonStorageBackend } = {}, { DomainFacility } = {}] = runtimeAvailable ? await Promise.all([
  runtime('@deepseek-ai/cordis'), runtime('@deepseek-ai/dsh-client-connection'), runtime('@deepseek-ai/dsh-storage'),
  runtime('@deepseek-ai/dsh-storage-json'), runtime('@deepseek-ai/dsh-storage-domain'),
]) : [];

// A bounded test-only HTTP listener: no UI shell or second Harness server.
// The deployed Connection plugin supplies its real auth, dispatch and HTTP bridge.
async function fixture(t, { filename = '下载说明.txt', bytes = Buffer.from('native download\r\n真实字节\n') } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-http-'));
  const files = path.join(base, 'files');
  await mkdir(files);
  await mkdir(path.join(files, 'empty'));
  await writeFile(path.join(files, filename), bytes);
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
  // Only credential persistence is test-owned. Connection itself mints/verifies
  // real signed cookies; no user token or OS credential store is read.
  let credential;
  ctx.provide('credentials', { async modifyRecord(_key, mutate) { const next = await mutate(credential); if (next !== undefined) credential = next; return credential; } });
  const failures = [];
  let route;
  let ready;
  const routeReady = new Promise(resolve => { ready = resolve; });
  ctx.provide('webServer', { register(value) { route = value; ready(); return async () => { route = undefined; }; } });
  let server;
  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
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
    serve().catch(error => {
      failures.push(error);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const request = (relative, options = {}) => fetch(`${origin}${relative}`, { ...options, headers: { cookie, ...options.headers }, signal: options.signal ?? AbortSignal.timeout(5000) });
  const control = async payload => {
    const response = await request('/api/file-manager/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), ...payload }) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body.value;
  };
  const grant = await control({ op: 'roots.add', path: files });
  return { ctx, origin, cookie, request, control, grant, files, filename, bytes, failures };
}

async function unzip(buffer) {
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value)));
  const result = new Map();
  await new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', entry => {
      if (entry.fileName.endsWith('/')) { result.set(entry.fileName, null); zip.readEntry(); return; }
      zip.openReadStream(entry, (error, stream) => {
        if (error) { reject(error); return; }
        const chunks = [];
        stream.on('error', reject);
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => { result.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
      });
    });
    zip.readEntry();
  });
  return result;
}

test('a cookie-authenticated native GET traverses the deployed bridge and downloads exact file bytes', { timeout: 10000, skip: skipWithoutRuntime }, async t => {
  const f = await fixture(t, { bytes: Buffer.alloc(256 * 1024, 0x61) });
  const task = await f.control({ op: 'transfers.begin', direction: 'download', rootId: f.grant.id, path: f.filename });
  const response = await f.request(`/api/file-manager/download?taskId=${encodeURIComponent(task.id)}`, { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' } });
  assert.equal(response.status, 200, `the real HTTP bridge rejected a bodyless GET: ${f.failures.map(String).join('; ')}`);
  assert.match(response.headers.get('content-disposition'), /attachment;/);
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
  const completed = await f.control({ op: 'transfers.get', taskId: task.id });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.completion, 'server-stream-finished');
  assert.equal(completed.bytesTransferred, f.bytes.length);
  assert.deepEqual(f.failures, []);
});

test('a native directory download preserves ZIP members and empty directories through the deployed bridge', { timeout: 10000, skip: skipWithoutRuntime }, async t => {
  const f = await fixture(t);
  const task = await f.control({ op: 'transfers.begin', direction: 'download', rootId: f.grant.id, path: '' });
  const response = await f.request(`/api/file-manager/download?taskId=${encodeURIComponent(task.id)}`);
  assert.equal(response.status, 200, f.failures.map(String).join('; '));
  assert.equal(response.headers.get('content-type'), 'application/zip');
  const entries = await unzip(Buffer.from(await response.arrayBuffer()));
  assert.deepEqual([...entries.keys()], ['files/', 'files/empty/', `files/${f.filename}`], 'ZIPs retain the selected directory as their established top-level member');
  assert.deepEqual(entries.get(`files/${f.filename}`), f.bytes);
  assert.equal(entries.get('files/empty/'), null);
  assert.equal((await f.control({ op: 'transfers.get', taskId: task.id })).status, 'completed');
});

test('download request-mode fixes do not bypass signed-cookie and cross-site rejection', { timeout: 10000, skip: skipWithoutRuntime }, async t => {
  const f = await fixture(t);
  const task = await f.control({ op: 'transfers.begin', direction: 'download', rootId: f.grant.id, path: f.filename });
  const relative = `/api/file-manager/download?taskId=${encodeURIComponent(task.id)}`;
  const unauthorized = await fetch(`${f.origin}${relative}`, { signal: AbortSignal.timeout(5000) });
  assert.equal(unauthorized.status, 401);
  await unauthorized.text();
  const crossSite = await f.request(relative, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  await crossSite.text();
  assert.equal((await f.control({ op: 'transfers.get', taskId: task.id })).status, 'queued');
});

test('closing task history through real HTTP requires authentication and never cancels a queued transfer', { timeout: 10000, skip: skipWithoutRuntime }, async t => {
  const f = await fixture(t);
  const finished = await f.control({ op: 'transfers.begin', direction: 'download', rootId: f.grant.id, path: f.filename });
  await (await f.request(`/api/file-manager/download?taskId=${finished.id}`)).arrayBuffer();
  const queued = await f.control({ op: 'transfers.begin', direction: 'download', rootId: f.grant.id, path: f.filename });
  const payload = { op: 'activities.dismiss', requestId: 'http-close-history', items: [
    { kind: 'transfer', taskId: finished.id, expectedHistoryRevision: 0 },
    { kind: 'transfer', taskId: queued.id, expectedHistoryRevision: 0 },
  ] };
  const unauthorized = await fetch(`${f.origin}/api/file-manager/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
  assert.equal(unauthorized.status, 401); await unauthorized.text();
  const crossSite = await f.request('/api/file-manager/control', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify(payload) });
  assert.equal(crossSite.status, 403); await crossSite.text();
  assert.notEqual((await f.control({ op: 'transfers.get', taskId: finished.id })).dismissed, true);
  const result = await f.control(payload);
  assert.deepEqual(result.results.map(item => item.outcome), ['dismissed', 'rejected']);
  assert.equal(result.results[1].error.code, 'TASK_BUSY');
  const closed = await f.control({ op: 'transfers.get', taskId: finished.id });
  assert.equal(closed.dismissed, true);
  assert.equal(closed.historyRevision, 1);
  assert.equal((await f.control({ op: 'transfers.get', taskId: queued.id })).status, 'queued');
  assert.deepEqual(await readFile(path.join(f.files, f.filename)), f.bytes);
  assert.deepEqual(f.failures, []);
});

test('text reads use the control route while large saves retain a streamed request body', { timeout: 10000, skip: skipWithoutRuntime }, async t => {
  const f = await fixture(t, { bytes: Buffer.from('original\n') });
  const snapshot = await f.control({ op: 'text.read', rootId: f.grant.id, path: f.filename });
  const text = 'large save without the carrier buffer cap\n'.repeat(8000);
  const saved = await f.request('/api/file-manager/text', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'save', requestId: randomUUID(), rootId: f.grant.id, path: f.filename, expectedVersion: snapshot.version, text }) });
  assert.equal(saved.status, 200, await saved.text());
  assert.equal(await readFile(path.join(f.files, f.filename), 'utf8'), text);
  const obsoleteGet = await f.request(`/api/file-manager/text?rootId=${f.grant.id}&path=${encodeURIComponent(f.filename)}`);
  assert.equal(obsoleteGet.status, 404, 'unsupported GET must be rejected by dispatch, not throw while constructing a Request body');
  await obsoleteGet.text();
  assert.deepEqual(f.failures, []);
});
