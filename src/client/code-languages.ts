/**
 * Language selection, the highlight budget and the token palette.
 *
 * Three decisions live here, deliberately as pure functions, because each one is
 * a behavioural contract rather than a rendering detail:
 *
 *  - which grammar a file gets (`languageIdFor` / `dialectFor`),
 *  - whether a document is still small enough to highlight
 *    (`classifyHighlightBudget`), and
 *  - how token classes map onto the host's own colours (`highlightStyle`).
 *
 * The host owns colour: the palette is expressed only as `var(--shiki-*)` and
 * `var(--dsw-*)` references, so light/dark switching stays the theme package's
 * business and this package never bakes in a resolved colour.
 */

import {
  HighlightStyle, LanguageSupport, StreamLanguage, syntaxHighlighting, type Language,
} from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { javascriptLanguage, jsxLanguage, tsxLanguage, typescriptLanguage } from '@codemirror/lang-javascript';
import { jsonLanguage } from '@codemirror/lang-json';
import { pythonLanguage } from '@codemirror/lang-python';
import { htmlLanguage } from '@codemirror/lang-html';
import { cssLanguage } from '@codemirror/lang-css';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { yamlLanguage } from '@codemirror/lang-yaml';
import { cppLanguage } from '@codemirror/lang-cpp';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { tags } from '@lezer/highlight';

/** UTF-8 size, in bytes, at which a document stops being highlighted. */
export const HIGHLIGHT_MAX_BYTES = 1048576;

/** Longest line, in UTF-16 units, that still allows highlighting. */
export const HIGHLIGHT_MAX_LINE_UNITS = 20000;

/** Whether a document is within the highlight budget. */
export type HighlightBudget = 'active' | 'limited';

/** The state one editor renders, in the frozen priority order. */
export type HighlightState = 'active' | 'plain' | 'limited' | 'error';

/** The grammar variants this generation ships. */
export type DialectId =
  | 'js' | 'jsx' | 'ts' | 'tsx' | 'json' | 'python'
  | 'html' | 'css' | 'markdown' | 'yaml' | 'cpp' | 'shell';

/**
 * The bare grammars.
 *
 * `shell` has no Lezer grammar, so its tokeniser is driven as a stream; every
 * other dialect is a Lezer language that also carries its own indent and fold
 * metadata.
 */
const GRAMMARS: Readonly<Record<DialectId, Language>> = Object.freeze({
  js: javascriptLanguage,
  jsx: jsxLanguage,
  ts: typescriptLanguage,
  tsx: tsxLanguage,
  json: jsonLanguage,
  python: pythonLanguage,
  html: htmlLanguage,
  css: cssLanguage,
  markdown: markdownLanguage,
  yaml: yamlLanguage,
  cpp: cppLanguage,
  shell: StreamLanguage.define(shell),
});

/**
 * Grammar hint (what the host derives from the filename) to grammar variant.
 *
 * `c` maps to the C++ grammar: this generation ships no separate C grammar and
 * the host reports `.c`/`.h` as `c`. Hints the host can produce but this
 * generation does not ship are absent on purpose, so they degrade to plain text
 * instead of being guessed at.
 */
const HINT_DIALECTS: Readonly<Record<string, DialectId>> = Object.freeze({
  javascript: 'js',
  typescript: 'ts',
  json: 'json',
  python: 'python',
  html: 'html',
  css: 'css',
  markdown: 'markdown',
  yaml: 'yaml',
  c: 'cpp',
  cpp: 'cpp',
  shellscript: 'shell',
});

/** Human-readable grammar names, for the label the panel shows next to the editor. */
export const LANGUAGE_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  json: 'JSON',
  python: 'Python',
  html: 'HTML',
  css: 'CSS',
  markdown: 'Markdown',
  yaml: 'YAML',
  c: 'C',
  cpp: 'C++',
  shellscript: 'Shell',
  plaintext: 'Plain text',
});

/**
 * The language id reported for a hint.
 *
 * The hint is the single source of truth for *which* language is used; a
 * filename never invents one. Known-but-unshipped hints and an absent hint are
 * both `plaintext`, which is not an error: the document is simply rendered
 * without a grammar.
 *
 * @param languageHint - The hint the host derived from the filename, if any.
 * @returns The frozen hint id, or `plaintext`.
 */
