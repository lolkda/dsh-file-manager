import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createManager } from '../host/manager.js';

async function save(t, before, draft) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-eol-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'file'), before);
  const manager = createManager();
  const grant = await manager.addRoot({ path: root });
  const ref = { rootId: grant.id, path: 'file' };
  const opened = await manager.readText(ref);
  const receipt = await manager.saveText({ ...ref, text: draft, expectedVersion: opened.version });
  return { opened, receipt, contents: await readFile(path.join(root, 'file'), 'utf8') };
}

test('legacy CR files retain their line endings after textarea edits', async t => {
  const result = await save(t, 'first\rsecond\r', 'edited\nsecond\n');
  assert.equal(result.opened.newline, 'cr');
  assert.equal(result.contents, 'edited\rsecond\r');
});

test('mixed line endings are preserved when one line is edited', async t => {
  const result = await save(t, 'one\r\ntwo\nthree\rfour', 'one\ntwo changed\nthree\nfour');
  assert.equal(result.opened.newline, 'mixed');
  assert.equal(result.contents, 'one\r\ntwo changed\nthree\rfour');
});

test('an inserted line uses nearby style without normalizing existing mixed endings', async t => {
  const result = await save(t, 'a\r\nb\nc', 'a\ninserted\nb\nc');
  assert.equal(result.contents, 'a\r\ninserted\r\nb\nc');
});

test('removing a line preserves the endings of surviving mixed-style lines', async t => {
  const result = await save(t, 'a\r\nb\nc\rd\n', 'a\nc\nd\n');
  assert.equal(result.contents, 'a\r\nc\rd\n');
});

test('adding a final newline follows the existing file style', async t => {
  const result = await save(t, 'a\r\nb', 'a\nb\n');
  assert.equal(result.contents, 'a\r\nb\r\n');
});

test('saving normalized textarea text does not normalize an unchanged mixed file', async t => {
  const before = '\ufeffa\r\nb\nc\r';
  const result = await save(t, before, 'a\nb\nc\n');
  assert.equal(result.contents, before);
});
