import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHeavyIoScheduler,
  sharedHeavyIoScheduler,
  DEFAULT_HEAVY_IO_CONCURRENCY,
  DEFAULT_HEAVY_IO_QUEUE_LIMIT,
} from '../dist/host/scheduler.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

/** Let queued microtasks and immediately-scheduled callbacks run to completion. */
async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index++) await new Promise(resolve => setImmediate(resolve));
}

function outcome(promise) {
  return promise.then(value => ({ value }), error => ({ error }));
}

function guard(promise, message) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), 2000);
      timer.unref?.();
    }),
  ]);
}

test('the shared heavy-IO scheduler defaults to two permits and a 64-entry wait queue', () => {
  const scheduler = createHeavyIoScheduler();
  const status = scheduler.status();
  assert.equal(status.concurrency, DEFAULT_HEAVY_IO_CONCURRENCY);
  assert.equal(status.concurrency, 2);
  assert.equal(status.queueLimit, DEFAULT_HEAVY_IO_QUEUE_LIMIT);
  assert.equal(status.queueLimit, 64);
  assert.equal(status.active, 0);
  assert.equal(status.queued, 0);
});

test('the scheduler rejects an unusable concurrency or queue limit instead of running unbounded', () => {
  for (const options of [{ concurrency: 0 }, { concurrency: -1 }, { concurrency: 1.5 }, { queueLimit: 0 }, { queueLimit: 2.5 }]) {
    assert.throws(() => createHeavyIoScheduler(options), error => error.code === 'INVALID_STATE' && error.status === 500, `expected ${JSON.stringify(options)} to be rejected`);
  }
});

