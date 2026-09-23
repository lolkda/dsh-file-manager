import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createManager } from '../dist/host/manager.js';

async function fixture(t, options = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-write-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  await mkdir(root);
  const manager = createManager(options);
  const grant = await manager.addRoot({ path: root });
  const ref = relative => ({ rootId: grant.id, path: relative });
  return { base, root, manager, grant, ref };
}
const requireMethod = (manager, name) => assert.equal(typeof manager[name], 'function', `${name} has not been implemented`);
const exists = filename => stat(filename).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

test('root grants are persisted before success and restored without a Session', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-persist-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  await mkdir(root);
  const stateFile = path.join(base, 'roots.json');
  const manager = createManager({ persistRoots: roots => writeFile(stateFile, JSON.stringify(roots)) });
  const grant = await manager.addRoot({ path: root });
  const saved = await readFile(stateFile, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; });
  assert.ok(saved, 'a successful root grant must already be durable');
  const restored = createManager({ initialRoots: JSON.parse(saved) });
  assert.equal(restored.listRoots()[0].id, grant.id);
  assert.equal((await restored.list({ rootId: grant.id, path: '' })).entries.length, 0);
});

test('failed root persistence does not publish an undurable grant', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-persist-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = createManager({ persistRoots: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
  await assert.rejects(manager.addRoot({ path: root }), { code: 'ENOSPC' });
  assert.deepEqual(manager.listRoots(), []);
});

test('failed root removal persistence preserves the existing grant', async t => {
  const { root, grant } = await fixture(t);
  const manager = createManager({ initialRoots: [grant], persistRoots: async () => { throw new Error('unavailable'); } });
  assert.equal(manager.listRoots().length, 1, 'restored grants must be usable');
  await assert.rejects(manager.removeRoot({ rootId: grant.id }), /unavailable/);
  assert.equal(manager.listRoots()[0].path, root);
});

test('concurrent grant changes retain both successful roots in persisted state', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-concurrent-roots-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(base, 'a')); await mkdir(path.join(base, 'b'));
  let persisted = [];
  const manager = createManager({ persistRoots: async roots => { persisted = structuredClone(roots); } });
  await Promise.all([manager.addRoot({ path: path.join(base, 'a') }), manager.addRoot({ path: path.join(base, 'b') })]);
  assert.equal(persisted.length, 2, 'concurrent persistence must not lose a grant');
});

test('closing a manager drains accepted writes and refuses newly submitted mutations', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-close-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let started;
  let finish;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const manager = createManager({ persistRoots: async () => { started(); await gate; } });
  requireMethod(manager, 'close');
  const adding = manager.addRoot({ path: root });
  await began;
  const closing = manager.close();
  await assert.rejects(manager.addRoot({ path: root }), { code: 'SERVICE_STOPPED' });
  finish();
  await adding;
  await closing;
});

test('configured text limits apply to reads rather than only UI hints', async t => {
  const { manager, root, ref } = await fixture(t, { maxTextBytes: 4 });
  await writeFile(path.join(root, 'file'), '12345');
  await assert.rejects(manager.readText(ref('file')), { code: 'TOO_LARGE' });
});

test('configured text limits reject oversized saves without changing the file', async t => {
  const { manager, root, ref } = await fixture(t, { maxTextBytes: 4 });
  await writeFile(path.join(root, 'file'), 'base');
  const opened = await manager.readText(ref('file'));
  await assert.rejects(manager.saveText({ ...ref('file'), text: 'longer', expectedVersion: opened.version }), { code: 'TOO_LARGE' });
  assert.equal(await readFile(path.join(root, 'file'), 'utf8'), 'base');
});

test('saving text preserves BOM, CRLF and executable permission bits', async t => {
  const { manager, root, ref } = await fixture(t);
  await writeFile(path.join(root, 'script.txt'), '\ufeffold\r\n');
  await chmod(path.join(root, 'script.txt'), 0o750);
  const opened = await manager.readText(ref('script.txt'));
  requireMethod(manager, 'saveText');
  const saved = await manager.saveText({ ...ref('script.txt'), text: '你好\nnext\n', expectedVersion: opened.version });
  assert.equal(await readFile(path.join(root, 'script.txt'), 'utf8'), '\ufeff你好\r\nnext\r\n');
  assert.equal((await stat(path.join(root, 'script.txt'))).mode & 0o777, 0o750);
  assert.notEqual(saved.version, opened.version);
  assert.equal(saved.text, '你好\r\nnext\r\n');
});

