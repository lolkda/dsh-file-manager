/**
 * task-6 独立验证：R16 共享重 IO 调度（集成侧复核）。
 *
 * 单元级覆盖已由 task-2 的 `tests/host-scheduler.test.mjs` 提供；本文件复核的是
 * **复制/移动/上传/下载/核验是否真的共用一个调度器**，以及状态查询与取消是否不占许可。
 * 判定标准与证据路径见 `docs/VERIFICATION-PLAN.md` §E。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { evidenceDirectory, hostFixture, probeReadiness, record, writeSizedFile } from './verify-harness.mjs';

const readiness = await probeReadiness();
const blocked = readiness.ready ? false : `task-6 verification blocked: ${readiness.missing.join(', ')}`;
const RUN = 'task6-scheduler';
const evidence = evidenceDirectory(RUN);

test('verification prerequisites are present', () => {
  assert.deepEqual(readiness.missing, [], 'task-6 verification cannot run before task-4/task-5 artifacts exist');
});

test('the frozen scheduler bounds are the ones under test', async () => {
  const limits = await import('../dist/contracts/limits.js');
  record(evidence, 'scheduler-bounds', `transferConcurrency=${limits.LIMIT_DEFAULTS.transferConcurrency} queue=${limits.HEAVY_IO_QUEUE_LIMIT}`);
  assert.equal(limits.LIMIT_DEFAULTS.transferConcurrency, 2, 'the default heavy-IO concurrency is 2');
  assert.equal(limits.HEAVY_IO_QUEUE_LIMIT, 64, 'the waiting queue is bounded at 64');
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Hold every permit with a gate that never settles, so the queue is observable. */
function gatedPermits(scheduler, count) {
  const releases = [];
  const started = [];
  for (let index = 0; index < count; index++) {
    started.push(scheduler.run(async () => {
      await new Promise(resolve => releases.push(resolve));
    }));
  }
  return { releases, started };
}

test('E1: copy tasks share one bounded heavy-IO pool across the profile', { skip: blocked }, async t => {
  const { createHeavyIoScheduler } = await import('../dist/host/scheduler.js');
  const scheduler = createHeavyIoScheduler({ concurrency: 2, queueLimit: 64 });
  const fixture = await hostFixture({ withTasks: true, scheduler });
  t.after(fixture.close);
  writeSizedFile(path.join(fixture.directory, 'a.bin'), 1024 * 1024);
  await mkdir(path.join(fixture.directory, 'dest'));
  const expectedVersion = await lstat(path.join(fixture.directory, 'a.bin'), { bigint: true }).then(async stats => {
    const digest = createHash('sha256').update(readFileSync(path.join(fixture.directory, 'a.bin'))).digest('hex');
    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}:${digest}`;
  });

  const gate = gatedPermits(scheduler, 2);
  await delay(50);
  assert.equal(scheduler.status().active, 2, 'both permits are held by the gates');

  const started = await fixture.call('tasks.start', {
    operation: 'copy',
    items: [{ ...fixture.ref('a.bin'), expectedVersion }],
    destination: fixture.ref('dest'),
    conflict: 'skip',
  }, { route: 'manifest' });
  assert.equal(started.status, 200);
  await delay(150);
  const status = scheduler.status();
  record(evidence, 'scheduler-concurrency', `with gates held: active=${status.active} queued=${status.queued} peak=${status.peak}`);
  assert.ok(status.active <= 2, `the pool must never exceed its concurrency (active=${status.active})`);
  assert.ok(status.queued >= 1, 'a copy task must wait for a shared permit instead of running unbounded');
  assert.equal(existsSync(path.join(fixture.directory, 'dest', 'a.bin')), false, 'nothing may be published while the permit is queued');

  for (const release of gate.releases) release();
  await Promise.allSettled(gate.started);
  const task = await fixture.settle(started.value.id);
  record(evidence, 'scheduler-concurrency', `after release: status=${task.status} peak=${scheduler.status().peak}`);
  assert.equal(task.status, 'completed');
  assert.ok(scheduler.status().peak <= 2, `peak concurrency must stay at or below 2, saw ${scheduler.status().peak}`);
  assert.equal(existsSync(path.join(fixture.directory, 'dest', 'a.bin')), true);
});

test('E2: status queries and cancellation never consume a heavy-IO permit', { skip: blocked }, async t => {
  const { createHeavyIoScheduler } = await import('../dist/host/scheduler.js');
  const scheduler = createHeavyIoScheduler({ concurrency: 2, queueLimit: 64 });
  const fixture = await hostFixture({ withTasks: true, scheduler });
  t.after(fixture.close);
  writeSizedFile(path.join(fixture.directory, 'a.bin'), 1024 * 1024);
  await mkdir(path.join(fixture.directory, 'dest'));
  const stats = await lstat(path.join(fixture.directory, 'a.bin'), { bigint: true });
  const digest = createHash('sha256').update(readFileSync(path.join(fixture.directory, 'a.bin'))).digest('hex');
  const expectedVersion = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}:${digest}`;

  const gate = gatedPermits(scheduler, 2);
  await delay(50);
  const started = await fixture.call('tasks.start', {
    operation: 'copy',
    items: [{ ...fixture.ref('a.bin'), expectedVersion }],
    destination: fixture.ref('dest'),
    conflict: 'skip',
  }, { route: 'manifest' });
  await delay(100);

  const before = scheduler.status();
  const queried = await Promise.race([fixture.call('tasks.get', { taskId: started.value.id }), delay(3000).then(() => 'timeout')]);
  const listed = await Promise.race([fixture.call('tasks.list'), delay(3000).then(() => 'timeout')]);
  const after = scheduler.status();
  record(evidence, 'scheduler-cancel', `status query active=${before.active}->${after.active} queued=${before.queued}->${after.queued} get=${queried.status} list=${listed.status}`);
  assert.notEqual(queried, 'timeout', 'a status query must not wait for a permit');
  assert.notEqual(listed, 'timeout', 'listing tasks must not wait for a permit');
  assert.equal(queried.status, 200);
  assert.equal(after.active, before.active, 'status queries must not take a permit');
  assert.ok(after.queued <= before.queued, 'status queries must not queue behind the pool');

  const cancelled = await Promise.race([fixture.call('tasks.cancel', { taskId: started.value.id }), delay(3000).then(() => 'timeout')]);
  record(evidence, 'scheduler-cancel', `cancel while both permits held -> ${cancelled === 'timeout' ? 'timeout' : `${cancelled.status} ${cancelled.value?.status}`}`);
  assert.notEqual(cancelled, 'timeout', 'cancelling a task blocked on a permit must not wait for one');
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.value.cancelRequested, true, 'the cancellation must be recorded even while the IO is blocked');
  assert.equal(scheduler.status().active, 2, 'cancellation must not consume or release another holder permit');

  // The status transition is observable once the blocked IO unwinds: release the gates
  // and the task must end as cancelled without publishing anything.
  for (const release of gate.releases) release();
  await Promise.allSettled(gate.started);
  const settled = await fixture.settle(started.value.id);
  record(evidence, 'scheduler-cancel', `after release: status=${settled.status}`);
  assert.equal(settled.status, 'cancelled', 'the cancelled task must finish as cancelled');
  assert.equal(existsSync(path.join(fixture.directory, 'dest', 'a.bin')), false, 'a cancelled task must publish nothing');
});

