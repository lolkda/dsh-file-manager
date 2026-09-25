/**
 * Upload review dialog: the themed portal policy menu, the stacked review row,
 * the action sizes and the frozen conflict rules.
 *
 * Subject and boundary
 * --------------------
 * Every case renders the shipped Client bundle (`dist/client.js`) against the
 * real Host through the same module table the other Client suites use, so the
 * assertions observe real rendered components, real requests and real
 * filesystem effects. `uiBoundary` supplies the primitive *components* only: it
 * does not model the Host popup's positioning, its focus movement or its theme
 * surfaces, so nothing here is pixel, geometry or computed-style evidence — the
 * popup offset and the single-border rendering stay on the real-page acceptance
 * list.
 *
 * The stylesheet cases read the declarations the shipped panel actually emits.
 * They are declaration contracts, not computed values: no cascade, specificity
 * or initial value is modelled.
 *
 * Each case names, in its comment, the production behaviour whose removal makes
 * it fail.
 *
 * Hooks this suite fixes, to be matched by the implementation:
 *  - trigger  `ui.Button` with `data-fm-upload-policy={index}`, `aria-haspopup="menu"`,
 *    `aria-expanded`, `disabled={busy}`, class `fm-upload-policy-trigger`. The
 *    trigger draws no ring of its own: focus and the expanded state are shown by
 *    the theme's interactive overlay (`--dsw-alias-interactive-bg-hover`), never
 *    by an outline, a shadow, a border layer or a border-colour swap. The token is
 *    pinned because the earlier `--dsw-alias-bg-layer-2` resolved to the card's own
 *    surface in the real page, which this declaration contract alone cannot see.
 *  - menu     `ui.Menu` with `open`, `portal`, `autoFocus`, `items`, `selectedId`,
 *    `onClose`, `onSelect`, class `fm-upload-policy-menu`, anchor = the trigger;
 *  - item     `fm-upload-item`, filename `fm-upload-filename`, label `fm-upload-label`,
 *    rename input `data-fm-upload-name={index}`. The label class may be shared
 *    with the rename field's label, so the policy label is identified by its
 *    position in the row (it is the first label, ahead of its control) rather
 *    than by uniqueness;
 *  - footer   Cancel and Upload use `size="md"`; every other dialog keeps its size.
 */

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { act, node, nodes, setup, textOf, uiBoundary } from './client-harness.mjs';
import { loadClientModule } from './client-module-loader.mjs';

// ---------------------------------------------------------------------------
// Harness helpers for this dialog only (the shared harness is reused as-is).
// ---------------------------------------------------------------------------

const uploadDialog = view => node(view.renderer, { role: 'dialog', 'aria-label': '核对上传内容' });

/** Opens the review exactly as the hidden file input does. */
async function openUpload(view, files) {
  await act(async () => {
    await node(view.renderer, { 'data-fm-upload-files': true }).props.onChange({ target: { files, value: '' } });
  });
  await view.flush();
}

/**
 * The plugin's one policy Menu. A native `<select>` would render none, so this
 * fails cleanly instead of crashing when the control is still native.
 */
const policyMenu = view => {
  const menus = uploadDialog(view).findAllByType(uiBoundary.Menu);
  assert.equal(menus.length, 1, 'the upload dialog must compose exactly one shared Menu');
  return menus[0];
};

/**
 * The policy control of review row 0.
 *
 * The rendered element must be a real button: the native select popup is the
 * reported visual regression. Asserting before any click keeps a missing
 * control an assertion failure rather than a TypeError inside the helpers.
 */
const policyTrigger = view => {
  const trigger = node(view.renderer, { 'data-fm-upload-policy': 0 });
  assert.equal(trigger.type, 'button', 'the upload policy must be a themed button trigger, not a native select');
  return trigger;
};

const openPolicy = async view => {
  policyTrigger(view);
  await view.click({ 'data-fm-upload-policy': 0 });
};

const confirmButton = view => node(view.renderer, { 'data-fm-action': 'upload-confirm' });

const beginRequests = view => view.requests.filter(item => item.init.body && JSON.parse(item.init.body).op === 'transfers.begin');

