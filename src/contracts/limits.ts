/**
 * Single source of truth for every limit, budget and admission bound.
 *
 * The Host settings schema, the HTTP envelope checks, the task/transfer engines
 * and the deletion planner all read their numbers from here, so a bound can
 * never exist in two places with two values.
 *
 * Node-free and zod-free on purpose: the Client half imports the same numbers.
 */

import { fail } from './errors.js';

/**
 * Configuration section identity: the kebab-case bundle row id this plugin is
 * installed under (`cordis.patch.yml`). DSH 0.1.7-rc.1 keys a plugin's settings
 * form by its profile entry id and validates the row's `config` against the
 * plugin's exported `Config` schema, so this constant is the id the row must
 * carry — not a namespace registered at runtime.
 */
export const SETTINGS_NAMESPACE = 'local-file-manager' as const;
/** Profile storage unit for root grants. Storage units must match /^[a-z][a-z0-9_]*$/. */
export const STORAGE_NAMESPACE = 'local_file_manager' as const;
/** Profile storage unit for operation journals (tasks and transfers). */
export const OPERATIONS_STORAGE_NAMESPACE = 'local_file_manager_operations' as const;
/** Bootstrap stage label reported on the wire. */
export const WIRE_STAGE = 'basic-management' as const;

export interface LimitBounds {
  readonly min: number;
  readonly max: number;
  readonly description: string;
}

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** Every profile limit, in reporting order. The single name list; nothing derives it. */
export const LIMIT_NAMES = [
  'maxTextBytes', 'maxFileBytes', 'maxTaskBytes', 'maxTaskEntries',
  'transferConcurrency', 'pollIntervalMs', 'deletePlanTtlMs', 'maxVerificationBytes',
] as const;
export type LimitName = (typeof LIMIT_NAMES)[number];
/** A fully resolved limit set; every name is present and numeric. */
export type ProfileLimits = { [K in LimitName]: number };
export type ProfileLimitsInput = Partial<ProfileLimits>;

/**
 * Bounds and descriptions for every profile limit. `maxVerificationBytes` is
 * the budget for one content-verification operation (a copy/move manifest, a
 * ZIP download, an overwrite proof). Exceeding it refuses the operation; it
 * never downgrades or skips verification.
 */
export const LIMIT_BOUNDS = {
  maxTextBytes: { min: 1, max: 32 * MiB, description: 'Text editing limit in bytes' },
  maxFileBytes: { min: 1, max: Number.MAX_SAFE_INTEGER, description: 'Individual transfer file limit in bytes' },
  maxTaskBytes: { min: 1, max: Number.MAX_SAFE_INTEGER, description: 'Total transfer task limit in bytes' },
  maxTaskEntries: { min: 1, max: 100000, description: 'Entry count limit for transfer tasks' },
  transferConcurrency: { min: 1, max: 8, description: 'Simultaneous heavy I/O operations' },
  pollIntervalMs: { min: 250, max: 60000, description: 'Snapshot reconciliation interval in milliseconds' },
  deletePlanTtlMs: { min: 1000, max: 600000, description: 'Deletion confirmation lifetime in milliseconds' },
  maxVerificationBytes: { min: 1, max: Number.MAX_SAFE_INTEGER, description: 'Content verification budget per operation in bytes' },
} as const satisfies Record<LimitName, LimitBounds>;

/**
 * Default profile limits. These are the values a fresh profile starts with.
 *
 * Typed as `Readonly<ProfileLimits>` rather than `as const`: the frozen *values*
 * are asserted by the contract tests, while literal types would leak into
 * consumers (`Pick<typeof LIMIT_DEFAULTS, ...>` becomes `10000`/`2`) and reject a
 * perfectly valid resolved `ProfileLimits`. Use {@link ProfileLimits} for values.
 */
export const LIMIT_DEFAULTS: Readonly<ProfileLimits> = {
  maxTextBytes: 5 * MiB,
  maxFileBytes: 2 * GiB,
  maxTaskBytes: 10 * GiB,
  maxTaskEntries: 10000,
  transferConcurrency: 2,
  pollIntervalMs: 2000,
  deletePlanTtlMs: 300000,
  maxVerificationBytes: 10 * GiB,
};

/** True when `value` is a safe integer inside its declared bounds. */
export function isValidLimitValue(name: LimitName, value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= LIMIT_BOUNDS[name].min
    && value <= LIMIT_BOUNDS[name].max;
}

