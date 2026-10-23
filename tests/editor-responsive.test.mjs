import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, assertNoDomErrors, editorViewOf, installDom, loadShippedClient, mountInto } from './editor-dom-harness.mjs';

async function scene(t, { width = 390, panel = true, observer = true, raf = true, canWrite = true } = {}) {
  const env = installDom({ raf });
  // jsdom has no text Range geometry. Empty geometry only lets CodeMirror's
  // selection/scroll measurement run; these tests assert configuration, not pixels.
  env.window.Range.prototype.getClientRects ??= () => [];
  env.window.Range.prototype.getBoundingClientRect ??= () => new env.window.DOMRect();
  let mount;
  t.after(async () => {
    try { await mount?.unmount(); assertNoDomErrors(env); }
    finally { env.restore(); }
  });
  const records = [];
  if (observer) env.window.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = false; records.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  };
  const container = env.document.createElement('div');
  container.className = panel ? 'dsh-fm' : 'standalone';
  env.body.append(container);
  let measured = width;
  Object.defineProperty(container, 'clientWidth', { get: () => measured });
  if (!panel) {
    const original = Object.getOwnPropertyDescriptor(env.window.HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(env.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() {
      return this.hasAttribute('data-fm-code') ? measured : original?.get?.call(this) ?? 0;
    } });
  }
  const client = await loadShippedClient(env.window);
  let props = {
    documentId: 'responsive-doc', path: 'a.txt', value: 'long unchanged line 中文 😀', canWrite,
    languageHint: undefined, ariaLabel: 'Editor', t: key => key,
    onChange: text => changes.push(text), onSave: () => saves.push(true),
  };
  const changes = [];
  const saves = [];
  mount = await mountInto(container, React.createElement(client.CodeEditor, props));
  return {
    env, container, changes, saves, records,
    root: () => container.querySelector('[data-fm-code]'),
    async render(next) { props = { ...props, ...next }; await mount.render(React.createElement(client.CodeEditor, props)); },
    async resize(next) {
      measured = next;
      await act(async () => {
        for (const record of records) if (!record.disconnected) record.callback([{ target: record.target, contentRect: { width: next } }]);
        if (!observer) env.window.dispatchEvent(new env.window.Event('resize'));
      });
    },
    async unmount() { await mount.unmount(); mount = null; },
  };
}

test('actual panel width controls native wrapping at the inclusive 600px boundary without rebuilding or editing', async t => {
  const state = await scene(t);
  const view = editorViewOf(state.container);
  assert.equal(state.root().getAttribute('data-fm-code-wrap'), 'true');
  assert.equal(view.contentDOM.classList.contains('cm-lineWrapping'), true);
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].target, state.container, 'observe actual .dsh-fm rather than the browser viewport');
  const text = view.state.doc.toString();
  await act(async () => view.dispatch({ changes: { from: text.length, insert: ' edited' }, selection: { anchor: 5 } }));
  await state.render({ value: text + ' edited' });
  const selection = view.state.selection.main;
  const beforeChanges = [...state.changes];
  await state.resize(601);
  assert.equal(editorViewOf(state.container), view);
  assert.equal(view.contentDOM.classList.contains('cm-lineWrapping'), false);
  assert.equal(view.state.selection.main.from, selection.from);
  assert.equal(view.state.doc.toString(), text + ' edited');
  await state.resize(600);
  assert.equal(view.contentDOM.classList.contains('cm-lineWrapping'), true);
  await state.resize(0);
  assert.equal(view.contentDOM.classList.contains('cm-lineWrapping'), true, 'hiding the retained panel preserves the last wrap decision');
  assert.deepEqual(state.changes, beforeChanges, 'layout changes are never document edits');
  assert.deepEqual(state.saves, []);
  await act(async () => view.contentDOM.dispatchEvent(new state.env.window.KeyboardEvent('keydown', {
    key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
  })));
  assert.equal(view.state.doc.toString(), text, 'native wrap reconfiguration preserves undo history');
  await state.unmount();
  assert.equal(state.records[0].disconnected, true);
});

test('standalone editor uses its own container; absent ResizeObserver still allows editing and resize', async t => {
  const state = await scene(t, { panel: false, observer: false, width: 700 });
  const view = editorViewOf(state.container);
  assert.equal(view.contentDOM.classList.contains('cm-lineWrapping'), false);
  assert.equal(view.contentDOM.getAttribute('contenteditable'), 'true');
  await state.resize(390);
  assert.equal(view.contentDOM.classList.contains('cm-lineWrapping'), true);
  assert.equal(editorViewOf(state.container), view);
  await act(async () => view.dispatch({ changes: { from: 0, insert: 'edit ' } }));
  assert.equal(state.changes.length, 1);
  await state.unmount();
  await state.resize(700);
  assert.equal(state.records.length, 0);
});

test('hidden initial mount does not guess wrapping; subsequent measured width enables it without remounting', async t => {
  const state = await scene(t, { width: 0 });
  const view = editorViewOf(state.container);
  assert.equal(view.contentDOM.classList.contains('cm-lineWrapping'), false);
  await state.resize(430);
  assert.equal(view.contentDOM.classList.contains('cm-lineWrapping'), true);
  assert.equal(editorViewOf(state.container), view);
  await state.render({ canWrite: false });
  assert.equal(view.contentDOM.getAttribute('contenteditable'), 'false');
  assert.equal(state.root().getAttribute('data-fm-code-mode'), 'preview');
  await state.render({ canWrite: true });
  assert.equal(view.contentDOM.getAttribute('contenteditable'), 'true');
  assert.equal(editorViewOf(state.container), view);
});

test('native fallback textarea wrap follows container and readonly pre retains complete text', async t => {
  const state = await scene(t, { raf: false });
  const text = state.container.querySelector('textarea').value;
  assert.equal(state.container.querySelector('textarea').getAttribute('wrap'), 'soft');
  await state.resize(1200);
  assert.equal(state.container.querySelector('textarea').getAttribute('wrap'), 'off');
  assert.equal(state.container.querySelector('textarea').value, text);
  await state.render({ canWrite: false });
  const pre = state.container.querySelector('pre');
  assert.ok(pre);
  assert.equal(pre.textContent, text);
  assert.equal(state.container.querySelector('textarea'), null);
  await state.resize(390);
  assert.equal(state.root().getAttribute('data-fm-code-wrap'), 'true');
  assert.equal(pre.textContent, text);
  assert.deepEqual(state.changes, []);
  assert.deepEqual(state.saves, []);
});