/**
 * The element that owns the dialog's keyboard capture.
 *
 * Escape has to be consumed before the enclosing Modal's document listener can
 * dismiss the whole review, so the handler lives on the review container. This
 * lookup is selector-agnostic on purpose: it asserts the ownership, not a class.
 */
const captureOwner = view => {
  const owners = uploadDialog(view).findAll(candidate => typeof candidate.props?.onKeyDownCapture === 'function');
  assert.equal(owners.length, 1, 'the upload review must own exactly one Escape capture');
  return owners[0];
};

/** Host instances only (the composite primitive elements duplicate their props). */
const hostNodes = root => root.findAll(candidate => typeof candidate.type === 'string');
const classList = value => String(value ?? '').split(/\s+/).filter(Boolean);
const classNode = (root, name) => {
  const found = hostNodes(root).filter(candidate => classList(candidate.props.className).includes(name));
  assert.equal(found.length, 1, `expected exactly one rendered .${name}, found ${found.length}`);
  return found[0];
};
const hasClass = name => candidate => classList(candidate.props.className).includes(name);

/** A directory handle fixture: the browser picker's own shape, entries only. */
const directory = (name, children = []) => ({
  name,
  kind: 'directory',
  async *entries() { for (const child of children) yield [child.name, child]; },
});

// ---------------------------------------------------------------------------
// Stylesheet declarations of the shipped panel.
// ---------------------------------------------------------------------------

/** Every rule in one stylesheet, at-rules expanded, comments removed. */
function styleRules(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const walk = (from, to) => {
    let cursor = from;
    while (cursor < to) {
      const open = source.indexOf('{', cursor);
      if (open === -1 || open >= to) break;
      const selector = source.slice(cursor, open).trim();
      let depth = 1;
      let end = open + 1;
      while (end < to && depth > 0) {
        if (source[end] === '{') depth += 1;
        else if (source[end] === '}') depth -= 1;
        end += 1;
      }
      if (selector.startsWith('@')) {
        walk(open + 1, end - 1);
      } else {
        const declarations = new Map();
        for (const chunk of source.slice(open + 1, end - 1).split(';')) {
          const separator = chunk.indexOf(':');
          if (separator > 0) declarations.set(chunk.slice(0, separator).trim(), chunk.slice(separator + 1).trim());
        }
        rules.push({ selector, declarations });
      }
      cursor = end;
    }
  };
  walk(0, source.length);
  return rules;
}

const shippedCss = view => textOf(view.renderer.root.findAll(candidate => candidate.type === 'style')[0]);
const rulesFor = (css, className) => styleRules(css)
  .filter(rule => rule.selector.split(',').some(part => part.includes(`.${className}`)));
/** The rules written with exactly this selector, no substring neighbours. */
const exactRule = (css, selector) => styleRules(css)
  .filter(rule => rule.selector.split(',').some(part => part.trim() === selector));
const declares = (rules, property, expected) => rules.some(rule => {
  const value = rule.declarations.get(property);
  if (value === undefined) return false;
  return expected instanceof RegExp ? expected.test(value) : value === expected;
});
/**
 * Whether these rules show a state with a host-theme background or text colour.
 *
 * A border colour is deliberately not accepted: the frozen requirement keeps the
 * theme background/text as the focus and open hint, and a colour swap on a border
 * is the ring-by-another-name the report was about.
 */
