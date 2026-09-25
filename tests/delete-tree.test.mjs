/**
 * Deletion of a selected directory is a *tree* operation, not a manifest walk.
 *
 * Approved contract change (this file is the failing regression for it):
 *
 * - `delete.prepare` checks and records only the deduplicated *selected* entries.
 *   It never enumerates, stats or reads a descendant of a selected directory, so
 *   `entryCount`/`entries` describe the selection, not the subtree, and a tree of
 *   any size (including far more than 10000 descendants) is preparable. The
 *   selection bound (`DELETE_PLAN_MAX_SELECTIONS`, 10000) still applies to the
 *   number of selected targets.
 * - The published confirmation is scoped: `scope: 'selected-trees'`. A caller
 *   holding a plan prepared under the old per-leaf semantics must not be able to
 *   confirm a recursive tree removal by accident.
 * - Confirming a selected directory binds its *identity* (device/inode/type),
 *   not its children's metadata. Content created, modified or removed inside the
 *   tree while the confirmation is pending is still inside the deletion scope:
 *   the whole tree goes away. Replacing the selected directory itself with a
 *   different inode is still a `VERSION_CONFLICT`.
 * - A selected regular file or symlink keeps the stronger metadata binding: an
 *   ordinary same-size rewrite (or an inode replacement) is still refused. Two
 *   selected paths that share one inode are a special case of that binding: the
 *   first removal moves the shared `nlink`/`ctime`, which is this operation's own
 *   doing, so the remaining selected paths of that inode are re-derived from the
 *   pinned original inode instead of being declared stale — while an outside
 *   rewrite through a third link still conflicts.
 * - The result is reported per *selected target*, not per leaf. `removed`
 *   describes the selected target itself. A directory whose subtree could only be
 *   partly removed reports `failed` for that target and sets
 *   `contentsChanged: true`, because entries inside it really were removed; the
 *   surviving content is checked below. Nothing may claim the tree was untouched.
 * - Unchanged protections: the granted root itself cannot be deleted, symlinks
 *   are removed as links and never followed, cancellation/confirmation/TTL/
 *   idempotency behave as before.
 * - Names inside a selected directory are resolved relative to a held directory
 *   descriptor, so a legal Linux name the UI path grammar cannot express (for
 *   example a backslash) no longer blocks deleting the tree that contains it.
 *   Selecting such a name directly is still refused with `INVALID_PATH`.
 *
 * Every case uses the real filesystem under a temporary root. Cases that need a
 * permission denial first probe that this process actually enforces Unix
 * permissions, and skip with a visible reason when it does not (a root or
 * DAC-overriding process would otherwise pass them for the wrong reason).
 */

import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createManager } from '../dist/host/manager.js';
import { measureReads } from './verify-harness.mjs';

/** Large enough that "did it read the file?" is decidable, small enough to stay cheap as a sparse file. */
const SIZE = 16 * 1024 * 1024;

/** Anything under this is metadata work; any real content read of a 16 MiB file is far above it. */
const METADATA_NOISE_LIMIT = 1024 * 1024;

async function fixture(t, options = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-fm-tree-'));
  const root = path.join(base, 'root');
  await mkdir(root);
  const manager = createManager(options);
  const grant = await manager.addRoot({ path: root });
  // Close the manager before removing its directory: an open manager keeps root
  // descriptors and pending plans alive, and teardown must not race them.
  t.after(async () => {
    await manager.close();
    await rm(base, { recursive: true, force: true });
  });
  const ref = relative => ({ rootId: grant.id, path: relative });
  return { base, root, manager, grant, ref };
}

const exists = filename => lstat(filename).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

/** The rejection a call produced, or `null` when it resolved. */
const rejection = promise => promise.then(() => null, error => error);

/**
 * Create `names` under `directory` with at most `concurrency` writes in flight,
 * so a bulk fixture never opens thousands of descriptors at once.
 */
async function writeMany(directory, names, concurrency = 24) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, names.length) }, async () => {
    while (next < names.length) {
      const name = names[next++];
      await writeFile(path.join(directory, name), '');
    }
  });
  await Promise.all(workers);
}

/** A sparse file of `bytes`: cheap to create, but a real read still moves `bytes` through rchar. */
async function sparseFile(filename, bytes) {
  const handle = await open(filename, 'w');
  try { await handle.truncate(bytes); } finally { await handle.close(); }
}

