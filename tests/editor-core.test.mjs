import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { loadClientModule } from './client-module-loader.mjs';
import {
  act, assertNoDomErrors, dispatchEditor, editorHostOf, editorViewOf, flushDom, installDom,
  loadShippedClient, mountInto, readEditorText, setEditorText,
} from './editor-dom-harness.mjs';

/**
 * editor-core: the shipped bundle's `codeLanguages` / `editor` namespaces.
 *
 * The subject is always `dist/client.js`, read the way the browser module table
 * reads it — never `src/`. Run `npm run build` first.
 *
 * This file is deliberately split in two slices:
 *
 *  - **Slice 1 (here, DOM-free).** Everything that decides *what* the editor
 *    renders is a pure function: the highlight budget, the language and dialect
 *    selection, and the token-to-CSS-variable mapping. Keeping it DOM-free is
 *    not a convenience — it is the only way to pin the ~1 MiB UTF-8 boundary
 *    and the 20 000 UTF-16-unit line boundary exactly, and to assert the mapped
 *    colours without a browser.
 *
 *  - **Slice 2 (same file, real DOM).** The component contract: mounting the
 *    real CodeMirror view, external-value synchronisation, document isolation,
 *    reconfiguration instead of remounting, the read-only matrix, the save
 *    shortcut and destruction. CodeMirror can only be mounted on a real
 *    Element, so this slice runs on jsdom + react-dom through
 *    `tests/editor-dom-harness.mjs` (owned by contracts-qa) rather than
 *    reimplementing a renderer here. The four-state markers, the reason-note
 *    copy and the token colours have their own acceptance suite; they are not
 *    duplicated here.
 *
 * Cross-copy caution that shapes the assertions below: esbuild inlines its own
 * copy of CodeMirror into `dist/client.js`, so a Tag instance from this test's
 * `node_modules` is never identical to the bundle's. Tag *families* are
 * therefore compared by their stable printed name (`String(tag)`, e.g.
 * `keyword`, `function(variableName)`), and style objects are never compared by
 * identity across the boundary.
 */

const MIB = 1048576;
const codeLanguages = () => loadClientModule('codeLanguages');
const editor = () => loadClientModule('editor');

/**
 * The frozen hint ids this generation ships. The host maps `.sh`/`.bash`/`.zsh`
 * to `shellscript`, `.c`/`.h` to `c`, and `.cc`/`.cpp`/`.cxx`/`.hh`/`.hpp`/`.hxx`
 * to `cpp`, so C must be supported even though the C++ grammar renders it.
 */
const SUPPORTED_HINTS = Object.freeze([
  'javascript', 'typescript', 'json', 'python', 'html', 'css', 'markdown', 'yaml', 'c', 'cpp', 'shellscript',
]);

/**
 * The token families a code reader must be able to tell apart. Families, not
 * individual tags: a tag set (`tags.function(tags.variableName)`) counts when
 * any member matches.
 * @param spec - One entry of `HighlightStyle.specs`.
 * @returns The printed names of the tags this entry styles.
 */
function tagNames(spec) {
  const tags = Array.isArray(spec.tag) ? spec.tag : [spec.tag];
  return tags.map(tag => String(tag));
}

/** Every colour a style spec may use, and nothing else: host tokens, never a resolved colour. */
const HOST_TOKEN_COLOUR = /^var\(--(shiki|dsw)-[a-z0-9-]+\)$/;
const LITERAL_COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

test('the shipped bundle exposes the editor and codeLanguages namespaces', async () => {
  const core = await editor();
  const languages = await codeLanguages();

  assert.equal(typeof core.CodeEditor, 'function', 'the bundle must export the CodeEditor component');
  assert.equal(core.HIGHLIGHT_MAX_BYTES, MIB, 'the editor namespace must re-export the byte budget');
  assert.equal(core.HIGHLIGHT_MAX_LINE_UNITS, 20000, 'the editor namespace must re-export the line budget');
  assert.equal(typeof core.classifyHighlightBudget, 'function');

  assert.equal(languages.HIGHLIGHT_MAX_BYTES, MIB);
  assert.equal(languages.HIGHLIGHT_MAX_LINE_UNITS, 20000);
  for (const name of ['classifyHighlightBudget', 'languageIdFor', 'dialectFor', 'languageExtensionFor', 'createHighlightExtension']) {
    assert.equal(typeof languages[name], 'function', `codeLanguages.${name} must be exported for the DOM slice and for QA`);
  }
  assert.ok(languages.highlightStyle, 'the HighlightStyle instance must be exported so its mapping is assertable');
});

/**
 * Builds an ASCII document of exactly `targetBytes` UTF-8 bytes with no long line.
 *
 * The byte budget cannot be probed with one huge line: the line budget fires
 * first, because a 1 MiB single line is 1 048 576 UTF-16 units — far past the
 * 20 000 limit. A fixture like `'a'.repeat(MIB)` is therefore `limited` for the
 * *line* reason, which would let a wrong byte implementation pass. Every line
 * below stays within the line budget, so only the byte budget can decide.
 *
 * @param targetBytes - Exact UTF-8 length the generated document must have.
 * @returns A multi-line document whose longest line is exactly 20 000 units.
 */
function asciiDocumentOfBytes(targetBytes) {
  const line = `${'a'.repeat(20000)}\n`; // 20 001 bytes, at the line limit
  const full = Math.floor(targetBytes / line.length);
  const remainder = targetBytes - full * line.length;
  let document = line.repeat(full);
  if (remainder > 0) document += `${'a'.repeat(remainder - 1)}\n`;
  assert.equal(Buffer.byteLength(document, 'utf8'), targetBytes, 'the fixture must hit the byte target exactly');
  assert.ok(longestLineUnits(document) <= 20000, 'the fixture must not trip the line budget');
  return document;
}

/** The longest line, in the UTF-16 units the line budget is defined in. */
function longestLineUnits(text) {
  let longest = 0;
  for (const line of text.split('\n')) longest = Math.max(longest, line.length);
  return longest;
}

/**
 * `count` lines, each `repetitions` copies of `unit`, joined by newlines.
 *
 * The caller passes repetitions so that `repetitions * unit.length` stays at or
 * under the line limit: a multi-byte unit consumes several UTF-16 units per copy.
 */
function linesOf(unit, count, repetitions) {
  const document = Array.from({ length: count }, () => unit.repeat(repetitions)).join('\n');
  assert.ok(longestLineUnits(document) <= 20000, 'generated lines must stay within the line budget');
  return document;
}