test('saving a stale text snapshot leaves the external version untouched', async t => {
  const { manager, root, ref } = await fixture(t);
  await writeFile(path.join(root, 'note'), 'base');
  const opened = await manager.readText(ref('note'));
  await writeFile(path.join(root, 'note'), 'external');
  requireMethod(manager, 'saveText');
  await assert.rejects(manager.saveText({ ...ref('note'), text: 'draft', expectedVersion: opened.version }), { code: 'VERSION_CONFLICT' });
  assert.equal(await readFile(path.join(root, 'note'), 'utf8'), 'external');
  assert.deepEqual(await readdir(root), ['note']);
});

test('saving without an expected version is refused', async t => {
  const { manager, root, ref } = await fixture(t);
  await writeFile(path.join(root, 'note'), 'base');
  requireMethod(manager, 'saveText');
  await assert.rejects(manager.saveText({ ...ref('note'), text: 'draft' }), { code: 'VERSION_REQUIRED' });
  assert.equal(await readFile(path.join(root, 'note'), 'utf8'), 'base');
});

test('two manager saves of the same base version have only one winner', async t => {
  const { manager, root, ref } = await fixture(t);
  await writeFile(path.join(root, 'note'), 'base');
  const opened = await manager.readText(ref('note'));
  requireMethod(manager, 'saveText');
  const results = await Promise.allSettled(['one', 'two'].map(text => manager.saveText({ ...ref('note'), text, expectedVersion: opened.version })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'VERSION_CONFLICT');
});

test('text saves never follow an existing symlink', async t => {
  const { manager, root, base, ref } = await fixture(t);
  const target = path.join(base, 'outside.txt');
  await writeFile(target, 'keep'); await symlink(target, path.join(root, 'link'));
  requireMethod(manager, 'saveText');
  await assert.rejects(manager.saveText({ ...ref('link'), text: 'replace', expectedVersion: 'not-a-version' }), { code: 'UNSUPPORTED_ENTRY' });
  assert.equal(await readFile(target, 'utf8'), 'keep');
});

test('creating a file publishes complete contents without overwriting an existing name', async t => {
  const { manager, root, ref } = await fixture(t);
  requireMethod(manager, 'createFile');
  await manager.createFile({ ...ref('new.txt'), text: '你好' });
  assert.equal(await readFile(path.join(root, 'new.txt'), 'utf8'), '你好');
  await assert.rejects(manager.createFile({ ...ref('new.txt'), text: 'replace' }), { code: 'ALREADY_EXISTS' });
  assert.equal(await readFile(path.join(root, 'new.txt'), 'utf8'), '你好');
  assert.deepEqual(await readdir(root), ['new.txt']);
});

test('creating a directory rejects an existing name rather than merging it', async t => {
  const { manager, root, ref } = await fixture(t);
  requireMethod(manager, 'createDirectory');
  await manager.createDirectory(ref('new'));
  assert.equal((await stat(path.join(root, 'new'))).isDirectory(), true);
  await assert.rejects(manager.createDirectory(ref('new')), { code: 'ALREADY_EXISTS' });
});

async function withFailedDirectorySync(root, operation) {
  const handle = await open(root, 'r');
  const prototype = Object.getPrototypeOf(handle);
  const original = prototype.sync;
  await handle.close();
  prototype.sync = async function () {
    if ((await this.stat()).isDirectory()) throw Object.assign(new Error('injected directory fsync failure'), { code: 'EIO' });
    return original.call(this);
  };
  try { return await operation(); }
  finally { prototype.sync = original; }
}

test('directory creation reports its committed effect if directory synchronization fails', async t => {
  const { root, manager, ref } = await fixture(t);
  const failure = await withFailedDirectorySync(root, () => manager.createDirectory(ref('created')).catch(error => error));
  assert.equal(failure.code, 'EIO');
  assert.equal((await stat(path.join(root, 'created'))).isDirectory(), true);
  assert.equal(failure.details?.committed, true);
});

test('rename reports its committed effect if directory synchronization fails', async t => {
  const { root, manager, ref } = await fixture(t);
  await writeFile(path.join(root, 'old'), 'retained');
  const selected = await manager.stat(ref('old'));
  const failure = await withFailedDirectorySync(root, () => manager.rename({ ...ref('old'), name: 'new', expectedVersion: selected.version }).catch(error => error));
  assert.equal(failure.code, 'EIO');
  assert.equal(await readFile(path.join(root, 'new'), 'utf8'), 'retained');
  assert.equal(failure.details?.committed, true);
});

test('creating a file through a symlinked parent is refused', async t => {
  const { manager, root, base, ref } = await fixture(t);
  const outside = path.join(base, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(root, 'linked'));
  requireMethod(manager, 'createFile');
  await assert.rejects(manager.createFile({ ...ref('linked/new.txt'), text: 'bad' }), { code: 'UNSUPPORTED_ENTRY' });
  assert.deepEqual(await readdir(outside), []);
});

test('rename changes the name only after its source version is checked', async t => {
  const { manager, root, ref } = await fixture(t);
  await writeFile(path.join(root, 'old.txt'), 'content');
  const entry = (await manager.list({ ...ref('') })).entries[0];
  requireMethod(manager, 'rename');
  const result = await manager.rename({ ...ref('old.txt'), name: '新名字.txt', expectedVersion: entry.version });
  assert.equal(result.path, '新名字.txt');
  assert.equal(await exists(path.join(root, 'old.txt')), false);
  assert.equal(await readFile(path.join(root, '新名字.txt'), 'utf8'), 'content');
});

test('rename does not overwrite an existing destination', async t => {
  const { manager, root, ref } = await fixture(t);
  await writeFile(path.join(root, 'a'), 'a'); await writeFile(path.join(root, 'b'), 'b');
  const entry = (await manager.list(ref(''))).entries.find(item => item.name === 'a');
  requireMethod(manager, 'rename');
  await assert.rejects(manager.rename({ ...ref('a'), name: 'b', expectedVersion: entry.version }), { code: 'ALREADY_EXISTS' });
  assert.equal(await readFile(path.join(root, 'a'), 'utf8'), 'a');
  assert.equal(await readFile(path.join(root, 'b'), 'utf8'), 'b');
});

test('rename refuses a source that changed after the listing', async t => {
  const { manager, root, ref } = await fixture(t);
  await writeFile(path.join(root, 'a'), 'a');
  const entry = (await manager.list(ref(''))).entries[0];
  await writeFile(path.join(root, 'a'), 'changed');
  requireMethod(manager, 'rename');
  await assert.rejects(manager.rename({ ...ref('a'), name: 'b', expectedVersion: entry.version }), { code: 'VERSION_CONFLICT' });
  assert.equal(await exists(path.join(root, 'b')), false);
});

test('delete preparation is read-only and commit requires explicit confirmation', async t => {
  const { manager, root, ref } = await fixture(t);
  await writeFile(path.join(root, 'keep'), 'keep');
  requireMethod(manager, 'prepareDelete'); requireMethod(manager, 'commitDelete');
  const plan = await manager.prepareDelete({ items: [ref('keep')] });
  assert.equal(plan.entryCount, 1);
  assert.ok(plan.entries[0].version.endsWith(`:${createHash('sha256').update('keep').digest('hex')}`), 'the server deletion manifest must bind actual file contents');
  assert.deepEqual(plan.entries, [{ rootId: ref('keep').rootId, path: 'keep', kind: 'file', size: 4, version: (await manager.stat(ref('keep'))).version }]);
  assert.equal(await exists(path.join(root, 'keep')), true);
  await assert.rejects(manager.commitDelete({ planId: plan.id, confirmed: false }), { code: 'CONFIRMATION_REQUIRED' });
  assert.equal(await exists(path.join(root, 'keep')), true);
});

test('deletion preparation can be cancelled before content hashing completes', async t => {
  const { manager, root, ref } = await fixture(t);
  await writeFile(path.join(root, 'file'), 'content');
  const controller = new AbortController();
  const preparing = manager.prepareDelete({ items: [ref('file')], signal: controller.signal });
  controller.abort();
  await assert.rejects(preparing, { code: 'CANCELLED' });
  assert.equal(await readFile(path.join(root, 'file'), 'utf8'), 'content');
});

test('renaming a file accepts its strong selected version without silently refreshing it', async t => {
  const { manager, root, ref } = await fixture(t);
  await writeFile(path.join(root, 'file'), 'content');
  const selected = await manager.readText(ref('file'));
  const result = await manager.rename({ ...ref('file'), name: 'renamed', expectedVersion: selected.version });
  assert.equal(result.path, 'renamed');
  assert.equal(await readFile(path.join(root, 'renamed'), 'utf8'), 'content');
});

test('confirmed recursive deletion removes exactly the prepared tree', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'folder')); await writeFile(path.join(root, 'folder', 'file'), 'data');
  requireMethod(manager, 'prepareDelete'); requireMethod(manager, 'commitDelete');
  const plan = await manager.prepareDelete({ items: [ref('folder')] });
  assert.equal(plan.entryCount, 2);
  const result = await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.equal(result.status, 'completed');
  assert.equal(await exists(path.join(root, 'folder')), false);
});

