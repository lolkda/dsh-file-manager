/**
 * Explicit compatibility confirmation for `entries.rename`, observed on the Host.
 *
 * The strict contract is that one rename is published with the Linux
 * `renameat2(RENAME_NOREPLACE)` helper, and that a filesystem which cannot enforce
 * no-replace is refused rather than guessed at. This suite pins the single agreed
 * exception: a request may carry `allowNonExclusiveRename: true`, and only then may
 * the manager fall back to an ordinary `fs.rename` — and only when the helper itself
 * proved, with an unsupported errno, that the kernel cannot do better. A helper that
 * could not be started, a signal, a permission failure, an unobservable process or an
 * unconfirmed outcome never authorizes that fallback, because in each of those cases
 * the Host cannot prove what happened on the filesystem.
 *
 * How the cases stay deterministic without a production injection switch:
 * - Real filesystem, real manager, real descriptor-anchored paths; nothing about the
 *   code under test is replaced.
 * - `child_process.spawn` is the one wrapped export. The stand-in child reports a
 *   chosen helper outcome (an errno, a start failure, a signal, unobservable stdio)
 *   and may mutate the fixture while it "runs", so a source, target or parent race is
 *   produced exactly where the real helper would have run. `syncBuiltinESMExports()`
 *   makes the Host's own namespace import see the wrapper, and it is restored after
 *   each case.
 * - The fallback's own `fs.rename` is counted by its fd-anchored argument, so "the
 *   fallback did not run" is proven directly instead of being inferred from the
 *   absence of a rename.
 * - The strict-refusal cases assert the full refusal contract, including that the
 *   refusal still carries the `compatibilityAvailable` marker a client needs in order
 *   to offer the confirmation at all.
 */

import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import { lstat, mkdir, mkdtemp, open, readFile, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createControlHandler } from '../dist/index.js';
import { createManager } from '../dist/host/manager.js';

/** The errno numbers the helper can report through its exit status. */
const ERRNO = { EACCES: 13, EEXIST: 17, EINVAL: 22, ENOSYS: 38, ENOTEMPTY: 39, ENOTSUP: 95 };

/** The real exports, captured before any case wraps them. */
const realSpawn = cp.spawn;
const realRename = fsp.rename;

/** At most one wrapper per case, so the restore order can never be ambiguous. */
const wrapped = new WeakSet();

/**
 * Point a case at a deterministic stand-in for the native helper.
 *
 * `report` runs while the child "is running" and before it closes, which is the
 * window in which another client of the same filesystem could change something.
 * A case that needs several outcomes uses several cases, each with its own fixture,
 * because two nested wrappers would leave the restore order deciding which stand-in
 * outlives the test. A leftover wrapper from an earlier case is reported instead of
 * being silently inherited.
 */
function useHelper(t, options = {}) {
  if (wrapped.has(t)) throw new Error('child_process.spawn is already wrapped for this case; use one case per outcome instead of nesting wrappers');
  if (cp.spawn !== realSpawn) throw new Error('child_process.spawn was left wrapped by an earlier case');
  wrapped.add(t);
  const { report = undefined, stdout = '', code = 1, signal = null, startError = undefined, observable = true } = options;
  const original = cp.spawn;
  const calls = [];
  const spawn = (command, args, spawnOptions) => {
    calls.push({ command, args, spawnOptions });
    const child = new EventEmitter();
    child.stdout = observable ? new PassThrough() : null;
    child.stderr = observable ? new PassThrough() : null;
    child.kill = () => { child.killed = true; };
    setImmediate(() => { void (async () => {
      if (startError !== undefined) {
        // A real `spawn` reports a start failure asynchronously; the helper never ran.
        child.emit('error', Object.assign(new Error('the helper could not be started'), { code: startError }));
        return;
      }
      if (report !== undefined) await report(calls.length);
      if (stdout) child.stdout.write(stdout);
      // A stream delivers its data on a later turn, so the close follows it.
      setImmediate(() => child.emit('close', code, signal));
    })(); });
    return child;
  };
  spawn.calls = calls;
  cp.spawn = spawn;
  syncBuiltinESMExports();
  t.after(() => { cp.spawn = original; syncBuiltinESMExports(); });
  return spawn;
}

