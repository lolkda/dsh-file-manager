import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { toDeleteCommitResult } from '../dist/contracts/views.js';
import { hostFixture } from './verify-harness.mjs';

// Removing the explicit scope gate would let an old GUI authorize a different
// deletion range than the one its confirmation text describes.
test('a legacy deletion commit without the selected-tree scope never deletes anything', async t => {
  const fixture = await hostFixture();
  t.after(fixture.close);
  await writeFile(path.join(fixture.directory, 'note'), 'keep');
  const prepared = await fixture.call('delete.prepare', { items: [fixture.ref('note')] });
  assert.equal(prepared.status, 200);

  const refused = await fixture.call('delete.commit', { planId: prepared.value.id, confirmed: true });
  assert.equal(refused.status, 400, 'a stale client must explicitly accept the new deletion scope before committing');
  assert.equal(refused.error.code, 'INVALID_REQUEST');
  assert.equal(await readFile(path.join(fixture.directory, 'note'), 'utf8'), 'keep');
});

// Returning a recursive manifest, or dropping its scope, makes this wire-level
// contract fail without relying on a timing threshold or a mocked filesystem.
test('the wire confirmation names only the selected tree and declares its recursive scope', async t => {
  const fixture = await hostFixture();
  t.after(fixture.close);
  await mkdir(path.join(fixture.directory, 'tree', 'nested'), { recursive: true });
  await writeFile(path.join(fixture.directory, 'tree', 'nested', 'note'), 'old');
  const prepared = await fixture.call('delete.prepare', { items: [fixture.ref('tree')] });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.value.scope, 'selected-trees');
  assert.equal(prepared.value.entryCount, 1);
  assert.deepEqual(prepared.value.entries.map(entry => entry.path), ['tree']);

  await writeFile(path.join(fixture.directory, 'tree', 'nested', 'new'), 'new');
  const deleted = await fixture.call('delete.commit', {
    planId: prepared.value.id, confirmed: true, scope: prepared.value.scope,
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.value.status, 'completed');
  assert.deepEqual(deleted.value.results.map(entry => entry.path), ['tree']);
  await assert.rejects(access(path.join(fixture.directory, 'tree')), { code: 'ENOENT' });
});

// A failed directory is not an untouched directory: the public receipt must
// retain this fact even when the selected directory itself could not be removed.
test('a partial tree deletion exposes changed contents without leaking private paths', () => {
  const result = toDeleteCommitResult({
    id: 'delete-plan', status: 'partial', results: [{
      rootId: 'root-1', path: 'tree', status: 'failed', removed: false, contentsChanged: true,
      error: { code: 'PERMISSION_DENIED', message: 'A child could not be removed.', details: { path: '/private/path' } },
      privateHandle: 42,
    }],
  });
  assert.deepEqual(result.results, [{
    rootId: 'root-1', path: 'tree', status: 'failed', removed: false, contentsChanged: true,
    error: { code: 'PERMISSION_DENIED', message: 'A child could not be removed.' },
  }]);
});
