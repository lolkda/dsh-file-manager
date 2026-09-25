/**
 * Independent safety review of the descriptor-relative tree deletion (task-3).
 *
 * These cases attack the execution-time walk in `src/host/delete-tree.ts` and the
 * `prepareDelete`/`commitDelete` precheck in `src/host/manager.ts`. They are the
 * *second* line: `delete-tree.test.mjs` pins the contract, this file pins the
 * boundaries a race or a leaked descriptor could slip through.
 *
 * Rules kept by every case here:
 *
 * - Real filesystem, real manager, no mocks of the code under test. Where a race or an
 *   I/O failure has to be produced deterministically, exactly one function of the real
 *   `node:fs/promises` export object (or `FileHandle.prototype`) is wrapped and restored
 *   in a `finally`; `syncBuiltinESMExports()` makes the walker's own namespace import
 *   see it. A wrapper passes every call through to the real implementation except the
 *   single fault-injection branch it exists for, which throws the errno the case needs
 *   (`EACCES`, `EIO`) and never touches the filesystem itself. Nothing is faked by
 *   sleeping.
 * - Permission-dependent cases probe that this process really enforces Unix
 *   permissions first and skip with a visible reason otherwise (a root or
 *   DAC-overriding process cannot decide them).
 * - A case that already passes is reported as preservation, never as a red test.
 */

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createManager } from '../dist/host/manager.js';

