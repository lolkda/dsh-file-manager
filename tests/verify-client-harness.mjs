/**
 * Independent Client-side verification harness (task-6).
 *
 * Deliberately separate from `tests/client-harness.mjs`: this file loads the shipped
 * `dist/client.js`, applies it to a minimal Cordis context of its own, records every
 * request the panel makes, and renders the registered slot cells with
 * `react-test-renderer`. Verification must not merely re-read the author's fixtures.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const require = createRequire(import.meta.url);
const h = React.createElement;

/** Minimal stand-ins for the browser module table the bundle expects. */
export const uiBoundary = {
  Button({ variant, size, icon, children, ...attrs }) { return h('button', attrs, icon, children); },
  Input({ icon, className, ...attrs }) { return h('span', { className }, icon, h('input', attrs)); },
  Modal({ open, onClose, title, closeLabel, description, children, footer, className, contentClassName }) {
    return open ? h('section', { role: 'dialog', 'aria-label': title, className },
      h('button', { onClick: onClose, 'aria-label': closeLabel }, closeLabel),
      h('h2', null, title), description && h('div', null, description),
      h('div', { className: contentClassName }, children), footer) : null;
  },
  Checkbox({ checked, onChange, label, disabled }) {
    return h('label', null, h('input', { type: 'checkbox', checked, disabled, onChange: event => onChange(event.target.checked), 'aria-label': label }), label);
  },
  RiskConfirmation({ open, title, description, acknowledgeLabel, cancelLabel, closeLabel, confirmLabel, acknowledged, disabled, onAcknowledgedChange, onCancel, onConfirm }) {
    return h(uiBoundary.Modal, { open, title, description, closeLabel, onClose: onCancel,
      footer: h(React.Fragment, null,
        h('button', { onClick: onCancel, disabled }, cancelLabel),
        h('button', { onClick: onConfirm, disabled: disabled || !acknowledged }, confirmLabel)) },
    h(uiBoundary.Checkbox, { checked: acknowledged, onChange: onAcknowledgedChange, disabled, label: acknowledgeLabel }));
  },
};

const moduleTable = {
  'react': () => require('react'),
  'react/jsx-runtime': () => require('react/jsx-runtime'),
  '@deepseek-ai/dsh-client-ui-primitives': () => uiBoundary,
};

/** Evaluate the shipped bundle and return its module exports. */
export async function loadBundle() {
  const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');
  let definition;
  const scope = globalThis;
  const previous = scope.window;
  scope.window = { __ModuleLoader__: { load(value) { definition = value; } } };
  try {
    vm.runInThisContext(source, { filename: 'dist/client.js' });
  } finally {
    if (previous === undefined) delete scope.window;
    else scope.window = previous;
  }
  assert.ok(definition, 'dist/client.js must register through window.__ModuleLoader__');
  assert.equal(definition.id, '@lolkda/dsh-file-manager');
  return definition.factory(name => {
    const resolve = moduleTable[name];
    assert.ok(resolve, `unexpected browser module dependency: ${name}`);
    return resolve();
  });
}

/**
 * Apply the shipped Client to a fresh context and return the recorded traffic plus
 * every registered slot cell. `respond(url, init)` supplies the HTTP answer.
 */
export async function applyClient({ respond, window: windowOverrides = {}, context = {}, globals = {} } = {}) {
  const client = await loadBundle();
  const requests = [];
  const listeners = new Map();
  const fetchImpl = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const request = { url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
    requests.push(request);
    const answer = await respond(request);
    return new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json', ...(answer.headers ?? {}) },
    });
  };
  const windowBoundary = {
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    fetch: fetchImpl,
    ...windowOverrides,
  };
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = windowBoundary;
  globalThis.fetch = fetchImpl;
  const overridden = new Map();
  for (const [name, value] of Object.entries(globals)) {
    overridden.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    globalThis[name] = value;
  }
  const cells = new Map();
  const registrations = [];
  const dictionaries = new Map();
  const disposers = [];
  const ctx = {
    locale: {
      register(ns, locale, dictionary) { dictionaries.set(`${ns}:${locale}`, dictionary); return () => dictionaries.delete(`${ns}:${locale}`); },
      bind(ns) { return (key, values) => {
        const text = dictionaries.get(`${ns}:zh-CN`)?.[key] ?? key;
        return values ? text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? '')) : text;
      }; },
    },
    slots: {
      inject(name, callback) { const dispose = callback(); disposers.push(dispose); return dispose; },
      register(registration, component) {
        registrations.push({ registration, component });
        cells.set(`${registration.name}:${registration.key ?? registration.id}`, { registration, component });
        return () => cells.delete(`${registration.name}:${registration.key ?? registration.id}`);
      },
    },
    effect(callback) { const dispose = callback(); disposers.push(dispose); return dispose; },
    uiWorkspace: { openSession() {} },
    ...context,
  };
  client.apply(ctx);
  return {
    client, ctx, cells, registrations, requests, listeners,
    t: ctx.locale.bind('local-file-manager'),
    async dispose() {
      for (const dispose of disposers.reverse()) await dispose?.();
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      globalThis.fetch = previousFetch;
      for (const [name, descriptor] of overridden) {
        if (descriptor === undefined) delete globalThis[name];
        else Object.defineProperty(globalThis, name, descriptor);
      }
    },
  };
}

/** The main panel cell: the component the harness must render. */
export function mainCell(harness) {
  const entry = [...harness.cells.entries()].find(([key]) => key.startsWith('main:'));
  assert.ok(entry, `the Client must register a main panel cell, saw ${[...harness.cells.keys()].join(', ') || 'none'}`);
  return { key: entry[0], ...entry[1] };
}

export async function render(component, props) {
  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(component, props)); });
  await act(async () => { await Promise.resolve(); });
  return renderer;
}

export async function settle(renderer, rounds = 4) {
  for (let index = 0; index < rounds; index++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
  return renderer;
}

/** Every rendered host element carrying `attribute`. */
export function withAttribute(renderer, attribute) {
  return renderer.root.findAll(node => typeof node.type === 'string' && node.props[attribute] !== undefined, { deep: true });
}

export function textsOf(renderer) {
  const texts = [];
  const walk = node => {
    for (const child of node.children ?? []) {
      if (typeof child === 'string') texts.push(child);
      else walk(child);
    }
  };
  walk(renderer.root);
  return texts;
}

export function textIncludes(renderer, needle) {
  return textsOf(renderer).some(text => text.includes(needle));
}

/** Click the first rendered element matching `predicate`. */
export async function click(renderer, predicate) {
  const target = renderer.root.findAll(node => typeof node.type === 'string' && predicate(node), { deep: true })[0];
  assert.ok(target, 'expected a clickable element to be rendered');
  await act(async () => { target.props.onClick({ preventDefault() {}, stopPropagation() {} }); });
  await settle(renderer);
  return target;
}

export { React, TestRenderer, act, h };
