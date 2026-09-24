/**
 * The reference dialog renders a Host-supplied plan as a React list.
 *
 * A Host answer that omits `mention` (or repeats one) must not make the dialog
 * emit React's list warnings: the plan is a snapshot the dialog only displays,
 * so its rows are keyed by position and a malformed answer stays a rendering
 * defect of the Host, not of the list.
 *
 * The assertion is on React's own report plus the rows that actually rendered;
 * the warning wording itself is not the contract.
 */

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { act, node, nodes, setup, snapshotBoundary, textOf } from './client-harness.mjs';

/** Collects React's list diagnostics for one test and restores the console after it. */
function listWarnings(t) {
  const seen = [];
  const original = console.error;
  console.error = (...args) => { seen.push(args.map(value => String(value)).join(' ')); };
  t.after(() => { console.error = original; });
  return () => seen.filter(message => /unique "key"|same key/.test(message));
}

const sessionCatalog = () => snapshotBoundary({
  ids: ['target'],
  byId: { target: { id: 'target', displayTitle: 'Target session', running: false } },
  phase: 'ready',
});

/**
 * Opens the reference dialog over the real panel. `answer` produces the raw
 * `entries.reference` envelope for the n-th request, so a case can control both
 * the shape and the repeat count of the Host answer.
 */
async function openReferenceDialog(t, answer, { selectSecondEntry = false } = {}) {
  let requests = 0;
  const view = await setup(t, {
    seed: root => writeFile(path.join(root, 'folder', 'second.txt'), 'second\n'),
    mainProps: { useSessions: sessionCatalog().use },
    intercept: async (url, init, route) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      if (body?.op === 'entries.reference') return new Response(JSON.stringify(answer(requests++)), { headers: { 'content-type': 'application/json' } });
      return route(url, init);
    },
  });
  await view.openHello();
  if (selectSecondEntry) {
    act(() => node(view.renderer, { type: 'checkbox', 'aria-label': '选择: second.txt' }).props.onChange({ target: { checked: true } }));
  }
  await view.click({ 'data-fm-action': 'reference' });
  return view;
}

const dialog = view => node(view.renderer, { role: 'dialog' });
const reference = mention => ({ ok: true, value: { rootId: 'root-1', path: 'folder/hello.txt', kind: 'file', absolutePath: '/tmp/root/folder/hello.txt', mention } });

test('a reference answer without a mention still keys every plan row', async t => {
  const warnings = listWarnings(t);
  const view = await openReferenceDialog(t, () => ({ ok: true, value: {} }));
  assert.ok(dialog(view), 'the dialog must still open on a Host answer that omits the mention');
  assert.deepEqual(warnings(), [], 'a plan row without a mention must not produce an unkeyed list child');
});

test('two plan rows carrying the same mention do not collide as React keys', async t => {
  const warnings = listWarnings(t);
  const view = await openReferenceDialog(t, () => reference('@same'), { selectSecondEntry: true });
  const text = textOf(dialog(view));
  assert.equal(text.split('@same').length - 1, 2, 'both selected entries must still render their mention');
  assert.deepEqual(warnings(), [], 'repeated mentions must not be used as React keys');
});

test('distinct mentions keep one row per selected entry and no list warning', async t => {
  const warnings = listWarnings(t);
  const view = await openReferenceDialog(t, index => reference(index === 0 ? '@folder/hello.txt' : '@folder/second.txt'), { selectSecondEntry: true });
  const text = textOf(dialog(view));
  assert.equal(text.split('@folder/hello.txt').length - 1, 1);
  assert.equal(text.split('@folder/second.txt').length - 1, 1);
  assert.equal(nodes(view.renderer, { 'data-fm-reference-session': true }).length, 1, 'the session picker is part of the same dialog');
  assert.deepEqual(warnings(), []);
});
