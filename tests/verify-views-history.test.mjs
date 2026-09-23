/**
 * task-6 独立验证：公开视图白名单（真实 HTTP 取证）、R18 特殊文件名、R13 冷重开。
 *
 * 判定标准与证据路径见 `docs/VERIFICATION-PLAN.md` §F、§G、§H。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { evidenceDirectory, hostFixture, probeReadiness, record, storageStub, writeSizedFile } from './verify-harness.mjs';

const readiness = await probeReadiness();
const blocked = readiness.ready ? false : `task-6 verification blocked: ${readiness.missing.join(', ')}`;
const RUN = 'task6-views';
const evidence = evidenceDirectory(RUN);

test('verification prerequisites are present', () => {
  assert.deepEqual(readiness.missing, [], 'task-6 verification cannot run before task-4/task-5 artifacts exist');
});

test('the recovery-proof field list covers every private journal field', async () => {
  // Self-test of the whitelist assertion used by the F cases: the list must name
  // every field the persisted journal keeps and the public view must not expose.
  const { RECOVERY_PROOF_FIELDS, leaksRecoveryProof } = await import('../dist/contracts/views.js');
  for (const field of ['checkpoint', 'measured', 'identity', 'sha256', 'metadataVersion', 'targetManifest', 'targetParent', 'destinationIdentity']) {
    assert.ok(RECOVERY_PROOF_FIELDS.includes(field), `${field} must be part of the recovery-proof exclusion list`);
  }
  assert.equal(leaksRecoveryProof({ items: [{ checkpoint: {} }] }), 'checkpoint');
  assert.equal(leaksRecoveryProof({ items: [{ status: 'completed' }] }), undefined);
  record(evidence, 'views-whitelist-selftest', `fields=${RECOVERY_PROOF_FIELDS.length}`);
});

const RECOVERY_FIELDS = ['checkpoint', 'measured', 'identity', 'sha256', 'metadataVersion', 'targetManifest', 'destinationIdentity'];

/** Names the frozen path grammar cannot express (R18). */
const UNEXPRESSIBLE = ['bad\\name', 'bad\u0001name'];

