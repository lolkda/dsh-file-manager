/**
 * Notification centre in a real DOM: jsdom + react-dom + the shipped bundle.
 *
 * The subject is the built `dist/client.js` applied to a minimal Cordis context
 * and mounted into a real element tree, with the real v2 Host router behind
 * `fetch`. This suite exists for the three things a react-test-renderer suite
 * cannot honestly claim:
 *
 *  - the overlay's own focus handling (focus moves into the drawer, Escape
 *    returns it to the entry point) runs against actual DOM nodes;
 *  - the empty state is rendered markup rather than an absent list;
 *  - the manual-copy detail is a real `readonly` textarea holding the complete
 *    text and selecting it on focus, so the text can be taken out by hand.
 *
 * It deliberately claims no pixel geometry, no real keyboard or IME input and no
 * OS clipboard: those stay browser-verification items (SPEC R21.11).
 *
 * Run `npm run build` first; nothing here compiles sources.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { act, assertNoDomErrors, flushDom, installDom, mountInto } from './editor-dom-harness.mjs';
import { loadClientModule, uiBoundary } from './client-module-loader.mjs';

const h = React.createElement;

/**
 * Boot the real Host, apply the shipped Client to a minimal context and mount
 * the independent main panel into a jsdom container.
 */
async function setupDom(t) {
  const env = installDom();
  const { createManager } = await import('../dist/host/manager.js');
  const { createFileManagerRouter } = await import('../dist/host/http.js');
  const { resolveLimits } = await import('../dist/contracts/limits.js');
  const { createEventHub } = await import('../dist/host/watch.js');

  const root = await mkdtemp(path.join(tmpdir(), 'dsh-fm-notifications-dom-'));
  await mkdir(path.join(root, 'folder'));
  await writeFile(path.join(root, 'folder', 'hello.txt'), 'hello\n');
  const manager = createManager({ rootPath: root });
  const events = createEventHub();
  const watcher = { async subscribe() { return async () => {}; }, async close() {} };
  const router = createFileManagerRouter({
    manager, tasks: undefined, transfers: undefined, watcher, events,
    limits: resolveLimits({}),
  });
  const requests = [];
  const fetchImpl = (url, init = {}) => {
    requests.push({ url: String(url), init });
    // Live observation is answered with a quiet stream: the composed handler
    // would otherwise schedule heartbeats inside a test that is not about them.
    if (String(url).includes('/v2/events')) {
      return Promise.resolve(new Response(new ReadableStream({ start() {}, cancel() {} }),
        { headers: { 'content-type': 'text/event-stream' } }));
    }
    // The Host router takes a Request, exactly like the browser module table
    // hands it one; a bare (url, init) pair would not be a real invocation.
    return Promise.resolve(router(new Request(new URL(String(url), 'http://localhost'), init)));
  };
  const previousFetch = globalThis.fetch;
  env.window.fetch = fetchImpl;
  globalThis.fetch = fetchImpl;

  const cells = new Map();
  const dictionaries = new Map();
  const disposers = [];
  const ctx = {
    locale: {
      register(namespace, locale, dictionary) { dictionaries.set(`${namespace}:${locale}`, dictionary); return () => dictionaries.delete(`${namespace}:${locale}`); },
      bind(namespace) {
        return (key, values) => {
          const text = dictionaries.get(`${namespace}:zh-CN`)?.[key] ?? key;
          return values ? text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? '')) : text;
        };
      },
    },
    slots: {
      inject(name, callback) { const dispose = callback(); disposers.push(dispose); return dispose; },
      register(registration, component) {
        cells.set(`${registration.name}:${registration.key ?? registration.id}`, { options: registration, component });
        return () => cells.delete(`${registration.name}:${registration.key ?? registration.id}`);
      },
    },
    effect(callback) { const dispose = callback(); disposers.push(dispose); return dispose; },
    uiWorkspace: { openSession() {} },
  };
  const apply = await loadClientModule('apply');
  assert.equal(typeof apply, 'function', 'the shipped bundle must export apply()');
  apply(ctx);
  const panel = cells.get('main:file-manager');
  assert.ok(panel, 'the independent main panel must register');
  const injected = panel.options.inject?.() ?? {};
  assert.ok(injected.notifications, 'the panel must receive the notification store');
  const translate = ctx.locale.bind('local-file-manager');

  const container = env.document.createElement('div');
  env.body.append(container);
  const mounted = await mountInto(container, h(panel.component, { t: translate, ...injected }));
  await flushDom(60);

  t.after(async () => {
    try {
      await mounted.unmount();
      await flushDom(10);
      // Tear the plugin down the way the Host does: reverse-order disposers, then
      // the services it was composed with.
      for (const dispose of [...disposers].reverse()) await dispose?.();
      events.close();
      await manager.close();
      await rm(root, { recursive: true, force: true });
      assertNoDomErrors(env);
    } finally {
      if (previousFetch === undefined) delete globalThis.fetch;
      else globalThis.fetch = previousFetch;
      env.restore();
    }
  });

  // Closed overlays stay mounted and open surfaces make the main panel inert.
  // Interactions use reachable controls; structural absence checks below inspect
  // every DOM node, including hidden and inert descendants.
  const reachableAll = selector => [...container.querySelectorAll(selector)]
    .filter(element => element.closest('[hidden],[inert]') === null);
  const reachableOne = selector => {
    const found = reachableAll(selector);
    assert.equal(found.length, 1, `expected exactly one reachable ${selector}, got ${found.length}`);
    return found[0];
  };

  return {
    ...env, container, requests, root, notifications: injected.notifications, t: translate,
    reachableAll, reachableOne,
    async settle(ms = 30) { await flushDom(ms); },
    trigger() { return reachableOne('[data-fm-action="notifications"]'); },
    drawer() { return reachableOne('[data-fm-overlay="notifications"]'); },
    async click(element) { await act(async () => { element.click(); await flushDom(30); }); },
  };
}

