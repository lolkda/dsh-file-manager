import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import * as plugin from '../index.js';
import { createManager } from '../host/manager.js';

async function integrated(t) {
  const { createTaskService } = await import('../host/tasks.js');
  const { createTransferService } = await import('../host/transfers.js');
  const { createWatchService } = await import('../host/watch.js');
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-integration-'));
  const manager = createManager();
  const grant = await manager.addRoot({ path: root });
  const limits = { maxTextBytes: 5 * 1024 ** 2, maxFileBytes: 2 * 1024 ** 3, maxTaskBytes: 10 * 1024 ** 3, maxTaskEntries: 10000, transferConcurrency: 2 };
  let settled;
  const completed = new Promise(resolve => { settled = resolve; });
  const tasks = createTaskService({ manager, limits, onChange: task => { if (['completed', 'partial', 'failed', 'cancelled'].includes(task.status)) settled(task); } });
  const transfers = createTransferService({ manager, limits });
  const watcher = createWatchService({ manager });
  t.after(async () => { await watcher.close(); await transfers.close(); await tasks.close(); await manager.close(); await rm(root, { recursive: true, force: true }); });
  const control = plugin.createControlHandler({ manager, tasks, transfers, watcher, limits, workspaces: () => [] });
  const ref = relative => ({ rootId: grant.id, path: relative });
  const call = payload => control(request({ requestId: randomUUID(), ...payload }));
  return { root, manager, tasks, transfers, watcher, ref, call, completed };
}

