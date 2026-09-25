/**
 * task-3 phase 1 (red tests): permanent deletion is a metadata-and-membership
 * operation.
 *
 * Approved contract change: `delete.prepare` / `delete.commit` never read file
 * content, never compute a SHA-256 and never charge `maxVerificationBytes`. A
 * prepared entry binds a metadata token (`dev:ino:size:mtimeNs:ctimeNs`) plus a
 * directory membership snapshot instead. It is deliberately a *weaker* proof than
 * a content version, but not a toothless one: an ordinary same-size rewrite is
 * still caught, because the token carries `size`, `mtimeNs` and `ctimeNs` (the
 * rewrite and inode-replacement cases below pin exactly that), and directory
 * membership is compared as well. What the Host does **not** claim is a CAS
 * guarantee: another process that races the deletion at an arbitrary moment —
 * including between the last check and the final unlink/rmdir — is outside the
 * promise. The token is therefore never accepted where an overwrite or a
 * transfer-source deletion is authorized; those paths (save / overwrite /
 * copy-download / cross-volume move) keep full content verification unchanged and
 * are asserted in their own suites.
 *
 * What the observations in this file can and cannot prove:
 *
 * - `measureReads` / `measureReadsMedian` read `/proc/self/io` `rchar` for this
 *   process. A delta below the threshold proves the operation did **not** read
 *   the file's contents: no content hash and no whole-file comparison could fit
 *   under it. It does not mean "zero bytes were read", because metadata syscalls,
 *   the `/proc/self/io` reads themselves and the test's own small bookkeeping all
 *   land in the same process-wide counter. It also cannot see work done by
 *   another process.
 * - The "must not read" cases measure one operation at a time: preparation and
 *   commit each get their own measurement region, and a single measurement
 *   region never contains the test's own `readFile`/hash/import noise. The
 *   signal is a real 16 MiB file, so the threshold (1 MiB) sits far below any
 *   true content read and far above the metadata noise of one prepared tree.
 * - The permission cases (mode-000 file, read-only parent directory) first probe
 *   that this process actually enforces Unix permissions. A root or
 *   DAC-overriding process cannot distinguish them, so those cases skip with a
 *   visible reason instead of passing for the wrong reason.
 * - `rchar` is process-global, so these cases must not run concurrently with
 *   other reading work. `node --test` runs the tests inside one file
 *   sequentially, which is what this file relies on.
 */

import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MetadataVersionSchema, ContentVersionSchema, EntryVersionSchema } from '../dist/contracts/views.js';
import { createManager } from '../dist/host/manager.js';
import { createHeavyIoScheduler } from '../dist/host/scheduler.js';
import { measureReads, measureReadsMedian, hostFixture } from './verify-harness.mjs';

/** Large enough that "did it read the file?" is decidable, small enough to stay cheap as a sparse file. */
const SIZE = 16 * 1024 * 1024;

/** Anything under this is metadata work; any real content read of a 16 MiB file is far above it. */
const METADATA_NOISE_LIMIT = 1024 * 1024;

