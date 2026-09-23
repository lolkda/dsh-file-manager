import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createManager } from '../dist/host/manager.js';

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'root-other');
  await mkdir(root);
  await mkdir(outside);
  const manager = createManager();
  assert.equal(typeof manager.addRoot, 'function', 'adding explicit root grants is not implemented');
  const grant = await manager.addRoot({ path: root });
  return { base, root, outside, manager, grant };
}

test('adding the same canonical directory twice reuses the grant', async t => {
  const { manager, root, grant } = await fixture(t);
  const again = await manager.addRoot({ path: `${root}/.` });
  assert.equal(again.id, grant.id);
  assert.equal((await manager.listRoots()).length, 1);
});

test('adding a relative path is rejected without creating a grant', async () => {
  const manager = createManager();
  assert.equal(typeof manager.addRoot, 'function', 'adding explicit root grants is not implemented');
  await assert.rejects(manager.addRoot({ path: './relative' }), { code: 'INVALID_PATH' });
  assert.deepEqual(await manager.listRoots(), []);
});

test('returned root metadata cannot mutate the server-side grant', async t => {
  const { manager, grant, root } = await fixture(t);
  grant.path = '/not-the-authorized-root';
  const roots = await manager.listRoots();
  assert.equal(roots[0].path, root);
});

test('listing sorts directories first and numbers naturally', async t => {
  const { manager, grant, root } = await fixture(t);
  await mkdir(path.join(root, 'folder'));
  await writeFile(path.join(root, 'file10.txt'), 'ten');
  await writeFile(path.join(root, 'file2.txt'), 'two');
  assert.equal(typeof manager.list, 'function', 'directory listing is not implemented');
  const listing = await manager.list({ rootId: grant.id, path: '' });
  assert.deepEqual(listing.entries.map(item => [item.name, item.kind]), [
    ['folder', 'directory'], ['file2.txt', 'file'], ['file10.txt', 'file'],
  ]);
});

