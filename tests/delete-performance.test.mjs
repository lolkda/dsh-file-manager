import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createManager } from '../dist/host/manager.js';
import { DELETE_IO_CONCURRENCY } from '../dist/contracts/limits.js';

const BATCH = DELETE_IO_CONCURRENCY;
const filename = i => `file-${String(i).padStart(5, '0')}`;
const leafName = target => path.basename(String(target));

async function fixture(t, count, relative = 'parent/tree', selected = relative) {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'dsh-fm-delete-perf-'));
  const realBase = await fs.realpath(base);
  const root = path.join(base, 'root');
  const tree = path.join(root, relative);
  await fs.mkdir(tree, { recursive: true });
  for (let start = 0; start < count; start += 24) {
    await Promise.all(Array.from({ length: Math.min(24, count - start) }, (_, i) => fs.writeFile(path.join(tree, filename(start + i)), '')));
  }
  await fs.writeFile(path.join(root, 'keep'), 'unselected');
  const manager = createManager({ rootPath: root });
  t.after(async () => {
    await manager.close();
    assert.equal(await fs.realpath(base), realBase);
    assert.equal(path.dirname(realBase), await fs.realpath(tmpdir()));
    assert.ok(path.basename(realBase).startsWith('dsh-fm-delete-perf-'));
    await fs.rm(realBase, { recursive: true, force: true });
  });
  const plan = await manager.prepareDelete({ items: [{ rootId: manager.getRoot().id, path: selected }] });
  const commit = () => manager.commitDelete({ planId: plan.id, confirmed: true });
  return { base, root, tree, commit };
}

function patch(replacements) {
  const originals = Object.fromEntries(Object.keys(replacements).map(key => [key, fs[key]]));
  Object.assign(fs, replacements);
  syncBuiltinESMExports();
  return () => { Object.assign(fs, originals); syncBuiltinESMExports(); };
}

for (const [relative, selected] of [
  ['tree', 'tree'],
  ['a/b/c/d/e/f/g/h/tree', 'a/b/c/d/e/f/g/h/tree'],
  ['tree/a/b/c/d/e/f/g/h', 'tree'],
]) {
  test(`bulk deletion shares in-flight ancestor checks (${relative}, selecting ${selected})`, async t => {
    const count = BATCH * 32;
    const { root, tree, commit } = await fixture(t, count, relative, selected);
    const beforeDescriptors = (await fs.readdir('/proc/self/fd')).length;
    const realOpen = fs.open;
    const realUnlink = fs.unlink;
    const realLstat = fs.lstat;
    let rootOpens = 0;
    let inflight = 0;
    let maxInflight = 0;
    let unlinks = 0;
    let leafChecks = 0;
    const restore = patch({
      open: async (target, ...args) => {
        if (target === root) rootOpens++;
        return realOpen(target, ...args);
      },
      lstat: async (target, ...args) => {
        if (leafName(target).startsWith('file-')) leafChecks++;
        return realLstat(target, ...args);
      },
      unlink: async target => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        try { await realUnlink(target); unlinks++; }
        finally { inflight--; }
      },
    });
    let result;
    try { result = await commit(); } finally { restore(); }
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(unlinks, count);
    assert.equal(inflight, 0);
    assert.ok(maxInflight <= BATCH, `leaf I/O must remain bounded: ${maxInflight}`);
    assert.ok(leafChecks >= count * 3, 'keep all existing per-leaf identity observations');
    assert.ok(rootOpens < count / 2, `do not re-open the entire parent chain for every file: ${rootOpens} root opens for ${count} leaves`);
    assert.ok(rootOpens >= count / BATCH, 'later batches must not use a completed verification');
    await assert.rejects(fs.lstat(tree), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(root, 'keep'), 'utf8'), 'unselected');
    assert.ok((await fs.readdir('/proc/self/fd')).length <= beforeDescriptors);
    t.diagnostic(`${count} leaves, ${rootOpens} root opens, peak unlink concurrency ${maxInflight}`);
  });
}

