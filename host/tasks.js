import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fail, FileManagerError } from '../contracts/errors.js';

const terminalStates = new Set(['completed', 'partial', 'failed', 'cancelled']);
const policies = new Set(['skip', 'rename', 'overwrite']);
const childPath = (parent, name) => parent ? `${parent}/${name}` : name;
const parentRef = ref => ({ rootId: ref.rootId, path: ref.path.includes('/') ? ref.path.slice(0, ref.path.lastIndexOf('/')) : '' });
const under = (child, parent) => child === parent || child.startsWith(`${parent}/`);
const errorView = error => ({ code: error.code ?? 'IO_ERROR', message: error.message ?? 'The operation failed.', details: { ...(error.details ?? {}) } });
const cancellation = signal => { if (signal?.aborted) fail('CANCELLED', 'The task was cancelled.', 499); };

function refOf(ref, allowRoot = false) {
  if (!ref || typeof ref.rootId !== 'string' || !ref.rootId || typeof ref.path !== 'string'
    || ref.path.length > 4096 || /[\x00-\x1f\\]/.test(ref.path) || path.posix.isAbsolute(ref.path) || /^[A-Za-z]:/.test(ref.path)
    || (ref.path && ref.path.split('/').some(part => !part || part === '.' || part === '..'))) {
    fail('INVALID_PATH', 'Expected an authorized root and a relative path.');
  }
  if (!allowRoot && !ref.path) fail('ROOT_OPERATION_NOT_ALLOWED', 'The granted root itself cannot be copied or moved.', 403);
  return { rootId: ref.rootId, path: ref.path };
}
function nameOf(name) {
  if (name === undefined) return undefined;
  refOf({ rootId: 'name-validation', path: name });
  if (name.includes('/')) fail('INVALID_PATH', 'A conflict rename must be one path segment.');
  return name;
}
function versionOf(version) {
  if (typeof version !== 'string' || !version) fail('VERSION_REQUIRED', 'Each source requires its selected version.', 409);
  return version;
}