const themedHint = rules => rules.some(rule => ['background', 'background-color', 'color']
  .some(property => /var\(--/.test(rule.declarations.get(property) ?? '')));
/**
 * The token the real page measured as an actual change of the effective surface.
 *
 * The first declaration-level hint used `--dsw-alias-bg-layer-2`, which resolves
 * to the very same surface as the card, so the check above passed while focus
 * stayed invisible in the browser. Pinning the measured overlay keeps the
 * regression visible to this suite; the real-page comparison stays the authority
 * on what the value renders as.
 */
const HINT_BACKGROUND = 'var(--dsw-alias-interactive-bg-hover)';
const declaresHintToken = rules => rules.some(rule => ['background', 'background-color']
  .some(property => rule.declarations.get(property) === HINT_BACKGROUND));

// ---------------------------------------------------------------------------
// The policy control itself.
// ---------------------------------------------------------------------------

// Remove the Menu composition (keep a native select) → fails.
test('the upload policy is the themed portal Menu, never the native select popup', async t => {
  const view = await setup(t, { transfers: true });
  await openUpload(view, [new File(['payload'], 'fresh.txt')]);
  assert.equal(uploadDialog(view).findAllByType('select').length, 0, 'the native popup is the reported visual regression');
  const menu = policyMenu(view);
  assert.equal(menu.props.portal, true, 'the list must escape the dialog box and its scroll container');
  assert.equal(menu.props.autoFocus, true, 'the shared primitive must own keyboard focus once the list opens');
  assert.equal(menu.props.open, false, 'the list starts closed');
  const trigger = policyTrigger(view);
  assert.equal(trigger.props['aria-haspopup'], 'menu', 'the trigger must announce the popup it owns');
  assert.equal(trigger.props['aria-expanded'], false, 'a closed list must not claim to be expanded');
  await openPolicy(view);
  assert.equal(policyMenu(view).props.open, true, 'activating the trigger must open the shared list');
  assert.equal(policyTrigger(view).props['aria-expanded'], true);
});

// Remove the trigger's own keyboard open (the ArrowDown branch) → fails.
test('ArrowDown opens the upload policy menu and Escape closes only that menu', async t => {
  const view = await setup(t, { transfers: true });
  await openUpload(view, [new File(['payload'], 'fresh.txt')]);
  const trigger = policyTrigger(view);
  assert.equal(typeof trigger.props.onKeyDown, 'function', 'the trigger must open the list from the keyboard');
  let prevented = false;
  act(() => trigger.props.onKeyDown({ key: 'ArrowDown', preventDefault() { prevented = true; } }));
  assert.equal(prevented, true, 'the arrow key belongs to the trigger, it must not scroll the dialog');
  assert.equal(policyMenu(view).props.open, true);

  // The event target is an explicit DOM boundary. This verifies our event and
  // state ownership, not browser focus geometry or the primitive's arrow walk.
  const content = captureOwner(view);
  let stopped = false;
  act(() => content.props.onKeyDownCapture({
    key: 'Escape', preventDefault() {}, stopPropagation() { stopped = true; },
    currentTarget: { querySelector() { return null; } },
  }));
  assert.equal(stopped, true, 'Escape must not bubble to the enclosing Modal');
  assert.equal(policyMenu(view).props.open, false, 'Escape closes the list first');
  assert.ok(uploadDialog(view), 'closing the list must not close the upload review');
  assert.deepEqual(beginRequests(view), [], 'Escape must never submit the upload');
});

// Remove the focus restoration after Escape (leave the list closed but the
// focus nowhere) → fails.
test('Escape returns focus to the upload policy trigger it came from', async t => {
  const view = await setup(t, { transfers: true });
  await openUpload(view, [new File(['payload'], 'fresh.txt')]);
  await openPolicy(view);
  const queried = [];
  let focused = 0;
  act(() => captureOwner(view).props.onKeyDownCapture({
    key: 'Escape', preventDefault() {}, stopPropagation() {},
    currentTarget: { querySelector(selector) { queried.push(selector); return { focus() { focused += 1; } }; } },
  }));
  assert.ok(queried.length > 0, 'Escape must look up the control the list belongs to');
  assert.equal(queried[0].includes('data-fm-upload-policy'), true, 'focus must return to the policy control, not to an unrelated node');
  assert.equal(focused, 1, 'Escape must restore focus to the trigger');
  assert.equal(policyMenu(view).props.open, false);
});

// Remove the trigger's own focus or open colour rules, or add a ring, a border
// layer or a border-colour swap to any trigger rule → fails.
test('the upload policy trigger draws no outer outline, shadow or second ring in any state', async t => {
  const view = await setup(t, { transfers: true });
  const rules = rulesFor(shippedCss(view), 'fm-upload-policy-trigger');
  assert.ok(rules.length > 0, 'the shipped stylesheet must own the upload trigger instead of leaving its ring to the primitive default');
  for (const rule of rules) {
    const outline = rule.declarations.get('outline');
    if (outline !== undefined) assert.equal(outline, 'none', `${rule.selector} must not draw an outer outline`);
    const shadow = rule.declarations.get('box-shadow');
    if (shadow !== undefined) assert.equal(shadow, 'none', `${rule.selector} must not draw an outer shadow`);
    // The trigger is borderless, so a declared border layer is the "double
    // border" the report was about — it must never be drawn.
    for (const property of ['border', 'border-width', 'border-style']) {
      const value = rule.declarations.get(property);
      if (value !== undefined) assert.equal(['none', '0'].includes(value), true, `${rule.selector} must not draw a border layer (${property}:${value})`);
    }
    const borderColor = rule.declarations.get('border-color');
    assert.equal(borderColor, undefined, `${rule.selector} must not swap a border colour in place of a background/text hint`);
  }
  const focus = rules.filter(rule => /:focus(-visible)?\b/.test(rule.selector));
  assert.ok(focus.length > 0, 'the trigger must own its focus appearance, otherwise the primitive ring reappears on top of it');
  assert.equal(declares(focus, 'outline', 'none'), true, 'focus must suppress the ring rather than add a second one');
  assert.equal(themedHint(focus), true, 'focus must be shown by a host-theme background or text colour');
  assert.equal(declaresHintToken(focus), true, 'focus must use the theme overlay the real page measured as a change of the effective surface');
  const open = rules.filter(rule => rule.selector.includes('aria-expanded'));
  assert.ok(open.length > 0, 'the expanded state must keep a themed hint of its own');
  assert.equal(themedHint(open), true, 'the expanded state must be shown by a host-theme background or text colour, not by a border colour');
  assert.equal(declaresHintToken(open), true, 'the expanded state must use that same measured theme overlay');
});

// Change only this dialog's footer size, or leave another dialog on md → fails.
test('only the upload review footer uses the medium action size', async t => {
  const view = await setup(t, { transfers: true, tasks: true });
  await openUpload(view, [new File(['payload'], 'fresh.txt')]);
  const buttons = uploadDialog(view).findAllByType(uiBoundary.Button);
  const confirm = buttons.find(button => button.props['data-fm-action'] === 'upload-confirm');
  assert.ok(confirm, 'the upload review must offer its submit action');
  assert.equal(confirm.props.size, 'md', 'the upload submit is the 36px action');
  const cancel = buttons.find(button => textOf(button) === '取消');
  assert.ok(cancel, 'the upload review must offer Cancel');
  assert.equal(cancel.props.size, 'md', 'Cancel matches the upload submit');

  await act(async () => { await cancel.props.onClick(); await view.settle(); });
  await view.openHello();
  await view.click({ 'data-fm-action': 'copy' });
  await view.click({ 'data-fm-action': 'paste' });
  const paste = node(view.renderer, { role: 'dialog', 'aria-label': '核对粘贴操作' });
  const pasteButtons = paste.findAllByType(uiBoundary.Button);
  const pasteConfirm = pasteButtons.find(button => button.props['data-fm-action'] === 'paste-confirm');
  assert.ok(pasteConfirm, 'the paste review must offer its submit action');
  assert.equal(pasteConfirm.props.size, 'sm', 'the upload sizing change must not leak into the paste dialog');
  assert.equal(pasteButtons.find(button => textOf(button) === '取消')?.props.size, 'sm', 'other dialogs keep their default size');
});

// Flatten the row (drop the review item's column layout or the filename's
// shrink guard) → fails.
test('the upload review stacks the filename, the policy label, its control and the rename field', async t => {
  const view = await setup(t, { transfers: true });
  await openUpload(view, [new File(['payload'], 'a-very-long-upload-name.txt')]);
  await openPolicy(view);
  await view.click({ role: 'menuitem', 'data-menu-item': 'rename' });
  const item = classNode(view.renderer.root, 'fm-upload-item');
  const row = hostNodes(item);
  assert.equal(textOf(classNode(item, 'fm-upload-filename')), 'a-very-long-upload-name.txt', 'the row shows the file name it reviews');
  // `fm-upload-label` is the row's label class and may also carry the rename
  // field's label, so the policy label is taken by position: it is the label
  // that sits ahead of the policy control in document order.
  const order = [
    row.findIndex(hasClass('fm-upload-filename')),
    row.findIndex(hasClass('fm-upload-label')),
    row.findIndex(hasClass('fm-upload-policy-trigger')),
    row.findIndex(candidate => candidate.props['data-fm-upload-name'] === 0),
  ];
  assert.equal(order.every(index => index >= 0), true, `filename, label, control and rename field must all be rendered, got ${JSON.stringify(order)}`);
  assert.equal(order.every((index, position) => position === 0 || index > order[position - 1]), true,
    `filename, label, control and rename field must stack in that order, got ${JSON.stringify(order)}`);
  assert.ok(order[1] < order[2], 'the policy label must sit with the control it names');
  const { zh } = await loadClientModule('i18n');
  assert.equal(Object.values(zh).includes(textOf(row[order[1]])), true, 'the policy control needs a visible label in the shipped wording');
});

// Drop the column/min-width declarations (let a long name stretch the dialog)
// → fails.
test('the shipped stylesheet keeps the upload review column narrow-safe', async t => {
  const view = await setup(t, { transfers: true });
  const css = shippedCss(view);
  const item = rulesFor(css, 'fm-upload-item');
  assert.ok(item.length > 0, 'the review row must have its own layout rule');
  assert.equal(declares(item, 'display', 'flex'), true, 'the row is a flex container');
  assert.equal(declares(item, 'flex-direction', 'column'), true, 'filename, label and control stack vertically');
  assert.equal(declares(item, 'min-width', '0'), true, 'the row must be allowed to shrink inside the dialog');
  const name = rulesFor(css, 'fm-upload-filename');
  assert.ok(name.length > 0, 'the file name must have its own rule');
  assert.equal(declares(name, 'min-width', '0'), true, 'a long name must not widen its column');
  assert.equal(
    declares(name, 'overflow-wrap', 'anywhere') || (declares(name, 'overflow', 'hidden') && declares(name, 'text-overflow', 'ellipsis')),
    true, 'a long name must wrap or ellipsize instead of widening the dialog');
  const trigger = rulesFor(css, 'fm-upload-policy-trigger');
  assert.equal(declares(trigger, 'width', '100%'), true, 'the control fills the row it was given');
  assert.equal(declares(trigger, 'min-width', '0'), true, 'the control follows the row width, it does not define it');
});

// Cap the card at the host box, or break the shrink chain down to the review
// body → the card grows past a short viewport again and fails.
test('the upload card and its shrink chain are capped so only the review body scrolls', async t => {
  const view = await setup(t, { transfers: true });
  await openUpload(view, [new File(['payload'], 'fresh.txt')]);

  // Two distinct hooks: the real Modal puts `className` on the card and
  // `contentClassName` on the header/description/body wrapper, with the footer
  // outside that wrapper. One class cannot scope both.
  const card = node(view.renderer, { role: 'dialog', 'aria-label': '核对上传内容' });
  assert.equal(classList(card.props.className).includes('fm-upload-dialog'), true,
    'the card needs its own scope, otherwise the height cap has nothing to attach to');
  const wrapper = classNode(view.renderer.root, 'fm-upload-dialog-content');
  assert.equal(classList(wrapper.props.className).includes('dsh-fm-dialog'), true,
    'the wrapper keeps the dialog styling scope');

  const css = shippedCss(view);
  const dialog = exactRule(css, '.fm-upload-dialog');
  assert.ok(dialog.length > 0, 'the card must carry its own height rule');
  assert.equal(declares(dialog, 'max-height', '100%'), true, 'the card is capped by the host padding box, not by its content');
  assert.equal(declares(dialog, 'min-height', '0'), true, 'the card must be allowed to shrink below its content');
  const content = rulesFor(css, 'fm-upload-content');
  assert.equal(declares(content, 'overflow-y', 'auto'), true, 'only the review body scrolls');
  assert.equal(declares(content, 'min-height', '0'), true, 'the scroll region itself must be shrinkable');
  assert.equal(declares(content, 'max-height', /./), true, 'the review body keeps a height cap of its own');
  assert.equal(declares(exactRule(css, '.dsh-fm-dialog.fm-upload-dialog-content'), 'min-height', '0'), true,
    'the wrapper joins the shrink chain');
  assert.equal(declares(exactRule(css, '.dsh-fm-dialog.fm-upload-dialog-content>*'), 'min-height', '0'), true,
    'the body between the wrapper and the review content must be allowed to shrink');

  const footer = exactRule(css, '.fm-upload-dialog .fm-upload-actions>button');
  assert.ok(footer.length > 0, 'the footer sits outside the content wrapper, so its guarantee is scoped by the card');
  assert.equal(declares(footer, 'min-height', '36px'), true, 'the footer keeps the standard action height');
  assert.equal(exactRule(css, '.dsh-fm-dialog .fm-upload-actions>button').length, 0,
    'the content-wrapper scope can never reach the footer; a guarantee written there is dead');
});

// ---------------------------------------------------------------------------
// Conflict policies.
// ---------------------------------------------------------------------------

// Offer overwrite (or drop the not-found state) for a name that does not exist
// in the destination → fails.
test('a new upload name offers the error policy and never overwrite', async t => {
  const view = await setup(t, { transfers: true });
  await openUpload(view, [new File(['payload'], 'fresh.txt')]);
  const menu = policyMenu(view);
  assert.deepEqual(menu.props.items.map(item => item.id), ['error', 'skip', 'rename'],
    'the destination has no such name, so the review starts from the explicit error policy');
  assert.equal(menu.props.selectedId, 'error');
  assert.equal(menu.props.items.some(item => item.id === 'overwrite'), false, 'there is no target to overwrite');
});

// Drop the file-over-file condition, or drop overwrite entirely → fails.
test('an upload over an existing file offers overwrite', async t => {
  const view = await setup(t, { transfers: true, seed: root => writeFile(path.join(root, 'upload.txt'), 'original') });
  await openUpload(view, [new File(['incoming'], 'upload.txt')]);
  const menu = policyMenu(view);
  assert.deepEqual(menu.props.items.map(item => item.id), ['skip', 'rename', 'overwrite']);
  assert.equal(menu.props.selectedId, 'skip', 'an existing name defaults to the non-destructive policy');
});

// Drop the directory guard, or introduce a merge option → fails.
test('an upload onto an existing directory offers no merge and no overwrite', async t => {
  const view = await setup(t, { transfers: true, window: { showDirectoryPicker: async () => directory('folder') } });
  await view.click({ 'data-fm-action': 'upload-directory' });
  const menu = policyMenu(view);
  assert.deepEqual(menu.props.items.map(item => item.id), ['skip', 'rename'], 'an existing directory can only be skipped or renamed');
  assert.equal(menu.props.items.some(item => String(item.id).includes('merge') || String(item.label).includes('合并')), false,
    'directories are never merged');
});

// Drop the target-kind check (allow overwrite whenever the source is a file)
// → fails.
test('a file that collides with a directory never offers overwrite', async t => {
  const view = await setup(t, { transfers: true });
  await openUpload(view, [new File(['incoming'], 'folder')]);
  const menu = policyMenu(view);
  assert.deepEqual(menu.props.items.map(item => item.id), ['skip', 'rename'],
    'overwrite is a file-for-file policy; a directory target has no version to bind');
});

// ---------------------------------------------------------------------------
// Interaction semantics.
// ---------------------------------------------------------------------------

// Drop the busy guard on the trigger, the rename field or the submit → fails.
test('a busy upload disables the policy control, the rename field and the submit', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const view = await setup(t, {
    transfers: true,
    intercept: async (url, init, route) => {
      if (init?.body && String(init.body).includes('"op":"transfers.begin"')) await held;
      return route(url, init);
    },
  });
  t.after(() => release());
  await openUpload(view, [new File(['payload'], 'fresh.txt')]);
  await openPolicy(view);
  await view.click({ role: 'menuitem', 'data-menu-item': 'rename' });
  act(() => node(view.renderer, { 'data-fm-upload-name': 0 }).props.onChange({ target: { value: 'renamed.txt' } }));
  await act(async () => { confirmButton(view).props.onClick(); });

  assert.equal(beginRequests(view).length, 1, 'the review must submit exactly one begin request');
  assert.equal(policyTrigger(view).props.disabled, true, 'busy must not allow another policy change');
  assert.equal(node(view.renderer, { 'data-fm-upload-name': 0 }).props.disabled, true, 'busy must not accept a rename');
  assert.equal(confirmButton(view).props.disabled, true, 'busy must not allow a second submit');

  act(() => policyMenu(view).props.onSelect('skip'));
  assert.equal(policyMenu(view).props.selectedId, 'rename', 'a selection delivered while busy must not change the reviewed policy');
  assert.equal(nodes(view.renderer, { 'data-fm-upload-name': 0 }).length, 1, 'the rename field stays for the retry');
});