test('directory pages expose the remaining entries rather than silently truncating them', async t => {
  const { manager, grant, root } = await fixture(t);
  for (const name of ['a', 'b', 'c']) await writeFile(path.join(root, name), name);
  assert.equal(typeof manager.list, 'function', 'directory pagination is not implemented');
  const first = await manager.list({ rootId: grant.id, path: '', limit: 2 });
  assert.equal(first.entries.length, 2);
  assert.ok(first.nextCursor);
  const second = await manager.list({ rootId: grant.id, path: '', limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.entries.map(item => item.name), ['c']);
  assert.equal(second.nextCursor, null);
});

test('text snapshots retain Unicode, line endings and a changing version', async t => {
  const { manager, grant, root } = await fixture(t);
  const filename = '中文 文件.txt';
  await writeFile(path.join(root, filename), '\ufeff你好\r\n');
  assert.equal(typeof manager.readText, 'function', 'versioned text snapshots are not implemented');
  const first = await manager.readText({ rootId: grant.id, path: filename });
  assert.equal(first.text, '你好\r\n');
  assert.equal(first.bom, true);
  assert.equal(first.newline, 'crlf');
  assert.ok(first.version);
  await writeFile(path.join(root, filename), '\ufeff世界\r\n');
  const next = await manager.readText({ rootId: grant.id, path: filename });
  assert.notEqual(next.version, first.version);
});

test('invalid UTF-8 is rejected rather than silently replacing bytes', async t => {
  const { manager, grant, root } = await fixture(t);
  await writeFile(path.join(root, 'binary'), Buffer.from([0xff, 0xfe, 0xfd]));
  assert.equal(typeof manager.readText, 'function', 'text decoding validation is not implemented');
  await assert.rejects(manager.readText({ rootId: grant.id, path: 'binary' }), { code: 'UNSUPPORTED_ENCODING' });
});

test('bounded text reads refuse files larger than the configured read limit', async t => {
  const { manager, grant, root } = await fixture(t);
  await writeFile(path.join(root, 'large.txt'), '123456');
  assert.equal(typeof manager.readText, 'function', 'bounded reads are not implemented');
  await assert.rejects(manager.readText({ rootId: grant.id, path: 'large.txt', maxBytes: 4 }), { code: 'TOO_LARGE' });
});

test('absolute paths and parent traversal cannot escape an explicit root', async t => {
  const { manager, grant, outside } = await fixture(t);
  await writeFile(path.join(outside, 'private.txt'), 'outside');
  assert.equal(typeof manager.readText, 'function', 'root-scoped reads are not implemented');
  for (const candidate of ['../root-other/private.txt', path.join(outside, 'private.txt'), '..\\root-other\\private.txt']) {
    await assert.rejects(manager.readText({ rootId: grant.id, path: candidate }), { code: 'INVALID_PATH' });
  }
});

test('file reads do not follow directory or leaf symlinks outside a grant', async t => {
  const { manager, grant, root, outside } = await fixture(t);
  await writeFile(path.join(outside, 'private.txt'), 'outside');
  await symlink(outside, path.join(root, 'linked-dir'));
  await symlink(path.join(outside, 'private.txt'), path.join(root, 'linked-file'));
  assert.equal(typeof manager.readText, 'function', 'no-follow reads are not implemented');
  await assert.rejects(manager.readText({ rootId: grant.id, path: 'linked-dir/private.txt' }), { code: 'UNSUPPORTED_ENTRY' });
  await assert.rejects(manager.readText({ rootId: grant.id, path: 'linked-file' }), { code: 'UNSUPPORTED_ENTRY' });
});

test('a replacement directory at the old root path does not inherit the grant', async t => {
  const { manager, grant, base, root } = await fixture(t);
  await rename(root, path.join(base, 'old-root'));
  await mkdir(root);
  await writeFile(path.join(root, 'new.txt'), 'not granted');
  assert.equal(typeof manager.list, 'function', 'root identity verification is not implemented');
  await assert.rejects(manager.list({ rootId: grant.id, path: '' }), { code: 'ROOT_CHANGED' });
});

test('internal directory leases hold safe descriptors and reject a replaced root', async t => {
  const { manager, grant, root, base } = await fixture(t);
  await writeFile(path.join(root, 'bytes'), Buffer.from([0, 255, 17]));
  assert.equal(typeof manager.io?.acquireDirectory, 'function', 'safe internal directory leases are missing');
  const lease = await manager.io.acquireDirectory({ rootId: grant.id, path: '' });
  try {
    assert.match(lease.address, /^\/proc\/self\/fd\/\d+$/);
    assert.equal((await lease.entries())[0].path, 'bytes');
    await rename(root, path.join(base, 'old-root'));
    await mkdir(root);
    await assert.rejects(lease.verify(), { code: 'ROOT_CHANGED' });
    await assert.rejects(lease.entries(), { code: 'ROOT_CHANGED' });
  } finally { await lease.close(); }
});

test('raw reads preserve binary bytes and verify the named source after streaming', async t => {
  const { manager, grant, root } = await fixture(t);
  const bytes = Buffer.from([0, 255, 17]);
  await writeFile(path.join(root, 'bytes'), bytes);
  assert.equal(typeof manager.io?.openRead, 'function', 'safe raw streams are missing');
  const ref = { rootId: grant.id, path: 'bytes' };
  const entry = await manager.io.stat(ref);
  const source = await manager.io.openRead({ ...ref, expectedVersion: entry.version });
  try {
    const chunks = [];
    for await (const chunk of source.stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes);
    await source.verify();
    await writeFile(path.join(root, 'replacement'), bytes);
    await rename(path.join(root, 'replacement'), path.join(root, 'bytes'));
    await assert.rejects(source.verify(), { code: 'VERSION_CONFLICT' });
  } finally { await source.close(); }
});

test('raw I/O refuses leaf links and linked ancestors', async t => {
  const { manager, grant, root, outside } = await fixture(t);
  await writeFile(path.join(outside, 'bytes'), 'outside');
  await symlink(outside, path.join(root, 'linked'));
  await symlink(path.join(outside, 'bytes'), path.join(root, 'leaf'));
  assert.equal(typeof manager.io?.openRead, 'function', 'safe raw streams are missing');
  for (const relative of ['leaf', 'linked/bytes']) {
    await assert.rejects(manager.io.openRead({ rootId: grant.id, path: relative }), { code: 'UNSUPPORTED_ENTRY' });
  }
  await assert.rejects(manager.io.createStagedFile({ rootId: grant.id, path: '../outside/bytes' }), { code: 'INVALID_PATH' });
});

test('staged binary writes publish complete data with the requested ordinary mode', async t => {
  const { manager, grant, root } = await fixture(t);
  assert.equal(typeof manager.io?.createStagedFile, 'function', 'safe staging writes are missing');
  const ref = { rootId: grant.id, path: 'binary' };
  const stage = await manager.io.createStagedFile({ ...ref, mode: 0o750 });
  try {
    await stage.write(Buffer.from([0, 255]));
    await stage.write(Buffer.from([17]));
    await assert.rejects(stat(path.join(root, 'binary')), { code: 'ENOENT' });
    const receipt = await stage.commit({ bytes: 3 });
    assert.equal(receipt.kind, 'file');
    assert.equal(receipt.bytes, 3);
    assert.match(receipt.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(await readFile(path.join(root, 'binary')), Buffer.from([0, 255, 17]));
    assert.equal((await stat(path.join(root, 'binary'))).mode & 0o777, 0o750);
  } finally { await stage.abort(); }
  assert.deepEqual(await readdir(root), ['binary']);
});

test('staged writes reject stale overwrite versions without publishing or leaking staging', async t => {
  const { manager, grant, root } = await fixture(t);
  await writeFile(path.join(root, 'file'), 'old');
  assert.equal(typeof manager.io?.createStagedFile, 'function', 'safe staging writes are missing');
  const ref = { rootId: grant.id, path: 'file' };
  const target = await manager.io.stat(ref);
  const stage = await manager.io.createStagedFile({ ...ref, overwrite: true, expectedVersion: target.version });
  try {
    await stage.write(Buffer.from('draft'));
    await writeFile(path.join(root, 'file'), 'external');
    await assert.rejects(stage.commit(), { code: 'VERSION_CONFLICT' });
  } finally { await stage.abort(); }
  assert.equal(await readFile(path.join(root, 'file'), 'utf8'), 'external');
  assert.deepEqual(await readdir(root), ['file']);
});

test('stream publication refuses revoked grants and cleans its held-parent staging', async t => {
  const { manager, grant, root } = await fixture(t);
  assert.equal(typeof manager.io?.createStagedFile, 'function', 'safe staging writes are missing');
  const stage = await manager.io.createStagedFile({ rootId: grant.id, path: 'file' });
  await stage.write(Buffer.from('draft'));
  await manager.removeRoot({ rootId: grant.id });
  await assert.rejects(stage.commit(), { code: 'ROOT_NOT_FOUND' });
  await stage.abort();
  assert.deepEqual(await readdir(root), []);
});

test('content validation happens before staged bytes become visible', async t => {
  const { manager, grant, root } = await fixture(t);
  assert.equal(typeof manager.io?.createStagedFile, 'function', 'safe staging writes are missing');
  const stage = await manager.io.createStagedFile({ rootId: grant.id, path: 'file' });
  await stage.write(Buffer.from('draft'));
  await assert.rejects(stage.commit({ sha256: '0'.repeat(64) }), { code: 'CHECKSUM_MISMATCH' });
  await stage.abort();
  assert.deepEqual(await readdir(root), []);
});

test('staged directories publish nested contents without implicitly merging', async t => {
  const { manager, grant, root } = await fixture(t);
  assert.equal(typeof manager.io?.createStagedDirectory, 'function', 'safe directory staging is missing');
  const stage = await manager.io.createStagedDirectory({ rootId: grant.id, path: 'folder' });
  await manager.io.createDirectory({ ...stage.ref, path: `${stage.ref.path}/empty` });
  const file = await manager.io.createStagedFile({ ...stage.ref, path: `${stage.ref.path}/file` });
  await file.write(Buffer.from('data'));
  await file.commit();
  await file.abort();
  assert.equal((await stage.commit()).path, 'folder');
  await stage.abort();
  assert.equal(await readFile(path.join(root, 'folder/file'), 'utf8'), 'data');
  assert.deepEqual(await readdir(path.join(root, 'folder/empty')), []);
  const conflict = await manager.io.createStagedDirectory({ rootId: grant.id, path: 'folder' });
  await assert.rejects(conflict.commit(), { code: 'ALREADY_EXISTS' });
  await conflict.abort();
  assert.deepEqual(await readdir(root), ['folder']);
});

test('a failed read-only directory publication still removes its owned staging subtree', async t => {
  const { manager, grant, root } = await fixture(t);
  const stage = await manager.io.createStagedDirectory({ rootId: grant.id, path: 'folder', mode: 0o500 });
  const file = await manager.io.createStagedFile({ ...stage.ref, path: `${stage.ref.path}/file` });
  await file.write(Buffer.from('staged')); await file.commit(); await file.abort();
  await mkdir(path.join(root, 'folder'));
  await assert.rejects(stage.commit(), { code: 'ALREADY_EXISTS' });
  await stage.abort();
  assert.deepEqual(await readdir(root), ['folder']);
  assert.deepEqual(await readdir(path.join(root, 'folder')), []);
});

test('aborting an owned tree also cleans a nested directory with no permission bits', async t => {
  const { manager, grant, root } = await fixture(t);
  const stage = await manager.io.createStagedDirectory({ rootId: grant.id, path: 'folder' });
  const nested = await manager.io.createStagedDirectory({ ...stage.ref, path: `${stage.ref.path}/sealed`, mode: 0 });
  await nested.commit(); await nested.abort();
  await mkdir(path.join(root, 'folder'));
  await assert.rejects(stage.commit(), { code: 'ALREADY_EXISTS' });
  await stage.abort();
  assert.deepEqual(await readdir(root), ['folder']);
});

test('explicit file stat and binary publication return content-bound versions', async t => {
  const { manager, grant, root } = await fixture(t);
  await writeFile(path.join(root, 'file'), 'content');
  const ref = { rootId: grant.id, path: 'file' };
  const digest = createHash('sha256').update('content').digest('hex');
  assert.ok((await manager.io.stat(ref)).version.endsWith(`:${digest}`));
  assert.equal((await manager.stat(ref)).version, (await manager.readText(ref)).version);
  const stage = await manager.io.createStagedFile({ rootId: grant.id, path: 'copy' });
  await stage.write(Buffer.from('content'));
  const receipt = await stage.commit();
  assert.ok(receipt.version.endsWith(`:${digest}`));
  await stage.abort();
});

test('weak metadata versions cannot authorize overwriting a file', async t => {
  const { manager, grant, root } = await fixture(t);
  await writeFile(path.join(root, 'file'), 'original');
  const weakVersion = (await manager.list({ rootId: grant.id, path: '' })).entries[0].version;
  let stage;
  try {
    await assert.rejects(async () => { stage = await manager.io.createStagedFile({ rootId: grant.id, path: 'file', overwrite: true, expectedVersion: weakVersion }); }, { code: 'STRONG_VERSION_REQUIRED' });
  } finally { await stage?.abort(); }
  assert.equal(await readFile(path.join(root, 'file'), 'utf8'), 'original');
});

test('strong stat refuses oversized or cancelled hashing before exposing a version', async t => {
  const { manager, grant, root } = await fixture(t);
  await writeFile(path.join(root, 'file'), '123456');
  const ref = { rootId: grant.id, path: 'file' };
  await assert.rejects(manager.io.stat({ ...ref, maxBytes: 5 }), { code: 'TOO_LARGE' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(manager.io.stat({ ...ref, signal: controller.signal }), { code: 'CANCELLED' });
});

test('source cleanup compares the actual copied digest rather than trusting metadata alone', async t => {
  const { manager, grant, root } = await fixture(t);
  await writeFile(path.join(root, 'file'), 'updated');
  const entry = await manager.io.stat({ rootId: grant.id, path: 'file' });
  // Supplying matching current metadata cannot authorize deleting bytes absent from the published copy.
  await assert.rejects(manager.io.removeEntry({ ...entry, sha256: createHash('sha256').update('copied!').digest('hex') }), { code: 'VERSION_CONFLICT' });
  assert.equal(await readFile(path.join(root, 'file'), 'utf8'), 'updated');
});

test('manager shutdown aborts uncommitted staging before resolving', async t => {
  const { manager, grant, root } = await fixture(t);
  assert.equal(typeof manager.io?.createStagedFile, 'function', 'safe staging writes are missing');
  const stage = await manager.io.createStagedFile({ rootId: grant.id, path: 'file' });
  await stage.write(Buffer.from('draft'));
  await manager.close();
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(stage.commit(), { code: 'SERVICE_STOPPED' });
});

test('removing a root revokes access but leaves its files on disk', async t => {
  const { manager, grant, root } = await fixture(t);
  await writeFile(path.join(root, 'keep.txt'), 'keep');
  assert.equal(typeof manager.removeRoot, 'function', 'root revocation is not implemented');
  await manager.removeRoot({ rootId: grant.id });
  assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'keep');
  assert.deepEqual(await manager.listRoots(), []);
  await assert.rejects(manager.list({ rootId: grant.id, path: '' }), { code: 'ROOT_NOT_FOUND' });
});
