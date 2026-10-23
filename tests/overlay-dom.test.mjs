import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, assertNoDomErrors, installDom, loadShippedClient, mountInto } from './editor-dom-harness.mjs';

const h = React.createElement;

async function setup(t) {
  const env = installDom();
  let view;
  t.after(async () => {
    try {
      await view?.unmount();
      assertNoDomErrors(env);
    } finally {
      env.restore();
    }
  });
  const client = await loadShippedClient(env.window);
  assert.equal(typeof client.overlay?.Overlay, 'function', 'the shipped bundle must export the overlay namespace');
  assert.equal(typeof client.overlay?.ActionGroup, 'function');
  const mount = env.document.createElement('div');
  env.body.append(mount);
  return {
    ...env, ...client.overlay, mount,
    async render(element) {
      if (view) await view.render(element);
      else view = await mountInto(mount, element);
    },
  };
}

async function key(env, element, key, options = {}) {
  const event = new env.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  await act(async () => element.dispatchEvent(event));
  return event;
}

async function click(element) {
  await act(async () => element.click());
}

async function pointer(env, element) {
  // jsdom has no PointerEvent constructor. The real bubbling pointerdown event
  // still exercises the component's document listener and composedPath.
  await act(async () => element.dispatchEvent(new env.window.Event('pointerdown', { bubbles: true, composed: true })));
}

test('overlay retains child state and DOM across hiding and drawer layout changes and restores the trigger without scrolling', async t => {
  const env = await setup(t);
  let mounts = 0;
  let unmounts = 0;
  let closes = 0;
  function Draft() {
    const [draft, setDraft] = React.useState('draft');
    React.useEffect(() => { mounts += 1; return () => { unmounts += 1; }; }, []);
    return h('button', { onClick: () => setDraft('edited') }, draft);
  }
  const trigger = env.document.createElement('button');
  env.body.prepend(trigger);
  trigger.focus();
  const focusOptions = [];
  const originalFocus = trigger.focus.bind(trigger);
  trigger.focus = options => { focusOptions.push(options); originalFocus(options); };
  const render = (open, extra = {}) => env.render(h(env.Overlay, {
    name: 'viewer', title: 'File content', open, onClose: () => { closes += 1; }, ...extra,
  }, h(Draft)));
  await render(false);
  const draft = env.mount.querySelector('button');
  assert.equal(mounts, 1);
  assert.equal(env.mount.querySelector('[data-fm-overlay]').hidden, true);
  assert.equal(env.document.activeElement, trigger);
  await render(true);
  assert.equal(env.document.activeElement, draft);
  const dialog = env.mount.querySelector('[role="dialog"]');
  assert.equal(dialog.getAttribute('aria-label'), 'File content');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  await click(draft);
  assert.equal(draft.textContent, 'edited');
  await render(true, { drawer: true });
  const root = env.mount.querySelector('[data-fm-overlay="viewer"]');
  assert.equal(root.getAttribute('data-fm-overlay-open'), 'true');
  assert.equal(root.classList.contains('fm-overlay-expanded'), false);
  assert.ok(root.classList.contains('fm-overlay-drawer'));
  await render(false);
  assert.equal(env.document.activeElement, trigger);
  assert.deepEqual(focusOptions.at(-1), { preventScroll: true });
  assert.equal(env.mount.querySelector('button'), draft);
  assert.equal(unmounts, 0);
  await render(true);
  assert.equal(draft.textContent, 'edited');
  assert.equal(mounts, 1);
  await key(env, draft, 'Escape');
  assert.equal(closes, 1);
});

