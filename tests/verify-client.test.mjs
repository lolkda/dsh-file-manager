/**
 * task-6 independent Client-side verification.
 *
 * These cases exist because the rest of the verification plan covers the Host and the
 * frozen contract only: the Client was a blind spot. They are written against the
 * shipped `dist/client.js` with this suite's own harness (`verify-client-harness.mjs`),
 * its own HTTP stub and its own observation points, so they are not a restatement of
 * the author's tests — each assertion names the rendered attribute or recorded request
 * it reads.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { applyClient, mainCell, render, settle, textIncludes, textsOf, withAttribute, act, React } from './verify-client-harness.mjs';

const evidenceRoot = path.join(process.cwd(), 'docs', 'verification', 'task6-client');
const evidence = (() => { if (!existsSync(evidenceRoot)) mkdirSync(evidenceRoot, { recursive: true }); return evidenceRoot; })();
const record = (testCase, line) => {
  writeFileSync(path.join(evidence, `${testCase}.log`), `${line}\n`, { flag: 'a' });
};

const blocked = existsSync(path.join(process.cwd(), 'dist', 'client.js'))
  ? false
  : 'dist/client.js is missing: run `npm run build` before the Client verification suite';

const FILE = { name: 'normal.txt', path: 'normal.txt', kind: 'file', size: 5, modifiedAt: '2026-01-01T00:00:00.000Z', version: '1:2:3:4:5', mode: 420 };
const FOLDER = { name: 'folder', path: 'folder', kind: 'directory', size: 0, modifiedAt: '2026-01-01T00:00:00.000Z', version: '1:2:3:4:5', mode: 493 };

const capabilitiesOf = (overrides = {}) => ({ write: true, tasks: true, taskHistory: true, watch: true, upload: true, references: true, ...overrides });
const bootstrapOf = ({ degraded = null, capabilities = capabilitiesOf() } = {}) => ({ ok: true, value: {
  roots: [{ id: 'root-1', path: '/tmp/root', name: 'root' }], workspaces: [], version: 1, stage: 'basic-management', limits: {}, capabilities, degraded,
} });
const listingOf = ({ entries = [FILE, FOLDER], unaddressable = [], nextCursor = null } = {}) => ({ ok: true, value: {
  rootId: 'root-1', path: '', total: entries.length, nextCursor, entries, unaddressable,
} });

/** A stub Host: every answer is explicit, so a missing expectation is a test defect. */
function hostStub({ bootstrap = bootstrapOf(), listing = listingOf(), tasks = { ok: true, value: { items: [], revision: 0 } }, onRequest } = {}) {
  return ({ url, body }) => {
    if (onRequest) { const override = onRequest({ url, body }); if (override) return override; }
    if (body?.op === 'bootstrap') return { body: bootstrap };
    if (body?.op === 'entries.list') return { body: typeof listing === 'function' ? listing(body) : listing };
    if (body?.op === 'tasks.list') return { body: tasks };
    if (url.includes('/v2/events')) return { status: 200, body: '', headers: { 'content-type': 'text/event-stream' } };
    return { body: { ok: true, value: {} } };
  };
}

async function mount(harness, props = {}) {
  const main = mainCell(harness);
  const renderer = await render(main.component, { t: harness.t, ...(main.registration.inject?.() ?? {}), ...props });
  await settle(renderer);
  return { main, renderer };
}

test('Client verification prerequisites are present', { skip: blocked }, async () => {
  const harness = await applyClient({ respond: hostStub() });
  const keys = [...harness.cells.keys()];
  record('prerequisites', `cells=${keys.join(',')}`);
  assert.ok(keys.some(key => key.startsWith('main:')), 'the shipped Client must register a main panel cell');
  assert.equal(harness.client.apply instanceof Function, true);
  await harness.dispose();
});

