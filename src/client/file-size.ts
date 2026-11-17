/**
 * Compact file-size text shared by the directory list and upload review.
 *
 * This is display-only. The listing, transfer limits and task progress keep
 * using the raw byte counts returned by the Host. Units use the same binary
 * steps as the rest of the file manager, and the smallest non-empty file is
 * shown as 0.1K so a real file can never look empty.
 */

interface SizeUnit {
  readonly suffix: 'K' | 'M' | 'G';
  readonly bytes: number;
}

const UNITS: readonly SizeUnit[] = [
  { suffix: 'K', bytes: 1024 },
  { suffix: 'M', bytes: 1024 ** 2 },
  { suffix: 'G', bytes: 1024 ** 3 },
];

/** One decimal place without a trailing `.0`, for positive values. */
function oneDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Formats a nonnegative byte count as `0K`, `1.5K`, `2M` or `1G`.
 *
 * Values round to one decimal. A value just below a unit boundary may round up
 * to 1024 of the smaller unit; that is promoted to the next unit so `1024K` and
 * `1024M` never appear. Invalid input is treated as zero because the contracts
 * already require a nonnegative safe integer and this helper must not turn a
 * malformed display value into a React error.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0K';
  let unitIndex = 0;
  let scaled = Math.max(0.1, bytes / UNITS[0]!.bytes);
  while (unitIndex < UNITS.length - 1 && Math.round(scaled * 10) / 10 >= 1024) {
    unitIndex += 1;
    scaled = bytes / UNITS[unitIndex]!.bytes;
  }
  return `${oneDecimal(Math.max(0.1, scaled))}${UNITS[unitIndex]!.suffix}`;
}
