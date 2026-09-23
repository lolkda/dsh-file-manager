#!/usr/bin/env node
/**
 * Syntax-check every shipped JavaScript artifact the same way `node --check`
 * did before the TypeScript port: the Host half must parse as ESM and the
 * Client half must parse as the browser module the harness reads verbatim.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

const targets = walk(dist).sort();
if (!targets.includes(path.join(dist, 'index.js'))) {
  process.stderr.write('check-dist: dist/index.js is missing; run the build first\n');
  process.exit(1);
}
if (!targets.includes(path.join(dist, 'client.js'))) {
  process.stderr.write('check-dist: dist/client.js is missing; run the build first\n');
  process.exit(1);
}

for (const file of targets) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
process.stdout.write(`check-dist: ${targets.length} artifacts parse cleanly (${targets.map(file => path.relative(root, file)).join(', ')})\n`);
void statSync;