test('C1: a late useSessions hook is actually used, not merely survived', { skip: blocked }, async () => {
  const harness = await applyClient({ respond: hostStub() });
  try {
    const { main, renderer } = await mount(harness);
    const referenceButton = () => renderer.root.findAll(node => typeof node.type === 'string' && node.props['data-fm-action'] === 'reference', { deep: true })[0];
    assert.ok(referenceButton(), 'the panel must render a reference action');
    record('c1-late-hook', `without the hook: reference disabled=${referenceButton().props.disabled}`);
    assert.equal(referenceButton().props.disabled, true, 'with no session catalog the reference action must be unavailable');
    assert.equal(withAttribute(renderer, 'data-fm-reference-session').length, 0, 'no session picker may render without a catalog');

    // The hook arrives later (the session service resolves after mount). It must be a
    // real hook: a plain function would itself change the hook order, which is not the
    // scenario under test.
    const calls = [];
    const catalog = { ids: ['s1', 's2'], byId: { s1: { id: 's1', displayTitle: 'Session one' }, s2: { id: 's2', displayTitle: 'Session two' } }, phase: 'ready' };
    const store = {
      value: catalog,
      listeners: new Set(),
      subscribe(listener) { store.listeners.add(listener); return () => store.listeners.delete(listener); },
      getSnapshot() { return store.value; },
    };
    const useSessions = selector => React.useSyncExternalStore(store.subscribe, () => { calls.push(1); return selector(store.getSnapshot()); });
    await act(async () => {
      renderer.update(React.createElement(main.component, { t: harness.t, ...(main.registration.inject?.() ?? {}), useSessions }));
    });
    await settle(renderer);
    record('c1-late-hook', `hook calls=${calls.length} reference disabled=${referenceButton().props.disabled}`);
    assert.ok(calls.length > 0, 'the panel must call the late-arriving hook');

    // Selecting an entry is required before referencing it to a session.
    const row = withAttribute(renderer, 'data-fm-entry')[0];
    assert.ok(row, 'the listing must render a selectable entry');
    await act(async () => { row.props.onClick({ preventDefault() {}, stopPropagation() {} }); });
    await settle(renderer);
    assert.equal(referenceButton().props.disabled, false, 'with a catalog and a selection the reference action must be enabled');

    // Strongest observation: the hook's own data reaches the rendered session picker.
    await act(async () => { referenceButton().props.onClick({ preventDefault() {}, stopPropagation() {} }); });
    await settle(renderer);
    const select = withAttribute(renderer, 'data-fm-reference-session')[0];
    record('c1-late-hook', `picker=${select ? 'rendered' : 'missing'}`);
    assert.ok(select, 'the reference flow must render a session picker once a catalog exists');
    const options = select.findAll(node => node.type === 'option', { deep: true }).map(node => node.props.value);
    const sessionIds = options.filter(value => value !== '' && value !== undefined);
    record('c1-late-hook', `options=${options.join(',')} sessionIds=${sessionIds.join(',')}`);
    assert.deepEqual(sessionIds, ['s1', 's2'], 'the picker must list exactly the sessions the late hook supplied');
  } finally {
    await harness.dispose();
  }
});

test('C2: paging never re-requests a cursor and never repeats a row', { skip: blocked }, async () => {
  const second = { ...FILE, name: 'second.txt', path: 'second.txt' };
  const harness = await applyClient({ respond: hostStub({
    listing: body => body.cursor === 'cursor-1' ? listingOf({ entries: [second] }) : listingOf({ entries: [FILE], nextCursor: 'cursor-1' }),
  }) });
  try {
    const { renderer } = await mount(harness);
    const paths = () => withAttribute(renderer, 'data-fm-path').map(node => node.props['data-fm-path']);
    assert.deepEqual(paths(), ['normal.txt'], 'the first page must render');

    const more = () => renderer.root.findAll(node => typeof node.type === 'string' && node.props['data-fm-action'] === 'more', { deep: true })[0];
    assert.ok(more(), 'a listing with nextCursor must offer a paging action');

    // Two clicks in the same frame: the defect reused one cursor for both appends.
    await act(async () => {
      more().props.onClick({ preventDefault() {}, stopPropagation() {} });
      more().props.onClick({ preventDefault() {}, stopPropagation() {} });
    });
    await settle(renderer, 6);

    const cursors = harness.requests.filter(request => request.body?.op === 'entries.list').map(request => request.body.cursor ?? '<none>');
    record('c2-paging', `list cursors=${cursors.join(',')} paths=${paths().join(',')}`);
    assert.equal(cursors.filter(cursor => cursor === 'cursor-1').length, 1, 'the same cursor must never be requested twice');
    assert.equal(new Set(cursors).size, cursors.length, 'every page request must use a distinct cursor');
    assert.deepEqual(paths(), ['normal.txt', 'second.txt'], 'the second page must append without duplicating rows');
    assert.equal(new Set(paths()).size, paths().length, 'no rendered row may repeat');
  } finally {
    await harness.dispose();
  }
});

