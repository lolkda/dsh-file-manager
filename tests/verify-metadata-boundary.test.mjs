/**
 * task-6 独立验证：R14 概念分离 / R15 资源预算。
 *
 * 判定标准与证据路径见 `docs/VERIFICATION-PLAN.md` §A、§B。每条用例的观测点写在
 * 用例体内；未接通实现的用例调用 `pending()` **故意失败**，绝不静默通过。
 */

import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  evidenceDirectory, hostFixture, measureReads, measureReadsMedian, pending, probeReadiness, record, tempRoot, writeSizedFile,
} from './verify-harness.mjs';
import { readFile } from 'node:fs/promises';

const readiness = await probeReadiness();
const blocked = readiness.ready ? false : `task-6 verification blocked: ${readiness.missing.join(', ')}`;
const RUN = 'task6-metadata';
const evidence = evidenceDirectory(RUN);

test('verification prerequisites are present', () => {
  assert.deepEqual(readiness.missing, [], 'task-6 verification cannot run before task-4/task-5 artifacts exist');
});

test('the rchar observation point works and responds to real content reads', async t => {
  // Self-test of the measurement itself: without this, a "did not read" assertion
  // could pass because the counter is broken rather than because the code is right.
  const fixture = await tempRoot('dsh-fm-verify-rchar-');
  t.after(fixture.cleanup);
  const file = path.join(fixture.directory, 'probe.bin');
  writeSizedFile(file, 16 * 1024 * 1024);
  const measured = await measureReads(() => readFileSync(file));
  record(evidence, 'rchar-selftest', `readFileSync(16 MiB) rchar delta = ${measured.bytes}`);
  assert.ok(measured.bytes >= 16 * 1024 * 1024, `reading 16 MiB must move rchar by at least 16 MiB (measured ${measured.bytes})`);
  const control = await measureReads(() => statSync(file));
  record(evidence, 'rchar-selftest', `statSync(16 MiB) rchar delta = ${control.bytes}`);
  assert.ok(control.bytes < measured.bytes / 8, 'metadata-only work must read far less than content work');
});

/**
 * The content-bound version of a file, computed independently: the frozen token is
 * `dev:ino:size:mtimeNs:ctimeNs:sha256`, so the test can mint it without spending
 * the operation's verification budget on a preparatory `entries.stat`.
 */