async function copyOnce(fixture, name, { destination = 'dest' } = {}) {
  const stats = await lstat(path.join(fixture.directory, name), { bigint: true });
  const digest = createHash('sha256').update(readFileSync(path.join(fixture.directory, name))).digest('hex');
  const expectedVersion = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}:${digest}`;
  const started = await fixture.call('tasks.start', {
    operation: 'copy', items: [{ ...fixture.ref(name), expectedVersion }], destination: fixture.ref(destination), conflict: 'skip',
  }, { route: 'manifest' });
  assert.equal(started.status, 200, `tasks.start must be accepted: ${JSON.stringify(started.error)}`);
  return await fixture.settle(started.value.id);
}

test('F1: no public response carries recovery proof while the journal still does', { skip: blocked }, async t => {
  const journal = new Map();
  const transferJournal = new Map();
  const fixture = await hostFixture({
    withTasks: true, withTransfers: true,
    persistTask: record => journal.set(record.id, structuredClone(record)),
    persistTasks: records => { for (const record of records) transferJournal.set(record.id, structuredClone(record)); },
  });
  t.after(fixture.close);
  writeSizedFile(path.join(fixture.directory, 'source.bin'), 512 * 1024);
  await mkdir(path.join(fixture.directory, 'dest'));
  await mkdir(path.join(fixture.directory, 'tree'));
  writeFileSync(path.join(fixture.directory, 'tree', 'member.txt'), 'zip member');

  const task = await copyOnce(fixture, 'source.bin');
  const listed = await fixture.call('tasks.get', { taskId: task.id });
  const raw = JSON.stringify(listed.body);
  record(evidence, 'views-whitelist', `tasks.get status=${listed.status} bytes=${raw.length} leaks=${RECOVERY_FIELDS.filter(field => raw.includes(`"${field}"`)).join(',') || 'none'}`);
  assert.equal(listed.status, 200);
  for (const field of RECOVERY_FIELDS) {
    assert.equal(raw.includes(`"${field}"`), false, `a public task response must not contain "${field}"`);
  }
  const storedTask = journal.get(task.id);
  assert.ok(storedTask, 'the journal must have received the task record');
  assert.ok(JSON.stringify(storedTask).includes('"checkpoint"'), 'the persisted journal must still keep the recovery proof');
  assert.equal('identity' in listed.value.items[0].result.destination, false, 'a committed summary carries no identity');
  assert.equal('sha256' in listed.value.items[0].result.destination, false, 'a committed summary carries no digest');
  assert.equal(listed.value.items[0].error, undefined, 'a successful item has no error');
  assert.equal(listed.value.items[0].result.sourceRemoved, false, 'a copy must not report the source as removed');

  // A failed item must keep its business code instead of degrading to IO_ERROR.
  const missing = await fixture.call('tasks.start', {
    operation: 'copy', items: [{ ...fixture.ref('absent.bin'), expectedVersion: '1:2:3:4:5' }], destination: fixture.ref('dest'), conflict: 'skip',
  }, { route: 'manifest' });
  assert.equal(missing.status, 200);
  const failed = await fixture.settle(missing.value.id);
  record(evidence, 'views-whitelist', `failed item code=${failed.items[0].error?.code}`);
  assert.equal(failed.items[0].error.code, 'NOT_FOUND', `a missing source must keep its business code, got ${failed.items[0].error.code}`);

  // Transfers: the same whitelist applies, and the journal keeps its own proof.
  const begun = await fixture.call('transfers.begin', { direction: 'download', ...fixture.ref('source.bin') }, { route: 'manifest' });
  assert.equal(begun.status, 200, JSON.stringify(begun.error));
  const downloaded = await fixture.router(new Request(`http://localhost/api/file-manager/v2/download?taskId=${begun.value.id}`));
  assert.equal(downloaded.status, 200);
  await downloaded.arrayBuffer();
  const transferView = await fixture.call('transfers.get', { taskId: begun.value.id });
  const transferRaw = JSON.stringify(transferView.body);
  record(evidence, 'views-whitelist', `transfers.get status=${transferView.status} leaks=${RECOVERY_FIELDS.filter(field => transferRaw.includes(`"${field}"`)).join(',') || 'none'}`);
  assert.equal(transferView.status, 200);
  for (const field of RECOVERY_FIELDS) {
    assert.equal(transferRaw.includes(`"${field}"`), false, `a public transfer response must not contain "${field}"`);
  }
  const storedTransfer = transferJournal.get(begun.value.id);
  assert.ok(storedTransfer, 'the transfer journal must have received the record');
  const storedItem = storedTransfer.items[0];
  record(evidence, 'views-whitelist', `journal item keeps ${['identity', 'sha256', 'version', 'committed'].filter(field => field in storedItem).join(',')}`);
  assert.ok(typeof storedItem.identity === 'string' && storedItem.identity.length > 0, 'the journal must keep the verified identity of the published bytes');
  assert.ok(typeof storedItem.sha256 === 'string' && storedItem.sha256.length === 64, 'the journal must keep the verified digest');
  assert.equal('identity' in transferView.value.items[0], false, 'the public item must not expose the identity');
  assert.equal('sha256' in transferView.value.items[0], false, 'the public item must not expose the digest');
  assert.equal('version' in transferView.value.items[0], false, 'the public item must not expose the internal version handle');
});