test('exactly 1 MiB of UTF-8 still highlights and one byte more does not', async () => {
  const { classifyHighlightBudget, HIGHLIGHT_MAX_BYTES } = await codeLanguages();

  assert.equal(HIGHLIGHT_MAX_BYTES, MIB);
  assert.equal(classifyHighlightBudget(asciiDocumentOfBytes(MIB)), 'active', 'a document exactly at the byte limit is still highlighted');
  assert.equal(classifyHighlightBudget(asciiDocumentOfBytes(MIB + 1)), 'limited', 'the limit is inclusive, so one byte over must stop highlighting');
  assert.equal(classifyHighlightBudget(''), 'active');
  assert.equal(classifyHighlightBudget('const greeting = "你好";'), 'active');
});

test('the byte budget measures UTF-8 bytes, not UTF-16 units', async () => {
  const { classifyHighlightBudget } = await codeLanguages();

  // 中 is 3 UTF-8 bytes but 1 UTF-16 unit. Twenty lines of 20 000 units are a
  // legal document by the line budget, so only the byte budget can decide this.
  const cjk = linesOf('中', 20, 20000);
  assert.equal(cjk.length, 400019, 'fixture: 400 000 units plus 19 newlines, well under 1 MiB of UTF-16 units');
  assert.equal(Buffer.byteLength(cjk, 'utf8'), 1200019, 'fixture: 1.2 MB of UTF-8');
  assert.equal(classifyHighlightBudget(cjk), 'limited', 'a length-based implementation would wrongly keep highlighting here');

  const cjkUnder = linesOf('中', 17, 20000);
  assert.equal(Buffer.byteLength(cjkUnder, 'utf8'), 1020016, 'fixture: 1 020 016 bytes, under the limit');
  assert.equal(classifyHighlightBudget(cjkUnder), 'active', 'multi-byte text under the byte limit keeps highlighting');

  // Astral characters are 4 UTF-8 bytes and 2 UTF-16 units, so 10 000 copies per
  // line is exactly the 20 000-unit line limit.
  const astral = linesOf('😀', 27, 10000);
  assert.ok(astral.length < MIB, 'fixture: the UTF-16 length is under 1 MiB, so only a byte measurement can reject it');
  assert.ok(Buffer.byteLength(astral, 'utf8') > MIB, 'fixture: the UTF-8 length is over 1 MiB');
  assert.equal(classifyHighlightBudget(astral), 'limited', 'surrogate pairs must count as their encoded size');
});

test('exactly 20000 UTF-16 units on one line still highlights and 20001 does not', async () => {
  const { classifyHighlightBudget, HIGHLIGHT_MAX_LINE_UNITS } = await codeLanguages();

  assert.equal(HIGHLIGHT_MAX_LINE_UNITS, 20000);
  assert.equal(classifyHighlightBudget('a'.repeat(20000)), 'active');
  assert.equal(classifyHighlightBudget('a'.repeat(20001)), 'limited');
});

test('the line budget is per line and does not count the newline itself', async () => {
  const { classifyHighlightBudget } = await codeLanguages();
  const longestLegal = 'a'.repeat(20000);

  assert.equal(
    classifyHighlightBudget(`${longestLegal}\n${longestLegal}`),
    'active',
    'two legal lines are not one illegal line',
  );
  assert.equal(classifyHighlightBudget(`${longestLegal}\n`), 'active', 'a trailing newline cannot create a phantom line');
  assert.equal(classifyHighlightBudget(`short\n${'b'.repeat(20001)}`), 'limited', 'a long line after a short one is still caught');
  assert.equal(classifyHighlightBudget(`${'b'.repeat(20001)}\nshort`), 'limited', 'a long first line is caught');
  assert.equal(
    classifyHighlightBudget(`short\n${'c'.repeat(19999)}`),
    'active',
    'a line just under the limit keeps highlighting',
  );
});

test('the language id keeps supported hints and falls back to plaintext', async () => {
  const { languageIdFor } = await codeLanguages();

  for (const hint of SUPPORTED_HINTS) {
    assert.equal(languageIdFor(hint), hint, `${hint} is shipped this generation and keeps its frozen id`);
  }
  assert.equal(languageIdFor(undefined), 'plaintext', 'an absent hint is plain text, not an error');
  assert.equal(languageIdFor(''), 'plaintext');
  for (const hint of ['ruby', 'go', 'rust', 'java', 'csharp', 'php', 'toml', 'ini', 'mdx', 'scss', 'less', 'sql', 'xml', 'lua', 'txt']) {
    assert.equal(languageIdFor(hint), 'plaintext', `${hint} is not shipped this generation and must degrade to plaintext`);
  }
});

test('the hint selects the language and only the path refines JS and TS', async () => {
  const { dialectFor } = await codeLanguages();

  assert.equal(dialectFor('javascript', 'src/a.js'), 'js');
  assert.equal(dialectFor('javascript', 'src/a.jsx'), 'jsx');
  assert.equal(dialectFor('javascript', 'src/a.mjs'), 'js');
  assert.equal(dialectFor('typescript', 'src/a.ts'), 'ts');
  assert.equal(dialectFor('typescript', 'src/a.tsx'), 'tsx');
  assert.equal(dialectFor('typescript', 'src/a.mts'), 'ts');
  assert.equal(dialectFor('typescript', 'src/a.cts'), 'ts');

  // The path must never invent a grammar the hint did not name.
  assert.equal(dialectFor(undefined, 'src/a.tsx'), null, 'an absent hint stays plain even for a .tsx path');
  assert.equal(dialectFor(undefined, 'src/a.ts'), null);
  assert.equal(dialectFor('ruby', 'src/a.rb'), null, 'an unshipped hint stays plain even for a known extension');

  // Every other shipped language ignores the path.
  assert.equal(dialectFor('json', 'a.tsx'), 'json', 'a non-JS language is not affected by a JS extension');
  assert.equal(dialectFor('python', 'a.py'), 'python');
  assert.equal(dialectFor('html', 'a.html'), 'html');
  assert.equal(dialectFor('css', 'a.css'), 'css');
  assert.equal(dialectFor('markdown', 'a.md'), 'markdown');
  assert.equal(dialectFor('yaml', 'a.yml'), 'yaml');
  assert.equal(dialectFor('cpp', 'a.hpp'), 'cpp');
  // C is a shipped hint rendered by the C++ grammar, so it must resolve even
  // though there is no separate `c` dialect id.
  assert.equal(dialectFor('c', 'src/a.c'), 'cpp');
  assert.equal(dialectFor('c', 'src/a.h'), 'cpp');
  assert.equal(dialectFor('shellscript', 'a.sh'), 'shell');
});