test('Tab wraps only usable controls, including disclosure visibility, and falls back to the dialog', async t => {
  const env = await setup(t);
  const render = children => env.render(h(env.Overlay, { name: 'viewer', title: 'Viewer', open: true, onClose() {} }, children));
  await render([
    h('button', { key: 'disabled', disabled: true }, 'disabled'),
    h('button', { key: 'hidden', hidden: true }, 'hidden'),
    h('button', { key: 'css', style: { display: 'none' } }, 'css hidden'),
    h('button', { key: 'first', id: 'first' }, 'first'),
    h('details', { key: 'details' }, h('summary', {}, 'actions'), h('button', { id: 'concealed' }, 'concealed')),
    h('input', { key: 'last', id: 'last' }),
    h('button', { key: 'negative', tabIndex: -1 }, 'programmatic only'),
  ]);
  const first = env.mount.querySelector('#first');
  const last = env.mount.querySelector('#last');
  assert.equal(env.document.activeElement, first);
  await act(async () => last.focus());
  assert.equal((await key(env, last, 'Tab')).defaultPrevented, true);
  assert.equal(env.document.activeElement, first);
  await key(env, first, 'Tab', { shiftKey: true });
  assert.equal(env.document.activeElement, last);
  const summary = env.mount.querySelector('summary');
  await click(summary);
  await act(async () => last.focus());
  await key(env, last, 'Tab');
  assert.equal(env.document.activeElement, first);
  await render([
    h('button', { key: 'start', id: 'start' }, 'start'),
    h('details', { key: 'edge' }, h('summary', {}, 'actions'), h('button', { id: 'edge-action' }, 'action')),
  ]);
  const edge = env.mount.querySelector('details');
  const edgeSummary = edge.querySelector('summary');
  await act(async () => edgeSummary.focus());
  await key(env, edgeSummary, 'Tab');
  assert.equal(env.document.activeElement, env.mount.querySelector('#start'), 'a closed disclosure only exposes its summary');
  await click(edgeSummary);
  const edgeAction = edge.querySelector('button');
  await act(async () => edgeAction.focus());
  await key(env, edgeAction, 'Tab');
  assert.equal(env.document.activeElement, env.mount.querySelector('#start'), 'an open disclosure exposes its actions');
  await render(h('p', {}, 'No controls'));
  const dialog = env.mount.querySelector('[role="dialog"]');
  await act(async () => dialog.focus());
  assert.equal((await key(env, dialog, 'Tab')).defaultPrevented, true);
  assert.equal(env.document.activeElement, dialog);
});

test('decorative SVG preserves the summary label and its nested click activation', async t => {
  const env = await setup(t);
  const label = '更多操作';
  await env.render(h('div', {},
    h(env.ActionGroup, { name: 'create', label: '新建' }, h('button', {}, '文件')),
    h(env.ActionGroup, { name: 'more', label }, h('button', {}, '复制'))));
  const [create, more] = env.mount.querySelectorAll('details');
  const summary = more.querySelector('summary');
  const arrow = summary.querySelector('svg.fm-action-chevron');
  assert.ok(arrow, 'the disclosure indicator is an SVG, not a text glyph');
  assert.equal(summary.textContent, label, 'the summary text contains only its action label');
  assert.equal(arrow.getAttribute('aria-hidden'), 'true', 'the decorative indicator is excluded from the accessible name');
  assert.equal(arrow.getAttribute('width'), '14');
  assert.equal(arrow.getAttribute('height'), '14');
  assert.equal(arrow.querySelector('title,desc'), null);
  assert.equal(arrow.hasAttribute('tabindex'), false, 'the indicator must not add a keyboard stop');
  assert.equal(summary.hasAttribute('role'), false, 'summary keeps its native disclosure semantics');
  await click(create.querySelector('summary'));
  assert.equal(create.open, true);
  const activateArrow = async target => act(async () => target.dispatchEvent(new env.window.MouseEvent('click', {
    bubbles: true, cancelable: true, composed: true,
  })));
  await activateArrow(arrow.querySelector('path'));
  assert.equal(more.open, true, 'clicking the SVG path activates its summary');
  assert.equal(create.open, false, 'an SVG target still excludes the other toolbar disclosure');
  await activateArrow(arrow);
  assert.equal(more.open, false, 'clicking the SVG again closes the same disclosure');
  assert.equal(summary.textContent, label);
});

