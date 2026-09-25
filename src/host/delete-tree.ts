import { constants, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { fail } from '../contracts/errors.js';
import { DELETE_IO_CONCURRENCY } from '../contracts/limits.js';

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// Linux O_PATH pins an inode without opening its contents, including mode-000 files.
const PATH_FLAGS = 0x200000 | constants.O_NOFOLLOW;
const identity = (stat: BigIntStats): string => `${stat.dev}:${stat.ino}`;
const stamp = (stat: BigIntStats): string => `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const directoryPath = (handle: FileHandle): string => `/proc/self/fd/${handle.fd}`;
const childPath = (handle: FileHandle, name: string | Buffer): Buffer =>
  Buffer.concat([Buffer.from(`${directoryPath(handle)}/`), typeof name === 'string' ? Buffer.from(name) : name]);

export interface DeletionEffect {
  /** The selected name itself was unlinked/rmdir'd, even if a later sync failed. */
  removed: boolean;
  /** At least one name in this selection was actually removed. */
  contentsChanged: boolean;
}

interface DeleteTreeOptions {
  parent: FileHandle;
  name: string;
  expected: BigIntStats;
  verifyParent(): Promise<void>;
  /** Metadata of directly selected files/links, updated only by our own unlink. */
  selectedVersions: Map<string, string>;
  effect: DeletionEffect;
}

/**
 * One execution-time walk, never a prepared subtree manifest. Every child is
 * addressed through its own held parent, with O_NOFOLLOW on directory opens.
 * Directories are visited serially; leaf I/O is bounded and always drained before
 * any descriptor closes. Do not replace this with fs.rm on a /proc/self/fd path:
 * its string-based recursion does not pin intermediate directories and can reject
 * before all of its child operations have finished.
 *
 * This helper deliberately does not acquire the manager's mutation queue again.
 */
export async function deleteTree({ parent, name, expected, verifyParent, selectedVersions, effect }: DeleteTreeOptions): Promise<void> {
  const inodeTails = new Map<string, Promise<void>>();
  const recordRemoval = (selected: boolean, changed: () => void): void => {
    effect.contentsChanged = true;
    if (selected) effect.removed = true;
    changed();
  };

  async function removeLeaf(parent: FileHandle, name: string | Buffer, verify: () => Promise<void>, changed: () => void, selected = false): Promise<void> {
    const address = childPath(parent, name);
    let observed: BigIntStats;
    try { observed = await fs.lstat(address, { bigint: true }); }
    catch (error) { if (!selected && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (observed.isDirectory()) fail('PATH_CHANGED', 'An entry became a directory during deletion.', 409);
    const key = identity(observed);
    const tracked = selectedVersions.has(key);
    const remove = async (): Promise<void> => {
      const before = await fs.lstat(address, { bigint: true });
      if (identity(before) !== key || before.isDirectory()) fail('PATH_CHANGED', 'An entry was replaced during deletion.', 409);
      if ((selected && identity(before) !== identity(expected)) || (tracked && stamp(before) !== selectedVersions.get(key))) {
        fail('VERSION_CONFLICT', 'A selected file changed during deletion.', 409);
      }
      let pinned: FileHandle | undefined;
      try {
        if (tracked) {
          pinned = await fs.open(address, PATH_FLAGS);
          if (stamp(await pinned.stat({ bigint: true })) !== stamp(before)) fail('VERSION_CONFLICT', 'A selected file changed while being pinned.', 409);
        }
        await verify();
        const current = await fs.lstat(address, { bigint: true });
        if (identity(current) !== key || current.isDirectory()
          || (tracked && stamp(current) !== stamp(before))) fail('VERSION_CONFLICT', 'An entry changed before unlink.', 409);
        await fs.unlink(address);
        recordRemoval(selected, changed);
        if (pinned) {
          const after = await pinned.stat({ bigint: true });
          // unlink changes ctime on other hard-link names. Only adopt the exact
          // one-link decrement we just caused; never drop size/mtime/mode checks.
          if (identity(after) === key && after.size === before.size && after.mtimeNs === before.mtimeNs
            && after.mode === before.mode && after.nlink === before.nlink - 1n) {
            selectedVersions.set(key, stamp(after));
          }
        }
      } finally { if (pinned) await pinned.close(); }
    };
    if (!tracked) return remove();
    // Two names of a selected inode can occur in the same leaf batch. Serialize
    // just that inode, so its self-induced ctime updates cannot race one another.
    const previous = inodeTails.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(remove);
    inodeTails.set(key, pending);
    try { await pending; }
    finally { if (inodeTails.get(key) === pending) inodeTails.delete(key); }
  }

  async function removeDirectory(parent: FileHandle, name: string | Buffer, before: BigIntStats, verifyParent: () => Promise<void>, changed: () => void, selected = false): Promise<void> {
    const address = childPath(parent, name);
    await verifyParent();
    const directory = await fs.open(address, DIRECTORY_FLAGS);
    const pending: Promise<void>[] = [];
    let failure: unknown;
    let failed = false;
    let dirty = false;
    const remember = (error: unknown): void => { if (!failed) { failed = true; failure = error; } };
    const drain = async (): Promise<void> => {
      const outcomes = await Promise.allSettled(pending.splice(0));
      for (const outcome of outcomes) if (outcome.status === 'rejected') remember(outcome.reason);
    };
    try {
      const opened = await directory.stat({ bigint: true });
      if (!opened.isDirectory() || identity(opened) !== identity(before)) fail('PATH_CHANGED', 'A directory was replaced while being opened.', 409);
      const verify = async (): Promise<void> => {
        await verifyParent();
        const named = await fs.lstat(address, { bigint: true });
        if (!named.isDirectory() || identity(named) !== identity(opened)) fail('PATH_CHANGED', 'A directory moved or was replaced during deletion.', 409);
      };
      await verify();
      // Keep raw names, including names the UI cannot express and invalid UTF-8.
      // This is one directory's names, not a stat/hash pre-scan of its subtree.
      const children = await fs.readdir(directoryPath(directory), { withFileTypes: true, encoding: 'buffer' });
      const childRemoved = (): void => { dirty = true; };
      for (const child of children) {
        if (child.isDirectory()) {
          await drain();
          try {
            const current = await fs.lstat(childPath(directory, child.name), { bigint: true });
            if (!current.isDirectory()) fail('PATH_CHANGED', 'A child directory was replaced during deletion.', 409);
            await removeDirectory(directory, child.name, current, verify, childRemoved);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') remember(error);
          }
        } else {
          pending.push(removeLeaf(directory, child.name, verify, childRemoved));
          if (pending.length >= DELETE_IO_CONCURRENCY) await drain();
        }
      }
      await drain();
      // Sync once for each changed directory, not once per small file.
      if (dirty) {
        try { await directory.sync(); } catch (error) { remember(error); }
      }
      if (failed) throw failure;
      await verify();
      // A concurrently added member produces a partial failure, never an
      // unbounded rescan or an unconditional recursive cleanup of a new tree.
      await fs.rmdir(address);
      recordRemoval(selected, changed);
    } finally {
      await drain();
      await directory.close();
    }
  }

  if (expected.isDirectory()) await removeDirectory(parent, name, expected, verifyParent, () => {}, true);
  else await removeLeaf(parent, name, verifyParent, () => {}, true);
}
