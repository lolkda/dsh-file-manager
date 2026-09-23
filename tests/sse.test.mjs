import assert from 'node:assert/strict';
import test from 'node:test';
import { loadClientModule } from './client-module-loader.mjs';

const sse = () => loadClientModule('sse');

const encoder = new TextEncoder();
const streamOf = chunks => new Response(new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
    controller.close();
  },
}), { headers: { 'content-type': 'text/event-stream' } });

const collect = async (response, options = {}) => {
  const frames = [];
  await sse().then(module => module.consumeEvents(response, { onFrame: frame => { frames.push(frame); }, ...options }));
  return frames;
};

test('frames split across chunks are reassembled before they are delivered', async () => {
  const frames = await collect(streamOf(['data: {"kind":"inva', 'lidate","rootId":"root","seq":1}\n', '\n']));
  assert.deepEqual(frames, [{ kind: 'invalidate', rootId: 'root', seq: 1 }]);
});

test('several frames in one chunk are all delivered and comments are ignored', async () => {
  const frames = await collect(streamOf([
    ':keepalive\n\n',
    'data: {"kind":"ready","seq":1}\n\ndata: {"kind":"task","taskId":"t1","seq":2}\n\n',
    'data: {"kind":"transfer","taskId":"t2","seq":3}\n\n',
  ]));
  assert.deepEqual(frames.map(frame => frame.kind), ['ready', 'task', 'transfer']);
});

test('a truncated multi-byte tail is reported instead of being silently dropped', async () => {
  const { consumeEvents } = await sse();
  const truncated = new Uint8Array([...encoder.encode('data: {"kind":"invalidate","rootId":"ab'), 0xe4, 0xbd]);
  await assert.rejects(() => consumeEvents(streamOf([truncated]), { onFrame: () => {} }), { code: 'EVENT_STREAM_INVALID' });
});

test('a multi-byte payload split mid-character still decodes intact', async () => {
  const bytes = encoder.encode('data: {"kind":"invalidate","rootId":"目录"}\n\n');
  const frames = await collect(streamOf([bytes.slice(0, 40), bytes.slice(40)]));
  assert.equal(frames[0].rootId, '目录');
});

test('a malformed frame fails the stream instead of being ignored', async () => {
  const { consumeEvents } = await sse();
  await assert.rejects(() => consumeEvents(streamOf(['data: not-json\n\n']), { onFrame: () => {} }), { code: 'EVENT_STREAM_INVALID' });
  await assert.rejects(() => consumeEvents(streamOf(['data: {"seq":4}\n\n']), { onFrame: () => {} }), { code: 'EVENT_STREAM_INVALID' });
});

test('a response that is not an event stream is refused', async () => {
  const { consumeEvents } = await sse();
  await assert.rejects(() => consumeEvents(new Response('nope', { status: 503 }), { onFrame: () => {} }), { code: 'EVENT_STREAM_INVALID' });
  await assert.rejects(() => consumeEvents(new Response(null, { status: 200 }), { onFrame: () => {} }), { code: 'EVENT_STREAM_INVALID' });
});

test('an oversized frame is refused rather than buffered', async () => {
  const { consumeEvents } = await sse();
  const huge = `data: ${JSON.stringify({ kind: 'invalidate', rootId: 'x'.repeat(300000) })}\n\n`;
  await assert.rejects(() => consumeEvents(streamOf([huge]), { onFrame: () => {} }), { code: 'EVENT_STREAM_INVALID' });
});

test('aborting the subscription stops delivery and leaves no reader behind', async () => {
  const { consumeEvents } = await sse();
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream({
    start(streamController) {
      streamController.enqueue(encoder.encode('data: {"kind":"ready","seq":1}\n\n'));
    },
    cancel() { cancelled = true; },
  });
  const frames = [];
  const pending = consumeEvents(new Response(body), {
    signal: controller.signal,
    onFrame: frame => { frames.push(frame); controller.abort(); },
  });
  await pending;
  assert.equal(frames.length, 1);
  assert.equal(cancelled, true, 'the reader must be released so the connection is not leaked');
});

