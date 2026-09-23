import assert from 'node:assert/strict';
import test from 'node:test';
import { loadClientModule } from './client-module-loader.mjs';

const documents = () => loadClientModule('documents');

const snapshot = (text = 'base', version = 'v1', rootId = 'root', filename = 'file.txt') => ({
  rootId, path: filename, text, version, bytes: text.length, bom: false, newline: 'lf', encoding: 'utf-8', mode: 0o644,
});
const find = (store, id) => store.getSnapshot().documents.find(document => document.id === id);
const only = store => store.getSnapshot().documents[0];

test('document identity distinguishes equal relative paths under different roots', async () => {
  const { createDocumentStore } = await documents();
  const store = createDocumentStore();
  const first = store.open(snapshot('one', 'v1', 'a'));
  const second = store.open(snapshot('two', 'v2', 'b'));
  assert.notEqual(first, second);
  assert.equal(store.getSnapshot().documents.length, 2);
  assert.equal(store.getSnapshot().activeId, second);
});

test('refreshing a dirty document preserves its draft and exposes the newer disk version', async () => {
  const { createDocumentStore } = await documents();
  const store = createDocumentStore();
  const id = store.open(snapshot());
  store.edit(id, 'my draft');
  store.open(snapshot('external', 'v2'));
  assert.equal(find(store, id).draft, 'my draft');
  assert.equal(find(store, id).base.version, 'v1');
  assert.equal(find(store, id).external.version, 'v2');
  assert.equal(find(store, id).dirty, true);
});

test('a completed save cannot erase text typed while the request was in flight', async () => {
  const { createDocumentStore } = await documents();
  const store = createDocumentStore();
  const id = store.open(snapshot());
  store.edit(id, 'submitted');
  store.edit(id, 'newer typing');
  const { text, ...receipt } = snapshot('submitted', 'v2');
  store.saved(id, receipt, 'submitted');
  assert.equal(find(store, id).base.text, 'submitted');
  assert.equal(find(store, id).draft, 'newer typing');
  assert.equal(find(store, id).dirty, true);
});

test('closing an unsaved document requires an explicit discard decision', async () => {
  const { createDocumentStore } = await documents();
  const store = createDocumentStore();
  const id = store.open(snapshot());
  store.edit(id, 'unsaved');
  assert.equal(store.close(id), false);
  assert.equal(find(store, id).draft, 'unsaved');
  assert.equal(store.close(id, { discard: true }), true);
  assert.equal(store.getSnapshot().documents.length, 0);
});

test('detaching a view subscription leaves the root-owned draft available', async () => {
  const { createDocumentStore } = await documents();
  const store = createDocumentStore();
  const id = store.open(snapshot());
  let changes = 0;
  const unsubscribe = store.subscribe(() => { changes++; });
  store.edit(id, 'retained');
  unsubscribe();
  store.edit(id, 'still retained');
  assert.equal(changes, 1);
  assert.equal(find(store, id).draft, 'still retained');
});

test('rebasing a conflict updates the base only after an explicit action', async () => {
  const { createDocumentStore } = await documents();
  const store = createDocumentStore();
  const id = store.open(snapshot());
  store.edit(id, 'mine');
  store.conflict(id, snapshot('theirs', 'v2'));
  assert.equal(find(store, id).base.version, 'v1');
  store.rebase(id);
  assert.equal(find(store, id).base.version, 'v2');
  assert.equal(find(store, id).draft, 'mine');
  assert.equal(find(store, id).dirty, true);
  assert.equal(find(store, id).external, null);
});

test('marking a deleted path unavailable never recreates it or drops its draft', async () => {
  const { createDocumentStore } = await documents();
  const store = createDocumentStore();
  const id = store.open(snapshot('base', 'v1', 'a', 'folder/file'));
  const other = store.open(snapshot('other', 'v1', 'b', 'folder/file'));
  store.edit(id, 'keep me');
  store.markMissing('a', 'folder');
  assert.equal(find(store, id).missing, true);
  assert.equal(find(store, id).draft, 'keep me');
  assert.equal(find(store, other).missing, false);
});

