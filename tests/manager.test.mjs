import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
  const manager = createManager({ rootPath: root });
  const grant = manager.getRoot();
  return { base, root, outside, manager, grant };
}

async function directoryIdentity(target) {
  const found = await stat(target, { bigint: true });
  return `${found.dev}:${found.ino}`;
}

test('the single browsing root is opened once with its canonical path, identity and label', async t => {
  const { manager, grant, root } = await fixture(t);
  assert.equal(typeof manager.getRoot, 'function', 'the fixed browsing root is not implemented');
  assert.equal(grant.path, root);
  assert.equal(grant.path, await realpath(root), 'the reported path is the canonical one');
  assert.equal(grant.identity, await directoryIdentity(root));
  assert.equal(grant.label, path.basename(root));
  assert.equal(typeof grant.id, 'string');
  assert.ok(grant.id.length > 0, 'the root carries a non-empty id');
  assert.deepEqual(Object.keys(grant).sort(), ['id', 'identity', 'label', 'path'],
    'the descriptor is exactly the frozen four fields');
});

test('the root id is bound to the canonical path identity, not to a construction order', async t => {
  const { grant, root, base } = await fixture(t);
  const other = path.join(base, 'other');
  await mkdir(other);
  const second = createManager({ rootPath: root });
  const third = createManager({ rootPath: other });
  t.after(async () => { await second.close(); await third.close(); });
  // Same directory, same identity: a restart observes the same id with no stored
  // grant at all, and a different directory never borrows it.
  assert.equal(typeof grant.id, 'string');
  assert.equal(second.getRoot().id, grant.id, 'the same directory keeps its id across managers');
  assert.notEqual(third.getRoot().id, grant.id, 'a different directory gets a different id');
  assert.notEqual(third.getRoot().identity, grant.identity);
});