async function fixture(t, options = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-fm-delete-'));
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

/** A sparse file of `bytes`: cheap to create, but a real read still moves `bytes` through rchar. */
async function sparseFile(filename, bytes) {
  const handle = await open(filename, 'w');
  try { await handle.truncate(bytes); } finally { await handle.close(); }
}

const tokenOf = stats => `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;

function assertMetadataToken(version, stats) {
  assert.equal(EntryVersionSchema.safeParse(version).success, true, `a deletion entry version must be a version token, got ${version}`);
  assert.equal(MetadataVersionSchema.safeParse(version).success, true, `a deletion entry version must be a metadata token, got ${version}`);
  assert.equal(ContentVersionSchema.safeParse(version).success, false, `a deletion entry version must carry no content digest, got ${version}`);
  assert.equal(version, tokenOf(stats), 'the deletion token must be derived from metadata alone');
}

/**
 * Restore `mtime` byte-for-byte while letting `ctime` advance, so a case can
 * isolate the ctime part of the token. `utimes` rounds a fixed input
 * deterministically, and the kernel bumps ctime on every update; the loop only
 * covers the case where two updates land inside the same timestamp tick.
 */
async function restoreMtimeAndAdvanceCtime(filename, seconds, original) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await utimes(filename, seconds, seconds);
    const current = await lstat(filename, { bigint: true });
    if (current.mtimeNs === original.mtimeNs && current.ctimeNs !== original.ctimeNs) return current;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`this filesystem cannot restore mtimeNs ${original.mtimeNs} while advancing ctimeNs; the case is not decidable here`);
}

/** A unix socket is an addressable name whose entry kind is neither file, directory nor symlink. */
async function withSocket(where, body) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(where, resolve);
  });
  try { return await body(); } finally { await new Promise(resolve => server.close(resolve)); }
}

/**
 * `EACCES` when this process really cannot read a mode-000 file; `null` when it
 * can read anything (root or CAP_DAC_READ_SEARCH), in which case a permission
 * case cannot be decided here.
 */
async function unreadableProbe(base) {
  const file = path.join(base, 'probe-unreadable');
  await writeFile(file, 'probe');
  await chmod(file, 0o000);
  const failure = await readFile(file).then(() => null, error => error);
  await chmod(file, 0o600);
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

/**
 * Create `names` under `directory` with at most `concurrency` writes in flight,
 * so a bulk fixture never opens thousands of descriptors at once.
 */
async function writeMany(directory, names, concurrency = 16) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, names.length) }, async () => {
    while (next < names.length) {
      const name = names[next++];
      await writeFile(path.join(directory, name), '');
    }
  });
  await Promise.all(workers);
}

test('the rchar observation separates metadata noise from a large read', async t => {
  // Self-test of the measurement itself: without it, every "did not read" case
  // below could pass because the counter is dead rather than because the engine
  // is right. It also calibrates the threshold: a full read (16 MiB) and a
  // partial read (2 MiB) must both land above `METADATA_NOISE_LIMIT`, while
  // metadata-only work stays below it.
  const { root } = await fixture(t);
  const file = path.join(root, 'self-test.bin');
  await sparseFile(file, SIZE);

  const full = await measureReads(() => readFile(file));
  assert.equal(full.value.length, SIZE);
  assert.ok(full.bytes >= SIZE, `reading ${SIZE} bytes must move rchar by at least ${SIZE} (measured ${full.bytes})`);

  const handle = await open(file, 'r');
  try {
    const PARTIAL = 2 * 1024 * 1024;
    const partial = await measureReads(async () => {
      const buffer = Buffer.alloc(PARTIAL);
      const { bytesRead } = await handle.read(buffer, 0, PARTIAL, 0);
      return bytesRead;
    });
    assert.equal(partial.value, PARTIAL);
    assert.ok(partial.bytes >= PARTIAL,
      `a ${PARTIAL} byte partial read must move rchar by at least ${PARTIAL} (measured ${partial.bytes})`);
    assert.ok(partial.bytes > METADATA_NOISE_LIMIT, 'the threshold must sit below a meaningful partial read');
  } finally {
    await handle.close();
  }

  const metadata = await measureReads(async () => { await lstat(file, { bigint: true }); });
  assert.ok(metadata.bytes < METADATA_NOISE_LIMIT, `metadata-only work must stay under the threshold (measured ${metadata.bytes})`);
});

test('deletion preparation never reads the selected file content', async t => {
  const { manager, root, ref } = await fixture(t);
  const file = path.join(root, 'big.bin');
  await sparseFile(file, SIZE);

  const baseline = () => manager.list(ref(''));
  const measured = await measureReadsMedian({
    baseline,
    operation: () => manager.prepareDelete({ items: [ref('big.bin')] }),
    repeats: 3,
  });
  assert.ok(measured.median < METADATA_NOISE_LIMIT,
    `preparing a ${SIZE} byte file must not read the file's contents (a full read would move rchar by at least ${SIZE}): median rchar delta ${measured.median} (samples ${measured.samples.join(', ')}) must stay under ${METADATA_NOISE_LIMIT}`);

  const plan = await manager.prepareDelete({ items: [ref('big.bin')] });
  assert.equal(plan.permanent, true);
  assert.equal(plan.entryCount, 1);
  assert.equal(plan.entries[0].size, SIZE);
  assert.equal(await exists(file), true, 'preparation is read-only and must not remove the file');
});