test('child disclosure consumes Escape before the overlay and ordinary actions execute exactly once', async t => {
  const env = await setup(t);
  let closes = 0;
  let actions = 0;
  await env.render(h(env.Overlay, { name: 'viewer', title: 'Viewer', open: true, onClose: () => { closes += 1; } },
    h(env.ActionGroup, { label: 'More actions', name: 'more' }, h('button', { onClick: () => { actions += 1; } }, 'Run'))));
  const details = env.mount.querySelector('details');
  const summary = details.querySelector('summary');
  const button = details.querySelector('button');
  assert.equal(env.mount.querySelector('[role="menu"]'), null);
  assert.ok(button, 'closed disclosure keeps its ordinary buttons mounted');
  await click(summary);
  assert.equal(details.open, true);
  await act(async () => button.focus());
  await key(env, button, 'Escape');
  assert.equal(details.open, false);
  assert.equal(closes, 0, 'one key closes only the disclosure');
  assert.equal(env.document.activeElement, summary);
  await click(summary);
  await act(async () => button.focus());
  await click(button);
  assert.equal(actions, 1);
  assert.equal(details.open, false);
  assert.equal(env.document.activeElement, summary);
  await key(env, summary, 'Escape');
  assert.equal(closes, 1);
});

test('suspended overlay yields to a child dialog and never steals child focus or a child Escape', async t => {
  const env = await setup(t);
  let closes = 0;
  const render = (suspended, open = true) => env.render(h(env.Overlay, {
    name: 'viewer', title: 'Viewer', open, suspended, onClose: () => { closes += 1; },
  }, h('button', {}, 'parent')));
  await render(false);
  const parent = env.mount.querySelector('button');
  const child = env.document.createElement('div');
  child.setAttribute('role', 'dialog');
  child.setAttribute('aria-modal', 'true');
  const confirm = env.document.createElement('button');
  child.append(confirm);
  env.body.append(child);
  confirm.focus();
  await render(true);
  assert.equal(env.mount.querySelector('[role="dialog"]').hasAttribute('inert'), true);
  assert.equal(env.document.activeElement, confirm);
  assert.equal((await key(env, confirm, 'Escape')).defaultPrevented, false);
  assert.equal(closes, 0);
  await click(env.mount.querySelector('.fm-overlay-mask'));
  assert.equal(closes, 0);
  await render(false);
  assert.equal(env.document.activeElement, confirm, 'resuming must not steal focus from a still-mounted child');
  await key(env, confirm, 'Escape');
  assert.equal(closes, 0);
  child.remove();
  parent.focus();
  await key(env, parent, 'Escape');
  assert.equal(closes, 1);
});

test('a nested dialog owns Escape even without suspension; a child handler prevents two closes', async t => {
  const env = await setup(t);
  let parentCloses = 0;
  let childCloses = 0;
  await env.render(h(env.Overlay, { name: 'viewer', title: 'Viewer', open: true, onClose: () => { parentCloses += 1; } },
    h('div', { role: 'dialog', 'aria-modal': true, onKeyDown: event => {
      if (event.key === 'Escape') { event.preventDefault(); childCloses += 1; }
    } }, h('button', {}, 'confirm'))));
  await key(env, env.mount.querySelector('button'), 'Escape');
  assert.equal(childCloses, 1);
  assert.equal(parentCloses, 0);
});

test('IME composition, trailing Escape, repeat, and modified Escape do not dismiss layers', async t => {
  const env = await setup(t);
  let closes = 0;
  await env.render(h(env.Overlay, { name: 'viewer', title: 'Viewer', open: true, onClose: () => { closes += 1; } },
    h(env.ActionGroup, { name: 'more', label: 'More' }, h('input'))));
  const details = env.mount.querySelector('details');
  const summary = details.querySelector('summary');
  const input = details.querySelector('input');
  await click(summary);
  input.focus();
  await act(async () => input.dispatchEvent(new env.window.CompositionEvent('compositionstart', { bubbles: true })));
  await key(env, input, 'Escape');
  assert.equal(details.open, true);
  await act(async () => input.dispatchEvent(new env.window.CompositionEvent('compositionend', { bubbles: true })));
  await key(env, input, 'Escape');
  assert.equal(details.open, true);
  await key(env, input, 'Escape', { isComposing: true });
  await key(env, input, 'Escape', { keyCode: 229 });
  assert.equal(details.open, true);
  await key(env, input, 'Escape');
  assert.equal(details.open, false);
  assert.equal(closes, 0);
  await key(env, summary, 'Escape', { repeat: true });
  await key(env, summary, 'Escape', { ctrlKey: true });
  await key(env, summary, 'Escape', { shiftKey: true });
  assert.equal(closes, 0);
  await key(env, summary, 'Escape');
  assert.equal(closes, 1);
});

