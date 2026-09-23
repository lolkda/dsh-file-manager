import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { FileManagerError, fail } from '../contracts/errors.js';
import { LIMIT_DEFAULTS } from '../contracts/limits.js';
import { renameNoReplace } from './atomic-rename.js';
import type { HeavyIoScheduler } from './scheduler.js';

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/** Linux O_PATH; the package only ships for linux/x64, where the value is stable. */
const O_PATH = 0x200000;

export type EntryKind = 'file' | 'directory' | 'symlink' | 'other';

type StageState = 'open' | 'committing' | 'committed' | 'failed' | 'aborted';

/** A cheap metadata snapshot. `version` is a weak stamp unless content was read. */
export interface EntryView {
  rootId: string;
  path: string;
  name: string | undefined;
  kind: EntryKind;
  size: number;
  modifiedAt: string;
  version: string;
  identity: string;
  mode: number;
  metadataVersion?: string;
  sha256?: string;
  /** Directory membership captured during planning; internal, never projected. */
  children?: string[] | undefined;
}

/** A directory child whose name the path grammar cannot express; it has no path. */
export interface UnaddressableEntry {
  name: string;
  kind: EntryKind;
  reason: string;
}

export interface EntryListing {
  entries: EntryView[];
  unaddressable: UnaddressableEntry[];
}

/**
 * Per-operation content-verification budget.
 *
 * The budget is charged **once**, with the total file bytes of the operation's
 * own manifest, during planning. How many internal passes the implementation
 * needs afterwards is an implementation detail and never re-charges: a second
 * read of the same bytes is not a second verification of new content. Exceeding
 * the budget refuses the operation; it never verifies less.
 */
export interface VerificationBudget {
  limit: number;
  /** Manifest bytes charged to this operation; 0 means "not charged yet". */
  charged: number;
}

export function createVerificationBudget(limit: number = LIMIT_DEFAULTS.maxVerificationBytes): VerificationBudget {
  if (!Number.isSafeInteger(limit) || limit < 1) fail('INVALID_STATE', 'The content-verification budget is invalid.', 500);
  return { limit, charged: 0 };
}

/** Charge one operation with its manifest total; repeated charges are no-ops. */
export function chargeVerification(budget: VerificationBudget, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) fail('INVALID_STATE', 'A verification charge must be a nonnegative safe integer.', 500);
  if (budget.charged > 0) return;
  if (bytes > budget.limit) {
    fail('TOO_LARGE', 'This operation exceeds the content-verification budget; nothing was published and no verification step was skipped or downgraded.', 413);
  }
  budget.charged = bytes;
}