test('F2: a close receipt carries exactly the five documented fields', { skip: blocked }, async t => {
  const fixture = await hostFixture({ withTasks: true });
  t.after(fixture.close);
  writeSizedFile(path.join(fixture.directory, 'source.bin'), 256 * 1024);
  await mkdir(path.join(fixture.directory, 'dest'));
  const task = await copyOnce(fixture, 'source.bin');

  const closed = await fixture.call('activities.dismiss', { items: [{ kind: 'task', taskId: task.id, expectedHistoryRevision: 0 }] });
  record(evidence, 'views-receipt', `dismiss -> ${closed.status} ${JSON.stringify(closed.value?.results?.[0]?.task)}`);
  assert.equal(closed.status, 200);
  const receipt = closed.value.results[0];
  assert.equal(receipt.outcome, 'dismissed');
  assert.deepEqual(Object.keys(receipt.task).sort(), ['canDismiss', 'dismissed', 'historyRevision', 'id', 'status']);
  assert.equal(receipt.task.dismissed, true);
  assert.equal(receipt.task.id, task.id);

  // Closing an already-closed record is idempotent; the revision guard bites on a
  // record that is still visible (an old close action must not hide it).
  const again = await fixture.call('activities.dismiss', { items: [{ kind: 'task', taskId: task.id, expectedHistoryRevision: 1 }] });
  record(evidence, 'views-receipt', `re-close -> ${again.status} ${again.value.results[0].outcome} revision=${again.value.results[0].task.historyRevision}`);
  assert.equal(again.value.results[0].outcome, 'dismissed');

  const second = await copyOnce(fixture, 'source.bin');
  const busy = await fixture.call('activities.dismiss', { items: [{ kind: 'task', taskId: second.id, expectedHistoryRevision: 99 }] });
  const rejected = busy.value.results[0];
  record(evidence, 'views-receipt', `stale revision on a visible record -> ${busy.status} ${rejected.outcome} ${rejected.error?.code}`);
  assert.equal(busy.status, 200);
  assert.equal(rejected.outcome, 'rejected');
  assert.deepEqual(Object.keys(rejected).sort(), ['error', 'kind', 'outcome', 'taskId']);
  assert.equal(rejected.error.code, 'TASK_CHANGED');
  const stillVisible = await fixture.call('tasks.get', { taskId: second.id });
  assert.equal(stillVisible.value.dismissed, false, 'a rejected close must leave the record visible');
});

test('G1: a directory with unexpressible names lists safely and per-item', { skip: blocked }, async t => {
  const fixture = await hostFixture();
  t.after(fixture.close);
  writeFileSync(path.join(fixture.directory, 'normal.txt'), 'normal');
  for (const name of UNEXPRESSIBLE) writeFileSync(path.join(fixture.directory, name), 'special');
  await mkdir(path.join(fixture.directory, 'folder'));
  await symlink(path.join(fixture.directory, 'normal.txt'), path.join(fixture.directory, 'link.txt'));

  const listing = await fixture.call('entries.list', fixture.ref(''));
  record(evidence, 'r18-list', `status=${listing.status} entries=${listing.value?.entries?.map(entry => entry.name).join('|')} unaddressable=${JSON.stringify(listing.value?.unaddressable)} total=${listing.value?.total}`);
  assert.equal(listing.status, 200, 'a single unexpressible name must not break the listing');
  const addressable = listing.value.entries.map(entry => entry.name);
  assert.ok(addressable.includes('normal.txt'));
  assert.ok(addressable.includes('folder'));
  assert.ok(addressable.includes('link.txt'), 'a symlink name is expressible and stays addressable');
  const unaddressable = listing.value.unaddressable.map(entry => entry.name);
  for (const name of UNEXPRESSIBLE) assert.ok(unaddressable.includes(name), `${JSON.stringify(name)} must be reported as unaddressable`);
  for (const entry of listing.value.unaddressable) {
    assert.deepEqual(Object.keys(entry).sort(), ['kind', 'name', 'reason']);
    assert.equal('path' in entry, false);
    assert.ok(entry.reason.length > 0 && entry.reason.length <= 200);
  }
  assert.equal(listing.value.total, addressable.length, 'total counts addressable entries only');

  // Paging still walks the whole readdir order and reaches every addressable entry.
  const seen = new Set();
  const unaddressableSeen = new Set();
  let cursor;
  for (let page = 0; page < 20; page++) {
    const next = await fixture.call('entries.list', { ...fixture.ref(''), limit: 1, ...(cursor ? { cursor } : {}) });
    assert.equal(next.status, 200);
    for (const entry of next.value.entries) seen.add(entry.name);
    for (const entry of next.value.unaddressable) unaddressableSeen.add(entry.name);
    cursor = next.value.nextCursor;
    if (!cursor) break;
  }
  record(evidence, 'r18-list', `paged addressable=${[...seen].sort().join('|')} unaddressable=${[...unaddressableSeen].sort().join('|')}`);
  assert.deepEqual([...seen].sort(), [...addressable].sort(), 'paging must reach every addressable entry');
  assert.equal(seen.size + unaddressableSeen.size, listing.value.total + listing.value.unaddressable.length);
});