test('a supported hint yields one memoised language extension per dialect', async () => {
  const { languageExtensionFor } = await codeLanguages();

  const support = languageExtensionFor('typescript', 'src/a.tsx');
  assert.ok(support, 'a shipped hint must produce a language extension');
  assert.ok(support.language, 'the extension must expose its Language so a caller can inspect it');
  assert.ok(support.language.parser, 'the Language must expose its parser, so a parser-level failure stays observable');

  assert.equal(
    languageExtensionFor('typescript', 'src/a.tsx'),
    languageExtensionFor('typescript', 'src/other.tsx'),
    'one syntax support per dialect must be reused instead of rebuilt on every mount',
  );
  assert.notEqual(
    languageExtensionFor('typescript', 'src/a.ts'),
    languageExtensionFor('typescript', 'src/a.tsx'),
    'ts and tsx are different grammars',
  );
  assert.equal(
    languageExtensionFor('c', 'src/a.c'),
    languageExtensionFor('cpp', 'src/a.cc'),
    'C reuses the C++ grammar, so the two hints share one syntax support',
  );

  assert.equal(languageExtensionFor(undefined, 'src/a.tsx'), null);
  assert.equal(languageExtensionFor('ruby', 'src/a.rb'), null);
  for (const hint of SUPPORTED_HINTS) {
    assert.ok(languageExtensionFor(hint, `a.${hint}`), `${hint} must produce an extension`);
  }
});

test('the language layer attaches no input-modifying support', async () => {
  // The language factories ship behaviour that changes what the user types, not
  // only what is coloured: `javascript({jsx: true})` bundles `autoCloseTags`
  // (lang-javascript 386/411 — an `EditorView.inputHandler`), `html()` bundles it
  // unless explicitly disabled, and `markdown()` bundles `markdownKeymap` plus
  // newline continuation. This editor only colours tokens, so the language layer
  // wraps the bare `*Language` objects, which leaves the support list empty.
  //
  // The behaviour itself cannot be asserted here: jsdom cannot type into
  // CodeMirror at all, so "typing `<` does not insert a closing tag" is browser
  // acceptance. What is asserted is the extension set that would carry it —
  // which is what a bundled auto-close would have to ride in.
  const { languageExtensionFor } = await codeLanguages();

  const cases = [
    ['javascript', 'a.js'], ['javascript', 'a.jsx'], ['typescript', 'a.ts'], ['typescript', 'a.tsx'],
    ['json', 'a.json'], ['python', 'a.py'], ['html', 'a.html'], ['css', 'a.css'],
    ['markdown', 'a.md'], ['yaml', 'a.yml'], ['c', 'a.c'], ['cpp', 'a.cc'], ['shellscript', 'a.sh'],
  ];
  for (const [hint, path] of cases) {
    const support = languageExtensionFor(hint, path);
    assert.ok(support, `${hint} must still produce a language extension`);
    assert.deepEqual(support.support, [], `${hint}/${path} must not bundle auto-close, keymap or continuation behaviour`);
    assert.equal(support.extension.length, 2, `${hint}/${path} must extend the state with the language and nothing else`);
    assert.deepEqual(support.extension[1], [], `${hint}/${path} must not attach supporting extensions`);
  }
});

test('the dialect decision and the extension decision cannot drift apart', async () => {
  const { dialectFor, languageExtensionFor } = await codeLanguages();
  const cases = [
    ['typescript', 'a.ts'], ['typescript', 'a.tsx'], ['javascript', 'a.js'], ['javascript', 'a.jsx'],
    [undefined, 'a.tsx'], ['ruby', 'a.rb'], ['json', 'a.json'], ['shellscript', 'a.sh'], ['cpp', 'a.cc'],
  ];
  for (const [hint, path] of cases) {
    const dialect = dialectFor(hint, path);
    const extension = languageExtensionFor(hint, path);
    assert.equal(
      dialect === null,
      extension === null,
      `${String(hint)} / ${path}: the dialect and the extension must agree about whether a grammar applies`,
    );
  }
});

test('the highlight state follows the frozen priority order', async () => {
  const { highlightStateFor, HIGHLIGHT_MAX_BYTES } = await codeLanguages();
  const huge = asciiDocumentOfBytes(HIGHLIGHT_MAX_BYTES + 1);

  assert.equal(
    highlightStateFor({ languageHint: 'typescript', path: 'a.ts', value: 'const x = 1;' }),
    'active',
  );
  assert.equal(
    highlightStateFor({ languageHint: 'typescript', path: 'a.ts', value: huge }),
    'limited',
    'a shipped language over the budget is limited, not plain',
  );
  assert.equal(
    highlightStateFor({ languageHint: undefined, path: 'a.txt', value: 'plain' }),
    'plain',
  );
  assert.equal(
    highlightStateFor({ languageHint: undefined, path: 'a.txt', value: huge }),
    'plain',
    'an unknown hint is plain even when the document is also over budget: plain outranks limited',
  );
  assert.equal(
    highlightStateFor({ languageHint: undefined, path: 'a.txt', value: huge, failed: true }),
    'error',
    'a failure outranks every other state',
  );
  assert.equal(
    highlightStateFor({ languageHint: 'typescript', path: 'a.ts', value: 'x', failed: true }),
    'error',
  );
});

test('the highlight style consumes host tokens and emits no literal colour', async () => {
  const { highlightStyle } = await codeLanguages();

  assert.ok(Array.isArray(highlightStyle.specs), 'the exported style must expose its specs');
  const colours = highlightStyle.specs.map(spec => String(spec.color));
  assert.ok(colours.length >= 8, 'the style must cover token families rather than one class');

  for (const colour of colours) {
    assert.match(colour, HOST_TOKEN_COLOUR, `${colour} must reference a host token instead of a resolved colour`);
  }

  // The generated CSS is the only artefact the browser actually applies, so the
  // variable has to survive into it.
  const rules = typeof highlightStyle.module?.getRules === 'function' ? highlightStyle.module.getRules() : '';
  assert.ok(rules.length > 0, 'the style must generate CSS rules');
  assert.match(rules, /color:\s*var\(--(shiki|dsw)-[a-z0-9-]+\)/, 'the generated CSS must carry a host variable');
  assert.equal(LITERAL_COLOUR.test(rules), false, 'our own rules must contain no literal colour');
});

test('the highlight style covers the token families a code reader distinguishes', async () => {
  const { highlightStyle } = await codeLanguages();
  const styled = new Set(highlightStyle.specs.flatMap(tagNames));

  for (const family of [
    'keyword', 'string', 'comment', 'number', 'function(variableName)', 'typeName', 'propertyName', 'operator', 'punctuation', 'invalid',
  ]) {
    assert.ok(styled.has(family), `the style must define a colour for ${family}`);
  }

  const distinct = new Set(highlightStyle.specs.map(spec => String(spec.color)));
  assert.ok(
    distinct.size >= 5,
    `token families must stay visually distinguishable, but only ${distinct.size} distinct colour(s) are mapped`,
  );
});