/** Record the manager's own renames; a descriptor path only the fallback can build. */
function countManagerRenames(t) {
  if (fsp.rename !== realRename) throw new Error('fs/promises rename was left wrapped by an earlier case');
  const seen = [];
  fsp.rename = async (from, to) => {
    if (String(from).startsWith('/proc/self/fd/')) seen.push({ from, to });
    return realRename(from, to);
  };
  syncBuiltinESMExports();
  t.after(() => { fsp.rename = realRename; syncBuiltinESMExports(); });
  return seen;
}

/** Make the next directory descriptor synchronization fail, after publication. */
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
  finally { prototype.sync = original; syncBuiltinESMExports(); }
}

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-fm-rename-compat-'));
  const root = path.join(base, 'root');
  await mkdir(root);
  const manager = createManager({ rootPath: root });
  const grant = manager.getRoot();
  // Close before removing: an open manager still holds root descriptors.
  t.after(async () => { await manager.close(); await rm(base, { recursive: true, force: true }); });
  return {
    base, root, manager,
    control: createControlHandler({ manager }),
    ref: relative => ({ rootId: grant.id, path: relative }),
  };
}

const capture = work => work.then(
  value => { throw new Error(`expected a rejection, received ${JSON.stringify(value)}`); },
  error => error,
);
const exists = filename => stat(filename).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

const request = payload => new Request('http://localhost/api/file-manager/v2/control', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
});

/* ------------------------------------------------------------------ *
 * Default and false stay strict
 * ------------------------------------------------------------------ */

test('an absent or false confirmation keeps the strict refusal when the helper cannot enforce no-replace', async t => {
  const { root, manager, ref } = await fixture(t);
  await writeFile(path.join(root, 'old'), 'original');
  const version = (await manager.list(ref(''))).entries[0].version;
  const helper = useHelper(t, { stdout: String(ERRNO.ENOSYS) });
  const renames = countManagerRenames(t);

  for (const confirmation of [undefined, false]) {
    const failure = await capture(manager.rename({ ...ref('old'), name: 'new', expectedVersion: version, ...(confirmation === undefined ? {} : { allowNonExclusiveRename: confirmation }) }));
    assert.equal(failure.code, 'UNSUPPORTED_ATOMIC_RENAME');
    assert.equal(failure.status, 501);
    // The refusal is the affordance: without this marker a client could not tell a
    // filesystem limitation from a helper fault, and would have nothing to confirm.
    assert.equal(failure.details?.compatibilityAvailable, true);
  }

  assert.equal(helper.calls.length, 2, 'the atomic helper is attempted for every request');
  assert.equal(renames.length, 0, 'neither request may take the ordinary fallback');
  assert.equal(await readFile(path.join(root, 'old'), 'utf8'), 'original');
  assert.equal(await exists(path.join(root, 'new')), false);
});

test('a non-boolean confirmation is refused before the helper runs', async t => {
  const { root, manager, ref } = await fixture(t);
  await writeFile(path.join(root, 'old'), 'original');
  const version = (await manager.list(ref(''))).entries[0].version;
  const helper = useHelper(t, { stdout: String(ERRNO.ENOSYS) });
  const renames = countManagerRenames(t);

  const failure = await capture(manager.rename({ ...ref('old'), name: 'new', expectedVersion: version, allowNonExclusiveRename: 'true' }));
  assert.equal(failure.code, 'INVALID_REQUEST');
  assert.equal(failure.status, 400);
  assert.equal(helper.calls.length, 0);
  assert.equal(renames.length, 0);
  assert.equal(await exists(path.join(root, 'new')), false);
});

/* ------------------------------------------------------------------ *
 * An explicit true falls back for every renamable kind
 * ------------------------------------------------------------------ */

test('a confirmed rename of a file falls back to an ordinary rename after the helper refuses', async t => {
  const { root, manager, ref } = await fixture(t);
  await writeFile(path.join(root, 'old'), 'original');
  const version = (await manager.list(ref(''))).entries[0].version;
  const helper = useHelper(t, { stdout: String(ERRNO.ENOSYS) });
  const renames = countManagerRenames(t);

  const result = await manager.rename({ ...ref('old'), name: 'new', expectedVersion: version, allowNonExclusiveRename: true });
  assert.equal(result.path, 'new');
  assert.equal(result.kind, 'file');
  assert.equal(helper.calls.length, 1, 'the atomic attempt always comes first');
  assert.deepEqual(helper.calls[0].args, ['old', 'new']);
  assert.equal(renames.length, 1, 'exactly one ordinary rename publishes the confirmed result');
  assert.ok(renames[0].to.endsWith('/new'));
  assert.equal(await exists(path.join(root, 'old')), false);
  assert.equal(await readFile(path.join(root, 'new'), 'utf8'), 'original');
});

