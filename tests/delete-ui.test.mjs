/**
 * Permanent deletion of a selected tree: the Client boundary.
 *
 * The subject is the shipped Client bundle against the real v2 Host (see
 * `client-harness.mjs`) plus the root-owned DocumentStore. Every deletion below
 * is a real filesystem deletion inside a temporary granted root: no test
 * replaces a Host result with a fabricated one, and a response is intercepted
 * only where a protocol boundary has to be observed.
 *
 * The contract these tests pin down:
 *   - `delete.prepare` answers with `scope: 'selected-trees'` and lists exactly
 *     the de-duplicated selected targets — never only their descendants, never
 *     fewer than the selection, never an extra descendant.
 *   - The Client refuses a plan whose scope is missing or different, and such a
 *     plan can never be committed.
 *   - `delete.commit` carries the same scope, so an older GUI that still means
 *     the older manifest semantics cannot authorize a recursive delete.
 *   - The confirmation says the selected directory *and everything inside it*
 *     (including content added or changed while the dialog was open) is deleted;
 *     it must not describe the deletion as limited to a server-prepared list.
 *   - After a deletion, only documents whose files really vanished become
 *     missing; drafts survive, saving a missing document stays impossible, and
 *     documents outside the deleted tree are untouched.
 */

import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { act, editorEdit, editorProps, node, nodes, setup, textOf, uiBoundary } from './client-harness.mjs';
import { loadClientModule } from './client-module-loader.mjs';

const ACK_LABEL = '我确认永久删除不可恢复';
const SELECT = name => `选择: ${name}`;
const reply = payload => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
const opOf = init => (init.body ? JSON.parse(init.body).op : null);
const commitRequests = view => view.requests.filter(item => opOf(item.init) === 'delete.commit');
const phase = (view, name) => nodes(view.renderer, { 'data-fm-delete-phase': name }).length;
const openDialog = view => view.renderer.root.findAllByType(uiBoundary.Modal).find(item => item.props.open);

/** Selects one entry of the current listing, the same way the checkbox does. */
const select = async (view, name) => {
  await act(async () => { node(view.renderer, { 'aria-label': SELECT(name) }).props.onChange({ target: { checked: true } }); });
};

/** Ticks the acknowledgement, which is the only gate besides the plan itself. */
const acknowledge = async view => {
  await act(async () => { node(view.renderer, { 'aria-label': ACK_LABEL }).props.onChange({ target: { checked: true } }); });
};

/** Activates an open document through its tab, so its rendered state can be read. */
const activateTab = async (view, relative) => {
  const tabs = view.renderer.root.findAll(item =>
    typeof item.type === 'string' && 'data-fm-tab' in item.props && String(item.props.title).endsWith(relative));
  assert.equal(tabs.length, 1, `exactly one open-document tab must match ${relative}`);
  await act(async () => { tabs[0].props.onClick(); await view.settle(); });
};

/**
 * Reads one real directory listing through the same v2 router the panel talks
 * to, and addresses every child with the parent's root (a listing entry carries
 * no root of its own).
 *
 * A `selected-trees` manifest describes only the selected targets, so a
 * malicious "descendant" entry cannot be taken from the manifest itself: it has
 * to be read from the real filesystem, and this is that real read — never a
 * guess about the older full-tree manifest.
 */
async function listDirectory(route, rootId, directory) {
  const response = await route('/api/file-manager/v2/control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'entries.list', rootId, path: directory }),
  });
  const payload = await response.json();
  assert.equal(payload.ok, true, `the fixture listing of ${directory} must succeed: ${JSON.stringify(payload)}`);
  return payload.value.entries.map(entry => ({
    rootId, path: entry.path, kind: entry.kind, size: entry.size, version: entry.version,
  }));
}

/** Every real child of the selected directories, for the malicious-plan fixtures. */
const realChildrenOf = async (route, targets) => {
  const children = [];
  for (const target of targets) children.push(...await listDirectory(route, target.rootId, target.path));
  return children;
};