test('deletion commit never reads the file content, measured without preparation', async t => {
  const { manager, root, ref } = await fixture(t);
  const file = path.join(root, 'big.bin');
  await sparseFile(file, SIZE);
  // Preparation stays outside the measurement region: the commit must be proven
  // on its own, not inferred from a combined delta.
  const plan = await manager.prepareDelete({ items: [ref('big.bin')] });

  const measured = await measureReads(() => manager.commitDelete({ planId: plan.id, confirmed: true }));
  assert.ok(measured.bytes < METADATA_NOISE_LIMIT,
    `committing a prepared ${SIZE} byte deletion must not read the file's contents (a full read would move rchar by at least ${SIZE}): rchar delta ${measured.bytes} must stay under ${METADATA_NOISE_LIMIT}`);
  assert.equal(measured.value.status, 'completed');
  assert.equal(await exists(file), false);
});

test('a file larger than the content-verification budget can still be prepared and deleted', async t => {
  const { manager, root, ref } = await fixture(t, { maxVerificationBytes: 1 });
  const file = path.join(root, 'big.bin');
  await sparseFile(file, SIZE);

  const plan = await manager.prepareDelete({ items: [ref('big.bin')] });
  assert.equal(plan.entryCount, 1);
  assert.equal(plan.entries[0].size, SIZE);
  assertMetadataToken(plan.entries[0].version, await lstat(file, { bigint: true }));

  const result = await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.equal(result.status, 'completed');
  assert.equal(await exists(file), false);
});

test('the prepared manifest binds every entry to a metadata token, never a content digest', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'folder'));
  await writeFile(path.join(root, 'folder', 'a'), 'aa');
  await writeFile(path.join(root, 'folder', 'b'), 'bb');

  const plan = await manager.prepareDelete({ items: [ref('folder')] });
  assert.equal(plan.entryCount, 3);
  for (const entry of plan.entries) {
    const stats = await lstat(path.join(root, ...entry.path.split('/')), { bigint: true });
    assertMetadataToken(entry.version, stats);
    assert.equal(entry.size, Number(stats.size), `the manifest size of ${entry.path} must be its metadata size`);
    assert.equal(entry.kind, stats.isDirectory() ? 'directory' : 'file');
  }
});

test('a deeply nested selected directory is deleted exactly and an unselected sibling survives', async t => {
  const { manager, root, ref } = await fixture(t);
  const levels = Array.from({ length: 8 }, (_, index) => `d${index + 1}`);
  const deepest = path.join(root, 'deep', ...levels);
  await mkdir(deepest, { recursive: true });
  await writeFile(path.join(deepest, 'leaf.txt'), 'leaf');
  await mkdir(path.join(root, 'sibling'));
  await writeFile(path.join(root, 'sibling', 'keep.txt'), 'keep');

  const plan = await manager.prepareDelete({ items: [ref('deep')] });
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.entryCount, 1 + levels.length + 1, 'the manifest must list every nested directory plus the leaf file');

  const result = await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.equal(result.status, 'completed');
  assert.equal(await exists(path.join(root, 'deep')), false);
  assert.deepEqual(await readdir(root), ['sibling'], 'an unselected sibling must survive');
  assert.equal(await readFile(path.join(root, 'sibling', 'keep.txt'), 'utf8'), 'keep');
});

test('selecting one .js file 20 levels deep deletes only that file', async t => {
  const { manager, root, ref } = await fixture(t);
  const levels = Array.from({ length: 20 }, (_, index) => `l${index + 1}`);
  const deepest = path.join(root, ...levels);
  await mkdir(deepest, { recursive: true });
  await writeFile(path.join(deepest, 'module.js'), 'export default 1;\n');
  await writeFile(path.join(deepest, 'sibling.txt'), 'keep');
  await writeFile(path.join(root, levels[0], 'top.js'), 'keep too');

  const plan = await manager.prepareDelete({ items: [ref([...levels, 'module.js'].join('/'))] });
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.entryCount, 1, 'selecting a file must plan exactly that file, never its ancestors');
  assert.deepEqual(plan.entries.map(entry => entry.path), [[...levels, 'module.js'].join('/')]);

  const result = await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.equal(result.status, 'completed');
  assert.equal(await exists(path.join(deepest, 'module.js')), false);
  assert.equal(await readFile(path.join(deepest, 'sibling.txt'), 'utf8'), 'keep', 'a sibling in the same directory must survive');
  assert.equal(await exists(path.join(root, ...levels)), true, 'the parent chain must survive a leaf selection');
  assert.equal(await readFile(path.join(root, levels[0], 'top.js'), 'utf8'), 'keep too');
});

