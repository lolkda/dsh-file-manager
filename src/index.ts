import { HEAVY_IO_QUEUE_LIMIT } from './contracts/limits.js';
import { FileManagerError } from './contracts/errors.js';
import type { DegradedView } from './contracts/views.js';
import { createFileManagerRouter, createUnavailableHandler, ROUTE_TABLE } from './host/http.js';
import { createHeavyIoScheduler } from './host/scheduler.js';
import { createManager } from './host/manager.js';
import { openOperationState, openProfileState, type OperationState, type ProfileState } from './host/state.js';
import { createTaskService } from './host/tasks.js';
import { createTransferService } from './host/transfers.js';
import { createEventHub, createWatchService } from './host/watch.js';
import { createRequestLedger } from './host/requests.js';
import type { PluginContext, RouteRegistration } from './host/context.js';
import { VERSION } from './version.js';

export { VERSION };
export { createControlHandler, createEventHandler, createFileManagerRouter, createTextHandler } from './host/http.js';

export const inject = ['connection', 'workspaceRegistry', 'storageDomain', 'settings'];

function causeCodeOf(error: unknown): string {
  const code = (error as FileManagerError | undefined)?.code;
  return typeof code === 'string' && code ? code : 'INITIALIZATION_FAILED';
}

/**
 * Register every v2 route for a file manager that could not open its durable
 * state. `bootstrap` still answers with the degradation reason so the client can
 * explain why nothing works; every other operation is refused.
 */
function registerUnavailable(ctx: PluginContext, degraded: DegradedView): void {
  for (const route of ROUTE_TABLE) {
    const registration: RouteRegistration = {
      path: route.path, methods: route.methods, requestBody: route.requestBody,
      fetch: createUnavailableHandler(degraded, {
        route: route.id,
        workspaces: () => ctx.workspaceRegistry.list().map(workspace => ({ id: workspace.id, path: workspace.path, title: workspace.title })),
        version: VERSION,
      }),
    };
    ctx.effect(() => ctx.connection.fetch.register(registration));
  }
}

/** Host-owned resources dispose in reverse order: routes, writes, then durable storage. */
export async function apply(ctx: PluginContext): Promise<void> {
  let profile: ProfileState | undefined;
  try {
    profile = await openProfileState(ctx);
  } catch (error) {
    // Unusable root grants make every file operation unsafe: refuse the whole surface.
    const causeCode = causeCodeOf(error);
    ctx.logger?.error?.(`[local-file-manager] root storage initialization failed (${causeCode}): ${String(error)}`);
    registerUnavailable(ctx, {
      scope: 'roots', code: causeCode,
      message: 'File manager storage could not initialize. File operations are disabled; inspect the Host log.',
      readOnly: false,
    });
    return;
  }
  const opened = profile;
  ctx.effect(() => () => opened.close());
  const limits = opened.limits;
  // One heavy-IO budget for copies, moves, uploads, downloads and verification.
  const scheduler = createHeavyIoScheduler({ concurrency: limits.transferConcurrency, queueLimit: HEAVY_IO_QUEUE_LIMIT });
  const manager = createManager({ ...opened.managerOptions, scheduler });
  ctx.effect(() => () => manager.close());

  let operations: OperationState | undefined;
  let degraded: DegradedView | null = null;
  try {
    operations = await openOperationState(ctx);
  } catch (error) {
    // The roots are trustworthy, so browsing and reading stay available; the
    // journal is left exactly as found and never reset.
    const causeCode = causeCodeOf(error);
    ctx.logger?.error?.(`[local-file-manager] operation journal unavailable (${causeCode}): ${String(error)}`);
    degraded = {
      scope: 'operations', code: causeCode,
      message: 'The operation journal is unavailable; the file manager is read-only.',
      readOnly: true,
    };
  }
  const journal = operations;

  const router = createFileManagerRouter({
    manager,
    limits,
    version: VERSION,
    persistentRoots: true,
    degraded,
    readOnly: degraded?.scope === 'operations',
    ledger: createRequestLedger(),
    workspaces: () => ctx.workspaceRegistry.list().map(workspace => ({ id: workspace.id, path: workspace.path, title: workspace.title })),
    ...(journal
      ? (() => {
        const events = createEventHub();
        ctx.effect(() => () => events.close());
        const tasks = createTaskService({
          ...journal.taskOptions, manager, limits, scheduler,
          onChange: task => events.publish({ kind: 'task', taskId: task.id, summary: { status: task.status, progress: task.progress, updatedAt: task.updatedAt } }),
        });
        ctx.effect(() => () => tasks.close());
        const transfers = createTransferService({
          ...journal.transferOptions, manager, limits, scheduler,
          onProgress: task => events.publish({
            kind: 'transfer', taskId: task.id,
            summary: {
              status: task.status, bytesTransferred: task.bytesTransferred, bytesTotal: task.bytesTotal,
              itemsCompleted: task.itemsCompleted, itemsTotal: task.itemsTotal,
            },
          }),
        });
        ctx.effect(() => () => transfers.close());
        const watcher = createWatchService({ manager, pollIntervalMs: limits.pollIntervalMs });
        ctx.effect(() => () => watcher.close());
        ctx.effect(() => () => journal.close());
        return { tasks, transfers, watcher, events };
      })()
      : {}),
  });

  for (const route of ROUTE_TABLE) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: route.path, methods: route.methods, requestBody: route.requestBody, fetch: router,
    }));
  }
}
