import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { act, node, nodes, setup, textOf } from './client-harness.mjs';

/**
 * Path-bar (breadcrumb) layout contract — R20.
 *
 * The subject is the shipped `dist/client.js`, rendered by React's real renderer
 * against the real Host router. The file separates two kinds of check:
 *
 *  - structure and declarations: which elements the panel renders, where they
 *    sit, and what the stylesheet it outputs declares for the breadcrumb
 *    selectors. A declaration check reads the stylesheet as text for a given
 *    selector — it models no cascade, specificity, inheritance or initial value
 *    — so it proves what the product declares, never what a browser computes.
 *    No pixel geometry, no scroll offset and no visual acceptance is claimed
 *    here; those belong to the real page;
 *  - control flow: the labels, request paths and listings the breadcrumb
 *    controls produce against the real Host.
 *
 * The declaration checks are the failing-first ones: the squeezed path bar comes
 * from shrinkable crumb/refresh controls and wrappers that may wrap, while the
 * region still sizes itself from its contents instead of the available space.
 */

const CONTROL_URL = '/api/file-manager/v2/control';

// A path long enough to squeeze any path bar: 17 plain levels, one very long
// level, one level with a space and Chinese characters, one level with only
// ASCII and spaces. Every name stays a legal filename component: the long level
// is 41 characters and 123 bytes, because each of its Chinese characters is
// 3 bytes in UTF-8.
const LONG_SEGMENT = `${'长段'.repeat(20)}尾`;
const DEEP_SEGMENTS = [
  ...Array.from({ length: 17 }, (unused, index) => `l${index + 1}`),
  LONG_SEGMENT,
  '中文 目录',
  'space segment',
];
const DEEP_PATH = DEEP_SEGMENTS.join('/');

async function seedDeep(root) {
  await mkdir(path.join(root, ...DEEP_SEGMENTS), { recursive: true });
  await writeFile(path.join(root, ...DEEP_SEGMENTS, 'deep.txt'), 'deep\n');
}

const controlBody = init => JSON.parse(String(init.body ?? '{}'));

// --- rendered markup --------------------------------------------------------

const classesOf = element => String(element.props.className ?? '').split(/\s+/).filter(Boolean);
const hasClass = (element, name) => classesOf(element).includes(name);

/** The nearest ancestor that is a rendered element, not a component instance. */
function hostParent(element) {
  let cursor = element.parent;
  while (cursor && typeof cursor.type !== 'string') cursor = cursor.parent;
  return cursor;
}

const refreshControl = view => node(view.renderer, { 'data-fm-action': 'refresh' });

/** The top path row: the element that owns the file list's refresh control. */
const pathRow = view => hostParent(refreshControl(view));

/** Every crumb control in the path row, root level first, then each path level. */
const crumbControls = view => pathRow(view).findAll(candidate => candidate.type === 'button' && candidate.props['data-fm-action'] !== 'refresh');

/** The rendered crumb items, in order: one per path level. */
const crumbItems = view => pathRow(view).findAll(candidate => hasClass(candidate, 'fm-crumb'));

const crumbRegion = view => {
  const navs = pathRow(view).findAll(candidate => candidate.type === 'nav');
  assert.equal(navs.length, 1, 'the path row must contain exactly one breadcrumb navigation region');
  return navs[0];
};

/** Clicks one already-located element and lets the interaction settle. */
async function clickElement(view, element) {
  await act(async () => {
    await element.props.onClick();
    await view.settle();
  });
}

/** Opens every level of the deep fixture through real directory clicks. */
async function openDeep(view) {
  for (let depth = 1; depth <= DEEP_SEGMENTS.length; depth += 1) {
    await view.click({ 'data-fm-entry': 'directory', 'data-fm-path': DEEP_SEGMENTS.slice(0, depth).join('/') });
  }
}

const rootLabelOf = view => view.manager.listRoots()[0].label;