test('only the latest overlay closes and listeners stop owning keys after hiding', async t => {
  const env = await setup(t);
  let parentCloses = 0;
  let topCloses = 0;
  const render = (parentOpen, topOpen) => env.render(h(React.Fragment, {},
    h(env.Overlay, { name: 'parent', title: 'Parent', open: parentOpen, onClose: () => { parentCloses += 1; } }, h('button', {}, 'parent')),
    h(env.Overlay, { name: 'top', title: 'Top', open: topOpen, onClose: () => { topCloses += 1; } }, h('button', {}, 'top'))));
  await render(true, false);
  const parent = env.mount.querySelector('[data-fm-overlay="parent"] button');
  await render(true, true);
  const top = env.mount.querySelector('[data-fm-overlay="top"] button');
  await key(env, top, 'Escape');
  assert.equal(topCloses, 1);
  assert.equal(parentCloses, 0);
  await click(env.mount.querySelector('[data-fm-overlay="parent"] .fm-overlay-mask'));
  assert.equal(parentCloses, 0);
  await render(true, false);
  assert.equal(env.document.activeElement, parent);
  await key(env, parent, 'Escape');
  assert.equal(parentCloses, 1);
  await render(false, false);
  const outside = env.document.createElement('button');
  env.body.append(outside);
  outside.focus();
  assert.equal((await key(env, outside, 'Escape')).defaultPrevented, false);
  assert.equal(parentCloses, 1);
});

test('disclosures are exclusive within a toolbar, outer pointer closes without swallowing the target action', async t => {
  const env = await setup(t);
  let outsideActions = 0;
  await env.render(h(React.Fragment, {},
    h('div', {},
      h(env.ActionGroup, { name: 'create', label: 'Create' }, h('button', {}, 'File')),
      h(env.ActionGroup, { name: 'more', label: 'More' }, h('button', {}, 'Copy'))),
    h('div', {}, h(env.ActionGroup, { name: 'independent', label: 'Independent' }, h('button', {}, 'Other'))),
    h('button', { id: 'outside', onClick: () => { outsideActions += 1; } }, 'Outside')));
  const [create, more, independent] = env.mount.querySelectorAll('details');
  await click(create.querySelector('summary'));
  assert.equal(create.open, true);
  await click(independent.querySelector('summary'));
  assert.equal(create.open, true, 'different toolbars do not close each other on activation');
  await click(more.querySelector('summary'));
  assert.equal(create.open, false);
  assert.equal(more.open, true);
  assert.equal(independent.open, true);
  await pointer(env, more.querySelector('button'));
  assert.equal(more.open, true);
  const outside = env.mount.querySelector('#outside');
  await pointer(env, outside);
  assert.equal(more.open, false);
  assert.equal(independent.open, false);
  await click(outside);
  assert.equal(outsideActions, 1);
});

test('closing an action disclosure preserves manual path-copy focus chosen by its button', async t => {
  const env = await setup(t);
  const manual = env.document.createElement('textarea');
  manual.readOnly = true;
  manual.value = '/work/中文 spaced';
  env.body.append(manual);
  await env.render(h(env.ActionGroup, { name: 'more', label: 'More' }, h('button', { onClick() {
    manual.focus({ preventScroll: true });
    manual.select();
  } }, 'Copy path')));
  const details = env.mount.querySelector('details');
  await click(details.querySelector('summary'));
  const button = details.querySelector('button');
  button.focus();
  await click(button);
  assert.equal(details.open, false);
  assert.equal(env.document.activeElement, manual);
  assert.equal(manual.selectionStart, 0);
  assert.equal(manual.selectionEnd, manual.value.length);
});