test('the DOM contains only the main notification entry, never hidden viewer or task duplicates', async t => {
  const dom = await setupDom(t);
  const selector = '[data-fm-action="notifications"]';
  const assertOnlyMainEntry = () => {
    assert.equal(dom.container.querySelectorAll(selector).length, 1, 'all mounted DOM, not only reachable nodes, has one entry');
    assert.equal(dom.container.querySelectorAll(`.fm-main-header ${selector}`).length, 1);
    for (const surface of ['viewer', 'tasks']) {
      const overlay = dom.container.querySelector(`[data-fm-overlay="${surface}"]`);
      assert.ok(overlay, `${surface} must be mounted for the absence assertion to be meaningful`);
      assert.equal(overlay.querySelectorAll(selector).length, 0, `${surface} contains no hidden or visible notification entry`);
    }
  };
  assertOnlyMainEntry();
  await dom.click(dom.reachableOne('[data-fm-entry="directory"][data-fm-path="folder"]'));
  await dom.click(dom.reachableOne('[data-fm-entry="file"][data-fm-path="folder/hello.txt"]'));
  assert.equal(dom.reachableOne('[data-fm-overlay="viewer"]').getAttribute('data-fm-overlay-open'), 'true');
  assertOnlyMainEntry();
  assert.equal(dom.reachableAll(selector).length, 0, 'editing offers no notification trigger');
  await dom.click(dom.reachableOne('[data-fm-action="back-to-files"]'));
  assertOnlyMainEntry();
  await dom.click(dom.trigger());
  assert.equal(dom.drawer().getAttribute('data-fm-overlay-open'), 'true', 'the main entry still opens history after editing');
});

test('the drawer takes focus when it opens and Escape returns it to the entry point', async t => {
  const dom = await setupDom(t);
  await act(async () => {
    dom.notifications.publish({ level: 'info', title: 'one' });
    await dom.settle(20);
  });

  const trigger = dom.trigger();
  trigger.focus();
  assert.equal(dom.document.activeElement, trigger);

  await dom.click(trigger);
  const drawer = dom.drawer();
  assert.equal(drawer.getAttribute('data-fm-overlay-open'), 'true');
  assert.equal(drawer.contains(dom.document.activeElement), true, 'focus moves into the open drawer');
  assert.equal(dom.reachableAll('article[data-fm-notification-id]').length, 1,
    'one event renders one row in the open drawer (its controls carry the same id)');

  const escape = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await act(async () => { dom.document.activeElement.dispatchEvent(escape); await flushDom(20); });
  assert.equal(drawer.getAttribute('data-fm-overlay-open'), 'false');
  assert.equal(dom.document.activeElement, trigger, 'Escape returns focus to the notification entry point');
});

test('an empty drawer explains itself instead of rendering nothing', async t => {
  const dom = await setupDom(t);
  assert.equal(dom.notifications.getSnapshot().entries.length, 0);

  await dom.click(dom.trigger());
  const drawer = dom.drawer();
  assert.equal(drawer.getAttribute('data-fm-overlay-open'), 'true');
  assert.equal(drawer.querySelectorAll('article[data-fm-notification-id]').length, 0);
  assert.equal(dom.reachableAll('[data-fm-notifications-empty]').length, 1,
    'the empty state has its own marker instead of an absent list');
  assert.equal(dom.reachableAll('[data-fm-action="notifications-clear"]').filter(button => button.disabled === false).length, 0,
    'nothing is offered to clear when the history is empty');
  assert.equal(dom.container.querySelectorAll('[data-fm-notice-dismiss]').length, 0, 'no banner is pushed at the user');
});

test('the manual-copy detail is a readonly textarea holding the complete text', async t => {
  const dom = await setupDom(t);
  const original = uiBoundary.writeClipboard;
  t.after(() => { uiBoundary.writeClipboard = original; });
  uiBoundary.writeClipboard = async () => false;
  await dom.click(dom.reachableOne('[data-fm-action="copy-directory-path"]'));
  await dom.click(dom.trigger());

  const textarea = dom.reachableOne('[data-fm-path-copy-text]');
  assert.ok(textarea, 'a refused copy must expose its manual text');
  assert.equal(textarea.readOnly, true);
  assert.equal(textarea.value, dom.root, 'the detail holds the exact path, never a truncated form');
  assert.equal(dom.notifications.getSnapshot().entries[0].level, 'error');
  assert.equal(dom.notifications.getSnapshot().entries.length, 1);

  // The contract is that the complete text can be taken out of the detail by hand:
  // a real readonly field, no truncation, and focus selects all of it.
  await act(async () => { textarea.focus(); await flushDom(10); });
  assert.equal(textarea.selectionStart, 0);
  assert.equal(textarea.selectionEnd, dom.root.length, 'focus selects the whole text for a manual copy');
  assert.equal(dom.notifications.getSnapshot().entries.length, 1, 'reading the detail never publishes anything');
});