// Let the settled request reopen the list it opened before, or reissue the begin
// → fails. This protects the behaviour the shipped implementation already has:
// it is a regression guard, not a new requirement.
test('a busy upload closes the policy list and never reopens or resubmits after a failed begin', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const view = await setup(t, {
    transfers: true,
    intercept: async (url, init, route) => {
      if (init?.body && String(init.body).includes('"op":"transfers.begin"')) {
        await held;
        // An explicit failure: the review must stay open for a retry instead of
        // closing as it would on an accepted begin.
        return new Response(JSON.stringify({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Injected begin failure.' } }), {
          status: 400, headers: { 'content-type': 'application/json' },
        });
      }
      return route(url, init);
    },
  });
  await openUpload(view, [new File(['payload'], 'fresh.txt')]);
  await openPolicy(view);
  await view.click({ role: 'menuitem', 'data-menu-item': 'skip' });
  await openPolicy(view);
  assert.equal(policyMenu(view).props.open, true, 'the list is open when the review is submitted');
  assert.equal(policyMenu(view).props.selectedId, 'skip', 'the row keeps the policy the user reviewed');

  await act(async () => { confirmButton(view).props.onClick(); });
  assert.equal(beginRequests(view).length, 1, 'the review submits one begin request');
  assert.equal(policyMenu(view).props.open, false, 'busy closes the list the trigger owns');
  assert.equal(policyTrigger(view).props.disabled, true, 'busy disables the policy control');

  await act(async () => { release(); await view.settle(); });
  assert.equal(uploadDialog(view).findAll(candidate => candidate.props?.role === 'alert').length, 1, 'the failed begin is reported inside the review');
  assert.ok(uploadDialog(view), 'a failed begin keeps the review open for a retry');
  assert.equal(policyMenu(view).props.open, false, 'the list must not reopen by itself once the request settles');
  assert.equal(policyMenu(view).props.selectedId, 'skip', 'the reviewed policy survives the failed begin');
  assert.equal(policyTrigger(view).props.disabled, false, 'the control is usable again after the failure');
  assert.equal(beginRequests(view).length, 1, 'a failed begin must not be reissued on its own');
  assert.deepEqual(await view.transfers.list(), [], 'the failed begin created no transfer');
});