/**
 * `EACCES` when this process really cannot read a mode-000 directory; `null` when
 * it can (root or CAP_DAC_READ_SEARCH), in which case "preparation cannot read
 * the directory" is not decidable here.
 */
async function unreadableDirectoryProbe(base) {
  const directory = path.join(base, 'probe-unreadable-directory');
  await mkdir(directory);
  await chmod(directory, 0o000);
  const failure = await readdir(directory).then(() => null, error => error);
  await chmod(directory, 0o755);
  return failure;
}

/** `EACCES` when this process really cannot unlink inside a mode-0555 directory; `null` when it can. */
async function readOnlyDirectoryProbe(base) {
  const directory = await mkdtemp(path.join(base, 'probe-readonly-'));
  const file = path.join(directory, 'file');
  await writeFile(file, 'probe');
  await chmod(directory, 0o555);
  const failure = await rm(file).then(() => null, error => error);
  await chmod(directory, 0o755);
  return failure;
}

test('preparing a selected directory records only that target and never enumerates its subtree', async t => {
  const { manager, root, grant, ref } = await fixture(t);
  await mkdir(path.join(root, 'deep', 'a', 'b'), { recursive: true });
  await writeFile(path.join(root, 'deep', 'a', 'b', 'leaf.txt'), 'leaf');
  await writeFile(path.join(root, 'deep', 'a', 'sibling.txt'), 'keep');

  const plan = await manager.prepareDelete({ items: [ref('deep')] });

  assert.equal(plan.permanent, true);
  assert.deepEqual(plan.targets, [{ rootId: grant.id, path: 'deep' }]);
  assert.equal(plan.entryCount, 1, 'the manifest counts the selected target, not its descendants');
  assert.deepEqual(plan.entries.map(entry => entry.path), ['deep'], 'the manifest must list the selected directory and nothing below it');
  assert.equal(plan.entries[0].kind, 'directory');
  assert.equal(plan.scope, 'selected-trees', 'a plan that deletes a whole tree must say so, so an old caller cannot confirm it by accident');

  // Preparation is read-only: the subtree is untouched, byte for byte.
  assert.deepEqual((await readdir(path.join(root, 'deep'))).sort(), ['a']);
  assert.deepEqual((await readdir(path.join(root, 'deep', 'a'))).sort(), ['b', 'sibling.txt']);
  assert.equal(await readFile(path.join(root, 'deep', 'a', 'b', 'leaf.txt'), 'utf8'), 'leaf');
  assert.equal(await readFile(path.join(root, 'deep', 'a', 'sibling.txt'), 'utf8'), 'keep');
});

test('selecting a directory and an entry inside it records only the directory', async t => {
  const { manager, root, grant, ref } = await fixture(t);
  await mkdir(path.join(root, 'tree', 'inner'), { recursive: true });
  await writeFile(path.join(root, 'tree', 'inner', 'a'), 'a');

  const plan = await manager.prepareDelete({ items: [ref('tree'), ref('tree/inner/a'), ref('tree/inner')] });

  assert.deepEqual(plan.targets, [{ rootId: grant.id, path: 'tree' }], 'an entry inside a selected tree is already covered by that tree');
  assert.equal(plan.entryCount, 1);
  assert.deepEqual(plan.entries.map(entry => entry.path), ['tree']);
});

test('a selected directory with more than 10000 descendants can be prepared and deleted', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'tree'));
  // 12000 empty files, well past the old manifest bound (10000), created with
  // bounded concurrency so the fixture never holds thousands of descriptors.
  const names = Array.from({ length: 12000 }, (_, index) => `a${String(index).padStart(5, '0')}`);
  await writeMany(path.join(root, 'tree'), names);
  await mkdir(path.join(root, 'sibling'));
  await writeFile(path.join(root, 'sibling', 'keep.txt'), 'keep');
  assert.equal((await readdir(path.join(root, 'tree'))).length, 12000);

  const plan = await manager.prepareDelete({ items: [ref('tree')] });
  assert.equal(plan.entryCount, 1, 'the descendant count must never enter the manifest, so it can never trip the entry bound');
  assert.equal(plan.targets.length, 1);

  const result = await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.equal(result.results.length, 1, 'a tree is one selected target and therefore one result');
  assert.equal(result.status, 'completed', `a tree of 12000 files must be removed as one target, got ${JSON.stringify(result.results)}`);
  assert.equal(await exists(path.join(root, 'tree')), false);
  assert.deepEqual(await readdir(root), ['sibling'], 'an unselected sibling must survive');
  assert.equal(await readFile(path.join(root, 'sibling', 'keep.txt'), 'utf8'), 'keep');
});