test('a successful CRLF save resets dirty state without changing textarea line semantics', async () => {
  const { createDocumentStore } = await documents();
  const store = createDocumentStore();
  const id = store.open({ ...snapshot('old\r\n'), newline: 'crlf' });
  store.edit(id, 'new\n');
  const { text, ...receipt } = { ...snapshot('new\r\n', 'v2'), newline: 'crlf' };
  store.saved(id, receipt, 'new\n');
  assert.equal(find(store, id).base.text, 'new\r\n');
  assert.equal(find(store, id).draft, 'new\n');
  assert.equal(find(store, id).dirty, false);
});

test('a mixed-EOL save adopts the verified disk snapshot instead of inventing line endings', async () => {
  const { createDocumentStore } = await documents();
  const store = createDocumentStore();
  const id = store.open({ ...snapshot('one\r\ntwo\nthree\r'), newline: 'mixed' });
  store.edit(id, 'ONE\ntwo\nthree\n');
  const actual = { ...snapshot('ONE\r\ntwo\nthree\r', 'v2'), newline: 'mixed' };
  const { text, ...receipt } = actual;
  store.saved(id, receipt, 'ONE\ntwo\nthree\n', actual);
  assert.equal(find(store, id).base.text, actual.text);
  assert.equal(find(store, id).dirty, false);
});

test('a post-save snapshot from another version cannot clear a local draft', async () => {
  const { createDocumentStore } = await documents();
  const store = createDocumentStore();
  const id = store.open(snapshot());
  store.edit(id, 'mine');
  const { text, ...receipt } = snapshot('mine', 'v2');
  assert.throws(() => store.saved(id, receipt, 'mine', snapshot('external', 'v3')), { code: 'VERSION_CONFLICT' });
  assert.equal(find(store, id).base.version, 'v1');
  assert.equal(find(store, id).draft, 'mine');
  assert.equal(find(store, id).dirty, true);
});

test('a save receipt for a different path is rejected instead of rebinding the document', async () => {
  const { createDocumentStore } = await documents();
  const store = createDocumentStore();
  const id = store.open(snapshot());
  store.edit(id, 'mine');
  const { text, ...receipt } = snapshot('mine', 'v2', 'root', 'somewhere-else.txt');
  assert.throws(() => store.saved(id, receipt, 'mine'), { code: 'REFERENCE_MISMATCH' });
  assert.equal(find(store, id).path, 'file.txt');
  assert.equal(find(store, id).dirty, true);
});

test('background refresh preserves the active document while keeping another draft dirty', async () => {
  const { createDocumentStore } = await documents();
  const store = createDocumentStore();
  const first = store.open(snapshot('one', 'v1', 'root', 'first.txt'));
  store.edit(first, 'draft');
  const second = store.open(snapshot('two', 'v1', 'root', 'second.txt'));
  store.open(snapshot('external', 'v2', 'root', 'first.txt'), { activate: false });
  assert.equal(store.getSnapshot().activeId, second);
  assert.equal(find(store, first).draft, 'draft');
  assert.equal(find(store, first).external.text, 'external');
});

test('activating an existing tab never reloads its base or loses a conflict', async () => {
  const { createDocumentStore } = await documents();
  const store = createDocumentStore();
  const first = store.open(snapshot('one', 'v1', 'root', 'first.txt'));
  store.edit(first, 'draft');
  store.conflict(first, snapshot('external', 'v2', 'root', 'first.txt'));
  store.open(snapshot('two', 'v1', 'root', 'second.txt'));
  assert.equal(typeof store.activate, 'function', 'tabs need explicit activation without reopening stale snapshots');
  store.activate(first);
  assert.equal(store.getSnapshot().activeId, first);
  assert.equal(find(store, first).external.text, 'external');
});

test('renaming a document preserves its draft while adopting the new path and disk version', async () => {
  const { createDocumentStore } = await documents();
  const store = createDocumentStore();
  const id = store.open(snapshot());
  store.edit(id, 'unsaved');
  store.relocate(id, snapshot('base', 'v2', 'root', 'renamed.txt'));
  assert.equal(find(store, id).path, 'renamed.txt');
  assert.equal(find(store, id).base.version, 'v2');
  assert.equal(find(store, id).draft, 'unsaved');
  assert.equal(find(store, id).dirty, true);
});