export function languageIdFor(languageHint: string | undefined): string {
  if (typeof languageHint === 'string' && Object.hasOwn(HINT_DIALECTS, languageHint)) return languageHint;
  return 'plaintext';
}

/** The lower-cased final extension of a path, or undefined when it has none. */
function fileExtension(path: string): string | undefined {
  return /\.([^./\\]+)$/u.exec(path.replaceAll('\\', '/'))?.[1]?.toLowerCase();
}

/**
 * The grammar variant for a hint and path.
 *
 * Only the JavaScript family has variants a filename can refine: a `.tsx` file
 * is still TypeScript, so the hint keeps naming the language and the path only
 * selects the dialect. Every other language ignores the path entirely, and an
 * absent or unshipped hint stays `null` whatever the extension is.
 *
 * @param languageHint - The hint the host derived from the filename, if any.
 * @param path - The file path, used only to pick a JS/TS dialect.
 * @returns The dialect id, or null when the document gets no grammar.
 */
export function dialectFor(languageHint: string | undefined, path: string): DialectId | null {
  const hint = languageIdFor(languageHint);
  if (hint === 'plaintext') return null;
  const dialect = HINT_DIALECTS[hint];
  if (dialect === undefined) return null;
  if (dialect === 'js') return fileExtension(path) === 'jsx' ? 'jsx' : 'js';
  if (dialect === 'ts') return fileExtension(path) === 'tsx' ? 'tsx' : 'ts';
  return dialect;
}

const EXTENSIONS = new Map<DialectId, LanguageSupport>();

/**
 * The syntax support for a dialect, built once and reused.
 *
 * The language packages ship factories — `javascript({jsx: true})`, `html()`,
 * `markdown()` — that attach *input* behaviour through the support list:
 * `autoCloseTags` closes tags while typing and `markdownKeymap` continues lists.
 * This editor only colours tokens, so the bare grammars are wrapped in a
 * minimal `LanguageSupport` instead. That keeps rendering while leaving the
 * support list empty, and the instance is cached per dialect so switching mode
 * or remounting reuses one grammar rather than rebuilding it.
 *
 * @param languageHint - The hint the host derived from the filename, if any.
 * @param path - The file path, used only to pick a JS/TS dialect.
 * @returns A shared `LanguageSupport`, or null for a plain-text document.
 */
export function languageExtensionFor(languageHint: string | undefined, path: string): LanguageSupport | null {
  const dialect = dialectFor(languageHint, path);
  if (dialect === null) return null;
  const existing = EXTENSIONS.get(dialect);
  if (existing) return existing;
  const created = new LanguageSupport(GRAMMARS[dialect], []);
  EXTENSIONS.set(dialect, created);
  return created;
}

/**
 * UTF-8 length without allocating the encoded buffer.
 *
 * Surrogate pairs count as four bytes because that is what encoding produces,
 * and the count stops as soon as the budget is exceeded: the result is only ever
 * compared against the limit, so returning early is safe and keeps a 5 MiB
 * document from building a second 5 MiB buffer.
 */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes > HIGHLIGHT_MAX_BYTES) return bytes;
  }
  return bytes;
}

/** The longest line, in UTF-16 units. The newline itself is not part of a line. */
function longestLineUnits(text: string): number {
  let longest = 0;
  let current = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) {
      if (current > longest) longest = current;
      current = 0;
    } else current += 1;
  }
  return current > longest ? current : longest;
}

/**
 * Whether a document still fits the highlight budget.
 *
 * Both limits are inclusive — exactly 1 MiB of UTF-8 and exactly 20 000 units on
 * a line still highlight — because only a document *over* a limit loses its
 * grammar. The size is measured in encoded bytes rather than UTF-16 units: a CJK
 * document is about three times as large as `value.length` suggests, and
 * measuring units instead would highlight documents the budget was meant to
 * exclude.
 *
 * @param text - The normalized draft about to be rendered.
 * @returns `limited` when either limit is exceeded, otherwise `active`.
 */