test('a selected directory still deletes content added or modified after preparation', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'tree', 'inner'), { recursive: true });
  await writeFile(path.join(root, 'tree', 'inner', 'a'), 'a');
  await writeFile(path.join(root, 'tree', 'top.txt'), 'top');

  const plan = await manager.prepareDelete({ items: [ref('tree')] });
  assert.equal(plan.entryCount, 1);

  // All of this lands while the confirmation is pending.
  await writeFile(path.join(root, 'tree', 'inner', 'new.txt'), 'new');
  await writeFile(path.join(root, 'tree', 'inner', 'a'), 'a-modified');
  await writeFile(path.join(root, 'tree', 'late.txt'), 'late');

  const result = await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.equal(result.status, 'completed',
    `content created after preparation is inside the scope of the selected tree, got ${JSON.stringify(result.results)}`);
  assert.equal(await exists(path.join(root, 'tree')), false, 'the whole tree must be gone, including what appeared after preparation');
  assert.deepEqual(await readdir(root), []);
});

test('preparing a selected directory does not read the content of the files inside it', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'tree'));
  await sparseFile(path.join(root, 'tree', 'big.bin'), SIZE);
  await writeFile(path.join(root, 'tree', 'small.txt'), 'small');

  const measured = await measureReads(() => manager.prepareDelete({ items: [ref('tree')] }));
  assert.equal(measured.value.entryCount, 1);
  assert.ok(measured.bytes < METADATA_NOISE_LIMIT,
    `preparing a selected directory must not read the ${SIZE} byte file inside it (a full read would move rchar by at least ${SIZE}): rchar delta ${measured.bytes} must stay under ${METADATA_NOISE_LIMIT}`);
});

test('a selected directory that cannot be enumerated can still be prepared', async t => {
  const { manager, base, root, ref } = await fixture(t);
  // Guard first: with DAC override this process could read the mode-000
  // directory, and the case would prove nothing.
  const denied = await unreadableDirectoryProbe(base);
  if (denied === null) {
    t.skip('this process can read a mode-000 directory (root or CAP_DAC_READ_SEARCH), so "preparation cannot read the tree" is not decidable here');
    return;
  }
  assert.equal(denied.code, 'EACCES', 'the fixture must be unreadable for the expected reason');

  const locked = path.join(root, 'locked');
  await mkdir(path.join(locked, 'inner'), { recursive: true });
  await writeFile(path.join(locked, 'inner', 'file.txt'), 'inner');
  await chmod(locked, 0o000);
  let plan;
  try {
    plan = await manager.prepareDelete({ items: [ref('locked')] });
  } finally {
    // Restored even when preparation rejects, so teardown can remove the tree.
    await chmod(locked, 0o755);
  }

  assert.equal(plan.entryCount, 1);
  assert.equal(plan.entries[0].kind, 'directory');
  assert.deepEqual(plan.entries.map(entry => entry.path), ['locked']);
  assert.equal(await readFile(path.join(locked, 'inner', 'file.txt'), 'utf8'), 'inner', 'preparation is read-only and must remove nothing');
});

test('a selected directory containing a name the path grammar cannot express is deleted as a tree', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'folder'));
  // A backslash is a legal Linux file name but not part of the addressable grammar.
  await writeFile(path.join(root, 'folder', 'bad\\name'), 'bad');
  await writeFile(path.join(root, 'folder', 'plain'), 'plain');

  const plan = await manager.prepareDelete({ items: [ref('folder')] });
  assert.equal(plan.entryCount, 1);

  const result = await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.equal(result.status, 'completed',
    `a name the UI grammar cannot express must not block deleting the tree that contains it, got ${JSON.stringify(result.results)}`);
  assert.equal(await exists(path.join(root, 'folder')), false);
  assert.deepEqual(await readdir(root), []);
});

test('selecting a name the path grammar cannot express is still refused', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'folder'));
  await writeFile(path.join(root, 'folder', 'bad\\name'), 'bad');

  const refused = await rejection(manager.prepareDelete({ items: [ref('folder/bad\\name')] }));
  assert.ok(refused, 'an unaddressable name must not become selectable just because trees are removed through descriptors');
  assert.equal(refused.code, 'INVALID_PATH');
  assert.equal(refused.status, 400);
  assert.deepEqual(await readdir(path.join(root, 'folder')), ['bad\\name']);
});