test('a changed deletion manifest is rejected without deleting its new contents', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'folder')); await writeFile(path.join(root, 'folder', 'old'), 'old');
  requireMethod(manager, 'prepareDelete'); requireMethod(manager, 'commitDelete');
  const plan = await manager.prepareDelete({ items: [ref('folder')] });
  await writeFile(path.join(root, 'folder', 'new'), 'new');
  await assert.rejects(manager.commitDelete({ planId: plan.id, confirmed: true }), { code: 'VERSION_CONFLICT' });
  assert.deepEqual((await readdir(path.join(root, 'folder'))).sort(), ['new', 'old']);
});

test('duplicate delete commit returns its receipt and cannot delete a newly recreated file', async t => {
  const { manager, root, ref } = await fixture(t);
  await writeFile(path.join(root, 'file'), 'old');
  requireMethod(manager, 'prepareDelete'); requireMethod(manager, 'commitDelete');
  const plan = await manager.prepareDelete({ items: [ref('file')] });
  const first = await manager.commitDelete({ planId: plan.id, confirmed: true });
  await writeFile(path.join(root, 'file'), 'new');
  const duplicate = await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.deepEqual(duplicate, first);
  assert.equal(await readFile(path.join(root, 'file'), 'utf8'), 'new');
});

test('deleting a link removes only the link, not its target', async t => {
  const { manager, root, base, ref } = await fixture(t);
  const target = path.join(base, 'outside'); await writeFile(target, 'keep');
  await symlink(target, path.join(root, 'link'));
  requireMethod(manager, 'prepareDelete'); requireMethod(manager, 'commitDelete');
  const plan = await manager.prepareDelete({ items: [ref('link')] });
  await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.equal(await readFile(target, 'utf8'), 'keep');
  assert.deepEqual(await readdir(root), []);
});