// --- stylesheet declarations -------------------------------------------------
//
// A lookup over the stylesheet the panel really renders: it walks the top-level
// blocks, skips at-rules (`@media`, `@supports`), normalizes whitespace and
// comma-separated selectors, and returns the properties of the rule with the
// requested selector as written. No cascade, specificity, pseudo-class or
// initial value is modelled.

const normalizeSelector = text => text.trim().replace(/\s+/g, ' ').replace(/\s*>\s*/g, '>');

/** The declarations of every top-level rule, keyed by normalized selector. */
function topLevelRules(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = new Map();
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('{', cursor);
    if (open === -1) break;
    const selector = source.slice(cursor, open).trim();
    let depth = 1;
    let end = open + 1;
    while (end < source.length && depth > 0) {
      if (source[end] === '{') depth += 1;
      else if (source[end] === '}') depth -= 1;
      end += 1;
    }
    if (!selector.startsWith('@')) {
      const declarations = new Map();
      for (const chunk of source.slice(open + 1, end - 1).split(';')) {
        const separator = chunk.indexOf(':');
        if (separator > 0) declarations.set(chunk.slice(0, separator).trim(), chunk.slice(separator + 1).trim());
      }
      for (const alternative of selector.split(',')) rules.set(normalizeSelector(alternative), declarations);
    }
    cursor = end;
  }
  return rules;
}

/** The declarations of the rule with exactly this selector, as written. */
function declarationsFor(view, selector) {
  const styles = view.renderer.root.findAll(candidate => candidate.type === 'style');
  assert.equal(styles.length, 1, 'the panel must render exactly one stylesheet');
  const rule = topLevelRules(textOf(styles[0])).get(normalizeSelector(selector));
  assert.ok(rule, `the stylesheet must contain the top-level rule "${selector}"`);
  return rule;
}

/** Expands only the three-value/none/auto flex and overflow forms used here. */
function declared(style, property) {
  const direct = style.get(property);
  if (direct !== undefined) return direct;
  if (property === 'overflow-x' || property === 'overflow-y') {
    const shorthand = style.get('overflow');
    if (shorthand === undefined) return undefined;
    const parts = shorthand.trim().split(/\s+/);
    return parts[property === 'overflow-x' ? 0 : (parts.length === 1 ? 0 : 1)];
  }
  const flexIndex = ['flex-grow', 'flex-shrink', 'flex-basis'].indexOf(property);
  if (flexIndex !== -1) {
    const shorthand = style.get('flex');
    if (shorthand === undefined) return undefined;
    const parts = shorthand.trim().split(/\s+/);
    const values = shorthand === 'none' ? ['0', '0', 'auto']
      : shorthand === 'auto' ? ['1', '1', 'auto']
        : parts.length === 3 ? parts : undefined;
    return values?.[flexIndex];
  }
  return undefined;
}

const isZeroLength = value => /^0(px|em|rem|%|vh|vw)?$/.test(String(value ?? '').trim());

// --- structure ---------------------------------------------------------------

test('the path row is the breadcrumb bar: one navigation region plus the refresh control', async t => {
  const view = await setup(t);
  const row = pathRow(view);
  assert.ok(hasClass(row, 'fm-breadcrumb-bar'), `the top path row must carry the approved breadcrumb-bar class (got "${row.props.className ?? ''}")`);
  // The single-line row layout is the retained `fm-pathbar` rule; the
  // breadcrumb class only adds what the squeezed path bar was missing.
  assert.ok(hasClass(row, 'fm-pathbar'), 'the bar keeps the path-row class that lays it out');
  const rowStyle = declarationsFor(view, '.dsh-fm .fm-pathbar');
  assert.equal(declared(rowStyle, 'display'), 'flex', 'the bar lays its region and control out on one line');
  assert.equal(declared(rowStyle, 'align-items'), 'center');
  assert.equal(declared(rowStyle, 'flex-wrap') ?? 'nowrap', 'nowrap', 'a wrapping bar would hide levels instead of scrolling them');
  assert.equal(hostParent(refreshControl(view)), row, 'the refresh control must be the bar\'s own child, outside the scrolling region');
  const region = crumbRegion(view);
  assert.ok(hasClass(region, 'fm-crumbs'), `the navigation region must carry the crumb container class (got "${region.props.className ?? ''}")`);
  assert.equal(hostParent(region), row, 'the navigation region must be the bar\'s own child');
});

