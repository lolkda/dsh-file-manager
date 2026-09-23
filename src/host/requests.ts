import { createHash } from 'node:crypto';
import { fail } from '../contracts/errors.js';
import {
  REQUEST_ID_MAX_LENGTH,
  REQUEST_ID_MIN_LENGTH,
  REQUEST_LEDGER_CAPACITY,
  REQUEST_LEDGER_TTL_MS,
} from '../contracts/limits.js';

export interface RequestLedgerOptions {
  now?: () => number;
  ttlMs?: number;
  capacity?: number;
}

export interface RequestLedger {
  /**
   * Runs one mutation under a caller-supplied `requestId`. Replaying the same
   * id with the same payload returns the original promise; reusing it for a
   * different payload is refused instead of silently applying both.
   */
  run<T>(requestId: unknown, input: unknown, operation: () => T | Promise<T>): Promise<T>;
}

interface LedgerEntry {
  fingerprint: string;
  settled: boolean;
  expiresAt: number;
  promise: Promise<unknown>;
}

/** `Object.keys` needs an index signature; request payloads are plain JSON objects. */
function fields(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** Deterministic JSON with sorted keys, so field order never changes a fingerprint. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = fields(value);
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

/** The requestId is the replay key, so it must not be part of the fingerprint. */
function payloadOf(input: unknown): unknown {
  if (input === null || (typeof input !== 'object' && typeof input !== 'function')) return input;
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields(input))) if (key !== 'requestId') payload[key] = value;
  return payload;
}

/** A bounded retry window, shared by the control and text endpoints. */
export function createRequestLedger({ now = Date.now, ttlMs = REQUEST_LEDGER_TTL_MS, capacity = REQUEST_LEDGER_CAPACITY }: RequestLedgerOptions = {}): RequestLedger {
  const entries = new Map<string, LedgerEntry>();
  return {
    run<T>(requestId: unknown, input: unknown, operation: () => T | Promise<T>): Promise<T> {
      if (typeof requestId !== 'string' || requestId.length < REQUEST_ID_MIN_LENGTH || requestId.length > REQUEST_ID_MAX_LENGTH) fail('INVALID_REQUEST', `Mutations require a requestId of ${REQUEST_ID_MIN_LENGTH} to ${REQUEST_ID_MAX_LENGTH} characters.`);
      for (const [id, entry] of entries) if (entry.settled && now() > entry.expiresAt) entries.delete(id);
      const fingerprint = createHash('sha256').update(canonical(payloadOf(input))).digest('hex');
      const previous = entries.get(requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('REQUEST_ID_REUSED', 'This requestId was already used for a different operation.', 409);
        // The fingerprint proves this is the same operation, so the recorded
        // promise settles with this call's result type.
        return previous.promise as Promise<T>;
      }
      if (entries.size >= capacity) fail('TOO_MANY_REQUESTS', 'The mutation retry window is full. Wait before starting more requests.', 429);
      const entry: LedgerEntry = { fingerprint, settled: false, expiresAt: 0, promise: Promise.resolve() };
      entry.promise = Promise.resolve().then(operation).finally(() => {
        entry.settled = true;
        entry.expiresAt = now() + ttlMs;
      });
      entries.set(requestId, entry);
      return entry.promise as Promise<T>;
    },
  };
}