test('the granted root itself cannot be prepared for recursive deletion', async t => {
  const { manager, ref } = await fixture(t);
  requireMethod(manager, 'prepareDelete');
  await assert.rejects(manager.prepareDelete({ items: [ref('')] }), { code: 'ROOT_OPERATION_NOT_ALLOWED' });
});

test('delete confirmation expires and cannot be reused after its deadline', async t => {
  let clock = 1000;
  const { manager, root, ref } = await fixture(t, { now: () => clock, deletePlanTtlMs: 10 });
  await writeFile(path.join(root, 'keep'), 'keep');
  requireMethod(manager, 'prepareDelete'); requireMethod(manager, 'commitDelete');
  const plan = await manager.prepareDelete({ items: [ref('keep')] });
  clock = 1011;
  await assert.rejects(manager.commitDelete({ planId: plan.id, confirmed: true }), { code: 'PLAN_EXPIRED' });
  assert.equal(await exists(path.join(root, 'keep')), true);
});

test('completed deletion receipts expire instead of exhausting the confirmation cache', async t => {
  let clock = 1000;
  const { manager, root, ref } = await fixture(t, { now: () => clock, deletePlanTtlMs: 5 });
  for (let index = 0; index < 66; index++) {
    await writeFile(path.join(root, 'file'), String(index));
    const plan = await manager.prepareDelete({ items: [ref('file')] });
    assert.equal((await manager.commitDelete({ planId: plan.id, confirmed: true })).status, 'completed');
    clock += 6;
  }
  assert.equal(await exists(path.join(root, 'file')), false);
});

// A selected ancestor owns its prepared subtree only once.
test('overlapping ancestor and descendant selections are deduplicated before deletion', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'folder')); await writeFile(path.join(root, 'folder', 'file'), 'data');
  requireMethod(manager, 'prepareDelete');
  const plan = await manager.prepareDelete({ items: [ref('folder/file'), ref('folder'), ref('folder')] });
  assert.equal(plan.entryCount, 2);
  assert.equal(plan.targets.length, 1);
});