test('the prepared manifest is postorder: a directory follows all of its children', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'folder', 'nested'), { recursive: true });
  await writeFile(path.join(root, 'folder', 'a'), 'a');
  await writeFile(path.join(root, 'folder', 'nested', 'b'), 'b');

  const plan = await manager.prepareDelete({ items: [ref('folder')] });
  const position = new Map(plan.entries.map((entry, index) => [entry.path, index]));
  for (const entry of plan.entries) {
    const parent = entry.path.split('/').slice(0, -1).join('/');
    if (position.has(parent)) {
      assert.ok(position.get(parent) > position.get(entry.path),
        `postorder: ${parent} must be listed after its child ${entry.path}`);
    }
  }
  assert.equal(position.get('folder'), plan.entries.length - 1, 'the selected directory must be removed after its whole subtree');
});

test('an unreadable file is deleted when its parent directory is writable', async t => {
  const { manager, base, root, ref } = await fixture(t);
  // Guard first: if this process can read a mode-000 file, the case proves
  // nothing about deletion and must skip visibly rather than pass by accident.
  const denied = await unreadableProbe(base);
  if (denied === null) {
    t.skip('this process can read a mode-000 file (root or CAP_DAC_READ_SEARCH), so a permission denial is not decidable here');
    return;
  }
  assert.equal(denied.code, 'EACCES', 'the fixture must be unreadable for the expected reason');

  const file = path.join(root, 'locked');
  await writeFile(file, 'secret');
  await chmod(file, 0o000);

  const plan = await manager.prepareDelete({ items: [ref('locked')] });
  assert.equal(plan.entryCount, 1);
  const result = await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.equal(result.status, 'completed', `a mode-000 file must be removable through its parent, got ${JSON.stringify(result.results)}`);
  assert.equal(await exists(file), false);
});

test('deletion preparation does not take or join a heavy-I/O permit', async t => {
  const scheduler = createHeavyIoScheduler({ concurrency: 1, queueLimit: 1 });
  const { manager, root, ref } = await fixture(t, { scheduler });
  await writeFile(path.join(root, 'file'), 'data');

  const held = await scheduler.acquire();
  // Occupies the only queue slot without needing a permit of its own, so any
  // attempt to acquire one during preparation fails immediately instead of
  // hanging this case.
  const queued = scheduler.run(async () => {});
  try {
    assert.equal(scheduler.status().queued, 1, 'the permit queue must be saturated before preparation starts');
    const plan = await manager.prepareDelete({ items: [ref('file')] });
    assert.equal(plan.entryCount, 1);
    assert.equal(scheduler.status().active, 1, 'preparation must not take a permit');
    assert.equal(scheduler.status().queued, 1, 'preparation must not join the permit queue');
  } finally {
    held.release();
    await queued;
    await scheduler.drain();
  }
});

