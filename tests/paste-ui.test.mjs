import assert from 'node:assert/strict';
import test from 'node:test';
import { act, node, nodes, setup, textOf, uiBoundary } from './client-harness.mjs';

// These regressions exercise the shipped Client and real task service through
// the existing dependency boundary. They are not browser/CSS screenshot tests.
// Reintroducing a native select, path/version disclosure, or forgetting to
// update/close the owned Menu state must make the relevant assertion fail.
async function openPaste(t) {
  const view = await setup(t, { tasks: true });
  await view.openHello();
  await view.click({ 'data-fm-action': 'copy' });
  await view.click({ 'data-fm-action': 'paste' });
  return view;
}

const pasteDialog = view => node(view.renderer, { role: 'dialog', 'aria-label': '核对粘贴操作' });
async function openPolicy(view) {
  const trigger = node(view.renderer, { 'data-fm-conflict-policy': 0 });
  assert.equal(trigger.type, 'button', 'the policy must use a themed button trigger, not a native select');
  return view.click({ 'data-fm-conflict-policy': 0 });
}
const policyMenu = view => {
  const menus = pasteDialog(view).findAllByType(uiBoundary.Menu);
  assert.equal(menus.length, 1, 'paste must compose the shared themed Menu');
  return menus[0];
};

test('paste policy uses a themed portal Menu rather than a native select popup', async t => {
  const view = await openPaste(t);
  assert.equal(pasteDialog(view).findAllByType('select').length, 0, 'the native popup is the reported visual regression');
  const menu = policyMenu(view);
  assert.equal(menu.props.portal, true, 'the list must escape the dialog scroll container');
  assert.equal(menu.props.autoFocus, true, 'the shared primitive must own keyboard focus on open');
  assert.equal(menu.props.open, false);
  assert.equal(menu.props.selectedId, 'skip');
  assert.deepEqual(menu.props.items.map(item => item.id), ['skip', 'rename', 'overwrite']);
  const trigger = node(view.renderer, { 'data-fm-conflict-policy': 0 });
  assert.equal(trigger.type, 'button');
  assert.equal(trigger.props['aria-haspopup'], 'menu');
  assert.equal(trigger.props['aria-expanded'], false);
  await openPolicy(view);
  assert.equal(policyMenu(view).props.open, true);
  assert.equal(node(view.renderer, { 'data-fm-conflict-policy': 0 }).props['aria-expanded'], true);
});

test('paste summary shows the filename without duplicated paths or version disclosures', async t => {
  const view = await openPaste(t);
  const dialog = pasteDialog(view);
  const text = textOf(dialog);
  assert.equal(text.includes('folder/hello.txt'), false, 'the modal must not echo root-relative source/destination paths');
  assert.equal(text.split('hello.txt').length - 1, 1, 'show the file name once');
  assert.equal(text.includes('绑定版本'), false);
  assert.equal(text.includes('目标版本'), false, 'do not ask the user to review a hidden token');
  assert.equal(dialog.findAllByType('details').length, 0);
  assert.equal(dialog.findAllByType('code').length, 0);
  assert.equal(text.includes('重名处理'), true);
});

test('choosing Rename updates the policy and reveals the themed name field without starting a task', async t => {
  const view = await openPaste(t);
  await openPolicy(view);
  await view.click({ role: 'menuitem', 'data-menu-item': 'rename' });
  assert.equal(policyMenu(view).props.open, false);
  assert.equal(policyMenu(view).props.selectedId, 'rename');
  assert.equal(textOf(node(view.renderer, { 'data-fm-conflict-policy': 0 })), '改名');
  assert.equal(nodes(view.renderer, { 'data-fm-paste-name': 0 }).length, 1);
  assert.equal(pasteDialog(view).findAllByType(uiBoundary.Input).length, 1);
  assert.deepEqual(await view.tasks.list(), []);
  await openPolicy(view);
  await view.click({ role: 'menuitem', 'data-menu-item': 'skip' });
  assert.equal(nodes(view.renderer, { 'data-fm-paste-name': 0 }).length, 0);
});

test('dismissing the policy menu retains the paste dialog and its selected policy', async t => {
  const view = await openPaste(t);
  await openPolicy(view);
  act(() => policyMenu(view).props.onClose());
  assert.equal(policyMenu(view).props.open, false);
  assert.equal(policyMenu(view).props.selectedId, 'skip');
  assert.ok(pasteDialog(view));
  assert.deepEqual(await view.tasks.list(), []);
});

test('ArrowDown opens the paste policy menu and Escape closes only that menu', async t => {
  const view = await openPaste(t);
  const trigger = node(view.renderer, { 'data-fm-conflict-policy': 0 });
  assert.equal(typeof trigger.props.onKeyDown, 'function');
  let prevented = false;
  act(() => trigger.props.onKeyDown({ key: 'ArrowDown', preventDefault() { prevented = true; } }));
  assert.equal(prevented, true);
  assert.equal(policyMenu(view).props.open, true);
  const content = node(view.renderer, { className: 'fm-dialog-content fm-paste-content' });
  let stopped = false;
  // The event target is an explicit DOM boundary. This verifies our event/state
  // ownership, not browser focus geometry or the primitive's own arrow walk.
  act(() => content.props.onKeyDownCapture({
    key: 'Escape', preventDefault() {}, stopPropagation() { stopped = true; },
    currentTarget: { querySelector() { return null; } },
  }));
  assert.equal(stopped, true, 'Escape must not bubble to the enclosing Modal');
  assert.equal(policyMenu(view).props.open, false);
  assert.ok(pasteDialog(view));
});

// Reusing the popup must not make a plain button submit or change a policy just
// because it gained focus; submission remains the existing explicit action.
test('opening and closing the paste policy menu never submits the task', async t => {
  const view = await openPaste(t);
  await openPolicy(view);
  assert.equal(node(view.renderer, { 'data-fm-conflict-policy': 0 }).props.type, 'button');
  act(() => policyMenu(view).props.onClose());
  assert.equal(view.requests.some(item => item.init.body && JSON.parse(item.init.body).op === 'tasks.start'), false);
  assert.deepEqual(await view.tasks.list(), []);
});
