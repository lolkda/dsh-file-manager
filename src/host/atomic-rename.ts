import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getSystemErrorName } from 'node:util';
import { FileManagerError, fail, isFileManagerError } from '../contracts/errors.js';

/**
 * The helper ships at the package root, outside `dist/`, so this specifier
 * resolves to the same binary from `src/host/` and from `dist/host/`.
 */
const executable = fileURLToPath(new URL('../../host/native/rename-no-replace', import.meta.url));

/** Only the descriptor of the directory that holds the leaf name is needed. */
export interface AtomicRenameDirectory {
  readonly fd: number;
}

/**
 * Never fall back to check-then-rename when the kernel cannot enforce
 * no-replace: an unprovable outcome is reported, not guessed.
 */
export function renameNoReplace(
  sourceParent: AtomicRenameDirectory,
  sourceName: string,
  destinationParent: AtomicRenameDirectory,
  destinationName: string,
): Promise<void> {
  if (process.platform !== 'linux') fail('UNSUPPORTED_ATOMIC_RENAME', 'Atomic no-replace rename requires the Linux helper.', 501);
  for (const name of [sourceName, destinationName]) {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\0]/.test(name)) fail('INVALID_PATH', 'Atomic rename accepts only leaf names.');
  }
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [sourceName, destinationName], {
      stdio: ['ignore', 'pipe', 'pipe', sourceParent.fd, destinationParent.fd],
      windowsHide: true,
    });
    const { stdout, stderr } = child;
    if (!stdout || !stderr) {
      child.kill();
      reject(new FileManagerError('UNSUPPORTED_ATOMIC_RENAME', 'The atomic rename helper could not be observed; no unsafe fallback was attempted.', 501));
      return;
    }
    let output = '';
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => { output = (output + chunk).slice(0, 256); });
    stderr.resume();
    child.once('error', (error: NodeJS.ErrnoException) => reject(new FileManagerError('UNSUPPORTED_ATOMIC_RENAME', 'The atomic rename helper could not be started; no unsafe fallback was attempted.', 501, { cause: error.code })));
    child.once('close', (code, signal) => {
      if (code === 0 && !signal) { resolve(); return; }
      const reported = output.trim();
      const errno = Number(reported);
      if (code === 1 && /^\d+$/.test(reported) && Number.isSafeInteger(errno) && errno > 0 && errno <= 4096) {
        const name = getSystemErrorName(-errno);
        if (name === 'EEXIST' || name === 'ENOTEMPTY') {
          reject(new FileManagerError('ALREADY_EXISTS', 'The destination appeared before atomic publication.', 409));
        } else if (['ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EINVAL'].includes(name)) {
          // Only this branch proves that the filesystem itself cannot enforce
          // no-replace. It is therefore the only failure allowed to tell a caller
          // that an explicitly confirmed ordinary rename is even worth offering;
          // every other outcome reports itself without that marker.
          reject(new FileManagerError('UNSUPPORTED_ATOMIC_RENAME', 'This filesystem cannot guarantee atomic no-replace rename.', 501, { compatibilityAvailable: true }));
        } else reject(Object.assign(new Error('Atomic rename failed.'), { code: name }));
        return;
      }
      reject(new FileManagerError('ATOMIC_RENAME_UNCERTAIN', 'The rename outcome could not be confirmed. Inspect the source and destination before retrying.', 500, { outcome: 'unknown', helperExitCode: code, signal }));
    });
  });
}

/**
 * True only when the helper proved that this filesystem cannot enforce
 * no-replace, so the caller may offer its explicitly confirmed compatibility
 * fallback. A helper that could not be started, a signal, a permission failure,
 * a raw errno, or an outcome that was never observed proves nothing about the
 * filesystem and therefore never authorizes that fallback.
 *
 * This helper reports the single failure; it never performs a fallback itself,
 * because the confirmed downgrade belongs to one single-entry rename and must not
 * be inherited by tasks, uploads or directory publication.
 */
export function renameCompatibilityAvailable(error: unknown): boolean {
  return isFileManagerError(error)
    && error.code === 'UNSUPPORTED_ATOMIC_RENAME'
    && error.details.compatibilityAvailable === true;
}