test('cancelling preparation before it starts publishes no manifest and removes nothing', async t => {
  const { manager, root, ref } = await fixture(t);
  await writeFile(path.join(root, 'file'), 'content');

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(manager.prepareDelete({ items: [ref('file')], signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(await exists(path.join(root, 'file')), true);
});

test('cancelling a large preparation mid-flight stops it before it can publish', async t => {
  const { manager, root, ref } = await fixture(t);
  const folders = Array.from({ length: 8 }, (_, index) => `part${index}`);
  for (const folder of folders) {
    await mkdir(path.join(root, 'tree', folder), { recursive: true });
    for (let index = 0; index < 100; index++) await writeFile(path.join(root, 'tree', folder, `f${index}`), String(index));
  }

  const controller = new AbortController();
  const pending = manager.prepareDelete({ items: [ref('tree')], signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(await exists(path.join(root, 'tree')), true);
  assert.equal((await readdir(path.join(root, 'tree'))).length, folders.length);
});

test('an entry type the deletion engine cannot remove fails preparation without touching the tree', async t => {
  const { manager, root, ref } = await fixture(t);
  await writeFile(path.join(root, 'keep'), 'keep');

  await withSocket(path.join(root, 'sock'), async () => {
    await assert.rejects(manager.prepareDelete({ items: [ref('sock')] }), { code: 'UNSUPPORTED_ENTRY' });
    assert.equal(await exists(path.join(root, 'sock')), true);
  });
  assert.equal(await readFile(path.join(root, 'keep'), 'utf8'), 'keep');
});

test('a name the path grammar cannot express fails preparation without touching the tree', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'folder'));
  await writeFile(path.join(root, 'folder', 'plain'), 'plain');
  // A backslash is a legal Linux file name but not part of the addressable grammar.
  await writeFile(path.join(root, 'folder', 'bad\\name'), 'bad');

  await assert.rejects(manager.prepareDelete({ items: [ref('folder')] }), { code: 'UNREPRESENTABLE_REFERENCE' });
  assert.deepEqual((await readdir(path.join(root, 'folder'))).sort(), ['bad\\name', 'plain']);
  assert.equal(await readFile(path.join(root, 'folder', 'plain'), 'utf8'), 'plain');
});

test('a failed preparation does not consume a pending-confirmation slot', async t => {
  const { manager, root, ref } = await fixture(t);
  await withSocket(path.join(root, 'sock'), async () => {
    await assert.rejects(manager.prepareDelete({ items: [ref('sock')] }), { code: 'UNSUPPORTED_ENTRY' });
    // DELETE_PLAN_MAX_PENDING is 64: if the failed preparation had published a
    // plan, one of these 64 valid preparations would be refused.
    const plans = [];
    for (let index = 0; index < 64; index++) {
      await writeFile(path.join(root, `file-${index}`), String(index));
      plans.push(await manager.prepareDelete({ items: [ref(`file-${index}`)] }));
    }
    assert.equal(plans.length, 64);
  });
});

test('the selection bound stays at 10000 and refuses an oversized selection up front', async t => {
  const { manager, grant, root } = await fixture(t);
  // Nonexistent paths on purpose: the bound must be enforced before any of the
  // 10001 entries is resolved, and the fixture root must stay empty.
  const items = Array.from({ length: 10001 }, (_, index) => ({ rootId: grant.id, path: `missing-${index}` }));
  await assert.rejects(manager.prepareDelete({ items }), { code: 'INVALID_REQUEST' });
  await assert.rejects(manager.prepareDelete({ items: [] }), { code: 'INVALID_REQUEST' });
  assert.deepEqual(await readdir(root), [], 'an oversized selection must never be resolved');
});

test('a tree that grows past 10000 entries is refused by the entry bound without a full pre-scan', async t => {
  const started = Date.now();
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'tree'));
  // 10000 empty regular files, named to sort before the poison, created with
  // bounded concurrency so the fixture never holds thousands of descriptors.
  const names = Array.from({ length: 10000 }, (_, index) => `a${String(index).padStart(5, '0')}`);
  await writeMany(path.join(root, 'tree'), names);
  assert.equal((await readdir(path.join(root, 'tree'))).length, 10000);

  // This tree already holds 10001 manifest entries: the 10000 files plus the
  // selected directory itself. In a postorder manifest the directory is pushed
  // last, so a bound that only counts already-pushed entries would let it
  // through with entryCount 10001. The bound must count an entry as it enters
  // the walk, directories included.
  const overflow = Date.now();
  const withoutPoison = await manager.prepareDelete({ items: [ref('tree')] }).then(() => null, error => error);
  console.log(`[delete-metadata] 10000-file manifest case took ${Date.now() - overflow}ms`);
  assert.ok(withoutPoison, 'a tree with 10000 files plus its own directory entry exceeds the manifest bound and must be refused');
  assert.equal(withoutPoison.code, 'TOO_LARGE',
    `the manifest bound must count the directory still being walked, got ${withoutPoison.code}: ${withoutPoison.message}`);
  assert.equal(withoutPoison.status, 413);
  const intact = await readdir(path.join(root, 'tree'));
  assert.equal(intact.length, 10000, 'a refused manifest must remove nothing at all');
  assert.equal(await readFile(path.join(root, 'tree', 'a09999'), 'utf8'), '');

  // The poison sorts last and is an entry type deletion cannot remove. A full
  // metadata pre-scan would reach it and report UNSUPPORTED_ENTRY; counting an
  // entry as it enters the manifest must instead stop the oversized manifest
  // with TOO_LARGE, before the poison is ever inspected.
  await withSocket(path.join(root, 'tree', 'z-poison'), async () => {
    try {
      const rejected = await manager.prepareDelete({ items: [ref('tree')] }).then(() => null, error => error);
      assert.ok(rejected, 'a manifest that exceeds the entry bound must be refused');
      assert.equal(rejected.code, 'TOO_LARGE',
        `the entry bound must trip before the trailing unsupported entry is inspected, got ${rejected.code}: ${rejected.message}`);
      assert.equal(rejected.status, 413);
      const remaining = await readdir(path.join(root, 'tree'));
      assert.equal(remaining.length, 10001, 'a refused manifest must remove nothing at all');
      assert.equal(remaining.includes('z-poison'), true);
      assert.equal(await readFile(path.join(root, 'tree', 'a09999'), 'utf8'), '');
    } finally {
      // Printed rather than hidden, and printed even while this case is red: this
      // is the slowest case in the file, so its duration is the input for
      // deciding whether it has to be isolated.
      console.log(`[delete-metadata] 10001-entry manifest case took ${Date.now() - started}ms total`);
    }
  });
});

