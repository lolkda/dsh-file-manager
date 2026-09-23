import { hostFixture } from '/app/project/dsh-files/dsh-file-manager-ts/tests/verify-harness.mjs';
import { createTaskService } from '/app/project/dsh-files/dsh-file-manager-ts/dist/host/tasks.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const durable = new Map();
const f = await hostFixture({ withTasks: true, persistTask: r => durable.set(r.id, structuredClone(r)) });
writeFileSync(path.join(f.directory, 'present.txt'), 'p'); mkdirSync(path.join(f.directory, 'dest'));
const started = await f.call('tasks.start', { operation: 'copy', items: [{ ...f.ref('absent.txt'), expectedVersion: '1:2:3:4:5' }], destination: f.ref('dest'), conflict: 'skip' }, { route: 'manifest' });
const failed = await f.settle(started.value.id);
const id = failed.id;
const retried = await f.tasks.retry({ taskId: id });
const revAfterRetry = retried.historyRevision;
// the TASK_BUSY attempt H1 makes while the retry is still running
await f.call('activities.dismiss', { items: [{ kind: 'task', taskId: id, expectedHistoryRevision: revAfterRetry }] });
await f.settle(id);
const rev = (await f.tasks.get({ taskId: id })).historyRevision;
await f.call('activities.dismiss', { items: [{ kind: 'task', taskId: id, expectedHistoryRevision: rev }] });
await f.tasks.close();
let input = [...durable.values()].map(r => structuredClone(r));
for (let round = 1; round <= 2; round++) {
  const writes = [];
  const svc = createTaskService({ manager: f.manager, limits: f.limits, initialTasks: input.map(r => structuredClone(r)), persistTask: r => writes.push(structuredClone(r)) });
  console.log(`open${round} writes=${writes.length}`);
  if (writes.length) {
    const a = input[0], b = writes[0];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) console.log(`   diff ${k}: ${JSON.stringify(a[k])} -> ${JSON.stringify(b[k])}`);
  }
  input = writes.length ? writes : input;
  await svc.close();
}
await f.close();
