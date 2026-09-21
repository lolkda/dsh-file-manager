import { createHash } from 'node:crypto';
import { fail } from '../contracts/errors.js';

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

/** A bounded retry window, shared by the control and text endpoints. */
export function createRequestLedger({ now = Date.now, ttlMs = 600000, capacity = 256 } = {}) {
  const entries = new Map();
  return {
    run(requestId, input, operation) {
      if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 128) fail('INVALID_REQUEST', 'Mutations require a requestId of 8 to 128 characters.');
      for (const [id, entry] of entries) if (entry.settled && now() > entry.expiresAt) entries.delete(id);
      const { requestId: ignored, ...payload } = input;
      const fingerprint = createHash('sha256').update(canonical(payload)).digest('hex');
      const previous = entries.get(requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('REQUEST_ID_REUSED', 'This requestId was already used for a different operation.', 409);
        return previous.promise;
      }
      if (entries.size >= capacity) fail('TOO_MANY_REQUESTS', 'The mutation retry window is full. Wait before starting more requests.', 429);
      const entry = { fingerprint, settled: false, expiresAt: 0, promise: null };
      entry.promise = Promise.resolve().then(operation).finally(() => {
        entry.settled = true;
        entry.expiresAt = now() + ttlMs;
      });
      entries.set(requestId, entry);
      return entry.promise;
    },
  };
}