test('a confirmed rename of a directory falls back and keeps its contents', async t => {
  const { root, manager, ref } = await fixture(t);
  await mkdir(path.join(root, 'dir'));
  await writeFile(path.join(root, 'dir', 'inner.txt'), 'kept');
  const version = (await manager.list(ref(''))).entries.find(entry => entry.name === 'dir').version;
  useHelper(t, { stdout: String(ERRNO.ENOSYS) });
  const renames = countManagerRenames(t);

  const result = await manager.rename({ ...ref('dir'), name: 'moved', expectedVersion: version, allowNonExclusiveRename: true });
  assert.equal(result.path, 'moved');
  assert.equal(result.kind, 'directory');
  assert.equal(renames.length, 1);
  assert.equal(await readFile(path.join(root, 'moved', 'inner.txt'), 'utf8'), 'kept');
  assert.equal(await exists(path.join(root, 'dir')), false);
});

test('a confirmed rename of a symlink falls back without following the link', async t => {
  const { base, root, manager, ref } = await fixture(t);
  await writeFile(path.join(base, 'outside.txt'), 'outside');
  await symlink('../outside.txt', path.join(root, 'link'));
  const version = (await manager.list(ref(''))).entries.find(entry => entry.name === 'link').version;
  useHelper(t, { stdout: String(ERRNO.ENOSYS) });
  const renames = countManagerRenames(t);

  const result = await manager.rename({ ...ref('link'), name: 'moved', expectedVersion: version, allowNonExclusiveRename: true });
  assert.equal(result.path, 'moved');
  assert.equal(result.kind, 'symlink');
  assert.equal(renames.length, 1);
  assert.equal((await lstat(path.join(root, 'moved'))).isSymbolicLink(), true);
  assert.equal(await readlink(path.join(root, 'moved')), '../outside.txt');
  assert.equal(await readFile(path.join(base, 'outside.txt'), 'utf8'), 'outside');
});

// One errno per case, each with its own fixture and its own single wrapper: nesting
// three wrappers inside one test would make the restore order decide which stand-in
// survived the test.
for (const [name, errno] of [['ENOSYS', ERRNO.ENOSYS], ['ENOTSUP', ERRNO.ENOTSUP], ['EINVAL', ERRNO.EINVAL]]) {
  test(`the ${name} errno proves no-replace is unavailable and authorizes the confirmed fallback`, async t => {
    const { root, manager, ref } = await fixture(t);
    await writeFile(path.join(root, 'old'), 'original');
    const version = (await manager.list(ref(''))).entries[0].version;
    useHelper(t, { stdout: String(errno) });
    const renames = countManagerRenames(t);

    const result = await manager.rename({ ...ref('old'), name: 'new', expectedVersion: version, allowNonExclusiveRename: true });
    assert.equal(result.path, 'new', `errno ${errno} must authorize the fallback`);
    assert.equal(renames.length, 1);
    assert.equal(await readFile(path.join(root, 'new'), 'utf8'), 'original');
    assert.equal(await exists(path.join(root, 'old')), false);
  });
}

test('a helper that already published the rename is never followed by a second one', async t => {
  const { root, manager, ref } = await fixture(t);
  await writeFile(path.join(root, 'old'), 'original');
  const version = (await manager.list(ref(''))).entries[0].version;
  // The helper publishes the rename itself, then reports success. The manager must
  // accept that outcome and must not repeat the move through the fallback.
  useHelper(t, { stdout: '', code: 0, report: async () => { await rename(path.join(root, 'old'), path.join(root, 'new')); } });
  const renames = countManagerRenames(t);

  const result = await manager.rename({ ...ref('old'), name: 'new', expectedVersion: version, allowNonExclusiveRename: true });
  assert.equal(result.path, 'new');
  assert.equal(renames.length, 0, 'a successful atomic rename leaves nothing for the fallback');
  assert.equal(await readFile(path.join(root, 'new'), 'utf8'), 'original');
});

/* ------------------------------------------------------------------ *
 * The confirmed fallback re-verifies before it renames
 * ------------------------------------------------------------------ */