test('the navigation region holds the root control plus one crumb item per level', async t => {
  const view = await setup(t, { seed: seedDeep });
  await openDeep(view);
  const region = crumbRegion(view);
  const rootControl = crumbControls(view)[0];
  assert.equal(hostParent(rootControl), region, 'the root control must be a direct child of the navigation region');
  assert.equal(textOf(rootControl), rootLabelOf(view));
  const items = crumbItems(view);
  assert.equal(items.length, DEEP_SEGMENTS.length, `every path level must be its own crumb item (got ${items.length} of ${DEEP_SEGMENTS.length})`);
  assert.deepEqual(
    items.map(textOf),
    DEEP_SEGMENTS.map(segment => `/${segment}`),
    'each crumb item must render its own separator and its level verbatim, in directory order',
  );
  for (const [index, item] of items.entries()) {
    assert.equal(hostParent(item), region, `crumb item ${index} must belong to the navigation region`);
    assert.equal(item.findAll(candidate => candidate.type === 'button').length, 1, `crumb item ${index} must carry exactly one control`);
    assert.equal(item.findAll(candidate => candidate.type === 'i').length, 1, `crumb item ${index} must own its separator`);
  }
});

// --- declarations ------------------------------------------------------------

test('the breadcrumb bar declares it can be squeezed, and the region declares the scrolling track', async t => {
  const view = await setup(t, { seed: seedDeep });
  await openDeep(view);
  const bar = declarationsFor(view, '.dsh-fm .fm-breadcrumb-bar');
  assert.ok(isZeroLength(declared(bar, 'min-width')), 'without min-width:0 the bar cannot shrink below its content');
  const region = declarationsFor(view, '.dsh-fm .fm-breadcrumb-bar>.fm-crumbs');
  assert.equal(declared(region, 'flex-grow'), '1', 'the region must absorb the free space of the bar');
  assert.equal(declared(region, 'flex-shrink'), '1', 'the region is the part that gives way');
  assert.ok(isZeroLength(declared(region, 'flex-basis')), 'the region must be sized from its flex factor, not from its content');
  assert.ok(isZeroLength(declared(region, 'min-width')), 'without min-width:0 a flex item refuses to shrink below its content');
  assert.ok(['auto', 'scroll'].includes(declared(region, 'overflow-x')), 'an overlong path scrolls horizontally inside the region');
  assert.ok(['hidden', 'clip'].includes(declared(region, 'overflow-y')), 'the region must not become vertically scrollable');
});

test('the root control declares no shrink and no wrap', async t => {
  const view = await setup(t, { seed: seedDeep });
  await openDeep(view);
  const root = declarationsFor(view, '.dsh-fm .fm-breadcrumb-bar>.fm-crumbs>button');
  assert.equal(declared(root, 'flex-shrink'), '0', 'the root level must not be compressed by a long path');
  assert.equal(declared(root, 'white-space'), 'nowrap', 'the root label must stay on one line');
});

test('each crumb item declares a non-shrinking, non-wrapping flex box', async t => {
  const view = await setup(t, { seed: seedDeep });
  await openDeep(view);
  const crumb = declarationsFor(view, '.dsh-fm .fm-crumb');
  assert.equal(declared(crumb, 'display'), 'inline-flex', 'a crumb item is a flex box, not a wrapping inline span');
  assert.equal(declared(crumb, 'align-items'), 'center', 'a crumb item keeps its separator and name on one line');
  assert.equal(declared(crumb, 'gap'), '2px', 'the separator and the level name keep their spacing');
  assert.equal(declared(crumb, 'flex-shrink'), '0', 'a crumb item must not be compressed by a long path');
  assert.equal(declared(crumb, 'flex-grow'), '0');
  assert.equal(declared(crumb, 'flex-basis'), 'auto');
  assert.equal(declared(crumb, 'white-space'), 'nowrap', 'a crumb item must never wrap between its separator and its name');
});

