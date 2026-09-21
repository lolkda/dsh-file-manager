/** A stable, user-visible failure without an internal stack on the wire. */
export class FileManagerError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'FileManagerError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function fail(code, message, status = 400, details = {}) {
  throw new FileManagerError(code, message, status, details);
}
