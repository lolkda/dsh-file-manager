import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { FileManagerError, fail, normalizeError } from '../contracts/errors.js';
import { DELETE_PLAN_MAX_ENTRIES, DELETE_PLAN_MAX_PENDING, DELETE_PLAN_MAX_SELECTIONS, DIRECTORY_PAGE_DEFAULT, DIRECTORY_PAGE_MAX, LIMIT_DEFAULTS, RELATIVE_PATH_MAX_LENGTH } from '../contracts/limits.js';
import { detectLineEndings, preserveLineEndings } from './line-endings.js';
import {
  chargeVerification, createIO, createVerificationBudget,
  type EntryKind, type EntryView, type RootPathRef, type UnaddressableEntry, type VerificationBudget,
} from './io.js';
import { renameNoReplace } from './atomic-rename.js';
import type { HeavyIoScheduler } from './scheduler.js';

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const names = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** A stored root grant. Frozen once persisted; never silently repaired. */
export interface RootDescriptor {
  id: string;
  provider: 'host-local';
  path: string;
  label: string;
  identity: string;
  createdAt: string;
}

export interface RootPathInput {
  rootId?: unknown;
  path?: string | undefined;
}

export interface ManagerOptions {
  initialRoots?: readonly RootDescriptor[] | undefined;
  persistRoots?: ((roots: RootDescriptor[]) => Promise<void>) | undefined;
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
  targets: DeleteTarget[];
  entryCount: number;
  expiresAt: number;
  permanent: true;
  entries: Array<{ rootId: string; path: string; kind: EntryKind; size: number; version: string }>;
}

export interface DeleteCommitResult {
  id: string;
  status: 'completed' | 'partial';
  results: Array<{ rootId: string; path: string; status: 'completed' | 'failed'; removed?: boolean; error?: { code: string; message: string; details?: Record<string, unknown> } }>;
}