export interface RootPathRef {
  rootId?: unknown;
  path?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface StatOptions extends RootPathRef {
  /** Binds the stat to a previously observed version; a change is a conflict. */
  expectedVersion?: string | undefined;
  /** Hard bound on the bytes that may be hashed; defaults to the operation budget. */
  maxBytes?: number | undefined;
  /** Metadata only: never reads file content, so the version stays weak. */
  metadataOnly?: boolean | undefined;
  budget?: VerificationBudget | undefined;
}

export interface OpenReadOptions extends RootPathRef {
  expectedVersion?: string | undefined;
  maxBytes?: number | undefined;
  budget?: VerificationBudget | undefined;
}

export interface ReadSource {
  entry: EntryView;
  version: string;
  size: number;
  stream: Readable;
  verify(): Promise<void>;
  close(): Promise<void>;
}

export interface StageValidation {
  bytes?: number | undefined;
  sha256?: string | undefined;
}

export interface StagedEntry {
  ref?: { rootId: string; path: string };
  write(chunk: Uint8Array): Promise<void>;
  commit(validation?: StageValidation): Promise<EntryView>;
  abort(): Promise<void>;
}

export interface DirectoryLease {
  handle: FileHandle;
  address: string;
  entry: EntryView;
  verify(): Promise<void>;
  /** Addressable children only, in readdir order. */
  entries(): Promise<EntryView[]>;
  /** Children the path grammar cannot express, each with the reason. */
  unaddressable(): Promise<UnaddressableEntry[]>;
  /** One enumeration that reports both, so callers never walk the directory twice. */
  listing(): Promise<EntryListing>;
  close(): Promise<void>;
}

export interface RemoveEntryOptions extends RootPathRef {
  kind?: EntryKind | undefined;
  version?: string | undefined;
  identity?: string | undefined;
  sha256?: string | undefined;
  beforeRemove?: (() => Promise<void> | void) | undefined;
  budget?: VerificationBudget | undefined;
}

export interface StageOptions extends RootPathRef {
  overwrite?: boolean | undefined;
  expectedVersion?: string | undefined;
  mode?: number | undefined;
  budget?: VerificationBudget | undefined;
}

export interface RenameEntryOptions {
  source?: RootPathRef | undefined;
  destination?: RootPathRef | undefined;
  expectedVersion?: string | undefined;
  overwrite?: boolean | undefined;
  expectedTargetVersion?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface IODependencies<Root> {
  rootOf(rootId: unknown): Root;
  openDirectory(root: Root, parts: readonly string[]): Promise<FileHandle>;
  /** Throws `INVALID_PATH` for a path the grammar cannot express. */
  partsOf(path: unknown): string[];
  /** The same grammar, reported instead of thrown. */
  pathViolation(path: unknown, allowRoot?: boolean): string | undefined;
  fdPath(handle: FileHandle, child?: string): string;
  entryView(ref: { rootId: string; path: string }, stat: BigIntStats): EntryView;
  stamp(stat: BigIntStats): string;
  identity(stat: BigIntStats): string;
  mutate<T>(operation: () => Promise<T>): Promise<T>;
  createDirectory(ref: RootPathRef): Promise<EntryView>;
  assertOpen(): void;
  /** Shared heavy-IO budget; undefined runs work without a permit. */
  scheduler?: HeavyIoScheduler | undefined;
  maxVerificationBytes?: number | undefined;
}

function missing(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  return undefined;
}

function cancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) fail('CANCELLED', 'The operation was cancelled.', 499);
}

function strongVersion(version: unknown): version is string {
  return typeof version === 'string' && /:[0-9a-f]{64}$/.test(version);
}

function metadataVersion(version: unknown): string | undefined {
  return strongVersion(version) ? version.slice(0, version.lastIndexOf(':')) : typeof version === 'string' ? version : undefined;
}

