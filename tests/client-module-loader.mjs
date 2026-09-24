import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import React from 'react';

/**
 * Loads a module of the shipped Client bundle for a unit test.
 *
 * The subject is always the built artifact `dist/client.js`, read the same way
 * the browser module table reads it: through `window.__ModuleLoader__.load` and
 * a `require` that resolves the external runtime modules. There is deliberately
 * no fallback to compiling sources — if the artifact is missing, or does not
 * export the requested module, this helper fails. A silent fallback would let
 * the tests drift away from what actually ships.
 *
 * Run `npm run build` first.
 */
const require = createRequire(import.meta.url);
const h = React.createElement;

// Public UI dependency boundary only. React renders the actual file-manager
// component; this adapter is not an application shell or a visual preview. It
// lives here because the browser module table — not the bundle — supplies the
// primitives, so the same boundary must serve every suite.
export const uiBoundary = {
  Button({ variant, size, icon, children, ...nativeAttrs }) {
    return h('button', nativeAttrs, icon, children);
  },
  Input({ icon, className, ...nativeAttrs }) {
    return h('span', { className }, icon, h('input', nativeAttrs));
  },
  // Public Menu boundary only: placement, native focus and theme rendering
  // belong to the actual Host primitive and are NOT simulated by this adapter.
  // Tests observe the plugin's props/callbacks and resulting file operations.
  Menu({ open, anchor, items, selectedId, onSelect, className }) {
    return h('span', { className }, anchor, open ? h('div', { role: 'menu' },
      items.map(item => h('button', {
        key: item.id, type: 'button', role: 'menuitem', disabled: item.disabled,
        'data-menu-item': item.id, 'data-menu-selected': item.id === selectedId,
        onClick: () => onSelect(item.id),
      }, item.label))) : null);
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
  /**
   * Host-public filename→grammar selection, standing in for the primitive
   * package's own `languageForPath` export at the module-table boundary.
   *
   * The Client calls `ui.languageForPath?.(path)` and must resolve to plain text
   * when a Host does not provide the function, so this adapter answers exactly
   * like the Host for the suffixes it answers at all — it is a boundary stub,
   * never a production fallback and never a second implementation of the Host's
   * full map. A suite that needs another suffix must extend the table below from
   * the Host's public map rather than guess.
   */
  languageForPath(path) {
    const extension = /\.([^./]+)$/u.exec(String(path).replaceAll('\\', '/'))?.[1]?.toLowerCase();
    return extension === undefined ? undefined : HOST_LANGUAGE_SUFFIXES[extension];
  },
};

/**
 * Subset of the installed Host's public suffix→grammar map, transcribed for the
 * suffixes these suites exercise (see `languageForPath` above). The Host owns the
 * full map; this table only has to agree with it where it answers.
 */
const HOST_LANGUAGE_SUFFIXES = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  md: 'markdown', markdown: 'markdown',
  py: 'python', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  css: 'css', html: 'html', htm: 'html', yml: 'yaml', yaml: 'yaml',
};

/** The modules the browser module table provides; React must never be bundled twice. */
const moduleTable = {
  'react': () => require('react'),
  'react/jsx-runtime': () => require('react/jsx-runtime'),
  '@deepseek-ai/dsh-client-ui-primitives': () => uiBoundary,
};

/**
 * Evaluates the bundle again for every caller. The browser evaluates a module
 * once, so module-level state is legitimate in the product; a test, however,
 * must not inherit state from the previous test — this mirrors the legacy
 * harness, which evaluated the bundle in a fresh vm context per test.
 */
function loadClient() {
  return (async () => {
    const url = new URL('../dist/client.js', import.meta.url);
    let source;
    try {
      source = await readFile(url, 'utf8');
    } catch {
      assert.fail('dist/client.js is missing: run `npm run build` before the Client tests');
    }
    let definition;
    // Run in this realm: the bundle's own arrays and objects must keep the
    // prototypes the assertions compare against (a fresh vm context would make
    // every structural comparison fail on the prototype).
    const scope = globalThis;
    const previous = scope.window;
    scope.window = { __ModuleLoader__: { load(value) { definition = value; } } };
    try {
      vm.runInThisContext(source, { filename: 'dist/client.js' });
    } finally {
      if (previous === undefined) delete scope.window;
      else scope.window = previous;
    }
    assert.ok(definition, 'dist/client.js must register itself through window.__ModuleLoader__');
    assert.equal(definition.id, '@lolkda/dsh-file-manager');
    return definition.factory(name => {
      const resolve = moduleTable[name];
      assert.ok(resolve, `Unexpected browser module dependency: ${name}`);
      return resolve();
    });
  })();
}

/**
 * Returns the module `name` exported by the shipped bundle. A missing export is
 * a build defect, not a reason to test something else.
 */
export async function loadClientModule(name) {
  const client = await loadClient();
  const module = client[name];
  assert.ok(module, `dist/client.js must export ${name}`);
  return module;
}

export { loadClient };
