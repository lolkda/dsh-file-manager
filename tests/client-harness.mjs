import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { loadClient as loadClientBundle, uiBoundary } from './client-module-loader.mjs';

/**
 * Component-level harness: the shipped Client bundle against the real Host.
 *
 * The subject is `dist/client.js` (never the legacy root `client.js`) and the
 * Host is the real v2 router, so these tests exercise the same routes, admission
 * rules and error envelopes a browser would. Run `npm run build` first.
 */

const h = React.createElement;

/**
 * Loads the shipped Client bundle and applies it to a minimal Cordis context.
 * `fetchImpl` receives the URL and init of every request the panel makes.
 */
export async function loadClient(fetchImpl, options = {}) {
  const client = await loadClientBundle();
  assert.equal(typeof client.apply, 'function', 'the shipped Client bundle must export apply()');
  const listeners = new Map();
  const windowBoundary = {
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    fetch: fetchImpl,
    ...options.window,
  };
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = windowBoundary;
  // The plugin uses the global fetch (the browser provides it); route it through
  // the real Host router for the duration of the test.
  globalThis.fetch = fetchImpl;
  // A test may replace a timer the plugin schedules, to observe whether the
  // plugin keeps or releases it. The bundle reads these as globals, so they are
  // installed for exactly as long as the client is applied.
  const overridden = new Map();
  for (const [name, value] of Object.entries(options.globals ?? {})) {
    overridden.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    globalThis[name] = value;
  }
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
      register(registration, component) {
        const key = `${registration.name}:${registration.key ?? registration.id}`;
        assert.equal(cells.has(key), false, 'a plugin cell must not replace another registration');
        cells.set(key, { options: registration, component });
        return () => cells.delete(key);
      },
    },
    effect(callback) { const dispose = callback(); disposers.push(dispose); return dispose; },
    // The Host always provides the workspace service; a harness without it would
    // silently disable the reference flow instead of exercising it.
    uiWorkspace: options.uiWorkspace ?? { openSession() {} },
    ...options.context,
  };
  client.apply(ctx);
  return {
    cells, client, listeners, t: ctx.locale.bind('local-file-manager'),
    dispose: async () => {
      for (const dispose of disposers.reverse()) await dispose?.();
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      globalThis.fetch = previousFetch;
      for (const [name, descriptor] of overridden) {
        if (descriptor === undefined) delete globalThis[name];
        else Object.defineProperty(globalThis, name, descriptor);
      }
      overridden.clear();
    },
  };
}

export { uiBoundary };

export const nodes = (renderer, props) => renderer.root.findAll(node => typeof node.type === 'string' && Object.entries(props).every(([key, value]) => node.props[key] === value));
export const node = (renderer, props) => {
  const found = nodes(renderer, props);
  assert.equal(found.length, 1, `Expected one rendered element matching ${JSON.stringify(props)}, found ${found.length}`);
  return found[0];
};
export const textOf = element => element.children.map(child => typeof child === 'string' ? child : textOf(child)).join('');

/**
 * The panel's code-editor boundary.
 *
 * The panel renders exactly one component element carrying the frozen
 * `CodeEditorProps`, wrapped in a React container that carries the
 * `data-fm-code*` marks. Under React's test renderer a host ref is never
 * attached, so the component runs its documented no-view lifecycle: container
 * and marks render, no CodeMirror instance exists, and the failure fallback is
 * deliberately unreachable. These helpers therefore read that component's props
 * and the marks React itself renders — never a rendered editor surface. The real
 * `.cm-content`, its colour spans and actual typing belong to the jsdom suite.
 *
 * They return `undefined`/`0` rather than asserting, so each caller's own
 * assertion names the business rule it protects.
 */
export const editorNodes = renderer => renderer.root.findAll(node =>
  typeof node.type === 'function'
  && typeof node.props === 'object' && node.props !== null
  && 'documentId' in node.props && 'languageHint' in node.props && typeof node.props.onChange === 'function');
export const editorProps = renderer => editorNodes(renderer)[0]?.props;
export const editorCount = renderer => editorNodes(renderer).length;
export const editorContainers = renderer => renderer.root.findAll(node =>
  typeof node.type === 'string' && 'data-fm-code' in node.props);

/**
 * Delivers text through the editor's own change callback, wrapped in `act`.
 *
 * A missing editor must be reported as the missing behavior it is: calling
 * `undefined.onChange` would crash a test instead of failing it, so this helper
 * asserts the boundary exists first. Callers keep their own assertions about
 * what the panel then does with the text.
 */
export const editorEdit = (view, text) => {
  const props = editorProps(view.renderer);
  assert.ok(props, 'the panel must render the code editor before it can receive text');
  act(() => props.onChange(text));
};

/**
 * Boots the real Host services, mounts the shipped Client bundle against the v2
 * router, and exposes the interaction helpers the component tests use.
 */
