import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestLedger } from '../dist/host/requests.js';

function outcome(promise) {
  return promise.then(value => ({ value }), error => ({ error }));
}

test('a mutation without a usable requestId is refused before anything runs', async () => {
  const ledger = createRequestLedger();
  let ran = 0;
  for (const requestId of ['', 'short', 'x'.repeat(129), 7, null, undefined, { id: 'a'.repeat(8) }]) {
    const { error } = await outcome(Promise.resolve().then(() => ledger.run(requestId, { op: 'roots.add' }, async () => { ran++; })));
    assert.equal(error.code, 'INVALID_REQUEST', `requestId ${JSON.stringify(requestId)} must be refused`);
    assert.equal(error.status, 400);
  }
  assert.equal(ran, 0);
});

test('replaying a requestId with the same payload returns the original promise and runs the operation once', async () => {
  const ledger = createRequestLedger();
  let ran = 0;
  const operation = async () => { ran++; return { ok: ran }; };
  const first = ledger.run('replay-same-request', { op: 'entries.create-file', path: 'a' }, operation);
  const second = ledger.run('replay-same-request', { op: 'entries.create-file', path: 'a' }, operation);
  assert.equal(first, second, 'a replay must observe the original promise, not a new operation');
  assert.deepEqual(await first, { ok: 1 });
  assert.equal(ran, 1);
  const third = ledger.run('replay-same-request', { op: 'entries.create-file', path: 'a' }, operation);
  assert.deepEqual(await third, { ok: 1 }, 'a replay after settlement must not run the operation again');
  assert.equal(ran, 1);
});

test('the fingerprint ignores field order but not a changed payload', async () => {
  const ledger = createRequestLedger();
  const reordered = ledger.run('order-insensitive-id', { path: 'a', op: 'roots.add' }, async () => 'first');
  const sameOperation = ledger.run('order-insensitive-id', { op: 'roots.add', path: 'a' }, async () => 'second');
  assert.equal(await reordered, 'first');
  assert.equal(await sameOperation, 'first', 'the same fields in another order are the same operation');
  const { error } = await outcome(Promise.resolve().then(() => ledger.run('order-insensitive-id', { op: 'roots.add', path: 'b' }, async () => 'third')));
  assert.equal(error.code, 'REQUEST_ID_REUSED');
  assert.equal(error.status, 409);
});

test('the requestId argument itself is not part of the fingerprint', async () => {
  const ledger = createRequestLedger();
  const first = await ledger.run('fingerprint-scope-id', { op: 'roots.add', path: 'a', requestId: 'fingerprint-scope-id' }, async () => 'ran');
  assert.equal(first, 'ran');
  const replay = await ledger.run('fingerprint-scope-id', { op: 'roots.add', path: 'a', requestId: 'fingerprint-scope-id' }, async () => 'again');
  assert.equal(replay, 'ran');
});

test('a failed operation still settles, so its replay reports the same failure instead of rerunning', async () => {
  const ledger = createRequestLedger();
  let attempts = 0;
  const failing = async () => { attempts++; throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); };
  const first = await outcome(ledger.run('failing-request-id', { op: 'roots.add', path: 'a' }, failing));
  assert.equal(first.error.code, 'ENOSPC');
  const replay = await outcome(ledger.run('failing-request-id', { op: 'roots.add', path: 'a' }, failing));
  assert.equal(replay.error.code, 'ENOSPC');
  assert.equal(attempts, 1);
});

test('a full retry window refuses further mutations with a 429', async () => {
  const ledger = createRequestLedger({ capacity: 2 });
  await ledger.run('capacity-request-one', { op: 'a' }, async () => 1);
  await ledger.run('capacity-request-two', { op: 'b' }, async () => 2);
  const { error } = await outcome(Promise.resolve().then(() => ledger.run('capacity-request-three', { op: 'c' }, async () => 3)));
  assert.equal(error.code, 'TOO_MANY_REQUESTS');
  assert.equal(error.status, 429);
  assert.equal(await ledger.run('capacity-request-one', { op: 'a' }, async () => 1), 1, 'a known requestId still replays while the window is full');
});

test('the default retry window holds 256 mutations', async () => {
  const ledger = createRequestLedger();
  for (let index = 0; index < 256; index++) await ledger.run(`default-capacity-${String(index).padStart(4, '0')}`, { op: 'a', index }, async () => index);
  const { error } = await outcome(Promise.resolve().then(() => ledger.run('default-capacity-overflow', { op: 'a' }, async () => 256)));
  assert.equal(error.code, 'TOO_MANY_REQUESTS');
});

test('an expired settled entry frees its requestId and its capacity', async () => {
  let clock = 1000;
  const ledger = createRequestLedger({ capacity: 1, ttlMs: 500, now: () => clock });
  await ledger.run('expiring-request-id', { op: 'a' }, async () => 'first');
  const { error } = await outcome(Promise.resolve().then(() => ledger.run('other-request-id', { op: 'b' }, async () => 'other')));
  assert.equal(error.code, 'TOO_MANY_REQUESTS', 'the window is still occupied before the TTL elapses');
  clock += 501;
  assert.equal(await ledger.run('other-request-id', { op: 'b' }, async () => 'other'), 'other', 'the expired entry must free the window');
  clock += 501;
  assert.equal(await ledger.run('expiring-request-id', { op: 'a' }, async () => 'second'), 'second', 'the expired requestId may be reused for another payload');
});

test('an entry that is still running never expires, even past its TTL', async () => {
  let clock = 0;
  let release;
  const ledger = createRequestLedger({ capacity: 1, ttlMs: 10, now: () => clock });
  const running = ledger.run('running-request-id', { op: 'a' }, () => new Promise(resolve => { release = resolve; }));
  clock += 10000;
  const { error } = await outcome(Promise.resolve().then(() => ledger.run('another-request-id', { op: 'b' }, async () => 'b')));
  assert.equal(error.code, 'TOO_MANY_REQUESTS', 'an unsettled entry must not be reclaimed by age');
  release('finished');
  assert.equal(await running, 'finished');
});