test('returned root metadata is a copy and cannot mutate the server-side root', async t => {
  const { manager, root } = await fixture(t);
  const observed = manager.getRoot();
  const authorizedId = observed.id;
  observed.path = '/not-the-authorized-root';
  observed.id = 'forged';
  const current = manager.getRoot();
  assert.equal(current.path, root, 'mutating a returned descriptor must not move the root');
  assert.equal(current.id, authorizedId, 'mutating a returned descriptor must not re-bind its id');
  assert.notEqual(current, observed, 'each call returns a fresh copy');
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

test('a replacement directory at the root path is refused instead of adopting a new identity', async t => {
  const { manager, grant, base, root } = await fixture(t);
  await rename(root, path.join(base, 'old-root'));
  await mkdir(root);
  await writeFile(path.join(root, 'new.txt'), 'not the opened root');
  assert.equal(typeof manager.list, 'function', 'root identity verification is not implemented');
  await assert.rejects(manager.list({ rootId: grant.id, path: '' }), { code: 'ROOT_CHANGED' });
  // The descriptor keeps the identity it opened with: a replacement directory is
  // never silently re-bound, and no new id appears for the same spelling.
  assert.equal(manager.getRoot().id, grant.id);
  assert.equal(manager.getRoot().identity, await directoryIdentity(path.join(base, 'old-root')));
  assert.notEqual(manager.getRoot().identity, await directoryIdentity(root));
  await assert.rejects(manager.readText({ rootId: grant.id, path: 'new.txt' }), { code: 'ROOT_CHANGED' });
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

test('stream publication into a replaced root is refused and cleans its held-parent staging', async t => {
  const { manager, grant, root, base } = await fixture(t);
  assert.equal(typeof manager.io?.createStagedFile, 'function', 'safe staging writes are missing');
  const stage = await manager.io.createStagedFile({ rootId: grant.id, path: 'file' });
  await stage.write(Buffer.from('draft'));
  await rename(root, path.join(base, 'old-root'));
  await mkdir(root);
  await assert.rejects(stage.commit(), { code: 'ROOT_CHANGED' });
  await stage.abort();
  assert.deepEqual(await readdir(root), [], 'a replaced root must never receive staged bytes');
  assert.deepEqual(await readdir(path.join(base, 'old-root')), [], 'its owned staging file must still be cleaned up');
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

test('the fixed root is the only one, and root management is gone', async t => {
  const { manager, grant, root } = await fixture(t);
  await writeFile(path.join(root, 'keep.txt'), 'keep');
  for (const removed of ['addRoot', 'removeRoot', 'listRoots', 'reauthorizeRoot', 'rootStatuses']) {
    assert.equal(manager[removed], undefined, `${removed} must not exist: directory locations were removed`);
  }
  assert.deepEqual(manager.getRoot(), grant, 'the only root stays the one opened at construction');
  assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'keep');
});

/* ------------------------------------------------------------------ *
 * One immutable root
 *
 * The browsing boundary is decided once, at construction, and is never adopted
 * from stored state. A container rebuild that changes the directory's `dev:ino`
 * must be refused rather than silently re-bound, and an id minted by another
 * process (or another directory) must never address the current root.
 * ------------------------------------------------------------------ */

test('an id from another process or another directory is refused and never re-bound', async t => {
  const { manager, grant, root, outside } = await fixture(t);
  await writeFile(path.join(root, 'file.txt'), 'content');
  const other = createManager({ rootPath: outside });
  t.after(() => other.close());
  const foreign = [
    'root-1', grant.id.slice(0, 8), `${grant.id} `, other.getRoot().id,
    createHash('sha256').update(`${root}\u0000stale-identity`).digest('hex').slice(0, 32),
  ];
  for (const rootId of foreign) {
    await assert.rejects(manager.list({ rootId, path: '' }), { code: 'ROOT_NOT_FOUND', status: 404 }, String(rootId));
    await assert.rejects(manager.readText({ rootId, path: 'file.txt' }), { code: 'ROOT_NOT_FOUND', status: 404 });
    await assert.rejects(manager.io.stat({ rootId, path: 'file.txt' }), { code: 'ROOT_NOT_FOUND', status: 404 });
    await assert.rejects(manager.io.createStagedFile({ rootId, path: 'new.txt' }), { code: 'ROOT_NOT_FOUND', status: 404 });
  }
  assert.equal(manager.getRoot().id, grant.id, 'a refused id must not move the fixed root');
  assert.deepEqual(await readdir(root), ['file.txt'], 'a refused id must not create anything');
});

test('a root that changes identity is refused by every entry point, including held handles', async t => {
  const { manager, grant, root, base } = await fixture(t);
  await writeFile(path.join(root, 'bytes'), 'bytes');
  const version = (await manager.io.stat({ rootId: grant.id, path: 'bytes' })).version;
  const lease = await manager.io.acquireDirectory({ rootId: grant.id, path: '' });
  await rename(root, path.join(base, 'old-root'));
  await mkdir(root);
  try {
    await assert.rejects(lease.verify(), { code: 'ROOT_CHANGED', status: 409 });
    await assert.rejects(lease.entries(), { code: 'ROOT_CHANGED', status: 409 });
  } finally { await lease.close(); }
  await assert.rejects(manager.list({ rootId: grant.id, path: '' }), { code: 'ROOT_CHANGED', status: 409 });
  await assert.rejects(manager.io.stat({ rootId: grant.id, path: 'bytes' }), { code: 'ROOT_CHANGED', status: 409 });
  await assert.rejects(manager.stat({ rootId: grant.id, path: 'bytes' }), { code: 'ROOT_CHANGED', status: 409 });
  await assert.rejects(manager.readText({ rootId: grant.id, path: 'bytes' }), { code: 'ROOT_CHANGED', status: 409 });
  await assert.rejects(manager.createFile({ rootId: grant.id, path: 'new.txt' }), { code: 'ROOT_CHANGED', status: 409 });
  await assert.rejects(manager.createDirectory({ rootId: grant.id, path: 'new-dir' }), { code: 'ROOT_CHANGED', status: 409 });
  await assert.rejects(manager.rename({ rootId: grant.id, path: 'bytes', name: 'renamed', expectedVersion: version }), { code: 'ROOT_CHANGED', status: 409 });
  assert.deepEqual(await readdir(root), [], 'the replacement directory must receive nothing');
  assert.deepEqual(await readdir(path.join(base, 'old-root')), ['bytes'], 'and the original tree is left untouched');
});

test('a root that disappears is reported as unavailable, never reopened silently', async t => {
  const { manager, grant, root } = await fixture(t);
  await rm(root, { recursive: true });
  await assert.rejects(manager.list({ rootId: grant.id, path: '' }), { code: 'ROOT_UNAVAILABLE', status: 409 });
  await assert.rejects(manager.readText({ rootId: grant.id, path: 'file.txt' }), { code: 'ROOT_UNAVAILABLE', status: 409 });
  assert.equal(manager.getRoot().identity, grant.identity, 'the descriptor keeps the identity it opened with');
});

test('a root that cannot be opened fails construction synchronously', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-open-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = path.join(base, 'file');
  await writeFile(file, 'not a directory');
  const real = path.join(base, 'real');
  await mkdir(path.join(real, 'nested'), { recursive: true });
  const link = path.join(base, 'link');
  await symlink(real, link);
  for (const rootPath of ['relative/path', '', ' ', 42, '/tmp/\u0000bad', '/tmp/bad\nname']) {
    assert.throws(() => createManager({ rootPath }), { code: 'INVALID_STATE', status: 500 }, JSON.stringify(rootPath));
  }
  for (const rootPath of [path.join(base, 'missing'), file, link]) {
    assert.throws(() => createManager({ rootPath }), { code: 'ROOT_UNAVAILABLE', status: 500 }, rootPath);
  }
  // The refusal carries the OS cause, so a Host can explain the degradation.
  const causeOf = rootPath => {
    try { createManager({ rootPath }); } catch (error) { return error.details?.cause; }
    return assert.fail(`${rootPath} must not construct a manager`);
  };
  assert.equal(causeOf(path.join(base, 'missing')), 'ENOENT');
  assert.equal(causeOf(file), 'ENOTDIR');
  // O_NOFOLLOW makes a symlinked leaf fail as a non-directory, not as a loop.
  assert.equal(causeOf(link), 'ENOTDIR');
  // A symlinked *ancestor* is followed, and the reported path is the canonical one.
  const through = createManager({ rootPath: path.join(link, 'nested') });
  t.after(() => through.close());
  assert.equal(through.getRoot().path, await realpath(path.join(real, 'nested')));
});

test('the default root is the process filesystem root, addressed without a trailing slash', async t => {
  const manager = createManager();
  t.after(() => manager.close());
  const root = manager.getRoot();
  assert.equal(root.path, '/');
  assert.equal(root.label, '/');
  assert.match(root.identity, /^\d+:\d+$/);
  assert.equal(root.id, createHash('sha256').update(`${root.path}\u0000${root.identity}`).digest('hex').slice(0, 32),
    'the id is the canonical path and the observed identity, so the same directory restarts with the same id');
});

test('a closed manager refuses root addressing before it can report an unknown root', async t => {
  const { manager, grant } = await fixture(t);
  await manager.close();
  assert.throws(() => manager.getRoot(), { code: 'SERVICE_STOPPED', status: 503 });
  await assert.rejects(manager.list({ rootId: grant.id, path: '' }), { code: 'SERVICE_STOPPED', status: 503 });
  await assert.rejects(manager.list({ rootId: 'unknown', path: '' }), { code: 'SERVICE_STOPPED', status: 503 });
});