test('replacing the prepared directory with a different inode is refused and both trees survive', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'folder'));
  await writeFile(path.join(root, 'folder', 'keep.txt'), 'keep');

  const plan = await manager.prepareDelete({ items: [ref('folder')] });
  assert.deepEqual(plan.targets.map(target => target.path), ['folder']);

  // The original tree is kept alive under another name, so the replacement cannot
  // reuse its inode. The confirmation binds the selected directory's identity, so
  // this swap is a conflict even though the replacement is a directory too.
  await rename(path.join(root, 'folder'), path.join(root, 'moved'));
  await mkdir(path.join(root, 'folder'));
  await writeFile(path.join(root, 'folder', 'new.txt'), 'new');

  const rejected = await rejection(manager.commitDelete({ planId: plan.id, confirmed: true }));
  assert.ok(rejected, 'a replaced directory must invalidate the prepared tree deletion');
  assert.equal(rejected.code, 'VERSION_CONFLICT');
  assert.equal(rejected.status, 409);
  assert.equal(await readFile(path.join(root, 'folder', 'new.txt'), 'utf8'), 'new', 'the replacement must survive');
  assert.equal(await readFile(path.join(root, 'moved', 'keep.txt'), 'utf8'), 'keep', 'the original tree must survive');
  assert.deepEqual((await readdir(root)).sort(), ['folder', 'moved']);
});

test('selecting a symlink to a directory outside the root removes only the link', async t => {
  const { manager, base, root, ref } = await fixture(t);
  const outside = path.join(base, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'precious.txt'), 'precious');
  await symlink(outside, path.join(root, 'link'));

  const plan = await manager.prepareDelete({ items: [ref('link')] });
  assert.equal(plan.entries[0].kind, 'symlink');

  const result = await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.equal(result.status, 'completed');
  assert.equal(await exists(path.join(root, 'link')), false, 'the link itself must be removed');
  assert.equal(await readFile(path.join(outside, 'precious.txt'), 'utf8'), 'precious', 'a link target must never be followed');
  assert.deepEqual(await readdir(outside), ['precious.txt']);
});

test('a symlink inside a selected directory is removed as a link and its target survives', async t => {
  const { manager, base, root, ref } = await fixture(t);
  const outside = path.join(base, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'precious.txt'), 'precious');
  await mkdir(path.join(root, 'tree', 'inner'), { recursive: true });
  await symlink(outside, path.join(root, 'tree', 'inner', 'link'));
  await symlink(outside, path.join(root, 'tree', 'link'));
  await writeFile(path.join(root, 'tree', 'inner', 'plain.txt'), 'plain');

  const plan = await manager.prepareDelete({ items: [ref('tree')] });
  assert.deepEqual(plan.targets.map(target => target.path), ['tree']);

  const result = await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.equal(result.status, 'completed', `a link inside a deleted tree must be removed as a link, got ${JSON.stringify(result.results)}`);
  assert.equal(await exists(path.join(root, 'tree')), false);
  assert.equal(await readFile(path.join(outside, 'precious.txt'), 'utf8'), 'precious', 'a link inside the tree must never be followed');
  assert.deepEqual(await readdir(outside), ['precious.txt'], 'the directory outside the root must be untouched');
});