test('G2: directory operations fail explicitly on an unexpressible member', { skip: blocked }, async t => {
  const fixture = await hostFixture({ withTasks: true, withTransfers: true });
  t.after(fixture.close);
  await mkdir(path.join(fixture.directory, 'mixed'));
  writeFileSync(path.join(fixture.directory, 'mixed', 'ok.txt'), 'ok');
  writeFileSync(path.join(fixture.directory, 'mixed', UNEXPRESSIBLE[0]), 'special');
  await mkdir(path.join(fixture.directory, 'dest'));

  const prepared = await fixture.call('delete.prepare', { items: [fixture.ref('mixed')] });
  record(evidence, 'r18-operations', `delete.prepare -> ${prepared.status} ${prepared.error?.code}`);
  assert.equal(prepared.status, 422, 'deleting a tree containing an unexpressible name must fail explicitly');
  assert.equal(prepared.error.code, 'UNREPRESENTABLE_REFERENCE');
  assert.equal(existsSync(path.join(fixture.directory, 'mixed', 'ok.txt')), true, 'a refused deletion must not remove anything');

  const copied = await fixture.call('tasks.start', {
    operation: 'copy', items: [{ ...fixture.ref('mixed'), expectedVersion: '1:2:3:4:5' }], destination: fixture.ref('dest'), conflict: 'skip',
  }, { route: 'manifest' });
  assert.equal(copied.status, 200, JSON.stringify(copied.error));
  const task = await fixture.settle(copied.value.id);
  record(evidence, 'r18-operations', `copy tree -> status=${task.status} code=${task.items[0].error?.code}`);
  assert.equal(task.status, 'failed');
  assert.equal(task.items[0].error.code, 'UNREPRESENTABLE_REFERENCE', 'copying must not silently omit the unexpressible member');
  assert.equal(existsSync(path.join(fixture.directory, 'dest', 'mixed')), false, 'a failed tree copy must publish nothing');

  const download = await fixture.call('transfers.begin', { direction: 'download', ...fixture.ref('mixed') }, { route: 'manifest' });
  if (download.status === 200) {
    const zip = await fixture.router(new Request(`http://localhost/api/file-manager/v2/download?taskId=${download.value.id}`));
    const body = await zip.arrayBuffer();
    record(evidence, 'r18-operations', `zip download -> ${zip.status} bytes=${body.byteLength} view=${JSON.stringify(await fixture.call('transfers.get', { taskId: download.value.id }).then(result => result.value.status))}`);
    assert.notEqual(zip.status, 200, 'packing a tree with an unexpressible member must fail instead of silently omitting it');
  } else {
    record(evidence, 'r18-operations', `zip download planning -> ${download.status} ${download.error?.code}`);
    assert.equal(download.error.code, 'UNREPRESENTABLE_REFERENCE');
  }
});