interface DeletePlanEntry extends EntryView {
  children?: string[] | undefined;
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
const descriptor = (root: RootDescriptor): RootDescriptor => ({ ...root });

/**
 * The root-relative path grammar, reported rather than thrown, so a directory
 * listing can show a name it cannot address instead of failing as a whole.
 */
export function pathViolation(relativePath: unknown, allowRoot = true): string | undefined {
  if (typeof relativePath !== 'string') return 'it is not a string';
  if (relativePath.length > RELATIVE_PATH_MAX_LENGTH) return `it exceeds ${RELATIVE_PATH_MAX_LENGTH} characters`;
  if (/[\x00-\x1f\\]/.test(relativePath)) return 'it contains control characters or a backslash';
  if (path.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) return 'it is absolute';
  if (relativePath === '') return allowRoot ? undefined : 'it names the granted root';
  if (relativePath.split('/').some(part => part === '' || part === '.' || part === '..')) return 'it contains an empty or dot segment';
  return undefined;
}

/** Internal paths address held directory descriptors, never untrusted ancestors. */
function fdPath(handle: FileHandle, child = ''): string {
  if (process.platform !== 'linux') fail('UNSUPPORTED_PLATFORM', 'This release requires a Linux Host.', 422);
  return `/proc/self/fd/${handle.fd}${child ? `/${child}` : ''}`;
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

/** Create a Host-local manager. No Agent or Session is ever acquired. */
export function createManager(options: ManagerOptions = {}) {
  const {
    initialRoots = [], persistRoots = async () => {}, now = Date.now,
    deletePlanTtlMs = LIMIT_DEFAULTS.deletePlanTtlMs,
    maxTextBytes = LIMIT_DEFAULTS.maxTextBytes,
    maxVerificationBytes = LIMIT_DEFAULTS.maxVerificationBytes,
    scheduler,
  } = options;
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1 || maxTextBytes > 32 * 1024 * 1024) fail('INVALID_STATE', 'The text size limit is invalid.', 500);
  const roots = new Map<string, RootDescriptor>();
  for (const root of initialRoots) {
    if (!root || typeof root.id !== 'string' || !root.id || root.provider !== 'host-local'
      || typeof root.path !== 'string' || !path.isAbsolute(root.path)
      || typeof root.identity !== 'string' || !/^\d+:\d+$/.test(root.identity) || roots.has(root.id)) {
      fail('INVALID_STATE', 'Stored root grants are invalid; no grants were silently discarded.', 500);
    }
    roots.set(root.id, Object.freeze({ ...root }));
  }
  let mutationTail: Promise<unknown> = Promise.resolve();
  let closed = false;
  const deletePlans = new Map<string, DeletePlan>();
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new FileManagerError('SERVICE_STOPPED', 'The file manager is stopping.', 503));
    const result = mutationTail.then(operation);
    mutationTail = result.catch(() => {});
    return result;
  };

  function rootOf(rootId: unknown): RootDescriptor {
    if (typeof rootId !== 'string' || !roots.has(rootId)) fail('ROOT_NOT_FOUND', 'The root grant no longer exists.', 404);
    return roots.get(rootId as string) as RootDescriptor;
  }

  /** Open and identity-check the granted root before walking any descendants. */
  async function openRoot(root: RootDescriptor): Promise<FileHandle> {
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(root.path, DIRECTORY_FLAGS);
      const stat = await handle.stat({ bigint: true });
      const actual = await fs.realpath(fdPath(handle));
      if (!stat.isDirectory() || identity(stat) !== root.identity || actual !== root.path) {
        fail('ROOT_CHANGED', 'The directory at this path is no longer the granted root.', 409);
      }
      return handle;
    } catch (error) {
      if (handle) await handle.close();
      if (error instanceof FileManagerError) throw error;
      fail('ROOT_UNAVAILABLE', 'The granted directory is unavailable.', 409, { cause: (error as NodeJS.ErrnoException).code });
    }
  }

  /** Descend via held descriptors and reject symlinks at every user path segment. */
  async function openDirectory(root: RootDescriptor, parts: readonly string[]): Promise<FileHandle> {
    let current = await openRoot(root);
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

  async function addRoot({ path: requestedPath }: { path?: unknown } = {}): Promise<RootDescriptor> {
    return mutate(async () => {
      if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath) || /[\x00-\x1f]/.test(requestedPath)) {
        fail('INVALID_PATH', 'Adding a root requires an existing absolute directory path.');
      }
      const canonical = await fs.realpath(requestedPath);
      const handle = await fs.open(canonical, DIRECTORY_FLAGS);
      try {
        const stat = await handle.stat({ bigint: true });
        if (!stat.isDirectory()) fail('NOT_DIRECTORY', 'The selected root is not a directory.', 422);
        if (await fs.realpath(fdPath(handle)) !== canonical) fail('ROOT_CHANGED', 'The directory changed during selection.', 409);
        for (const root of roots.values()) {
          if (root.identity === identity(stat) && root.path === canonical) return descriptor(root);
        }
        const root: RootDescriptor = Object.freeze({
          id: randomUUID(), provider: 'host-local', path: canonical,
          label: path.basename(canonical) || canonical, identity: identity(stat),
          createdAt: new Date(now()).toISOString(),
        });
        await persistRoots([...listRoots(), descriptor(root)]);
        roots.set(root.id, root);
        return descriptor(root);
      } finally {
        await handle.close();
      }
    });
  }

  function listRoots(): RootDescriptor[] {
    return [...roots.values()].map(descriptor);
  }

  async function removeRoot({ rootId }: RootPathInput = {}): Promise<{ rootId: string; removed: true }> {
    return mutate(async () => {
      const root = rootOf(rootId);
      await persistRoots(listRoots().filter(candidate => candidate.id !== root.id));
      roots.delete(root.id);
      return { rootId: root.id, removed: true };
    });
  }

  async function list({ rootId, path: relativePath = '', limit = DIRECTORY_PAGE_DEFAULT, cursor }: ListInput = {}): Promise<ListResult> {
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
    if (!parts.length) fail('ROOT_OPERATION_NOT_ALLOWED', 'The granted root itself cannot be modified or deleted.', 403);
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
    if (rootOf(location.rootId) !== location.root) fail('ROOT_CHANGED', 'The grant changed while the operation was pending.', 409);
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

  async function statEntry(ref: RootPathRef): Promise<EntryView> {
    return withParent(ref, async location => entryView({ rootId: String(ref.rootId), path: ref.path as string }, await fs.lstat(location.address, { bigint: true })));
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

  function rename({ rootId, path: relativePath, name, expectedVersion }: {
    rootId?: unknown; path?: string | undefined; name?: unknown; expectedVersion?: unknown;
  } = {}): Promise<EntryView> {
    return mutate(async () => {
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
        await renameNoReplace(location.parent, location.name, location.parent, name as string);
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

  /** Bind deletion to a server-held, postorder manifest rather than a fresh rm -r walk. */
  async function prepareDelete({ items, signal }: { items?: unknown; signal?: AbortSignal } = {}): Promise<DeletePlanView> {
    if (!Array.isArray(items) || items.length === 0 || items.length > DELETE_PLAN_MAX_SELECTIONS) fail('INVALID_REQUEST', `Select between 1 and ${DELETE_PLAN_MAX_SELECTIONS} entries.`);
    for (const [id, plan] of deletePlans) if ((!plan.promise || plan.result) && plan.expiresAt < now()) deletePlans.delete(id);
    if (deletePlans.size >= DELETE_PLAN_MAX_PENDING) fail('TOO_MANY_REQUESTS', 'Too many pending deletion confirmations.', 429);
    const selected = items.map((ref: { rootId?: unknown; path?: unknown }) => {
      if (!ref || typeof ref !== 'object') fail('INVALID_REQUEST', 'Each selected entry must have a root and relative path.');
      const parts = partsOf(ref.path);
      if (!parts.length) fail('ROOT_OPERATION_NOT_ALLOWED', 'The granted root itself cannot be deleted.', 403);
      const root = rootOf(ref.rootId);
      return { rootId: root.id, path: ref.path as string, absolute: path.join(root.path, ...parts) };
    }).sort((a, b) => a.absolute.length - b.absolute.length || a.absolute.localeCompare(b.absolute));
    const unique: Array<{ rootId: string; path: string; absolute: string }> = [];
    for (const ref of selected) if (!unique.some(parent => ref.absolute === parent.absolute || ref.absolute.startsWith(`${parent.absolute}/`))) unique.push(ref);
    const targets = unique.map(({ rootId, path: relativePath }) => ({ rootId, path: relativePath }));
    const entries: DeletePlanEntry[] = [];
    // One budget for the whole manifest: a plan that would verify more bytes
    // than the profile allows is refused instead of verified more cheaply.
    const spend = createVerificationBudget(maxVerificationBytes);
    // Metadata-only measurement first, so an over-budget plan is refused before
    // a single byte of file content is read.
    let plannedBytes = 0;
    async function measure(ref: { rootId: string; path: string }): Promise<void> {
      if (signal?.aborted) fail('CANCELLED', 'Deletion preparation was cancelled.', 499);
      const entry = await io.stat({ ...ref, signal, metadataOnly: true });
      if (!['file', 'directory', 'symlink'].includes(entry.kind)) fail('UNSUPPORTED_ENTRY', 'A selected tree contains an unsupported entry.', 422);
      if (entry.kind === 'file') plannedBytes += entry.size;
      if (entry.kind !== 'directory') return;
      const directory = await openDirectory(rootOf(ref.rootId), partsOf(ref.path));
      let children: string[];
      try { children = (await fs.readdir(fdPath(directory))).sort(); }
      finally { await directory.close(); }
      for (const child of children) {
        const childPath = `${ref.path}/${child}`;
        if (pathViolation(childPath, false) !== undefined) {
          fail('UNREPRESENTABLE_REFERENCE', 'This entry name cannot be represented safely by the current path grammar; it cannot be deleted or included in an operation.', 422);
        }
        await measure({ rootId: ref.rootId, path: childPath });
      }
    }
    for (const ref of targets) await measure(ref);
    chargeVerification(spend, plannedBytes);
    async function collect(ref: { rootId: string; path: string }): Promise<void> {
      if (signal?.aborted) fail('CANCELLED', 'Deletion preparation was cancelled.', 499);
      if (entries.length >= DELETE_PLAN_MAX_ENTRIES) fail('TOO_LARGE', `The deletion manifest exceeds ${DELETE_PLAN_MAX_ENTRIES} entries.`, 413);
      const entry: DeletePlanEntry = await io.stat({ ...ref, signal, budget: spend });
      if (!['file', 'directory', 'symlink'].includes(entry.kind)) fail('UNSUPPORTED_ENTRY', 'A selected tree contains an unsupported entry.', 422);
      if (entry.kind === 'directory') {
        const directory = await openDirectory(rootOf(ref.rootId), partsOf(ref.path));
        let children: string[];
        try { children = (await fs.readdir(fdPath(directory))).sort(); }
        finally { await directory.close(); }
        for (const child of children) {
          const childPath = `${ref.path}/${child}`;
          if (pathViolation(childPath, false) !== undefined) {
            fail('UNREPRESENTABLE_REFERENCE', 'This entry name cannot be represented safely by the current path grammar; it cannot be deleted or included in an operation.', 422);
          }
          await collect({ rootId: ref.rootId, path: childPath });
        }
        entry.children = children;
        if ((await statEntry(ref)).version !== entry.version) fail('VERSION_CONFLICT', 'The directory changed during deletion preparation.', 409);
      }
      if (entries.length >= DELETE_PLAN_MAX_ENTRIES) fail('TOO_LARGE', `The deletion manifest exceeds ${DELETE_PLAN_MAX_ENTRIES} entries.`, 413);
      entries.push(entry);
    }
    for (const ref of targets) await collect(ref);
    const id = randomUUID();
    const expiresAt = now() + deletePlanTtlMs;
    deletePlans.set(id, { id, targets, entries, expiresAt, promise: null, result: null });
    return {
      id, targets: structuredClone(targets), entryCount: entries.length, expiresAt, permanent: true,
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
      for (const entry of plan.entries) {
        let current: EntryView;
        try { current = await io.stat({ ...entry, budget: createVerificationBudget(maxVerificationBytes) }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('VERSION_CONFLICT', 'A prepared deletion target no longer exists.', 409); throw error; }
        if (current.version !== entry.version) fail('VERSION_CONFLICT', 'A prepared deletion target changed. Review a fresh confirmation.', 409);
        if (entry.kind === 'directory') {
          const directory = await openDirectory(rootOf(entry.rootId), partsOf(entry.path));
          try {
            const children = (await fs.readdir(fdPath(directory))).sort();
            if (children.join('\0') !== (entry.children ?? []).join('\0')) fail('VERSION_CONFLICT', 'The prepared directory membership changed. Review a fresh confirmation.', 409);
          } finally { await directory.close(); }
        }
      }
      const results: DeleteCommitResult['results'] = [];
      for (const entry of plan.entries) {
        let removed = false;
        try {
          await withParent(entry, async location => {
            const current = await fs.lstat(location.address, { bigint: true });
            const matches = entry.kind === 'directory' ? identity(current) === entry.identity && current.isDirectory()
              : entry.kind === 'file' ? current.isFile() && (await io.stat({ ...entry, budget: createVerificationBudget(maxVerificationBytes) })).version === entry.version
                : stamp(current) === entry.version;
            if (!matches) fail('VERSION_CONFLICT', 'The target changed during deletion.', 409);
            await verifyParent(location);
            if (entry.kind === 'directory') await fs.rmdir(location.address);
            else await fs.unlink(location.address);
            removed = true;
            await location.parent.sync();
          });
          results.push({ rootId: entry.rootId, path: entry.path, status: 'completed' });
        } catch (error) {
          const failure = normalizeError(error, { profile: 'control' });
          results.push({
            rootId: entry.rootId, path: entry.path, status: 'failed', removed,
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
    assertOpen() { if (closed) fail('SERVICE_STOPPED', 'The file manager is stopping.', 503); },
    scheduler,
    maxVerificationBytes,
  });

  async function close(): Promise<void> {
    closed = true;
    await mutationTail;
    await io.close();
    deletePlans.clear();
  }

  /** The verification budget one operation may spend on this manager. */
  function verificationBudget(): VerificationBudget {
    return createVerificationBudget(maxVerificationBytes);
  }

  return {
    addRoot, listRoots, removeRoot, list, readText, stat: io.stat, saveText, createFile, createDirectory, rename,
    prepareDelete, commitDelete, io, close, verificationBudget, maxVerificationBytes,
  };
}

export type Manager = ReturnType<typeof createManager>;
