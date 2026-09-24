#!/usr/bin/env node
/**
 * Pack the release snapshot and prove it is installable before anyone installs it.
 *
 * `npm pack` normally runs `prepublishOnly`, which re-runs the whole suite. This
 * script is the packaging gate that runs *after* the suite, so it packs with
 * `--ignore-scripts` and then asserts the tarball itself:
 *   - every runtime entrypoint the harness reads is present,
 *   - the Client module registers the package identity,
 *   - the compiled Host entry loads as ESM and reports the package version,
 *   - the native no-replace helper is shipped and executable.
 *
 * The verified tarball is copied to `artifacts/ts-refactor/` with its SHA-256, so
 * the snapshot that gets installed is exactly the snapshot that was verified.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const outDir = path.join(root, 'artifacts', 'ts-refactor');
const snapshot = path.join(outDir, `dsh-file-manager-${manifest.version}.tgz`);

function fail(message) {
  process.stderr.write(`pack-check: ${message}\n`);
  process.exit(1);
}

if (!existsSync(path.join(root, 'dist', 'index.js'))) fail('dist/index.js is missing; run npm run build first');
if (!existsSync(path.join(root, 'dist', 'client.js'))) fail('dist/client.js is missing; run npm run build first');
if (!existsSync(path.join(root, 'host', 'native', 'rename-no-replace'))) {
  fail('host/native/rename-no-replace is missing; run npm run build:native first');
}

mkdirSync(outDir, { recursive: true });
const packed = execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', outDir], {
  cwd: root,
  encoding: 'utf8',
}).trim().split('\n').pop();

const tarball = path.join(outDir, packed);
if (!existsSync(tarball)) fail(`npm pack did not produce ${packed}`);

const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n').filter(Boolean);
const required = [
  'package/package.json',
  'package/dist/index.js',
  'package/dist/client.js',
  'package/dist/host/scheduler.js',
  'package/cordis.patch.yml',
  'package/host/native/rename-no-replace',
  'package/host/native/rename-no-replace.c',
];
for (const entry of required) {
  if (!listing.includes(entry)) fail(`${packed} is missing ${entry}`);
}
for (const forbidden of ['package/src/', 'package/node_modules/', 'package/dist/client.js.map']) {
  if (listing.some(entry => entry.startsWith(forbidden))) fail(`${packed} unexpectedly ships ${forbidden}`);
}

// Unpack into a scratch directory and exercise the installed layout for real.
const scratch = path.join(root, 'artifacts', 'ts-refactor', 'unpacked');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
execFileSync('tar', ['-xzf', tarball, '-C', scratch], { encoding: 'utf8' });
const installed = path.join(scratch, 'package');

const client = readFileSync(path.join(installed, 'dist', 'client.js'), 'utf8');
if (!client.includes(`id: ${JSON.stringify(manifest.name)}`)) {
  fail(`the packed Client module does not register ${manifest.name}`);
}

const reported = execFileSync(process.execPath, [
  '--input-type=module',
  '-e',
  `const m = await import(${JSON.stringify(`file://${path.join(installed, 'dist', 'index.js')}`)}); process.stdout.write(String(m.VERSION));`,
], { encoding: 'utf8' });
if (reported !== manifest.version) {
  fail(`the packed Host entry reports version ${reported}, expected ${manifest.version}`);
}

const helper = path.join(installed, 'host', 'native', 'rename-no-replace');
const helperMode = statSync(helper).mode & 0o111;
if (!helperMode) fail('the packed native helper is not executable');

copyFileSync(tarball, snapshot);
const digest = createHash('sha256').update(readFileSync(snapshot)).digest('hex');
process.stdout.write(
  `pack-check: ${path.relative(root, snapshot)}\n`
  + `pack-check: ${listing.length} entries, client id and VERSION verified, native helper executable\n`
  + `pack-check: sha256 ${digest}\n`,
);