test('an awaited frame handler delays the next frame', async () => {
  const { consumeEvents } = await sse();
  const order = [];
  await consumeEvents(streamOf(['data: {"kind":"task","taskId":"t1","seq":1}\n\ndata: {"kind":"task","taskId":"t2","seq":2}\n\n']), {
    async onFrame(frame) {
      order.push(`start:${frame.taskId}`);
      await new Promise(resolve => setTimeout(resolve, 5));
      order.push(`end:${frame.taskId}`);
    },
  });
  assert.deepEqual(order, ['start:t1', 'end:t1', 'start:t2', 'end:t2']);
});

test('the sequence gate restarts with every connection', async () => {
  const { createFrameGate } = await sse();
  const gate = createFrameGate();
  assert.equal(gate.accept({ kind: 'ready', seq: 1 }), true);
  assert.equal(gate.accept({ kind: 'task', taskId: 't1', seq: 1 }), false, 'a replayed frame must not be handled twice');
  assert.equal(gate.accept({ kind: 'task', taskId: 't2', seq: 2 }), true);
  assert.equal(gate.accept({ kind: 'task', taskId: 't3', seq: 5 }), true);
  assert.equal(gate.sequence, 5);
  assert.equal(gate.accept({ kind: 'invalidate', rootId: 'root' }), true, 'a frame without a sequence is always delivered');
  gate.reset();
  assert.equal(gate.sequence, 0);
  assert.equal(gate.accept({ kind: 'ready', seq: 1 }), true, 'the server restarts its sequence for every connection');
});

test('a ready frame asks for a full resynchronization', async () => {
  const { classifyFrame } = await sse();
  assert.deepEqual(classifyFrame({ kind: 'ready', seq: 1 }), { kind: 'resync' });
  assert.deepEqual(classifyFrame({ kind: 'invalidate', rootId: 'root' }), { kind: 'invalidate', rootId: 'root' });
  assert.deepEqual(classifyFrame({ kind: 'task', taskId: 't1' }), { kind: 'task', taskId: 't1' });
  assert.deepEqual(classifyFrame({ kind: 'transfer', taskId: 't2' }), { kind: 'transfer', taskId: 't2' });
  assert.deepEqual(classifyFrame({ kind: 'watch-status', rootId: 'root', path: 'a', status: 'polling' }), { kind: 'watch-status', rootId: 'root', path: 'a', status: 'polling' });
  assert.deepEqual(classifyFrame({ kind: 'invalidate' }), { kind: 'ignore' });
  assert.deepEqual(classifyFrame({ kind: 'something-new' }), { kind: 'ignore' });
});

function fakeTimers() {
  let next = 0;
  const timers = new Map();
  return {
    setTimer(handler, ms) { const id = ++next; timers.set(id, { handler, ms }); return id; },
    clearTimer(id) { timers.delete(id); },
    fire() {
      const entry = [...timers.entries()][0];
      assert.ok(entry, 'a timer must be pending');
      timers.delete(entry[0]);
      entry[1].handler();
      return entry[1].ms;
    },
    pending: () => timers.size,
    delay: () => [...timers.values()][0]?.ms,
  };
}

test('the reconnect delay backs off and is capped', async () => {
  const { createRetryTimer } = await sse();
  const timers = fakeTimers();
  const timer = createRetryTimer({ base: 1000, max: 4000, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  assert.equal(timer.delay, 1000);
  const delays = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const pending = timer.wait();
    delays.push(timers.delay());
    timers.fire();
    await pending;
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 4000, 4000]);
  timer.reset();
  assert.equal(timer.delay, 1000, 'a ready frame restarts the backoff');
});

test('disposing the timer clears it and wakes the waiting loop', async () => {
  const { createRetryTimer } = await sse();
  const timers = fakeTimers();
  const timer = createRetryTimer({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const pending = timer.wait();
  assert.equal(timers.pending(), 1);
  timer.dispose();
  await pending;
  assert.equal(timers.pending(), 0, 'no timer may outlive the subscription');
  assert.equal(timer.disposed, true);
  await timer.wait();
  assert.equal(timers.pending(), 0, 'a disposed timer must never schedule another retry');
});