test('the confirmed fallback re-checks a content-bound source version', async t => {
  const { root, manager, ref } = await fixture(t);
  await writeFile(path.join(root, 'old'), 'aaaa');
  const version = (await manager.stat(ref('old'))).version;
  assert.match(version, /:[0-9a-f]{64}$/, 'a selected file carries a content-bound version');
  // The request carries the content-bound token, so this case exercises the re-hash
  // branch of the re-check. Rewriting the file also moves the metadata stamp, so what
  // is pinned here is "the confirmed fallback re-verifies before it renames", not that
  // the content observation is the one that fires first.
  useHelper(t, { stdout: String(ERRNO.ENOSYS), report: async () => { await writeFile(path.join(root, 'old'), 'bbbb'); } });
  const renames = countManagerRenames(t);

  const failure = await capture(manager.rename({ ...ref('old'), name: 'new', expectedVersion: version, allowNonExclusiveRename: true }));
  assert.equal(failure.code, 'VERSION_CONFLICT');
  assert.equal(failure.status, 409);
  assert.equal(renames.length, 0, 'the source is re-checked before the ordinary rename, not after');
  assert.equal(await exists(path.join(root, 'new')), false);
  assert.equal(await readFile(path.join(root, 'old'), 'utf8'), 'bbbb');
});

test('the confirmed fallback re-checks a metadata source version', async t => {
  const { root, manager, ref } = await fixture(t);
  await writeFile(path.join(root, 'old'), 'aaaa');
  const version = (await manager.list(ref(''))).entries[0].version;
  // The listing token is metadata-only, so this case exercises the stamp branch of the
  // re-check, and the rewrite is deliberately longer so that the stamp really moved.
  useHelper(t, { stdout: String(ERRNO.ENOSYS), report: async () => { await writeFile(path.join(root, 'old'), 'a longer body appeared'); } });
  const renames = countManagerRenames(t);

  const failure = await capture(manager.rename({ ...ref('old'), name: 'new', expectedVersion: version, allowNonExclusiveRename: true }));
  assert.equal(failure.code, 'VERSION_CONFLICT');
  assert.equal(renames.length, 0);
  assert.equal(await exists(path.join(root, 'new')), false);
  assert.equal(await readFile(path.join(root, 'old'), 'utf8'), 'a longer body appeared');
});

test('the confirmed fallback still refuses a destination that appeared while the helper ran', async t => {
  const { root, manager, ref } = await fixture(t);
  await writeFile(path.join(root, 'old'), 'original');
  const version = (await manager.list(ref(''))).entries[0].version;
  useHelper(t, { stdout: String(ERRNO.ENOSYS), report: async () => { await writeFile(path.join(root, 'new'), 'intruder'); } });
  const renames = countManagerRenames(t);

  const failure = await capture(manager.rename({ ...ref('old'), name: 'new', expectedVersion: version, allowNonExclusiveRename: true }));
  assert.equal(failure.code, 'ALREADY_EXISTS');
  assert.equal(failure.status, 409);
  assert.equal(renames.length, 0, 'the confirmed rename is not an unconditional overwrite');
  assert.equal(await readFile(path.join(root, 'old'), 'utf8'), 'original');
  assert.equal(await readFile(path.join(root, 'new'), 'utf8'), 'intruder');
});

test('the confirmed fallback re-verifies the parent directory that holds the name', async t => {
  const { root, manager, ref } = await fixture(t);
  await mkdir(path.join(root, 'dir'));
  await writeFile(path.join(root, 'dir', 'old'), 'original');
  const version = (await manager.list(ref('dir'))).entries[0].version;
  // The held descriptor survives the swap, so only re-checking the path can notice.
  useHelper(t, { stdout: String(ERRNO.ENOSYS), report: async () => {
    await rename(path.join(root, 'dir'), path.join(root, 'dir-old'));
    await mkdir(path.join(root, 'dir'));
  } });
  const renames = countManagerRenames(t);

  const failure = await capture(manager.rename({ ...ref('dir/old'), name: 'new', expectedVersion: version, allowNonExclusiveRename: true }));
  assert.ok(['PATH_CHANGED', 'ROOT_CHANGED'].includes(failure.code), `unexpected code ${failure.code}`);
  assert.equal(failure.status, 409);
  assert.equal(renames.length, 0);
  assert.equal(await readFile(path.join(root, 'dir-old', 'old'), 'utf8'), 'original');
  assert.equal(await exists(path.join(root, 'dir', 'new')), false);
});

