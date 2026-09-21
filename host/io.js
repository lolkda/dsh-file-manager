import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { fail, FileManagerError } from '../contracts/errors.js';
import { renameNoReplace } from './atomic-rename.js';

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const missing = error => { if (error.code !== 'ENOENT') throw error; return undefined; };
const cancelled = signal => { if (signal?.aborted) fail('CANCELLED', 'The operation was cancelled.', 499); };
const strongVersion = version => typeof version === 'string' && /:[0-9a-f]{64}$/.test(version);
const metadataVersion = version => strongVersion(version) ? version.slice(0, version.lastIndexOf(':')) : version;

/** Trusted internal capability API. Addresses are held descriptor paths, never root.path concatenations. */
export function createIO({ rootOf, openDirectory, partsOf, fdPath, entryView, stamp, identity, mutate, createDirectory, assertOpen }) {
  const resources = new Set();
  let stopping = false;
  function available() {
    assertOpen();
    if (stopping) fail('SERVICE_STOPPED', 'The file manager is stopping.', 503);
  }

  async function acquireDirectory({ rootId, path = '' } = {}) {
    available();
    const parts = partsOf(path);
    const root = rootOf(rootId);
    const handle = await openDirectory(root, parts);
    const opened = await handle.stat({ bigint: true });
    let closed = false;
    const lease = {
      handle, address: fdPath(handle), entry: entryView({ rootId, path }, opened),
      async verify() {
        available();
        if (closed) fail('RESOURCE_CLOSED', 'The directory lease is closed.', 409);
        if (rootOf(rootId) !== root) fail('ROOT_CHANGED', 'The root grant changed.', 409);
        const current = await openDirectory(root, parts);
        try {
          if (identity(await current.stat({ bigint: true })) !== identity(opened)) fail('PATH_CHANGED', 'The directory path changed while in use.', 409);
        } finally { await current.close(); }
      },
      async entries() {
        await lease.verify();
        const before = stamp(await handle.stat({ bigint: true }));
        const children = (await fs.readdir(lease.address)).sort();
        const result = [];
        for (const name of children) {
          // The filesystem may contain names outside the UI path grammar. Never turn these into unchecked refs.
          const childPath = path ? `${path}/${name}` : name;
          partsOf(childPath);
          result.push(entryView({ rootId, path: childPath }, await fs.lstat(fdPath(handle, name), { bigint: true })));
        }
        if (stamp(await handle.stat({ bigint: true })) !== before) fail('DIRECTORY_CHANGED', 'The directory changed during enumeration.', 409);
        await lease.verify();
        return result;
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

  async function acquireParent(ref = {}) {
    const parts = partsOf(ref.path);
    if (!parts.length) fail('ROOT_OPERATION_NOT_ALLOWED', 'The granted root itself cannot be modified.', 403);
    const parent = await acquireDirectory({ rootId: ref.rootId, path: parts.slice(0, -1).join('/') });
    return { parent, name: parts.at(-1), address: fdPath(parent.handle, parts.at(-1)), ref: { rootId: ref.rootId, path: ref.path } };
  }

  async function stat(ref = {}) {
    cancelled(ref.signal);
    if (ref.path === '') {
      const lease = await acquireDirectory(ref);
      try { await lease.verify(); return lease.entry; }
      finally { await lease.close(); }
    }
    const location = await acquireParent(ref);
    try {
      const entry = entryView(ref, await fs.lstat(location.address, { bigint: true }));
      await location.parent.verify();
      if (entry.kind === 'file') {
        const source = await openRead(ref);
        try { return source.entry; }
        finally { await source.close(); }
      }
      return entry;
    } finally { await location.parent.close(); }
  }

  async function openRead({ rootId, path, expectedVersion, signal, maxBytes = Number.MAX_SAFE_INTEGER } = {}) {
    cancelled(signal);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail('INVALID_REQUEST', 'A raw read bound must be a nonnegative safe integer.');
    const location = await acquireParent({ rootId, path });
    let handle;
    try {
      const named = await fs.lstat(location.address, { bigint: true });
      if (!named.isFile()) fail('UNSUPPORTED_ENTRY', 'Only ordinary files can be streamed; links are not followed.', 422);
      handle = await fs.open(location.address, FILE_FLAGS);
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || stamp(named) !== stamp(before)) fail('VERSION_CONFLICT', 'The source changed while being opened.', 409);
      if (before.size > BigInt(maxBytes)) fail('TOO_LARGE', 'The file exceeds the configured bound; content hashing was not started.', 413);
      if (expectedVersion !== undefined && metadataVersion(expectedVersion) !== stamp(before)) fail('VERSION_CONFLICT', 'The source changed after selection.', 409);
      const size = Number(before.size);
      async function verifyNamed() {
        cancelled(signal);
        await location.parent.verify();
        const current = await fs.lstat(location.address, { bigint: true }).catch(missing);
        if (!current || stamp(current) !== stamp(before) || stamp(await handle.stat({ bigint: true })) !== stamp(before)) {
          fail('VERSION_CONFLICT', 'The source changed while being read.', 409);
        }
      }
      const fingerprint = await hashHandle(handle, size, signal);
      await verifyNamed();
      if (fingerprint.bytes !== size) fail('VERSION_CONFLICT', 'The source size changed while its fingerprint was read.', 409);
      const version = `${stamp(before)}:${fingerprint.sha256}`;
      if (strongVersion(expectedVersion) && expectedVersion !== version) fail('VERSION_CONFLICT', 'The source contents changed after selection.', 409);
      let closed = false;
      let reading;
      let checking;
      const source = {
        entry: { ...entryView({ rootId, path }, before), metadataVersion: stamp(before), version, sha256: fingerprint.sha256 },
        version, size, stream: null,
        verify() {
          checking = (async () => {
            if (closed) fail('RESOURCE_CLOSED', 'The source stream is closed.', 409);
            await verifyNamed();
            const current = await hashHandle(handle, size, signal);
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
          await handle.close();
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
          reading = handle.read(buffer, 0, buffer.length, offset);
          const { bytesRead } = await reading;
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
      if (error.code === 'ELOOP') fail('UNSUPPORTED_ENTRY', 'Symbolic links are not followed.', 422);
      throw error;
    }
  }

  async function absent(address) {
    if (await fs.lstat(address).catch(missing)) fail('ALREADY_EXISTS', 'The destination already exists; no directory merge or overwrite was authorized.', 409);
  }
  function ordinaryMode(mode, fallback) {
    if (mode === undefined) return fallback;
    if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) fail('UNSUPPORTED_ENTRY', 'Only ordinary POSIX permission bits are supported.', 422);
    return mode;
  }
  async function hashHandle(handle, maxBytes = Number.MAX_SAFE_INTEGER, signal) {
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
  async function clearDirectory(handle) {
    // Final source permissions may be read-only; these are owned disposable stages, not user source directories.
    await handle.chmod(0o700);
    for (const name of await fs.readdir(fdPath(handle))) {
      const address = fdPath(handle, name);
      const original = await fs.lstat(address, { bigint: true });
      if (original.isDirectory()) {
        // Linux O_PATH pins even mode-000 directories without following links. chmod addresses only that held inode.
        const pinned = await fs.open(address, (constants.O_PATH ?? 0x200000) | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        let child;
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

  async function createStage({ rootId, path, overwrite = false, expectedVersion, mode, signal } = {}, directory = false) {
    available();
    cancelled(signal);
    if (directory && overwrite) fail('DIRECTORY_CONFLICT', 'Directories cannot be overwritten or merged.', 409);
    if (overwrite && !strongVersion(expectedVersion)) fail('STRONG_VERSION_REQUIRED', 'Overwrite requires a content-bound destination version from an explicit file stat.', 409);
    const requestedMode = ordinaryMode(mode, (directory ? 0o777 : 0o666) & ~process.umask());
    const location = await acquireParent({ rootId, path });
    const name = `.dsh-fm-${randomUUID()}.${directory ? 'dir' : 'tmp'}`;
    const address = fdPath(location.parent.handle, name);
    let handle;
    try {
      await location.parent.verify();
      if (directory) {
        await fs.mkdir(address, { mode: 0o700 });
        handle = await fs.open(address, DIRECTORY_FLAGS);
      } else {
        handle = await fs.open(address, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      }
      const ownedIdentity = identity(await handle.stat({ bigint: true }));
      let state = 'open';
      let tail = Promise.resolve();
      let committing;
      let receipt;
      let published = false;
      let aborted = false;
      let bytes = 0;
      const writtenHash = createHash('sha256');
      async function owned() {
        const named = await fs.lstat(address, { bigint: true }).catch(missing);
        if (!named || identity(named) !== ownedIdentity) fail('PATH_CHANGED', 'The owned staging entry was replaced.', 409);
      }
      async function cleanup() {
        await tail.catch(() => {});
        try {
          const named = await fs.lstat(address, { bigint: true }).catch(missing);
          if (named) {
            if (identity(named) !== ownedIdentity) fail('CLEANUP_FAILED', 'The staging name no longer identifies the owned entry.', 500, { stagingName: name, committed: published });
            if (directory) { await clearDirectory(handle); await fs.rmdir(address); }
            else await fs.unlink(address);
          }
        } finally {
          resources.delete(stage.abort);
          await handle.close();
          await location.parent.close();
        }
      }
      const stage = {
        ...(directory ? { ref: { rootId, path: [...partsOf(path).slice(0, -1), name].join('/') } } : {}),
        async write(chunk) {
          available();
          if (directory || state !== 'open') fail('INVALID_STATE', 'This stage is not open for file data.', 409);
          if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) fail('INVALID_REQUEST', 'A staging chunk must contain raw bytes.');
          const copy = Buffer.from(chunk);
          const result = tail.then(async () => {
            cancelled(signal);
            if (aborted) fail('CANCELLED', 'The staging write was aborted.', 499);
            let offset = 0;
            while (offset < copy.length) {
              const { bytesWritten } = await handle.write(copy, offset, copy.length - offset, bytes + offset);
              if (!bytesWritten) fail('IO_ERROR', 'The staging write made no progress.', 500);
              offset += bytesWritten;
            }
            bytes += copy.length;
            writtenHash.update(copy);
          });
          tail = result;
          return result;
        },
        commit(validation = {}) {
          if (receipt) return Promise.resolve(structuredClone(receipt));
          if (committing) return committing;
          try { available(); }
          catch (error) { return Promise.reject(error); }
          if (state !== 'open') return Promise.reject(new FileManagerError('INVALID_STATE', 'The staging entry is no longer open.', 409));
          state = 'committing';
          committing = mutate(async () => {
            await tail;
            cancelled(signal);
            if (aborted) fail('CANCELLED', 'The staging write was aborted.', 499);
            await location.parent.verify();
            await owned();
            let content;
            if (!directory) {
              await handle.sync();
              content = await hashHandle(handle, bytes, signal);
              if (content.bytes !== bytes || content.sha256 !== writtenHash.copy().digest('hex')
                || (validation.bytes !== undefined && validation.bytes !== bytes)
                || (validation.sha256 !== undefined && validation.sha256 !== content.sha256)) {
                fail('CHECKSUM_MISMATCH', 'The staged data failed byte-count or digest verification.', 409);
              }
            }
            await handle.chmod(requestedMode);
            await handle.sync();
            await location.parent.verify();
            await owned();
            if (overwrite) {
              const target = await fs.lstat(location.address, { bigint: true }).catch(missing);
              if (!target || stamp(target) !== metadataVersion(expectedVersion)) fail('VERSION_CONFLICT', 'The destination changed before publication.', 409);
              if (!target.isFile()) fail('UNSUPPORTED_ENTRY', 'Only an ordinary destination file may be overwritten.', 422);
              const selected = await openRead({ ...location.ref, expectedVersion, signal });
              await selected.close();
            } else await absent(location.address);
            cancelled(signal);
            if (aborted) fail('CANCELLED', 'The staging write was aborted.', 499);
            if (!directory && !overwrite) {
              try { await fs.link(address, location.address); }
              catch (error) { if (error.code === 'EEXIST') fail('ALREADY_EXISTS', 'The destination appeared before publication.', 409); throw error; }
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
              const publishedContent = await hashHandle(handle, bytes, signal);
              if (publishedContent.bytes !== content.bytes || publishedContent.sha256 !== content.sha256) {
                fail('VERSION_CONFLICT', 'The file contents changed immediately after publication.', 409, { committed: true });
              }
            }
            receipt = { ...entryView(location.ref, target), ...(content ? { ...content, metadataVersion: stamp(target), version: `${stamp(target)}:${content.sha256}` } : {}) };
            state = 'committed';
            await cleanup();
            return structuredClone(receipt);
          }).catch(error => {
            state = 'failed';
            if (published) error.details = { ...(error.details ?? {}), committed: true, destination: location.ref };
            throw error;
          });
          return committing;
        },
        async abort() {
          if (state === 'aborted' || state === 'committed') return;
          aborted = true;
          if (committing) await committing.catch(() => {});
          if (state === 'committed' || state === 'aborted') return;
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

  async function renameEntry({ source, destination, expectedVersion, overwrite = false, expectedTargetVersion, signal } = {}) {
    return mutate(async () => {
      cancelled(signal);
      const from = await acquireParent(source);
      let to;
      let committed = false;
      try {
        to = await acquireParent(destination);
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
        return await stat(destination);
      } catch (error) {
        if (committed) error.details = { ...(error.details ?? {}), committed: true, sourceRemoved: true, destination };
        throw error;
      } finally { await to?.parent.close(); await from.parent.close(); }
    });
  }

  /** Move cleanup only: caller supplies the previously verified, published-copy manifest. */
  async function removeEntry({ rootId, path, kind, version, identity: expectedIdentity, sha256, signal, beforeRemove } = {}) {
    return mutate(async () => {
      cancelled(signal);
      const location = await acquireParent({ rootId, path });
      let removed = false;
      try {
        const current = await fs.lstat(location.address, { bigint: true });
        if (kind === 'directory') {
          if (!current.isDirectory() || identity(current) !== expectedIdentity) fail('VERSION_CONFLICT', 'The source directory changed before cleanup.', 409);
        } else {
          if (kind !== 'file' || !current.isFile() || stamp(current) !== metadataVersion(version)) fail('VERSION_CONFLICT', 'The source file changed before cleanup.', 409);
          if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) fail('STRONG_VERSION_REQUIRED', 'Source cleanup requires the digest of the actual published copy.', 409);
          const selected = await openRead({ rootId, path, expectedVersion: version, maxBytes: Number(current.size), signal });
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
        return { rootId, path, removed: true };
      } catch (error) {
        if (removed) error.details = { ...(error.details ?? {}), removed: true };
        throw error;
      } finally { await location.parent.close(); }
    });
  }

  async function close() {
    stopping = true;
    const failures = [];
    for (const release of [...resources].reverse()) {
      try { await release(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Some file manager I/O resources could not be released.');
  }

  return {
    stat, acquireDirectory, openRead, createDirectory, renameEntry, removeEntry,
    createStagedFile: options => createStage(options, false),
    createStagedDirectory: options => createStage(options, true),
    close,
  };
}