test('G3: deep nesting stays addressable and never degrades into a 500', { skip: blocked }, async t => {
  // R18 also covers a root-relative path longer than 4096 characters. Such a path
  // cannot be created on Linux at all: the absolute path would exceed PATH_MAX, so a
  // real readdir can never yield one (the classification itself is covered by the
  // unit-level grammar oracle in tests/contracts.test.mjs). What IS reachable is deep
  // nesting just under the limit, which must stay fully addressable.
  const fixture = await hostFixture();
  t.after(fixture.close);
  writeFileSync(path.join(fixture.directory, 'shallow.txt'), 'shallow');
  const segment = 'd'.repeat(40);
  let current = fixture.directory;
  let relativePath = '';
  while (relativePath.length + segment.length + 1 <= 3800) {
    current = path.join(current, segment);
    await mkdir(current);
    relativePath = relativePath ? `${relativePath}/${segment}` : segment;
  }
  writeFileSync(path.join(current, 'deep.txt'), 'deep');
  record(evidence, 'r18-deep-nesting', `deepest relative path length=${relativePath.length} levels=${relativePath.split('/').length}`);

  // Walk down level by level: every level must be addressable and list without error.
  let walked = '';
  for (const part of relativePath.split('/')) {
    const listing = await fixture.call('entries.list', fixture.ref(walked));
    assert.equal(listing.status, 200, `listing ${walked || '<root>'} must not fail`);
    assert.ok(listing.value.unaddressable.length === 0, 'a path under PATH_MAX is expressible and must stay addressable');
    assert.ok(listing.value.entries.some(entry => entry.name === part || entry.name === 'shallow.txt' || entry.name === 'deep.txt'),
      `level ${walked || '<root>'} must list its children`);
    walked = walked ? `${walked}/${part}` : part;
  }
  const deepest = await fixture.call('entries.list', fixture.ref(walked));
  record(evidence, 'r18-deep-nesting', `deepest listing -> ${deepest.status} entries=${deepest.value?.entries?.map(entry => entry.name).join('|')}`);
  assert.equal(deepest.status, 200);
  assert.equal(deepest.value.unaddressable.length, 0);
  assert.deepEqual(deepest.value.entries.map(entry => entry.name), ['deep.txt']);
  const stat = await fixture.call('entries.stat', fixture.ref(`${walked}/deep.txt`));
  assert.equal(stat.status, 200, 'the deeply nested file must be addressable by its full relative path');
  assert.equal(stat.value.kind, 'file');
});