/* ------------------------------------------------------------------ *
 * Every other helper failure stays authoritative
 * ------------------------------------------------------------------ */

test('a helper that could not be started never authorizes the fallback', async t => {
  const { root, manager, ref } = await fixture(t);
  await writeFile(path.join(root, 'old'), 'original');
  const version = (await manager.list(ref(''))).entries[0].version;
  useHelper(t, { startError: 'ENOENT' });
  const renames = countManagerRenames(t);

  const failure = await capture(manager.rename({ ...ref('old'), name: 'new', expectedVersion: version, allowNonExclusiveRename: true }));
  assert.equal(failure.code, 'UNSUPPORTED_ATOMIC_RENAME');
  assert.equal(failure.status, 501);
  assert.equal(failure.details?.cause, 'ENOENT');
  // A helper that never ran proves nothing about the filesystem, so a client must
  // not be offered the weaker guarantee for it.
  assert.equal('compatibilityAvailable' in (failure.details ?? {}), false);
  assert.equal(renames.length, 0);
  assert.equal(await readFile(path.join(root, 'old'), 'utf8'), 'original');
  assert.equal(await exists(path.join(root, 'new')), false);
});

test('an unconfirmed helper outcome never authorizes the fallback', async t => {
  const { root, manager, ref } = await fixture(t);
  await writeFile(path.join(root, 'old'), 'original');
  const version = (await manager.list(ref(''))).entries[0].version;
  useHelper(t, { stdout: 'not-an-errno', code: 1 });
  const renames = countManagerRenames(t);

  const failure = await capture(manager.rename({ ...ref('old'), name: 'new', expectedVersion: version, allowNonExclusiveRename: true }));
  assert.equal(failure.code, 'ATOMIC_RENAME_UNCERTAIN');
  assert.equal(failure.status, 500);
  assert.equal(failure.details?.outcome, 'unknown');
  assert.equal('compatibilityAvailable' in (failure.details ?? {}), false);
  assert.equal(renames.length, 0, 'an unknown outcome must be inspected, never guessed at');
  assert.equal(await exists(path.join(root, 'new')), false);
});

test('a helper killed by a signal never authorizes the fallback', async t => {
  const { root, manager, ref } = await fixture(t);
  await writeFile(path.join(root, 'old'), 'original');
  const version = (await manager.list(ref(''))).entries[0].version;
  useHelper(t, { stdout: '', code: null, signal: 'SIGKILL' });
  const renames = countManagerRenames(t);

  const failure = await capture(manager.rename({ ...ref('old'), name: 'new', expectedVersion: version, allowNonExclusiveRename: true }));
  assert.equal(failure.code, 'ATOMIC_RENAME_UNCERTAIN');
  assert.equal(failure.details?.signal, 'SIGKILL');
  assert.equal('compatibilityAvailable' in (failure.details ?? {}), false);
  assert.equal(renames.length, 0);
  assert.equal(await exists(path.join(root, 'new')), false);
});

test('a permission errno from the helper never authorizes the fallback', async t => {
  const { root, manager, ref } = await fixture(t);
  await writeFile(path.join(root, 'old'), 'original');
  const version = (await manager.list(ref(''))).entries[0].version;
  useHelper(t, { stdout: String(ERRNO.EACCES) });
  const renames = countManagerRenames(t);

  const failure = await capture(manager.rename({ ...ref('old'), name: 'new', expectedVersion: version, allowNonExclusiveRename: true }));
  assert.equal(failure.code, 'EACCES', 'an unmapped errno keeps its own identity');
  assert.equal(renames.length, 0, 'a denied rename is a denial, not a capability gap');
  assert.equal(await readFile(path.join(root, 'old'), 'utf8'), 'original');
});

// Both errnos mean "the destination is in the way", and neither may be downgraded
// into the confirmed fallback.
for (const [name, errno] of [['EEXIST', ERRNO.EEXIST], ['ENOTEMPTY', ERRNO.ENOTEMPTY]]) {
  test(`a helper-reported ${name} destination conflict never authorizes the fallback`, async t => {
    const { root, manager, ref } = await fixture(t);
    await writeFile(path.join(root, 'old'), 'original');
    const version = (await manager.list(ref(''))).entries[0].version;
    useHelper(t, { stdout: String(errno), report: async () => { await writeFile(path.join(root, 'new'), 'intruder'); } });
    const renames = countManagerRenames(t);

    const failure = await capture(manager.rename({ ...ref('old'), name: 'new', expectedVersion: version, allowNonExclusiveRename: true }));
    assert.equal(failure.code, 'ALREADY_EXISTS');
    assert.equal(failure.status, 409);
    assert.equal('compatibilityAvailable' in (failure.details ?? {}), false);
    assert.equal(renames.length, 0);
    assert.equal(await readFile(path.join(root, 'new'), 'utf8'), 'intruder');
  });
}