test('heavy operations never exceed the concurrency limit and the remainder waits in order', async () => {
  const scheduler = createHeavyIoScheduler({ concurrency: 2, queueLimit: 64 });
  const gates = Array.from({ length: 5 }, () => deferred());
  let active = 0;
  let peak = 0;
  const results = gates.map((gate, index) => scheduler.run(async () => {
    active++;
    peak = Math.max(peak, active);
    await gate.promise;
    active--;
    return index;
  }));
  await settle();
  assert.equal(scheduler.status().active, 2);
  assert.equal(scheduler.status().queued, 3);
  assert.equal(active, 2);
  for (const gate of gates) gate.resolve();
  assert.deepEqual(await guard(Promise.all(results), 'the queue never drained'), [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
  assert.equal(scheduler.status().active, 0);
  assert.equal(scheduler.status().queued, 0);
});

test('a queued operation cancelled through its signal is rejected as CANCELLED and never runs', async () => {
  const scheduler = createHeavyIoScheduler({ concurrency: 1, queueLimit: 64 });
  const gate = deferred();
  const first = scheduler.run(() => gate.promise);
  const controller = new AbortController();
  let ran = false;
  const queued = outcome(scheduler.run(async () => { ran = true; return 'queued'; }, { signal: controller.signal }));
  await settle();
  assert.equal(scheduler.status().queued, 1);
  controller.abort();
  const { error } = await guard(queued, 'a cancelled queued operation never settled');
  assert.equal(error.code, 'CANCELLED');
  assert.equal(error.status, 499);
  assert.equal(ran, false);
  assert.equal(scheduler.status().queued, 0);
  gate.resolve('first');
  assert.equal(await first, 'first');
});

test('an operation queued behind an already-aborted signal is rejected without taking a permit', async () => {
  const scheduler = createHeavyIoScheduler({ concurrency: 1, queueLimit: 1 });
  const gate = deferred();
  const held = scheduler.run(() => gate.promise);
  const controller = new AbortController();
  controller.abort();
  const { error } = await outcome(scheduler.run(async () => 'never', { signal: controller.signal }));
  assert.equal(error.code, 'CANCELLED');
  assert.equal(scheduler.status().queued, 0);
  gate.resolve('held');
  assert.equal(await held, 'held');
});

test('cancelling a submitted handle while it waits releases the queue slot and does not consume a permit', async () => {
  const scheduler = createHeavyIoScheduler({ concurrency: 1, queueLimit: 1 });
  const gate = deferred();
  const held = scheduler.run(() => gate.promise);
  await settle();
  const handle = scheduler.submit(async () => 'queued');
  const settled = outcome(handle.promise);
  for (let index = 0; index < 5; index++) scheduler.status();
  handle.cancel();
  await settle();
  const { error } = await guard(settled, 'a cancelled handle never settled');
  assert.equal(error.code, 'CANCELLED');
  assert.equal(scheduler.status().queued, 0);
  const next = scheduler.submit(async () => 'next');
  assert.equal(scheduler.status().queued, 1, 'the released queue slot must be reusable');
  gate.resolve('held');
  assert.equal(await held, 'held');
  assert.equal(await guard(next.promise, 'the replacement queued operation never ran'), 'next');
});

test('a full wait queue rejects the surplus operation with a 429 instead of growing without bound', async () => {
  const scheduler = createHeavyIoScheduler({ concurrency: 1, queueLimit: 2 });
  const gate = deferred();
  const held = scheduler.run(() => gate.promise);
  const queued = [scheduler.run(async () => 'one'), scheduler.run(async () => 'two')];
  await settle();
  assert.equal(scheduler.status().queued, 2);
  const { error } = await outcome(scheduler.run(async () => 'three'));
  assert.equal(error.code, 'TOO_MANY_REQUESTS');
  assert.equal(error.status, 429);
  assert.equal(scheduler.status().queued, 2, 'the rejected operation must not occupy a queue slot');
  gate.resolve('held');
  assert.equal(await held, 'held');
  assert.deepEqual(await guard(Promise.all(queued), 'the admitted queue never drained'), ['one', 'two']);
  assert.equal(await scheduler.run(async () => 'after'), 'after');
});

test('a throwing operation still releases its permit', async () => {
  const scheduler = createHeavyIoScheduler({ concurrency: 1, queueLimit: 4 });
  const failure = await outcome(scheduler.run(async () => { throw new Error('boom'); }));
  assert.equal(failure.error.message, 'boom');
  assert.equal(scheduler.status().active, 0);
  assert.equal(await scheduler.run(async () => 'after failure'), 'after failure');
  const second = await outcome(scheduler.run(async () => { throw Object.assign(new Error('again'), { code: 'EIO' }); }));
  assert.equal(second.error.code, 'EIO');
  assert.equal(await scheduler.run(async () => 'still free'), 'still free');
});

test('a nested heavy operation reuses the permit it already holds instead of deadlocking', async () => {
  const scheduler = createHeavyIoScheduler({ concurrency: 1, queueLimit: 4 });
  const gate = deferred();
  const observations = [];
  const outer = scheduler.run(async () => {
    observations.push(['outer-start', scheduler.status().active, scheduler.status().queued]);
    const inner = await scheduler.run(async () => 'inner');
    observations.push(['after-inner', scheduler.status().active, scheduler.status().queued]);
    await gate.promise;
    return `outer:${inner}`;
  });
  const competing = scheduler.run(async () => 'competing');
  await settle();
  assert.equal(observations.length, 2);
  const [start, after] = observations;
  assert.deepEqual(start, ['outer-start', 1, 1], 'the outer operation holds the only permit; the competing operation waits');
  assert.deepEqual(after, ['after-inner', 1, 1], 'the nested call must not take a permit or join the wait queue');
  assert.equal(scheduler.status().active, 1);
  assert.equal(scheduler.status().queued, 1, 'the competing operation must still be waiting behind the held permit');
  gate.resolve();
  assert.equal(await guard(outer, 'a nested heavy operation deadlocked'), 'outer:inner');
  assert.equal(await guard(competing, 'the competing operation never ran'), 'competing');
  assert.equal(scheduler.status().active, 0);
  assert.equal(scheduler.status().queued, 0);
});

test('a detached continuation that outlives its permit waits for a fresh permit', async () => {
  const scheduler = createHeavyIoScheduler({ concurrency: 1, queueLimit: 4 });
  const inner = deferred();
  let detached = null;
  await scheduler.run(async () => {
    detached = (async () => {
      await inner.promise;
      return scheduler.run(async () => 'detached');
    })();
  });
  const holder = deferred();
  const blocker = scheduler.run(() => holder.promise);
  await settle();
  assert.equal(scheduler.status().active, 1);
  inner.resolve();
  await settle();
  assert.equal(scheduler.status().queued, 1, 'a released permit must not be reused by a detached continuation');
  holder.resolve('blocker');
  assert.equal(await guard(detached, 'the detached nested operation never ran'), 'detached');
  assert.equal(await blocker, 'blocker');
  assert.equal(scheduler.status().active, 0);
});

test('every caller that asks for the shared budget gets the same scheduler', async () => {
  const first = sharedHeavyIoScheduler();
  const second = sharedHeavyIoScheduler();
  assert.equal(first, second);
  const gate = deferred();
  const running = [first.run(() => gate.promise), first.run(() => gate.promise), second.run(() => gate.promise)];
  await settle();
  assert.equal(second.status().active, 2, 'the shared budget must not be multiplied per caller');
  assert.equal(second.status().queued, 1);
  gate.resolve('done');
  assert.deepEqual(await guard(Promise.all(running), 'the shared budget never drained'), ['done', 'done', 'done']);
});

test('drain resolves only after every admitted operation has settled', async () => {
  const scheduler = createHeavyIoScheduler({ concurrency: 2, queueLimit: 4 });
  const gate = deferred();
  const running = [scheduler.run(() => gate.promise), scheduler.run(() => gate.promise), scheduler.run(() => gate.promise)];
  await settle();
  let drained = false;
  const draining = scheduler.drain().then(() => { drained = true; });
  await settle();
  assert.equal(drained, false);
  gate.resolve('done');
  await guard(draining, 'drain never settled');
  assert.equal(drained, true);
  assert.deepEqual(await Promise.all(running), ['done', 'done', 'done']);
});

test('an explicitly acquired permit is held until it is released', async () => {
  const scheduler = createHeavyIoScheduler({ concurrency: 1, queueLimit: 4 });
  const permit = await scheduler.acquire();
  assert.equal(scheduler.status().active, 1);
  const queued = scheduler.run(async () => 'queued');
  await settle();
  assert.equal(scheduler.status().queued, 1, 'the held permit must block the next operation');
  permit.release();
  await settle();
  assert.equal(scheduler.status().queued, 0, 'releasing the permit must admit the waiting operation');
  assert.equal(await guard(queued, 'the queued operation never ran'), 'queued');
  assert.equal(scheduler.status().active, 0);
});

test('releasing a permit twice frees only one slot', async () => {
  const scheduler = createHeavyIoScheduler({ concurrency: 1, queueLimit: 4 });
  const permit = await scheduler.acquire();
  permit.release();
  permit.release();
  assert.equal(scheduler.status().active, 0);
  const gate = deferred();
  const first = scheduler.run(() => gate.promise);
  const second = scheduler.run(async () => 'second');
  await settle();
  assert.equal(scheduler.status().active, 1);
  assert.equal(scheduler.status().queued, 1, 'a double release must not admit two operations');
  gate.resolve('first');
  assert.equal(await first, 'first');
  assert.equal(await guard(second, 'the second operation never ran'), 'second');
});

test('a nested acquire reuses the held permit and releasing it keeps the permit', async () => {
  const scheduler = createHeavyIoScheduler({ concurrency: 1, queueLimit: 4 });
  const competing = deferred();
  const gate = deferred();
  let nestedReleased = false;
  const outer = scheduler.run(async () => {
    const nested = await scheduler.acquire();
    assert.equal(scheduler.status().active, 1, 'a nested acquire must not take a second permit');
    nested.release();
    nestedReleased = true;
    assert.equal(scheduler.status().active, 1, 'releasing a nested permit must not free the outer permit');
    await gate.promise;
    return 'outer';
  });
  const blocked = scheduler.run(() => competing.promise);
  await settle();
  assert.equal(nestedReleased, true);
  assert.equal(scheduler.status().active, 1);
  assert.equal(scheduler.status().queued, 1, 'the outer permit must still block the competitor');
  gate.resolve();
  assert.equal(await guard(outer, 'the outer operation never finished'), 'outer');
  assert.equal(scheduler.status().active, 1, 'the competitor took the permit after the outer operation finished');
  competing.resolve('blocked');
  assert.equal(await blocked, 'blocked');
});

test('waiting for a permit can be cancelled and gives its queue slot back', async () => {
  const scheduler = createHeavyIoScheduler({ concurrency: 1, queueLimit: 1 });
  const held = await scheduler.acquire();
  const controller = new AbortController();
  const waiting = outcome(scheduler.acquire({ signal: controller.signal }));
  await settle();
  assert.equal(scheduler.status().queued, 1);
  controller.abort();
  const { error } = await guard(waiting, 'a cancelled permit wait never settled');
  assert.equal(error.code, 'CANCELLED');
  assert.equal(scheduler.status().queued, 0);
  held.release();
  const replacement = await scheduler.acquire();
  assert.equal(scheduler.status().active, 1);
  replacement.release();
});

test('waiting for a permit past the queue limit is refused with a 429', async () => {
  const scheduler = createHeavyIoScheduler({ concurrency: 1, queueLimit: 1 });
  const held = await scheduler.acquire();
  const admitted = scheduler.acquire();
  const { error } = await outcome(scheduler.acquire());
  assert.equal(error.code, 'TOO_MANY_REQUESTS');
  assert.equal(error.status, 429);
  assert.equal(scheduler.status().queued, 1);
  held.release();
  (await admitted).release();
});
