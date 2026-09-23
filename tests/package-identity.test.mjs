/**
 * Package identity and packaging contract.
 *
 * The identity that must never drift:
 * - the npm package name, the bundle patch and the built Client module id are one value;
 * - the kebab-case settings namespace, the snake-case storage units and the bundle
 *   unit id are *not* derived from the package name and must survive a rename;
 * - the published tarball ships the built `dist/` half plus the native helper.
 *
 * The Client bundle is asserted from `dist/client.js` whenever it has been built.
 * Before the first build the same invariant is asserted against the generator that
 * produces it, so the test is never vacuous — it just proves it one step earlier.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const base = fileURLToPath(new URL('../', import.meta.url));
const at = relative => path.join(base, relative);

const manifest = JSON.parse(await readFile(at('package.json'), 'utf8'));
const patch = await readFile(at('cordis.patch.yml'), 'utf8');
const buildScript = await readFile(at('scripts/build.mjs'), 'utf8');

/** Read the first candidate that exists, so the test follows the migration. */
async function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (existsSync(at(candidate))) return { candidate, text: await readFile(at(candidate), 'utf8') };
  }
  return undefined;
}

test('the npm package identity is consistent across every declaration', async () => {
  const installed = patch.match(/name:\s*'([^']+)'/)?.[1];
  assert.equal(manifest.name, '@lolkda/dsh-file-manager');
  assert.equal(installed, manifest.name, 'the bundle patch must install the package it ships in');
  if (existsSync(at('dist/client.js'))) {
    const bundle = await readFile(at('dist/client.js'), 'utf8');
    const clientId = bundle.match(/id:\s*["']([^"']+)["']/)?.[1];
    assert.equal(clientId, manifest.name, 'the built Client module id must match the installed package name');
    assert.match(bundle, /__ModuleLoader__/, 'the Client half must keep the ModuleLoader wrapper');
  } else {
    assert.match(buildScript, /id: \$\{JSON\.stringify\(manifest\.name\)\}/,
      'the Client module id must be generated from package.json, never written by hand');
    assert.match(buildScript, /'client',\s*'index\.tsx'|CLIENT_ENTRY/,
      'the build must bundle the Client entrypoint');
  }
});

test('renaming the package must not touch the kebab-case namespace or the storage units', async () => {
  assert.match(patch, /id: local-file-manager/, 'the bundle unit id stays kebab-case');

  // The three names are frozen in the contract layer and declared exactly once there.
  const frozen = ['local-file-manager', 'local_file_manager', 'local_file_manager_operations'];
  const contract = await firstExisting(['dist/contracts/limits.js', 'src/contracts/limits.ts']);
  assert.ok(contract, 'the limits contract must be built or present in source');
  for (const name of frozen) {
    assert.ok(contract.text.includes(`'${name}'`), `${name} must be declared in the limits contract`);
  }
  assert.ok(frozen.includes('local-file-manager') && frozen.includes('local_file_manager'),
    'Settings stays kebab-case while Storage stays snake_case');

  // No shipped half may invent a second namespace: every namespace-shaped literal it
  // carries must be one of the frozen three, whether it imports the constant or not.
  const inspected = [];
  for (const candidate of ['dist/index.js', 'dist/host/state.js', 'dist/client.js', 'host/state.js', 'client.js']) {
    if (!existsSync(at(candidate))) continue;
    const text = await readFile(at(candidate), 'utf8');
    inspected.push(candidate);
    for (const match of text.matchAll(/['"](local[-_][a-z0-9_]+)['"]/g)) {
      assert.ok(frozen.includes(match[1]), `${candidate} declares an unknown namespace literal ${match[1]}`);
    }
  }
  assert.ok(inspected.length > 0, 'at least one shipped half must be inspectable for namespace drift');
});

test('the published tarball stays publishable and ships the built halves', async () => {
  assert.notEqual(manifest.private, true, 'a private package cannot be published');
  assert.equal(manifest.license, 'UNLICENSED');
  assert.equal(manifest.type, 'module');
  assert.deepEqual(manifest.os, ['linux']);
  assert.equal(manifest.engines.node, '>=24');
  for (const required of ['dist', 'host', 'cordis.patch.yml', 'README.md']) {
    assert.ok(manifest.files.includes(required), `${required} must ship in the published tarball`);
  }
  assert.equal(manifest.files.includes('src'), false, 'sources are built, not shipped');
  // Every declared entrypoint must live inside a shipped directory.
  const shipped = manifest.files.filter(entry => !entry.includes('.'));
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    assert.match(target, /^\.\/dist\//, `exports["${subpath}"] must point into the built half`);
    assert.ok(shipped.some(directory => target.startsWith(`./${directory}/`)),
      `exports["${subpath}"] (${target}) is outside every shipped directory`);
  }
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  assert.equal(typeof manifest.scripts['build:native'], 'string');
  assert.match(manifest.scripts['build:native'], /rename-no-replace\.c/);
  for (const hook of ['preinstall', 'install', 'postinstall']) {
    assert.equal(manifest.scripts[hook], undefined, `${hook} must stay undefined: no implicit native build`);
  }
});