test('a helper whose stdio cannot be observed never authorizes the fallback', async t => {
  const { root, manager, ref } = await fixture(t);
  await writeFile(path.join(root, 'old'), 'original');
  const version = (await manager.list(ref(''))).entries[0].version;
  useHelper(t, { observable: false });
  const renames = countManagerRenames(t);

  const failure = await capture(manager.rename({ ...ref('old'), name: 'new', expectedVersion: version, allowNonExclusiveRename: true }));
  assert.equal(failure.code, 'UNSUPPORTED_ATOMIC_RENAME');
  assert.equal(failure.status, 501);
  assert.deepEqual(failure.details, {}, 'nothing was observed, so nothing may be claimed');
  assert.equal(renames.length, 0);
  assert.equal(await exists(path.join(root, 'new')), false);
});

/* ------------------------------------------------------------------ *
 * The exception belongs to one rename and nowhere else
 * ------------------------------------------------------------------ */

test('the shared io move refuses the same unsupported filesystem instead of renaming anyway', async t => {
  const { root, manager, ref } = await fixture(t);
  await writeFile(path.join(root, 'old'), 'original');
  const version = (await manager.list(ref(''))).entries[0].version;
  const helper = useHelper(t, { stdout: String(ERRNO.ENOSYS) });
  const renames = countManagerRenames(t);

  const failure = await capture(manager.io.renameEntry({ source: ref('old'), destination: ref('new'), expectedVersion: version }));
  assert.equal(failure.code, 'UNSUPPORTED_ATOMIC_RENAME');
  assert.equal(failure.status, 501);
  // The shared helper still reports the capability it lacks; only the single-entry
  // rename decides what to do with that report.
  assert.equal(failure.details?.compatibilityAvailable, true);
  assert.equal(helper.calls.length, 1);
  assert.equal(renames.length, 0, 'copy and move tasks must never inherit the exception');
  assert.equal(await readFile(path.join(root, 'old'), 'utf8'), 'original');
  assert.equal(await exists(path.join(root, 'new')), false);
});

test('directory publication refuses the same unsupported filesystem instead of renaming anyway', async t => {
  const { root, manager, ref } = await fixture(t);
  const helper = useHelper(t, { stdout: String(ERRNO.ENOSYS) });
  const renames = countManagerRenames(t);

  const stage = await manager.io.createStagedDirectory(ref('published'));
  const failure = await capture(stage.commit());
  assert.equal(failure.code, 'UNSUPPORTED_ATOMIC_RENAME');
  assert.equal(failure.status, 501);
  assert.equal(failure.details?.compatibilityAvailable, true);
  assert.equal(helper.calls.length, 1);
  assert.equal(renames.length, 0, 'publication is never a place for a per-request downgrade');
  assert.equal(await exists(path.join(root, 'published')), false);
  await stage.abort();
});

/* ------------------------------------------------------------------ *
 * Publication and synchronization failures keep their existing meaning
 * ------------------------------------------------------------------ */

test('a synchronization failure after the confirmed rename reports the committed effect', async t => {
  const { root, manager, ref } = await fixture(t);
  await writeFile(path.join(root, 'old'), 'retained');
  const version = (await manager.list(ref(''))).entries[0].version;
  useHelper(t, { stdout: String(ERRNO.ENOSYS) });
  const renames = countManagerRenames(t);

  const failure = await capture(withFailedDirectorySync(root, () => manager.rename({ ...ref('old'), name: 'new', expectedVersion: version, allowNonExclusiveRename: true })));
  assert.equal(failure.code, 'EIO');
  assert.equal(failure.details?.committed, true, 'the fallback really published before the sync failed');
  assert.equal(failure.details?.sourceRemoved, true);
  assert.equal(renames.length, 1);
  assert.equal(await readFile(path.join(root, 'new'), 'utf8'), 'retained');
  assert.equal(await exists(path.join(root, 'old')), false);
});