test('a same-size rewrite that restores the mtime is still detected before deletion', async t => {
  const { manager, root, ref } = await fixture(t);
  const file = path.join(root, 'note');
  const fixed = 1700000000.5;
  await writeFile(file, 'aaaa');
  await utimes(file, fixed, fixed);
  const before = await lstat(file, { bigint: true });

  const plan = await manager.prepareDelete({ items: [ref('note')] });
  await writeFile(file, 'bbbb');
  const after = await restoreMtimeAndAdvanceCtime(file, fixed, before);

  assert.equal(after.size, before.size, 'the case must keep the size unchanged');
  assert.equal(after.ino, before.ino, 'the case must keep the same inode');
  assert.equal(after.mtimeNs, before.mtimeNs, 'the case must restore mtimeNs exactly, isolating ctime');
  assert.notEqual(after.ctimeNs, before.ctimeNs, 'ctime must have advanced for the case to be meaningful');

  await assert.rejects(manager.commitDelete({ planId: plan.id, confirmed: true }), { code: 'VERSION_CONFLICT' });
  assert.equal(await readFile(file, 'utf8'), 'bbbb', 'a refused commit must leave the new content in place');
});

test('replacing the prepared file with a different inode is refused', async t => {
  const { manager, root, ref } = await fixture(t);
  const file = path.join(root, 'note');
  const replacement = path.join(root, 'replacement');
  const fixed = 1700000000.5;
  await writeFile(file, 'aaaa');
  await utimes(file, fixed, fixed);
  const before = await lstat(file, { bigint: true });

  const plan = await manager.prepareDelete({ items: [ref('note')] });
  // Created while the original still exists, so the replacement cannot reuse its inode.
  await writeFile(replacement, 'bbbb');
  await utimes(replacement, fixed, fixed);
  await rm(file);
  await rename(replacement, file);
  const after = await lstat(file, { bigint: true });

  assert.notEqual(after.ino, before.ino, 'the case must present a different inode');
  assert.equal(after.size, before.size, 'the case must keep the size unchanged');
  await assert.rejects(manager.commitDelete({ planId: plan.id, confirmed: true }), { code: 'VERSION_CONFLICT' });
  assert.equal(await readFile(file, 'utf8'), 'bbbb');
});

test('removing a member from a prepared directory is refused', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'folder'));
  await writeFile(path.join(root, 'folder', 'a'), 'a');
  await writeFile(path.join(root, 'folder', 'b'), 'b');

  const plan = await manager.prepareDelete({ items: [ref('folder')] });
  await rm(path.join(root, 'folder', 'b'));
  await assert.rejects(manager.commitDelete({ planId: plan.id, confirmed: true }), { code: 'VERSION_CONFLICT' });
  assert.deepEqual(await readdir(path.join(root, 'folder')), ['a']);
});