/**
 * Rewrites a real `delete.prepare` response into the `selected-trees` contract
 * and records exactly what the Client received.
 *
 * The real Host response is the only source of plan ids, kinds and version
 * tokens; the rewrite only re-expresses *which* entries such a plan may list.
 * `scope` is added because the shipped Host predates the field. `mutate` — which
 * may be asynchronous, and which receives the raw `route` so it can read the
 * real filesystem — returns the entries to send instead, so each test changes
 * exactly one variable away from a valid plan. A `scope` of `null` means the
 * field is absent from the response entirely.
 */
function prepareBoundary(mutate = ({ targets }) => targets, { scope = 'selected-trees' } = {}) {
  const failures = [];
  const plans = [];
  return {
    failures,
    plans,
    intercept: async (url, init, route) => {
      const response = await route(url, init);
      if (opOf(init) !== 'delete.prepare') return response;
      const payload = await response.json();
      try {
        const value = payload.value;
        const byKey = new Map(value.entries.map(entry => [`${entry.rootId}\u0000${entry.path}`, entry]));
        const targets = value.targets.map(target => {
          const entry = byKey.get(`${target.rootId}\u0000${target.path}`);
          assert.ok(entry, `the real manifest must describe the selected target ${target.path}`);
          return entry;
        });
        // A `selected-trees` manifest lists the selected targets and nothing
        // else, so the boundary normalizes the response to that shape before
        // `mutate` sees it. Every fixture below is then independent of whatever
        // the older Host happened to enumerate: the only manifest-derived data
        // left is the target entries themselves, which both Hosts return.
        value.entries = targets.slice();
        value.entries = await mutate({
          value, targets, route,
          children: () => realChildrenOf(route, targets),
        });
        value.entryCount = value.entries.length;
        if (scope === null) delete value.scope;
        else value.scope = scope;
        plans.push(structuredClone(value));
      } catch (error) {
        failures.push(error);
        throw error;
      }
      return reply(payload);
    },
  };
}

/** The shape of the plan the Client actually received, for failure messages. */
const planShape = plan => ({
  scope: plan.scope,
  entryCount: plan.entryCount,
  entries: plan.entries.map(entry => entry.path),
  targets: plan.targets.map(target => target.path),
});

/** Asserts that the UI refused the plan and never sent a commit for it. */
const assertPlanRefused = async (view, plans) => {
  const seen = JSON.stringify(plans.map(planShape));
  assert.equal(phase(view, 'failed'), 1, `a plan the UI must not accept has to end the attempt as failed; the UI received ${seen}`);
  assert.equal(phase(view, 'ready'), 0, `the attempt must never reach the confirmable phase; the UI received ${seen}`);
  assert.equal(node(view.renderer, { 'data-fm-action': 'delete-confirm' }).props.disabled, true, 'confirm must stay disabled');
  assert.equal(node(view.renderer, { 'aria-label': ACK_LABEL }).props.disabled, true, 'the acknowledgement must stay disabled');
  await acknowledge(view);
  await view.click({ 'data-fm-action': 'delete-confirm' });
  assert.equal(commitRequests(view).length, 0, 'a refused plan must never be committed');
  await access(path.join(view.root, 'folder/hello.txt'));
};

/** A second selectable directory, so a plan can be asked to drop one selection. */
const withSecondFolder = async root => {
  await mkdir(path.join(root, 'folder2'));
  await writeFile(path.join(root, 'folder2', 'other.txt'), 'other\n');
};

/**
 * Proves this process cannot remove a file out of a directory it has no write
 * permission on. A process with CAP_DAC_OVERRIDE (root) can, and a real partial
 * failure cannot then be produced: the test says so instead of pretending.
 */