/* ------------------------------------------------------------------ *
 * The wire
 * ------------------------------------------------------------------ */

test('the control route passes an explicit confirmation through to the rename', async t => {
  const { root, control, ref } = await fixture(t);
  await writeFile(path.join(root, 'old'), 'original');
  const version = (await (await control(request({ op: 'entries.list', ...ref('') }))).json()).value.entries[0].version;
  const helper = useHelper(t, { stdout: String(ERRNO.ENOSYS) });
  const renames = countManagerRenames(t);

  const response = await control(request({ op: 'entries.rename', ...ref('old'), name: 'new', expectedVersion: version, allowNonExclusiveRename: true, requestId: randomUUID() }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).value.path, 'new');
  assert.equal(helper.calls.length, 1);
  assert.equal(renames.length, 1);
  assert.equal(await readFile(path.join(root, 'new'), 'utf8'), 'original');
});

test('the control route keeps the strict refusal and its affordance when the field is absent', async t => {
  const { root, control, ref } = await fixture(t);
  await writeFile(path.join(root, 'old'), 'original');
  const version = (await (await control(request({ op: 'entries.list', ...ref('') }))).json()).value.entries[0].version;
  useHelper(t, { stdout: String(ERRNO.ENOSYS) });
  const renames = countManagerRenames(t);

  const response = await control(request({ op: 'entries.rename', ...ref('old'), name: 'new', expectedVersion: version, requestId: randomUUID() }));
  assert.equal(response.status, 501);
  const { error } = await response.json();
  assert.equal(error.code, 'UNSUPPORTED_ATOMIC_RENAME');
  assert.equal(error.details.compatibilityAvailable, true);
  assert.equal(renames.length, 0);
  assert.equal(await exists(path.join(root, 'new')), false);
});

test('the control route refuses a confirmation that is not a boolean', async t => {
  const { root, control, ref } = await fixture(t);
  await writeFile(path.join(root, 'old'), 'original');
  const helper = useHelper(t, { stdout: String(ERRNO.ENOSYS) });

  const response = await control(request({ op: 'entries.rename', ...ref('old'), name: 'new', expectedVersion: '1:2:3:4:5', allowNonExclusiveRename: 'true', requestId: randomUUID() }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
  assert.equal(helper.calls.length, 0, 'an unparsable confirmation must not reach the filesystem');
  assert.equal(await exists(path.join(root, 'new')), false);
});

test('a replayed confirmed rename is answered from the request ledger instead of running twice', async t => {
  const { root, control, ref } = await fixture(t);
  await writeFile(path.join(root, 'old'), 'original');
  const version = (await (await control(request({ op: 'entries.list', ...ref('') }))).json()).value.entries[0].version;
  const helper = useHelper(t, { stdout: String(ERRNO.ENOSYS) });
  const renames = countManagerRenames(t);
  const payload = { op: 'entries.rename', ...ref('old'), name: 'new', expectedVersion: version, allowNonExclusiveRename: true, requestId: 'confirmed-rename-request' };

  const first = await control(request(payload));
  const replay = await control(request(payload));
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), await first.json());
  assert.equal(helper.calls.length, 1);
  assert.equal(renames.length, 1);
  assert.equal(await readFile(path.join(root, 'new'), 'utf8'), 'original');
});

test('a strict request cannot be replayed as a confirmed one', async t => {
  const { root, control, ref } = await fixture(t);
  await writeFile(path.join(root, 'old'), 'original');
  const version = (await (await control(request({ op: 'entries.list', ...ref('') }))).json()).value.entries[0].version;
  useHelper(t, { stdout: String(ERRNO.ENOSYS) });
  const renames = countManagerRenames(t);
  const strict = { op: 'entries.rename', ...ref('old'), name: 'new', expectedVersion: version, requestId: 'strict-rename-request' };

  assert.equal((await control(request(strict))).status, 501);
  // The confirmation is part of the request identity, so reusing the id cannot
  // quietly upgrade an already-decided strict request into the weaker guarantee.
  const upgraded = await control(request({ ...strict, allowNonExclusiveRename: true }));
  assert.equal(upgraded.status, 409);
  assert.equal((await upgraded.json()).error.code, 'REQUEST_ID_REUSED');
  assert.equal(renames.length, 0);
  assert.equal(await readFile(path.join(root, 'old'), 'utf8'), 'original');
});
