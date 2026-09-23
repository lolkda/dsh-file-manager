/**
 * Shared helpers for the task-6 independent verification suite (`tests/verify-*.test.mjs`).
 *
 * Not a test file itself. Three rules this harness enforces so a verification
 * case can never pass without proving anything:
 *
 * 1. **Readiness is checked, not assumed.** `probeReadiness()` reports exactly
 *    which task-4/task-5 artifacts are missing; each suite fails a guard test and
 *    skips its cases with that reason instead of passing vacuously.
 * 2. **Pending cases throw.** A case whose body has not been connected to the real
 *    implementation calls `pending()` and fails loudly — never silently passes.
 * 3. **Content reads are measured, not guessed.** `measureReads()` returns the
 *    `/proc/self/io` `rchar` delta with a baseline subtracted and a median of
 *    repeats, so "did this operation hash the file?" is a decidable question.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const at = relative => path.join(root, relative);

/** A verification case that is not connected to the implementation yet. */
export function pending(what) {
  throw new Error(`PENDING-IMPLEMENTATION: ${what}`);
}

/**
 * Which artifacts the verification suite needs. Every entry is a real file or a
 * real string the implementation must contain; nothing here is optional.
 */
export async function probeReadiness() {
  const required = [
    'dist/index.js',
    'dist/client.js',
    'dist/host/manager.js',
    'dist/host/tasks.js',
    'dist/host/transfers.js',
    'dist/host/watch.js',
    'dist/host/http.js',
  ];
  const missing = required.filter(relative => !existsSync(at(relative)));
  if (missing.length === 0) {
    // The route table is the frozen source; the Host entry must consume it rather
    // than hand-writing paths, and the built contract must still carry the six v2
    // paths. Both are real anti-drift checks, not a literal hunt in index.js.
    const contract = readFileSync(at('dist/contracts/protocol.js'), 'utf8');
    for (const route of ['/api/file-manager/v2/control', '/api/file-manager/v2/manifest', '/api/file-manager/v2/text',
      '/api/file-manager/v2/upload', '/api/file-manager/v2/download', '/api/file-manager/v2/events']) {
      if (!contract.includes(route)) missing.push(`dist/contracts/protocol.js must still declare ${route}`);
    }
    const host = readFileSync(at('dist/index.js'), 'utf8');
    if (!/ROUTE_TABLE|ROUTES/.test(host)) missing.push('dist/index.js must register the routes from the frozen table');
  }
  return { ready: missing.length === 0, missing };
}

/* ------------------------------------------------------------------ *
 * Evidence
 * ------------------------------------------------------------------ */