export async function setup(t, options = {}) {
  const { createManager } = await import('../dist/host/manager.js');
  const { createFileManagerRouter } = await import('../dist/host/http.js');
  const { resolveLimits } = await import('../dist/contracts/limits.js');
  const { createEventHub } = await import('../dist/host/watch.js');
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-client-'));
  let manager, tasks, transfers, watcher, events, client, result;
  const taskSnapshots = new Map();
  const taskWaiters = new Map();
  t.after(async () => {
    result?.unmount();
    await client?.dispose();
    await watcher?.close();
    events?.close();
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
    const { createTaskService } = await import('../dist/host/tasks.js');
    tasks = createTaskService({ manager: options.wrapTaskManager?.(manager) ?? manager, ...options.taskOptions, onChange(task) {
      taskSnapshots.set(task.id, task);
      options.taskOptions?.onChange?.(task);
      if (!['queued', 'running'].includes(task.status)) { for (const resolve of taskWaiters.get(task.id) ?? []) resolve(task); taskWaiters.delete(task.id); }
    } });
  }
  if (options.transfers) {
    const { createTransferService } = await import('../dist/host/transfers.js');
    transfers = createTransferService({ manager: options.wrapTransferManager?.(manager) ?? manager, ...options.transferOptions });
  }
  // The Host always composes live observation, so the Client sees the capability
  // it is written against and `capabilities.watch` is true for every test.
  //
  // The subscription is acknowledged without emitting: filesystem watching is
  // Host behaviour with its own suite, and a real watcher would invalidate a
  // directory while a test is mid-write. The event route is answered here with a
  // quiet stream for the same reason — the composed handler sends a `ready` frame
  // and schedules a heartbeat on every connection, which would resynchronize a
  // directory a test is still setting up and would put a Host timer into a test
  // that counts the timers the Client keeps. A test that wants frames supplies
  // them through `intercept`, as the invalidation and resynchronization tests do.
  events = createEventHub();
  watcher = options.watcher ?? {
    async subscribe() { return async () => {}; },
    async close() {},
  };
  const quietEvents = () => new Response(new ReadableStream({ start() {}, cancel() {} }), { headers: { 'content-type': 'text/event-stream' } });
  const router = createFileManagerRouter({
    manager, tasks, transfers, watcher, events,
    workspaces: options.controlOptions?.workspaces ?? (() => options.workspaces ?? []),
    limits: resolveLimits(options.limits ?? {}),
    persistentRoots: options.persistentRoots ?? true,
  });
  const pending = new Set();
  const requests = [];
  const route = (url, init) => {
    const request = new Request(new URL(url, 'http://localhost'), init);
    if (new URL(request.url).pathname === '/api/file-manager/v2/events') return Promise.resolve(quietEvents());
    return router(request);
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
  result = { renderer: null, client, manager, tasks, transfers, watcher, events, root, pending, requests };
  result.waitForTask = taskId => {
    const current = taskSnapshots.get(taskId);
    if (current && !['queued', 'running'].includes(current.status)) return Promise.resolve(current);
    return new Promise(resolve => { if (!taskWaiters.has(taskId)) taskWaiters.set(taskId, []); taskWaiters.get(taskId).push(resolve); });
  };
  /**
   * Waits until an interaction stops producing requests.
   *
   * Draining the requests that are already in flight is not enough to settle an
   * interaction: the Client answers a response inside a microtask chain, so the
   * request that continues the same interaction — the receipt verification read
   * after a save, the listing refresh after a mutation — is issued only after
   * the promise that carried the previous request has already settled. The
   * interaction is settled once a whole macrotask passes without a new request,
   * so a follow-up request can never be mistaken for the next assertion's state.
   */
  result.settle = async () => {
    for (let quiet = 0; quiet < 4;) {
      while (pending.size) await Promise.all([...pending]);
      await new Promise(resolve => setImmediate(resolve));
      quiet = pending.size === 0 ? quiet + 1 : 0;
    }
  };
  result.flush = async () => { await act(async () => { await result.settle(); }); };
  /**
   * Waits for `predicate` while letting the Client's own timers run.
   *
   * `settle()` only waits for requests that are already in flight, so it cannot
   * observe a follow-up the Client deliberately coalesces behind a debounce — a
   * watcher resynchronization, for instance. This helper polls inside `act`, so
   * the render a debounced follow-up causes is committed like any other, and it
   * returns whether the predicate ever held; the caller's assertion stays the
   * single place that decides pass or fail.
   */
  result.waitFor = async (predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let held = false;
    await act(async () => {
      while (!(held = predicate() === true)) {
        if (Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    });
    return held;
  };
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
    await act(async () => { await node(result.renderer, props).props.onClick(); await result.settle(); });
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
