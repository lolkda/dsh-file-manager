/**
 * Third-party licence obligations for the bundled Client.
 *
 * The Client bundle inlines its editor dependencies, and a bundle never carries the
 * dependency `LICENSE` files itself. The published tarball ships only the built
 * halves (no `node_modules`), so the obligations have to travel with the package: the
 * notices file must exist, must be part of `files`, must list every package the
 * bundle actually inlined with its version, and must reproduce each distinct licence
 * text in full.
 *
 * The expected package set is derived from the built bundle's own file path comments
 * rather than hard-coded, so adding a dependency cannot silently outgrow the notice.
 * These checks read the frozen artifact only; they never build or pack.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const at = relative => path.join(root, relative);
const manifest = JSON.parse(readFileSync(at('package.json'), 'utf8'));
const NOTICES = 'THIRD-PARTY-NOTICES.md';

/** The packages esbuild inlined, read from the bundle's own path comments. */
function bundledPackages() {
  const bundle = readFileSync(at('dist/client.js'), 'utf8');
  const names = new Set();
  for (const match of bundle.matchAll(/\/\/ node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//gu)) names.add(match[1]);
  return [...names].sort();
}

const normalize = text => text.replace(/\s+/gu, ' ').trim();

function installedPackage(name) {
  const manifestPath = at(path.join('node_modules', ...name.split('/'), 'package.json'));
  assert.ok(existsSync(manifestPath), `${name} must be installed for its licence to be checkable`);
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

const licenceTextOf = name => readFileSync(at(path.join('node_modules', ...name.split('/'), 'LICENSE')), 'utf8');

test('the published manifest ships the third-party notices', () => {
  assert.ok(manifest.files.includes(NOTICES), `${NOTICES} must be listed in package.json "files"`);
  assert.ok(existsSync(at(NOTICES)), `${NOTICES} must exist`);
});

test('every package inlined into the client bundle is listed with the installed version', () => {
  const notices = readFileSync(at(NOTICES), 'utf8');
  const names = bundledPackages();
  assert.ok(names.length > 0, 'the built bundle must carry the paths of the packages it inlined');
  for (const name of names) {
    const { version, license } = installedPackage(name);
    assert.equal(license, 'MIT', `${name} is expected to be MIT; different terms must be handled explicitly here`);
    assert.ok(notices.includes(`${name}@${version}`), `${name}@${version} must be listed in ${NOTICES}`);
  }
});

test('the notices reproduce every distinct licence text in full', () => {
  const notices = normalize(readFileSync(at(NOTICES), 'utf8'));
  const texts = new Map();
  for (const name of bundledPackages()) texts.set(normalize(licenceTextOf(name)), name);
  assert.ok(texts.size > 0, 'at least one licence text must be checked');
  for (const [text, example] of texts) {
    assert.ok(notices.includes(text), `the licence text shipped by ${example} must appear in full in ${NOTICES}`);
  }
});

test('the notices list nothing that is not bundled, and the project licence is unchanged', () => {
  const notices = readFileSync(at(NOTICES), 'utf8');
  assert.equal(manifest.license, 'UNLICENSED', 'this package itself stays UNLICENSED');
  const listed = new Set([...notices.matchAll(/^\s*-\s*`((?:@[^/\s`]+\/)?[^@\s`]+)@([^`\s]+)`/gmu)]
    .map(match => `${match[1]}@${match[2]}`));
  assert.ok(listed.size > 0, 'the notices must list name@version entries');
  const bundled = new Set(bundledPackages().map(name => `${name}@${installedPackage(name).version}`));
  for (const entry of listed) {
    assert.ok(bundled.has(entry), `${entry} is listed in ${NOTICES} but is not part of the bundled set`);
  }
});