export function classifyHighlightBudget(text: string): HighlightBudget {
  if (text.length === 0) return 'active';
  return utf8Length(text) > HIGHLIGHT_MAX_BYTES || longestLineUnits(text) > HIGHLIGHT_MAX_LINE_UNITS
    ? 'limited'
    : 'active';
}

/**
 * The state to render, in the frozen priority order:
 * *error* > *plain* (no grammar for the hint) > *limited* (a shipped grammar over
 * budget) > *active*.
 *
 * The order matters when two conditions hold at once: an unknown hint over
 * budget is reported as `plain`, because there was never a grammar to withdraw,
 * while a failure outranks both.
 *
 * @param input - The hint, path, normalized draft and whether the editor failed.
 * @returns The state the editor renders.
 */
export function highlightStateFor(input: {
  readonly languageHint?: string | undefined;
  readonly path: string;
  readonly value: string;
  readonly failed?: boolean | undefined;
}): HighlightState {
  if (input.failed === true) return 'error';
  if (dialectFor(input.languageHint, input.path) === null) return 'plain';
  return classifyHighlightBudget(input.value);
}

/**
 * The token palette.
 *
 * Every value is a host token reference and nothing else: the theme package
 * owns both palettes, so one style sheet is correct in light and dark mode and
 * this package never has to know a colour value. Families are kept visually
 * distinct — keywords, strings, comments, literals, functions and types each get
 * their own token — because that distinction is the whole point of the feature.
 */
export const highlightStyle: HighlightStyle = HighlightStyle.define([
  {
    tag: [
      tags.keyword, tags.modifier, tags.controlKeyword, tags.definitionKeyword,
      tags.operatorKeyword, tags.self, tags.moduleKeyword,
    ],
    color: 'var(--shiki-token-keyword)',
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.character, tags.regexp, tags.escape],
    color: 'var(--shiki-token-string)',
  },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: 'var(--shiki-token-comment)',
    fontStyle: 'italic',
  },
  {
    tag: [
      tags.number, tags.integer, tags.float, tags.bool, tags.null,
      tags.constant(tags.name), tags.constant(tags.variableName), tags.constant(tags.propertyName),
    ],
    color: 'var(--shiki-token-constant)',
  },
  {
    tag: [
      tags.function(tags.variableName), tags.function(tags.propertyName),
      tags.function(tags.definition(tags.variableName)), tags.macroName, tags.labelName,
    ],
    color: 'var(--shiki-token-function)',
  },
  {
    tag: [
      tags.typeName, tags.className, tags.namespace, tags.tagName,
      tags.standard(tags.name), tags.standard(tags.variableName),
    ],
    color: 'var(--shiki-token-parameter)',
  },
  {
    tag: [
      tags.propertyName, tags.attributeName, tags.attributeValue,
      tags.definition(tags.propertyName),
    ],
    color: 'var(--shiki-token-link)',
  },
  {
    tag: [tags.variableName, tags.definition(tags.variableName), tags.local(tags.variableName)],
    color: 'var(--shiki-foreground)',
  },
  {
    tag: [
      tags.punctuation, tags.bracket, tags.brace, tags.squareBracket, tags.paren, tags.separator,
      tags.operator, tags.derefOperator, tags.logicOperator, tags.arithmeticOperator,
      tags.compareOperator, tags.updateOperator, tags.definitionOperator, tags.typeOperator,
      tags.controlOperator,
    ],
    color: 'var(--shiki-token-punctuation)',
  },
  {
    tag: [tags.heading, tags.strong],
    color: 'var(--shiki-token-keyword)',
  },
  {
    tag: [tags.emphasis],
    color: 'var(--shiki-foreground)',
    fontStyle: 'italic',
  },
  {
    tag: [tags.strikethrough],
    color: 'var(--shiki-foreground)',
    textDecoration: 'line-through',
  },
  {
    tag: [tags.link, tags.url],
    color: 'var(--shiki-token-link)',
    textDecoration: 'underline',
  },
  {
    tag: [tags.invalid],
    color: 'var(--dsw-alias-state-error-primary)',
  },
]);

/**
 * The syntax-highlighting extension for the palette.
 *
 * @returns The extension that applies {@link highlightStyle} to a state.
 */
export function createHighlightExtension(): Extension {
  return syntaxHighlighting(highlightStyle);
}
