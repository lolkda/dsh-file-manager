import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createManager } from '../dist/host/manager.js';

async function fixture(t, options = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-write-'));
  const root = path.join(base, 'root');
  await mkdir(root);
  const manager = createManager({ ...options, rootPath: root });
  const grant = manager.getRoot();
  // Close before removing: an open manager still holds root descriptors, and
  // teardown must not race its pending work.
  t.after(async () => {
    await manager.close();
    await rm(base, { recursive: true, force: true });
  });
  const ref = relative => ({ rootId: grant.id, path: relative });
  return { base, root, manager, grant, ref };
}
const requireMethod = (manager, name) => assert.equal(typeof manager[name], 'function', `${name} has not been implemented`);
const exists = filename => stat(filename).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

test('the browsing root is opened rather than restored and needs no Session', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-persist-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  await mkdir(root);
  const manager = createManager({ rootPath: root });
  const grant = manager.getRoot();
  // Nothing about the root is durable, so a "restart" cannot depend on a store
  // that a container rebuild may have left behind.
  const restored = createManager({ rootPath: root });
  t.after(() => restored.close());
  assert.equal(restored.getRoot().id, grant.id, 'the same directory and identity yield the same root id');
  assert.equal(restored.getRoot().path, root);
  assert.equal((await restored.list({ rootId: grant.id, path: '' })).entries.length, 0);
  await manager.close();
});

test('closing a manager drains an accepted mutation and refuses newly submitted ones', async t => {
  const { manager, root, ref } = await fixture(t);
  requireMethod(manager, 'close');
  const rootId = manager.getRoot().id;
  await writeFile(path.join(root, 'seed.txt'), 'seed');
  const version = (await manager.io.stat(ref('seed.txt'))).version;
  // Gate a call the queued mutation really awaits, so "accepted" is proven: the
  // rename is inside the mutation queue and blocked before it can publish.
  let entered; let release;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const stat = manager.io.stat.bind(manager.io);
  let armed = false;
  manager.io.stat = async input => { if (armed) { armed = false; entered(); await gate; } return stat(input); };

  armed = true;
  const accepted = manager.rename({ ...ref('seed.txt'), name: 'renamed.txt', expectedVersion: version });
  await reached;
  const closing = manager.close();
  await assert.rejects(manager.createFile(ref('late.txt')), { code: 'SERVICE_STOPPED', status: 503 });
  await assert.rejects(manager.createDirectory(ref('late-dir')), { code: 'SERVICE_STOPPED', status: 503 });
  await assert.rejects(manager.prepareDelete({ items: [ref('renamed.txt')] }), { code: 'SERVICE_STOPPED', status: 503 });
  release();
  const settled = await Promise.allSettled([accepted, closing]);
  assert.equal(settled[0].status, 'fulfilled', 'an accepted mutation must be drained, never rejected');
  assert.equal(await exists(path.join(root, 'renamed.txt')), true, 'the drained mutation really published');
  assert.equal(await exists(path.join(root, 'seed.txt')), false);
  assert.equal(await exists(path.join(root, 'late.txt')), false, 'a refused submission must create nothing');
  assert.equal(await exists(path.join(root, 'late-dir')), false);
});

test('after a manager has closed every entry point reports SERVICE_STOPPED', async t => {
  const { manager, ref } = await fixture(t);
  requireMethod(manager, 'close');
  await manager.close();
  assert.throws(() => manager.getRoot(), { code: 'SERVICE_STOPPED', status: 503 });
  for (const call of [
    () => manager.list(ref('')),
    () => manager.readText(ref('file')),
    () => manager.stat(ref('file')),
    () => manager.io.stat(ref('file')),
    () => manager.io.acquireDirectory(ref('')),
  ]) {
    await assert.rejects(call(), { code: 'SERVICE_STOPPED', status: 503 });
  }
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
  // Approved contract change: permanent deletion binds a metadata snapshot
  // (`dev:ino:size:mtimeNs:ctimeNs`), not the file contents, so the manifest token
  // carries no digest and preparation stays off the content-verification budget.
  const { MetadataVersionSchema, ContentVersionSchema } = await import('../dist/contracts/views.js');
  const stats = await lstat(path.join(root, 'keep'), { bigint: true });
  const token = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
  assert.equal(MetadataVersionSchema.safeParse(plan.entries[0].version).success, true, `the server deletion manifest must bind metadata, got ${plan.entries[0].version}`);
  assert.equal(ContentVersionSchema.safeParse(plan.entries[0].version).success, false, 'a deletion manifest token must carry no content digest');
  assert.deepEqual(plan.entries, [{ rootId: ref('keep').rootId, path: 'keep', kind: 'file', size: 4, version: token }]);
  assert.equal(await exists(path.join(root, 'keep')), true);
  await assert.rejects(manager.commitDelete({ planId: plan.id, confirmed: false }), { code: 'CONFIRMATION_REQUIRED' });
  assert.equal(await exists(path.join(root, 'keep')), true);
});

test('deletion preparation can be cancelled before its manifest is published', async t => {
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

test('confirmed deletion removes the selected directory whole and nothing else', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'folder')); await writeFile(path.join(root, 'folder', 'file'), 'data');
  await writeFile(path.join(root, 'sibling'), 'sibling');
  requireMethod(manager, 'prepareDelete'); requireMethod(manager, 'commitDelete');
  const plan = await manager.prepareDelete({ items: [ref('folder')] });
  assert.equal(plan.entryCount, 1, 'a selected directory is one target: its contents are removed with it, never planned as entries');
  const result = await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.equal(result.status, 'completed');
  assert.equal(await exists(path.join(root, 'folder')), false);
  assert.equal(await readFile(path.join(root, 'sibling'), 'utf8'), 'sibling', 'an unselected sibling must survive the confirmed deletion');
});

test('a member added after preparation is deleted with the selected directory', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'folder')); await writeFile(path.join(root, 'folder', 'old'), 'old');
  requireMethod(manager, 'prepareDelete'); requireMethod(manager, 'commitDelete');
  const plan = await manager.prepareDelete({ items: [ref('folder')] });
  assert.equal(plan.entryCount, 1);
  await writeFile(path.join(root, 'folder', 'new'), 'new');
  // The confirmation covers the selected directory, so content created after
  // preparation is inside its scope and is removed with it.
  const result = await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.equal(result.status, 'completed', `content added inside the selected directory must be deleted with it: ${JSON.stringify(result.results)}`);
  assert.equal(await exists(path.join(root, 'folder')), false, 'the whole selected directory, added content included, must be gone');
  assert.deepEqual(await readdir(root), []);
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

// A selected ancestor owns its selected subtree only once.
test('overlapping ancestor and descendant selections are deduplicated before deletion', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'folder')); await writeFile(path.join(root, 'folder', 'file'), 'data');
  requireMethod(manager, 'prepareDelete');
  const plan = await manager.prepareDelete({ items: [ref('folder/file'), ref('folder'), ref('folder')] });
  assert.equal(plan.entryCount, 1, 'the two duplicates and the covered descendant collapse into the one selected directory');
  assert.equal(plan.targets.length, 1);
  assert.deepEqual(plan.entries.map(entry => entry.path), ['folder']);

  const result = await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.equal(result.status, 'completed');
  assert.equal(await exists(path.join(root, 'folder')), false, 'the deduplicated selection still deletes the whole directory');
});