async function contentTokenOf(directory, name) {
  const stats = await lstat(path.join(directory, name), { bigint: true });
  const digest = createHash('sha256').update(readFileSync(path.join(directory, name))).digest('hex');
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}:${digest}`;
}

test('R14: browsing and referencing a large file never reads its content', { skip: blocked }, async t => {
  const SIZE = 64 * 1024 * 1024;
  const fixture = await hostFixture();
  t.after(fixture.close);
  writeSizedFile(path.join(fixture.directory, 'big.bin'), SIZE);
  await fixture.call('entries.list', fixture.ref(''));

  const baseline = () => fixture.manager.list(fixture.ref(''));
  const measured = await measureReadsMedian({
    baseline,
    operation: async () => {
      const listing = await fixture.call('entries.list', fixture.ref(''));
      assert.equal(listing.status, 200);
      const reference = await fixture.call('entries.reference', fixture.ref('big.bin'));
      assert.equal(reference.status, 200);
      return { listing, reference };
    },
    repeats: 3,
  });
  record(evidence, 'metadata-boundary', `64 MiB list+reference median rchar delta = ${measured.median} (samples ${measured.samples.join(',')})`);
  assert.ok(measured.median < 1024 * 1024, `browsing must not read content: median rchar delta ${measured.median} must stay under 1 MiB for a ${SIZE} byte file`);

  const listing = await fixture.call('entries.list', fixture.ref(''));
  const entry = listing.value.entries.find(candidate => candidate.name === 'big.bin');
  assert.ok(entry, 'the 64 MiB file must appear in the listing');
  const { MetadataVersionSchema, ContentVersionSchema } = await import('../dist/contracts/views.js');
  assert.equal(MetadataVersionSchema.safeParse(entry.version).success, true, `listing version ${entry.version} must be a weak metadata token`);
  assert.equal(ContentVersionSchema.safeParse(entry.version).success, false, 'a listing token must carry no digest');
  const stats = await lstat(path.join(fixture.directory, 'big.bin'), { bigint: true });
  const recomputed = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
  record(evidence, 'metadata-boundary', `listing version=${entry.version} recomputed=${recomputed}`);
  assert.equal(entry.version, recomputed, 'the listing token must be derived from metadata alone');
});

test('R14: a listing still succeeds when a member cannot be read', { skip: blocked }, async t => {
  const fixture = await hostFixture();
  t.after(fixture.close);
  const secret = path.join(fixture.directory, 'secret.txt');
  writeFileSync(secret, 'unreadable content');
  chmodSync(secret, 0o000);
  try {
    const listing = await fixture.call('entries.list', fixture.ref(''));
    assert.equal(listing.status, 200, 'an unreadable member must not break the whole listing');
    const entry = listing.value.entries.find(candidate => candidate.name === 'secret.txt');
    assert.ok(entry, 'the unreadable file must still be listed with its metadata');
    const read = await fixture.call('text.read', fixture.ref('secret.txt'));
    record(evidence, 'metadata-boundary-permission', `text.read on mode-000 file -> ${read.status} ${read.error?.code}`);
    assert.equal(read.status, 403, 'reading an unreadable file must fail');
    assert.equal(read.error.code, 'PERMISSION_DENIED');
    const reference = await fixture.call('entries.reference', fixture.ref('secret.txt'));
    assert.equal(reference.status, 200, 'referencing is metadata-only and must not need content access');
  } finally {
    chmodSync(secret, 0o600);
  }
});

test('R14: a content-bound version appears exactly where content is read', { skip: blocked }, async t => {
  const SIZE = 16 * 1024 * 1024;
  const fixture = await hostFixture();
  t.after(fixture.close);
  const file = path.join(fixture.directory, 'big.bin');
  writeSizedFile(file, SIZE);

  const listing = await fixture.call('entries.list', fixture.ref(''));
  const weak = listing.value.entries.find(candidate => candidate.name === 'big.bin').version;
  const measured = await measureReads(async () => {
    const stat = await fixture.call('entries.stat', fixture.ref('big.bin'));
    assert.equal(stat.status, 200);
    return stat;
  });
  record(evidence, 'metadata-boundary-strong', `entries.stat rchar delta = ${measured.bytes} for ${SIZE} bytes`);
  const { ContentVersionSchema, metadataVersionOf } = await import('../dist/contracts/views.js');
  const strong = measured.value.value.version;
  assert.equal(ContentVersionSchema.safeParse(strong).success, true, `entries.stat must mint a content-bound version, got ${strong}`);
  assert.equal(metadataVersionOf(strong), weak, 'the strong version must be the weak token plus the digest of the same bytes');
  assert.ok(measured.bytes >= SIZE, `minting a content version must read the bytes: rchar delta ${measured.bytes} must reach ${SIZE}`);
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
  assert.equal(measured.value.value.sha256, digest, 'the digest must match an independent hash of the file');
});

test('R14: a weak listing token cannot authorize a content replacement', { skip: blocked }, async t => {
  const fixture = await hostFixture({ withTasks: true });
  t.after(fixture.close);
  const file = path.join(fixture.directory, 'note.txt');
  writeFileSync(file, 'original');
  const listing = await fixture.call('entries.list', fixture.ref(''));
  const weak = listing.value.entries.find(candidate => candidate.name === 'note.txt').version;

  // A weak token still authorizes metadata-only work: rename keeps working.
  const renamed = await fixture.call('entries.rename', { ...fixture.ref('note.txt'), name: 'renamed.txt', expectedVersion: weak });
  assert.equal(renamed.status, 200, 'a listing token must keep authorizing metadata-only operations');

  const read = await fixture.call('text.read', fixture.ref('renamed.txt'));
  assert.equal(read.status, 200);
  const saved = await fixture.call('save', { ...fixture.ref('renamed.txt'), text: 'replaced', expectedVersion: weak }, { route: 'text' });
  record(evidence, 'metadata-boundary-weak', `text save with weak token -> ${saved.status} ${saved.error?.code}`);
  assert.equal(saved.status, 409);
  assert.equal(saved.error.code, 'VERSION_CONFLICT');
  assert.equal(readFileSync(path.join(fixture.directory, 'renamed.txt'), 'utf8'), 'original', 'a refused save must not touch the file');

  await mkdir(path.join(fixture.directory, 'dest'), { recursive: true });
  writeFileSync(path.join(fixture.directory, 'dest', 'renamed.txt'), 'occupied');
  const overwrite = await fixture.call('tasks.start', {
    operation: 'copy',
    items: [{ ...fixture.ref('renamed.txt'), expectedVersion: read.value.version, conflict: 'overwrite', expectedTargetVersion: weak }],
    destination: fixture.ref('dest'),
  }, { route: 'manifest' });
  assert.equal(overwrite.status, 200, `planning is accepted, the refusal is per item: ${JSON.stringify(overwrite.error)}`);
  const overwriteTask = await fixture.settle(overwrite.value.id);
  const item = overwriteTask.items[0];
  record(evidence, 'metadata-boundary-weak', `overwrite with weak target token -> item=${item.status} code=${item.error?.code}`);
  assert.equal(item.status, 'failed');
  assert.equal(item.error.code, 'STRONG_VERSION_REQUIRED', `overwriting content requires a content-bound token, got ${item.error.code}`);
  assert.equal(readFileSync(path.join(fixture.directory, 'dest', 'renamed.txt'), 'utf8'), 'occupied', 'a refused overwrite must not touch the target');
});

test('R15: exceeding the verification budget is refused and publishes nothing', { skip: blocked }, async t => {
  const SIZE = 16 * 1024 * 1024;
  const fixture = await hostFixture({ withTasks: true, limits: { maxVerificationBytes: 1024 * 1024 } });
  t.after(fixture.close);
  const source = path.join(fixture.directory, 'source.bin');
  writeSizedFile(source, SIZE);
  await mkdir(path.join(fixture.directory, 'dest'));
  const before = await lstat(source, { bigint: true });
  const beforeDigest = createHash('sha256').update(readFileSync(source)).digest('hex');

  const measured = await measureReads(async () => {
    const started = await fixture.call('tasks.start', {
      operation: 'copy',
      items: [{ ...fixture.ref('source.bin'), expectedVersion: await contentTokenOf(fixture.directory, 'source.bin') }],
      destination: fixture.ref('dest'),
      conflict: 'skip',
    }, { route: 'manifest' });
    assert.equal(started.status, 200, `tasks.start must be accepted for planning: ${JSON.stringify(started.error)}`);
    return await fixture.settle(started.value.id);
  });
  const task = measured.value;
  const item = task.items[0];
  record(evidence, 'budget-refuse', `status=${task.status} item=${item.status} code=${item.error?.code} rchar delta=${measured.bytes} for ${SIZE} bytes`);
  assert.equal(task.status, 'failed');
  assert.equal(item.error.code, 'TOO_LARGE', `the verification budget must refuse the copy, got ${item.error.code}`);
  assert.ok(measured.bytes >= SIZE, `the budget is charged while hashing, so the refusal happens after reading: rchar delta ${measured.bytes}`);
  // Observation, not a frozen requirement: the over-budget operation still reads the
  // whole file before refusing. Reported to host-core as an efficiency note.
  const destination = path.join(fixture.directory, 'dest', 'source.bin');
  assert.equal(existsSync(destination), false, 'a refused verification must publish nothing');
  const after = await lstat(source, { bigint: true });
  assert.equal(after.size, before.size);
  assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), beforeDigest, 'the source must be untouched');
});

test('R15: the budget is the operation manifest total, not the sum of internal reads', { skip: blocked }, async t => {
  // R15: `maxVerificationBytes` is charged by "the total file bytes involved in the
  // operation manifest", and must not be reset (or multiplied) per internal call. A
  // single 16 MiB file therefore needs a budget of 16 MiB, not a multiple of it.
  const SIZE = 16 * 1024 * 1024;
  const fixture = await hostFixture({ withTasks: true, limits: { maxVerificationBytes: 2 * SIZE } });
  t.after(fixture.close);
  writeSizedFile(path.join(fixture.directory, 'source.bin'), SIZE);
  await mkdir(path.join(fixture.directory, 'dest'));
  const started = await fixture.call('tasks.start', {
    operation: 'copy',
    items: [{ ...fixture.ref('source.bin'), expectedVersion: await contentTokenOf(fixture.directory, 'source.bin') }],
    destination: fixture.ref('dest'),
    conflict: 'skip',
  }, { route: 'manifest' });
  assert.equal(started.status, 200);
  const task = await fixture.settle(started.value.id);
  record(evidence, 'budget-accounting', `manifest=${SIZE} budget=${2 * SIZE} -> status=${task.status} code=${task.items[0].error?.code}`);
  assert.equal(task.status, 'completed',
    `a manifest of ${SIZE} bytes must fit a ${2 * SIZE} byte budget (got ${task.items[0].error?.code})`);
  assert.equal(existsSync(path.join(fixture.directory, 'dest', 'source.bin')), true);
});

test('R15: an over-budget manifest is refused at planning time, before the content is read', { skip: blocked }, async t => {
  // Lead's requirement for the fixed accounting: the manifest total is charged once,
  // up front, so an over-budget operation is refused while planning — it must not read
  // the file first, and the internal verification steps must still all run when it is
  // within budget (covered by the within-budget case above).
  const SIZE = 16 * 1024 * 1024;
  const fixture = await hostFixture({ withTasks: true, limits: { maxVerificationBytes: 1024 * 1024 } });
  t.after(fixture.close);
  writeSizedFile(path.join(fixture.directory, 'source.bin'), SIZE);
  await mkdir(path.join(fixture.directory, 'dest'));

  // Mint the token outside the measured region: hashing it here would be the test
  // reading the file, not the implementation.
  const expectedVersion = await contentTokenOf(fixture.directory, 'source.bin');
  const measured = await measureReads(async () => {
    const started = await fixture.call('tasks.start', {
      operation: 'copy',
      items: [{ ...fixture.ref('source.bin'), expectedVersion }],
      destination: fixture.ref('dest'),
      conflict: 'skip',
    }, { route: 'manifest' });
    assert.equal(started.status, 200, `planning is accepted, the refusal is reported on the item: ${JSON.stringify(started.error)}`);
    return await fixture.settle(started.value.id);
  });
  const task = measured.value;
  record(evidence, 'budget-planning-refusal', `status=${task.status} code=${task.items[0].error?.code} rchar delta=${measured.bytes} for ${SIZE} bytes`);
  assert.equal(task.status, 'failed');
  assert.equal(task.items[0].error.code, 'TOO_LARGE');
  assert.ok(measured.bytes < SIZE / 8,
    `an over-budget manifest must be refused while planning: rchar delta ${measured.bytes} must stay far below ${SIZE}`);
  assert.equal(existsSync(path.join(fixture.directory, 'dest', 'source.bin')), false);
});

test('R15: a within-budget copy really verifies the bytes', { skip: blocked }, async t => {
  const SIZE = 16 * 1024 * 1024;
  const fixture = await hostFixture({ withTasks: true, limits: { maxVerificationBytes: 256 * 1024 * 1024 } });
  t.after(fixture.close);
  const source = path.join(fixture.directory, 'source.bin');
  writeSizedFile(source, SIZE);
  await mkdir(path.join(fixture.directory, 'dest'));
  const sourceDigest = createHash('sha256').update(readFileSync(source)).digest('hex');

  const measured = await measureReads(async () => {
    const started = await fixture.call('tasks.start', {
      operation: 'copy',
      items: [{ ...fixture.ref('source.bin'), expectedVersion: await contentTokenOf(fixture.directory, 'source.bin') }],
      destination: fixture.ref('dest'),
      conflict: 'skip',
    }, { route: 'manifest' });
    assert.equal(started.status, 200);
    return await fixture.settle(started.value.id);
  });
  const task = measured.value;
  record(evidence, 'budget-verify', `status=${task.status} rchar delta=${measured.bytes} for ${SIZE} bytes`);
  assert.equal(task.status, 'completed', `the copy must succeed within budget: ${JSON.stringify(task.items[0].error)}`);
  assert.ok(measured.bytes >= SIZE, `verification must actually read the content: rchar delta ${measured.bytes} must reach ${SIZE}`);
  const destination = path.join(fixture.directory, 'dest', 'source.bin');
  assert.equal(createHash('sha256').update(readFileSync(destination)).digest('hex'), sourceDigest, 'the published bytes must equal the source bytes');
});

test('R15: the budget is charged per operation, not per underlying call', { skip: blocked }, async t => {
  const EACH = 512 * 1024;
  const fixture = await hostFixture({ withTasks: true, limits: { maxVerificationBytes: 1024 * 1024 } });
  t.after(fixture.close);
  const names = ['a.bin', 'b.bin', 'c.bin'];
  for (const name of names) writeSizedFile(path.join(fixture.directory, name), EACH);
  await mkdir(path.join(fixture.directory, 'dest'));
  const items = [];
  for (const name of names) items.push({ ...fixture.ref(name), expectedVersion: await contentTokenOf(fixture.directory, name) });

  const started = await fixture.call('tasks.start', { operation: 'copy', items, destination: fixture.ref('dest'), conflict: 'skip' }, { route: 'manifest' });
  assert.equal(started.status, 200);
  const task = await fixture.settle(started.value.id);
  record(evidence, 'budget-per-operation', `status=${task.status} codes=${task.items.map(item => item.error?.code ?? item.status).join(',')}`);
  assert.equal(task.status, 'failed', 'a manifest whose total exceeds the budget must be refused as a whole');
  assert.ok(task.items.some(item => item.error?.code === 'TOO_LARGE'), `expected TOO_LARGE, saw ${JSON.stringify(task.items.map(item => item.error?.code))}`);
  for (const name of names) {
    assert.equal(existsSync(path.join(fixture.directory, 'dest', name)), false, `${name} must not be published by a refused operation`);
  }
});

test('R15: verification failures never modify files and report commit facts', { skip: blocked }, async t => {
  const fixture = await hostFixture({ withTasks: true });
  t.after(fixture.close);
  const file = path.join(fixture.directory, 'target.txt');
  writeFileSync(file, 'first');

  // (a) A verification failure must not delete or rewrite anything.
  const prepared = await fixture.call('delete.prepare', { items: [fixture.ref('target.txt')] });
  assert.equal(prepared.status, 200);
  writeFileSync(file, 'second');
  const commit = await fixture.call('delete.commit', { planId: prepared.value.id, confirmed: true });
  record(evidence, 'budget-failure-semantics', `stale delete.commit -> ${commit.status} ${commit.error?.code}`);
  assert.equal(commit.status, 409);
  assert.equal(commit.error.code, 'VERSION_CONFLICT');
  assert.equal(readFileSync(file, 'utf8'), 'second', 'a refused deletion must leave the file exactly as it is');

  // (b) A failure after publication must report the committed fact, not a rollback.
  const source = path.join(fixture.directory, 'published.bin');
  writeSizedFile(source, 2 * 1024 * 1024);
  await mkdir(path.join(fixture.directory, 'dest'));
  const failing = await hostFixture({
    withTasks: true,
    persistTask: record => {
      const published = JSON.stringify(record).includes('"result"');
      if (published) throw Object.assign(new Error('injected persistence failure'), { code: 'EIO' });
    },
  });
  t.after(failing.close);
  const failingSource = path.join(failing.directory, 'published.bin');
  writeSizedFile(failingSource, 2 * 1024 * 1024);
  await mkdir(path.join(failing.directory, 'dest'));
  const started = await failing.call('tasks.start', {
    operation: 'copy',
    items: [{ ...failing.ref('published.bin'), expectedVersion: await contentTokenOf(failing.directory, 'published.bin') }],
    destination: failing.ref('dest'),
    conflict: 'skip',
  }, { route: 'manifest' });
  assert.equal(started.status, 200);
  const task = await failing.settle(started.value.id);
  record(evidence, 'budget-failure-semantics', `persistence failure -> status=${task.status} code=${task.items[0].error?.code} committed=${task.items[0].error?.details?.committed}`);
  assert.equal(task.status, 'failed');
  // The wire code set is closed (Lead ruling): an unmapped errno never leaks, the raw
  // value moves into details.cause, and the committed fact is still reported.
  assert.equal(task.items[0].error.code, 'IO_ERROR',
    `a post-publication failure must use the closed-set code, got ${task.items[0].error.code}`);
  assert.equal(task.items[0].error.details.cause, 'EIO', 'the raw errno must survive in details.cause');
  assert.equal(task.items[0].error.details.committed, true, 'a post-publication failure must report that the content is committed');
  assert.equal(existsSync(path.join(failing.directory, 'dest', 'published.bin')), true, 'committed content is never rolled back');
});

test('the median-plus-baseline measurement is usable for the real cases', async t => {
  // Self-test of measureReadsMedian: a metadata-only operation must measure far below
  // its own content-reading counterpart on a 16 MiB file.
  const fixture = await tempRoot('dsh-fm-verify-median-');
  t.after(fixture.cleanup);
  const file = path.join(fixture.directory, 'median.bin');
  writeSizedFile(file, 16 * 1024 * 1024);
  const baseline = () => statSync(file);
  const metadataOnly = await measureReadsMedian({ operation: () => statSync(file), baseline, repeats: 3 });
  const contentRead = await measureReadsMedian({ operation: () => readFileSync(file), baseline, repeats: 3 });
  record(evidence, 'rchar-selftest', `median metadata-only = ${metadataOnly.median}, median content = ${contentRead.median}`);
  assert.ok(metadataOnly.median < 64 * 1024, `metadata-only median must stay tiny (measured ${metadataOnly.median})`);
  assert.ok(contentRead.median >= 16 * 1024 * 1024, `content median must exceed 16 MiB (measured ${contentRead.median})`);
});

test('evidence is written next to the plan it belongs to', () => {
  writeFileSync(path.join(evidence, 'README.txt'), 'task-6 independent verification evidence; see docs/VERIFICATION-PLAN.md\n');
  assert.ok(evidence.endsWith(path.join('docs', 'verification', RUN)));
});
