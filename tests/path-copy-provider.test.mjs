import assert from 'node:assert/strict';
import test from 'node:test';
import { nodes, setup, uiBoundary } from './client-harness.mjs';

const current = { 'data-fm-action': 'copy-directory-path' };
const selected = { 'data-fm-action': 'copy-selected-paths' };
const manual = { 'data-fm-path-copy-text': true };
// The result banner is gone; the same facts are read from the plugin-owned
// notification history: one success event, or one error event that carries the
// complete manual text. The textarea in the notification detail is still checked
// in the DOM, because that is where the user copies from.
const entriesOf = view => view.notifications.getSnapshot().entries;
const successes = view => entriesOf(view).filter(entry => entry.level === 'success');
const failures = view => entriesOf(view).filter(entry => entry.action?.kind === 'manual-copy');
const manualTexts = view => entriesOf(view).filter(entry => entry.action?.kind === 'manual-copy').map(entry => entry.action.text);

// Only the public provider boundary is simulated. Real OS copy/paste is checked
// separately in Chromium; these tests establish the plugin's result handling.
function installWriter(t, writer) {
  const original = uiBoundary.writeClipboard;
  uiBoundary.writeClipboard = writer;
  t.after(() => { uiBoundary.writeClipboard = original; });
}

test('both path actions use the injected public writer, not a private navigator path', async t => {
  const written = [];
  installWriter(t, async text => { written.push(text); return true; });
  const view = await setup(t, { window: { navigator: {} } });
  const before = view.requests.length;
  await view.click(current);
  assert.deepEqual(written, [view.root]);
  const afterFirst = successes(view).length;
  assert.equal(entriesOf(view)[0].level, 'success');
  await view.select('folder');
  await view.click(selected);
  assert.deepEqual(written, [view.root, `${view.root}/folder`]);
  assert.equal(successes(view).length, afterFirst + 1, 'each accepted write is its own success event');
  assert.equal(failures(view).length, 0);
  assert.equal(view.requests.length, before);
});

for (const [name, writer] of [
  ['false', async () => false],
  ['nonboolean truthy value', async () => 'accepted'],
  ['missing capability', undefined],
  ['synchronous throw', () => { throw new Error('sync provider failure'); }],
  ['asynchronous rejection', async () => { throw new Error('async provider failure'); }],
]) {
  test(`public writer ${name} preserves complete fallback for both actions`, async t => {
    installWriter(t, writer);
    const view = await setup(t);
    const before = view.requests.length;
    const successesBefore = successes(view).length;
    await view.click(current);
    assert.equal(successes(view).length, successesBefore, 'a refused write never adds a success');
    assert.deepEqual(manualTexts(view), [view.root]);
    assert.equal(nodes(view.renderer, manual)[0].props.value, view.root);
    assert.equal(nodes(view.renderer, manual)[0].props.readOnly, true);
    await view.select('folder');
    await view.click(selected);
    assert.equal(successes(view).length, successesBefore, 'still no success after a second refusal');
    assert.equal(failures(view).length, 2);
    assert.deepEqual(manualTexts(view)[0], `${view.root}/folder`, 'the newest event keeps its own text');
    assert.equal(nodes(view.renderer, manual)[0].props.value, `${view.root}/folder`);
    assert.equal(view.requests.length, before);
  });
}
