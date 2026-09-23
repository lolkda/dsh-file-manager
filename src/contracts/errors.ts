/**
 * Frozen error contract for the file manager.
 *
 * This module is the single place where a thrown value becomes a stable,
 * user-visible failure. It ports `contracts/errors.js` verbatim semantics and
 * adds the centralized normalization the Host boundary needs:
 *
 * - an already-classified {@link FileManagerError} is returned unchanged, so a
 *   deliberate cancellation never degrades into an ordinary I/O fault;
 * - cancellation is recognized from the error identity, the `AbortError` name
 *   and the `ABORT_ERR` code before any errno mapping runs;
 * - known system errno codes map to stable business codes and HTTP statuses;
 * - anything else becomes `IO_ERROR` / 500 instead of leaking an internal
 *   message or a stack to the wire.
 *
 * Nothing here imports zod or Node built-ins: the Client half also consumes it.
 */

/** JSON-serializable failure details; never carries a stack or an internal handle. */
export type ErrorDetails = Record<string, unknown>;

/**
 * Stable business codes this Host can emit. `code` itself stays a plain string
 * because a few layers legitimately surface a raw errno (for example an item
 * failure recorded as `EIO`/`EXDEV`), and because the Client keeps its own
 * purely local codes. The list is the contract for everything the Host mints.
 */
export const HOST_ERROR_CODES = [
  'ALREADY_EXISTS',
  'ATOMIC_RENAME_UNCERTAIN',
  'CANCELLED',
  'CHECKSUM_MISMATCH',
  'CLEANUP_FAILED',
  'CONFIRMATION_REQUIRED',
  'DIRECTORY_CHANGED',
  'DIRECTORY_CONFLICT',
  'FEATURE_UNAVAILABLE',
  'FILE_MANAGER_UNAVAILABLE',
  'HISTORY_REVISION_EXHAUSTED',
  'INCOMPLETE_DOWNLOAD',
  'INITIALIZATION_FAILED',
  'INTERRUPTED',
  'INVALID_CURSOR',
  'INVALID_MANIFEST',
  'INVALID_PATH',
  'INVALID_REQUEST',
  'INVALID_STATE',
  'INVALID_TEXT',
  'IO_ERROR',
  'ITEM_NOT_FOUND',
  'ITEM_NOT_READY',
  'LINE_ENDING_MAPPING_LIMIT',
  'NO_FAILED_ITEMS',
  'NO_SPACE',
  'NOT_DIRECTORY',
  'NOT_FOUND',
  'PATH_CHANGED',
  'PERMISSION_DENIED',
  'PERSISTENCE_FAILED',
  'PLAN_EXPIRED',
  'PLAN_NOT_FOUND',
  'RECOVERY_REQUIRED',
  'REQUEST_ID_REUSED',
  'RESOURCE_CLOSED',
  'ROOT_CHANGED',
  'ROOT_NOT_FOUND',
  'ROOT_OPERATION_NOT_ALLOWED',
  'ROOT_UNAVAILABLE',
  'SAME_ENTRY',
  'SELF_DESCENDANT',
  'SERVICE_STOPPED',
  'SIZE_MISMATCH',
  'SOURCE_DELETE_FAILED',
  'STRONG_VERSION_REQUIRED',
  'TASK_BUSY',
  'TASK_CHANGED',
  'TASK_NOT_FOUND',
  'TASK_PERSISTENCE_FAILED',
  'TOO_LARGE',
  'TOO_MANY_REQUESTS',
  'UNREPRESENTABLE_REFERENCE',
  'UNSUPPORTED_ATOMIC_RENAME',
  'UNSUPPORTED_ENCODING',
  'UNSUPPORTED_ENTRY',
  'UNSUPPORTED_PLATFORM',
  'VERSION_CONFLICT',
  'VERSION_REQUIRED',
] as const;

export type HostErrorCode = (typeof HOST_ERROR_CODES)[number];

const hostErrorCodes: ReadonlySet<string> = new Set<string>(HOST_ERROR_CODES);

/** True when `code` is one of the stable Host-minted business codes. */
export function isHostErrorCode(code: unknown): code is HostErrorCode {
  return typeof code === 'string' && hostErrorCodes.has(code);
}

/** A stable, user-visible failure without an internal stack on the wire. */
export class FileManagerError extends Error {
  code: string;
  status: number;
  details: ErrorDetails;