const request = (payload, endpoint = 'control') => new Request(`http://localhost/api/file-manager/${endpoint}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
});
async function fixture(t) {
  assert.equal(typeof plugin.createTextHandler, 'function', 'the versioned text route is missing');
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-write-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = createManager();
  const grant = await manager.addRoot({ path: root });
  const control = plugin.createControlHandler({ manager, workspaces: () => [] });
  const text = plugin.createTextHandler({ manager });
  const ref = relative => ({ rootId: grant.id, path: relative });
  const call = payload => control(request({ requestId: randomUUID(), ...payload }));
  return { root, manager, control, text, ref, call };
}

test('the control API creates an empty file and a directory inside an explicit root', async t => {
  const { root, ref, call } = await fixture(t);
  assert.equal((await call({ op: 'entries.create-file', ...ref('file') })).status, 200);
  assert.equal(await readFile(path.join(root, 'file'), 'utf8'), '');
  assert.equal((await call({ op: 'entries.create-directory', ...ref('folder') })).status, 200);
  assert.equal((await stat(path.join(root, 'folder'))).isDirectory(), true);
});

test('the text endpoint saves bodies larger than the small control-envelope limit', async t => {
  const { root, manager, text, ref } = await fixture(t);
  const original = await manager.createFile({ ...ref('file'), text: 'base' });
  const contents = 'a'.repeat(300 * 1024);
  const response = await text(request({ op: 'save', ...ref('file'), text: contents, expectedVersion: original.version, requestId: randomUUID() }, 'text'));
  assert.equal(response.status, 200);
  const value = (await response.json()).value;
  assert.ok(value.version);
  assert.equal('text' in value, false, 'idempotency receipts must not retain whole file bodies');
  assert.equal(await readFile(path.join(root, 'file'), 'utf8'), contents);
});

test('a repeated text save request returns its original receipt rather than writing twice', async t => {
  const { manager, text, ref } = await fixture(t);
  const original = await manager.createFile({ ...ref('file'), text: 'base' });
  const payload = { op: 'save', ...ref('file'), text: 'next', expectedVersion: original.version, requestId: 'same-save-request' };
  const first = await (await text(request(payload, 'text'))).json();
  const again = await text(request(payload, 'text'));
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), first);
});

test('reusing one request id for different writes is rejected', async t => {
  const { manager, text, ref } = await fixture(t);
  const original = await manager.createFile({ ...ref('file'), text: 'base' });
  const payload = { op: 'save', ...ref('file'), text: 'next', expectedVersion: original.version, requestId: 'reused-save-request' };
  assert.equal((await text(request(payload, 'text'))).status, 200);
  const response = await text(request({ ...payload, text: 'different' }, 'text'));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'REQUEST_ID_REUSED');
});

test('wire-level mutations require a request id', async t => {
  const { control, ref } = await fixture(t);
  const response = await control(request({ op: 'entries.create-file', ...ref('file') }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
});

test('wire-level rename checks the listing version', async t => {
  const { manager, ref, call } = await fixture(t);
  await manager.createFile({ ...ref('old'), text: 'contents' });
  const entry = (await manager.list(ref(''))).entries[0];
  const response = await call({ op: 'entries.rename', ...ref('old'), name: 'new', expectedVersion: entry.version });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).value.path, 'new');
});

test('wire-level deletion uses the server-held confirmation rather than client file lists', async t => {
  const { manager, ref, call } = await fixture(t);
  await manager.createFile({ ...ref('file'), text: 'contents' });
  const plan = (await (await call({ op: 'delete.prepare', items: [ref('file')] })).json()).value;
  assert.ok(plan?.id);
  const refused = await call({ op: 'delete.commit', planId: plan.id, confirmed: false });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, 'CONFIRMATION_REQUIRED');
  const completed = await call({ op: 'delete.commit', planId: plan.id, confirmed: true });
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).value.status, 'completed');
});

test('an I/O failure after publication reports that the filesystem already changed', async t => {
  const { manager, ref, root } = await fixture(t);
  const control = plugin.createControlHandler({
    manager: { ...manager, async createDirectory(target) {
      await manager.createDirectory(target);
      throw Object.assign(new Error('simulated directory sync failure'), { code: 'EIO', details: { committed: true } });
    } },
    workspaces: () => [],
  });
  const response = await control(request({ op: 'entries.create-directory', ...ref('created'), requestId: randomUUID() }));
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.details.committed, true);
  assert.equal((await stat(path.join(root, 'created'))).isDirectory(), true);
});

test('bootstrap advertises only the services actually composed into its controller', async t => {
  const { call } = await integrated(t);
  const response = await call({ op: 'bootstrap' });
  const { capabilities } = (await response.json()).value;
  assert.equal(capabilities.tasks, true);
  assert.equal(capabilities.transfers, true);
  assert.equal(capabilities.watch, true);
  assert.equal(capabilities.references, true);
});

test('copy task endpoints drive the real task engine and expose its completed result', async t => {
  const { manager, ref, call, completed, root } = await integrated(t);
  await manager.createFile({ ...ref('source'), text: 'payload' });
  await manager.createDirectory(ref('destination'));
  const source = await manager.stat(ref('source'));
  const response = await call({ op: 'tasks.start', operation: 'copy', items: [{ ...ref('source'), expectedVersion: source.version }], destination: ref('destination'), conflict: 'skip' });
  assert.equal(response.status, 200);
  const task = (await response.json()).value;
  assert.equal((await completed).status, 'completed');
  const current = await (await call({ op: 'tasks.get', taskId: task.id })).json();
  assert.equal(current.value.status, 'completed');
  assert.equal(await readFile(path.join(root, 'destination', 'source'), 'utf8'), 'payload');
});

test('transfer control endpoints prepare a real raw download', async t => {
  const { manager, ref, call, transfers } = await integrated(t);
  await manager.createFile({ ...ref('file.txt'), text: 'real transfer' });
  const begin = await call({ op: 'transfers.begin', direction: 'download', ...ref('file.txt') });
  assert.equal(begin.status, 200);
  const task = (await begin.json()).value;
  const response = await transfers.handleDownload(new Request(`http://localhost/api/file-manager/download?taskId=${encodeURIComponent(task.id)}`));
  assert.equal(await response.text(), 'real transfer');
  const fetched = await (await call({ op: 'transfers.get', taskId: task.id })).json();
  assert.equal(fetched.value.status, 'completed');
});

test('large bounded transfer manifests are not rejected by the small control-envelope cap', async t => {
  const { call, ref } = await integrated(t);
  const items = Array.from({ length: 1400 }, (_, index) => ({ path: `file-${index}-${'x'.repeat(185)}`, kind: 'file', size: 0 }));
  const input = { op: 'transfers.begin', direction: 'upload', ...ref(''), items };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) > 256 * 1024);
  const response = await call(input);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).value.itemsTotal, items.length);
});

test('file references use checked absolute Host paths and closed directory quotes', async t => {
  const { manager, ref, call, root } = await integrated(t);
  await manager.createDirectory(ref('folder name'));
  const response = await call({ op: 'entries.reference', ...ref('folder name') });
  assert.equal(response.status, 200);
  const value = (await response.json()).value;
  assert.equal(value.absolutePath, path.join(root, 'folder name'));
  assert.equal(value.mention, `@\"${path.join(root, 'folder name')}/\"`);
});

test('unrepresentable quote characters are refused instead of producing ambiguous references', async t => {
  const { manager, ref, call } = await integrated(t);
  await manager.createFile({ ...ref('quote\".txt'), text: 'data' });
  const response = await call({ op: 'entries.reference', ...ref('quote\".txt') });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'UNREPRESENTABLE_REFERENCE');
});