test('H1: a closed record does not come back and an old close cannot hide a new execution', { skip: blocked }, async t => {
  const { createTaskService } = await import('../dist/host/tasks.js');
  const durable = new Map();
  const fixture = await hostFixture({
    withTasks: true,
    persistTask: record => durable.set(record.id, structuredClone(record)),
  });
  writeFileSync(path.join(fixture.directory, 'present.txt'), 'present');
  await mkdir(path.join(fixture.directory, 'dest'));

  // A failed item is what makes a record retryable (a successful one has nothing to retry).
  const started = await fixture.call('tasks.start', {
    operation: 'copy', items: [{ ...fixture.ref('absent.txt'), expectedVersion: '1:2:3:4:5' }], destination: fixture.ref('dest'), conflict: 'skip',
  }, { route: 'manifest' });
  assert.equal(started.status, 200, JSON.stringify(started.error));
  const failed = await fixture.settle(started.value.id);
  const taskId = failed.id;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.historyRevision, 0);
  assert.ok(durable.has(taskId), 'the failed record must be persisted');
  assert.ok(JSON.stringify([...durable.entries()]).includes('"checkpoint"') || JSON.stringify([...durable.entries()]).includes('"expectedVersion"'),
    'the persisted record must keep the recovery/verification handle');

  // A retry starts a new execution and advances the history revision.
  const retried = await fixture.tasks.retry({ taskId });
  const revisionAfterRetry = retried.historyRevision;
  record(evidence, 'history-cold-reopen', `retry -> dismissed=${retried.dismissed} revision=${revisionAfterRetry}`);
  assert.equal(retried.dismissed, false, 'a retry must make the record visible again');
  assert.ok(revisionAfterRetry > 0, 'the retry must advance the history revision');

  // While the retried execution is still running it cannot be closed at all.
  const busy = await fixture.call('activities.dismiss', { items: [{ kind: 'task', taskId, expectedHistoryRevision: revisionAfterRetry }] });
  const busyReceipt = busy.value.results[0];
  record(evidence, 'history-cold-reopen', `close while the retry runs -> ${busyReceipt.outcome} ${busyReceipt.error?.code}`);
  assert.equal(busyReceipt.outcome, 'rejected');
  assert.equal(busyReceipt.error.code, 'TASK_BUSY', 'a running retry must not be closable');
  assert.equal((await fixture.tasks.get({ taskId })).dismissed, false, 'the retried record must stay visible');

  // Once it settles, a close action carrying the pre-retry revision must be refused.
  const rerun = await fixture.settle(taskId);
  assert.equal(rerun.status, 'failed', 'the retried copy fails again for the same reason');
  const revisionNow = (await fixture.tasks.get({ taskId })).historyRevision;
  const staleClose = await fixture.call('activities.dismiss', { items: [{ kind: 'task', taskId, expectedHistoryRevision: 0 }] });
  const staleReceipt = staleClose.value.results[0];
  record(evidence, 'history-cold-reopen', `stale close (revision 0 vs ${revisionNow}) -> ${staleReceipt.outcome} ${staleReceipt.error?.code}`);
  assert.equal(staleReceipt.outcome, 'rejected');
  assert.equal(staleReceipt.error.code, 'TASK_CHANGED', 'an old close action must not hide the new execution');
  assert.equal((await fixture.tasks.get({ taskId })).dismissed, false, 'the retried record must stay visible');

  const closed = await fixture.call('activities.dismiss', { items: [{ kind: 'task', taskId, expectedHistoryRevision: revisionNow }] });
  assert.equal(closed.status, 200);
  assert.equal(closed.value.results[0].outcome, 'dismissed');
  const revisionAfterClose = closed.value.results[0].task.historyRevision;
  // Baseline for the close/reopen claim: taken once the record is closed, so it must
  // stay byte-identical through the reopen.
  const rawAfterClose = JSON.stringify([...durable.entries()]);
  await fixture.tasks.close();

  // Cold reopen from the persisted records only. Opening history must not rewrite it.
  const reopenWrites = [];
  const reopened = createTaskService({
    manager: fixture.manager, limits: fixture.limits,
    initialTasks: [...durable.values()].map(record => structuredClone(record)),
    persistTask: record => reopenWrites.push(structuredClone(record)),
  });
  t.after(() => reopened.close().catch(() => {}));
  const restored = await reopened.get({ taskId });
  record(evidence, 'history-cold-reopen', `reopened dismissed=${restored.dismissed} revision=${restored.historyRevision} status=${restored.status}`);
  assert.equal(restored.dismissed, true, 'a closed record must not come back after a cold reopen');
  assert.equal(restored.historyRevision, revisionAfterClose, 'the history revision must survive the reopen');
  assert.equal(restored.items[0].error.code, 'NOT_FOUND', 'the item failure must survive the reopen');

  // A reopen may normalize what it read, but it must never resurrect a closed record
  // or reset its history revision.
  record(evidence, 'history-cold-reopen', `writes on reopen=${reopenWrites.length} statuses=${reopenWrites.map(record => `${record.status}/dismissed=${record.dismissed}/rev=${record.historyRevision}/item=${record.items[0]?.status}/code=${record.items[0]?.error?.code}`).join(',') || 'none'}`);
  for (const written of reopenWrites) {
    assert.equal(written.dismissed, true, 'a reopen must never un-dismiss a closed record');
    assert.equal(written.historyRevision, revisionAfterClose, 'a reopen must never reset the history revision');
    assert.equal(written.items[0].error.code, 'NOT_FOUND', 'a reopen must never drop the recorded failure');
  }
  assert.equal(JSON.stringify([...durable.entries()]), rawAfterClose, 'closing and reopening must not rewrite the persisted records');

  // SPEC R13: "新的重试重新显示" - a new retry brings the record back, which is exactly
  // why an old close action must carry a revision (checked above).
  const resurrected = await reopened.retry({ taskId }).then(result => result, error => error.code);
  record(evidence, 'history-cold-reopen', `retry a closed record -> ${typeof resurrected === 'string' ? resurrected : `dismissed=${resurrected.dismissed} revision=${resurrected.historyRevision}`}`);
  assert.notEqual(typeof resurrected, 'string', `a retry must be accepted for a closed record, got ${resurrected}`);
  assert.equal(resurrected.dismissed, false, 'the new retry must be visible again');
  assert.ok(resurrected.historyRevision > revisionAfterClose, 'the retry must advance the history revision past the close');
  assert.equal((await reopened.get({ taskId })).dismissed, false, 'the reopened service must agree with the retry result');
});

