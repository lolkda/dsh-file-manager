import { HEAVY_IO_QUEUE_LIMIT, resolveLimits, type ProfileLimitsInput } from './contracts/limits.js';
import { FileManagerError } from './contracts/errors.js';
import type { DegradedView } from './contracts/views.js';
import { createFileManagerRouter, createUnavailableHandler, ROUTE_TABLE } from './host/http.js';
import { createHeavyIoScheduler } from './host/scheduler.js';
import { createManager, type Manager } from './host/manager.js';
import { LIMITS_CONFIG, openOperationState, type OperationState } from './host/state.js';
import { createTaskService } from './host/tasks.js';
import { createTransferService } from './host/transfers.js';
import { createEventHub, createWatchService } from './host/watch.js';
import { createRequestLedger } from './host/requests.js';
import type { PluginContext, RouteRegistration } from './host/context.js';
import { VERSION } from './version.js';

export { VERSION };
export { createControlHandler, createEventHandler, createFileManagerRouter, createTextHandler } from './host/http.js';

/**
 * The plugin's Loader `Config`. DSH 0.1.7-rc.1 replaced the runtime
 * `settings.register(namespace, schema)` call with this declaration: the Loader
 * validates a profile row's `config` against `Config` and passes the resolved
 * values to {@link apply}. A row without `config` gets the contract defaults.
 */
export { LIMITS_CONFIG as Config };

export const inject = ['connection', 'storageDomain'];

function causeCodeOf(error: unknown): string {
  const code = (error as FileManagerError | undefined)?.code;
  return typeof code === 'string' && code ? code : 'INITIALIZATION_FAILED';
}

/**
 * Register every v2 route for a file manager that could not open its fixed root.
 * `bootstrap` still answers with the degradation reason so the client can explain
 * why nothing works; every other operation is refused.
 */
function registerUnavailable(ctx: PluginContext, degraded: DegradedView): void {
  for (const route of ROUTE_TABLE) {
    const registration: RouteRegistration = {
      path: route.path, methods: route.methods, requestBody: route.requestBody,
      fetch: createUnavailableHandler(degraded, { route: route.id, version: VERSION }),
    };
    ctx.effect(() => ctx.connection.fetch.register(registration));
  }
}

/**
 * Host-owned resources dispose in reverse order: routes, writes, then durable storage.
 *
 * `config` is the Loader-validated row configuration; the resolved limits are
 * the only configuration this plugin has. The browsable root is not
 * configuration: it is always the Host's `/`.
 */
export async function apply(ctx: PluginContext, config: ProfileLimitsInput = {}): Promise<void> {
  const limits = resolveLimits(config);
  // One heavy-IO budget for copies, moves, uploads, downloads and verification.
  const scheduler = createHeavyIoScheduler({ concurrency: limits.transferConcurrency, queueLimit: HEAVY_IO_QUEUE_LIMIT });
  let manager: Manager;
  try {
    // The root is opened and identity-checked here, before any route exists: an
    // unverifiable root refuses the whole surface instead of answering requests
    // against an unproven directory.
    manager = createManager({
      maxTextBytes: limits.maxTextBytes,
      maxVerificationBytes: limits.maxVerificationBytes,
      deletePlanTtlMs: limits.deletePlanTtlMs,
      scheduler,
    });
  } catch (error) {
    const causeCode = causeCodeOf(error);
    ctx.logger?.error?.(`[local-file-manager] root initialization failed (${causeCode}): ${String(error)}`);
    registerUnavailable(ctx, {
      scope: 'filesystem', code: causeCode,
      message: 'The filesystem root could not be opened. File operations are disabled; inspect the Host log.',
      readOnly: false,
    });
    return;
  }
  ctx.effect(() => () => manager.close());

  let operations: OperationState | undefined;
  let degraded: DegradedView | null = null;
  try {
    operations = await openOperationState(ctx);
  } catch (error) {
    // The root is verified, so browsing and reading stay available; the
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
    degraded,
    readOnly: degraded?.scope === 'operations',
    ledger: createRequestLedger(),
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
