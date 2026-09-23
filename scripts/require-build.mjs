#!/usr/bin/env node
/**
 * Fail `npm test` with an actionable message when the built artifacts are absent.
 *
 * Every suite imports the shipped implementation from `dist/`, so without a build
 * they die with `ERR_MODULE_NOT_FOUND` inside 20 files at once. This guard turns
 * that into one clear instruction. It deliberately does not build: `npm run check`
 * already builds, and silently rebuilding on every test run would hide a stale
 * artifact instead of surfacing it.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const required = ['dist/index.js', 'dist/client.js'];
const missing = required.filter(relative => !existsSync(path.join(root, relative)));

if (missing.length) {
  process.stderr.write(
    `pretest: ${missing.join(', ')} not found under dist/.\n`
    + 'pretest: the suites import the built implementation, so run `npm run build` first\n'
    + 'pretest: (or `npm run check`, which type-checks, builds and syntax-checks the artifacts).\n',
  );
  process.exit(1);
}