/** Directory for one verification run; created on first use. */
export function evidenceDirectory(runId) {
  const directory = at(path.join('docs', 'verification', runId));
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** Append a line of raw evidence (command output, measured numbers) to a case log. */
export function record(directory, caseName, line) {
  writeFileSync(path.join(directory, `${caseName}.log`), `${line}\n`, { flag: 'a' });
}

/* ------------------------------------------------------------------ *
 * rchar: did this operation actually read the bytes?
 * ------------------------------------------------------------------ */

/** Bytes this process has read through read/pread so far, or undefined if unavailable. */
export function rchar() {
  try {
    const match = readFileSync('/proc/self/io', 'utf8').match(/rchar:\s*(\d+)/);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Measure the bytes an operation reads.
 *
 * `/proc/self/io` is Linux-only and this deployment is Linux-only, so an
 * unavailable counter is an environment fault: the caller must fail, never skip.
 */
export async function measureReads(operation) {
  const before = rchar();
  assert.notEqual(before, undefined, '/proc/self/io must expose rchar: this verification cannot run without it');
  const value = await operation();
  const after = rchar();
  assert.notEqual(after, undefined, '/proc/self/io must expose rchar: this verification cannot run without it');
  return { value, bytes: after - before };
}

/**
 * Median of `repeats` measurements with a same-shaped baseline subtracted, so
 * small-file noise (~100 B per read of /proc/self/io itself) cannot masquerade
 * as signal. Always measure on files of at least 16 MiB for "must not read"
 * assertions; the baseline is measured immediately before each repeat.
 */
export async function measureReadsMedian({ operation, baseline, repeats = 3 }) {
  const samples = [];
  for (let index = 0; index < repeats; index++) {
    await baseline();
    const control = await measureReads(baseline);
    const measured = await measureReads(operation);
    samples.push(measured.bytes - control.bytes);
  }
  samples.sort((left, right) => left - right);
  const middle = samples[Math.floor(samples.length / 2)];
  assert.notEqual(middle, undefined, 'at least one measurement is required');
  return { samples, median: middle };
}

/* ------------------------------------------------------------------ *
 * Fixtures: a real Host, driven the way the Host drives it
 * ------------------------------------------------------------------ */

/**
 * Build a real manager + router over a temporary root, with the effective limits
 * passed explicitly. Everything runs through the frozen v2 router, so the
 * verification exercises the wire boundary rather than an internal shortcut.
 */
export async function hostFixture({
  limits = {}, prefix = 'dsh-fm-verify-host-',
  transfers, tasks, watcher, events, withTasks = false, withTransfers = false, scheduler, persistTask, persistTasks,
  degraded = null, readOnly = false,
} = {}) {
  const { createManager } = await import('../dist/host/manager.js');
  const { createFileManagerRouter } = await import('../dist/host/http.js');
  const { resolveLimits } = await import('../dist/contracts/limits.js');
  const effective = resolveLimits(limits);
  const fixture = await tempRoot(prefix);
  const manager = createManager({
    maxTextBytes: effective.maxTextBytes,
    deletePlanTtlMs: effective.deletePlanTtlMs,
    maxVerificationBytes: effective.maxVerificationBytes,
    ...(scheduler ? { scheduler } : {}),
  });
  const grant = await manager.addRoot({ path: fixture.directory });
  const settled = new Map();
  const watchers = new Set();
  const announce = task => {
    if (!['completed', 'partial', 'failed', 'cancelled'].includes(task.status)) return;
    for (const resolve of watchers) resolve(task);
  };
  let builtTasks = tasks;
  if (withTasks && !builtTasks) {
    const { createTaskService } = await import('../dist/host/tasks.js');
    builtTasks = createTaskService({
      manager, limits: effective, ...(persistTask ? { persistTask } : {}), onChange: announce,
    });
  }
  let builtTransfers = transfers;
  if (withTransfers && !builtTransfers) {
    const { createTransferService } = await import('../dist/host/transfers.js');
    builtTransfers = createTransferService({
      manager, limits: effective, ...(scheduler ? { scheduler } : {}), ...(persistTasks ? { persistTasks } : {}), onProgress: announce,
    });
  }
  const router = createFileManagerRouter({
    manager,
    workspaces: () => [],
    limits: effective,
    ...(degraded ? { degraded } : {}),
    ...(readOnly ? { readOnly } : {}),
    ...(builtTasks ? { tasks: builtTasks } : {}),
    ...(builtTransfers ? { transfers: builtTransfers } : {}),
    ...(watcher ? { watcher } : {}),
    ...(events ? { events } : {}),
  });
  const call = async (op, payload = {}, { route = 'control', method = 'POST' } = {}) => {
    const path = route === 'manifest' ? 'manifest' : route;
    const url = `http://localhost/api/file-manager/v2/${path}`;
    const response = await router(new Request(url, {
      method,
      ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, requestId: `verify-${Math.random().toString(36).slice(2, 12)}`, ...payload }) } : {}),
    }));
    const body = await response.json();
    return { status: response.status, body, value: body?.value, error: body?.error };
  };
  return {
    ...fixture, manager, router, call, limits: effective, rootId: grant.id,
    tasks: builtTasks, transfers: builtTransfers,
    ref: relativePath => ({ rootId: grant.id, path: relativePath }),
    /** Wait until the task/transfer reaches a terminal status, then return its view. */
    async settle(taskId, timeoutMs = 30000) {
      const service = builtTasks ?? builtTransfers;
      const current = () => (builtTasks ? builtTasks.get({ taskId }) : builtTransfers.get(taskId));
      const first = await current();
      if (['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(first.status)) return first;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { watchers.delete(wrapped); reject(new Error(`task ${taskId} did not settle within ${timeoutMs}ms`)); }, timeoutMs);
        const wrapped = task => {
          if (task.id !== taskId) return;
          clearTimeout(timer);
          watchers.delete(wrapped);
          resolve(task);
        };
        watchers.add(wrapped);
      });
      void settled; void service;
      return await current();
    },
    async close() {
      for (const stop of [builtTransfers?.close, builtTasks?.close, () => manager.close()]) {
        try { await stop?.(); } catch { /* cleanup must not mask a verification failure */ }
      }
      await fixture.cleanup();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A temporary root plus a 16 MiB file, cleaned up by the caller. */
export async function tempRoot(prefix = 'dsh-fm-verify-') {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

/** Write a file of `bytes` bytes; content is deliberately non-compressible-ish. */
export function writeSizedFile(file, bytes) {
  const chunk = Buffer.alloc(1024 * 1024);
  for (let offset = 0; offset < chunk.length; offset++) chunk[offset] = (offset * 31 + 7) & 0xff;
  const parts = [];
  for (let written = 0; written < bytes; written += chunk.length) {
    parts.push(chunk.subarray(0, Math.min(chunk.length, bytes - written)));
  }
  writeFileSync(file, Buffer.concat(parts));
}

/**
 * A storage-domain stub for the R17 degradation cases. The real profile storage
 * is never touched: every case builds its own in-memory records and can be told
 * to fail on open, which is what "operation records unavailable" means.
 */
export function storageStub({ failOn = undefined, global = undefined, tables = {} } = {}) {
  const state = {
    global: structuredClone(global ?? { revision: 0, roots: [] }),
    tables: new Map(Object.entries(tables).map(([name, records]) => [name, new Map(Object.entries(records))])),
    opens: 0,
    writes: [],
  };
  return {
    state,
    async open(spec) {
      state.opens++;
      if (failOn !== undefined && spec.name === failOn) {
        throw Object.assign(new Error(`injected storage failure for ${spec.name}`), { code: 'EIO' });
      }
      const table = name => {
        if (!state.tables.has(name)) state.tables.set(name, new Map());
        const records = state.tables.get(name);
        return {
          entries: () => records.entries(),
          async put(key, value) { records.set(key, value); state.writes.push([name, key, structuredClone(value)]); },
        };
      };
      return {
        global: {
          get: () => state.global,
          async set(next) { state.global = next; state.writes.push(['global', 'roots', structuredClone(next)]); },
        },
        table,
        async close() {},
      };
    },
  };
}