for (const swap of ['root', 'ancestor', 'selected-directory']) {
  test(`later batches recheck ${swap} after a completed verification`, async t => {
    const { base, root, tree, commit } = await fixture(t, BATCH * 2);
    const beforeDescriptors = (await fs.readdir('/proc/self/fd')).length;
    const source = swap === 'root' ? root : swap === 'ancestor' ? path.join(root, 'parent') : tree;
    const moved = path.join(base, 'moved');
    const originalTree = swap === 'root' ? path.join(moved, 'parent', 'tree') : swap === 'ancestor' ? path.join(moved, 'tree') : moved;
    const realUnlink = fs.unlink;
    let removed = 0;
    const restore = patch({ unlink: async target => {
      await realUnlink(target);
      if (++removed === BATCH) {
        // The last unlink in batch one cannot resolve until the swap is complete.
        // Batch two therefore must obtain a fresh ancestor verification.
        assert.equal(await fs.realpath(source), source);
        await fs.rename(source, moved);
        await fs.mkdir(tree, { recursive: true });
        await fs.writeFile(path.join(tree, 'replacement'), 'untouched');
      }
    } });
    let result;
    try { result = await commit(); } finally { restore(); }
    assert.equal(result.status, 'partial');
    assert.equal(result.results[0].error.code, swap === 'root' ? 'ROOT_CHANGED' : 'PATH_CHANGED');
    assert.equal(result.results[0].removed, false);
    assert.equal(result.results[0].contentsChanged, true);
    assert.equal(removed, BATCH);
    assert.equal((await fs.readdir(originalTree)).length, BATCH);
    assert.equal(await fs.readFile(path.join(tree, 'replacement'), 'utf8'), 'untouched');
    assert.ok((await fs.readdir('/proc/self/fd')).length <= beforeDescriptors);
  });
}

test('shared verification failure reaches all waiters and is not cached for later batches', { timeout: 15000 }, async t => {
  const { root, tree, commit } = await fixture(t, BATCH * 2);
  const beforeDescriptors = (await fs.readdir('/proc/self/fd')).length;
  const realOpen = fs.open;
  const realLstat = fs.lstat;
  const realReaddir = fs.readdir;
  const gate = Promise.withResolvers();
  const allObserved = Promise.withResolvers();
  let listed = false;
  let failures = 0;
  let observations = 0;
  const restore = patch({
    readdir: async (target, ...args) => {
      const entries = await realReaddir(target, ...args);
      if (entries.some(entry => String(entry.name ?? entry) === filename(0))) listed = true;
      return entries;
    },
    lstat: async (target, ...args) => {
      const result = await realLstat(target, ...args);
      if (listed && leafName(target).startsWith('file-') && ++observations === BATCH * 2) allObserved.resolve();
      return result;
    },
    open: async (target, ...args) => {
      if (listed && target === root && failures === 0) {
        failures++;
        await gate.promise;
        throw Object.assign(new Error('injected parent verification failure'), { code: 'EACCES' });
      }
      return realOpen(target, ...args);
    },
  });
  const pending = commit();
  let result;
  try {
    await allObserved.promise;
    // Let the completed lstat continuations join the in-flight check; no sleeps.
    await new Promise(resolve => setImmediate(resolve));
    gate.resolve();
    result = await pending;
  } finally {
    gate.resolve();
    await pending;
    restore();
  }
  assert.equal(failures, 1);
  assert.equal(result.status, 'partial');
  assert.equal(result.results[0].contentsChanged, true, 'later batch retries the parent check and deletes its leaves');
  assert.equal(result.results[0].removed, false);
  assert.deepEqual(await fs.readdir(tree), Array.from({ length: BATCH }, (_, i) => filename(i)), 'all waiters share the failed check; none may unlink');
  assert.ok((await fs.readdir('/proc/self/fd')).length <= beforeDescriptors);
});
