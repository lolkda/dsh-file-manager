import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createManager } from '../dist/host/manager.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-atomic-'));
  const managers = [createManager(), createManager()];
  const grants = await Promise.all(managers.map(manager => manager.addRoot({ path: root })));
  t.after(async () => { await Promise.all(managers.map(manager => manager.close())); await rm(root, { recursive: true, force: true }); });
  return { root, managers, ref: (index, relative) => ({ rootId: grants[index].id, path: relative }) };
}
async function survivingContents(root, names) {
  const contents = await Promise.all(names.map(name => readFile(path.join(root, name), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  })));
  return contents.filter(value => value !== null).sort();
}
function assertExclusive(outcomes) {
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1, 'only one operation may publish the target');
  const rejected = outcomes.find(outcome => outcome.status === 'rejected');
  assert.equal(rejected.reason.code, 'ALREADY_EXISTS');
  assert.notEqual(rejected.reason.details?.committed, true, 'the losing operation must not have clobbered a target');
}

test('independent managers racing to rename never lose either source without overwrite authorization', async t => {
  const { root, managers, ref } = await fixture(t);
  for (let round = 0; round < 12; round++) {
    const names = [`a-${round}`, `b-${round}`, `target-${round}`];
    await Promise.all([writeFile(path.join(root, names[0]), 'AAA'), writeFile(path.join(root, names[1]), 'BBB')]);
    const versions = await Promise.all(managers.map((manager, index) => manager.stat(ref(index, names[index]))));
    const outcomes = await Promise.allSettled(managers.map((manager, index) => manager.rename({ ...ref(index, names[index]), name: names[2], expectedVersion: versions[index].version })));
    assert.deepEqual(await survivingContents(root, names), ['AAA', 'BBB'], 'a check-then-rename race lost source bytes');
    assertExclusive(outcomes);
  }
});

test('independent move publishers atomically refuse an occupied destination', async t => {
  const { root, managers, ref } = await fixture(t);
  for (let round = 0; round < 12; round++) {
    const names = [`move-a-${round}`, `move-b-${round}`, `move-target-${round}`];
    await Promise.all([writeFile(path.join(root, names[0]), 'AAA'), writeFile(path.join(root, names[1]), 'BBB')]);
    const versions = await Promise.all(managers.map((manager, index) => manager.io.stat(ref(index, names[index]))));
    const outcomes = await Promise.allSettled(managers.map((manager, index) => manager.io.renameEntry({ source: ref(index, names[index]), destination: ref(index, names[2]), expectedVersion: versions[index].version, overwrite: false })));
    assert.deepEqual(await survivingContents(root, names), ['AAA', 'BBB'], 'the losing move must retain its source');
    assertExclusive(outcomes);
  }
});

test('competing directory stages cannot replace an already published empty directory', async t => {
  const { root, managers, ref } = await fixture(t);
  for (let round = 0; round < 12; round++) {
    const stages = await Promise.all(managers.map((manager, index) => manager.io.createStagedDirectory(ref(index, `directory-${round}`))));
    const original = await Promise.all(stages.map(stage => stat(path.join(root, stage.ref.path), { bigint: true })));
    const outcomes = await Promise.allSettled(stages.map(stage => stage.commit()));
    assertExclusive(outcomes);
    const lost = outcomes.findIndex(outcome => outcome.status === 'rejected');
    assert.equal((await stat(path.join(root, stages[lost].ref.path), { bigint: true })).ino, original[lost].ino);
    await stages[lost].abort();
  }
});

test('source cleanup waits for the final destination proof and preserves source on proof failure', async t => {
  const { root, managers: [manager], ref } = await fixture(t);
  await writeFile(path.join(root, 'file'), 'AAA');
  const selected = await manager.io.stat(ref(0, 'file'));
  await assert.rejects(manager.io.removeEntry({ ...selected, beforeRemove: async () => { throw Object.assign(new Error('destination disappeared'), { code: 'VERSION_CONFLICT' }); } }), { code: 'VERSION_CONFLICT' });
  assert.equal(await readFile(path.join(root, 'file'), 'utf8'), 'AAA');
});

test('source cleanup rechecks its source after an awaited destination proof', async t => {
  const { root, managers: [manager], ref } = await fixture(t);
  await writeFile(path.join(root, 'file'), 'AAA');
  const selected = await manager.io.stat(ref(0, 'file'));
  await assert.rejects(manager.io.removeEntry({ ...selected, beforeRemove: async () => { await writeFile(path.join(root, 'file'), 'changed source contents'); } }), { code: 'VERSION_CONFLICT' });
  assert.equal(await readFile(path.join(root, 'file'), 'utf8'), 'changed source contents');
});
