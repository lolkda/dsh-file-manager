import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// Public UI dependency boundary only. React renders the actual file-manager
// component; this adapter is not an application shell or a visual preview.
const h = React.createElement;
export const uiBoundary = {
  Button({ variant, size, icon, children, ...nativeAttrs }) {
    return h('button', nativeAttrs, icon, children);
  },
  Input({ icon, className, ...nativeAttrs }) {
    return h('span', { className }, icon, h('input', nativeAttrs));
  },
  Modal({ open, onClose, title, closeLabel, description, children, footer, className, contentClassName }) {
    return open ? h('section', { role: 'dialog', 'aria-label': title, className },
      h('button', { onClick: onClose, 'aria-label': closeLabel }, closeLabel),
      h('h2', null, title), description && h('div', null, description), h('div', { className: contentClassName }, children), footer) : null;
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

export async function loadClient(fetchImpl, options = {}) {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  let definition;
  const listeners = new Map();
  const windowBoundary = {
    __ModuleLoader__: { load(value) { definition = value; } },
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    ...options.window,
  };
  vm.runInNewContext(source, {
    window: windowBoundary, fetch: fetchImpl, AbortController, console, URL,
    crypto: webcrypto, setTimeout, clearTimeout, setInterval, clearInterval,
    TextEncoder, TextDecoder, Blob, FormData, ...options.globals,
  }, { filename: 'client.js' });
  assert.equal(definition.id, '@lolkda/dsh-file-manager');
  const client = definition.factory(name => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return uiBoundary;
    assert.fail(`Unexpected browser module dependency: ${name}`);
  });
  const cells = new Map();
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
      register(options, component) {
        const key = `${options.name}:${options.key ?? options.id}`;
        assert.equal(cells.has(key), false, 'a plugin cell must not replace another registration');
        cells.set(key, { options, component });
        return () => cells.delete(key);
      },
    },
    effect(callback) { const dispose = callback(); disposers.push(dispose); return dispose; },
    ...options.context,
  };
  client.apply(ctx);
  return {
    cells, client, listeners, t: ctx.locale.bind('local-file-manager'),
    dispose: async () => { for (const dispose of disposers.reverse()) await dispose?.(); },
  };
}

export const nodes = (renderer, props) => renderer.root.findAll(node => typeof node.type === 'string' && Object.entries(props).every(([key, value]) => node.props[key] === value));
export const node = (renderer, props) => {
  const found = nodes(renderer, props);
  assert.equal(found.length, 1, `Expected one rendered element matching ${JSON.stringify(props)}, found ${found.length}`);
  return found[0];
};
export const textOf = element => element.children.map(child => typeof child === 'string' ? child : textOf(child)).join('');

export async function setup(t, options = {}) {
  const { createManager } = await import('../host/manager.js');
  const { createControlHandler, createTextHandler } = await import('../index.js');
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-client-'));
  let manager, tasks, transfers, client, result;
  const taskSnapshots = new Map();
  const taskWaiters = new Map();
  t.after(async () => {
    result?.unmount();
    await client?.dispose();
    await tasks?.close();
    await transfers?.close();
    await manager?.close();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'folder'));
  await writeFile(path.join(root, 'folder', 'hello.txt'), '<script>not executable</script>\n你好');
  await options.seed?.(root);
  manager = createManager();
  await manager.addRoot({ path: root });
  if (options.tasks) {
    const { createTaskService } = await import('../host/tasks.js');
    tasks = createTaskService({ manager: options.wrapTaskManager?.(manager) ?? manager, ...options.taskOptions, onChange(task) {
      taskSnapshots.set(task.id, task);
      options.taskOptions?.onChange?.(task);
      if (!['queued', 'running'].includes(task.status)) { for (const resolve of taskWaiters.get(task.id) ?? []) resolve(task); taskWaiters.delete(task.id); }
    } });
  }
  if (options.transfers) {
    const { createTransferService } = await import('../host/transfers.js');
    transfers = createTransferService({ manager: options.wrapTransferManager?.(manager) ?? manager, ...options.transferOptions });
  }
  const control = createControlHandler({ manager, tasks, transfers, workspaces: () => [], ...options.controlOptions });
  const text = createTextHandler({ manager });
  const pending = new Set();
  const requests = [];
  const route = (url, init) => {
    const request = new Request(new URL(url, 'http://localhost'), init);
    const pathname = new URL(request.url).pathname;
    if (pathname === '/api/file-manager/text') return text(request);
    if (pathname === '/api/file-manager/upload') return transfers.handleUpload(request);
    if (pathname === '/api/file-manager/download') return transfers.handleDownload(request);
    return control(request);
  };
  const fetchImpl = (url, init = {}) => {
    requests.push({ url: String(url), init });
    const promise = Promise.resolve(options.intercept ? options.intercept(url, init, route) : route(url, init));
    pending.add(promise);
    promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  };
  client = await loadClient(fetchImpl, options);
  let panel = client.cells.get('main:file-manager');
  assert.ok(panel, 'the independent main panel is missing');
  result = { renderer: null, client, manager, tasks, transfers, root, pending, requests };
  result.waitForTask = taskId => {
    const current = taskSnapshots.get(taskId);
    if (current && !['queued', 'running'].includes(current.status)) return Promise.resolve(current);
    return new Promise(resolve => { if (!taskWaiters.has(taskId)) taskWaiters.set(taskId, []); taskWaiters.get(taskId).push(resolve); });
  };
  result.flush = async () => { await act(async () => { while (pending.size) await Promise.all([...pending]); }); };
  result.mount = async ({ settle = true } = {}) => {
    await act(async () => {
      result.renderer = TestRenderer.create(h(panel.component, { t: client.t, ...options.mainProps, ...panel.options.inject?.() }));
    });
    if (settle) await result.flush();
  };
  result.unmount = () => act(() => result.renderer.unmount());
  result.reloadClient = async () => {
    result.unmount();
    await client.dispose();
    client = await loadClient(fetchImpl, options);
    result.client = client;
    panel = client.cells.get('main:file-manager');
    await result.mount();
  };
  result.click = async props => {
    await act(async () => { await node(result.renderer, props).props.onClick(); while (pending.size) await Promise.all([...pending]); });
  };
  result.openHello = async () => {
    await result.click({ 'data-fm-entry': 'directory', 'data-fm-path': 'folder' });
    await result.click({ 'data-fm-entry': 'file', 'data-fm-path': 'folder/hello.txt' });
  };
  await result.mount({ settle: options.settleInitial !== false });
  return result;
}

// A minimal implementation of the documented selector-hook boundary. This
// models only externally owned snapshots, not the Harness input application.
export function snapshotBoundary(initial) {
  let state = initial;
  const listeners = new Set();
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  const get = () => state;
  return {
    get,
    update(change) { state = { ...state, ...change }; for (const listener of listeners) listener(); },
    use(selector) { return selector(React.useSyncExternalStore(subscribe, get, get)); },
  };
}

export { React, TestRenderer, act };