async function writePermissionEnforced() {
  const probe = await mkdtemp(path.join(tmpdir(), 'dsh-file-manager-perm-'));
  try {
    await mkdir(path.join(probe, 'locked'));
    await writeFile(path.join(probe, 'locked', 'file.txt'), 'x');
    await chmod(path.join(probe, 'locked'), 0o555);
    try {
      await rm(path.join(probe, 'locked', 'file.txt'));
      return false;
    } catch {
      return true;
    } finally {
      await chmod(path.join(probe, 'locked'), 0o755);
    }
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

test('the permanent deletion dialog states the selected directory and all of its contents are deleted', async t => {
  const view = await setup(t);
  await select(view, 'folder');
  await view.click({ 'data-fm-action': 'delete' });
  assert.equal(phase(view, 'ready'), 1, 'the real manifest must be reviewable before the wording is judged');
  const dialog = openDialog(view);
  assert.ok(dialog, 'the permanent deletion confirmation must be open');
  const text = textOf(dialog);
  assert.match(text, /全部内容/, 'the dialog must say the whole content of the selected directory is deleted, not only what a server list happened to name');
  assert.match(text, /(新增|新加)/, 'the dialog must say content added during the confirmation window is deleted too');
  assert.match(text, /修改/, 'the dialog must say content modified during the confirmation window is deleted too');
  assert.equal(text.includes('服务端清单'), false, 'the dialog must not describe the deletion as limited to the server-prepared manifest');
});

test('a prepare response without a scope cannot reach the confirmable phase or be committed', async t => {
  const boundary = prepareBoundary(undefined, { scope: null });
  const view = await setup(t, { intercept: boundary.intercept });
  await select(view, 'folder');
  await view.click({ 'data-fm-action': 'delete' });
  assert.deepEqual(boundary.failures, [], 'the protocol boundary must have been applied to the real response');
  assert.deepEqual(boundary.plans.map(planShape), [{ scope: undefined, entryCount: 1, entries: ['folder'], targets: ['folder'] }],
    'the UI must have received a valid selected-trees plan whose only defect is the missing scope');
  await assertPlanRefused(view, boundary.plans);
});

test('a prepare response declaring a different scope cannot reach the confirmable phase or be committed', async t => {
  const boundary = prepareBoundary(undefined, { scope: 'subtree-manifest' });
  const view = await setup(t, { intercept: boundary.intercept });
  await select(view, 'folder');
  await view.click({ 'data-fm-action': 'delete' });
  assert.deepEqual(boundary.failures, [], 'the protocol boundary must have been applied to the real response');
  assert.equal(boundary.plans[0].scope, 'subtree-manifest');
  await assertPlanRefused(view, boundary.plans);
});

test('a plan listing only descendants of the selection is refused', async t => {
  const boundary = prepareBoundary(async ({ children }) => children());
  const view = await setup(t, { intercept: boundary.intercept });
  await select(view, 'folder');
  await view.click({ 'data-fm-action': 'delete' });
  assert.deepEqual(boundary.failures, [], 'the protocol boundary must have been applied to the real response');
  assert.deepEqual(boundary.plans.map(planShape), [{ scope: 'selected-trees', entryCount: 1, entries: ['folder/hello.txt'], targets: ['folder'] }],
    'the UI must have received a plan whose entries omit the selected directory itself');
  await assertPlanRefused(view, boundary.plans);
});

test('a plan that omits one of the selected targets is refused', async t => {
  const boundary = prepareBoundary(({ targets }) => targets.slice(0, 1));
  const view = await setup(t, { intercept: boundary.intercept, seed: withSecondFolder });
  await select(view, 'folder');
  await select(view, 'folder2');
  await view.click({ 'data-fm-action': 'delete' });
  assert.deepEqual(boundary.failures, [], 'the protocol boundary must have been applied to the real response');
  assert.deepEqual(boundary.plans.map(planShape), [{ scope: 'selected-trees', entryCount: 1, entries: ['folder'], targets: ['folder', 'folder2'] }],
    'the UI must have received a plan that lists one of the two selected targets');
  await assertPlanRefused(view, boundary.plans);
  await access(path.join(view.root, 'folder2/other.txt'));
});

test('a plan that silently drops one selected item from both targets and entries is refused', async t => {
  const boundary = prepareBoundary(({ value, targets }) => {
    value.targets = value.targets.slice(0, 1);
    return targets.slice(0, 1);
  });
  const view = await setup(t, { intercept: boundary.intercept, seed: withSecondFolder });
  await select(view, 'folder');
  await select(view, 'folder2');
  await view.click({ 'data-fm-action': 'delete' });
  assert.deepEqual(boundary.failures, [], 'the protocol boundary must have been applied to the real response');
  assert.deepEqual(boundary.plans.map(planShape), [{ scope: 'selected-trees', entryCount: 1, entries: ['folder'], targets: ['folder'] }],
    'the UI must have received a plan that dropped one of the two selected items from its own target list as well');
  await assertPlanRefused(view, boundary.plans);
  await access(path.join(view.root, 'folder2/other.txt'));
});

test('a plan listing an extra descendant next to the selection is refused', async t => {
  const boundary = prepareBoundary(async ({ targets, children }) => [...targets, ...await children()]);
  const view = await setup(t, { intercept: boundary.intercept });
  await select(view, 'folder');
  await view.click({ 'data-fm-action': 'delete' });
  assert.deepEqual(boundary.failures, [], 'the protocol boundary must have been applied to the real response');
  assert.deepEqual(boundary.plans.map(planShape), [{ scope: 'selected-trees', entryCount: 2, entries: ['folder', 'folder/hello.txt'], targets: ['folder'] }],
    'the UI must have received a plan that lists the selected directory and one of its descendants');
  await assertPlanRefused(view, boundary.plans);
});

test('confirming a real directory deletion carries the selected-trees scope', async t => {
  const view = await setup(t);
  await select(view, 'folder');
  await view.click({ 'data-fm-action': 'delete' });
  assert.equal(phase(view, 'ready'), 1);
  await acknowledge(view);
  await view.click({ 'data-fm-action': 'delete-confirm' });
  await view.flush();
  const commits = commitRequests(view);
  assert.equal(commits.length, 1, 'the confirmed deletion must be submitted exactly once');
  assert.equal(JSON.parse(commits[0].init.body).scope, 'selected-trees', 'the commit must declare the selected-trees scope so the Host cannot apply the older manifest semantics');
  await assert.rejects(access(path.join(view.root, 'folder/hello.txt')), { code: 'ENOENT' });
});

test('a completed directory deletion invalidates its whole prefix while drafts and other trees survive', async t => {
  const view = await setup(t, {
    seed: async root => { await mkdir(path.join(root, 'other')); await writeFile(path.join(root, 'other/sibling.txt'), 'sibling\n'); },
  });
  await view.openHello();
  await view.click({ 'data-fm-action': 'edit' });
  editorEdit(view, '目录删除前的草稿');
  await view.click({ 'data-fm-root': true });
  await view.click({ 'data-fm-entry': 'directory', 'data-fm-path': 'other' });
  await view.click({ 'data-fm-entry': 'file', 'data-fm-path': 'other/sibling.txt' });
  await view.click({ 'data-fm-root': true });
  await select(view, 'folder');
  await view.click({ 'data-fm-action': 'delete' });
  assert.equal(phase(view, 'ready'), 1);
  await acknowledge(view);
  await view.click({ 'data-fm-action': 'delete-confirm' });
  await view.flush();

  await assert.rejects(access(path.join(view.root, 'folder/hello.txt')), { code: 'ENOENT' });
  await access(path.join(view.root, 'other/sibling.txt'));

  await activateTab(view, 'folder/hello.txt');
  assert.equal(nodes(view.renderer, { 'data-fm-missing': true }).length, 1, 'the document under the deleted directory must be reported missing');
  assert.equal(editorProps(view.renderer)?.value, '目录删除前的草稿', 'the unsaved draft of a deleted document must survive');
  assert.equal(node(view.renderer, { 'data-fm-action': 'save' }).props.disabled, true, 'a missing document must not be saveable');

  await activateTab(view, 'other/sibling.txt');
  assert.equal(nodes(view.renderer, { 'data-fm-missing': true }).length, 0, 'a document outside the deleted tree must not be reported missing');
  assert.equal(editorProps(view.renderer)?.value, 'sibling\n');
});

test('a partly failed directory deletion marks only the documents that really vanished', async t => {
  if (!(await writePermissionEnforced())) {
    t.skip('this process can bypass directory write permissions (root or CAP_DAC_OVERRIDE), so a real partial failure cannot be produced');
    return;
  }
  const commitResults = [];
  const keep = path.join('folder', 'keep');
  const view = await setup(t, {
    seed: async root => {
      await mkdir(path.join(root, keep));
      await writeFile(path.join(root, keep, 'locked.txt'), 'locked\n');
      await chmod(path.join(root, keep), 0o555);
    },
    intercept: async (url, init, route) => {
      const response = await route(url, init);
      if (opOf(init) !== 'delete.commit') return response;
      const payload = await response.json();
      commitResults.push(payload.value);
      return reply(payload);
    },
  });
  try {
    await view.openHello();
    await view.click({ 'data-fm-action': 'edit' });
    editorEdit(view, '会被删除的草稿');
    await view.click({ 'data-fm-root': true });
    await view.click({ 'data-fm-entry': 'directory', 'data-fm-path': 'folder' });
    await view.click({ 'data-fm-entry': 'directory', 'data-fm-path': 'folder/keep' });
    await view.click({ 'data-fm-entry': 'file', 'data-fm-path': 'folder/keep/locked.txt' });
    await view.click({ 'data-fm-action': 'edit' });
    editorEdit(view, '幸存的草稿');
    await view.click({ 'data-fm-root': true });
    await select(view, 'folder');
    await view.click({ 'data-fm-action': 'delete' });
    assert.equal(phase(view, 'ready'), 1);
    await acknowledge(view);
    await view.click({ 'data-fm-action': 'delete-confirm' });
    await view.flush();

    const observed = ` (Host commit result: ${JSON.stringify(commitResults)})`;
    await assert.rejects(access(path.join(view.root, 'folder/hello.txt')), { code: 'ENOENT' });
    await access(path.join(view.root, keep, 'locked.txt'));
    await access(path.join(view.root, keep));

    await activateTab(view, 'folder/hello.txt');
    assert.equal(nodes(view.renderer, { 'data-fm-missing': true }).length, 1, `the open document whose file really vanished must be reported missing${observed}`);
    assert.equal(editorProps(view.renderer)?.value, '会被删除的草稿', `the draft of a document that really vanished must survive${observed}`);
    assert.equal(node(view.renderer, { 'data-fm-action': 'save' }).props.disabled, true);

    await activateTab(view, 'folder/keep/locked.txt');
    assert.equal(nodes(view.renderer, { 'data-fm-missing': true }).length, 0, `an open document whose file survived a failed directory deletion must not be reported missing${observed}`);
    assert.equal(editorProps(view.renderer)?.value, '幸存的草稿', `a surviving document must keep its draft${observed}`);
    assert.equal(node(view.renderer, { 'data-fm-action': 'save' }).props.disabled, false, 'a surviving document must stay saveable');
  } finally {
    await chmod(path.join(view.root, keep), 0o755);
  }
});

test('a save receipt from before a deletion cannot resurrect the deleted document', async t => {
  const { createDocumentStore } = await loadClientModule('documents');
  const store = createDocumentStore();
  const snapshot = { rootId: 'root', path: 'folder/file.txt', text: 'base', version: 'v1', bytes: 4 };
  const id = store.open(snapshot);
  store.edit(id, '已提交的草稿');
  const attempt = store.beginSave(id);
  store.markMissing('root', 'folder');
  const missing = store.getSnapshot().documents.find(document => document.id === id);
  assert.equal(missing.missing, true, 'the deleted file must be marked missing before the receipt arrives');

  const receipt = { rootId: 'root', path: 'folder/file.txt', version: 'v2', bytes: 4 };
  assert.equal(store.saved(attempt, receipt, '已提交的草稿'), false, 'a receipt issued before the deletion must not be committed onto a missing document');

  const after = store.getSnapshot().documents.find(document => document.id === id);
  assert.equal(after.missing, true, 'a late receipt must not clear the missing mark');
  assert.equal(after.dirty, true, 'a late receipt must not clear the draft');
  assert.equal(after.draft, '已提交的草稿');
  assert.equal(after.base.version, 'v1', 'a late receipt must not replace the base version');
  assert.equal(after.base.text, 'base', 'a late receipt must not replace the base text');
});
