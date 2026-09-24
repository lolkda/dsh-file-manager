/**
 * Independent DOM acceptance for the syntax-highlighted code editor (task-5).
 *
 * Subject: the shipped `dist/client.js` mounted with jsdom + react-dom. These
 * tests do not compile `src/`, do not stub CodeMirror and never assert on React
 * element props as a substitute for the rendered editor. When `dist/` predates
 * the editor, every test fails on the missing export — that is the intended RED,
 * not a missing build.
 *
 * Evidence boundaries (SPEC R21.11): jsdom cannot prove real keyboard/IME input,
 * layout geometry or computed theme colours. Typing is driven through the real
 * CodeMirror view, and the browser-only half is reported as unverified instead of
 * being faked here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {
  act, assertNoDomErrors, dispatchEditor, editorHostOf, editorViewOf, flushDom, installDom,
  loadShippedClient, mountInto, readEditorText, setEditorText,
} from './editor-dom-harness.mjs';

/** The four frozen copy keys, injected as the component's `t`. */
const MESSAGES = {
  'code.language': 'Language: {language}',
  'code.language.plaintext': 'Plain text',
  'code.highlightLimited': 'Syntax highlighting is off for this size.',
  'code.highlightUnavailable': 'Highlighting is unavailable; showing plain text.',
};
/**
 * The component's translator. Named `translate` rather than `t` on purpose: a
 * TestContext is commonly bound to `t`, and passing one into the component would
 * only fail later, inside the component, as an unrelated TypeError.
 */
const translate = (key, values) => (MESSAGES[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? ''));

const LANGUAGE_ID = {
  typescript: 'typescript',
  javascript: 'javascript',
  json: 'json',
  python: 'python',
  html: 'html',
  css: 'css',
  markdown: 'markdown',
  yaml: 'yaml',
  c: 'c',
  'c++': 'cpp',
  shell: 'shellscript',
};

const TS_SAMPLE = 'const answer: number = 42;\n// a comment\nfunction greet(name: string) { return `hi ${name}`; }\n';
const HTML_SAMPLE = '<script>window.__executed = true;</script>\n<img src="x" onerror="window.__executed = true">\n';

/** ASCII text of exactly `bytes` UTF-8 bytes, multi-line, no line over 20000 units. */
function asciiBytes(bytes) {
  const lines = [];
  let remaining = bytes;
  while (remaining > 0) {
    const take = Math.min(20000, remaining);
    lines.push('a'.repeat(take));
    remaining -= take;
    if (remaining > 0) remaining -= 1;
  }
  return lines.join('\n');
}

const utf8Bytes = text => new TextEncoder().encode(text).length;
const longestLine = text => text.split('\n').reduce((max, line) => Math.max(max, line.length), 0);

/**
 * Boots one jsdom environment, loads the shipped Client, and mounts the editor.
 * Everything is torn down by the returned `destroy`, so a suite never inherits
 * another suite's globals.
 */
async function openEditor(testContext, props = {}, { raf = true, platform, beforeMount } = {}) {
  const handle = installDom({ raf });
  // Platform must be in place *before* the bundle is evaluated: CodeMirror resolves
  // its `Mod` modifier once, at module evaluation time.
  if (platform) {
    Object.defineProperty(handle.window.navigator, 'platform', { value: platform, configurable: true });
    Object.defineProperty(handle.window.navigator, 'userAgent', {
      value: platform === 'MacIntel'
        ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
        : handle.window.navigator.userAgent,
      configurable: true,
    });
  }
  // Registered before anything that can throw: a failed load, a missing export or a
  // failed mount must still hand the globals back, otherwise every later test in
  // this process inherits a foreign window and a leaked jsdom.
  let mounted = null;
  let destroyed = false;
  const destroy = async () => {
    if (destroyed) return;
    destroyed = true;
    try { await mounted?.unmount(); } finally { handle.restore(); }
  };
  testContext.after(destroy);

  const client = await loadShippedClient(handle.window);
  // Only what mounting needs. The complete frozen export surface has its own test,
  // so one missing re-export cannot silence every behavioural assertion: a gate
  // that fails closed on the whole list would report "28 tests blocked by one
  // missing constant" instead of real behaviour.
  assert.equal(typeof client.CodeEditor, 'function', 'dist/client.js must export the CodeEditor component');
  assert.equal(typeof client.editor, 'object', 'dist/client.js must export the editor namespace');
  assert.equal(typeof client.codeLanguages, 'object', 'dist/client.js must export the codeLanguages namespace');
  // A hook for tests that must change the loaded artifact's world *before* the first
  // mount (for example breaking the shared parser to exercise construction).
  if (beforeMount) beforeMount(client);
  const container = handle.document.createElement('div');
  handle.body.appendChild(container);
  const state = {
    client, handle, container,
    calls: [], saveCalls: 0,
    // `t` is the module-level message function: the TestContext must never be
    // passed as the component's translator, which would only surface later as an
    // unrelated TypeError inside the component.
    props: {
      documentId: 'doc-1', path: 'sample.ts', value: TS_SAMPLE, mode: 'preview',
      canWrite: true, languageHint: 'typescript', ariaLabel: 'Code', t: translate,
      onChange: text => { state.calls.push(text); }, onSave: () => { state.saveCalls += 1; },
      ...props,
    },
  };
  const element = () => React.createElement(client.CodeEditor, state.props);
  mounted = await mountInto(container, element());
  state.render = async patch => {
    state.props = { ...state.props, ...patch };
    await mounted.render(element());
  };
  state.destroy = destroy;
  return state;
}

/** The contract's display name for a language id — never a hard-coded lowercase id. */
function displayNameFor(client, languageId) {
  const names = client.codeLanguages.LANGUAGE_DISPLAY_NAMES;
  assert.equal(typeof names, 'object', 'LANGUAGE_DISPLAY_NAMES must be exported by codeLanguages');
  const match = Object.entries(names).find(([key, value]) => key.toLowerCase() === languageId.toLowerCase()
    && typeof value === 'string' && value.length > 0);
  assert.ok(match, `LANGUAGE_DISPLAY_NAMES must carry a non-empty display name for ${languageId}`);
  return match[1];
}

/** The export surface Lead froze; a missing member is a build/coordination defect. */
function requireEditorSurface(client) {
  assert.equal(typeof client.CodeEditor, 'function', 'dist/client.js must export the CodeEditor component');
  assert.equal(typeof client.editor?.CodeEditor, 'function', 'the editor namespace must export CodeEditor');
  for (const key of ['HIGHLIGHT_MAX_BYTES', 'HIGHLIGHT_MAX_LINE_UNITS', 'classifyHighlightBudget']) {
    assert.equal(typeof client.editor?.[key] !== 'undefined', true, `editor.${key} must be exported`);
  }
  for (const key of ['HIGHLIGHT_MAX_BYTES', 'HIGHLIGHT_MAX_LINE_UNITS', 'classifyHighlightBudget', 'languageIdFor', 'languageExtensionFor', 'createHighlightExtension', 'LANGUAGE_DISPLAY_NAMES']) {
    assert.equal(typeof client.codeLanguages?.[key] !== 'undefined', true, `codeLanguages.${key} must be exported`);
  }
}

