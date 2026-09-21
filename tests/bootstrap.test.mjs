import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const base = new URL('../', import.meta.url);

async function optionalModule(path) {
  try {
    return await import(new URL(path, base));
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === new URL(path, base).href) return undefined;
    throw error;
  }
}

test('bundle declares independently installable Host and Client entrypoints', async () => {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(new URL('package.json', base), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  assert.ok(manifest, 'the installable file-manager package is missing');
  assert.equal(manifest.name, '@local/dsh-file-manager');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.exports['.'], './index.js');
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
});

test('a new file manager has no root grants and requires no Session', async () => {
  const module = await optionalModule('host/manager.js');
  assert.equal(typeof module?.createManager, 'function', 'the Session-independent manager is missing');
  const manager = module.createManager();
  assert.deepEqual(await manager.listRoots(), []);
});

test('bundle patch installs a Host row without changing any Agent preset', async () => {
  let patch;
  try {
    patch = await readFile(new URL('cordis.patch.yml', base), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  assert.ok(patch, 'the installable bundle patch is missing');
  assert.match(patch, /- insert:/);
  assert.match(patch, /id: local-file-manager/);
  assert.match(patch, /name: '@local\/dsh-file-manager'/);
  assert.doesNotMatch(patch, /agent-presets|sandbox|permission|replace:|remove:/);
});

test('the wire version identifies the same release as the installed package', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', base), 'utf8'));
  const { createManager } = await optionalModule('host/manager.js');
  const { createControlHandler } = await optionalModule('index.js');
  const manager = createManager();
  const handler = createControlHandler({ manager, workspaces: () => [] });
  const response = await handler(new Request('http://localhost/api/file-manager/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'bootstrap' }) }));
  assert.equal((await response.json()).value.version, manifest.version);
  await manager.close();
});

test('native rebuilding is explicit and never runs as an installation hook', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', base), 'utf8'));
  assert.equal(typeof manifest.scripts['build:native'], 'string', 'the native helper needs a reproducible manual build command');
  assert.match(manifest.scripts['build:native'], /rename-no-replace\.c/);
  assert.equal(manifest.scripts.preinstall, undefined);
  assert.equal(manifest.scripts.install, undefined);
  assert.equal(manifest.scripts.postinstall, undefined);
});
