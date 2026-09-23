#!/usr/bin/env node
/**
 * Build the shipped artifacts from `src/`:
 *  - Host ESM + declarations: `tsc -p tsconfig.host.json` -> `dist/`
 *  - Client module: esbuild bundle of `src/client/index.tsx` -> `dist/client.js`,
 *    wrapped in the `window.__ModuleLoader__.load(...)` contract the harness reads.
 *
 * The package identity and version come from `package.json`; nothing here is
 * hand-maintained, so the Client module id can never drift from the package name.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist');
const tsc = path.join(root, 'node_modules', '.bin', 'tsc');

const CLIENT_ENTRY = path.join(root, 'src', 'client', 'index.tsx');
const CLIENT_OUT = path.join(dist, 'client.js');

/** Runtime modules the browser module table already provides; never bundled. */
const EXTERNALS = ['react', 'react/jsx-runtime', ...(manifest.dsh?.client?.external ?? [])];

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

function fail(message) {
  process.stderr.write(`build: ${message}\n`);
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// The Host half is real ESM JavaScript; Node never strips types from node_modules.
run(tsc, ['-p', 'tsconfig.host.json']);
if (!existsSync(path.join(dist, 'index.js'))) {
  fail('tsc did not emit dist/index.js (src/index.ts is the Host entry)');
}

// The Client half is type-checked separately (DOM lib, JSX, no emit).
run(tsc, ['-p', 'tsconfig.client.json']);

if (!existsSync(CLIENT_ENTRY)) {
  fail('src/client/index.tsx is missing; the Client module cannot be bundled');
}
await build({
  entryPoints: [CLIENT_ENTRY],
  outfile: CLIENT_OUT,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: EXTERNALS,
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'warning',
  // The Client reports its version from package metadata, so the panel can never
  // display a version that disagrees with the package it was built from.
  define: { __FM_VERSION__: JSON.stringify(manifest.version) },
  banner: {
    js: [
      'window.__ModuleLoader__.load({',
      `\tid: ${JSON.stringify(manifest.name)},`,
      '\tfactory: (require) => {',
      '\t\tvar module = { exports: {} };',
      '\t\tvar exports = module.exports;',
      '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    ].join('\n'),
  },
  footer: {
    js: ['\t\treturn module.exports;', '\t}', '});'].join('\n'),
  },
});

const bundle = readFileSync(CLIENT_OUT, 'utf8');
if (!bundle.includes(`id: ${JSON.stringify(manifest.name)}`)) {
  fail(`dist/client.js does not register the Client module id ${manifest.name}`);
}
if (!bundle.includes('__ModuleLoader__')) fail('dist/client.js is not wrapped in the ModuleLoader contract');

const bytes = statSync(CLIENT_OUT).size;
process.stdout.write(`build: dist/ ready (host ESM + client module ${manifest.name}, ${bytes} bytes)\n`);