test('C3: a deliberate cancellation is never reported as an IO fault', { skip: blocked }, async () => {
  const harness = await applyClient({ respond: hostStub() });
  try {
    const cancellation = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError', code: 'ABORT_ERR' });
    const domCancellation = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const codes = [harness.client.i18n.failureCode(cancellation), harness.client.i18n.failureCode(domCancellation)];
    const rawCodes = [harness.client.api.failureCodeOf(cancellation), harness.client.api.failureCodeOf(domCancellation)];
    const messages = [harness.t, cancellation, domCancellation].length && [
      harness.client.i18n.errorMessage(harness.t, cancellation),
      harness.client.i18n.errorMessage(harness.t, domCancellation),
    ];
    record('c3-cancellation', `i18n.failureCode=${codes.join(',')} raw failureCodeOf=${rawCodes.map(code => String(code)).join(',')} messages=${messages.map(message => JSON.stringify(message)).join(',')}`);
    for (const code of codes) assert.equal(code, 'CANCELLED', `a deliberate cancellation must classify as CANCELLED, got ${code}`);
    const ioText = harness.client.i18n.errorMessage(harness.t, Object.assign(new Error('boom'), { code: 'EIO' }));
    for (const message of messages) assert.notEqual(message, ioText, 'a cancellation must not borrow the generic IO fault text');

    // And the panel must not paint a cancellation as an IO fault either.
    const failing = await applyClient({ respond: hostStub({ onRequest: ({ body }) => {
      if (body?.op === 'entries.list') throw cancellation;
      return undefined;
    } }) });
    try {
      const { renderer } = await mount(failing);
      const texts = textsOf(renderer);
      record('c3-cancellation', `panel shows io fault=${texts.some(text => text.includes(ioText))} shows cancellation=${texts.some(text => text.includes(messages[0]))}`);
      assert.equal(texts.some(text => text.includes(ioText)), false, 'a cancelled listing must not render the generic IO fault text');
    } finally {
      await failing.dispose();
    }
  } finally {
    await harness.dispose();
  }
});

test('C6: a truncated multibyte SSE tail is reported, never silently dropped', { skip: blocked }, async () => {
  const harness = await applyClient({ respond: hostStub() });
  try {
    const frames = [];
    const encoder = new TextEncoder();
    const good = encoder.encode('data: {"seq":1,"kind":"heartbeat"}\n\n');
    const truncated = Uint8Array.from([0xe4, 0xb8]); // first two bytes of a three-byte character
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(good); controller.enqueue(truncated); controller.close(); },
    });
    const outcome = await harness.client.sse.consumeEvents(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), { onFrame: frame => frames.push(frame) })
      .then(() => 'resolved', error => error);
    const code = typeof outcome === 'string' ? outcome : (outcome.code ?? outcome.name);
    record('c6-sse-flush', `outcome=${typeof outcome === 'string' ? outcome : String(outcome.message)} code=${code} frames=${JSON.stringify(frames)}`);
    assert.notEqual(outcome, 'resolved', 'a truncated tail must be reported as a stream error');
    assert.equal(frames.length, 1, 'the complete frame before the truncated tail must still be delivered');
    assert.equal(frames[0].seq, 1);
    assert.equal(JSON.stringify(frames).includes('\uFFFD'), false, 'no replacement character may be emitted for the truncated tail');
  } finally {
    await harness.dispose();
  }
});

