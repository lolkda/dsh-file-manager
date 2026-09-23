import assert from 'node:assert/strict';
import test from 'node:test';
import { loadClientModule } from './client-module-loader.mjs';

const i18n = () => loadClientModule('i18n');
// The same fallback rule the Harness locale binding applies: a missing key
// resolves to the key itself, which is how a missing message is detected.
const translateWith = dictionary => (key, values) => {
  const text = dictionary[key] ?? key;
  return values ? text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? '')) : text;
};

test('both dictionaries expose the same complete set of messages', async () => {
  const { en, zh } = await i18n();
  const english = Object.keys(en).sort();
  const chinese = Object.keys(zh).sort();
  assert.deepEqual(chinese, english, 'a message that exists in one language must exist in the other');
  assert.ok(english.length > 100, 'the shipped catalog is the full legacy message set');
  for (const key of english) {
    assert.equal(typeof en[key], 'string');
    assert.notEqual(en[key], '', `${key} must have English text`);
    assert.notEqual(zh[key], '', `${key} must have Chinese text`);
  }
});

test('the plugin namespace stays the kebab-case runtime namespace', async () => {
  const { NS } = await i18n();
  assert.equal(NS, 'local-file-manager');
});

test('the messages the view depends on are all present', async () => {
  const { en, zh } = await i18n();
  const required = [
    'title', 'subtitle', 'roots', 'add', 'emptyRoots', 'selectFile', 'loading', 'empty', 'name', 'size', 'modified',
    'refresh', 'more', 'removeRoot', 'preview', 'special', 'note', 'notPersistent', 'edit', 'save', 'saving', 'saved',
    'dirty', 'close', 'cancel', 'editor', 'openDocuments', 'closeDocument', 'closeTitle', 'closeDescription', 'discard',
    'saveClose', 'external', 'compare', 'conflictTitle', 'conflictDescription', 'diskVersion', 'localDraft', 'rebase',
    'missing', 'readOnly', 'newFile', 'newDirectory', 'rename', 'applyName', 'select', 'selected', 'delete', 'deleteTitle',
    'deleteDescription', 'deleteAck', 'deleteConfirm', 'deleteEntries', 'expires', 'versions', 'deletePreparing',
    'deleteReady', 'deleteFailed', 'deleteCommitting', 'removeRootTitle', 'removeRootDescription', 'removeRootConfirm',
    'removeRootWorking', 'copy', 'cut', 'paste', 'copyTask', 'moveTask', 'pasteTitle', 'pasteDescription', 'clipboard',
    'skip', 'renameConflict', 'overwrite', 'pasteConfirm', 'tasks', 'refreshTasks', 'retry', 'cancelTask',
    'targetCommitted', 'closeTask', 'closeTaskHint', 'clearEndedTasks', 'collapseTasks', 'expandTasks', 'activeTasks',
    'historyFailures', 'uploadFiles', 'uploadDirectory', 'uploadTitle', 'uploadConfirm', 'uploadDescription',
    'directoryFallback', 'download', 'downloadTitle', 'downloadStart', 'downloadNote', 'serverFinished', 'uploadTask',
    'downloadTask', 'reference', 'referenceTitle', 'referenceDescription', 'referenceSession', 'referenceSelect',
    'referenceConfirm', 'referenceWaiting', 'referenceBusy', 'referenceStale', 'referenceTargetUnavailable',
    'referenceRetry', 'status.completed', 'status.failed', 'status.partial', 'status.queued', 'status.running',
    'status.pending', 'status.skipped', 'status.cancelled', 'status.interrupted',
  ];
  const errorCodes = [
    'INVALID_DELETE_PLAN', 'TASK_CHANGED', 'HISTORY_REVISION_EXHAUSTED', 'INVALID_HISTORY_RESULT', 'SOURCE_DELETE_FAILED',
    'INTERRUPTED', 'TASK_PERSISTENCE_FAILED', 'TASK_BUSY', 'UPLOAD_SOURCE_LOST', 'INCOMPLETE_UPLOAD',
    'UNREPRESENTABLE_REFERENCE', 'REFERENCE_TARGET_UNAVAILABLE', 'REFERENCE_BUSY', 'STRONG_VERSION_REQUIRED',
    'INVALID_PATH', 'ROOT_NOT_FOUND', 'ROOT_CHANGED', 'ROOT_UNAVAILABLE', 'NOT_FOUND', 'PERMISSION_DENIED',
    'UNSUPPORTED_ENTRY', 'UNSUPPORTED_ENCODING', 'TOO_LARGE', 'DIRECTORY_CHANGED', 'VERSION_CONFLICT', 'INVALID_REQUEST',
    'UNSUPPORTED_PLATFORM', 'UNSUPPORTED_LINE_ENDINGS', 'LINE_ENDING_MAPPING_LIMIT', 'IO_ERROR', 'TRANSPORT',
    'ALREADY_EXISTS', 'PLAN_EXPIRED', 'PLAN_NOT_FOUND', 'NO_SPACE', 'CANCELLED',
  ];
  for (const key of required) assert.ok(en[key] && zh[key], `${key} is missing from the catalog`);
  for (const code of errorCodes) assert.ok(en[`error.${code}`] && zh[`error.${code}`], `error.${code} is missing from the catalog`);
  assert.ok(en['watch.connecting'] && en['watch.watching'] && en['watch.polling'] && en['watch.unavailable'] && en['watch.disconnected'], 'watch statuses need messages');
});

test('a known failure code is rendered with its own message', async () => {
  const { zh, errorMessage } = await i18n();
  const t = translateWith(zh);
  assert.equal(errorMessage(t, { code: 'VERSION_CONFLICT' }), zh['error.VERSION_CONFLICT']);
  assert.equal(errorMessage(t, { code: 'TOO_LARGE' }), zh['error.TOO_LARGE']);
});

test('a user-initiated cancellation is never shown as an I/O failure', async () => {
  const { zh, en, errorMessage } = await i18n();
  const t = translateWith(zh);
  assert.equal(errorMessage(t, { name: 'AbortError', message: 'aborted' }), zh['error.CANCELLED']);
  assert.equal(errorMessage(t, { name: 'AbortError', code: 20 }), zh['error.CANCELLED'], 'the numeric DOMException code is a truthy number, not a failure code');
  assert.equal(errorMessage(t, { code: 20 }), zh['error.CANCELLED']);
  assert.equal(errorMessage(t, { code: 'CANCELLED' }), zh['error.CANCELLED']);
  assert.notEqual(errorMessage(t, { name: 'AbortError' }), zh['error.IO_ERROR']);
  assert.equal(errorMessage(translateWith(en), { name: 'AbortError' }), en['error.CANCELLED']);
});

test('an unknown or missing failure falls back to the I/O message', async () => {
  const { zh, errorMessage } = await i18n();
  const t = translateWith(zh);
  for (const failure of [undefined, null, 'boom', 42, {}, new Error('boom'), { code: 'NO_SUCH_CODE' }, { code: '' }, { code: 7 }]) {
    assert.equal(errorMessage(t, failure), zh['error.IO_ERROR'], `${JSON.stringify(failure)} must fall back to error.IO_ERROR`);
  }
});