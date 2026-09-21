import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getSystemErrorName } from 'node:util';
import { FileManagerError } from '../contracts/errors.js';

const executable = fileURLToPath(new URL('./native/rename-no-replace', import.meta.url));

/** Never fall back to check-then-rename when the kernel cannot enforce no-replace. */
export function renameNoReplace(sourceParent, sourceName, destinationParent, destinationName) {
  if (process.platform !== 'linux') throw new FileManagerError('UNSUPPORTED_ATOMIC_RENAME', 'Atomic no-replace rename requires the Linux helper.', 501);
  for (const name of [sourceName, destinationName]) {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\/\0]/.test(name)) throw new FileManagerError('INVALID_PATH', 'Atomic rename accepts only leaf names.');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [sourceName, destinationName], {
      stdio: ['ignore', 'pipe', 'pipe', sourceParent.fd, destinationParent.fd],
      windowsHide: true,
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output = (output + chunk).slice(0, 256); });
    child.stderr.resume();
    child.once('error', error => reject(new FileManagerError('UNSUPPORTED_ATOMIC_RENAME', 'The atomic rename helper could not be started; no unsafe fallback was attempted.', 501, { cause: error.code })));
    child.once('close', (code, signal) => {
      if (code === 0 && !signal) { resolve(); return; }
      const errno = Number(output.trim());
      if (code === 1 && /^\d+$/.test(output.trim()) && Number.isSafeInteger(errno) && errno > 0 && errno <= 4096) {
        const name = getSystemErrorName(-errno);
        if (name === 'EEXIST' || name === 'ENOTEMPTY') {
          reject(new FileManagerError('ALREADY_EXISTS', 'The destination appeared before atomic publication.', 409));
        } else if (['ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EINVAL'].includes(name)) {
          reject(new FileManagerError('UNSUPPORTED_ATOMIC_RENAME', 'This filesystem cannot guarantee atomic no-replace rename.', 501));
        } else reject(Object.assign(new Error('Atomic rename failed.'), { code: name }));
        return;
      }
      reject(new FileManagerError('ATOMIC_RENAME_UNCERTAIN', 'The rename outcome could not be confirmed. Inspect the source and destination before retrying.', 500, { outcome: 'unknown', helperExitCode: code, signal }));
    });
  });
}