const highlightState = container => editorHostOf(container).getAttribute('data-fm-code-highlight');

/**
 * The reason node: it exists only while the state is not `active`, carries
 * `data-fm-code-note` itself (never the host) and is unique in the tree, so a
 * mirrored attribute cannot silently satisfy the text assertions.
 */
function noteNode(container) {
  assert.equal(editorHostOf(container).hasAttribute('data-fm-code-note'), false,
    'data-fm-code-note belongs to the reason node; the host must not mirror it');
  const nodes = container.querySelectorAll('[data-fm-code-note]');
  assert.ok(nodes.length <= 1, `the reason node must be unique, saw ${nodes.length}`);
  return nodes[0] ?? null;
}

const noteState = container => noteNode(container)?.getAttribute('data-fm-code-note') ?? null;

/** Assert a degraded state renders exactly its frozen reason copy. */
function requireNote(container, value, key) {
  const node = noteNode(container);
  assert.ok(node, `the ${value} state must render a reason node`);
  assert.equal(node.getAttribute('data-fm-code-note'), value);
  assert.equal(node.className, 'fm-code-note', 'the reason node must carry exactly the fm-code-note class');
  assert.equal(node.textContent, translate(key));
  return node;
}

/**
 * The colours the rendered editor applies to its syntax tokens, as a set of CSS
 * colour values.
 *
 * Token spans carry classes rather than inline styles, and style-mod may install
 * rules through the CSSOM, so both the `<style>` text and the live `cssRules` are
 * read. The set holds distinct colour *values*: several classes that all resolve
 * to one colour would prove nothing about per-category colouring.
 */