// Make selecting a policy submit, or leave the list open behind the row → fails.
test('choosing a policy updates the row, closes the list and starts nothing', async t => {
  const view = await setup(t, { transfers: true });
  await openUpload(view, [new File(['payload'], 'fresh.txt')]);
  await openPolicy(view);
  await view.click({ role: 'menuitem', 'data-menu-item': 'rename' });
  assert.equal(policyMenu(view).props.open, false, 'the list closes on selection');
  assert.equal(policyMenu(view).props.selectedId, 'rename', 'the row owns the reviewed policy');
  assert.equal(textOf(policyTrigger(view)), '改名', 'the trigger shows the reviewed policy');
  assert.equal(nodes(view.renderer, { 'data-fm-upload-name': 0 }).length, 1, 'renaming reveals the name field');
  assert.deepEqual(await view.transfers.list(), [], 'choosing a policy must not start the upload');
  assert.deepEqual(beginRequests(view), []);

  await openPolicy(view);
  await view.click({ role: 'menuitem', 'data-menu-item': 'skip' });
  assert.equal(policyMenu(view).props.open, false);
  assert.equal(nodes(view.renderer, { 'data-fm-upload-name': 0 }).length, 0, 'leaving rename drops the name field');
  assert.deepEqual(await view.transfers.list(), []);
});

// Drop the owned list state (let onClose dismiss the review) → fails.
test('dismissing the upload policy list keeps the review and its policy', async t => {
  const view = await setup(t, { transfers: true });
  await openUpload(view, [new File(['payload'], 'fresh.txt')]);
  await openPolicy(view);
  act(() => policyMenu(view).props.onClose());
  assert.equal(policyMenu(view).props.open, false);
  assert.equal(policyMenu(view).props.selectedId, 'error');
  assert.ok(uploadDialog(view), 'dismissing the popup must not close the upload review');
  assert.deepEqual(beginRequests(view), []);
});