test('E3: the queue is bounded, failures release permits and nesting cannot deadlock', { skip: blocked }, async () => {
  const { createHeavyIoScheduler, DEFAULT_HEAVY_IO_CONCURRENCY, DEFAULT_HEAVY_IO_QUEUE_LIMIT } = await import('../dist/host/scheduler.js');
  assert.equal(DEFAULT_HEAVY_IO_CONCURRENCY, 2);
  assert.equal(DEFAULT_HEAVY_IO_QUEUE_LIMIT, 64);
  const scheduler = createHeavyIoScheduler({ concurrency: 2, queueLimit: 64 });
  const gate = gatedPermits(scheduler, 2);
  await delay(50);

  const waiters = [];
  for (let index = 0; index < 64; index++) waiters.push(scheduler.run(async () => index).catch(error => error.code ?? 'error'));
  await delay(50);
  const overflow = await scheduler.run(async () => 'ran').then(() => 'ran', error => error.code);
  record(evidence, 'scheduler-bounds', `queued=${scheduler.status().queued} overflow=${overflow}`);
  assert.equal(overflow, 'TOO_MANY_REQUESTS', 'the 65th waiter must be refused, not queued');
  assert.equal(scheduler.status().queued, 64, 'a refused waiter must not occupy the queue');
  for (const release of gate.releases) release();
  await Promise.allSettled([...gate.started, ...waiters]);

  // A failing operation must give its permit back.
  const activeBefore = scheduler.status().active;
  const failure = await scheduler.run(async () => { throw Object.assign(new Error('injected'), { code: 'EIO' }); }).then(() => 'resolved', error => error.code);
  const recovered = await scheduler.run(async () => 'ok');
  record(evidence, 'scheduler-bounds', `failure=${failure} active=${activeBefore}->${scheduler.status().active} recovered=${recovered}`);
  assert.equal(failure, 'EIO');
  assert.equal(recovered, 'ok', 'a failed operation must release its permit');
  assert.equal(scheduler.status().active, 0);

  // Nested acquisition inside one operation must reuse the same permit.
  const nested = createHeavyIoScheduler({ concurrency: 1, queueLimit: 1 });
  const nestedResult = await Promise.race([
    nested.run(async () => {
      const inner = await nested.run(async () => 'inner');
      return `outer:${inner}`;
    }),
    delay(3000).then(() => 'deadlock'),
  ]);
  record(evidence, 'scheduler-bounds', `nested=${nestedResult}`);
  assert.equal(nestedResult, 'outer:inner', 'nested heavy IO must reuse one permit instead of deadlocking');
  await nested.drain();
});
