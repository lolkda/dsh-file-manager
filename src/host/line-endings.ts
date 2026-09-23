import { diffArrays } from 'diff';
import { fail } from '../contracts/errors.js';

const separators = /\r\n|\r|\n/g;

/** How a document ends its lines; `mixed` means more than one style survives. */
export type NewlineStyle = 'lf' | 'crlf' | 'cr' | 'mixed';

export function detectLineEndings(text: string): NewlineStyle {
  const kinds = new Set(text.match(separators) ?? []);
  if (kinds.size > 1) return 'mixed';
  return kinds.has('\r\n') ? 'crlf' : kinds.has('\r') ? 'cr' : 'lf';
}

/** Map textarea lines back to original separators without normalizing surviving lines. */
export function preserveLineEndings(text: string, previous: string): string {
  const nextLines = text.split(/\r\n|\r|\n/);
  const oldEndings = previous.match(separators) ?? [];
  if (new Set(oldEndings).size <= 1) return nextLines.join(oldEndings[0] ?? '\n');
  const oldLines = previous.split(/\r\n|\r|\n/);
  const changes = diffArrays(oldLines, nextLines, { maxEditLength: 10000, timeout: 250 });
  if (!changes) fail('LINE_ENDING_MAPPING_LIMIT', 'This edit is too large to preserve mixed line endings safely.', 422);
  const mapping: Array<number | null> = [];
  let oldIndex = 0;
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index];
    if (!change) continue;
    if (change.removed) {
      const following = changes[index + 1];
      let added = null;
      if (following?.added) { index++; added = following; }
      if (added) for (let offset = 0; offset < added.count; offset++) mapping.push(offset < change.count ? oldIndex + offset : null);
      oldIndex += change.count;
    } else if (change.added) {
      for (let offset = 0; offset < change.count; offset++) mapping.push(null);
    } else {
      for (let offset = 0; offset < change.count; offset++) mapping.push(oldIndex++);
    }
  }
  const mappedEndings = mapping.map(index => index === null ? undefined : oldEndings[index]);
  let nearby = oldEndings[0] ?? '\n';
  return nextLines.map((line, index) => {
    if (index === nextLines.length - 1) return line;
    const ending = mappedEndings[index];
    // New lines inherit their predecessor's style; at the beginning use the first surviving style.
    if (ending) nearby = ending;
    else if (index === 0) nearby = mappedEndings.find(value => Boolean(value)) ?? nearby;
    return line + nearby;
  }).join('');
}