test('the refresh control declares no shrink and no wrap', async t => {
  const view = await setup(t, { seed: seedDeep });
  await openDeep(view);
  const refresh = declarationsFor(view, '.dsh-fm .fm-breadcrumb-bar>button');
  assert.equal(declared(refresh, 'flex-shrink'), '0', 'the refresh control keeps its width while the region scrolls');
  assert.equal(declared(refresh, 'white-space'), 'nowrap', 'the refresh label must stay on one line');
});

// --- control flow (existing behaviour that must survive the fix) -------------

test('a short path shows only the root level and the root crumb returns to the root directory', async t => {
  const view = await setup(t);
  const rootLabel = rootLabelOf(view);
  assert.deepEqual(crumbControls(view).map(textOf), [rootLabel], 'the root directory has no path level');
  await view.click({ 'data-fm-entry': 'directory', 'data-fm-path': 'folder' });
  assert.deepEqual(crumbControls(view).map(textOf), [rootLabel, 'folder']);
  await clickElement(view, crumbControls(view)[0]);
  assert.deepEqual(crumbControls(view).map(textOf), [rootLabel], 'the root crumb leaves every path level behind');
  assert.equal(nodes(view.renderer, { 'data-fm-entry': 'directory', 'data-fm-path': 'folder' }).length, 1, 'the root crumb lists the root directory again');
  assert.ok(view.requests.some(item => item.url === CONTROL_URL && controlBody(item.init).op === 'entries.list' && controlBody(item.init).path === ''));
});

test('a twenty-level path renders every label verbatim and navigates to any ancestor', async t => {
  const view = await setup(t, { seed: seedDeep });
  await openDeep(view);
  const rootLabel = rootLabelOf(view);
  assert.deepEqual(crumbControls(view).map(textOf), [rootLabel, ...DEEP_SEGMENTS]);
  await clickElement(view, crumbControls(view)[3]);
  assert.deepEqual(crumbControls(view).map(textOf), [rootLabel, 'l1', 'l2', 'l3'], 'an ancestor crumb enters exactly that directory');
  const listings = view.requests.filter(item => item.url === CONTROL_URL).map(item => controlBody(item.init)).filter(body => body.op === 'entries.list');
  assert.equal(listings.at(-1).path, 'l1/l2/l3');
  assert.equal(nodes(view.renderer, { 'data-fm-entry': 'directory', 'data-fm-path': 'l1/l2/l3/l4' }).length, 1, 'the ancestor listing is the real one');
  await clickElement(view, crumbControls(view)[0]);
  assert.deepEqual(crumbControls(view).map(textOf), [rootLabel]);
  assert.equal(nodes(view.renderer, { 'data-fm-entry': 'directory', 'data-fm-path': 'l1' }).length, 1);
});

test('refresh stays in the current directory and leaves the labels untouched', async t => {
  const view = await setup(t, { seed: seedDeep });
  await openDeep(view);
  const before = crumbControls(view).map(textOf);
  const seen = view.requests.length;
  await view.click({ 'data-fm-action': 'refresh' });
  assert.deepEqual(crumbControls(view).map(textOf), before, 'refresh must not rename, reorder or drop a level');
  const listings = view.requests.slice(seen).map(item => controlBody(item.init)).filter(body => body.op === 'entries.list');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].path, DEEP_PATH, 'refresh re-reads the directory the user is in');
  assert.equal(nodes(view.renderer, { 'data-fm-entry': 'file', 'data-fm-path': `${DEEP_PATH}/deep.txt` }).length, 1);
});