test('a selected file rewritten with the same size is still refused', async t => {
  const { manager, root, ref } = await fixture(t);
  const file = path.join(root, 'note');
  const fixed = 1700000000.5;
  await writeFile(file, 'aaaa');
  await utimes(file, fixed, fixed);
  const before = await lstat(file, { bigint: true });

  const plan = await manager.prepareDelete({ items: [ref('note')] });
  await writeFile(file, 'bbbb');
  // Restore mtime byte-for-byte and let only ctime move, so the case isolates the
  // metadata binding instead of relying on a coarse timestamp tick. The kernel
  // bumps ctime on every update; the loop only covers two updates landing inside
  // the same tick.
  for (let attempt = 0; attempt < 100; attempt++) {
    await utimes(file, fixed, fixed);
    const current = await lstat(file, { bigint: true });
    if (current.mtimeNs === before.mtimeNs && current.ctimeNs !== before.ctimeNs) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const after = await lstat(file, { bigint: true });
  assert.equal(after.ino, before.ino, 'the case must keep the same inode');
  assert.equal(after.size, before.size, 'the case must keep the size unchanged');
  assert.equal(after.mtimeNs, before.mtimeNs, 'the case must restore mtimeNs exactly, isolating ctime');
  assert.notEqual(after.ctimeNs, before.ctimeNs, 'ctime must have advanced for the case to be meaningful');

  const rejected = await rejection(manager.commitDelete({ planId: plan.id, confirmed: true }));
  assert.ok(rejected, 'a same-size rewrite must still invalidate a prepared file deletion');
  assert.equal(rejected.code, 'VERSION_CONFLICT');
  assert.equal(rejected.status, 409);
  assert.equal(await readFile(file, 'utf8'), 'bbbb', 'a refused commit must leave the new content in place');
});

test('a read-only subtree fails its selected target while another selected target completes', async t => {
  const { manager, base, root, ref } = await fixture(t);
  // Guard first: with DAC override this process could unlink inside a 0555
  // directory, and the partial-result case would prove nothing.
  const denied = await readOnlyDirectoryProbe(base);
  if (denied === null) {
    t.skip('this process can unlink inside a mode-0555 directory (root or CAP_DAC_OVERRIDE), so a partial result is not decidable here');
    return;
  }
  assert.equal(denied.code, 'EACCES', 'the fixture must deny the unlink for the expected reason');

  const blocked = path.join(root, 'blocked');
  await mkdir(path.join(blocked, 'locked'), { recursive: true });
  await writeFile(path.join(blocked, 'locked', 'inner.txt'), 'inner');
  // Removable entries on both sides of the denied subtree, so a walker that keeps
  // going after a denial really does change the tree whatever order it visits.
  await writeFile(path.join(blocked, 'aaa.txt'), 'aaa');
  await mkdir(path.join(blocked, 'sub'));
  await writeFile(path.join(blocked, 'sub', 'zzz.txt'), 'zzz');
  await writeFile(path.join(root, 'free.txt'), 'free');
  await chmod(path.join(blocked, 'locked'), 0o555);
  try {
    const plan = await manager.prepareDelete({ items: [ref('blocked'), ref('free.txt')] });
    assert.equal(plan.entryCount, 2);

    const result = await manager.commitDelete({ planId: plan.id, confirmed: true });
    assert.equal(result.status, 'partial', `a tree that could not be fully removed must produce a partial result, got ${JSON.stringify(result.results)}`);
    assert.equal(result.results.length, 2, 'results are reported per selected target, never per leaf');
    const byPath = new Map(result.results.map(item => [item.path, item]));
    assert.equal(byPath.get('free.txt').status, 'completed', 'an independent selected file must still be removed');
    assert.equal(await exists(path.join(root, 'free.txt')), false);

    const blockedResult = byPath.get('blocked');
    assert.ok(blockedResult, 'the failed tree must still be reported, under its selected path');
    assert.equal(blockedResult.status, 'failed', 'a partly removed tree must never be reported as completed');
    assert.equal(blockedResult.error.code, 'PERMISSION_DENIED');
    // `removed` describes the selected target itself, which survived here; the
    // partial removal inside it must be admitted rather than hidden behind
    // "nothing changed".
    assert.notEqual(blockedResult.removed, true, 'the failed target itself was not removed');
    assert.equal(blockedResult.contentsChanged, true, 'the walker really did remove entries inside the target before the denial');
    // The survivors are real: the denied subtree is still there, byte for byte.
    assert.equal(await exists(blocked), true);
    assert.equal(await readFile(path.join(blocked, 'locked', 'inner.txt'), 'utf8'), 'inner');
  } finally {
    await chmod(path.join(blocked, 'locked'), 0o755);
  }
});

test('two selected hard links to one inode are both removed and a third link survives', async t => {
  const { manager, base, root, ref } = await fixture(t);
  const original = path.join(root, 'a.txt');
  await writeFile(original, 'data');
  await link(original, path.join(root, 'b.txt'));
  await link(original, path.join(base, 'third.txt'));

  const plan = await manager.prepareDelete({ items: [ref('a.txt'), ref('b.txt')] });
  assert.equal(plan.targets.length, 2);

  const result = await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.equal(result.status, 'completed',
    `both selected paths of one inode must be removed: removing the first link moves the shared nlink/ctime, which is this operation's own doing, not an outside change, got ${JSON.stringify(result.results)}`);
  assert.equal(await exists(original), false);
  assert.equal(await exists(path.join(root, 'b.txt')), false);
  assert.equal(await readFile(path.join(base, 'third.txt'), 'utf8'), 'data', 'a link outside the root must survive');
});

test('an outside rewrite of a shared inode still conflicts even when both links are selected', async t => {
  const { manager, base, root, ref } = await fixture(t);
  const original = path.join(root, 'a.txt');
  await writeFile(original, 'data');
  await link(original, path.join(root, 'b.txt'));
  // The third link lives outside the root: this is an outside writer, not our own
  // link-count bookkeeping, so the metadata binding must still catch it.
  const outside = path.join(base, 'third.txt');
  await link(original, outside);

  const plan = await manager.prepareDelete({ items: [ref('a.txt'), ref('b.txt')] });
  await writeFile(outside, 'data that is longer');

  const rejected = await rejection(manager.commitDelete({ planId: plan.id, confirmed: true }));
  assert.ok(rejected, 'an outside rewrite of a shared inode must still invalidate the prepared deletion');
  assert.equal(rejected.code, 'VERSION_CONFLICT');
  assert.equal(rejected.status, 409);
  assert.equal(await exists(original), true);
  assert.equal(await exists(path.join(root, 'b.txt')), true);
  assert.equal(await readFile(outside, 'utf8'), 'data that is longer');
});

test('the granted root itself cannot be deleted', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'folder'));
  await writeFile(path.join(root, 'folder', 'keep.txt'), 'keep');

  const empty = await rejection(manager.prepareDelete({ items: [ref('')] }));
  assert.ok(empty, 'the granted root itself must never be deletable');
  assert.equal(empty.code, 'ROOT_OPERATION_NOT_ALLOWED');
  assert.equal(empty.status, 403);

  const slash = await rejection(manager.prepareDelete({ items: [ref('/')] }));
  assert.ok(slash, 'the root must not be addressable as a selection either');
  assert.equal(slash.code, 'INVALID_PATH');

  assert.deepEqual(await readdir(root), ['folder']);
  assert.equal(await readFile(path.join(root, 'folder', 'keep.txt'), 'utf8'), 'keep');
});