/**
 * Resolve configured limits over the defaults, rejecting an out-of-bounds or
 * non-integer value instead of silently clamping it. Invalid configuration is a
 * Host-side state fault (500), not a user error.
 */
export function resolveLimits(configured: ProfileLimitsInput = {}): ProfileLimits {
  const resolved = { ...LIMIT_DEFAULTS } as ProfileLimits;
  for (const name of LIMIT_NAMES) {
    const value = configured[name];
    if (value === undefined) continue;
    if (!isValidLimitValue(name, value)) {
      fail('INVALID_STATE', `Invalid profile limit: ${name}.`, 500, {
        limit: name, min: LIMIT_BOUNDS[name].min, max: LIMIT_BOUNDS[name].max,
      });
    }
    resolved[name] = value;
  }
  return resolved;
}

/** Queue bound for heavy I/O waiting behind `transferConcurrency` permits. */
export const HEAVY_IO_QUEUE_LIMIT = 64;

/** Small control envelope: everything that is not an explicit manifest operation. */
export const CONTROL_ENVELOPE_BYTES = 256 * 1024;
/** Manifest envelope: bounded bulk manifests carried on the manifest route. */
export const MANIFEST_ENVELOPE_BYTES = 16 * MiB;
/**
 * The only operations allowed to exceed {@link CONTROL_ENVELOPE_BYTES}. Every
 * other control operation is rejected with `TOO_LARGE` / 413.
 */
export const MANIFEST_OPS = ['tasks.start', 'tasks.retry', 'transfers.begin'] as const;
/** True when `op` may carry a bulk manifest on the manifest route. */
export function isManifestOp(op: unknown): boolean {
  return typeof op === 'string' && (MANIFEST_OPS as readonly string[]).includes(op);
}

/**
 * A text body may need six wire bytes per text byte once JSON escapes are
 * applied, plus the envelope fields.
 */
export const TEXT_ENVELOPE_MULTIPLIER = 6;
export const TEXT_ENVELOPE_OVERHEAD_BYTES = 65536;
/** Wire envelope bound for a text save of `maxTextBytes` text bytes. */
export function textEnvelopeBytes(maxTextBytes: number): number {
  return maxTextBytes * TEXT_ENVELOPE_MULTIPLIER + TEXT_ENVELOPE_OVERHEAD_BYTES;
}

/** Request-id ledger: identifier length, retry window size and TTL. */
export const REQUEST_ID_MIN_LENGTH = 8;
export const REQUEST_ID_MAX_LENGTH = 128;
export const REQUEST_LEDGER_CAPACITY = 256;
export const REQUEST_LEDGER_TTL_MS = 600000;

/** Directory listing page bounds. */
export const DIRECTORY_PAGE_DEFAULT = 200;
export const DIRECTORY_PAGE_MAX = 500;

/** Root-relative path grammar bound, measured in UTF-16 code units. */
export const RELATIVE_PATH_MAX_LENGTH = 4096;

/** Deletion confirmation bounds: selected entries, manifest entries, live plans. */
export const DELETE_PLAN_MAX_SELECTIONS = 10000;
export const DELETE_PLAN_MAX_ENTRIES = 10000;
export const DELETE_PLAN_MAX_PENDING = 64;

/** Task-history close bounds: records per request and distinct-select duplicate check. */
export const ACTIVITY_DISMISS_MAX_ITEMS = 256;

/** Watch bounds: targets per subscription, retained records, SSE heartbeat and queue. */
export const WATCH_MAX_TARGETS = 128;
export const WATCH_MAX_RECORDS = 512;
export const EVENT_HEARTBEAT_MS = 15000;
export const EVENT_MAX_QUEUED = 128;

/**
 * HTTP admission: at most this many small-envelope requests are accepted at
 * once, and at most this many large/streaming bodies. Excess requests are
 * refused immediately (including releasing the request body) rather than queued.
 */
export const SMALL_BODY_ADMISSION = 8;
export const LARGE_BODY_ADMISSION = 2;

/** Conflict strategies for copy/move tasks. */
export const TASK_CONFLICT_POLICIES = ['skip', 'rename', 'overwrite'] as const;
/** Conflict strategies for upload items. */
export const UPLOAD_CONFLICT_POLICIES = ['error', 'skip', 'overwrite'] as const;

export type TaskConflictPolicy = (typeof TASK_CONFLICT_POLICIES)[number];
export type UploadConflictPolicy = (typeof UPLOAD_CONFLICT_POLICIES)[number];