test('a directory whose own metadata moved is refused even with members and inode unchanged', async t => {
  // The prepared directory token is the full metadata stamp, not an identity:
  // touching only the directory (no member change, no new inode, no content
  // change) must still invalidate the manifest.
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'folder'));
  await writeFile(path.join(root, 'folder', 'keep.txt'), 'contents');
  const before = await lstat(path.join(root, 'folder'), { bigint: true });

  const plan = await manager.prepareDelete({ items: [ref('folder')] });
  assert.equal(plan.entryCount, 2);

  await utimes(path.join(root, 'folder'), 1700000000.5, 1700000000.5);
  const after = await lstat(path.join(root, 'folder'), { bigint: true });
  assert.notEqual(after.mtimeNs, before.mtimeNs, 'the case must move the directory mtime for the stamp to differ');
  assert.equal(after.ino, before.ino, 'the case must keep the directory inode');
  assert.equal(after.size, before.size, 'the case must keep the directory size');
  assert.deepEqual(await readdir(path.join(root, 'folder')), ['keep.txt'], 'the member set must be unchanged');
  assert.equal(await readFile(path.join(root, 'folder', 'keep.txt'), 'utf8'), 'contents');

  const rejected = await manager.commitDelete({ planId: plan.id, confirmed: true }).then(() => null, error => error);
  assert.ok(rejected, 'a directory whose own metadata moved must invalidate the prepared manifest');
  assert.equal(rejected.code, 'VERSION_CONFLICT');
  assert.equal(rejected.status, 409);
  assert.deepEqual(await readdir(root), ['folder'], 'a refused manifest must leave the tree untouched');
  assert.equal(await readFile(path.join(root, 'folder', 'keep.txt'), 'utf8'), 'contents');
});

test('a prepared directory replaced by a new inode is refused even with the same members', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'folder'));
  const before = await lstat(path.join(root, 'folder'), { bigint: true });

  const plan = await manager.prepareDelete({ items: [ref('folder')] });
  assert.equal(plan.entryCount, 1);

  // The original is kept alive under another name, so the replacement cannot
  // reuse its inode, and both directories have the same (empty) member set.
  await rename(path.join(root, 'folder'), path.join(root, 'moved'));
  await mkdir(path.join(root, 'folder'));
  const after = await lstat(path.join(root, 'folder'), { bigint: true });
  assert.notEqual(after.ino, before.ino, 'the case must present a different directory inode');
  assert.deepEqual(await readdir(path.join(root, 'folder')), [], 'the replacement must have the same member set');
  assert.deepEqual(await readdir(path.join(root, 'moved')), []);

  const rejected = await manager.commitDelete({ planId: plan.id, confirmed: true }).then(() => null, error => error);
  assert.ok(rejected, 'a replaced directory must invalidate the prepared manifest');
  assert.equal(rejected.code, 'VERSION_CONFLICT');
  assert.equal(rejected.status, 409);
  assert.equal(await exists(path.join(root, 'folder')), true);
  assert.equal(await exists(path.join(root, 'moved')), true);
  assert.deepEqual((await readdir(root)).sort(), ['folder', 'moved']);
});

test('a new member deep inside a prepared tree rejects the whole manifest, not just that entry', async t => {
  const { manager, root, ref } = await fixture(t);
  await mkdir(path.join(root, 'outer', 'inner'), { recursive: true });
  await writeFile(path.join(root, 'outer', 'inner', 'a'), 'a');
  await writeFile(path.join(root, 'other'), 'other');

  const plan = await manager.prepareDelete({ items: [ref('outer'), ref('other')] });
  assert.equal(plan.targets.length, 2);
  await writeFile(path.join(root, 'outer', 'inner', 'new'), 'new');

  const rejected = await manager.commitDelete({ planId: plan.id, confirmed: true }).then(() => null, error => error);
  assert.ok(rejected, 'a manifest whose membership changed must be refused');
  assert.equal(rejected.code, 'VERSION_CONFLICT');
  assert.equal(rejected.status, 409);
  assert.equal(await exists(path.join(root, 'other')), true, 'a refused manifest must not delete its unaffected targets either');
  assert.deepEqual((await readdir(path.join(root, 'outer', 'inner'))).sort(), ['a', 'new']);
});