test('permanent deletion still requires explicit confirmation', async t => {
  const { manager, root, ref } = await fixture(t);
  await writeFile(path.join(root, 'note'), 'note');
  const plan = await manager.prepareDelete({ items: [ref('note')] });

  for (const call of [() => manager.commitDelete({ planId: plan.id }), () => manager.commitDelete({ planId: plan.id, confirmed: false })]) {
    const refused = await rejection(call());
    assert.ok(refused, 'a missing confirmation must never delete anything');
    assert.equal(refused.code, 'CONFIRMATION_REQUIRED');
  }
  assert.equal(await readFile(path.join(root, 'note'), 'utf8'), 'note');
});

test('a confirmation expires on the injected clock and the tree is untouched', async t => {
  let clock = 1_700_000_000_000;
  const { manager, root, ref } = await fixture(t, { now: () => clock, deletePlanTtlMs: 60_000 });
  await writeFile(path.join(root, 'first'), 'first');

  const fresh = await manager.prepareDelete({ items: [ref('first')] });
  assert.equal(fresh.expiresAt, clock + 60_000, 'the confirmation lifetime must come from the configured TTL');
  clock += 1_000;
  assert.equal((await manager.commitDelete({ planId: fresh.id, confirmed: true })).status, 'completed', 'a confirmation inside its lifetime must still work');
  assert.equal(await exists(path.join(root, 'first')), false);

  await writeFile(path.join(root, 'second'), 'second');
  const stale = await manager.prepareDelete({ items: [ref('second')] });
  clock += 60_001;
  const expired = await rejection(manager.commitDelete({ planId: stale.id, confirmed: true }));
  assert.ok(expired, 'an expired confirmation must be refused');
  assert.equal(expired.code, 'PLAN_EXPIRED');
  assert.equal(await readFile(path.join(root, 'second'), 'utf8'), 'second', 'an expired confirmation must delete nothing');
});

test('committing the same confirmation twice is idempotent', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'tree'));
  await writeFile(path.join(root, 'tree', 'file'), 'file');
  const plan = await manager.prepareDelete({ items: [ref('tree')] });

  const first = await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.equal(first.status, 'completed');
  assert.equal(await exists(path.join(root, 'tree')), false);

  const second = await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.deepEqual(second, first, 'a repeated confirmation must replay the recorded result, not fail or delete twice');
  const third = await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.deepEqual(third, first);
});