// ---------------------------------------------------------------------------
// Slice 2: the component contract in a real DOM
// ---------------------------------------------------------------------------

/** The frozen prop surface, with a value the tests override per case. */
const BASE_PROPS = Object.freeze({
  documentId: 'doc-1',
  path: 'src/a.ts',
  value: '',
  mode: 'edit',
  canWrite: true,
  languageHint: 'typescript',
  ariaLabel: 'Text editor: src/a.ts',
});

/**
 * The shipped `CodeEditor` component, or an actionable failure.
 *
 * Reaching into `client.editor.CodeEditor` directly would throw a bare
 * `TypeError` while the namespace does not exist yet, which hides the real
 * reason behind a property read. This asserts the export boundary instead, so a
 * missing namespace reports the same thing the loader reports.
 *
 * @param client - The exports returned by the shipped bundle.
 * @returns The component to render.
 */
function editorComponentOf(client) {
  const component = client?.editor?.CodeEditor;
  assert.equal(typeof component, 'function', 'dist/client.js must export the editor namespace with a CodeEditor component');
  return component;
}

/**
 * One jsdom for a whole test, however many editors that test needs.
 *
 * Installing a second jsdom inside one test is what broke this suite: each
 * install saves whatever globals were in force at the time, so restoring them in
 * registration order re-installs the first, already-closed window, leaves
 * `globalThis.window` undefined during teardown, and hands React's global act
 * environment a dead document — after which every later test fails with
 * `Should not already be working` for reasons unrelated to the component.
 *
 * A test therefore installs the DOM once and mounts as many editors into it as
 * it needs, and teardown unmounts every editor before restoring that one handle.
 *
 * @param t - The test context that owns the teardown.
 * @returns The handle, the shipped bundle and a `mount` that adds one editor.
 */
async function editorScene(t) {
  const handle = installDom();
  const editors = [];
  t.after(async () => {
    for (const editor of [...editors].reverse()) await editor.unmount();
    handle.restore();
  });
  const client = await loadShippedClient(handle.window);
  const CodeEditor = editorComponentOf(client);
  return {
    handle,
    client,
    async mount(overrides = {}) {
      const container = handle.document.createElement('div');
      handle.body.appendChild(container);
      const changes = [];
      const saves = [];
      const rendered = [];
      let mounted = null;
      const view = {
        handle,
        container,
        changes,
        saves,
        rendered,
        props: {
          ...BASE_PROPS,
          t: (key, values) => { rendered.push({ key, values }); return key; },
          onChange: text => { changes.push(text); },
          onSave: () => { saves.push(true); },
          ...overrides,
        },
        element() { return React.createElement(CodeEditor, view.props); },
        /** Re-renders with merged props, the way the panel would after a state change. */
        async render(next) { view.props = { ...view.props, ...next }; await mounted.render(view.element()); },
        host() { return editorHostOf(container); },
        async unmount() {
          if (mounted) { const current = mounted; mounted = null; await current.unmount(); }
        },
      };
      mounted = await mountInto(container, view.element());
      editors.push(view);
      return view;
    },
  };
}

/** One editor in its own fresh jsdom: the common case. */
async function mountEditor(t, overrides = {}) {
  const scene = await editorScene(t);
  return scene.mount(overrides);
}

/** Sends Ctrl+S at one rendered content node, the way the keyboard would. */
async function pressSave(view, content) {
  const event = new view.handle.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
  await act(async () => { content.dispatchEvent(event); });
  return event;
}

/**
 * Breaks the parser behind a grammar, and returns the restore.
 *
 * Patching the memoised support's own parser is how a parse failure is injected:
 * the component parses through that same instance, and restoring it mid-test is
 * what makes "the cause is gone" observable.
 *
 * @param parser - The live parser of the grammar under test.
 * @param t - The test context, restored again at teardown for safety.
 * @returns A function that restores the parser immediately.
 */
function breakParser(parser, t) {
  const original = parser.startParse;
  parser.startParse = () => { throw new Error('parser exploded'); };
  const restore = () => { parser.startParse = original; };
  t.after(restore);
  return restore;
}

/** The control the user is left with after a degradation. */
function fallbackOf(host) {
  return host.querySelector('[data-fm-code-fallback="edit"]');
}

/**
 * Types into the degraded fallback the way a user would.
 *
 * React's value tracker ignores a plain `value` assignment followed by an `input`
 * event, so the prototype setter is used to make the event look real.
 *
 * @param view - The mounted editor handle, for its window.
 * @param textarea - The fallback element to type into.
 * @param text - The draft being typed.
 */