test('H2: normalization on cold reopen is idempotent', { skip: blocked }, async t => {
  // Lead's strengthened requirement: opening a persisted snapshot may normalize once,
  // but opening that same snapshot again must write nothing and must observe exactly
  // the same state - so "rewrite on every open" (revision creeping upward) is caught.
  const { createTaskService } = await import('../dist/host/tasks.js');
  const durable = new Map();
  const fixture = await hostFixture({ withTasks: true, persistTask: record => durable.set(record.id, structuredClone(record)) });
  t.after(fixture.close);
  writeFileSync(path.join(fixture.directory, 'present.txt'), 'present');
  await mkdir(path.join(fixture.directory, 'dest'));

  const started = await fixture.call('tasks.start', {
    operation: 'copy', items: [{ ...fixture.ref('absent.txt'), expectedVersion: '1:2:3:4:5' }], destination: fixture.ref('dest'), conflict: 'skip',
  }, { route: 'manifest' });
  const failed = await fixture.settle(started.value.id);
  const taskId = failed.id;
  const retried = await fixture.tasks.retry({ taskId });
  await fixture.settle(taskId);
  const revision = (await fixture.tasks.get({ taskId })).historyRevision;
  assert.ok(revision > retried.historyRevision - 1, 'the retry must have advanced the revision');
  await fixture.call('activities.dismiss', { items: [{ kind: 'task', taskId, expectedHistoryRevision: revision }] });
  await fixture.tasks.close();

  const snapshot = [...durable.values()].map(record => structuredClone(record));
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].dismissed, true, 'the snapshot must be closed before the idempotence check');

  const firstWrites = [];
  const first = createTaskService({
    manager: fixture.manager, limits: fixture.limits,
    initialTasks: snapshot.map(record => structuredClone(record)),
    persistTask: record => firstWrites.push(structuredClone(record)),
  });
  t.after(() => first.close().catch(() => {}));
  const firstView = await first.get({ taskId });

  const secondWrites = [];
  const second = createTaskService({
    manager: fixture.manager, limits: fixture.limits,
    initialTasks: (firstWrites.length ? firstWrites : snapshot).map(record => structuredClone(record)),
    persistTask: record => secondWrites.push(structuredClone(record)),
  });
  t.after(() => second.close().catch(() => {}));
  const secondView = await second.get({ taskId });
  const changes = firstWrites.length
    ? Object.keys({ ...snapshot[0], ...firstWrites[0] })
      .filter(key => JSON.stringify(snapshot[0][key]) !== JSON.stringify(firstWrites[0][key]))
      .map(key => `${key}: ${JSON.stringify(snapshot[0][key])} -> ${JSON.stringify(firstWrites[0][key])}`)
    : [];
  record(evidence, 'history-idempotence', `snapshot item=${snapshot[0].items[0].status}/${snapshot[0].items[0].attempts} open1 writes=${firstWrites.length} open2 writes=${secondWrites.length} revision=${secondView.historyRevision} changes=[${changes.join(' | ')}]`);

  assert.equal(secondWrites.length, 0, 'a second open of the same snapshot must not write');
  assert.equal(secondView.dismissed, true, 'a second open must not resurrect a closed record');
  assert.equal(secondView.historyRevision, snapshot[0].historyRevision, 'a second open must not advance the revision');
  assert.equal(secondView.status, snapshot[0].status, 'a second open must see the same status');
  assert.equal(firstView.historyRevision, snapshot[0].historyRevision, 'opening must never advance the history revision');
  assert.equal(firstView.dismissed, true, 'opening must never resurrect a closed record');
  assert.equal(JSON.stringify([...durable.values()]), JSON.stringify(snapshot), 'opening must not touch the persisted records');
});