test('breadcrumb levels and refresh are disabled while a directory request is in flight', async t => {
  let release;
  let started;
  let armed = false;
  const gate = new Promise(resolve => { release = resolve; });
  const opened = new Promise(resolve => { started = resolve; });
  t.after(() => release());
  const view = await setup(t, { seed: seedDeep, intercept: async (url, init, route) => {
    if (url === CONTROL_URL && init.method === 'POST') {
      const body = controlBody(init);
      // Only the navigation this test drives is held; the bootstrap listing of
      // the same path must complete or the view would never mount.
      if (armed && body.op === 'entries.list' && body.path === '') { started(); await gate; }
    }
    return route(url, init);
  } });
  await view.click({ 'data-fm-entry': 'directory', 'data-fm-path': 'l1' });
  assert.deepEqual(crumbControls(view).map(textOf), [rootLabelOf(view), 'l1']);
  assert.equal(crumbControls(view).every(control => control.props.disabled === false), true, 'an idle breadcrumb stays usable');
  assert.equal(refreshControl(view).props.disabled, false);
  armed = true;
  await act(async () => { crumbControls(view)[0].props.onClick(); await opened; });
  assert.equal(crumbControls(view).every(control => control.props.disabled === true), true, 'every level is disabled while a listing is in flight');
  assert.equal(refreshControl(view).props.disabled, true, 'refresh is disabled while a listing is in flight');
  release();
  await view.flush();
  assert.deepEqual(crumbControls(view).map(textOf), [rootLabelOf(view)], 'the released navigation still commits');
  assert.equal(crumbControls(view).every(control => control.props.disabled === false), true);
});

test('a failed navigation keeps the current levels and reports the error', async t => {
  const view = await setup(t, { seed: seedDeep, intercept: async (url, init, route) => {
    if (url === CONTROL_URL && init.method === 'POST' && controlBody(init).op === 'entries.list' && controlBody(init).path === 'l1') {
      return new Response(JSON.stringify({ ok: false, error: { code: 'IO_ERROR', message: 'listing failed' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return route(url, init);
  } });
  await view.click({ 'data-fm-entry': 'directory', 'data-fm-path': 'l1' });
  assert.deepEqual(crumbControls(view).map(textOf), [rootLabelOf(view)], 'a rejected navigation must not commit a path level');
  const alerts = nodes(view.renderer, { role: 'alert' });
  assert.equal(alerts.length, 1, 'the failure must be reported');
  assert.equal(textOf(alerts[0]), '文件系统操作失败。');
  assert.equal(refreshControl(view).props.disabled, false, 'a failure must not leave the path controls stuck');
});

test('a Host without a granted root keeps refresh disabled and shows no level', async t => {
  const view = await setup(t, { intercept: async (url, init, route) => {
    const response = await route(url, init);
    if (init.body && controlBody(init).op === 'bootstrap') {
      const payload = await response.json();
      payload.value.roots = [];
      return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
    }
    return response;
  } });
  assert.deepEqual(crumbControls(view).map(textOf), [], 'no granted root means no breadcrumb level');
  assert.equal(refreshControl(view).props.disabled, true, 'without a root there is nothing to refresh');
});

test('a long root label reaches the root crumb verbatim', async t => {
  const longName = `根目录_${'长'.repeat(30)}_尾`;
  const view = await setup(t, { seed: root => mkdir(path.join(root, longName)) });
  act(() => node(view.renderer, { 'data-fm-add-path': true }).props.onChange({ target: { value: path.join(view.root, longName) } }));
  await act(async () => {
    await node(view.renderer, { 'data-fm-add-root': true }).props.onSubmit({ preventDefault() {} });
    await view.settle();
  });
  const entry = nodes(view.renderer, { 'data-fm-root': true }).find(candidate => textOf(candidate).includes(longName));
  assert.ok(entry, 'the added root must appear in the root list');
  await clickElement(view, entry);
  assert.equal(textOf(crumbControls(view)[0]), longName, 'the root level must show the full granted label');
});