async function typeInFallback(view, textarea, text) {
  const { window } = view.handle;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  await act(async () => {
    setter.call(textarea, text);
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

test('a container React never attaches leaves the component unmounted instead of failing', async () => {
  // react-test-renderer supplies no host node, so the ref is null: that is "not
  // mounted yet", not an initialisation failure. Treating it as one would make
  // every renderer-based suite silently assert a fallback control instead of the
  // editor.
  const client = await loadShippedClient({});
  const CodeEditor = editorComponentOf(client);
  let tree = null;
  await act(async () => {
    tree = TestRenderer.create(React.createElement(CodeEditor, {
      ...BASE_PROPS, value: 'const x = 1;', t: key => key, onChange: () => {}, onSave: () => {},
    }));
  });
  try {
    const hosts = tree.root.findAll(node => typeof node.type === 'string' && node.props['data-fm-code'] !== undefined);
    assert.equal(hosts.length, 1, 'the component must still render its host element');
    assert.equal(hosts[0].props['data-fm-code-highlight'], 'active', 'an unattached container is not a degradation');
    assert.equal(hosts[0].props['data-fm-code-language'], 'typescript');
    assert.equal(
      tree.root.findAll(node => node.props['data-fm-code-fallback'] !== undefined).length,
      0,
      'no fallback control may be rendered when the container was merely not attached',
    );
    assert.equal(tree.root.findAll(node => node.type === 'textarea').length, 0, 'the React boundary must not expose a hidden textarea');
  } finally {
    await act(async () => { tree.unmount(); });
  }
});

test('the component mounts a real CodeMirror view carrying the draft and the accessible name', async t => {
  const view = await mountEditor(t, { value: 'const greeting = "你好";' });
  const host = view.host();

  assert.equal(host.getAttribute('data-fm-code-mode'), 'edit');
  assert.equal(host.getAttribute('data-fm-code-language'), 'typescript');
  assert.equal(host.getAttribute('data-fm-code-highlight'), 'active');
  assert.equal(host.hasAttribute('data-fm-code-note'), false, 'the host must not mirror the reason note');

  const editorView = editorViewOf(host);
  assert.equal(editorView.state.doc.toString(), 'const greeting = "你好";', 'the mounted view must hold the passed draft');
  assert.equal(
    host.querySelector('.cm-content').getAttribute('aria-label'),
    'Text editor: src/a.ts',
    'the accessible name must reach the editable surface, not only the wrapper',
  );
  assertNoDomErrors(view.handle);
});

test('the rendered editor mirrors the frozen editable and read-only matrix', async t => {
  // One jsdom, three editors: the matrix is three configurations of the same
  // environment, and installing three windows is what poisoned act before.
  const scene = await editorScene(t);

  // Both a preview and a Host that grants no write access are non-editable:
  // the surface is still selectable and announced as read-only, but it cannot be
  // typed into, so it must not advertise itself as editable.
  const preview = await scene.mount({ mode: 'preview', value: 'read only' });
  const previewContent = preview.host().querySelector('.cm-content');
  assert.equal(previewContent.getAttribute('contenteditable'), 'false', 'a preview is not editable');
  assert.equal(previewContent.getAttribute('aria-readonly'), 'true', 'a preview must announce that it is read-only');
  assert.equal(readEditorText(preview.host()), 'read only');

  const writable = await scene.mount({ mode: 'edit', canWrite: true });
  const writableContent = writable.host().querySelector('.cm-content');
  assert.equal(writableContent.getAttribute('contenteditable'), 'true');
  assert.notEqual(writableContent.getAttribute('aria-readonly'), 'true', 'a writable editor must not claim to be read-only');

  const readOnly = await scene.mount({ mode: 'edit', canWrite: false });
  const readOnlyContent = readOnly.host().querySelector('.cm-content');
  assert.equal(readOnlyContent.getAttribute('contenteditable'), 'false', 'a Host without the write capability cannot expose an editable surface');
  assert.equal(readOnlyContent.getAttribute('aria-readonly'), 'true');
});

test('an external draft change reaches the view without echoing onChange', async t => {
  const view = await mountEditor(t, { value: 'first' });
  assert.equal(readEditorText(view.host()), 'first');

  await view.render({ value: 'second\nline' });
  assert.equal(readEditorText(view.host()), 'second\nline', 'the prop stays authoritative for a programmatic change');
  assert.deepEqual(view.changes, [], 'a programmatic synchronisation must not report an edit');
  assertNoDomErrors(view.handle);
});

test('an edit made in the view reports the exact draft once and never loops', async t => {
  const view = await mountEditor(t, { value: 'base' });

  await setEditorText(view.host(), '你好\n世界');
  assert.deepEqual(view.changes, ['你好\n世界'], 'the reported draft is the edited text, verbatim');
  assert.equal(readEditorText(view.host()), '你好\n世界');
  assert.equal(view.changes.length, 1, 'the render caused by onChange must not dispatch a second transaction');
  assertNoDomErrors(view.handle);
});

test('re-supplying the identical draft neither rebuilds the view nor loses the selection', async t => {
  const view = await mountEditor(t, { value: 'keep me' });
  const before = editorViewOf(view.host());
  await dispatchEditor(view.host(), { selection: { anchor: 3 } });

  await view.render({ value: 'keep me' });
  assert.equal(editorViewOf(view.host()), before, 'the same document must keep its view instance');
  assert.equal(editorViewOf(view.host()).state.selection.main.anchor, 3, 'a repeated value must not reset the caret');
  assert.deepEqual(view.changes, [], 'a repeated value is not an edit');
});

test('switching mode reconfigures the live view instead of remounting it', async t => {
  const view = await mountEditor(t, { value: 'unchanged', mode: 'edit' });
  const before = editorViewOf(view.host());

  await view.render({ mode: 'preview' });
  assert.equal(editorViewOf(view.host()), before, 'mode is a configuration change, not a new editor');
  assert.equal(view.host().querySelector('.cm-content').getAttribute('contenteditable'), 'false');
  assert.equal(readEditorText(view.host()), 'unchanged');

  await view.render({ mode: 'edit' });
  assert.equal(editorViewOf(view.host()), before);
  assert.equal(view.host().querySelector('.cm-content').getAttribute('contenteditable'), 'true');
  assert.equal(readEditorText(view.host()), 'unchanged');
  assert.deepEqual(view.changes, [], 'reconfiguring is not an edit');
});

test('a language change reconfigures without remounting and without reporting an edit', async t => {
  const view = await mountEditor(t, { value: 'const x = 1;', languageHint: 'typescript', path: 'a.ts' });
  const before = editorViewOf(view.host());

  await view.render({ languageHint: 'javascript', path: 'a.js' });
  assert.equal(editorViewOf(view.host()), before);
  assert.equal(readEditorText(view.host()), 'const x = 1;');
  assert.equal(view.host().getAttribute('data-fm-code-language'), 'javascript');
  assert.equal(view.host().getAttribute('data-fm-code-highlight'), 'active');

  await view.render({ languageHint: undefined, path: 'a.txt' });
  assert.equal(editorViewOf(view.host()), before, 'losing the grammar must not rebuild the editor');
  assert.equal(view.host().getAttribute('data-fm-code-language'), 'plaintext');
  assert.equal(view.host().getAttribute('data-fm-code-highlight'), 'plain');
  assert.equal(readEditorText(view.host()), 'const x = 1;');
  assert.deepEqual(view.changes, []);
});

test('two open documents keep independent views, text and callbacks', async t => {
  const handle = installDom();
  const container = handle.document.createElement('div');
  handle.body.appendChild(container);
  let mounted = null;
  t.after(async () => { await mounted?.unmount(); handle.restore(); });

  const client = await loadShippedClient(handle.window);
  const CodeEditor = editorComponentOf(client);
  const left = [];
  const right = [];
  const props = documentId => ({
    ...BASE_PROPS, documentId, value: documentId === 'left' ? 'LEFT' : 'RIGHT', t: key => key,
    onChange: text => (documentId === 'left' ? left : right).push(text), onSave: () => {},
  });
  mounted = await mountInto(container, React.createElement(React.Fragment, null,
    React.createElement(CodeEditor, props('left')),
    React.createElement(CodeEditor, props('right')),
  ));

  const hosts = container.querySelectorAll('[data-fm-code]');
  assert.equal(hosts.length, 2, 'both documents must render their own host');
  assert.notEqual(editorViewOf(hosts[0]), editorViewOf(hosts[1]), 'each document owns its own view');

  await setEditorText(hosts[0], 'left edited');
  assert.deepEqual(left, ['left edited']);
  assert.deepEqual(right, [], 'the other document must not report the edit');
  assert.equal(readEditorText(hosts[0]), 'left edited');
  assert.equal(readEditorText(hosts[1]), 'RIGHT', 'the untouched document keeps its text');
  assertNoDomErrors(handle);
});

test('unmounting destroys the view and leaves no editor DOM behind', async t => {
  const view = await mountEditor(t, { value: 'dispose me' });
  assert.ok(view.host().querySelector('.cm-content'), 'precondition: the editor is mounted');

  await view.unmount();
  assert.equal(view.container.querySelector('.cm-content'), null, 'the destroyed view must take its DOM with it');
  assert.equal(view.container.querySelector('[data-fm-code]'), null, 'the host must be released with the component');
  await flushDom(60);
  assert.deepEqual(view.changes, [], 'a destroyed view must not report anything');
  assertNoDomErrors(view.handle);
});

/**
 * The class names the shipped highlight style generates, read from its own CSS.
 *
 * Counting `span` elements is not a discriminative test: a document that is
 * parsed can still render without spans when a whole line is one token or the
 * tree is error-only, so "no spans" would pass even with the grammar still
 * applied. Asking whether any rendered node carries one of *our* classes is the
 * question the requirement actually asks.
 *
 * @param highlightStyle - The exported `HighlightStyle` instance.
 * @returns The generated class names.
 */
function highlightClasses(highlightStyle) {
  const rules = typeof highlightStyle.module?.getRules === 'function' ? highlightStyle.module.getRules() : '';
  return new Set([...rules.matchAll(/\.([^\s{,]+)\s*\{/g)].map(match => match[1]));
}

/** Whether anything rendered inside the editor carries one of those classes. */
function hasTokenStyling(host, classes) {
  return [...host.querySelectorAll('.cm-content *')].some(node =>
    String(node.className).split(/\s+/).some(name => classes.has(name)));
}

/** One line just over the line budget that is still full of highlightable tokens. */
function longLineDocument() {
  const line = 'const x = 1; '.repeat(1600).trimEnd();
  assert.ok(line.length > 20000, 'fixture: the single line must exceed the 20 000-unit budget');
  assert.ok(line.length < 40000, 'fixture: the line must stay small enough to parse quickly');
  assert.equal(line.includes('\n'), false, 'fixture: the document must be one line');
  return line;
}

/**
 * Watches token styling for a bounded time and reports whether it was seen.
 *
 * CodeMirror parses asynchronously and in time-sliced chunks, so at any single
 * moment "not parsed yet" and "no grammar" look identical. Presence is therefore
 * asserted with a short budget, and absence only with a budget far beyond the
 * measured parse time — measured in this environment: a short line is styled
 * within 50 ms, while one line just over the 20 000-unit budget takes about
 * 1.1 s before its 769 token spans appear. Returning early on a single absent
 * reading would pass on an implementation that still highlights.
 *
 * @param host - The editor host element.
 * @param classes - The highlight classes to look for.
 * @param options - Poll budget; defaults suit the fast, positive checks.
 * @returns Whether styling was observed inside the budget.
 */
async function tokenStylingSeen(host, classes, { attempts = 60, intervalMs = 20 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (hasTokenStyling(host, classes)) return true;
    await flushDom(intervalMs);
  }
  return false;
}

/**
 * The poll budget for asserting that an over-budget line carries no styling.
 *
 * Four seconds is deliberately far past the ~1.1 s a still-applied grammar needs
 * to style such a line here, so a grammar that was never withdrawn cannot sneak
 * past this check on a slower machine.
 */
const ABSENCE_POLL = { attempts: 80, intervalMs: 50 };

test('crossing the highlight budget withdraws the grammar without replacing the view', async t => {
  // Slice 2 must take every module from the *same* bundle evaluation as the
  // mounted component. `loadClientModule` re-evaluates dist/client.js on every
  // call, so a second copy generates its own highlight class names (style-mod's
  // counter starts over) and `HighlightStyle` identity silently refers to
  // another instance — the scene's client is the copy the component was built
  // from.
  const scene = await editorScene(t);
  const { highlightStyle } = scene.client.codeLanguages;
  const classes = highlightClasses(highlightStyle);
  assert.ok(classes.size > 0, 'precondition: the shipped style generates classes');

  const view = await scene.mount({ value: 'const greeting = "你好";' });
  const before = editorViewOf(view.host());
  assert.equal(
    await tokenStylingSeen(view.host(), classes),
    true,
    'precondition: a parsed line carries a token class, so the measurement itself works',
  );

  // One line over the line budget: a configuration change, not a new editor.
  const overBudget = longLineDocument();
  await view.render({ value: overBudget });
  assert.equal(editorViewOf(view.host()), before, 'the same view must survive the budget crossing');
  assert.equal(view.host().getAttribute('data-fm-code-highlight'), 'limited');
  assert.equal(
    await tokenStylingSeen(view.host(), classes, ABSENCE_POLL),
    false,
    'the grammar must actually be withdrawn, not merely reported as limited',
  );
  assert.equal(readEditorText(view.host()), overBudget, 'the text stays complete');
  assert.deepEqual(view.changes, [], 'a budget change is not an edit');

  // And back: the grammar returns without a new editor either. This third phase
  // is what makes the middle assertion meaningful: styling that simply never
  // appeared would fail here.
  await view.render({ value: 'const greeting = "你好";' });
  assert.equal(editorViewOf(view.host()), before);
  assert.equal(view.host().getAttribute('data-fm-code-highlight'), 'active');
  assert.equal(
    await tokenStylingSeen(view.host(), classes),
    true,
    'the grammar must come back',
  );
});

test('a transaction that fails while parsing keeps the committed draft', async t => {
  const scene = await editorScene(t);
  const view = await scene.mount({ value: 'first' });
  await setEditorText(view.host(), 'committed');
  assert.deepEqual(view.changes, ['committed'], 'precondition: one real edit was reported');

  // Break the parser behind the memoised grammar the component parses with, then
  // attempt a real transaction. Nothing is committed by a failed dispatch, so the
  // text that must survive is the last committed draft — not the prop, which may
  // already be stale because React has not rendered the owner's update yet.
  // The parser comes from the scene's copy: patching the copy `codeLanguages()`
  // re-evaluates would leave the mounted component untouched.
  const { languageExtensionFor } = scene.client.codeLanguages;
  const parser = languageExtensionFor('typescript', 'src/a.ts').language.parser;
  const original = parser.startParse;
  parser.startParse = () => { throw new Error('parser exploded'); };
  t.after(() => { parser.startParse = original; });

  await dispatchEditor(view.host(), { changes: { from: 0, to: 0, insert: 'lost' } });

  assert.equal(view.host().getAttribute('data-fm-code-highlight'), 'error', 'a crashed parse must degrade the editor');
  const fallback = view.host().querySelector('[data-fm-code-fallback="edit"]');
  assert.ok(fallback, 'the readable fallback must take over');
  assert.equal(fallback.value, 'committed', 'the last committed draft is preserved');
  assert.equal(fallback.value.includes('lost'), false, 'the transaction that never committed must not appear as saved text');
  assert.equal(view.changes.at(-1), 'committed', 'the owner is told the draft the document actually holds');
});

test('a failure is bound to its document and clears when its cause is gone', async t => {
  const scene = await editorScene(t);
  const { languageExtensionFor } = scene.client.codeLanguages;
  const parser = languageExtensionFor('typescript', 'src/a.ts').language.parser;
  const original = parser.startParse;
  parser.startParse = () => { throw new Error('parser exploded'); };
  t.after(() => { parser.startParse = original; });

  const view = await scene.mount({ documentId: 'doc-a', path: 'src/a.ts', languageHint: 'typescript', value: 'const a = 1;' });
  assert.equal(
    view.host().getAttribute('data-fm-code-highlight'),
    'error',
    'a broken grammar degrades the document that uses it',
  );

  // A document that does not use the broken grammar must not inherit the failure.
  await view.render({ documentId: 'doc-b', path: 'src/b.json', languageHint: 'json', value: '{"a":1}' });
  assert.equal(
    view.host().getAttribute('data-fm-code-highlight'),
    'active',
    'the failure must not follow another document',
  );
  assert.equal(readEditorText(view.host()), '{"a":1}');

  // And the document that failed must recover once the cause is repaired: a
  // failure that can never clear would pin a document to the fallback forever.
  parser.startParse = original;
  await view.render({ documentId: 'doc-a', path: 'src/a.ts', languageHint: 'typescript', value: 'const a = 1;' });
  assert.equal(
    view.host().getAttribute('data-fm-code-highlight'),
    'active',
    'a repaired grammar must restore highlighting',
  );
  assert.equal(readEditorText(view.host()), 'const a = 1;');
});

test('a re-render after a repair does not rebuild the failed view', async t => {
  // Recovery is a lifecycle event, not a per-render re-check: the failed view
  // stays on the fallback until its document changes or the component is
  // remounted. An unrelated re-render must never quietly paper over a failure and
  // build a second editor behind the fallback.
  const scene = await editorScene(t);
  const restore = breakParser(scene.client.codeLanguages.languageExtensionFor('typescript', 'src/a.ts').language.parser, t);
  const view = await scene.mount({ documentId: 'doc-a', path: 'src/a.ts', languageHint: 'typescript', value: 'const a = 1;' });
  assert.equal(view.host().getAttribute('data-fm-code-highlight'), 'error', 'a broken grammar degrades its document');

  restore();
  await view.render({});
  assert.equal(
    view.host().getAttribute('data-fm-code-highlight'),
    'error',
    'a plain re-render must not re-attempt a view it already failed',
  );
  assert.equal(view.host().querySelector('.cm-content'), null, 'no editor may be rebuilt behind the fallback');
  assert.ok(fallbackOf(view.host()), 'the readable fallback stays in place');

  // A different document is the lifecycle event that does start a new view.
  await view.render({ documentId: 'doc-b', path: 'src/b.json', languageHint: 'json', value: '{"a":1}' });
  assert.equal(view.host().getAttribute('data-fm-code-highlight'), 'active', 'a different document gets a new view');
  assert.equal(readEditorText(view.host()), '{"a":1}');
});

test('a superseded view cannot save into the current document', async t => {
  // A document switch replaces the view (new content node, new view, old view
  // destroyed), so "is this the live view" has to be answered per view and not
  // per component: a component-wide flag would be reset by the new mount and let
  // the old binding through again.
  const scene = await editorScene(t);
  const view = await scene.mount({ documentId: 'doc-a', value: 'a' });
  const supersededContent = view.host().querySelector('.cm-content');

  await view.render({ documentId: 'doc-b', path: 'src/b.json', languageHint: 'json', value: 'b' });
  const currentContent = view.host().querySelector('.cm-content');
  assert.notEqual(currentContent, supersededContent, 'a document switch must render its own content node');
  assert.deepEqual(view.saves, [], 'switching documents is not a save');

  await pressSave(view, supersededContent);
  assert.deepEqual(view.saves, [], 'a superseded view must not save into the current document');

  await pressSave(view, currentContent);
  assert.deepEqual(view.saves, [true], 'the view that replaced it must still save');
});

test('a freshly mounted editor still saves after an unmount', async t => {
  // The guard for the wrong fix: a per-component "released" flag that is never
  // reset would leave every later mount unable to save. Green before and after
  // the fix by design; it exists to keep it that way.
  const scene = await editorScene(t);
  const first = await scene.mount({ value: 'first' });
  await pressSave(first, first.host().querySelector('.cm-content'));
  assert.deepEqual(first.saves, [true], 'the first view saves');

  await first.unmount();
  const second = await scene.mount({ value: 'second' });
  await pressSave(second, second.host().querySelector('.cm-content'));
  assert.deepEqual(second.saves, [true], 'a freshly mounted view saves too');
});

test('the degraded fallback follows the draft the user keeps typing', async t => {
  // The salvage only bridges the window in which the owner's prop has not caught
  // up. If it were kept, every later keystroke in the fallback — and every later
  // draft from the owner — would be masked by text from the moment of failure.
  const scene = await editorScene(t);
  const view = await scene.mount({ value: 'first' });
  await setEditorText(view.host(), 'committed');

  breakParser(scene.client.codeLanguages.languageExtensionFor('typescript', 'src/a.ts').language.parser, t);
  await dispatchEditor(view.host(), { changes: { from: 0, to: 0, insert: 'lost' } });

  const fallback = fallbackOf(view.host());
  assert.ok(fallback, 'the readable fallback must take over');
  assert.equal(fallback.value, 'committed', 'precondition: the salvage replaces the stale prop for now');

  await typeInFallback(view, fallback, 'committed again');
  assert.equal(view.changes.at(-1), 'committed again', 'the new draft must reach the owner');

  await view.render({ value: 'committed again' });
  const afterTyping = fallbackOf(view.host());
  assert.equal(afterTyping.value, 'committed again', 'the fallback must show the newest draft, not the salvaged one');
  assert.equal(view.host().getAttribute('data-fm-code-highlight'), 'error', 'the document is still degraded');
});

test('a failed dispatch never fabricates an edit event', async t => {
  // Degrading must not look like an edit: a failed transaction commits nothing,
  // and a surface the user cannot type into has no edit to report at all.
  const scene = await editorScene(t);
  const readOnly = await scene.mount({ mode: 'edit', canWrite: false, value: 'read only' });
  const preview = await scene.mount({ mode: 'preview', value: 'preview text' });
  const editable = await scene.mount({ value: 'same' });
  // Mounted while healthy, then broken, so the failure lands on a real dispatch.
  breakParser(scene.client.codeLanguages.languageExtensionFor('typescript', 'src/a.ts').language.parser, t);

  await dispatchEditor(readOnly.host(), { changes: { from: 0, to: 0, insert: 'x' } });
  assert.equal(readOnly.host().getAttribute('data-fm-code-highlight'), 'error', 'the failure still degrades the editor');
  assert.deepEqual(readOnly.changes, [], 'a surface without write access must not report an edit');

  await dispatchEditor(preview.host(), { changes: { from: 0, to: 0, insert: 'y' } });
  assert.equal(preview.host().getAttribute('data-fm-code-highlight'), 'error');
  assert.deepEqual(preview.changes, [], 'a preview must not report an edit');

  await dispatchEditor(editable.host(), { changes: { from: 0, to: 0, insert: 'z' } });
  assert.equal(editable.host().getAttribute('data-fm-code-highlight'), 'error');
  assert.deepEqual(editable.changes, [], 'the owner must not hear its own unchanged draft echoed back');
});

test('an open composition defers the incoming draft and is not inherited', async t => {
  const scene = await editorScene(t);
  const view = await scene.mount({ value: 'typed' });
  const host = view.host();
  // Dispatched at the component's own node, which is where a real composition
  // event arrives by bubbling up from the content node. Keeping it off the content
  // node also keeps CodeMirror's own `composing` flag out of the picture, so what
  // is asserted here is this component's deferral, not CodeMirror's.
  const mountNode = () => {
    const node = host.querySelector('.fm-code-mount');
    assert.ok(node, 'the editor must be mounted, so the composition listener has a node');
    return node;
  };
  const composition = name => new view.handle.window.Event(name, { bubbles: true });

  await act(async () => { mountNode().dispatchEvent(composition('compositionstart')); });
  await view.render({ value: 'incoming' });
  assert.equal(readEditorText(host), 'typed', 'an open composition must defer the incoming draft');
  assert.deepEqual(view.changes, [], 'deferring a draft is not an edit');

  await act(async () => { mountNode().dispatchEvent(composition('compositionend')); });
  await flushDom(30);
  assert.equal(readEditorText(host), 'incoming', 'the deferred draft applies once the composition ends');

  // A composition left open on one document must not defer the next one.
  await act(async () => { mountNode().dispatchEvent(composition('compositionstart')); });
  await view.render({ documentId: 'doc-b', path: 'src/b.json', languageHint: 'json', value: 'second document' });
  assert.equal(readEditorText(host), 'second document', 'a new document starts from its own draft');
  await view.render({ value: 'second edited' });
  assert.equal(readEditorText(host), 'second edited', 'the new document must not inherit the open composition');
});

test('the degraded fallback of a read-only view does not report input', async t => {
  // The fallback stands in for the same surface as the editor, so it has to
  // report on the same condition. Without the write capability there is no edit
  // to report, exactly as the CodeMirror path and the fallback's own save key
  // already gate on it.
  const scene = await editorScene(t);
  const view = await scene.mount({ mode: 'edit', canWrite: false, value: 'read only' });
  breakParser(scene.client.codeLanguages.languageExtensionFor('typescript', 'src/a.ts').language.parser, t);
  await dispatchEditor(view.host(), { changes: { from: 0, to: 0, insert: 'x' } });

  const fallback = fallbackOf(view.host());
  assert.ok(fallback, 'the readable fallback must take over');
  assert.equal(fallback.readOnly, true, 'a Host without the write capability keeps it read-only');
  assert.deepEqual(view.changes, [], 'the failed dispatch must not report an edit either');

  await typeInFallback(view, fallback, 'typed anyway');
  assert.deepEqual(view.changes, [], 'input on a read-only fallback must not be reported as an edit');
  assert.equal(fallbackOf(view.host()).value, 'read only', 'and the text must not appear to have been accepted');
});

test('the editing surface declares itself focusable without intercepting Tab', async t => {
  // A non-editable content node is not focusable on its own, so a preview could
  // not be reached, read or copied with the keyboard, and its accessible name
  // could never be announced. This asserts the declared attribute only: whether a
  // real browser then tabs into it is unverified here, because jsdom's `focus()`
  // succeeds on any element and this machine has no browser to measure it with.
  const scene = await editorScene(t);
  const preview = await scene.mount({ mode: 'preview', value: 'read only' });
  const previewContent = preview.host().querySelector('.cm-content');
  assert.equal(previewContent.getAttribute('tabindex'), '0', 'a preview must declare itself reachable');
  assert.equal(previewContent.getAttribute('contenteditable'), 'false', 'and must stay non-editable');

  const writable = await scene.mount({ value: 'editable' });
  const writableContent = writable.host().querySelector('.cm-content');
  assert.equal(writableContent.getAttribute('tabindex'), '0', 'an editable surface keeps the same declaration');
  assert.equal(writableContent.getAttribute('contenteditable'), 'true');

  // A rename reconfigures the same view, and reconfiguring must not drop the tab
  // stop while it updates the accessible name.
  await preview.render({ ariaLabel: 'Renamed preview' });
  const renamed = preview.host().querySelector('.cm-content');
  assert.equal(renamed.getAttribute('aria-label'), 'Renamed preview', 'the accessible name must follow a rename');
  assert.equal(renamed.getAttribute('tabindex'), '0', 'and the tab stop must survive the reconfigure');
  assert.equal(preview.host().getAttribute('data-fm-code-highlight'), 'active');
});

test('the save shortcut reports through onSave and is suppressed for a preview', async t => {
  const scene = await editorScene(t);
  const editable = await scene.mount({ value: 'x' });
  const content = editable.host().querySelector('.cm-content');
  const event = new editable.handle.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
  await act(async () => { content.dispatchEvent(event); });
  assert.deepEqual(editable.saves, [true], 'Ctrl+S must reach the owner callback');
  assert.equal(event.defaultPrevented, true, 'the browser save dialog must be suppressed');

  const preview = await scene.mount({ mode: 'preview', value: 'x' });
  const previewContent = preview.host().querySelector('.cm-content');
  const previewEvent = new preview.handle.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
  await act(async () => { previewContent.dispatchEvent(previewEvent); });
  assert.deepEqual(preview.saves, [], 'a preview has no save action');
});