test('a prepared target that disappeared is refused with a conflict, not a partial success', async t => {
  const { manager, root, ref } = await fixture(t);
  await writeFile(path.join(root, 'note'), 'note');

  const plan = await manager.prepareDelete({ items: [ref('note')] });
  await rm(path.join(root, 'note'));

  const rejected = await manager.commitDelete({ planId: plan.id, confirmed: true }).then(() => null, error => error);
  assert.ok(rejected, 'a prepared target that no longer exists must be refused');
  assert.equal(rejected.code, 'VERSION_CONFLICT');
  assert.equal(rejected.status, 409);
});

test('a read-only parent fails only its own entry and leaves its sibling completed', async t => {
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
  await mkdir(blocked);
  await writeFile(path.join(blocked, 'inside'), 'inside');
  await writeFile(path.join(root, 'free'), 'free');
  await chmod(blocked, 0o555);
  try {
    const plan = await manager.prepareDelete({ items: [ref('blocked/inside'), ref('free')] });
    assert.equal(plan.entryCount, 2);

    const result = await manager.commitDelete({ planId: plan.id, confirmed: true });
    assert.equal(result.status, 'partial', `a denied entry must produce a partial result, got ${JSON.stringify(result.results)}`);
    const byPath = new Map(result.results.map(item => [item.path, item]));
    assert.equal(byPath.get('free').status, 'completed', 'an entry with a writable parent must still be removed');
    assert.equal(await exists(path.join(root, 'free')), false);
    assert.equal(byPath.get('blocked/inside').status, 'failed');
    assert.equal(byPath.get('blocked/inside').error.code, 'PERMISSION_DENIED');
    assert.equal(await readFile(path.join(blocked, 'inside'), 'utf8'), 'inside');
  } finally {
    await chmod(blocked, 0o755);
  }
});

test('preparing a symlink reads neither the link nor its large target', async t => {
  const { manager, root, base, ref } = await fixture(t);
  const target = path.join(base, 'target.bin');
  await sparseFile(target, SIZE);
  await symlink(target, path.join(root, 'link'));

  const measured = await measureReads(() => manager.prepareDelete({ items: [ref('link')] }));
  assert.ok(measured.bytes < METADATA_NOISE_LIMIT,
    `preparing a symlink must not follow or read its target: rchar delta ${measured.bytes} must stay under ${METADATA_NOISE_LIMIT}`);
  const plan = measured.value;
  assert.equal(plan.entries[0].kind, 'symlink');
  assertMetadataToken(plan.entries[0].version, await lstat(path.join(root, 'link'), { bigint: true }));

  const result = await manager.commitDelete({ planId: plan.id, confirmed: true });
  assert.equal(result.status, 'completed');
  assert.equal(await exists(path.join(root, 'link')), false, 'only the link may be removed');
  assert.equal(await exists(target), true, 'the link target must survive');
});

test('the wire delete plan carries a metadata token and reads no content', async t => {
  // The operator-visible contract, through the frozen v2 control route: the view
  // projection must not turn the metadata token into a content-bound one, and the
  // whole request must stay off the content budget.
  const fixture = await hostFixture();
  t.after(fixture.close);
  const file = path.join(fixture.directory, 'big.bin');
  await sparseFile(file, SIZE);

  const measured = await measureReads(() => fixture.call('delete.prepare', { items: [fixture.ref('big.bin')] }));
  assert.equal(measured.value.status, 200, `delete.prepare must accept a metadata-only plan: ${JSON.stringify(measured.value.body)}`);
  assert.ok(measured.bytes < METADATA_NOISE_LIMIT,
    `delete.prepare must not read the ${SIZE} byte file's contents: rchar delta ${measured.bytes} must stay under ${METADATA_NOISE_LIMIT}`);
  const entry = measured.value.value.entries[0];
  assert.equal(entry.path, 'big.bin');
  assert.equal(entry.size, SIZE);
  assertMetadataToken(entry.version, await lstat(file, { bigint: true }));
});