import { closeSync, constants, fstatSync, openSync, realpathSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { FileManagerError, fail, normalizeError } from '../contracts/errors.js';
import { DELETE_SCOPE, DELETE_PLAN_MAX_PENDING, DELETE_PLAN_MAX_SELECTIONS, DIRECTORY_PAGE_DEFAULT, DIRECTORY_PAGE_MAX, LIMIT_DEFAULTS, RELATIVE_PATH_MAX_LENGTH } from '../contracts/limits.js';
import { deleteTree, type DeletionEffect } from './delete-tree.js';
import { detectLineEndings, preserveLineEndings } from './line-endings.js';
import {
  chargeVerification, createIO, createVerificationBudget,
  type EntryKind, type EntryView, type RootPathRef, type UnaddressableEntry, type VerificationBudget,
} from './io.js';
import { renameCompatibilityAvailable, renameNoReplace } from './atomic-rename.js';
import type { HeavyIoScheduler } from './scheduler.js';

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const names = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
/** The browsable root every manager is built around. */
export const ROOT_PATH_DEFAULT = '/';

/**
 * The one directory a manager browses, resolved once at construction.
 *
 * This is not a grant: there is no way to add, remove, re-authorize or persist
 * one. `id` is derived from `identity` and the canonical path, so a path whose
 * `dev:ino` or canonical form differs reports a different id.
 */
export interface RootDescriptor {
  readonly id: string;
  readonly path: string;
  readonly label: string;
  readonly identity: string;
}

export interface ManagerOptions {
  /**
   * The directory to browse. Defaults to `/`; an isolated directory is for
   * embedded and verification callers only and is not a plugin setting. The path
   * is opened and identity-checked here, so an unusable root fails at
   * construction instead of answering requests it cannot serve.
   */
  rootPath?: string | undefined;
  now?: (() => number) | undefined;
  deletePlanTtlMs?: number | undefined;
  maxTextBytes?: number | undefined;
  maxVerificationBytes?: number | undefined;
  scheduler?: HeavyIoScheduler | undefined;
}

export interface ReadTextOptions extends RootPathRef {
  maxBytes?: number | undefined;
  budget?: VerificationBudget | undefined;
}

export interface ListInput {
  rootId?: unknown;
  path?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface ListResult {
  rootId: string;
  path: string;
  entries: EntryView[];
  unaddressable: UnaddressableEntry[];
  total: number;
  nextCursor: string | null;
}

export interface DeleteTarget { rootId: string; path: string }

export interface DeletePlanView {
  id: string;
  scope: typeof DELETE_SCOPE;
  targets: DeleteTarget[];
  entryCount: number;
  expiresAt: number;
  permanent: true;
  entries: Array<{ rootId: string; path: string; kind: EntryKind; size: number; version: string }>;
}

export interface DeleteCommitResult {
  id: string;
  status: 'completed' | 'partial';
  results: Array<{ rootId: string; path: string; status: 'completed' | 'failed'; removed?: boolean; contentsChanged?: boolean; error?: { code: string; message: string; details?: Record<string, unknown> } }>;
}

interface DeletePlanEntry extends EntryView {
  parentIdentity: string;
}

interface DeletePlan {
  id: string;
  targets: DeleteTarget[];
  entries: DeletePlanEntry[];
  expiresAt: number;
  promise: Promise<DeleteCommitResult> | null;
  result: DeleteCommitResult | null;
}

const identity = (stat: BigIntStats): string => `${stat.dev}:${stat.ino}`;
const stamp = (stat: BigIntStats): string => `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

/**
 * The root-relative path grammar, reported rather than thrown, so a directory
 * listing can show a name it cannot address instead of failing as a whole.
 */
export function pathViolation(relativePath: unknown, allowRoot = true): string | undefined {
  if (typeof relativePath !== 'string') return 'it is not a string';
  if (relativePath.length > RELATIVE_PATH_MAX_LENGTH) return `it exceeds ${RELATIVE_PATH_MAX_LENGTH} characters`;
  if (/[\x00-\x1f\\]/.test(relativePath)) return 'it contains control characters or a backslash';
  if (path.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) return 'it is absolute';
  if (relativePath === '') return allowRoot ? undefined : 'it names the root';
  if (relativePath.split('/').some(part => part === '' || part === '.' || part === '..')) return 'it contains an empty or dot segment';
  return undefined;
}

/** A held descriptor's address; never built from an untrusted ancestor path. */
function fdAddress(fd: number, child = ''): string {
  if (process.platform !== 'linux') fail('UNSUPPORTED_PLATFORM', 'This release requires a Linux Host.', 422);
  return `/proc/self/fd/${fd}${child ? `/${child}` : ''}`;
}

/** Internal paths address held directory descriptors, never untrusted ancestors. */
function fdPath(handle: FileHandle, child = ''): string {
  return fdAddress(handle.fd, child);
}

/**
 * Resolve the one browsable root, once, at construction.
 *
 * The path is opened with `O_DIRECTORY | O_NOFOLLOW` (a link is rejected), its
 * `dev:ino` is captured, and the canonical path is read back from the held
 * descriptor instead of being assumed from the requested string. Later operations
 * re-open the path and re-check both facts; a path whose `dev:ino` or canonical
 * form has changed is refused rather than adopted.
 *
 * A failure is reported as a root failure, not an I/O error: the caller decides
 * whether the whole surface has to be refused.
 */
function snapshotRoot(requestedPath: string): RootDescriptor {
  if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath) || /[\x00-\x1f]/.test(requestedPath)) {
    fail('INVALID_STATE', 'The configured root path must be an absolute directory path.', 500);
  }
  let fd: number | undefined;
  try {
    fd = openSync(requestedPath, DIRECTORY_FLAGS);
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isDirectory()) fail('NOT_DIRECTORY', 'The fixed root is not a directory.', 500);
    const canonical = realpathSync(fdAddress(fd));
    const observed = identity(stat);
    return Object.freeze({
      id: createHash('sha256').update(`${canonical}\u0000${observed}`).digest('hex').slice(0, 32),
      path: canonical,
      label: path.basename(canonical) || canonical,
      identity: observed,
    });
  } catch (error) {
    // A `throw` (not `fail`) keeps the control-flow analysis of this
    // try/catch/finally honest: every path returns a snapshot or throws.
    if (error instanceof FileManagerError) throw error;
    throw new FileManagerError('ROOT_UNAVAILABLE', 'The fixed root could not be opened as a directory.', 500, { cause: (error as NodeJS.ErrnoException).code });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function partsOf(relativePath: unknown): string[] {
  const violation = pathViolation(relativePath, true);
  if (violation !== undefined) {
    fail('INVALID_PATH', violation === 'it contains an empty or dot segment'
      ? 'Dot segments and empty path segments are not allowed.'
      : 'Expected a root-relative path.');
  }
  const value = relativePath as string;
  if (value === '') return [];
  return value.split('/');
}

function kindOf(stat: BigIntStats): EntryKind {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  return 'other';
}

/** Create a Host-local manager over one fixed, non-configurable root. */
export function createManager(options: ManagerOptions = {}) {
  const {
    rootPath = ROOT_PATH_DEFAULT, now = Date.now,
    deletePlanTtlMs = LIMIT_DEFAULTS.deletePlanTtlMs,
    maxTextBytes = LIMIT_DEFAULTS.maxTextBytes,
    maxVerificationBytes = LIMIT_DEFAULTS.maxVerificationBytes,
    scheduler,
  } = options;
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1 || maxTextBytes > 32 * 1024 * 1024) fail('INVALID_STATE', 'The text size limit is invalid.', 500);
  // The root is resolved first: without a verified snapshot there is nothing
  // that could safely answer a request.
  const root = snapshotRoot(rootPath);
  let mutationTail: Promise<unknown> = Promise.resolve();
  /**
   * `close()` has been called: no further work is accepted, while the mutations
   * already queued still run to completion. Closing is a shutdown, not a
   * cancellation of work the Host already accepted.
   */
  let stopping = false;
  /** The queued work drained and the I/O resources were released. */
  let closed = false;
  const deletePlans = new Map<string, DeletePlan>();
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    if (stopping) return Promise.reject(new FileManagerError('SERVICE_STOPPED', 'The file manager is stopping.', 503));
    const result = mutationTail.then(operation);
    mutationTail = result.catch(() => {});
    return result;
  };

  /**
   * Guard the entry points that read the root for a caller, not the work already
   * accepted: every mutation queued before `close()` keeps using the root while
   * it drains, so this must not be consulted on that path.
   */
  function assertOpen(): void {
    if (closed) fail('SERVICE_STOPPED', 'The file manager is closed.', 503);
  }

  /** The frozen root snapshot, copied so a caller cannot rewrite it in place. */
  function getRoot(): RootDescriptor {
    assertOpen();
    return { ...root };
  }

  /**
   * Resolve a caller-supplied root id against the one root.
   *
   * A reference dropped by any other root — an older identity of this path,
   * another directory, or an id this manager did not mint — is refused instead of
   * being rebound. Task history and drafts therefore keep addressing what they
   * were created against, and stop resolving once that is gone.
   *
   * This is deliberately not a shutdown check: it runs inside accepted work too.
   */
  function rootOf(rootId: unknown): RootDescriptor {
    if (typeof rootId !== 'string' || rootId !== root.id) {
      fail('ROOT_NOT_FOUND', 'This reference belongs to a different root and is not rebound.', 404);
    }
    return root;
  }

  /** Open and identity-check the root before walking any of its descendants. */
  async function openRoot(candidate: RootDescriptor): Promise<FileHandle> {
    if (candidate !== root) fail('ROOT_CHANGED', 'The root this operation was built for is no longer the current root.', 409);
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(root.path, DIRECTORY_FLAGS);
      const stat = await handle.stat({ bigint: true });
      const actual = await fs.realpath(fdPath(handle));
      if (!stat.isDirectory() || identity(stat) !== root.identity || actual !== root.path) {
        fail('ROOT_CHANGED', 'The directory at the root path is no longer the one this manager opened.', 409);
      }
      return handle;
    } catch (error) {
      if (handle) await handle.close();
      if (error instanceof FileManagerError) throw error;
      fail('ROOT_UNAVAILABLE', 'The fixed root directory is unavailable.', 409, { cause: (error as NodeJS.ErrnoException).code });
    }
  }

  /** Descend via held descriptors and reject symlinks at every user path segment. */
  async function openDirectory(rootCandidate: RootDescriptor, parts: readonly string[]): Promise<FileHandle> {
    let current = await openRoot(rootCandidate);
    try {
      for (const segment of parts) {
        const address = fdPath(current, segment);
        const stat = await fs.lstat(address, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSUPPORTED_ENTRY', 'Directory links and special entries are not followed.', 422);
        const next = await fs.open(address, DIRECTORY_FLAGS);
        await current.close();
        current = next;
      }
      return current;
    } catch (error) {
      await current.close();
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') fail('UNSUPPORTED_ENTRY', 'Symbolic links are not followed.', 422);
      throw error;
    }
  }

  async function list({ rootId, path: relativePath = '', limit = DIRECTORY_PAGE_DEFAULT, cursor }: ListInput = {}): Promise<ListResult> {
    assertOpen();
    const parts = partsOf(relativePath);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > DIRECTORY_PAGE_MAX) fail('INVALID_REQUEST', `Page size must be between 1 and ${DIRECTORY_PAGE_MAX}.`);
    const root = rootOf(rootId);
    const directory = await openDirectory(root, parts);
    try {
      const before = stamp(await directory.stat({ bigint: true }));
      let offset = 0;
      if (cursor != null) {
        let decoded: { offset?: unknown; version?: unknown };
        try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { offset?: unknown; version?: unknown }; }
        catch { fail('INVALID_CURSOR', 'The directory cursor is invalid.'); }
        if (!decoded || !Number.isSafeInteger(decoded.offset) || (decoded.offset as number) < 0) fail('INVALID_CURSOR', 'The directory cursor is invalid.');
        if (decoded.version !== before) fail('DIRECTORY_CHANGED', 'The directory changed; reload its first page.', 409);
        offset = decoded.offset as number;
      }
      const children = await fs.readdir(fdPath(directory), { withFileTypes: true });
      children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || names.compare(a.name, b.name) || a.name.localeCompare(b.name));
      const selected = children.slice(offset, offset + limit);
      const entries: EntryView[] = [];
      const unaddressable: UnaddressableEntry[] = [];
      let total = 0;
      for (const child of children) {
        const childPath = parts.length ? `${parts.join('/')}/${child.name}` : child.name;
        if (pathViolation(childPath, false) === undefined) total++;
      }
      for (const child of selected) {
        const childPath = parts.length ? `${parts.join('/')}/${child.name}` : child.name;
        const violation = pathViolation(childPath, false);
        const stat = await fs.lstat(fdPath(directory, child.name), { bigint: true });
        // A name the grammar cannot express is shown with a reason; it never
        // fails the page and never becomes an addressable path.
        if (violation !== undefined) {
          unaddressable.push({ name: child.name, kind: kindOf(stat), reason: violation });
          continue;
        }
        entries.push({
          rootId: root.id, path: childPath, name: child.name, kind: kindOf(stat),
          size: Number(stat.size), modifiedAt: new Date(Number(stat.mtimeMs)).toISOString(),
          version: stamp(stat), identity: identity(stat), mode: Number(stat.mode & 0o7777n),
        });
      }
      if (stamp(await directory.stat({ bigint: true })) !== before) fail('DIRECTORY_CHANGED', 'The directory changed while being listed; reload it.', 409);
      const nextOffset = offset + selected.length;
      return {
        rootId: root.id, path: relativePath, entries, unaddressable, total,
        nextCursor: nextOffset < children.length ? Buffer.from(JSON.stringify({ version: before, offset: nextOffset })).toString('base64url') : null,
      };
    } finally {
      await directory.close();
    }
  }

  async function readText({ rootId, path: relativePath, maxBytes = maxTextBytes, signal, budget }: ReadTextOptions = {}): Promise<{
    rootId: string; path: string; text: string; bytes: number; version: string;
    encoding: 'utf-8'; bom: boolean; newline: ReturnType<typeof detectLineEndings>; mode: number;
  }> {
    // Also reached from inside a drained write, which runs before `closed` is set.
    assertOpen();
    const parts = partsOf(relativePath);
    if (!parts.length) fail('UNSUPPORTED_ENTRY', 'Select a regular file for text preview.', 422);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail('INVALID_REQUEST', 'Read limit must be a positive integer.');
    const bound = Math.min(maxBytes, maxTextBytes);
    const spend = budget ?? createVerificationBudget(maxVerificationBytes);
    const root = rootOf(rootId);
    const directory = await openDirectory(root, parts.slice(0, -1));
    let file: FileHandle | undefined;
    try {
      const address = fdPath(directory, parts.at(-1) as string);
      const entry = await fs.lstat(address, { bigint: true });
      if (!entry.isFile() || entry.isSymbolicLink()) fail('UNSUPPORTED_ENTRY', 'Only regular files can be opened; links are not followed.', 422);
      file = await fs.open(address, FILE_FLAGS);
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) fail('UNSUPPORTED_ENTRY', 'The selected entry is not a regular file.', 422);
      if (before.size > BigInt(bound)) fail('TOO_LARGE', 'The file exceeds the text-preview limit.', 413);
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        if (signal?.aborted) fail('CANCELLED', 'The read was cancelled.', 499);
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, bound - total + 1));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > bound) fail('TOO_LARGE', 'The file grew beyond the text-preview limit.', 413);
        chunks.push(chunk.subarray(0, bytesRead));
      }
      const after = await file.stat({ bigint: true });
      if (stamp(before) !== stamp(after)) fail('VERSION_CONFLICT', 'The file changed while being read.', 409);
      const bytes = Buffer.concat(chunks, total);
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { fail('UNSUPPORTED_ENCODING', 'The file is not valid UTF-8 text.', 422); }
      if (text.includes('\0')) fail('UNSUPPORTED_ENCODING', 'Binary content is not editable as text.', 422);
      chargeVerification(spend, total);
      const digest = createHash('sha256').update(bytes).digest('hex');

      return {
        rootId: root.id, path: relativePath as string, text, bytes: total, version: `${stamp(after)}:${digest}`,
        encoding: 'utf-8', bom: bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
        newline: detectLineEndings(text), mode: Number(after.mode & 0o7777n),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') fail('UNSUPPORTED_ENTRY', 'Symbolic links are not followed.', 422);
      throw error;
    } finally {
      if (file) await file.close();
      await directory.close();
    }
  }

  interface ParentLocation {
    rootId: string;
    path: string;
    root: RootDescriptor;
    parts: string[];
    parent: FileHandle;
    name: string;
    address: string;
  }

  async function withParent<T>(ref: RootPathRef, operation: (location: ParentLocation) => Promise<T>): Promise<T> {
    const parts = partsOf(ref.path);
    if (!parts.length) fail('ROOT_OPERATION_NOT_ALLOWED', 'The root itself cannot be modified or deleted.', 403);
    const root = rootOf(ref.rootId);
    const parent = await openDirectory(root, parts.slice(0, -1));
    const location: ParentLocation = {
      rootId: root.id, path: ref.path as string, root, parts, parent,
      name: parts.at(-1) as string, address: fdPath(parent, parts.at(-1)),
    };
    try { return await operation(location); }
    finally { await parent.close(); }
  }

  async function verifyParent(location: ParentLocation): Promise<void> {
    if (rootOf(location.rootId) !== location.root) fail('ROOT_CHANGED', 'The root this operation was built for is no longer the current root.', 409);
    const current = await openDirectory(location.root, location.parts.slice(0, -1));
    try {
      if (identity(await current.stat({ bigint: true })) !== identity(await location.parent.stat({ bigint: true }))) {
        fail('PATH_CHANGED', 'A parent directory changed while the operation was pending.', 409);
      }
    } finally { await current.close(); }
  }

  function entryView(ref: { rootId: string; path: string }, stat: BigIntStats): EntryView {
    return {
      rootId: ref.rootId, path: ref.path, name: ref.path.split('/').at(-1), kind: kindOf(stat),
      size: Number(stat.size), modifiedAt: new Date(Number(stat.mtimeMs)).toISOString(),
      version: stamp(stat), identity: identity(stat), mode: Number(stat.mode & 0o7777n),
    };
  }

  async function absent(address: string): Promise<void> {
    try { await fs.lstat(address); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    fail('ALREADY_EXISTS', 'The destination already exists; no overwrite was authorized.', 409);
  }

  function requireVersion(version: unknown): asserts version is string {
    if (typeof version !== 'string' || version.length === 0) fail('VERSION_REQUIRED', 'An expected file version is required.', 409);
  }

  function textBytes(text: unknown, previous: { text: string; bom: boolean } | null): Buffer {
    if (typeof text !== 'string' || text.includes('\0') || /[\uD800-\uDFFF]/u.test(text)) {
      fail('INVALID_TEXT', 'Expected a valid Unicode text string without NUL characters.');
    }
    const normalized = previous ? preserveLineEndings(text, previous.text) : text;
    const bytes = Buffer.from(`${previous?.bom ? '\ufeff' : ''}${normalized}`, 'utf8');
    if (bytes.length > maxTextBytes) fail('TOO_LARGE', 'The text exceeds the configured editing limit.', 413);
    return bytes;
  }

  /** File data is staged beside the destination; no partial body is published. */
  async function writeText(ref: RootPathRef, text: unknown, expectedVersion: unknown, create: boolean, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof readText>>> {
    if (!create) requireVersion(expectedVersion);
    if (signal?.aborted) fail('CANCELLED', 'The operation was cancelled.', 499);
    return withParent(ref, async location => {
      const previous = create ? null : await readText(ref);
      if (previous && previous.version !== expectedVersion) fail('VERSION_CONFLICT', 'The file changed since it was opened.', 409);
      if (previous && (previous.mode & 0o6000)) fail('UNSUPPORTED_ENTRY', 'Editing set-ID files is not supported.', 422);
      const bytes = textBytes(text, previous);
      const temporaryName = `.dsh-fm-${randomUUID()}.tmp`;
      const temporaryPath = fdPath(location.parent, temporaryName);
      let temporary: FileHandle | undefined;
      let published = false;
      let primaryError: FileManagerError | undefined;
      try {
        if (create) await absent(location.address);
        temporary = await fs.open(temporaryPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await temporary.writeFile(bytes);
        await temporary.chmod(previous ? previous.mode & 0o777 : 0o666 & ~process.umask());
        await temporary.sync();
        await verifyParent(location);
        const namedTemporary = await fs.lstat(temporaryPath, { bigint: true });
        if (identity(namedTemporary) !== identity(await temporary.stat({ bigint: true }))) fail('PATH_CHANGED', 'The staging file was replaced.', 409);
        if (previous && (await readText(ref)).version !== expectedVersion) fail('VERSION_CONFLICT', 'The file changed before publication.', 409);
        if (signal?.aborted) fail('CANCELLED', 'The operation was cancelled before publication.', 499);
        await verifyParent(location);
        if (create) {
          try { await fs.link(temporaryPath, location.address); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('ALREADY_EXISTS', 'The destination appeared before publication.', 409); throw error; }
          await fs.unlink(temporaryPath);
        } else {
          await fs.rename(temporaryPath, location.address);
        }
        published = true;
        await location.parent.sync();
        const saved = await readText(ref);
        if (!saved.version.endsWith(`:${createHash('sha256').update(bytes).digest('hex')}`)) {
          fail('VERSION_CONFLICT', 'The file changed immediately after publication; keep the local draft.', 409, { committed: true });
        }
        return saved;
      } catch (error) {
        primaryError = error as FileManagerError;
        if (published) (error as FileManagerError).details = { ...((error as FileManagerError).details ?? {}), committed: true };
        throw error;
      } finally {
        try {
          if (temporary) {
            const remaining = await fs.lstat(temporaryPath, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
            if (remaining && identity(remaining) === identity(await temporary.stat({ bigint: true }))) await fs.unlink(temporaryPath);
          }
        } catch (cleanupError) {
          if (primaryError) primaryError.details = { ...(primaryError.details ?? {}), cleanupFailed: true, stagingName: temporaryName };
          else throw new FileManagerError('CLEANUP_FAILED', 'The operation left an owned staging file that could not be cleaned.', 500, { committed: published, stagingName: temporaryName });
        } finally {
          if (temporary) await temporary.close();
        }
      }
    });
  }

  function saveText({ rootId, path: relativePath, text, expectedVersion, signal }: {
    rootId?: unknown; path?: string | undefined; text?: unknown; expectedVersion?: unknown; signal?: AbortSignal | undefined;
  } = {}): Promise<Awaited<ReturnType<typeof readText>>> {
    return mutate(() => writeText({ rootId, path: relativePath }, text, expectedVersion, false, signal));
  }

  function createFile({ rootId, path: relativePath, text = '', signal }: {
    rootId?: unknown; path?: string | undefined; text?: unknown; signal?: AbortSignal | undefined;
  } = {}): Promise<Awaited<ReturnType<typeof readText>>> {
    return mutate(() => writeText({ rootId, path: relativePath }, text, undefined, true, signal));
  }

  function createDirectory(ref: RootPathRef = {}): Promise<EntryView> {
    return mutate(() => withParent(ref, async location => {
      await verifyParent(location);
      try { await fs.mkdir(location.address, { mode: 0o777 & ~process.umask() }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('ALREADY_EXISTS', 'The directory name already exists.', 409); throw error; }
      try {
        await location.parent.sync();
        return entryView({ rootId: String(ref.rootId), path: ref.path as string }, await fs.lstat(location.address, { bigint: true }));
      } catch (error) {
        (error as FileManagerError).details = { ...((error as FileManagerError).details ?? {}), committed: true };
        throw error;
      }
    }));
  }

  function rename({ rootId, path: relativePath, name, expectedVersion, allowNonExclusiveRename }: {
    rootId?: unknown; path?: string | undefined; name?: unknown; expectedVersion?: unknown; allowNonExclusiveRename?: unknown;
  } = {}): Promise<EntryView> {
    return mutate(async () => {
      if (allowNonExclusiveRename !== undefined && typeof allowNonExclusiveRename !== 'boolean') {
        fail('INVALID_REQUEST', 'allowNonExclusiveRename must be a boolean when it is present.');
      }
      const compatible = allowNonExclusiveRename === true;
      requireVersion(expectedVersion);
      const targetParts = partsOf(name);
      if (targetParts.length !== 1) fail('INVALID_PATH', 'A new name must be one path segment.');
      return withParent({ rootId, path: relativePath }, async location => {
        if (name === location.name) fail('INVALID_REQUEST', 'The source and destination names are identical.');
        const source = await fs.lstat(location.address, { bigint: true });
        if (!['file', 'directory', 'symlink'].includes(kindOf(source))) fail('UNSUPPORTED_ENTRY', 'This entry type cannot be renamed.', 422);
        const strong = source.isFile() && /:[0-9a-f]{64}$/.test(expectedVersion);
        // Only a strong selection needs content; a metadata selection stays cheap.
        const selectedVersion = strong
          ? (await io.stat({ rootId, path: relativePath })).version
          : stamp(source);
        if (selectedVersion !== expectedVersion) fail('VERSION_CONFLICT', 'The source changed after it was selected.', 409);
        const destination = fdPath(location.parent, name as string);
        await absent(destination);
        await verifyParent(location);
        const currentVersion = strong
          ? (await io.stat({ rootId, path: relativePath })).version
          : stamp(await fs.lstat(location.address, { bigint: true }));
        if (currentVersion !== expectedVersion) fail('VERSION_CONFLICT', 'The source changed before rename.', 409);
        await absent(destination);
        try {
          await renameNoReplace(location.parent, location.name, location.parent, name as string);
        } catch (error) {
          if (!compatible || !renameCompatibilityAvailable(error)) throw error;
          // The helper proved that this filesystem cannot enforce no-replace, and the
          // caller explicitly accepted the weaker guarantee for this one rename. Every
          // fact the strict path established is re-proved immediately before the
          // ordinary rename: the same parent directory, the same source version, and a
          // destination that still does not exist. The window that remains after this
          // re-check is exactly the concurrency risk the caller confirmed; the ordinary
          // rename stays atomic as a rename but no longer promises not to replace a name
          // another process created in that window.
          await verifyParent(location);
          const confirmedVersion = strong
            ? (await io.stat({ rootId, path: relativePath })).version
            : stamp(await fs.lstat(location.address, { bigint: true }));
          if (confirmedVersion !== expectedVersion) fail('VERSION_CONFLICT', 'The source changed before the compatible rename.', 409);
          await absent(destination);
          await fs.rename(location.address, destination);
        }
        try {
          await location.parent.sync();
          return await io.stat({ rootId, path: [...location.parts.slice(0, -1), name as string].join('/') });
        } catch (error) {
          (error as FileManagerError).details = { ...((error as FileManagerError).details ?? {}), committed: true, sourceRemoved: true };
          throw error;
        }
      });
    });
  }

  /** Confirm selected names/identities; never enumerate a selected directory here. */
  async function prepareDelete({ items, signal }: { items?: unknown; signal?: AbortSignal } = {}): Promise<DeletePlanView> {
    if (!Array.isArray(items) || items.length === 0 || items.length > DELETE_PLAN_MAX_SELECTIONS) fail('INVALID_REQUEST', `Select between 1 and ${DELETE_PLAN_MAX_SELECTIONS} entries.`);
    if (stopping) fail('SERVICE_STOPPED', 'The file manager is stopping.', 503);
    for (const [id, plan] of deletePlans) if ((!plan.promise || plan.result) && plan.expiresAt < now()) deletePlans.delete(id);
    if (deletePlans.size >= DELETE_PLAN_MAX_PENDING) fail('TOO_MANY_REQUESTS', 'Too many pending deletion confirmations.', 429);
    const selected = items.map((ref: { rootId?: unknown; path?: unknown }) => {
      if (!ref || typeof ref !== 'object') fail('INVALID_REQUEST', 'Each selected entry must have a root and relative path.');
      const parts = partsOf(ref.path);
      if (!parts.length) fail('ROOT_OPERATION_NOT_ALLOWED', 'The root itself cannot be deleted.', 403);
      const root = rootOf(ref.rootId);
      return { rootId: root.id, path: ref.path as string, absolute: path.join(root.path, ...parts) };
    }).sort((a, b) => a.absolute.length - b.absolute.length || a.absolute.localeCompare(b.absolute));
    const unique: Array<{ rootId: string; path: string; absolute: string }> = [];
    for (const ref of selected) if (!unique.some(parent => ref.absolute === parent.absolute || ref.absolute.startsWith(`${parent.absolute}/`))) unique.push(ref);
    const targets = unique.map(({ rootId, path: relativePath }) => ({ rootId, path: relativePath }));
    const entries: DeletePlanEntry[] = [];
    for (const ref of targets) {
      if (signal?.aborted) fail('CANCELLED', 'Deletion preparation was cancelled.', 499);
      entries.push(await withParent(ref, async location => {
        const entry = entryView(ref, await fs.lstat(location.address, { bigint: true }));
        if (!['file', 'directory', 'symlink'].includes(entry.kind)) fail('UNSUPPORTED_ENTRY', 'A selected entry has an unsupported type.', 422);
        const parentIdentity = identity(await location.parent.stat({ bigint: true }));
        await verifyParent(location);
        return { ...entry, parentIdentity };
      }));
    }
    if (signal?.aborted) fail('CANCELLED', 'Deletion preparation was cancelled.', 499);
    // Not a queued mutation: a preparation that spans a shutdown must not leave a
    // confirmation behind for a manager that is going away.
    if (stopping) fail('SERVICE_STOPPED', 'The file manager is stopping.', 503);
    const id = randomUUID();
    const expiresAt = now() + deletePlanTtlMs;
    deletePlans.set(id, { id, targets, entries, expiresAt, promise: null, result: null });
    return {
      id, scope: DELETE_SCOPE, targets: structuredClone(targets), entryCount: entries.length, expiresAt, permanent: true,
      entries: entries.map(({ rootId, path: entryPath, kind, size, version }) => ({ rootId, path: entryPath, kind, size, version })),
    };
  }

  function commitDelete({ planId, confirmed }: { planId?: unknown; confirmed?: unknown } = {}): Promise<DeleteCommitResult> {
    if (confirmed !== true) return Promise.reject(new FileManagerError('CONFIRMATION_REQUIRED', 'Permanent deletion requires explicit confirmation.'));
    const plan = deletePlans.get(planId as string);
    if (!plan) return Promise.reject(new FileManagerError('PLAN_NOT_FOUND', 'The deletion confirmation is no longer available.', 404));
    if (plan.result) return Promise.resolve(structuredClone(plan.result));
    if (plan.promise) return plan.promise.then(result => structuredClone(result));
    if (now() > plan.expiresAt) return Promise.reject(new FileManagerError('PLAN_EXPIRED', 'The deletion confirmation expired. Prepare it again.', 409));
    plan.promise = mutate<DeleteCommitResult>(async () => {
      if (now() > plan.expiresAt) fail('PLAN_EXPIRED', 'The deletion confirmation expired while waiting.', 409);
      const selectedVersions = new Map(plan.entries.filter(entry => entry.kind !== 'directory').map(entry => [entry.identity, entry.version]));
      const check = async (entry: DeletePlanEntry, location: ParentLocation, expectedVersion = entry.version): Promise<BigIntStats> => {
        if (identity(await location.parent.stat({ bigint: true })) !== entry.parentIdentity) fail('PATH_CHANGED', 'The selected parent directory was replaced.', 409);
        await verifyParent(location);
        let current: BigIntStats;
        try { current = await fs.lstat(location.address, { bigint: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('VERSION_CONFLICT', 'A prepared deletion target no longer exists.', 409); throw error; }
        const matches = kindOf(current) === entry.kind && (entry.kind === 'directory'
          ? identity(current) === entry.identity
          : stamp(current) === expectedVersion);
        if (!matches) fail('VERSION_CONFLICT', 'A selected deletion target changed. Review a fresh confirmation.', 409);
        return current;
      };
      // Precheck the selections only, before changing anything. A directory's
      // contents are within the confirmed scope, not a frozen per-file snapshot.
      for (const entry of plan.entries) await withParent(entry, location => check(entry, location));
      const results: DeleteCommitResult['results'] = [];
      for (const entry of plan.entries) {
        const effect: DeletionEffect = { removed: false, contentsChanged: false };
        try {
          await withParent(entry, async location => {
            // Only execution may use a version updated by our own unlink. The
            // precheck above must never merge distinct prepared hard-link stamps.
            const current = await check(entry, location, selectedVersions.get(entry.identity));
            let failed = false;
            let failure: unknown;
            try {
              await deleteTree({
                parent: location.parent, name: location.name, expected: current,
                verifyParent: () => verifyParent(location), selectedVersions, effect,
              });
            } catch (error) { failed = true; failure = error; }
            // The tree walker syncs each changed child directory once. Preserve
            // its first failure and any removal facts even if the parent sync fails.
            if (effect.contentsChanged) {
              try { await location.parent.sync(); }
              catch (error) { if (!failed) { failed = true; failure = error; } }
            }
            if (failed) throw failure;
          });
          results.push({ rootId: entry.rootId, path: entry.path, status: 'completed' });
        } catch (error) {
          const failure = normalizeError(error, { profile: 'control' });
          results.push({
            rootId: entry.rootId, path: entry.path, status: 'failed', ...effect,
            error: { code: failure.code, message: failure.message, details: failure.details },
          });
        }
      }
      const result: DeleteCommitResult = { id: plan.id, status: results.every(item => item.status === 'completed') ? 'completed' : 'partial', results };
      plan.result = result;
      return structuredClone(result);
    }).catch((error: unknown) => { plan.promise = null; throw error; });
    return plan.promise;
  }

  const io = createIO<RootDescriptor>({
    rootOf, openDirectory, partsOf, pathViolation, fdPath, entryView, stamp, identity, mutate, createDirectory,
    assertOpen,
    scheduler,
    maxVerificationBytes,
  });

  async function close(): Promise<void> {
    // Stop accepting new work, then let what is already queued finish: an
    // accepted mutation is a durable promise, not something shutdown cancels.
    // Reads and I/O entry points only start refusing once the drain is done.
    stopping = true;
    await mutationTail;
    closed = true;
    await io.close();
    deletePlans.clear();
  }

  /** The verification budget one operation may spend on this manager. */
  function verificationBudget(): VerificationBudget {
    return createVerificationBudget(maxVerificationBytes);
  }

  return {
    getRoot, list, readText, stat: io.stat, saveText, createFile, createDirectory, rename,
    prepareDelete, commitDelete, io, close, verificationBudget, maxVerificationBytes,
  };
}

export type Manager = ReturnType<typeof createManager>;
