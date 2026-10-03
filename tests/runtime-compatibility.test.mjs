import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const runtimeRoot = process.env.FILE_MANAGER_DSH_RUNTIME_ROOT ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh';
const runtimeAvailable = existsSync(path.join(runtimeRoot, 'package.json'));
const skipWithoutRuntime = runtimeAvailable ? false : `no DSH runtime at ${runtimeRoot}; set FILE_MANAGER_DSH_RUNTIME_ROOT`;

// Reintroducing a numeric peer constraint would reject an otherwise usable Host
// before apply() runs. Optional preserves the host relationship without installing
// a second CLI runtime as a dependency of this plugin.
test('the plugin does not constrain the DSH version or install its own Host', () => {
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh'], '*');
  assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh'].optional, true);
  assert.equal(manifest.dependencies['@deepseek-ai/dsh'], undefined);
  assert.deepEqual(lock.packages[''].peerDependencies, manifest.peerDependencies);
  assert.deepEqual(lock.packages[''].peerDependenciesMeta, manifest.peerDependenciesMeta);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
});

// Exercise the actual startup/install gate, not a reimplementation of SemVer.
// The synthetic future numbers prove admission only, NOT future API support.
test('the deployed DSH admits the shipped manifest without version exemptions', { skip: skipWithoutRuntime }, async () => {
  const require = createRequire(path.join(runtimeRoot, 'package.json'));
  const { evaluatePluginCompatibility } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
  assert.equal(typeof evaluatePluginCompatibility, 'function', 'the integration runtime must expose the new compatibility gate');
  assert.equal(evaluatePluginCompatibility(manifest, {}), undefined, 'the running DSH must not skip this bundle');
  for (const version of ['0.1.7-rc.1', '0.2.0-rc.2', '0.2.0', '0.2.1-rc.1', '1.0.0']) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, `manifest admission must not pin DSH ${version}`);
  }
  // A negative control proves the real checker is active and no exemption hides
  // the original rejection that prompted this change.
  const legacy = { ...manifest, peerDependencies: { '@deepseek-ai/dsh': '0.1.7-rc.1' } };
  const rejected = evaluatePluginCompatibility(legacy, {}, '0.2.0-rc.2');
  assert.deepEqual(rejected.peers, legacy.peerDependencies);
  assert.equal(rejected.exempted, false);
});