  constructor(code: string, message: string, status = 400, details: ErrorDetails = {}) {
    super(message);
    this.name = 'FileManagerError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Throw a {@link FileManagerError}; mirrors the legacy `fail()` helper exactly. */
export function fail(code: string, message: string, status = 400, details: ErrorDetails = {}): never {
  throw new FileManagerError(code, message, status, details);
}

/** Narrowing guard that also survives a foreign copy of the class. */
export function isFileManagerError(error: unknown): error is FileManagerError {
  if (error instanceof FileManagerError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown; status?: unknown };
  return candidate.name === 'FileManagerError'
    && typeof candidate.code === 'string'
    && typeof candidate.status === 'number';
}

/** The Host and the Client observe cancellation through these codes only. */
export const CANCELLATION_CODES = ['CANCELLED', 'ABORT_ERR'] as const;

/** True when a code means "the caller cancelled", not "the filesystem broke". */
export function isCancellationCode(code: unknown): boolean {
  return typeof code === 'string' && (code === 'CANCELLED' || code === 'ABORT_ERR');
}

/**
 * Recognize a raw cancellation that never reached {@link fail}:
 * `AbortController.abort()`, `AbortSignal` reason propagation and Node's
 * `DOMException` all land here, and none of them may be reported as `IO_ERROR`.
 */
export function isCancellationError(error: unknown): boolean {
  if (isFileManagerError(error)) return isCancellationCode(error.code);
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  if (candidate.name === 'AbortError') return true;
  if (candidate.name === 'TimeoutError') return false;
  return typeof candidate.code === 'string' && candidate.code === 'ABORT_ERR';
}

/**
 * Which caller produced the failure. Only the wording of two messages differs
 * between the control envelope and the streaming transfer routes; the codes,
 * statuses and detail whitelist are shared.
 */
export type ErrorProfile = 'control' | 'transfer';

interface ErrnoMapping {
  readonly code: HostErrorCode;
  readonly status: number;
}

const errnoMappings: Record<ErrorProfile, Readonly<Record<string, ErrnoMapping>>> = {
  control: Object.freeze({
    ENOENT: { code: 'NOT_FOUND', status: 404 },
    EACCES: { code: 'PERMISSION_DENIED', status: 403 },
    EPERM: { code: 'PERMISSION_DENIED', status: 403 },
    ENOTDIR: { code: 'NOT_DIRECTORY', status: 422 },
    ELOOP: { code: 'UNSUPPORTED_ENTRY', status: 422 },
    EEXIST: { code: 'ALREADY_EXISTS', status: 409 },
    ENOSPC: { code: 'NO_SPACE', status: 507 },
    ABORT_ERR: { code: 'CANCELLED', status: 499 },
  }),
  transfer: Object.freeze({
    ENOENT: { code: 'NOT_FOUND', status: 404 },
    EACCES: { code: 'PERMISSION_DENIED', status: 403 },
    EPERM: { code: 'PERMISSION_DENIED', status: 403 },
    ENOTDIR: { code: 'NOT_DIRECTORY', status: 422 },
    ELOOP: { code: 'UNSUPPORTED_ENTRY', status: 422 },
    EEXIST: { code: 'ALREADY_EXISTS', status: 409 },
    ENOSPC: { code: 'NO_SPACE', status: 507 },
    EDQUOT: { code: 'NO_SPACE', status: 507 },
    ABORT_ERR: { code: 'CANCELLED', status: 499 },
  }),
};

const profileMessages: Record<ErrorProfile, {
  readonly notFound: string;
  readonly denied: string;
  readonly notDirectory: string;
  readonly symlink: string;
  readonly exists: string;
  readonly noSpace: string;
  readonly quota: string;
  readonly cancelled: string;
  readonly failed: string;
}> = {
  control: {
    notFound: 'The selected entry no longer exists.',
    denied: 'The filesystem denied this operation.',
    notDirectory: 'A path component is not a directory.',
    symlink: 'Symbolic links are not followed.',
    exists: 'The destination already exists.',
    noSpace: 'The destination has no space available.',
    quota: 'The destination quota is exhausted.',
    cancelled: 'The operation was cancelled.',
    failed: 'The filesystem operation failed.',
  },
  transfer: {
    notFound: 'The selected entry no longer exists.',
    denied: 'The filesystem denied the transfer.',
    notDirectory: 'A path component is not a directory.',
    symlink: 'Symbolic links are not followed.',
    exists: 'The destination already exists.',
    noSpace: 'The destination has no space available.',
    quota: 'The destination quota is exhausted.',
    cancelled: 'The transfer was cancelled.',
    failed: 'The transfer failed.',
  },
};

const PUBLIC_DETAIL_KEYS = ['committed', 'cleanupFailed', 'stagingName'] as const;

/**
 * Whitelist the only details an errno-derived failure may expose. A raw
 * `NodeJS.ErrnoException` can carry a path, a syscall or a descriptor; none of
 * that leaves the Host.
 */
export function publicErrorDetails(details: unknown): ErrorDetails {
  const result: ErrorDetails = {};
  if (typeof details !== 'object' || details === null) return result;
  const source = details as Record<string, unknown>;
  if (source.committed === true) result.committed = true;
  if (source.cleanupFailed === true) result.cleanupFailed = true;
  if (typeof source.stagingName === 'string') result.stagingName = source.stagingName;
  return result;
}

/** The three keys {@link publicErrorDetails} can ever produce. */
export function publicDetailKeys(): readonly string[] {
  return PUBLIC_DETAIL_KEYS;
}

export interface NormalizeOptions {
  /** Wording profile; defaults to the control envelope. */
  readonly profile?: ErrorProfile;
  /** An aborted signal turns an otherwise unclassified failure into a cancellation. */
  readonly signal?: AbortSignal | undefined;
}

function rawCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function rawDetails(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as { details?: unknown }).details;
}

/**
 * Convert any thrown value into the stable failure the wire reports.
 *
 * Order matters and is part of the contract:
 * 1. an already-classified failure is preserved untouched;
 * 2. cancellation is recognized from the error itself (`AbortError`, `ABORT_ERR`);
 * 3. a known system errno maps to its stable business code and status;
 * 4. an unclassified failure on an aborted signal is still a cancellation, so a
 *    caller-initiated abort never surfaces as `IO_ERROR`;
 * 5. everything else becomes `IO_ERROR` / 500 with a whitelisted, bounded detail set.
 */
export function normalizeError(error: unknown, options: NormalizeOptions = {}): FileManagerError {
  if (isFileManagerError(error)) return error;
  const profile = options.profile ?? 'control';
  const messages = profileMessages[profile];
  if (isCancellationError(error)) {
    return new FileManagerError('CANCELLED', messages.cancelled, 499, {});
  }
  const code = rawCode(error);
  if (code !== undefined) {
    const mapping = errnoMappings[profile][code];
    if (mapping !== undefined) {
      const message = mapping.code === 'NOT_FOUND' ? messages.notFound
        : mapping.code === 'PERMISSION_DENIED' ? messages.denied
          : mapping.code === 'NOT_DIRECTORY' ? messages.notDirectory
            : mapping.code === 'UNSUPPORTED_ENTRY' ? messages.symlink
              : mapping.code === 'ALREADY_EXISTS' ? messages.exists
                : mapping.code === 'NO_SPACE' ? (code === 'EDQUOT' ? messages.quota : messages.noSpace)
                  : messages.cancelled;
      return new FileManagerError(mapping.code, message, mapping.status, publicErrorDetails(rawDetails(error)));
    }
  }
  if (options.signal?.aborted === true) {
    return new FileManagerError('CANCELLED', messages.cancelled, 499, {});
  }
  // An unmapped errno still becomes the closed-set `IO_ERROR`; the raw errno is kept
  // in `details.cause` so the diagnostic value survives without opening the wire code
  // set (a client can never branch on an unbounded set of errno values).
  const fallbackDetails = publicErrorDetails(rawDetails(error));
  if (code !== undefined) fallbackDetails.cause = code;
  return new FileManagerError('IO_ERROR', messages.failed, 500, fallbackDetails);
}

/** True for a system errno name (as opposed to a Host business code). */
export function isErrnoCode(code: unknown): code is string {
  return typeof code === 'string' && /^E[A-Z0-9]{2,}$/.test(code) && !isHostErrorCode(code);
}

/** True for a system errno the given profile's mapping table does not cover. */
export function isUnmappedErrno(code: unknown, profile: ErrorProfile = 'control'): code is string {
  return isErrnoCode(code) && errnoMappings[profile][code] === undefined;
}