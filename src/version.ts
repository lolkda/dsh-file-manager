import { readFileSync } from 'node:fs';

/**
 * The wire version is the installed package's own version, read from the package
 * metadata at runtime. `../package.json` resolves to the package root from both
 * `src/` and `dist/`, so the two layouts can never disagree.
 */
function readVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof manifest.version === 'string' && manifest.version ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION: string = readVersion();