/** Trusted internal capability API. Addresses are held descriptor paths, never root.path concatenations. */
export function createIO<Root>(dependencies: IODependencies<Root>) {
  const {
    rootOf, openDirectory, partsOf, pathViolation, fdPath, entryView, stamp, identity, mutate, createDirectory, assertOpen,
  } = dependencies;
  const scheduler = dependencies.scheduler;
  const maxVerificationBytes = dependencies.maxVerificationBytes ?? LIMIT_DEFAULTS.maxVerificationBytes;
  const resources = new Set<() => Promise<void>>();
  let stopping = false;

  function available(): void {
    assertOpen();
    if (stopping) fail('SERVICE_STOPPED', 'The file manager is stopping.', 503);
  }

  /** Heavy work holds one shared permit; nested calls reuse their caller's. */
  function heavy<T>(operation: () => Promise<T> | T): Promise<T> {
    return scheduler ? scheduler.run(operation) : Promise.resolve().then(operation);
  }

  function budgetOf(budget: VerificationBudget | undefined): VerificationBudget {
    return budget ?? createVerificationBudget(maxVerificationBytes);
  }

  async function acquireDirectory(ref: RootPathRef = {}): Promise<DirectoryLease> {
    available();
    const parts = partsOf(ref.path ?? '');
    const root = rootOf(ref.rootId);
    const handle = await openDirectory(root, parts);
    const opened = await handle.stat({ bigint: true });
    let closed = false;
    const lease: DirectoryLease = {
      handle, address: fdPath(handle), entry: entryView({ rootId: String(ref.rootId), path: ref.path ?? '' }, opened),
      async verify() {
        available();
        if (closed) fail('RESOURCE_CLOSED', 'The directory lease is closed.', 409);
        if (rootOf(ref.rootId) !== root) fail('ROOT_CHANGED', 'The root grant changed.', 409);
        const current = await openDirectory(root, parts);
        try {
          if (identity(await current.stat({ bigint: true })) !== identity(opened)) fail('PATH_CHANGED', 'The directory path changed while in use.', 409);
        } finally { await current.close(); }
      },
      async listing(): Promise<EntryListing> {
        await lease.verify();
        const before = stamp(await handle.stat({ bigint: true }));
        const children = (await fs.readdir(lease.address)).sort();
        const entries: EntryView[] = [];
        const unaddressable: UnaddressableEntry[] = [];
        for (const name of children) {
          const childPath = ref.path ? `${ref.path}/${name}` : name;
          const violation = pathViolation(childPath, false);
          const stat = await fs.lstat(fdPath(handle, name), { bigint: true });
          // One name the grammar cannot express must never fail the whole listing.
          if (violation !== undefined) {
            unaddressable.push({ name, kind: kindOf(stat), reason: violation });
            continue;
          }
          entries.push(entryView({ rootId: String(ref.rootId), path: childPath }, stat));
        }
        if (stamp(await handle.stat({ bigint: true })) !== before) fail('DIRECTORY_CHANGED', 'The directory changed during enumeration.', 409);
        await lease.verify();
        return { entries, unaddressable };
      },
      async entries(): Promise<EntryView[]> {
        return (await lease.listing()).entries;
      },
      async unaddressable(): Promise<UnaddressableEntry[]> {
        return (await lease.listing()).unaddressable;
      },
      async close() {
        if (closed) return;
        closed = true;
        resources.delete(lease.close);
        await handle.close();
      },
    };
    resources.add(lease.close);
    return lease;
  }

  async function acquireParent(ref: RootPathRef = {}) {
    const parts = partsOf(ref.path ?? '');
    if (!parts.length) fail('ROOT_OPERATION_NOT_ALLOWED', 'The granted root itself cannot be modified.', 403);
    const parent = await acquireDirectory({ rootId: ref.rootId, path: parts.slice(0, -1).join('/') });
    return { parent, name: parts.at(-1) as string, address: fdPath(parent.handle, parts.at(-1)), ref: { rootId: String(ref.rootId), path: ref.path ?? '' } };
  }

  async function stat(ref: StatOptions = {}): Promise<EntryView> {
    cancelled(ref.signal);
    if (ref.path === '' || ref.path === undefined) {
      const lease = await acquireDirectory(ref);
      try { await lease.verify(); return lease.entry; }
      finally { await lease.close(); }
    }
    const location = await acquireParent(ref);
    try {
      const entry = entryView({ rootId: String(ref.rootId), path: ref.path }, await fs.lstat(location.address, { bigint: true }));
      await location.parent.verify();
      if (entry.kind === 'file' && ref.metadataOnly !== true) {
        const source = await openRead({ rootId: ref.rootId, path: ref.path, signal: ref.signal, maxBytes: ref.maxBytes, budget: ref.budget });
        try { return source.entry; }
        finally { await source.close(); }
      }
      return entry;
    } finally { await location.parent.close(); }
  }

  function kindOf(value: BigIntStats): EntryKind {
    if (value.isSymbolicLink()) return 'symlink';
    if (value.isDirectory()) return 'directory';
    if (value.isFile()) return 'file';
    return 'other';
  }

  async function openRead({ rootId, path: relativePath, expectedVersion, signal, maxBytes, budget }: OpenReadOptions = {}): Promise<ReadSource> {
    cancelled(signal);
    const spend = budgetOf(budget);
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) fail('INVALID_REQUEST', 'A raw read bound must be a nonnegative safe integer.');
    const location = await acquireParent({ rootId, path: relativePath, signal });
    let handle: FileHandle | undefined;
    try {
      const named = await fs.lstat(location.address, { bigint: true });
      if (!named.isFile()) fail('UNSUPPORTED_ENTRY', 'Only ordinary files can be streamed; links are not followed.', 422);
      handle = await fs.open(location.address, FILE_FLAGS);
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || stamp(named) !== stamp(before)) fail('VERSION_CONFLICT', 'The source changed while being opened.', 409);
      // A selected source that changed is a conflict, not a size problem.
      if (expectedVersion !== undefined && metadataVersion(expectedVersion) !== stamp(before)) fail('VERSION_CONFLICT', 'The source changed after selection.', 409);
      const bound = Math.min(maxBytes ?? Number.MAX_SAFE_INTEGER, spend.limit);
      if (before.size > BigInt(bound)) {
        fail('TOO_LARGE', 'The file exceeds the content-verification budget for this operation; content hashing was not started.', 413);
      }
      // The permit covers the whole read, including streaming the caller does later.
      const permit = scheduler ? await scheduler.acquire(signal ? { signal } : undefined) : undefined;
      const size = Number(before.size);
      chargeVerification(spend, size);
      async function verifyNamed(): Promise<void> {
        cancelled(signal);
        await location.parent.verify();
        const current = await fs.lstat(location.address, { bigint: true }).catch(missing);
        if (!current || stamp(current) !== stamp(before) || stamp(await (handle as FileHandle).stat({ bigint: true })) !== stamp(before)) {
          fail('VERSION_CONFLICT', 'The source changed while being read.', 409);
        }
      }
      const fingerprint = await hashHandle(handle, size, signal);
      await verifyNamed();
      if (fingerprint.bytes !== size) fail('VERSION_CONFLICT', 'The source size changed while its fingerprint was read.', 409);
      const version = `${stamp(before)}:${fingerprint.sha256}`;
      if (strongVersion(expectedVersion) && expectedVersion !== version) fail('VERSION_CONFLICT', 'The source contents changed after selection.', 409);
      let closed = false;
      let reading: Promise<unknown> | undefined;
      let checking: Promise<void> | undefined;
      const source: ReadSource = {
        entry: { ...entryView({ rootId: String(rootId), path: relativePath ?? '' }, before), metadataVersion: stamp(before), version, sha256: fingerprint.sha256 },
        version, size, stream: null as unknown as Readable,
        verify() {
          checking = (async () => {
            if (closed) fail('RESOURCE_CLOSED', 'The source stream is closed.', 409);
            await verifyNamed();
            const current = await hashHandle(handle as FileHandle, size, signal);
            await verifyNamed();
            if (current.bytes !== size || current.sha256 !== fingerprint.sha256) fail('VERSION_CONFLICT', 'The source contents changed while being streamed.', 409);
          })();
          return checking;
        },
        async close() {
          if (closed) return;
          closed = true;
          resources.delete(source.close);
          signal?.removeEventListener('abort', onAbort);
          source.stream.destroy();
          await reading?.catch(() => {});
          await checking?.catch(() => {});
          await handle?.close();
          permit?.release();
          await location.parent.close();
        },
      };
      source.stream = Readable.from((async function* () {
        let offset = 0;
        const hash = createHash('sha256');
        while (offset < source.size) {
          cancelled(signal);
          if (closed) fail('RESOURCE_CLOSED', 'The source stream was closed.', 409);
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, source.size - offset));
          reading = (handle as FileHandle).read(buffer, 0, buffer.length, offset);
          const { bytesRead } = await reading as { bytesRead: number };
          if (!bytesRead) fail('VERSION_CONFLICT', 'The source shrank while being streamed.', 409);
          offset += bytesRead;
          const chunk = buffer.subarray(0, bytesRead);
          hash.update(chunk);
          yield chunk;
        }
        await verifyNamed();
        if (hash.digest('hex') !== fingerprint.sha256) fail('VERSION_CONFLICT', 'The streamed bytes no longer match the selected content version.', 409);
      })(), { objectMode: false });
      const onAbort = () => source.stream.destroy(new FileManagerError('CANCELLED', 'The read was cancelled.', 499));
      source.stream.on('error', () => {});
      signal?.addEventListener('abort', onAbort, { once: true });
      resources.add(source.close);
      return source;
    } catch (error) {
      if (handle) await handle.close();
      await location.parent.close();
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') fail('UNSUPPORTED_ENTRY', 'Symbolic links are not followed.', 422);
      throw error;
    }
  }

  async function absent(address: string): Promise<void> {
    if (await fs.lstat(address).catch(missing)) fail('ALREADY_EXISTS', 'The destination already exists; no directory merge or overwrite was authorized.', 409);
  }

  function ordinaryMode(mode: number | undefined, fallback: number): number {
    if (mode === undefined) return fallback;
    if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) fail('UNSUPPORTED_ENTRY', 'Only ordinary POSIX permission bits are supported.', 422);
    return mode;
  }

  async function hashHandle(handle: FileHandle, maxBytes: number = Number.MAX_SAFE_INTEGER, signal?: AbortSignal): Promise<{ bytes: number; sha256: string }> {
    const hash = createHash('sha256');
    let bytes = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (bytes <= maxBytes) {
      cancelled(signal);
      available();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes - bytes + 1), bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { bytes, sha256: hash.digest('hex') };
  }

  /** Clean only a held, owned staging subtree; never follow a substituted link. */
  async function clearDirectory(handle: FileHandle): Promise<void> {
    // Final source permissions may be read-only; these are owned disposable stages, not user source directories.
    await handle.chmod(0o700);
    for (const name of await fs.readdir(fdPath(handle))) {
      const address = fdPath(handle, name);
      const original = await fs.lstat(address, { bigint: true });
      if (original.isDirectory()) {
        // Linux O_PATH pins even mode-000 directories without following links. chmod addresses only that held inode.
        const pinned = await fs.open(address, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        let child: FileHandle | undefined;
        try {
          if (identity(await pinned.stat({ bigint: true })) !== identity(original)) fail('PATH_CHANGED', 'A staging directory changed during cleanup.', 409);
          await fs.chmod(fdPath(pinned), 0o700);
          child = await fs.open(`${fdPath(pinned)}/.`, DIRECTORY_FLAGS);
          await clearDirectory(child);
          if (identity(await fs.lstat(address, { bigint: true })) !== identity(original)) fail('PATH_CHANGED', 'A staging directory was replaced during cleanup.', 409);
          await fs.rmdir(address);
        } finally { await child?.close(); await pinned.close(); }
      } else {
        if (stamp(await fs.lstat(address, { bigint: true })) !== stamp(original)) fail('PATH_CHANGED', 'A staging entry changed during cleanup.', 409);
        await fs.unlink(address);
      }
    }
  }

  async function createStage(options: StageOptions = {}, directory = false): Promise<StagedEntry> {
    const { rootId, path: relativePath, overwrite = false, expectedVersion, mode, signal, budget } = options;
    available();
    cancelled(signal);
    const spend = budgetOf(budget);
    if (directory && overwrite) fail('DIRECTORY_CONFLICT', 'Directories cannot be overwritten or merged.', 409);
    if (overwrite && !strongVersion(expectedVersion)) fail('STRONG_VERSION_REQUIRED', 'Overwrite requires a content-bound destination version from an explicit file stat.', 409);
    const requestedMode = ordinaryMode(mode, (directory ? 0o777 : 0o666) & ~process.umask());
    const location = await acquireParent({ rootId, path: relativePath, signal });
    const name = `.dsh-fm-${randomUUID()}.${directory ? 'dir' : 'tmp'}`;
    const address = fdPath(location.parent.handle, name);
    let handle: FileHandle | undefined;
    try {
      await location.parent.verify();
      if (directory) {
        await fs.mkdir(address, { mode: 0o700 });
        handle = await fs.open(address, DIRECTORY_FLAGS);
      } else {
        handle = await fs.open(address, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      }
      const staged = handle;
      const ownedIdentity = identity(await staged.stat({ bigint: true }));
      let state: StageState = 'open';
      const stateOf = (): StageState => state;
      let tail: Promise<unknown> = Promise.resolve();
      let committing: Promise<EntryView> | undefined;
      let receipt: EntryView | undefined;
      let published = false;
      let aborted = false;
      let bytes = 0;
      const writtenHash = createHash('sha256');
      async function owned(): Promise<void> {
        const named = await fs.lstat(address, { bigint: true }).catch(missing);
        if (!named || identity(named) !== ownedIdentity) fail('PATH_CHANGED', 'The owned staging entry was replaced.', 409);
      }
      async function cleanup(): Promise<void> {
        await tail.catch(() => {});
        try {
          const named = await fs.lstat(address, { bigint: true }).catch(missing);
          if (named) {
            if (identity(named) !== ownedIdentity) fail('CLEANUP_FAILED', 'The staging name no longer identifies the owned entry.', 500, { stagingName: name, committed: published });
            if (directory) { await clearDirectory(staged); await fs.rmdir(address); }
            else await fs.unlink(address);
          }
        } finally {
          resources.delete(stage.abort);
          await staged.close();
          await location.parent.close();
        }
      }
      const stage: StagedEntry = {
        ...(directory ? { ref: { rootId: String(rootId), path: [...partsOf(relativePath ?? '').slice(0, -1), name].join('/') } } : {}),
        async write(chunk: Uint8Array): Promise<void> {
          available();
          if (directory || state !== 'open') fail('INVALID_STATE', 'This stage is not open for file data.', 409);
          if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) fail('INVALID_REQUEST', 'A staging chunk must contain raw bytes.');
          const copy = Buffer.from(chunk);
          const result = tail.then(async () => {
            cancelled(signal);
            if (aborted) fail('CANCELLED', 'The staging write was aborted.', 499);
            let offset = 0;
            while (offset < copy.length) {
              const { bytesWritten } = await staged.write(copy, offset, copy.length - offset, bytes + offset);
              if (!bytesWritten) fail('IO_ERROR', 'The staging write made no progress.', 500);
              offset += bytesWritten;
            }
            bytes += copy.length;
            writtenHash.update(copy);
          });
          tail = result;
          return result;
        },
        commit(validation: StageValidation = {}): Promise<EntryView> {
          if (receipt) return Promise.resolve(structuredClone(receipt));
          if (committing) return committing;
          try { available(); }
          catch (error) { return Promise.reject(error); }
          if (state !== 'open') return Promise.reject(new FileManagerError('INVALID_STATE', 'The staging entry is no longer open.', 409));
          state = 'committing';
          committing = mutate(async () => {
            return heavy(async () => {
              await tail;
              cancelled(signal);
              if (aborted) fail('CANCELLED', 'The staging write was aborted.', 499);
              await location.parent.verify();
              await owned();
              let content: { bytes: number; sha256: string } | undefined;
              if (!directory) {
                await staged.sync();
                chargeVerification(spend, bytes);
                content = await hashHandle(staged, bytes, signal);
                if (content.bytes !== bytes || content.sha256 !== writtenHash.copy().digest('hex')
                  || (validation.bytes !== undefined && validation.bytes !== bytes)
                  || (validation.sha256 !== undefined && validation.sha256 !== content.sha256)) {
                  fail('CHECKSUM_MISMATCH', 'The staged data failed byte-count or digest verification.', 409);
                }
              }
              await staged.chmod(requestedMode);
              await staged.sync();
              await location.parent.verify();
              await owned();
              if (overwrite) {
                const target = await fs.lstat(location.address, { bigint: true }).catch(missing);
                if (!target || stamp(target) !== metadataVersion(expectedVersion)) fail('VERSION_CONFLICT', 'The destination changed before publication.', 409);
                if (!target.isFile()) fail('UNSUPPORTED_ENTRY', 'Only an ordinary destination file may be overwritten.', 422);
                const selected = await openRead({ ...location.ref, expectedVersion, signal, budget: spend });
                await selected.close();
              } else await absent(location.address);
              cancelled(signal);
              if (aborted) fail('CANCELLED', 'The staging write was aborted.', 499);
              if (!directory && !overwrite) {
                try { await fs.link(address, location.address); }
                catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('ALREADY_EXISTS', 'The destination appeared before publication.', 409); throw error; }
                published = true;
                await fs.unlink(address);
              } else {
                if (directory) await renameNoReplace(location.parent.handle, name, location.parent.handle, location.name);
                else await fs.rename(address, location.address); // Explicit, strong-version-reviewed file overwrite only.
                published = true;
              }
              await location.parent.handle.sync();
              const target = await fs.lstat(location.address, { bigint: true });
              if (identity(target) !== ownedIdentity) fail('VERSION_CONFLICT', 'The destination changed immediately after publication.', 409, { committed: true });
              if (content) {
                const publishedContent = await hashHandle(staged, bytes, signal);
                if (publishedContent.bytes !== content.bytes || publishedContent.sha256 !== content.sha256) {
                  fail('VERSION_CONFLICT', 'The file contents changed immediately after publication.', 409, { committed: true });
                }
              }
              receipt = { ...entryView(location.ref, target), ...(content ? { ...content, metadataVersion: stamp(target), version: `${stamp(target)}:${content.sha256}` } : {}) };
              state = 'committed';
              await cleanup();
              return structuredClone(receipt);
            });
          }).catch((error: FileManagerError) => {
            state = 'failed';
            if (published) error.details = { ...(error.details ?? {}), committed: true, destination: location.ref };
            throw error;
          });
          return committing;
        },
        async abort(): Promise<void> {
          if (stateOf() === 'aborted' || stateOf() === 'committed') return;
          aborted = true;
          if (committing) await committing.catch(() => {});
          if (stateOf() === 'committed' || stateOf() === 'aborted') return;
          state = 'aborted';
          await cleanup();
        },
      };
      resources.add(stage.abort);
      return stage;
    } catch (error) {
      if (handle) {
        await handle.close();
        if (directory) await fs.rmdir(address).catch(() => {});
        else await fs.unlink(address).catch(() => {});
      }
      await location.parent.close();
      throw error;
    }
  }

  async function renameEntry({ source, destination, expectedVersion, overwrite = false, expectedTargetVersion, signal }: RenameEntryOptions = {}): Promise<EntryView> {
    return mutate(async () => {
      cancelled(signal);
      const from = await acquireParent(source ?? {});
      let to: Awaited<ReturnType<typeof acquireParent>> | undefined;
      let committed = false;
      try {
        to = await acquireParent(destination ?? {});
        const original = await fs.lstat(from.address, { bigint: true });
        if (!original.isFile() && !original.isDirectory()) fail('UNSUPPORTED_ENTRY', 'Copy and move do not include links or special entries.', 422);
        if (stamp(original) !== metadataVersion(expectedVersion)) fail('VERSION_CONFLICT', 'The source changed before the move.', 409);
        if (strongVersion(expectedVersion) && (await stat({ ...source, signal })).version !== expectedVersion) fail('VERSION_CONFLICT', 'The selected source contents changed before the move.', 409);
        const target = await fs.lstat(to.address, { bigint: true }).catch(missing);
        if (target && identity(target) === identity(original)) fail('SAME_ENTRY', 'The source and destination identify the same entry.', 409);
        if (overwrite) {
          if (!strongVersion(expectedTargetVersion)) fail('STRONG_VERSION_REQUIRED', 'Overwrite requires a content-bound target version.', 409);
          if (!target || stamp(target) !== metadataVersion(expectedTargetVersion)) fail('VERSION_CONFLICT', 'The overwrite target changed.', 409);
          if (!target.isFile() || !original.isFile()) fail('DIRECTORY_CONFLICT', 'Directories and links cannot be overwritten or merged.', 409);
          if ((await stat({ ...destination, signal })).version !== expectedTargetVersion) fail('VERSION_CONFLICT', 'The overwrite target contents changed.', 409);
        } else await absent(to.address);
        await from.parent.verify();
        await to.parent.verify();
        if (stamp(await fs.lstat(from.address, { bigint: true })) !== metadataVersion(expectedVersion)) fail('VERSION_CONFLICT', 'The source changed before rename.', 409);
        cancelled(signal);
        if (overwrite) await fs.rename(from.address, to.address);
        else await renameNoReplace(from.parent.handle, from.name, to.parent.handle, to.name);
        committed = true;
        await from.parent.handle.sync();
        await to.parent.handle.sync();
        const current = await fs.lstat(to.address, { bigint: true });
        if (identity(current) !== identity(original)) fail('VERSION_CONFLICT', 'The moved destination changed immediately after rename.', 409);
        return await stat(destination ?? {});
      } catch (error) {
        if (committed) (error as FileManagerError).details = { ...((error as FileManagerError).details ?? {}), committed: true, sourceRemoved: true, destination };
        throw error;
      } finally { await to?.parent.close(); await from.parent.close(); }
    });
  }

  /** Move cleanup only: caller supplies the previously verified, published-copy manifest. */
  async function removeEntry({ rootId, path: relativePath, kind, version, identity: expectedIdentity, sha256, signal, beforeRemove, budget }: RemoveEntryOptions = {}): Promise<{ rootId: string; path: string; removed: true }> {
    return mutate(async () => {
      cancelled(signal);
      const location = await acquireParent({ rootId, path: relativePath, signal });
      let removed = false;
      try {
        const current = await fs.lstat(location.address, { bigint: true });
        if (kind === 'directory') {
          if (!current.isDirectory() || identity(current) !== expectedIdentity) fail('VERSION_CONFLICT', 'The source directory changed before cleanup.', 409);
        } else {
          if (kind !== 'file' || !current.isFile() || stamp(current) !== metadataVersion(version)) fail('VERSION_CONFLICT', 'The source file changed before cleanup.', 409);
          if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) fail('STRONG_VERSION_REQUIRED', 'Source cleanup requires the digest of the actual published copy.', 409);
          const selected = await openRead({ rootId, path: relativePath, expectedVersion: version, maxBytes: Number(current.size), signal, budget });
          try {
            if (selected.entry.sha256 !== sha256) fail('VERSION_CONFLICT', 'The source now contains bytes that were not published at the destination.', 409);
          } finally { await selected.close(); }
        }
        await location.parent.verify();
        cancelled(signal);
        if (beforeRemove !== undefined) {
          if (typeof beforeRemove !== 'function') fail('INVALID_REQUEST', 'The internal deletion proof must be callable.');
          await beforeRemove();
        }
        await location.parent.verify();
        cancelled(signal);
        const finalSource = await fs.lstat(location.address, { bigint: true });
        if (kind === 'directory') {
          if (!finalSource.isDirectory() || identity(finalSource) !== expectedIdentity) fail('VERSION_CONFLICT', 'The source directory changed during final proof validation.', 409);
          await fs.rmdir(location.address);
        } else {
          if (!finalSource.isFile() || stamp(finalSource) !== stamp(current)) fail('VERSION_CONFLICT', 'The source file changed during final proof validation.', 409);
          await fs.unlink(location.address);
        }
        removed = true;
        await location.parent.handle.sync();
        return { rootId: String(rootId), path: relativePath ?? '', removed: true };
      } catch (error) {
        if (removed) (error as FileManagerError).details = { ...((error as FileManagerError).details ?? {}), removed: true };
        throw error;
      } finally { await location.parent.close(); }
    });
  }

  async function close(): Promise<void> {
    stopping = true;
    const failures: unknown[] = [];
    for (const release of [...resources].reverse()) {
      try { await release(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Some file manager I/O resources could not be released.');
  }

  return {
    stat, acquireDirectory, openRead, createDirectory, renameEntry, removeEntry,
    createStagedFile: (options: StageOptions) => createStage(options, false),
    createStagedDirectory: (options: StageOptions) => createStage(options, true),
    close,
  };
}