test('an incomplete snapshot is refused instead of opening an unusable document', async () => {
  const { createDocumentStore } = await documents();
  const store = createDocumentStore();
  assert.throws(() => store.open({ rootId: 'root', path: 'file.txt', version: 'v1' }), { code: 'INVALID_SNAPSHOT' });
  assert.equal(store.getSnapshot().documents.length, 0);
});

test('the snapshot object is frozen so a view can never mutate root-owned state', async () => {
  const { createDocumentStore } = await documents();
  const store = createDocumentStore();
  const id = store.open(snapshot());
  const state = store.getSnapshot();
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.documents), true);
  assert.equal(Object.isFrozen(find(store, id)), true);
  assert.equal(Object.isFrozen(find(store, id).base), true);
});

test('a discarded save attempt cannot overwrite the state of a newer attempt', async () => {
  const { createDocumentStore } = await documents();
  const store = createDocumentStore();
  const id = store.open(snapshot());
  store.edit(id, 'first draft');
  const stale = store.beginSave(id);
  assert.equal(only(store).saving, true, 'starting a save must mark the document as saving');
  store.relocate(id, snapshot('base', 'v2', 'root', 'renamed.txt'));
  store.edit(id, 'second draft');
  const current = store.beginSave(id);
  assert.notEqual(current.attempt, stale.attempt, 'a replacement attempt needs its own identity');
  assert.equal(store.isSaveCurrent(stale), false);
  assert.equal(store.isSaveCurrent(current), true);

  const { text, ...staleReceipt } = snapshot('first draft', 'v3', 'root', 'file.txt');
  assert.equal(store.saved(stale, staleReceipt, 'first draft'), false, 'a late response from a replaced attempt must be dropped');
  store.saveSettled(stale);
  assert.equal(only(store).saving, true, 'a settled stale attempt must not clear the in-flight attempt');
  assert.equal(only(store).draft, 'second draft');

  store.saveSettled(current);
  assert.equal(only(store).saving, false);
});

test('typing while a save is in flight does not invalidate the attempt that owns the response', async () => {
  const { createDocumentStore } = await documents();
  const store = createDocumentStore();
  const id = store.open(snapshot());
  store.edit(id, 'submitted');
  const attempt = store.beginSave(id);
  store.edit(id, 'typed later');
  assert.equal(store.isSaveCurrent(attempt), true, 'an edit must not orphan the response of the save already in flight');
  const { text, ...receipt } = snapshot('submitted', 'v2');
  assert.equal(store.saved(attempt, receipt, 'submitted'), true);
  assert.equal(only(store).base.text, 'submitted');
  assert.equal(only(store).draft, 'typed later');
  assert.equal(only(store).dirty, true);
  assert.equal(only(store).saving, false, 'a completed save releases its saving flag');
});

test('a save attempt on a document that is already gone is refused', async () => {
  const { createDocumentStore } = await documents();
  const store = createDocumentStore();
  const id = store.open(snapshot());
  store.close(id, { discard: true });
  assert.throws(() => store.beginSave(id), { code: 'DOCUMENT_NOT_FOUND' });
  assert.throws(() => store.activate(id), { code: 'DOCUMENT_NOT_FOUND' });
});

test('a settled attempt for a closed document is a harmless no-op', async () => {
  const { createDocumentStore } = await documents();
  const store = createDocumentStore();
  const id = store.open(snapshot());
  const attempt = store.beginSave(id);
  store.saveSettled(attempt);
  assert.equal(only(store).saving, false);
  store.close(id, { discard: true });
  store.saveSettled(attempt);
  assert.equal(store.getSnapshot().documents.length, 0, 'a late settle must never recreate a removed document');
});

test('relocating onto another open document is refused', async () => {
  const { createDocumentStore } = await documents();
  const store = createDocumentStore();
  const first = store.open(snapshot('one', 'v1', 'root', 'first.txt'));
  const second = store.open(snapshot('two', 'v1', 'root', 'second.txt'));
  assert.throws(() => store.relocate(first, snapshot('one', 'v2', 'root', 'second.txt')), { code: 'DOCUMENT_CONFLICT' });
  assert.equal(find(store, first).path, 'first.txt');
  assert.equal(find(store, second).path, 'second.txt');
});