/** Asynchronous task orchestration. Storage and notification remain profile-owned injection points. */
export function createTaskService({ manager, limits = {}, initialTasks = [], persistTask = async () => {}, onChange = () => {} } = {}) {
  if (!manager?.io) fail('INVALID_STATE', 'The safe manager I/O capability is required.', 500);
  const io = manager.io;
  const bounds = {
    maxFileBytes: limits.maxFileBytes ?? 2 * 1024 ** 3,
    maxTaskBytes: limits.maxTaskBytes ?? 10 * 1024 ** 3,
    maxTaskEntries: limits.maxTaskEntries ?? 10000,
    concurrency: limits.transferConcurrency ?? 2,
  };
  for (const value of Object.values(bounds)) if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_STATE', 'Task limits must be positive safe integers.', 500);
  if (bounds.concurrency > 8) fail('INVALID_STATE', 'Task concurrency cannot exceed eight.', 500);
  const tasks = new Map();
  const active = new Map();
  const waiting = [];
  const requeuing = new Set();
  const historyUpdates = new Set();
  const controls = new Set();
  let stopped = false;
  let closingPromise;
  let persistenceTail = Promise.resolve();

  function progress(task) {
    const result = { total: task.items.length, completed: 0, failed: 0, skipped: 0, cancelled: 0, bytes: 0, totalBytes: 0 };
    for (const item of task.items) {
      if (item.status in result) result[item.status]++;
      result.bytes += item.result?.bytes ?? item.bytesTransferred ?? 0;
      result.totalBytes += item.measured?.bytes ?? 0;
    }
    return result;
  }
  function quiescent(task) {
    return terminalStates.has(task.status) && !active.has(task.id) && !requeuing.has(task.id) && !historyUpdates.has(task.id);
  }
  function nextHistoryRevision(task) {
    if (task.historyRevision === Number.MAX_SAFE_INTEGER) fail('HISTORY_REVISION_EXHAUSTED', 'The task history revision cannot advance safely.', 409);
    return task.historyRevision + 1;
  }
  function view(task) {
    return structuredClone({ ...task, canDismiss: !task.dismissed && quiescent(task), progress: progress(task), items: task.items.map(({ checkpoint, measured, ...item }) => item) });
  }
  function notify(task) {
    try { onChange(view(task)); } catch { /* Notification failure must not disguise a completed filesystem mutation. */ }
  }
  async function save(task, publish = true) {
    task.updatedAt = new Date().toISOString();
    task.progress = progress(task);
    const record = structuredClone(task);
    delete record.canDismiss;
    const saving = persistenceTail.then(() => persistTask(record));
    persistenceTail = saving.catch(() => {});
    await saving;
    if (publish) notify(task);
  }
  function taskOf(taskId) {
    if (typeof taskId !== 'string' || !tasks.has(taskId)) fail('TASK_NOT_FOUND', 'The task is unavailable.', 404);
    return tasks.get(taskId);
  }
  function accepting() { if (stopped) fail('SERVICE_STOPPED', 'The task service is stopping.', 503); }
  function logicalPath(ref) {
    const grant = manager.listRoots().find(root => root.id === ref.rootId);
    if (!grant) fail('ROOT_NOT_FOUND', 'The root grant no longer exists.', 404);
    // Used only for overlap comparison. All filesystem access goes through io capabilities.
    return path.posix.join(grant.path, ref.path);
  }
  function statusOf(task, cancelled = false) {
    if (cancelled || task.items.some(item => item.status === 'cancelled')) return 'cancelled';
    const failed = task.items.filter(item => item.status === 'failed').length;
    if (!failed) return 'completed';
    return failed === task.items.length ? 'failed' : 'partial';
  }

  if (!Array.isArray(initialTasks)) fail('INVALID_STATE', 'Stored tasks are invalid.', 500);
  for (const record of initialTasks) {
    if (!record || typeof record.id !== 'string' || !record.id || tasks.has(record.id)
      || !['copy', 'move'].includes(record.operation) || !Array.isArray(record.items) || !record.items.length) {
      fail('INVALID_STATE', 'Stored tasks are invalid; no task was silently discarded.', 500);
    }
    const task = structuredClone(record);
    if (task.dismissed === undefined) task.dismissed = false;
    if (task.historyRevision === undefined) task.historyRevision = 0;
    if (typeof task.dismissed !== 'boolean' || !Number.isSafeInteger(task.historyRevision) || task.historyRevision < 0) {
      fail('INVALID_STATE', 'Stored task history flags or revision are invalid.', 500);
    }
    delete task.canDismiss;
    refOf(task.destination, true);
    for (const item of task.items) {
      refOf(item.source); refOf(item.destination); versionOf(item.source.expectedVersion);
      if (typeof item.id !== 'string' || !Number.isSafeInteger(item.attempts) || item.attempts < 0) fail('INVALID_STATE', 'Stored task items are invalid.', 500);
      for (const [key, rootRef] of [['manifest', item.source], ['targetManifest', item.destination]]) {
        for (const entry of item.checkpoint?.[key] ?? []) {
          refOf(entry);
          if (entry.rootId !== rootRef.rootId || !under(entry.path, rootRef.path)) fail('INVALID_STATE', 'A stored task manifest escaped its selected subtree.', 500);
        }
      }
      if (item.status === 'running' || item.status === 'pending') {
        item.status = 'failed';
        item.error = { code: 'INTERRUPTED', message: 'The Host stopped before this item obtained a durable completion receipt. Review and retry it.', details: { committed: Boolean(item.checkpoint?.receipt) } };
      }
    }
    if (!terminalStates.has(task.status)) task.status = statusOf(task);
    tasks.set(task.id, task);
  }
  const ready = Promise.all([...tasks.values()].map(task => save(task)));
  ready.catch(() => {});

  async function start({ operation, items, destination, conflict = 'skip' } = {}) {
    accepting(); await ready;
    if (!['copy', 'move'].includes(operation) || !Array.isArray(items) || !items.length || items.length > bounds.maxTaskEntries) fail('INVALID_REQUEST', 'Select an operation and a bounded nonempty item list.');
    if (!policies.has(conflict)) fail('INVALID_REQUEST', 'Choose skip, rename, or overwrite for conflicts.');
    const target = refOf(destination, true);
    if ((await io.stat(target)).kind !== 'directory') fail('NOT_DIRECTORY', 'The task destination must be a directory.', 422);
    const selected = items.map(input => {
      const source = { ...refOf(input), expectedVersion: versionOf(input.expectedVersion) };
      const policy = input.conflict ?? conflict;
      if (!policies.has(policy)) fail('INVALID_REQUEST', 'An item conflict strategy is invalid.');
      return { source, conflict: policy, name: nameOf(input.name), expectedTargetVersion: input.expectedTargetVersion, logical: logicalPath(source) };
    }).sort((a, b) => a.logical.length - b.logical.length || a.logical.localeCompare(b.logical));
    const unique = [];
    for (const item of selected) if (!unique.some(parent => under(item.logical, parent.logical))) unique.push(item);
    // Preserve the UI selection order after removing descendants and exact duplicates.
    unique.sort((a, b) => items.findIndex(input => input.rootId === a.source.rootId && input.path === a.source.path)
      - items.findIndex(input => input.rootId === b.source.rootId && input.path === b.source.path));
    const createdAt = new Date().toISOString();
    const task = {
      id: randomUUID(), operation, destination: target, conflict, status: 'queued', createdAt, updatedAt: createdAt,
      dismissed: false, historyRevision: 0,
      items: unique.map(({ logical, ...item }) => ({
        id: randomUUID(), ...item, destination: { rootId: target.rootId, path: childPath(target.path, item.name ?? path.posix.basename(item.source.path)) },
        status: 'pending', attempts: 0, bytesTransferred: 0,
      })),
    };
    await save(task);
    tasks.set(task.id, task);
    schedule(task);
    return view(task);
  }

  async function inspect(ref, signal) {
    try { return await io.stat({ ...ref, signal }); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }
  async function resolveDestination(task, item, source, signal) {
    const sourcePath = logicalPath(item.source);
    const targetParent = logicalPath(task.destination);
    if (source.kind === 'directory' && under(targetParent, sourcePath)) fail('SELF_DESCENDANT', 'A directory cannot be copied or moved into itself or its own subtree.', 409);
    const base = item.name ?? path.posix.basename(item.source.path);
    let ref = { rootId: task.destination.rootId, path: childPath(task.destination.path, base) };
    let existing = await inspect(ref, signal);
    if (existing && item.conflict === 'rename' && item.name === undefined) {
      const extension = source.kind === 'file' ? path.posix.extname(base) : '';
      const stem = extension ? base.slice(0, -extension.length) : base;
      for (let suffix = 1; existing && suffix <= 10000; suffix++) {
        ref = { rootId: task.destination.rootId, path: childPath(task.destination.path, `${stem} (${suffix})${extension}`) };
        existing = await inspect(ref, signal);
      }
      if (existing) fail('ALREADY_EXISTS', 'No unused conflict name was found.', 409);
    }
    item.destination = ref;
    if (existing && source.identity === existing.identity) fail('SAME_ENTRY', 'The source and destination identify the same entry.', 409);
    if (existing && item.conflict === 'skip') return { skip: true };
    if (existing && item.conflict === 'rename') fail('ALREADY_EXISTS', 'The explicitly chosen new name also exists.', 409);
    if (existing && (source.kind === 'directory' || existing.kind === 'directory')) fail('DIRECTORY_CONFLICT', 'Directories cannot be overwritten or merged.', 409);
    if (existing && (source.kind !== 'file' || existing.kind !== 'file')) fail('UNSUPPORTED_ENTRY', 'Only ordinary files can be overwritten.', 422);
    if (existing && (typeof item.expectedTargetVersion !== 'string' || !/:[0-9a-f]{64}$/.test(item.expectedTargetVersion))) fail('STRONG_VERSION_REQUIRED', 'Overwrite requires a content-bound version from an explicit target stat.', 409);
    if (item.expectedTargetVersion !== undefined && item.conflict === 'overwrite'
      && (!existing || existing.version !== item.expectedTargetVersion)) fail('VERSION_CONFLICT', 'The selected overwrite target changed.', 409);
    return { overwrite: Boolean(existing), expectedVersion: existing?.version };
  }

  async function collect(task, item, signal) {
    const manifest = [];
    item.measured = { entries: 0, bytes: 0 };
    async function walk(ref) {
      cancellation(signal);
      const before = task.items.reduce((result, entry) => ({ entries: result.entries + (entry.measured?.entries ?? 0), bytes: result.bytes + (entry.measured?.bytes ?? 0) }), { entries: 0, bytes: 0 });
      if (before.entries >= bounds.maxTaskEntries) fail('TOO_LARGE', 'The task exceeds its configured entry limit.', 413);
      const entry = await io.stat({ ...ref, maxBytes: Math.min(bounds.maxFileBytes, Math.max(0, bounds.maxTaskBytes - before.bytes)), signal });
      if (!['file', 'directory'].includes(entry.kind)) fail('UNSUPPORTED_ENTRY', 'A selected tree contains a link or special entry; nothing was silently omitted.', 422);
      if (entry.mode & 0o7000) fail('UNSUPPORTED_ENTRY', 'Copy and move support ordinary POSIX permission bits only.', 422);
      if (entry.kind === 'file' && entry.size > bounds.maxFileBytes) fail('TOO_LARGE', 'A selected file exceeds the configured byte limit.', 413);
      item.measured.entries++;
      if (entry.kind === 'file') item.measured.bytes += entry.size;
      const totals = task.items.reduce((result, entry) => ({ entries: result.entries + (entry.measured?.entries ?? 0), bytes: result.bytes + (entry.measured?.bytes ?? 0) }), { entries: 0, bytes: 0 });
      if (totals.entries > bounds.maxTaskEntries || totals.bytes > bounds.maxTaskBytes) fail('TOO_LARGE', 'The task exceeds its configured entry or byte limit.', 413);
      manifest.push(entry);
      if (entry.kind === 'directory') {
        const lease = await io.acquireDirectory(ref);
        let children;
        try { children = await lease.entries(); }
        finally { await lease.close(); }
        entry.children = children.map(child => child.name).sort();
        for (const child of children) await walk(child);
        if ((await io.stat(ref)).version !== entry.version) fail('VERSION_CONFLICT', 'The source directory changed during planning.', 409);
      }
    }
    await walk(item.source);
    if (manifest[0].version !== item.source.expectedVersion) fail('VERSION_CONFLICT', 'The source changed after selection.', 409);
    return manifest;
  }

  async function verifyManifest(manifest, removed = [], signal) {
    const deleted = new Set(removed);
    for (const original of manifest) {
      cancellation(signal);
      if (deleted.has(original.path)) continue;
      const current = await io.stat({ ...original, signal, maxBytes: original.kind === 'file' ? original.size : undefined });
      const changed = original.kind === 'directory' && deleted.size ? current.identity !== original.identity : current.version !== original.version;
      if (changed || current.kind !== original.kind) fail('VERSION_CONFLICT', 'A manifest entry changed before the next operation.', 409);
      if (original.kind === 'directory') {
        const lease = await io.acquireDirectory(original);
        try {
          const children = (await lease.entries()).map(entry => entry.name).sort();
          const expected = original.children.filter(name => !deleted.has(childPath(original.path, name)));
          if (children.join('\0') !== expected.join('\0')) fail('VERSION_CONFLICT', 'A manifest directory acquired different children.', 409);
        } finally { await lease.close(); }
      }
    }
  }

  function targetRef(item, entry) {
    return { rootId: item.destination.rootId, path: item.destination.path + entry.path.slice(item.source.path.length) };
  }
  async function captureTarget(item, manifest, signal) {
    const targets = [];
    for (const entry of manifest) {
      cancellation(signal);
      const target = await io.stat({ ...targetRef(item, entry), signal, maxBytes: entry.kind === 'file' ? entry.size : undefined });
      if (entry.kind !== target.kind || (entry.kind === 'file' && (entry.size !== target.size || entry.sha256 !== target.sha256))) fail('VERSION_CONFLICT', 'The published target differs from the copied tree.', 409);
      targets.push({ ...target, ...(entry.children ? { children: [...entry.children] } : {}), ...(entry.sha256 ? { sha256: entry.sha256 } : {}) });
    }
    return targets;
  }
  async function verifyTarget(checkpoint, signal) {
    const sources = checkpoint?.manifest;
    const targets = checkpoint?.targetManifest;
    const invalid = () => fail('RECOVERY_REQUIRED', 'The saved publication proof is incomplete or inconsistent. No source deletion is authorized.', 409, { outcomeUncertain: true });
    if (!Array.isArray(sources) || !sources.length || !Array.isArray(targets) || targets.length !== sources.length
      || !checkpoint.receipt || !['published', 'renamed'].includes(checkpoint.phase)) invalid();
    const sourceRoot = sources[0];
    const targetRoot = targets[0];
    const expectedParent = parentRef(targetRoot);
    const targetParent = checkpoint.targetParent;
    if (!targetParent || targetParent.kind !== 'directory' || typeof targetParent.identity !== 'string'
      || targetParent.rootId !== expectedParent.rootId || targetParent.path !== expectedParent.path) invalid();
    if (checkpoint.receipt.rootId !== targetRoot.rootId || checkpoint.receipt.path !== targetRoot.path
      || checkpoint.receipt.version !== targetRoot.version || checkpoint.receipt.kind !== targetRoot.kind) invalid();
    if (new Set(sources.map(entry => entry.path)).size !== sources.length || new Set(targets.map(entry => entry.path)).size !== targets.length) invalid();
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index];
      const target = targets[index];
      if (source.rootId !== sourceRoot.rootId || !under(source.path, sourceRoot.path)
        || target.rootId !== targetRoot.rootId || target.path !== targetRoot.path + source.path.slice(sourceRoot.path.length)
        || !['file', 'directory'].includes(source.kind) || target.kind !== source.kind) invalid();
      if (source.kind === 'file') {
        if (typeof source.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(source.sha256) || source.sha256 !== target.sha256
          || source.size !== target.size || !source.version.endsWith(`:${source.sha256}`) || !target.version.endsWith(`:${source.sha256}`)) invalid();
      } else if (!Array.isArray(source.children) || !Array.isArray(target.children)
        || source.children.join('\0') !== target.children.join('\0')) invalid();
    }
    const sourcePaths = new Set(sources.map(entry => entry.path));
    if (!Array.isArray(checkpoint.removed) || new Set(checkpoint.removed).size !== checkpoint.removed.length
      || checkpoint.removed.some(path => !sourcePaths.has(path))) invalid();
    const container = await io.acquireDirectory(targetParent);
    try {
      if (container.entry.identity !== targetParent.identity) fail('VERSION_CONFLICT', 'The published destination container was replaced.', 409);
      await container.verify();
    } finally { await container.close(); }
    await verifyManifest(checkpoint.targetManifest, [], signal);
    for (const entry of checkpoint.targetManifest) {
      if (entry.kind !== 'file' || !entry.sha256) continue;
      const source = await io.openRead({ ...entry, expectedVersion: entry.version, maxBytes: entry.size, signal });
      try {
        const hash = createHash('sha256');
        for await (const chunk of source.stream) hash.update(chunk);
        await source.verify();
        if (hash.digest('hex') !== entry.sha256) fail('CHECKSUM_MISMATCH', 'The published destination no longer contains the copied bytes.', 409);
      } finally { await source.close(); }
    }
  }

  /** Run the destination check after source hashing, holding its parent identity chain through unlink/rmdir. */
  async function removeWithTargetProof(source, target, parents, signal) {
    const held = [];
    let removed = false;
    let primaryError;
    try {
      await io.removeEntry({ ...source, signal, beforeRemove: async () => {
        cancellation(signal);
        for (const parent of parents) {
          const lease = await io.acquireDirectory(parent);
          held.push(lease);
          if (lease.entry.identity !== parent.identity) fail('VERSION_CONFLICT', 'A published destination parent was replaced.', 409, { target: { rootId: target.rootId, path: target.path } });
        }
        const current = await io.stat({ ...target, signal, maxBytes: target.kind === 'file' ? target.size : undefined });
        if (current.kind !== target.kind || current.identity !== target.identity || current.version !== target.version
          || (target.kind === 'file' && current.sha256 !== target.sha256)) {
          fail('VERSION_CONFLICT', 'The corresponding published destination changed before source removal.', 409, { target: { rootId: target.rootId, path: target.path } });
        }
        if (target.kind === 'directory') {
          const directory = await io.acquireDirectory(target);
          held.push(directory);
          if (directory.entry.identity !== target.identity) fail('VERSION_CONFLICT', 'The published destination directory was replaced.', 409);
          const children = (await directory.entries()).map(entry => entry.name).sort();
          if (children.join('\0') !== target.children.join('\0')) fail('VERSION_CONFLICT', 'The published destination directory membership changed.', 409);
        }
        for (const lease of held) await lease.verify();
        cancellation(signal);
      } });
      removed = true;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const failures = [];
      for (const lease of held.reverse()) {
        try { await lease.close(); } catch (error) { failures.push(error); }
      }
      if (failures.length) {
        if (primaryError) primaryError.details = { ...(primaryError.details ?? {}), targetLeaseCleanupFailed: true };
        else throw new FileManagerError('CLEANUP_FAILED', 'A checked destination lease could not be released.', 500, { removed, targetLeaseCleanupFailed: true });
      }
    }
  }

  async function cleanupSource(task, item, signal) {
    const checkpoint = item.checkpoint;
    try {
      cancellation(signal);
      await verifyTarget(checkpoint, signal);
      await verifyManifest(checkpoint.manifest, checkpoint.removed ?? [], signal);
      const targets = new Map(checkpoint.manifest.map((entry, index) => [entry.path, checkpoint.targetManifest[index]]));
      const directories = new Map(checkpoint.targetManifest.filter(entry => entry.kind === 'directory').map(entry => [entry.path, entry]));
      directories.set(checkpoint.targetParent.path, checkpoint.targetParent);
      const lineages = new Map();
      function parentsFor(target) {
        const parent = parentRef(target);
        if (lineages.has(parent.path)) return lineages.get(parent.path);
        const parents = [];
        let current = parent;
        while (true) {
          const proof = directories.get(current.path);
          if (!proof || proof.rootId !== target.rootId) fail('RECOVERY_REQUIRED', 'A published destination parent proof is missing.', 409);
          parents.push(proof);
          if (current.path === checkpoint.targetParent.path) break;
          if (!current.path) fail('RECOVERY_REQUIRED', 'The destination parent proof escaped its publication container.', 409);
          current = parentRef(current);
        }
        parents.reverse();
        lineages.set(parent.path, parents);
        return parents;
      }
      for (const entry of [...checkpoint.manifest].reverse()) {
        if (checkpoint.removed.includes(entry.path)) continue;
        cancellation(signal);
        const target = targets.get(entry.path);
        try { await removeWithTargetProof(entry, target, parentsFor(target), signal); }
        catch (error) {
          if (error.details?.removed) checkpoint.removed.push(entry.path);
          throw error;
        }
        checkpoint.removed.push(entry.path);
        item.result.sourceRemoved = checkpoint.removed.length === checkpoint.manifest.length;
        await save(task);
      }
      item.result.sourceRemoved = true;
    } catch (error) {
      item.result.sourceRemoved = checkpoint.removed.length === checkpoint.manifest.length;
      throw new FileManagerError('SOURCE_DELETE_FAILED', 'The destination was published, but source cleanup did not complete. The remaining source entries were retained.', 409,
        { committed: true, sourceRemoved: item.result.sourceRemoved, bothCopiesExist: checkpoint.removed.length === 0, cause: error.code ?? 'IO_ERROR', removedPaths: [...checkpoint.removed] });
    }
  }

  async function copy(task, item, manifest, destinationPolicy, signal) {
    const byPath = new Map(manifest.map(entry => [entry.path, entry]));
    const targetContainer = await io.acquireDirectory(parentRef(item.destination));
    async function copyEntry(entry, destination, top = false) {
      cancellation(signal);
      const stage = entry.kind === 'directory'
        ? await io.createStagedDirectory({ ...destination, mode: entry.mode, signal })
        : await io.createStagedFile({ ...destination, mode: entry.mode, signal, ...(top ? destinationPolicy : {}) });
      let primaryError;
      try {
        let validation;
        if (entry.kind === 'directory') {
          for (const name of entry.children) await copyEntry(byPath.get(childPath(entry.path, name)), { rootId: stage.ref.rootId, path: childPath(stage.ref.path, name) });
        } else {
          const source = await io.openRead({ ...entry, expectedVersion: entry.version, maxBytes: bounds.maxFileBytes, signal });
          try {
            const hash = createHash('sha256');
            let bytes = 0;
            for await (const chunk of source.stream) {
              cancellation(signal);
              await stage.write(chunk);
              hash.update(chunk); bytes += chunk.length;
              item.bytesTransferred += chunk.length;
              notify(task);
            }
            await source.verify();
            entry.sha256 = hash.digest('hex');
            validation = { bytes, sha256: entry.sha256 };
          } finally { await source.close(); }
        }
        if (top) {
          await verifyManifest(manifest, [], signal);
          item.checkpoint = { phase: 'publishing', manifest, removed: [], targetParent: targetContainer.entry };
          await save(task);
          await targetContainer.verify();
        }
        cancellation(signal);
        const receipt = await stage.commit(validation);
        if (top) {
          item.result = { destination: receipt, bytes: item.measured.bytes, sourceRemoved: false, method: task.operation === 'move' ? 'copy-delete' : 'copy' };
          item.checkpoint = { ...item.checkpoint, phase: 'published', receipt, targetManifest: await captureTarget(item, manifest, signal) };
          await save(task);
        }
        return receipt;
      } catch (error) {
        primaryError = error;
        if (top && !error.details?.committed && !item.result) delete item.checkpoint;
        if (top && item.result) error.details = { ...(error.details ?? {}), committed: true };
        throw error;
      } finally {
        try { await stage.abort(); }
        catch (error) {
          if (primaryError) primaryError.details = { ...(primaryError.details ?? {}), cleanupFailed: true, cleanupError: error.code ?? 'IO_ERROR' };
          else throw error;
        }
      }
    }
    try {
      await copyEntry(manifest[0], item.destination, true);
      if (task.operation === 'move') await cleanupSource(task, item, signal);
    } finally { await targetContainer.close(); }
  }

  async function execute(task, item, signal) {
    cancellation(signal);
    if (item.checkpoint) {
      if (!item.checkpoint.receipt || !item.checkpoint.targetManifest) fail('RECOVERY_REQUIRED', 'A previous publication has an uncertain outcome. Review the source and destination before starting a new task.', 409, { outcomeUncertain: true });
      await verifyTarget(item.checkpoint, signal);
      if (task.operation === 'move' && !item.result?.sourceRemoved) await cleanupSource(task, item, signal);
      return;
    }
    const manifest = await collect(task, item, signal);
    const destinationPolicy = await resolveDestination(task, item, manifest[0], signal);
    if (destinationPolicy.skip) { item.status = 'skipped'; return; }
    await verifyManifest(manifest, [], signal);
    if (task.operation === 'move') {
      const targetContainer = await io.acquireDirectory(parentRef(item.destination));
      item.checkpoint = { phase: 'renaming', manifest, removed: [], targetParent: targetContainer.entry };
      try {
        await save(task);
        await targetContainer.verify();
        const receipt = await io.renameEntry({ source: item.source, destination: item.destination, expectedVersion: item.source.expectedVersion,
          overwrite: destinationPolicy.overwrite, expectedTargetVersion: destinationPolicy.expectedVersion, signal });
        item.result = { destination: receipt, bytes: item.measured.bytes, sourceRemoved: true, method: 'rename' };
        item.checkpoint = { phase: 'renamed', manifest, removed: manifest.map(entry => entry.path), receipt, targetParent: targetContainer.entry, targetManifest: await captureTarget(item, manifest, signal) };
        await save(task);
        return;
      } catch (error) {
        if (!error.details?.committed && !item.result) delete item.checkpoint;
        if (error.code !== 'EXDEV') throw error;
      } finally { await targetContainer.close(); }
    }
    await copy(task, item, manifest, destinationPolicy, signal);
  }

  async function runTask(task, signal) {
    try {
      task.status = 'running';
      await save(task);
      for (const item of task.items) {
        if (item.status !== 'pending') continue;
        if (signal.aborted) { item.status = 'cancelled'; continue; }
        item.status = 'running'; item.attempts++; item.bytesTransferred = 0;
        delete item.error;
        try {
          await save(task);
          await execute(task, item, signal);
          if (item.status !== 'skipped') item.status = 'completed';
        } catch (error) {
          if (item.result) error.details = { ...(error.details ?? {}), committed: true, sourceRemoved: item.result.sourceRemoved };
          item.error = errorView(error);
          item.status = error.code === 'CANCELLED' && !item.result && !error.details?.committed ? 'cancelled' : 'failed';
        }
        await save(task);
      }
      task.status = statusOf(task, signal.aborted);
      await save(task);
    } catch (error) {
      task.persistenceError = errorView(error);
      for (const item of task.items) if (item.status === 'pending' || item.status === 'running') {
        item.status = 'failed'; item.error = { code: 'TASK_PERSISTENCE_FAILED', message: 'Task persistence failed; further filesystem work was stopped.', details: { cause: error.code ?? 'IO_ERROR' } };
      }
      task.status = task.items.every(item => item.status === 'failed') ? 'failed' : 'partial';
      try { await save(task); } catch { notify(task); }
    }
  }
  function pump() {
    while (!stopped && active.size < bounds.concurrency && waiting.length) {
      const task = waiting.shift();
      if (task.status !== 'queued') continue;
      const controller = new AbortController();
      const run = { controller, promise: null };
      active.set(task.id, run);
      run.promise = runTask(task, controller.signal).finally(() => {
        active.delete(task.id);
        notify(tasks.get(task.id) ?? task);
        pump();
      });
    }
  }
  function schedule(task) { waiting.push(task); queueMicrotask(pump); }

  async function list() { await ready; return [...tasks.values()].map(view); }
  async function get({ taskId } = {}) { await ready; return view(taskOf(taskId)); }
  async function cancel({ taskId } = {}) {
    accepting(); await ready;
    const task = taskOf(taskId);
    if (terminalStates.has(task.status)) return view(task);
    const run = active.get(taskId);
    if (run) run.controller.abort();
    else {
      for (const item of task.items) if (item.status === 'pending') item.status = 'cancelled';
      task.status = 'cancelled';
    }
    task.cancelRequested = true;
    await save(task);
    return view(task);
  }
  async function dismiss({ taskId, expectedHistoryRevision } = {}) {
    accepting(); await ready;
    const current = taskOf(taskId);
    if (!quiescent(current)) fail('TASK_BUSY', 'Wait for the task and its metadata changes to finish before dismissing it.', 409);
    if (current.dismissed) return view(current);
    if (expectedHistoryRevision !== current.historyRevision) fail('TASK_CHANGED', 'The task history changed; reload it before dismissing.', 409);
    const candidate = structuredClone(current);
    candidate.historyRevision = nextHistoryRevision(current);
    candidate.dismissed = true;
    historyUpdates.add(taskId);
    notify(current);
    try {
      await save(candidate, false);
      tasks.set(taskId, candidate);
    } finally {
      historyUpdates.delete(taskId);
      notify(taskOf(taskId));
    }
    return view(taskOf(taskId));
  }
  async function retry({ taskId, items: patches = [] } = {}) {
    accepting(); await ready;
    const task = structuredClone(taskOf(taskId));
    if (!quiescent(task)) fail('TASK_BUSY', 'Wait for the task and its metadata changes to finish before retrying failed items.', 409);
    const failed = task.items.filter(item => item.status === 'failed');
    if (!failed.length) fail('NO_FAILED_ITEMS', 'Only failed items can be retried.', 409);
    if (!Array.isArray(patches)) fail('INVALID_REQUEST', 'Retry item patches must be an array.');
    const seen = new Set();
    for (const patch of patches) {
      const item = failed.find(item => item.id === patch?.id);
      if (!item || seen.has(item.id)) fail('INVALID_REQUEST', 'Retry patches must refer to distinct failed items.');
      seen.add(item.id);
      if (Object.keys(patch).some(key => !['id', 'conflict', 'name', 'expectedTargetVersion', 'expectedVersion'].includes(key))) fail('INVALID_REQUEST', 'A retry cannot change the source selection.');
      if (item.checkpoint && Object.keys(patch).some(key => key !== 'id')) fail('RECOVERY_REQUIRED', 'A published item cannot be retargeted or given a different source version.', 409);
      if (patch.conflict !== undefined && !policies.has(patch.conflict)) fail('INVALID_REQUEST', 'An item conflict strategy is invalid.');
      if (patch.name !== undefined) nameOf(patch.name);
      if (patch.expectedVersion !== undefined) versionOf(patch.expectedVersion);
    }
    for (const patch of patches) {
      const item = failed.find(item => item.id === patch.id);
      for (const key of ['conflict', 'name', 'expectedTargetVersion']) if (patch[key] !== undefined) item[key] = patch[key];
      if (patch.expectedVersion !== undefined) item.source.expectedVersion = patch.expectedVersion;
    }
    for (const item of failed) { item.status = 'pending'; delete item.error; }
    delete task.cancelRequested; delete task.persistenceError;
    task.historyRevision = nextHistoryRevision(task);
    task.dismissed = false;
    task.status = 'queued';
    requeuing.add(taskId);
    notify(taskOf(taskId));
    try {
      await save(task, false);
      tasks.set(task.id, task);
      schedule(task);
      return view(task);
    } finally {
      requeuing.delete(taskId);
      notify(taskOf(taskId));
    }
  }
  function controlled(operation) {
    if (stopped) return Promise.reject(new FileManagerError('SERVICE_STOPPED', 'The task service is stopping.', 503));
    const result = operation();
    controls.add(result);
    result.then(() => controls.delete(result), () => controls.delete(result));
    return result;
  }
  function close() {
    if (closingPromise) return closingPromise;
    stopped = true;
    for (const run of active.values()) run.controller.abort();
    closingPromise = (async () => {
      await Promise.allSettled([...controls]);
      await ready;
      for (const task of waiting.splice(0)) {
        for (const item of task.items) if (item.status === 'pending') item.status = 'cancelled';
        task.status = 'cancelled';
        await save(task);
      }
      await Promise.all([...active.values()].map(run => run.promise));
      await persistenceTail;
    })();
    return closingPromise;
  }

  return {
    start: input => controlled(() => start(input)), list, get,
    cancel: input => controlled(() => cancel(input)), retry: input => controlled(() => retry(input)),
    dismiss: input => controlled(() => dismiss(input)), close,
  };
}
