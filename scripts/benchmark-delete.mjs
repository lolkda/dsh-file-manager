#!/usr/bin/env node
/** Reproducible real-filesystem benchmark; deletes only its own mkdtemp fixture. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const modulePath = path.resolve(process.argv[2] ?? 'dist/host/manager.js');
const count = Number(process.argv[3] ?? 12000);
const repetitions = Number(process.argv[4] ?? 3);
assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 100000);
assert.ok(Number.isSafeInteger(repetitions) && repetitions > 0 && repetitions <= 10);
const { createManager } = await import(pathToFileURL(modulePath));

for (const depth of [0, 8]) {
  for (let round = 1; round <= repetitions; round++) {
    const base = await fs.mkdtemp(path.join(tmpdir(), 'dsh-fm-delete-bench-'));
    const realBase = await fs.realpath(base);
    const root = path.join(base, 'root');
    const relative = [...Array.from({ length: depth }, (_, i) => `level-${i}`), 'tree'].join('/');
    const target = path.join(root, relative);
    let manager;
    const realOpen = fs.open;
    try {
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(root, 'keep'), 'unselected');
      let next = 0;
      await Promise.all(Array.from({ length: 24 }, async () => {
        while (next < count) await fs.writeFile(path.join(target, `file-${next++}`), '');
      }));
      manager = createManager({ rootPath: root });
      const startPrepare = performance.now();
      const plan = await manager.prepareDelete({ items: [{ rootId: manager.getRoot().id, path: relative }] });
      const prepareMs = performance.now() - startPrepare;
      let rootOpens = 0;
      fs.open = async (target, ...args) => {
        if (target === root) rootOpens++;
        return realOpen(target, ...args);
      };
      syncBuiltinESMExports();
      const startCommit = performance.now();
      const result = await manager.commitDelete({ planId: plan.id, confirmed: true });
      const commitMs = performance.now() - startCommit;
      fs.open = realOpen;
      syncBuiltinESMExports();
      assert.equal(result.status, 'completed', JSON.stringify(result));
      await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
      assert.equal(await fs.readFile(path.join(root, 'keep'), 'utf8'), 'unselected');
      console.log(JSON.stringify({ modulePath, node: process.version, depth, count, round, prepareMs, commitMs, rootOpens }));
    } finally {
      fs.open = realOpen;
      syncBuiltinESMExports();
      await manager?.close();
      // Check the exact generated absolute target before recursive teardown.
      assert.equal(await fs.realpath(base), realBase);
      assert.ok(path.basename(realBase).startsWith('dsh-fm-delete-bench-'));
      assert.equal(path.dirname(realBase), await fs.realpath(tmpdir()));
      await fs.rm(realBase, { recursive: true, force: true });
    }
  }
}