function tokenColors(handle, container) {
  const rules = new Map();
  for (const node of handle.document.querySelectorAll('style')) {
    const sources = [node.textContent ?? ''];
    const sheet = node.sheet;
    if (sheet?.cssRules) for (const rule of sheet.cssRules) sources.push(rule.cssText ?? '');
    for (const css of sources) {
      for (const match of css.matchAll(/\.([^\s{,#]+)[^{,]*\{([^}]*)\}/g)) {
        const color = match[2].match(/(?:^|;)\s*color\s*:\s*([^;]+)/)?.[1]?.trim();
        if (color) rules.set(match[1], color);
      }
    }
  }
  const values = new Set();
  for (const span of container.querySelectorAll('.cm-line span')) {
    for (const name of String(span.className).split(/\s+/).filter(Boolean)) {
      if (rules.has(name)) values.add(rules.get(name));
    }
  }
  return values;
}

const renderedLines = container => [...container.querySelectorAll('.cm-line')].map(node => node.textContent ?? '');

/**
 * The document text of a normally rendered editor.
 *
 * `plain` and `limited` are frozen to keep the same real CodeMirror with only the
 * syntax extension removed, so a fallback control in those states is a defect
 * rather than an acceptable shape. Requiring the real view also keeps long-text
 * integrity from being "proved" against the virtualized DOM.
 */
function visibleText(container) {
  assert.ok(container.querySelector('.cm-content'),
    'active/plain/limited states must keep the real CodeMirror editor; only error may fall back');
  return readEditorText(container);
}

/** The text of the degraded (`error`) surface, which may be a native control. */
function degradedText(container) {
  const textarea = container.querySelector('textarea');
  if (textarea) return textarea.value;
  return container.textContent ?? '';
}

/** Type into the plain fallback control the way a browser would (real input event). */
async function typeIntoFallback(handle, control, text) {
  const setter = Object.getOwnPropertyDescriptor(handle.window.HTMLTextAreaElement.prototype, 'value').set;
  await act(async () => {
    setter.call(control, text);
    control.dispatchEvent(new handle.window.Event('input', { bubbles: true }));
  });
}

test('the shipped language map covers the frozen first batch and nothing beyond it', async testContext => {
  const state = await openEditor(testContext);
  const { codeLanguages } = state.client;
  const firstBatch = ['javascript', 'typescript', 'json', 'python', 'html', 'css', 'markdown', 'yaml', 'c', 'cpp', 'shellscript'];
  for (const hint of firstBatch) {
    const support = codeLanguages.languageExtensionFor(hint, `file.${hint}`);
    assert.ok(support, `the first batch must ship a grammar for ${hint}`);
    assert.equal(typeof support.language?.parser?.startParse, 'function', `${hint} must expose a real parser`);
    assert.equal(codeLanguages.languageIdFor(hint), hint, `languageIdFor(${hint}) must stay stable`);
  }
  // Suffixes the Host can report but this version deliberately does not support:
  // they must resolve to plain text, never to a guessed grammars.
  const unsupported = ['ruby', 'go', 'rust', 'java', 'csharp', 'kotlin', 'swift', 'php', 'toml', 'ini', 'mdx', 'scss', 'less', 'sql', 'xml', 'lua'];
  for (const hint of unsupported) {
    assert.equal(codeLanguages.languageIdFor(hint), 'plaintext', `${hint} is not first-batch and must be plain`);
    assert.equal(codeLanguages.languageExtensionFor(hint, `file.${hint}`), null, `${hint} must not get a grammar`);
  }
  assert.equal(codeLanguages.languageIdFor(undefined), 'plaintext', 'a missing hint is plain text');
  // The JSX dialect is chosen from the path within the already identified language.
  const plainJs = codeLanguages.languageExtensionFor('javascript', 'file.js');
  const jsx = codeLanguages.languageExtensionFor('javascript', 'file.jsx');
  assert.ok(jsx, 'the JSX dialect must exist for javascript + .jsx');
  assert.notEqual(jsx, plainJs, 'the JSX dialect must be a different support than plain javascript');
  assert.equal(codeLanguages.languageExtensionFor(undefined, 'file.jsx'), null,
    'a missing hint must stay plain even when the path looks like JSX');
});

test('the reason node never disagrees with the declared highlight state', async testContext => {
  const state = await openEditor(testContext, { mode: 'preview', languageHint: 'typescript', value: TS_SAMPLE });
  const cases = [
    [{ languageHint: 'typescript', value: TS_SAMPLE }, 'active'],
    [{ languageHint: undefined, value: TS_SAMPLE }, 'plain'],
    [{ languageHint: 'typescript', value: asciiBytes(1048577) }, 'limited'],
  ];
  for (const [patch, expected] of cases) {
    await act(async () => { await state.render(patch); });
    assert.equal(highlightState(state.container), expected);
    const note = noteNode(state.container);
    if (expected === 'active') assert.equal(note, null, 'an active state must not carry a reason node');
    else assert.equal(note?.getAttribute('data-fm-code-note'), expected, 'the reason node must match the declared state');
  }
});

test('the DOM harness itself mounts, commits effects and restores the environment', async testContext => {
  // Self-test for the plumbing, independent of the editor implementation: it keeps
  // a harness defect from being read later as an editor defect.
  const handle = installDom();
  let restored = false;
  const restore = () => { if (!restored) { restored = true; handle.restore(); } };
  testContext.after(restore);
  const container = handle.document.createElement('div');
  handle.body.appendChild(container);
  let mounts = 0;
  function Probe({ label }) {
    const ref = React.useRef(null);
    React.useEffect(() => {
      const node = handle.document.createElement('span');
      node.setAttribute('data-probe', label);
      node.textContent = label;
      ref.current.appendChild(node);
      mounts += 1;
      return () => { node.remove(); };
    }, [label]);
    return React.createElement('div', { ref, className: 'harness-probe' });
  }
  const mount = await mountInto(container, React.createElement(Probe, { label: 'first' }));
  assert.equal(mounts, 1, 'mountInto must commit effects inside act');
  assert.equal(container.querySelector('[data-probe="first"]').textContent, 'first');
  await mount.render(React.createElement(Probe, { label: 'second' }));
  assert.equal(container.querySelector('[data-probe="second"]').textContent, 'second', 'render must update the committed tree');
  await mount.unmount();
  assert.equal(container.childNodes.length, 0, 'unmount must release the rendered tree');
  assert.equal(handle.errors.length, 0, 'the harness environment must raise no jsdom errors');
  restore();
  assert.notEqual(globalThis.window, handle.window, 'the harness must hand the previous global environment back');
});

test('the shipped bundle exposes the frozen editor surface', async testContext => {
  const state = await openEditor(testContext);
  // The one place the complete frozen export surface is asserted. Every other test
  // fails on what it actually needs, so a single missing re-export cannot mask the
  // behaviour of thirty others.
  requireEditorSurface(state.client);
  assert.equal(state.client.editor.HIGHLIGHT_MAX_BYTES, 1048576, 'the byte budget must be the frozen 1 MiB');
  assert.equal(state.client.editor.HIGHLIGHT_MAX_LINE_UNITS, 20000, 'the line budget must be the frozen 20000 UTF-16 units');
});

test('preview renders real syntax colours drawn only from theme tokens', async testContext => {
  const state = await openEditor(testContext, { mode: 'preview' });
  const { container, handle } = state;
  const host = editorHostOf(container);
  assert.equal(host.getAttribute('data-fm-code-mode'), 'preview');
  assert.equal(host.getAttribute('data-fm-code-language'), LANGUAGE_ID.typescript);
  assert.equal(highlightState(container), 'active', 'the editor must be highlighted, not silently degraded');
  assert.equal(noteState(container), null, 'no reason node may exist while highlighting is active');
  assert.ok(container.textContent.includes(translate('code.language', { language: displayNameFor(state.client, LANGUAGE_ID.typescript) })),
    'an active editor must name the language it highlighted with, through code.language');
  assert.ok(container.querySelector('.cm-editor'), 'a real CodeMirror editor must be mounted');
  assert.equal(container.querySelector('.cm-content').getAttribute('contenteditable'), 'false', 'preview must be read-only in the DOM');
  assert.deepEqual(renderedLines(container), TS_SAMPLE.split('\n'), 'preview must show the file text verbatim');
  assert.equal(readEditorText(container), TS_SAMPLE, 'no truncation or renaming of the document text');

  const colors = tokenColors(handle, container);
  assert.ok(colors.size >= 2, `a highlighted sample needs at least two distinct token colours, saw ${colors.size}: ${[...colors].join(', ')}`);
  for (const color of colors) {
    assert.match(color, /^var\(--(?:shiki|dsw)-[a-z0-9-]+\)$/, `a token colour must be a theme token, saw ${color}`);
  }
  assert.equal(container.querySelector('[aria-label="Code"]') !== null, true, 'the editor must expose its accessible name');
  assertNoDomErrors(handle);
});

test('an unsupported hint stays plain, keeps its text and is never multi-coloured', async testContext => {
  const state = await openEditor(testContext, { mode: 'preview', path: 'sample.bin', languageHint: undefined });
  const { container, handle } = state;
  assert.equal(highlightState(container), 'plain');
  assert.equal(editorHostOf(container).getAttribute('data-fm-code-language'), 'plaintext');
  requireNote(container, 'plain', 'code.language.plaintext');
  assert.equal(visibleText(container), TS_SAMPLE, 'plain text must still show the whole file');
  assert.equal(tokenColors(handle, container).size, 0, 'plain text must not acquire token colours');
  assert.equal(container.querySelector('.fm-code-language'), null,
    'the plain state must not repeat its explanation as a language label');
});

test('markup in a file is displayed as text and never turned into live DOM', async testContext => {
  const state = await openEditor(testContext, { mode: 'preview', path: 'page.html', value: HTML_SAMPLE, languageHint: 'html' });
  const { container, handle } = state;
  assert.equal(highlightState(container), 'active', 'the html grammar must apply');
  assert.equal(container.querySelector('script'), null, 'a displayed script tag must not become a script element');
  assert.equal(container.querySelector('img'), null, 'a displayed img tag must not become an image element');
  assert.equal(state.handle.window.__executed, undefined, 'displayed content must never execute');
  assert.deepEqual(renderedLines(container), HTML_SAMPLE.split('\n'));
  assert.equal(readEditorText(container), HTML_SAMPLE);
  assertNoDomErrors(handle);
});

test('empty document mounts without content, colour or spurious change', async testContext => {
  const state = await openEditor(testContext, { mode: 'edit', value: '', path: 'empty.ts', languageHint: 'typescript' });
  assert.equal(highlightState(state.container), 'active', 'an empty document is still a normal highlighted document');
  assert.equal(readEditorText(state.container), '');
  assert.deepEqual(state.calls, [], 'mounting must never report a change');
});

for (const [name, bytes, expected] of [['exactly 1 MiB', 1048576, 'active'], ['1 MiB + 1 byte', 1048577, 'limited']]) {
  test(`the byte budget is applied to UTF-8 size: ${name}`, async testContext => {
    const value = asciiBytes(bytes);
    assert.equal(utf8Bytes(value), bytes, 'fixture self-check: the sample must be exactly the intended byte size');
    assert.ok(longestLine(value) <= 20000, 'fixture self-check: the line budget must not be the reason here');
    const state = await openEditor(testContext, { mode: 'edit', value, path: 'size.ts', languageHint: 'typescript' });
      assert.equal(highlightState(state.container), expected);
    assert.equal(visibleText(state.container), value, 'the budget must never truncate the document');
    if (expected === 'limited') requireNote(state.container, 'limited', 'code.highlightLimited');
  });
}

for (const [name, unitCount, expected] of [['exactly 20000 UTF-16 units', 20000, 'active'], ['20001 UTF-16 units', 20001, 'limited']]) {
  test(`the line budget counts UTF-16 units per line: ${name}`, async testContext => {
    const value = `${'a'.repeat(unitCount)}\nplain\n`;
    assert.ok(utf8Bytes(value) < 1048576, 'fixture self-check: the byte budget must not be the reason here');
    const state = await openEditor(testContext, { mode: 'edit', value, path: 'line.ts', languageHint: 'typescript' });
      assert.equal(highlightState(state.container), expected);
    assert.equal(longestLine(value), unitCount);
  });
}

test('the byte budget uses encoded size, not JavaScript string length (CJK trap)', async testContext => {
  const value = Array.from({ length: 400 }, () => '中'.repeat(1000)).join('\n');
  assert.ok(value.length < 1048576, 'fixture self-check: the JavaScript length stays under 1 MiB');
  assert.ok(utf8Bytes(value) > 1048576, 'fixture self-check: the encoded size exceeds 1 MiB');
  assert.ok(longestLine(value) < 20000, 'fixture self-check: the line budget must not be the reason here');
  const state = await openEditor(testContext, { mode: 'edit', value, path: 'cjk.ts', languageHint: 'typescript' });
  assert.equal(highlightState(state.container), 'limited', 'a character-count comparison would wrongly stay highlighted');
  assert.equal(visibleText(state.container), value);
});

test('the shipped classifier agrees with the rendered editor at both boundaries', async testContext => {
  const state = await openEditor(testContext);
  const { classifyHighlightBudget } = state.client.codeLanguages;
  const cases = [
    ['const a = 1;\n', 'active'],
    [asciiBytes(1048576), 'active'],
    [asciiBytes(1048577), 'limited'],
    [`${'a'.repeat(20000)}\n`, 'active'],
    [`${'a'.repeat(20001)}\n`, 'limited'],
  ];
  for (const [value, expected] of cases) {
    assert.equal(classifyHighlightBudget(value), expected, `classifyHighlightBudget disagreed for a ${value.length}-character sample`);
  }
  await state.render({ mode: 'edit', value: cases[2][0], path: 'x.ts', languageHint: 'typescript' });
  assert.equal(highlightState(state.container), 'limited', 'the classifier and the rendered state must not diverge');
});

test('preview never saves, and a non-writable edit view stays read-only for the keyboard path', async testContext => {
  const state = await openEditor(testContext, { mode: 'preview' });
  const { container, handle } = state;
  const content = container.querySelector('.cm-content');
  content.dispatchEvent(new handle.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
  await flushDom();
  assert.equal(state.saveCalls, 0, 'preview has nothing to save and must not call onSave');

  await state.render({ mode: 'edit', canWrite: false });
  const readOnlyContent = container.querySelector('.cm-content');
  // Permission semantics: a preview, or any non-writable document, is not
  // content-editable at all and announces aria-readonly.
  assert.equal(readOnlyContent.getAttribute('contenteditable'), 'false',
    'a non-writable document must not be content-editable');
  assert.equal(readOnlyContent.getAttribute('aria-readonly'), 'true', 'a non-writable view must announce its read-only state');
  readOnlyContent.dispatchEvent(new handle.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
  await flushDom();
  assert.equal(state.saveCalls, 0, 'a non-writable document must not save');
});

test('edit mode reports a real document edit through onChange and saves on Ctrl/Cmd+S', async testContext => {
  const state = await openEditor(testContext, { mode: 'edit', canWrite: true });
  const { container, handle } = state;
  const host = editorHostOf(container);
  assert.equal(host.getAttribute('data-fm-code-mode'), 'edit');
  assert.equal(container.querySelector('.cm-content').getAttribute('contenteditable'), 'true');
  assert.notEqual(container.querySelector('.cm-content').getAttribute('aria-readonly'), 'true',
    'a writable document must not announce itself as read-only');

  await setEditorText(container, 'const edited = true;\n');
  assert.deepEqual(state.calls, ['const edited = true;\n'], 'a real edit must reach onChange exactly once');
  assert.equal(readEditorText(container), 'const edited = true;\n');

  const event = new handle.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
  container.querySelector('.cm-content').dispatchEvent(event);
  await flushDom();
  assert.equal(state.saveCalls, 1, 'Ctrl+S must reach onSave once');
  assert.equal(event.defaultPrevented, true, 'the browser save dialog must be suppressed');
  assertNoDomErrors(handle);
});

test('programmatic sync never echoes back, never rebuilds the view and keeps the document', async testContext => {
  const state = await openEditor(testContext, { mode: 'edit' });
  const { container } = state;
  const before = editorViewOf(container);
  await act(async () => { await state.render({ value: TS_SAMPLE }); });
  assert.deepEqual(state.calls, [], 're-rendering identical text must not report a change');
  assert.equal(editorViewOf(container), before, 'the editor instance must survive a value sync');

  const external = 'const external = 1;\n';
  await act(async () => { await state.render({ value: external }); });
  assert.equal(readEditorText(container), external, 'an external snapshot must reach the editor text');
  assert.deepEqual(state.calls, [], 'an external sync is not a user change');
  assert.equal(editorViewOf(container), before, 'an external sync must not rebuild the instance (cursor and undo would be lost)');
});

test('two documents keep independent text, and a rename relanguages without touching the draft', async testContext => {
  const state = await openEditor(testContext, { mode: 'edit', documentId: 'doc-a', value: 'first\n' });
  const { container, handle } = state;
  const second = handle.document.createElement('div');
  handle.body.appendChild(second);
  const secondProps = { ...state.props, documentId: 'doc-b', value: 'second\n', path: 'b.ts', languageHint: 'typescript' };
  const secondMount = await mountInto(second, React.createElement(state.client.CodeEditor, secondProps));
  assert.equal(readEditorText(container), 'first\n');
  assert.equal(readEditorText(second), 'second\n');
  assert.notEqual(editorViewOf(container), editorViewOf(second), 'documents must not share one editor instance');
  await secondMount.unmount();
  second.remove();

  const view = editorViewOf(container);
  await act(async () => { await state.render({ path: 'renamed.tsx', languageHint: 'typescript' }); });
  assert.equal(editorHostOf(container).getAttribute('data-fm-code-language'), LANGUAGE_ID.typescript);
  assert.equal(readEditorText(container), 'first\n', 'a rename must not touch the draft text');
  assert.deepEqual(state.calls, [], 'a rename is not a user change');
  assert.equal(editorViewOf(container), view, 'a language change must reconfigure, not rebuild');
});

test('a missing editor capability degrades to an editable plain-text fallback', async testContext => {
  // This proves the capability pre-check fallback only: with no
  // requestAnimationFrame the component must not build a CodeMirror view at all.
  // A parser failure is a different path and is covered separately below.
  const state = await openEditor(testContext, { mode: 'edit', canWrite: true }, { raf: false });
  const { container, handle } = state;
  assert.equal(highlightState(container), 'error');
  requireNote(container, 'error', 'code.highlightUnavailable');
  assert.equal(container.querySelector('.cm-editor'), null, 'the failed environment must not leave a half-built editor');

  const fallback = container.querySelector('textarea');
  assert.ok(fallback, 'a degraded view must still offer an editable plain-text control');
  assert.equal(fallback.getAttribute('data-fm-code-fallback'), 'edit',
    'the fallback control must be marked so scoped styles and assertions agree on it');
  assert.equal(fallback.value, TS_SAMPLE, 'the degraded view must carry the full draft');
  await typeIntoFallback(handle, fallback, 'typed into the fallback\n');
  assert.deepEqual(state.calls, ['typed into the fallback\n'], 'the degraded control must still report edits');
});

test('incomplete syntax stays highlighted and is never treated as a failure', async testContext => {
  const broken = 'const broken = "unterminated\nfunction f( { \n/* open comment\n';
  const state = await openEditor(testContext, { mode: 'edit', value: broken, path: 'broken.ts', languageHint: 'typescript' });
  assert.equal(highlightState(state.container), 'active', 'incomplete syntax is not a fault');
  assert.equal(noteState(state.container), null, 'a highlighted document has no reason node');
  assert.equal(readEditorText(state.container), broken);
});

test('the real document store keeps drafts across edits and external snapshots', async testContext => {
  const state = await openEditor(testContext, { mode: 'edit' });
  const { client, handle } = state;
  // A dedicated container: `openEditor` already created a react root, and React
  // refuses two roots on the same node.
  const container = handle.document.createElement('div');
  handle.body.appendChild(container);
  const store = client.createDocumentStore();
  const documentId = store.open({ rootId: 'root', path: 'sample.ts', text: TS_SAMPLE, version: 'v1', bytes: TS_SAMPLE.length, newline: 'lf', encoding: 'utf-8', mode: 0o644 });
  const changes = [];
  function Bound() {
    const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const document = snapshot.documents.find(item => item.id === documentId);
    return React.createElement(client.CodeEditor, {
      documentId, path: document.path, value: document.draft, mode: 'edit', canWrite: true,
      languageHint: 'typescript', ariaLabel: 'Code', t: translate,
      onChange: text => { changes.push(text); store.edit(documentId, text); },
      onSave: () => {},
    });
  }
  let bound = null;
  let boundDestroyed = false;
  testContext.after(async () => {
    if (boundDestroyed) return;
    boundDestroyed = true;
    await bound?.unmount();
  });
  bound = await mountInto(container, React.createElement(Bound));
  assert.equal(readEditorText(container), TS_SAMPLE);

  await setEditorText(container, 'draft from the real editor\n');
  await flushDom();
  const dirty = store.getSnapshot().documents.find(item => item.id === documentId);
  assert.equal(dirty.draft, 'draft from the real editor\n', 'a real edit must reach the document store');
  assert.equal(dirty.dirty, true);
  assert.equal(changes.length, 1, 'the store echo must not produce a second change callback');
  assert.equal(readEditorText(container), 'draft from the real editor\n', 'the rebuilt draft must not replace the editor text');

  // An external write lands through the store's subscription, so the React update it
  // triggers has to happen inside `act` — otherwise React reports the update as
  // unwrapped and the test would be relying on a warning nobody can see.
  await act(async () => {
    store.open({ rootId: 'root', path: 'sample.ts', text: 'external write\n', version: 'v2' }, { activate: false });
  });
  await flushDom();
  const conflicted = store.getSnapshot().documents.find(item => item.id === documentId);
  assert.equal(conflicted.draft, 'draft from the real editor\n', 'an external snapshot must preserve the draft');
  assert.equal(conflicted.external?.text, 'external write\n');
  assert.equal(readEditorText(container), 'draft from the real editor\n', 'the editor must keep showing the preserved draft');
  assert.equal(changes.length, 1, 'a background refresh must not report a user change');
  await bound.unmount();
  boundDestroyed = true;
});

test('unmounting releases the editor and stops reporting events', async testContext => {
  const state = await openEditor(testContext, { mode: 'edit' });
  const { container, handle } = state;
  const content = container.querySelector('.cm-content');
  // Captured before teardown: the window is closed by then, and the point of the
  // assertion is that a released editor ignores input, not that jsdom can build
  // an event afterwards.
  const KeyboardEvent = handle.window.KeyboardEvent;
  await act(async () => { await state.destroy(); });
  assert.equal(container.childNodes.length, 0, 'unmount must remove the editor tree');
  content.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
  await flushDom();
  assert.equal(state.saveCalls, 0, 'a released editor must not keep reporting events');
  assertNoDomErrors(handle);
});

test('a superseded view cannot save, and the view that replaced it still can', async testContext => {
  // A document switch keeps the component instance and builds a fresh view, so a
  // per-component "released" flag is not enough: the new mount would reset it and
  // the superseded binding would come back to life. The guard has to be per view.
  const state = await openEditor(testContext, { mode: 'edit', documentId: 'doc-a', value: 'const a = 1;\n', path: 'x.ts', languageHint: 'typescript' });
  const { container, handle } = state;
  const supersededContent = container.querySelector('.cm-content');
  const supersededView = editorViewOf(container);
  await act(async () => { await state.render({ documentId: 'doc-b', path: 'y.ts', languageHint: 'typescript', value: 'const b = 2;\n' }); });
  const currentContent = container.querySelector('.cm-content');
  assert.notEqual(currentContent, supersededContent, 'a document switch must build a fresh view for the new document');
  assert.equal(supersededView.destroyed, true, 'the superseded view must be destroyed');
  assert.equal(state.saveCalls, 0, 'the switch itself must not save anything');

  const ctrlS = () => new handle.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
  supersededContent.dispatchEvent(ctrlS());
  await flushDom();
  assert.equal(state.saveCalls, 0, 'the superseded view must never be able to save the document on screen');
  currentContent.dispatchEvent(ctrlS());
  await flushDom();
  assert.equal(state.saveCalls, 1, 'the current view must still save');
});

test('no completion or diagnostic surface is attached to the editor', async testContext => {
  const state = await openEditor(testContext, { mode: 'edit' });
  const { container, handle } = state;
  container.querySelector('.cm-content').dispatchEvent(new handle.window.KeyboardEvent('keydown', { key: ' ', ctrlKey: true, bubbles: true, cancelable: true }));
  await flushDom();
  assert.equal(container.querySelector('.cm-tooltip-autocomplete'), null, 'the file manager must not ship an autocomplete popup');
  assert.equal(container.querySelector('.cm-diagnostic'), null, 'the file manager must not ship diagnostics');
});

test('replayed auto-close trigger keys never rewrite the document in the JSX dialect', async testContext => {
  // Auto-closing (JSX in lang-javascript, html()) and other input handlers only run
  // on real input events, which jsdom cannot deliver through CodeMirror — the
  // editor's own input path ignores them here. So this does not prove the absence of
  // auto-closing; what it does prove is that the rendered artifact contains no raw
  // listener that mutates the document behind the editor's back, and that the
  // automatic-edit surface stays empty. The auto-close typing behaviours remain a
  // browser-verification item (SPEC R21.11), and no fake DOM listener is added here
  // to cancel a library behaviour.
  const state = await openEditor(testContext, { mode: 'edit', path: 'app.jsx', languageHint: 'javascript', value: 'const view = <div>' });
  const { container, handle } = state;
  // Self-verifying fixture: the paths match the host's own mapping, so this really
  // exercises the JSX dialect rather than a JavaScript grammar under a JSX name.
  const { dialectFor } = state.client.codeLanguages;
  assert.equal(dialectFor('javascript', 'app.jsx'), 'jsx', 'the fixture must exercise the JSX dialect');
  assert.equal(dialectFor('typescript', 'app.tsx'), 'tsx', 'the host reports .tsx as TypeScript, so TSX is the TS dialect');
  assert.equal(dialectFor(undefined, 'app.jsx'), null, 'a missing hint stays plain even when the path looks like JSX');
  const content = container.querySelector('.cm-content');
  content.focus();
  const before = readEditorText(container);
  for (const [type, data] of [['beforeinput', '<'], ['input', '<'], ['beforeinput', '>'], ['input', '>'], ['beforeinput', '{'], ['input', '{'], ['beforeinput', '"'], ['input', '"']]) {
    content.dispatchEvent(new handle.window.InputEvent(type, { inputType: 'insertText', data, bubbles: true, cancelable: true, composed: true }));
  }
  // `Enter` is deliberately absent: measured, it is a real edit command in
  // CodeMirror's default keymap (`insertNewlineAndIndent`) and legitimately inserts
  // a line break. Only the auto-closing triggers are replayed here.
  for (const key of ['<', '>', '{', '"']) {
    content.dispatchEvent(new handle.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }
  await flushDom();
  assert.equal(readEditorText(container), before, 'no event may cause the editor to insert or complete text on its own');
  assert.deepEqual(state.calls, [], 'an automatic edit must never be reported as a user change');
  assert.equal(container.querySelector('.cm-tooltip-autocomplete'), null);
  assert.equal(container.querySelector('.cm-diagnostic'), null);
});

test('highlighting resumes once the text is back within budget', async testContext => {
  const state = await openEditor(testContext, { mode: 'edit', value: asciiBytes(1048577), path: 'size.ts', languageHint: 'typescript' });
  assert.equal(highlightState(state.container), 'limited');
  requireNote(state.container, 'limited', 'code.highlightLimited');
  await act(async () => { await state.render({ value: TS_SAMPLE }); });
  assert.equal(highlightState(state.container), 'active', 'the budget state must not stick after the text shrinks');
  assert.equal(noteState(state.container), null, 'the reason node must disappear again');
  assert.equal(readEditorText(state.container), TS_SAMPLE);
});

test('a degraded read-only preview still explains why it has no colours', async testContext => {
  const value = asciiBytes(1048577);
  const state = await openEditor(testContext, { mode: 'preview', canWrite: false, value, path: 'size.ts', languageHint: 'typescript' });
  assert.equal(highlightState(state.container), 'limited');
  requireNote(state.container, 'limited', 'code.highlightLimited');
  assert.equal(visibleText(state.container), value, 'a degraded preview must still carry the whole file');
  // `limited` keeps the real editor (only the syntax extension is dropped), so the
  // editor must still be there and still be read-only.
  const content = state.container.querySelector('.cm-content');
  assert.ok(content, 'limited is not a fallback state: the real editor must stay mounted');
  assert.equal(content.getAttribute('contenteditable'), 'false', 'preview stays read-only even when degraded');
});

/**
 * Replace the shared language parser's entry point with a thrower, the way a real
 * parser failure would surface: `@codemirror/language` calls `parser.startParse`
 * for every parse, and `languageExtensionFor` hands out the same language
 * instance for a given dialect, so the component's own parse is affected without
 * any production test seam. Returns a restore function.
 */
function breakParser(client, hint, path) {
  const support = client.codeLanguages.languageExtensionFor(hint, path);
  assert.ok(support?.language?.parser,
    'languageExtensionFor must return a LanguageSupport whose parser is reachable, otherwise a parser failure cannot be exercised without a production seam');
  const parser = support.language.parser;
  const original = parser.startParse;
  parser.startParse = () => { throw new Error('injected parser failure'); };
  return () => { parser.startParse = original; };
}

// Parser failures are checked in the three phases a document really goes through,
// because a failure raised inside `EditorState.update` is not the same event as one
// raised while a view is being constructed: each phase has to degrade on its own.
test('a parser failure while mounting a document degrades instead of breaking the panel', async testContext => {
  // A genuine construction-phase failure: the parser is broken *before* the first
  // mount, so the failing parse happens while the editor state is being created.
  let restoreParser = null;
  let state = null;
  try {
    state = await openEditor(testContext, { mode: 'edit', value: TS_SAMPLE, path: 'fresh.ts', languageHint: 'typescript' }, {
      beforeMount: client => { restoreParser = breakParser(client, 'typescript', 'fresh.ts'); },
    });
    assert.ok(restoreParser, 'the parser must have been broken before mounting');
    assert.equal(highlightState(state.container), 'error', 'a construction-phase parser failure must degrade, not escape');
    requireNote(state.container, 'error', 'code.highlightUnavailable');
    assert.ok(degradedText(state.container).includes('const answer'), 'the draft must remain visible after a construction-phase failure');
  } finally {
    restoreParser?.();
  }
});

test('a parser failure while applying new text from props degrades instead of breaking the panel', async testContext => {
  const state = await openEditor(testContext, { mode: 'edit', value: TS_SAMPLE, path: 'x.ts', languageHint: 'typescript' });
  const restoreParser = breakParser(state.client, 'typescript', 'x.ts');
  try {
    const next = 'const fromProps = 1;\n';
    await act(async () => { await state.render({ value: next }); });
    assert.equal(highlightState(state.container), 'error', 'a props-update parser failure must degrade, not escape');
    requireNote(state.container, 'error', 'code.highlightUnavailable');
    assert.ok(degradedText(state.container).includes('const fromProps = 1;'), 'the newly supplied text must not be lost');
  } finally {
    restoreParser();
  }
});

test('a parser failure during a transaction degrades instead of breaking the panel', async testContext => {
  const state = await openEditor(testContext, { mode: 'edit', value: TS_SAMPLE, path: 'x.ts', languageHint: 'typescript' });
  const restoreParser = breakParser(state.client, 'typescript', 'x.ts');
  try {
    // The same `view.dispatch` path a user edit takes, carrying the `userEvent`
    // string shorthand: the bundle's own state module turns it into the annotation
    // (`resolveTransaction`), so no cross-copy object is needed. Input *handlers*
    // (auto-closing and friends) only run on real DOM input and stay
    // browser-verified.
    await dispatchEditor(state.container, { changes: { from: 0, to: 0, insert: 'x' }, userEvent: 'input.type' });
    assert.equal(highlightState(state.container), 'error', 'a transaction-phase parser failure must degrade, not escape');
    requireNote(state.container, 'error', 'code.highlightUnavailable');
    assert.ok(degradedText(state.container).includes('const answer'), 'the document must remain visible after a transaction-phase failure');
  } finally {
    restoreParser();
  }
});

test('the limited budget withdraws the syntax instead of only relabelling it', async testContext => {
  const state = await openEditor(testContext, { mode: 'edit', value: TS_SAMPLE, path: 'size.ts', languageHint: 'typescript' });
  const { container, handle } = state;
  assert.ok(tokenColors(handle, container).size >= 2, 'the fixture must start out genuinely highlighted');
  const oversize = asciiBytes(1048577);
  await act(async () => { await state.render({ value: oversize }); });
  assert.equal(highlightState(container), 'limited');
  assert.ok(container.querySelector('.cm-content'), 'limited is not a fallback state; the editor must stay mounted');
  assert.equal(visibleText(container), oversize, 'the document must survive the budget switch');
  assert.equal(tokenColors(handle, container).size, 0,
    'a limited document must actually lose its token colours, not merely report a different state');
});

test('the limited budget stops parsing instead of only hiding the colours', async testContext => {
  // Decisive check that the grammar itself is withdrawn: with a broken parser an
  // over-budget document must stay `limited`. If the grammar were still applied the
  // parse would throw and the editor would degrade to `error` — which is exactly
  // what "the budget only changed the label" looks like from the outside. The
  // colour assertion above cannot tell those two apart.
  const oversize = asciiBytes(1048577);
  let restoreParser = null;
  let state = null;
  try {
    state = await openEditor(testContext, { mode: 'edit', value: oversize, path: 'x.ts', languageHint: 'typescript' }, {
      beforeMount: client => { restoreParser = breakParser(client, 'typescript', 'x.ts'); },
    });
    assert.equal(highlightState(state.container), 'limited',
      'an over-budget document must not be parsed at all, so a broken parser cannot surface');
    assert.equal(visibleText(state.container), oversize, 'the document must still be intact');
  } finally {
    restoreParser?.();
  }
});

test('the save shortcut follows the platform modifier instead of a hard-coded key', async testContext => {
  // Default (non-mac) environment: Ctrl saves and Meta does not.
  const pc = await openEditor(testContext, { mode: 'edit' });
  pc.container.querySelector('.cm-content').dispatchEvent(
    new pc.handle.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
  await flushDom();
  assert.equal(pc.saveCalls, 1, 'Ctrl+S must save off macOS');
  pc.container.querySelector('.cm-content').dispatchEvent(
    new pc.handle.window.KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true }));
  await flushDom();
  assert.equal(pc.saveCalls, 1, 'Meta+S is not the save shortcut off macOS');

  // macOS environment, applied before the bundle is evaluated so CodeMirror's
  // `Mod` resolves to Cmd.
  const mac = await openEditor(testContext, { mode: 'edit' }, { platform: 'MacIntel' });
  const metaEvent = new mac.handle.window.KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true });
  mac.container.querySelector('.cm-content').dispatchEvent(metaEvent);
  await flushDom();
  assert.equal(mac.saveCalls, 1, 'Meta+S must save on macOS');
  assert.equal(metaEvent.defaultPrevented, true, 'the browser save dialog must be suppressed on macOS too');
});

test('undo and the caret survive within the current document', async testContext => {
  const state = await openEditor(testContext, { mode: 'edit' });
  const { container, handle } = state;
  await setEditorText(container, 'changed text\n');
  assert.deepEqual(state.calls, ['changed text\n'], 'the edit must be reported once');

  await dispatchEditor(container, { selection: { anchor: 3 } });
  assert.equal(editorViewOf(container).state.selection.main.from, 3, 'the test must be able to place the caret');
  await act(async () => { await state.render({ value: 'changed text\n' }); });
  assert.equal(editorViewOf(container).state.selection.main.from, 3,
    'a same-content flow must not disturb the caret or selection');

  container.querySelector('.cm-content').dispatchEvent(
    new handle.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
  await flushDom();
  assert.equal(readEditorText(container), TS_SAMPLE, 'undo must restore the previous document');
  assert.equal(state.calls.length, 2, 'an undo is a real document change and must be reported exactly once more');
  assert.equal(state.calls.at(-1), TS_SAMPLE, 'the reported text must be the restored document');
});

test('a failure in one document does not mark a healthy document as failed', async testContext => {
  const state = await openEditor(testContext, { mode: 'edit', documentId: 'doc-a', value: 'first\n', path: 'x.ts', languageHint: 'typescript' });
  const restoreParser = breakParser(state.client, 'typescript', 'x.ts');
  try {
    await act(async () => { await state.render({ documentId: 'doc-a', path: 'x.ts', languageHint: 'typescript', value: 'first\nexternal\n' }); });
    assert.equal(highlightState(state.container), 'error', 'the failing document must degrade');
  } finally {
    // The parser is shared by every document, so it must be healthy again *before*
    // the switch: otherwise the next document would fail for the same reason and the
    // test would prove nothing about state leaking between documents.
    restoreParser();
  }
  await act(async () => { await state.render({ documentId: 'doc-b', path: 'y.ts', languageHint: 'typescript', value: 'second\n' }); });
  assert.equal(highlightState(state.container), 'active', 'a healthy document must not inherit another document failure');
  assert.equal(noteState(state.container), null, 'a healthy document must not carry a reason node');
  assert.equal(visibleText(state.container), 'second\n');
  await act(async () => { await state.render({ documentId: 'doc-a', path: 'x.ts', languageHint: 'typescript', value: 'first\n' }); });
  assert.equal(highlightState(state.container), 'active', 'the recovered document must re-highlight once its parser works');
  assert.equal(visibleText(state.container), 'first\n');
});

test('a late dispatch from the previous document cannot damage the current one', async testContext => {
  const state = await openEditor(testContext, { mode: 'edit', documentId: 'doc-a', value: 'first\n', path: 'x.ts', languageHint: 'typescript' });
  const { container } = state;
  const previousView = editorViewOf(container);
  await act(async () => { await state.render({ documentId: 'doc-b', path: 'y.ts', languageHint: 'typescript', value: 'second\n' }); });
  assert.equal(highlightState(container), 'active', 'the new document must start healthy');
  // A dispatch that belongs to the document that is no longer shown: whatever it
  // does — throw because its view was released, or apply to a detached view — it
  // must not degrade or rewrite the document on screen.
  try {
    previousView.dispatch({ changes: { from: 0, to: 0, insert: 'late' } });
  } catch {
    // A released view refusing the dispatch is an acceptable outcome.
  }
  await flushDom();
  assert.equal(highlightState(container), 'active', 'a late dispatch from the previous document must not degrade the current one');
  assert.equal(visibleText(container), 'second\n', 'the current document must be untouched by a late dispatch');
});

test('a degraded editor keeps taking new text and still reports the edits made in it', async testContext => {
  const state = await openEditor(testContext, { mode: 'edit', value: TS_SAMPLE, path: 'x.ts', languageHint: 'typescript' });
  const { container, handle } = state;
  const restoreParser = breakParser(state.client, 'typescript', 'x.ts');
  try {
    await act(async () => { await state.render({ value: 'first from props\n' }); });
    assert.equal(highlightState(container), 'error', 'the injected parser failure must degrade the editor');
    const fallbackNow = () => container.querySelector('textarea[data-fm-code-fallback="edit"]');
    assert.equal(fallbackNow().value, 'first from props\n', 'the degraded control must show the text the panel wants');

    await act(async () => { await state.render({ value: 'second from props\n' }); });
    assert.equal(fallbackNow().value, 'second from props\n', 'a degraded editor must keep accepting new text from the panel');

    await typeIntoFallback(handle, fallbackNow(), 'typed while degraded\n');
    assert.deepEqual(state.calls, ['typed while degraded\n'], 'editing the degraded control must still reach onChange');

    await act(async () => { await state.render({ value: 'typed while degraded\n' }); });
    assert.equal(fallbackNow().value, 'typed while degraded\n', 'an echo of the reported text must not disturb the degraded control');
    assert.equal(state.calls.length, 1, 'an echo of the reported text must not be reported again');
  } finally {
    restoreParser();
  }
});

test('a degraded preview never reports a change', async testContext => {
  const state = await openEditor(testContext, { mode: 'preview', canWrite: false, value: TS_SAMPLE, path: 'x.ts', languageHint: 'typescript' });
  const { container, handle } = state;
  const restoreParser = breakParser(state.client, 'typescript', 'x.ts');
  try {
    await act(async () => { await state.render({ value: 'preview text\n' }); });
    assert.equal(highlightState(container), 'error', 'the injected parser failure must degrade the preview');
    const fallback = container.querySelector('[data-fm-code-fallback="preview"]');
    assert.ok(fallback, 'a degraded preview must still show the document');
    assert.equal(fallback.textContent, 'preview text\n');
    assert.equal(container.querySelector('textarea'), null, 'a preview must not expose an editable control');
    fallback.dispatchEvent(new handle.window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    fallback.dispatchEvent(new handle.window.InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true, composed: true }));
    fallback.dispatchEvent(new handle.window.Event('input', { bubbles: true }));
    await flushDom();
    assert.deepEqual(state.calls, [], 'a preview must never report a change, not even while degraded');
  } finally {
    restoreParser();
  }
});

test('a degraded read-only edit view refuses programmatic input instead of reporting it', async testContext => {
  const state = await openEditor(testContext, { mode: 'edit', canWrite: false, value: TS_SAMPLE, path: 'x.ts', languageHint: 'typescript' });
  const { container, handle } = state;
  const restoreParser = breakParser(state.client, 'typescript', 'x.ts');
  try {
    await act(async () => { await state.render({ value: 'read only text\n' }); });
    assert.equal(highlightState(container), 'error');
    const fallback = container.querySelector('textarea[data-fm-code-fallback="edit"]');
    assert.equal(fallback.readOnly, true, 'a non-writable edit view must be read-only, degraded or not');
    assert.equal(fallback.value, 'read only text\n');
    await typeIntoFallback(handle, fallback, 'must not be reported\n');
    assert.deepEqual(state.calls, [], 'a read-only control must not turn programmatic input into a reported change');
  } finally {
    restoreParser();
  }
});

test('the editing surface is keyboard focusable and Ctrl+A selects the whole document', async testContext => {
  const lines = 5000;
  const long = Array.from({ length: lines }, (_, index) => `const value${index} = ${index};`).join('\n') + '\n';
  const state = await openEditor(testContext, { mode: 'edit', value: long, path: 'big.ts', languageHint: 'typescript' });
  const { container, handle } = state;
  const content = container.querySelector('.cm-content');
  assert.equal(content.getAttribute('contenteditable'), 'true');
  // The focusable declaration belongs on the editing surface or the element that
  // hosts it; either way the editor must not be reachable only by mouse.
  const focusable = container.querySelector('[data-fm-code] [tabindex="0"], [data-fm-code][tabindex="0"]');
  assert.ok(focusable, 'the editing surface must declare tabindex="0" so the editor can be focused from the keyboard');

  const view = editorViewOf(container);
  assert.ok(view.state.doc.length > lines, 'the fixture must be longer than one viewport');
  assert.ok(container.querySelectorAll('.cm-line').length < lines,
    'the fixture must be long enough for CodeMirror to render only a viewport slice');
  content.dispatchEvent(new handle.window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }));
  await flushDom();
  assert.equal(view.state.selection.main.from, 0, 'Ctrl+A must select from the start of the document');
  assert.equal(view.state.selection.main.to, view.state.doc.length,
    'Ctrl+A must select the whole document even though only a slice of it is rendered');
});

// Acceptance 12 of R21: every language of the first batch must really highlight,
// verified per language against the rendered artifact rather than by asking whether a
// parser object exists. Samples are short on purpose; the assertions are that the
// text is shown verbatim and that the rendered tokens carry at least two distinct
// colour values from the theme.
const HIGHLIGHT_SAMPLES = [
  ['javascript', 'app.js', 'const answer = 42; // note\n'],
  ['typescript', 'app.ts', 'const answer: number = 42; // note\n'],
  ['json', 'data.json', '{"answer": 42, "ok": true}\n'],
  ['python', 'main.py', 'def f(x):\n    return x + 1  # note\n'],
  ['html', 'page.html', '<div class="x">hi</div>\n'],
  ['css', 'style.css', 'a { color: red; }\n'],
  ['markdown', 'doc.md', '# Title\n\n**bold** and *em* and `code`\n'],
  ['yaml', 'conf.yaml', 'answer: 42\n'],
  ['c', 'main.c', 'int main(void) { return 0; }\n'],
  ['cpp', 'main.cpp', 'int main() { return 0; }\n'],
  ['shellscript', 'run.sh', 'if [ -f "$x" ]; then echo "hi"; fi  # note\n'],
  ['javascript', 'app.jsx', 'const view = <div className="x">hi</div>;\n'],
  ['typescript', 'app.tsx', 'const view: JSX.Element = <div className="x">hi</div>;\n'],
];

for (const [hint, path, sample] of HIGHLIGHT_SAMPLES) {
  test(`the first batch really highlights ${hint} from ${path}`, async testContext => {
    const state = await openEditor(testContext, { mode: 'preview', canWrite: false, value: sample, path, languageHint: hint });
    const { container, handle, client } = state;
    const host = container.querySelector('[data-fm-code]');
    assert.ok(host, 'the editor must render its contract container');
    assert.equal(highlightState(container), 'active', `${path} must be highlighted, not degraded or plain`);
    assert.equal(host.getAttribute('data-fm-code-language'), client.codeLanguages.languageIdFor(hint),
      `${path} must report the language it was highlighted as`);
    assert.equal(visibleText(container), sample, `the ${hint} sample must be shown verbatim`);
    assert.equal(readEditorText(container), sample, `the ${hint} sample must survive the editor model unchanged`);
    const colours = tokenColors(handle, container);
    assert.ok(colours.size >= 2,
      `${hint} must produce at least two distinct token colours, got ${colours.size}: ${[...colours].join(', ')}`);
    // The dialect matters for the two JSX-bearing cases: a JavaScript grammar under a
    // .jsx path is not JSX highlighting, and the host reports .tsx as typescript.
    const expectedDialect = path.endsWith('.jsx') ? 'jsx' : path.endsWith('.tsx') ? 'tsx' : null;
    if (expectedDialect !== null) {
      assert.equal(client.codeLanguages.dialectFor(hint, path), expectedDialect,
        `${path} must resolve to the ${expectedDialect} dialect, not the plain ${hint} grammar`);
    }

    // Acceptance 12 covers the editing mode too, and switching mode must keep the
    // same colours rather than rebuild the editor into plain text.
    await act(async () => { await state.render({ mode: 'edit', canWrite: true }); });
    assert.equal(highlightState(container), 'active', `${path} must stay highlighted after switching to edit mode`);
    assert.equal(visibleText(container), sample, `editing ${path} must keep the sample verbatim`);
    const editColours = tokenColors(handle, container);
    assert.ok(editColours.size >= 2,
      `${path} must keep at least two distinct token colours in edit mode, got ${editColours.size}: ${[...editColours].join(', ')}`);
  });
}