test('R18: unexpressible entries render with a reason and no usable path', { skip: blocked }, async () => {
  const special = { name: 'bad\\name', kind: 'file', reason: 'it contains control characters or a backslash' };
  const harness = await applyClient({ respond: hostStub({ listing: listingOf({ entries: [FILE, FOLDER], unaddressable: [special] }) }) });
  try {
    const { renderer } = await mount(harness);
    const paths = withAttribute(renderer, 'data-fm-path').map(node => node.props['data-fm-path']);
    record('r18-render', `paths=${paths.join(',')} unaddressable=${withAttribute(renderer, 'data-fm-unaddressable-name').map(node => node.props['data-fm-unaddressable-name']).join(',')}`);
    assert.deepEqual(paths, ['normal.txt', 'folder'], 'expressible entries must render normally');
    assert.equal(paths.includes(special.name), false, 'an unexpressible name must never become a usable path');

    const named = withAttribute(renderer, 'data-fm-unaddressable-name');
    assert.equal(named.length, 1, 'the unexpressible entry must still be listed');
    assert.equal(named[0].props['data-fm-unaddressable-name'], special.name, 'it must be identified by name');
    assert.equal(textIncludes(renderer, special.reason), true, 'its reason must be shown to the user');
    const actions = named[0].findAll(node => typeof node.type === 'string' && node.props['data-fm-action'] !== undefined, { deep: true });
    assert.equal(actions.length, 0, 'an unexpressible entry must offer no operation entry point');
  } finally {
    await harness.dispose();
  }
});

test('R17: a degraded Host explains why, and unavailable history is not rendered as empty', { skip: blocked }, async () => {
  // The harness installs process-wide globals, so the two scenarios must run one at a
  // time rather than sharing `globalThis.fetch`.
  const unavailable = await applyClient({ respond: hostStub({
    bootstrap: bootstrapOf({ degraded: { scope: 'operations', code: 'INITIALIZATION_FAILED', message: '操作记录不可用', readOnly: true }, capabilities: capabilitiesOf({ write: false, tasks: false, taskHistory: false, upload: false }) }),
    tasks: { status: 503, body: { ok: false, error: { code: 'FILE_MANAGER_UNAVAILABLE', message: 'history unavailable', details: { scope: 'operations' } } } },
  }) });
  let degraded;
  try {
    degraded = await mount(unavailable);
    const degradedTexts = textsOf(degraded.renderer);
    const notice = degradedTexts.find(text => text.includes('任务历史不可用'));
    record('r17-degraded', `degraded notice=${JSON.stringify(notice)} shows reason=${degradedTexts.some(text => text.includes('操作记录不可用'))}`);
    assert.ok(notice, 'a degraded Host must say that history is unavailable instead of showing an empty history');
    assert.equal(degradedTexts.some(text => text.includes('操作记录不可用')), true, 'the degradation reason must reach the user');
    const writeActions = degraded.renderer.root.findAll(node => typeof node.type === 'string' && ['new-file', 'new-directory', 'rename', 'delete', 'upload-files'].includes(node.props['data-fm-action']), { deep: true });
    record('r17-degraded', `write actions rendered=${writeActions.length}`);
    assert.equal(writeActions.every(node => node.props.disabled === true), true, 'a read-only degradation must disable the write actions');
  } finally {
    await unavailable.dispose();
  }

  const healthy = await applyClient({ respond: hostStub() });
  try {
    // Differential: the same empty history without degradation shows no such notice.
    const plain = await mount(healthy);
    const plainTexts = textsOf(plain.renderer);
    record('r17-degraded', `healthy notice=${plainTexts.some(text => text.includes('任务历史不可用'))}`);
    assert.equal(plainTexts.some(text => text.includes('任务历史不可用')), false, 'a healthy empty history must not claim to be unavailable');
  } finally {
    await healthy.dispose();
  }
});