async function fixture(t, options = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-fm-safety-'));
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

/** A name as it is on disk, whatever shape `readdir` returned it in. */
const rawName = entry => (Buffer.isBuffer(entry) ? entry.toString('latin1')
  : typeof entry === 'string' ? entry
    : Buffer.isBuffer(entry.name) ? entry.name.toString('latin1') : String(entry.name));

/** Open descriptors of this process, used to prove an aborted walk closed its own. */
const descriptorCount = () => readdir('/proc/self/fd').then(list => list.length);

/**
 * Wrap one function of the real `node:fs/promises` export object so the walker's
 * namespace import sees it too. Returns the restore step; the caller must run it in
 * a `finally`.
 */
function patchPromiseExport(name, replacement) {
  const original = fsp[name];
  fsp[name] = replacement;
  syncBuiltinESMExports();
  return () => { fsp[name] = original; syncBuiltinESMExports(); };
}

/**
 * Count the walker's own listings of the directory holding `marker`, by wrapping the
 * real `readdir`. One physical walk lists a directory once, so a second listing means
 * the plan was executed twice.
 */
function countWalkerListings(marker) {
  let calls = 0;
  const realReaddir = fsp.readdir;
  const restore = patchPromiseExport('readdir', async (target, options) => {
    const entries = await realReaddir(target, options);
    if (Array.isArray(entries) && entries.map(rawName).includes(marker)) calls += 1;
    return entries;
  });
  return { calls: () => calls, restore };
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

/** The metadata token a prepared selection binds: identity plus size, mtime and ctime. */
const tokenOf = stats => `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;

/**
 * Make the kernel's coarse ctime clock advance past `directory`'s current value, so an
 * inode change after this point is guaranteed to be visible as a new `ctimeNs`. This is
 * a precondition, not a timing threshold: it returns as soon as the clock really
 * ticked, and the cases below assert the resulting change instead of assuming it.
 */
async function advanceCtimeClock(directory) {
  const scratch = path.join(directory, '.ctime-barrier');
  await writeFile(scratch, 'barrier');
  const before = (await lstat(scratch, { bigint: true })).ctimeNs;
  try {
    for (let attempt = 0; attempt < 500; attempt++) {
      await utimes(scratch, 1700000000, 1700000000);
      if ((await lstat(scratch, { bigint: true })).ctimeNs !== before) return;
    }
    assert.fail('this filesystem did not advance ctime within 500 updates; the case is not decidable here');
  } finally {
    await rm(scratch, { force: true });
  }
}

test('a selected entry whose parent directory was swapped is refused before anything is deleted', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'p'));
  await mkdir(path.join(root, 'q'));
  await writeFile(path.join(root, 'p', 'f'), 'shared');
  // Same inode, same stamp: only the parent's identity can tell the two trees apart.
  await link(path.join(root, 'p', 'f'), path.join(root, 'q', 'f'));
  await writeFile(path.join(root, 'free'), 'free');
  const before = await lstat(path.join(root, 'p', 'f'), { bigint: true });

  const plan = await manager.prepareDelete({ items: [ref('p/f'), ref('free')] });
  assert.deepEqual(plan.targets.map(target => target.path).sort(), ['free', 'p/f']);

  await rename(path.join(root, 'p'), path.join(root, 'old'));
  await rename(path.join(root, 'q'), path.join(root, 'p'));
  const after = await lstat(path.join(root, 'p', 'f'), { bigint: true });
  assert.equal(after.ino, before.ino, 'the fixture must keep the selected file inode across the swap');
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ctimeNs, before.ctimeNs, 'the fixture must leave the selected file stamp untouched, isolating the parent');

  const refused = await rejection(manager.commitDelete({ planId: plan.id, confirmed: true }));
  assert.ok(refused, 'a selected entry reached through a different parent directory must be refused');
  assert.equal(refused.code, 'PATH_CHANGED');
  assert.equal(refused.status, 409);

  // The precheck runs before any deletion, so the unrelated selection survives too.
  assert.equal(await readFile(path.join(root, 'free'), 'utf8'), 'free', 'a refused precheck must not delete an unaffected selection');
  assert.equal(await readFile(path.join(root, 'p', 'f'), 'utf8'), 'shared');
  assert.equal(await readFile(path.join(root, 'old', 'f'), 'utf8'), 'shared');
});

test('replacing the granted root directory is refused and the original tree survives', async t => {
  const { manager, base, root, ref } = await fixture(t);
  await writeFile(path.join(root, 'note'), 'note');
  const plan = await manager.prepareDelete({ items: [ref('note')] });

  await rename(root, path.join(base, 'root-old'));
  await mkdir(root);

  const refused = await rejection(manager.commitDelete({ planId: plan.id, confirmed: true }));
  assert.ok(refused, 'the granted root identity must be re-checked before deleting');
  assert.equal(refused.code, 'ROOT_CHANGED');
  assert.equal(refused.status, 409);
  assert.equal(await readFile(path.join(base, 'root-old', 'note'), 'utf8'), 'note', 'the original tree must survive');
  assert.deepEqual(await readdir(root), [], 'the replacement directory must stay untouched');
});

test('revoking the root grant while a confirmation is pending is refused', async t => {
  const { manager, root, grant, ref } = await fixture(t);
  await writeFile(path.join(root, 'note'), 'note');
  const plan = await manager.prepareDelete({ items: [ref('note')] });

  await manager.removeRoot({ rootId: grant.id });

  const refused = await rejection(manager.commitDelete({ planId: plan.id, confirmed: true }));
  assert.ok(refused, 'a revoked grant must not authorize the pending confirmation');
  assert.equal(refused.code, 'ROOT_NOT_FOUND');
  assert.equal(refused.status, 404);
  assert.equal(await readFile(path.join(root, 'note'), 'utf8'), 'note', 'a refused confirmation must delete nothing');
});

test('a child directory swapped for an outside link after the listing is refused and the outside directory is untouched', async t => {
  const { manager, base, root, ref } = await fixture(t);
  const outside = path.join(base, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'precious.txt'), 'precious');
  await mkdir(path.join(root, 'tree', 'swapme'), { recursive: true });
  await writeFile(path.join(root, 'tree', 'swapme', 'inner.txt'), 'inner');
  await writeFile(path.join(root, 'tree', 'plain.txt'), 'plain');
  const plan = await manager.prepareDelete({ items: [ref('tree')] });

  // The swap happens inside the walker's own listing call: the real readdir returns,
  // then the child it named is moved away and replaced by a link to an outside tree.
  let swaps = 0;
  const realReaddir = fsp.readdir;
  const restore = patchPromiseExport('readdir', async (target, options) => {
    const entries = await realReaddir(target, options);
    if (swaps === 0 && Array.isArray(entries) && entries.map(rawName).includes('swapme')) {
      swaps += 1;
      await rename(path.join(root, 'tree', 'swapme'), path.join(root, 'tree', 'hold'));
      await symlink(outside, path.join(root, 'tree', 'swapme'));
    }
    return entries;
  });

  let result;
  try {
    result = await manager.commitDelete({ planId: plan.id, confirmed: true });
  } finally {
    restore();
  }

  assert.equal(swaps, 1, 'the case must really swap the child after the listing');
  assert.equal(result.status, 'partial');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].status, 'failed', 'a child replaced by a link must fail the tree, not be followed');
  assert.equal(result.results[0].error.code, 'PATH_CHANGED');
  assert.equal(await readFile(path.join(outside, 'precious.txt'), 'utf8'), 'precious', 'a link must never lead the walk outside the selected tree');
  assert.deepEqual(await readdir(outside), ['precious.txt'], 'the outside directory must be untouched');
  assert.equal(await readFile(path.join(root, 'tree', 'hold', 'inner.txt'), 'utf8'), 'inner', 'the moved-away subtree must survive');
});

test('a selected directory replaced by a link to an outside directory is refused', async t => {
  const { manager, base, root, ref } = await fixture(t);
  const outside = path.join(base, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'precious.txt'), 'precious');
  await mkdir(path.join(root, 'tree'));
  await writeFile(path.join(root, 'tree', 'inner.txt'), 'inner');
  const plan = await manager.prepareDelete({ items: [ref('tree')] });

  await rename(path.join(root, 'tree'), path.join(root, 'hold'));
  await symlink(outside, path.join(root, 'tree'));

  const refused = await rejection(manager.commitDelete({ planId: plan.id, confirmed: true }));
  assert.ok(refused, 'a directory selection replaced by a link must be refused');
  assert.equal(refused.code, 'VERSION_CONFLICT');
  assert.equal(refused.status, 409);
  assert.deepEqual(await readdir(outside), ['precious.txt'], 'the link target must never be deleted');
  assert.equal(await readFile(path.join(root, 'hold', 'inner.txt'), 'utf8'), 'inner');
});

test('a confirmation waits for a pending leaf removal before it settles and closes its descriptors', { timeout: 30_000 }, async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'tree'));
  await writeFile(path.join(root, 'tree', 'slow.txt'), 'slow');
  await writeFile(path.join(root, 'tree', 'boom.txt'), 'boom');
  const plan = await manager.prepareDelete({ items: [ref('tree')] });
  const descriptorsBefore = await descriptorCount();

  let enterGate;
  let openGate;
  let noteFailure;
  const gated = new Promise(resolve => { enterGate = resolve; });
  const gate = new Promise(resolve => { openGate = resolve; });
  const failed = new Promise(resolve => { noteFailure = resolve; });
  const attempted = [];
  const realUnlink = fsp.unlink;
  const restore = patchPromiseExport('unlink', async target => {
    const name = rawName(target);
    attempted.push(path.posix.basename(name));
    if (name.endsWith('/slow.txt')) { enterGate(); await gate; return realUnlink(target); }
    if (name.endsWith('/boom.txt')) {
      noteFailure();
      const error = new Error('the filesystem denied this operation');
      error.code = 'EACCES';
      throw error;
    }
    return realUnlink(target);
  });

  let settled = false;
  let result;
  let failure;
  let commit;
  try {
    commit = manager.commitDelete({ planId: plan.id, confirmed: true })
      .then(value => { settled = true; result = value; return value; }, error => { settled = true; failure = error; return null; });
    await gated;
    await failed;
    // Several event-loop turns while one unlink is still in flight: a walker that
    // closed its directory descriptor or settled early would be caught here.
    for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'the confirmation must not settle while a leaf removal is still pending');
    assert.equal(await exists(path.join(root, 'tree', 'slow.txt')), true, 'the gated removal must really still be pending');
  } finally {
    // Always release the pending removal, so a failed assertion above cannot leave a
    // walk (and this test) hanging.
    openGate();
    await commit?.catch(() => {});
    restore();
  }

  const descriptorsAfter = await descriptorCount();
  assert.ok(result, `the confirmation must complete once the pending removal finishes: ${failure?.message}`);
  assert.deepEqual(attempted.sort(), ['boom.txt', 'slow.txt'], 'both leaves must be attempted exactly once');
  assert.equal(settled, true);
  assert.equal(result.status, 'partial');
  assert.equal(result.results[0].status, 'failed');
  assert.equal(result.results[0].removed, false, 'the tree itself is still there');
  assert.equal(result.results[0].contentsChanged, true, 'the gated removal really happened inside the tree');
  assert.equal(result.results[0].error.code, 'PERMISSION_DENIED');
  assert.equal(await exists(path.join(root, 'tree', 'slow.txt')), false, 'the pending removal must complete against the held descriptor');
  assert.equal(await exists(path.join(root, 'tree', 'boom.txt')), true);
  assert.ok(descriptorsAfter <= descriptorsBefore,
    `an aborted walk must not leave directory descriptors open: ${descriptorsBefore} before, ${descriptorsAfter} after`);
});

test('a repeated confirmation replays the recorded receipt without re-running the walk', async t => {
  const { manager, base, root, ref } = await fixture(t);
  const denied = await readOnlyDirectoryProbe(base);
  if (denied === null) {
    t.skip('this process can unlink inside a mode-0555 directory (root or CAP_DAC_OVERRIDE), so a partial result is not decidable here');
    return;
  }
  assert.equal(denied.code, 'EACCES', 'the fixture must deny the unlink for the expected reason');

  const blocked = path.join(root, 'blocked');
  await mkdir(path.join(blocked, 'locked'), { recursive: true });
  await writeFile(path.join(blocked, 'locked', 'inner.txt'), 'inner');
  await writeFile(path.join(blocked, 'aaa.txt'), 'aaa');
  await chmod(path.join(blocked, 'locked'), 0o555);

  const plan = await manager.prepareDelete({ items: [ref('blocked')] });
  const listings = countWalkerListings('locked');
  let first;
  let replay;
  try {
    first = await manager.commitDelete({ planId: plan.id, confirmed: true });
    assert.equal(first.status, 'partial');
    assert.equal(first.results.length, 1);
    assert.equal(first.results[0].status, 'failed');
    assert.equal(first.results[0].removed, false);
    assert.equal(first.results[0].contentsChanged, true);
    assert.equal(await exists(path.join(blocked, 'aaa.txt')), false, 'the writable part of the tree must really have been removed');

    // The denial is gone and the removed names are back: a replayed receipt must not
    // touch any of it.
    await chmod(path.join(blocked, 'locked'), 0o755);
    await writeFile(path.join(blocked, 'locked', 'inner.txt'), 'recreated');
    await writeFile(path.join(blocked, 'recreated.txt'), 'recreated too');
    replay = await manager.commitDelete({ planId: plan.id, confirmed: true });
  } finally {
    listings.restore();
    await chmod(path.join(blocked, 'locked'), 0o755);
  }

  assert.deepEqual(replay, first, 'a repeated confirmation must replay the recorded receipt unchanged');
  assert.equal(listings.calls(), 1, 'a replayed receipt must not re-list the tree');
  assert.equal(await readFile(path.join(blocked, 'locked', 'inner.txt'), 'utf8'), 'recreated', 'a replayed receipt must not delete again');
  assert.equal(await readFile(path.join(blocked, 'recreated.txt'), 'utf8'), 'recreated too');
});

test('two concurrent confirmations of one plan share a single walk', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'tree'));
  await writeFile(path.join(root, 'tree', 'marker.txt'), 'marker');
  await writeFile(path.join(root, 'tree', 'other.txt'), 'other');
  const plan = await manager.prepareDelete({ items: [ref('tree')] });

  const listings = countWalkerListings('marker.txt');
  let first;
  let second;
  let third;
  try {
    [first, second] = await Promise.all([
      manager.commitDelete({ planId: plan.id, confirmed: true }),
      manager.commitDelete({ planId: plan.id, confirmed: true }),
    ]);
    third = await manager.commitDelete({ planId: plan.id, confirmed: true });
  } finally {
    listings.restore();
  }

  assert.deepEqual(second, first, 'a duplicate confirmation must resolve to the same receipt');
  assert.deepEqual(third, first, 'a later replay must resolve to the same receipt');
  assert.equal(first.status, 'completed');
  assert.equal(listings.calls(), 1, 'duplicate confirmations must share one physical walk');
  assert.equal(await exists(path.join(root, 'tree')), false);
});

test('a selected directory holding raw Linux names is deleted as a tree', async t => {
  const { manager, root, ref } = await fixture(t);
  const folder = path.join(root, 'folder');
  await mkdir(folder);
  const prefix = Buffer.from(`${folder}/`);
  const invalidUtf8 = Buffer.concat([prefix, Buffer.from([0x61, 0xff, 0x62])]);
  const control = Buffer.concat([prefix, Buffer.from([0x63, 0x01, 0x64])]);
  await writeFile(invalidUtf8, 'invalid');
  await writeFile(control, 'control');
  await writeFile(path.join(folder, 'bad\\name'), 'backslash');
  await writeFile(path.join(root, 'keep.txt'), 'keep');

  const listed = (await readdir(folder, { encoding: 'buffer' })).map(name => name.toString('hex')).sort();
  assert.deepEqual(listed, ['61ff62', '6261645c6e616d65', '630164'], 'the fixture must really hold an invalid UTF-8 name, a control name and a backslash name');

  const plan = await manager.prepareDelete({ items: [ref('folder')] });
  assert.equal(plan.entryCount, 1);

  const result = await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.equal(result.status, 'completed', `raw names must not block the tree: ${JSON.stringify(result.results)}`);
  assert.equal(await exists(folder), false);
  assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'keep');
});

test('hard links selected inside and outside a deleted tree are removed while an outside link keeps its bytes', async t => {
  const { manager, base, root, ref } = await fixture(t);
  await writeFile(path.join(root, 'a.txt'), 'shared-bytes');
  await link(path.join(root, 'a.txt'), path.join(root, 'b.txt'));
  await mkdir(path.join(root, 'dir'));
  await link(path.join(root, 'a.txt'), path.join(root, 'dir', 'c.txt'));
  // Never selected and outside the root: it must keep the inode's bytes.
  await link(path.join(root, 'a.txt'), path.join(base, 'third.txt'));
  const before = await lstat(path.join(root, 'a.txt'), { bigint: true });

  const plan = await manager.prepareDelete({ items: [ref('a.txt'), ref('b.txt'), ref('dir')] });
  assert.equal(plan.entryCount, 3);

  // Guarantee that the removals really move the shared inode's ctime, so the walk has
  // to re-derive the remaining expectations instead of getting lucky in one tick.
  await advanceCtimeClock(root);

  const result = await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.equal(result.status, 'completed', `every selected name of the shared inode must be removed: ${JSON.stringify(result.results)}`);
  assert.equal(await exists(path.join(root, 'a.txt')), false);
  assert.equal(await exists(path.join(root, 'b.txt')), false);
  assert.equal(await exists(path.join(root, 'dir')), false);

  const third = await lstat(path.join(base, 'third.txt'), { bigint: true });
  assert.equal(third.ino, before.ino, 'the outside name must still be the same inode');
  assert.equal(third.nlink, 1n, 'only the outside name may be left');
  assert.notEqual(third.ctimeNs, before.ctimeNs, 'the case must have moved the shared ctime, otherwise it proves nothing');
  assert.equal(await readFile(path.join(base, 'third.txt'), 'utf8'), 'shared-bytes');
});

test('two selections of one inode captured around an outside rewrite are refused, not merged', async t => {
  const { manager, base, root, ref } = await fixture(t);
  await writeFile(path.join(root, 'a.txt'), 'aaaa');
  await link(path.join(root, 'a.txt'), path.join(root, 'b.txt'));
  // Never selected: a write through this name is an outside change to the shared inode.
  const outside = path.join(base, 'third.txt');
  await link(path.join(root, 'a.txt'), outside);

  // Inside the real listing of the first selection: `a` gets the old stamp, then the
  // inode is rewritten from outside, then `b` gets the new stamp. Both selections are
  // the same inode, so a map keyed by identity alone can only keep one of the two.
  const realLstat = fsp.lstat;
  let rewrites = 0;
  const restore = patchPromiseExport('lstat', async (target, options) => {
    const stats = await realLstat(target, options);
    const name = Buffer.isBuffer(target) ? target.toString('latin1') : String(target);
    if (rewrites === 0 && name.endsWith('/a.txt')) {
      rewrites += 1;
      await writeFile(outside, 'aaaa rewritten');
    }
    return stats;
  });

  let plan;
  try {
    plan = await manager.prepareDelete({ items: [ref('a.txt'), ref('b.txt')] });
  } finally {
    restore();
  }

  assert.equal(rewrites, 1, 'the case must rewrite the shared inode between the two captures');
  const byPath = new Map(plan.entries.map(entry => [entry.path, entry]));
  const first = byPath.get('a.txt');
  const second = byPath.get('b.txt');
  assert.equal(plan.entryCount, 2);
  // The public plan view carries no `identity` field, so the shared inode is asserted
  // through the dev:ino prefix of the two tokens and checked against the real disk.
  const identityOf = version => version.split(':').slice(0, 2).join(':');
  const current = await lstat(path.join(root, 'a.txt'), { bigint: true });
  const onDisk = tokenOf(current);
  assert.equal(identityOf(first.version), `${current.dev}:${current.ino}`, 'the earlier selection must name the inode on disk');
  assert.equal(identityOf(second.version), `${current.dev}:${current.ino}`, 'the later selection must name the same inode');
  assert.notEqual(first.version, second.version, 'the two captures must really carry different stamps');
  assert.equal(onDisk, second.version, 'the later selection must carry the current stamp');
  assert.notEqual(onDisk, first.version, 'the earlier selection must carry the stale stamp');

  const refused = await rejection(manager.commitDelete({ planId: plan.id, confirmed: true }));
  assert.ok(refused, 'a stale confirmation of one link must not be masked by a fresher confirmation of the same inode');
  assert.equal(refused.code, 'VERSION_CONFLICT');
  assert.equal(refused.status, 409);
  assert.equal(await exists(path.join(root, 'a.txt')), true, 'the stale selection must survive the refusal');
  assert.equal(await exists(path.join(root, 'b.txt')), true, 'the fresher selection must survive the refusal too');
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'aaaa rewritten');
  assert.equal(await readFile(path.join(root, 'b.txt'), 'utf8'), 'aaaa rewritten');
  assert.equal(await readFile(outside, 'utf8'), 'aaaa rewritten');
});

test('a parent sync failure after a successful unlink still reports the removal', async t => {
  const { manager, root, ref } = await fixture(t);
  const note = path.join(root, 'note');
  await writeFile(note, 'note');
  const plan = await manager.prepareDelete({ items: [ref('note')] });

  const probe = await open(note, 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const realSync = prototype.sync;
  prototype.sync = async function (...args) {
    const error = new Error('the filesystem operation failed');
    error.code = 'EIO';
    throw error;
  };

  let result;
  try {
    result = await manager.commitDelete({ planId: plan.id, confirmed: true });
  } finally {
    prototype.sync = realSync;
  }

  assert.equal(result.status, 'partial');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].status, 'failed', 'a failed durability sync must fail the target');
  assert.equal(result.results[0].removed, true, 'the removal already happened and must stay reported');
  assert.equal(result.results[0].contentsChanged, true);
  assert.equal(result.results[0].error.code, 'IO_ERROR');
  assert.equal(result.results[0].error.details.cause, 'EIO');
  assert.equal(await exists(note), false, 'the unlink must not be undone by the sync failure');
});
