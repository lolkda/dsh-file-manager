import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const base = new URL('../', import.meta.url);

test('the npm package identity is consistent across every declaration', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', base), 'utf8'));
  const patch = await readFile(new URL('cordis.patch.yml', base), 'utf8');
  const client = await readFile(new URL('client.js', base), 'utf8');
  const installed = patch.match(/name:\s*'([^']+)'/)?.[1];
  const clientId = client.match(/id:\s*'([^']+)'/)?.[1];
  assert.equal(manifest.name, '@lolkda/dsh-file-manager');
  assert.equal(installed, manifest.name, 'the bundle patch must install the package it ships in');
  assert.equal(clientId, manifest.name, 'the Client module id must match the installed package name');
});

test('renaming the package must not touch the kebab-case runtime namespace or unit id', async () => {
  const patch = await readFile(new URL('cordis.patch.yml', base), 'utf8');
  const state = await readFile(new URL('host/state.js', base), 'utf8');
  const client = await readFile(new URL('client.js', base), 'utf8');
  assert.match(patch, /id: local-file-manager/);
  assert.match(state, /const NS = 'local-file-manager'/);
  assert.match(client, /const NS = 'local-file-manager'/);
});

test('the published tarball stays publishable and keeps every runtime entrypoint', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', base), 'utf8'));
  assert.notEqual(manifest.private, true, 'a private package cannot be published');
  assert.equal(manifest.license, 'UNLICENSED');
  for (const required of ['index.js', 'client.js', 'host', 'contracts', 'cordis.patch.yml']) {
    assert.ok(manifest.files.includes(required), `${required} must ship in the published tarball`);
  }
});