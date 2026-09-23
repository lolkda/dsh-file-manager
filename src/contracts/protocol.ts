/**
 * Frozen wire protocol: one discriminated union per endpoint, typed with
 * `z.infer` so a request/result type can never drift from its schema.
 *
 * The schemas define the **admission grammar** and the **response shapes**.
 * They do not replace the Host's own validation: every operation re-validates
 * its input through the manager/task/transfer engines, and those engines own the
 * stable business codes. A field whose absence is already a documented business
 * failure (`VERSION_REQUIRED`, `STRONG_VERSION_REQUIRED`, `CONFIRMATION_REQUIRED`,
 * `INVALID_PATH`, …) therefore stays optional here and is rejected by the Host
 * with its existing code and status.
 *
 * Naming rule: `XRequestSchema` / `XResultSchema` for a single operation,
 * `XViewSchema` for a public DTO owned by `views.ts`.
 */

import { z } from 'zod';
import { fail } from './errors.js';
import {
  CONTROL_ENVELOPE_BYTES, LIMIT_NAMES, MANIFEST_ENVELOPE_BYTES, MANIFEST_OPS,
  SMALL_BODY_ADMISSION, LARGE_BODY_ADMISSION, type LimitName, type ProfileLimits,
} from './limits.js';
import {
  AbsoluteRootPathSchema, ActivityReceiptSchema, DegradedViewSchema, DeleteCommitResultSchema, DeletePlanSchema,
  EchoedVersionSchema, EntryChildPathSchema, EntryPathSchema, EntrySnapshotSchema, EntryStatSchema,
  EpochMillisSchema, IsoTimestampSchema, LeafNameSchema, NonNegativeIntegerSchema, PublicErrorSchema,
  PublicTaskViewSchema, PublicTransferViewSchema, RequestIdSchema, RootDescriptorSchema, RootIdSchema,
  RootPathRefSchema, TaskProgressSchema, TaskStatusSchema, TextReceiptSchema, TextSnapshotSchema,
  TransferPathSchema, UnaddressableEntrySchema, UploadConflictSchema, WorkspaceCandidateSchema,
} from './views.js';

/**
 * Public view types, re-exported so a consumer can import every wire type from
 * this one module.
 *
 * Only types are re-exported: the zod schemas stay in `views.ts`, and the Client
 * must use `import type` anyway, so zod never enters the browser bundle.
 */
export type {
  ActivityDismissedReceipt, ActivityKind, ActivityReceipt, ActivityRejectedReceipt,
  ContentVersion, DegradedOperations, DegradedRoots, DegradedView,
  DeleteCommitResult, DeletePlan, EntryKind, EntrySnapshot, EntryStat, EntryVersion,
  JsonValue, MetadataVersion, NewlineStyle, PublicEntrySummary, PublicError, PublicTaskItem,
  PublicTaskView, PublicTransferItem, PublicTransferView, RootDescriptor, RootPathRef, TaskItemStatus,
  TaskProgress, TaskStatus, TextReceipt, TextSnapshot, UnaddressableEntry, WorkspaceCandidate,
} from './views.js';
export type { TaskConflictPolicy, UploadConflictPolicy } from './limits.js';

/* ------------------------------------------------------------------ *
 * Operations
 * ------------------------------------------------------------------ */

/** Every control operation the Host dispatches, in dispatch order. */
export const CONTROL_OPS = [
  'bootstrap',
  'roots.list',
  'roots.add',
  'roots.remove',
  'entries.list',
  'entries.stat',
  'entries.reference',
  'text.read',
  'entries.create-file',
  'entries.create-directory',
  'entries.rename',
  'delete.prepare',
  'delete.commit',
  'activities.dismiss',
  'tasks.start',
  'tasks.list',
  'tasks.get',
  'tasks.cancel',
  'tasks.retry',
  'transfers.begin',
  'transfers.list',
  'transfers.get',
  'transfers.cancel',
  'transfers.retry',
] as const;
export type ControlOp = (typeof CONTROL_OPS)[number];

/**
 * Operations that mutate durable state. They require a `requestId` and are
 * replayed idempotently inside one ledger window; a reused id with a different
 * fingerprint is `REQUEST_ID_REUSED` / 409.
 */
export const MUTATION_OPS = [
  'roots.add',
  'roots.remove',
  'entries.create-file',
  'entries.create-directory',
  'entries.rename',
  'delete.commit',
  'activities.dismiss',
  'tasks.start',
  'tasks.cancel',
  'tasks.retry',
  'transfers.begin',
  'transfers.cancel',
  'transfers.retry',
] as const;
export type MutationOp = (typeof MUTATION_OPS)[number];

/** True when `op` must carry a request id and be de-duplicated by the ledger. */
export function isMutationOp(op: unknown): op is MutationOp {
  return typeof op === 'string' && (MUTATION_OPS as readonly string[]).includes(op);
}

/** The only operation the text route accepts. */
export const TEXT_OPS = ['save'] as const;
export type TextOp = (typeof TEXT_OPS)[number];

/* ------------------------------------------------------------------ *
 * Envelopes
 * ------------------------------------------------------------------ */

/** Read-only operations tolerate a request id and ignore it. */
const readEnvelope = { requestId: RequestIdSchema.optional() };
/** Mutating operations require one. */
const mutationEnvelope = { requestId: RequestIdSchema };

export const SuccessEnvelopeSchema = z.object({ ok: z.literal(true), value: z.unknown() });
export const FailureEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: PublicErrorSchema,
  /** Some transfer failures return the task view alongside the failure. */
  value: z.unknown().optional(),
});
export const ResponseEnvelopeSchema = z.discriminatedUnion('ok', [SuccessEnvelopeSchema, FailureEnvelopeSchema]);
export type ResponseEnvelope = z.infer<typeof ResponseEnvelopeSchema>;

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

export const CapabilitiesSchema = z.object({
  write: z.boolean(),
  persistentRoots: z.boolean(),
  tasks: z.boolean(),
  transfers: z.boolean(),
  watch: z.boolean(),
  references: z.boolean(),
  taskHistory: z.boolean(),
}).strict();
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/** The effective profile limits; every field mirrors `LIMIT_DEFAULTS` keys. */
export const PublicLimitsSchema = z.object({
  maxTextBytes: NonNegativeIntegerSchema,
  maxFileBytes: NonNegativeIntegerSchema,
  maxTaskBytes: NonNegativeIntegerSchema,
  maxTaskEntries: NonNegativeIntegerSchema,
  transferConcurrency: NonNegativeIntegerSchema,
  pollIntervalMs: NonNegativeIntegerSchema,
  deletePlanTtlMs: NonNegativeIntegerSchema,
  maxVerificationBytes: NonNegativeIntegerSchema,
}).strict();
export type PublicLimits = z.infer<typeof PublicLimitsSchema>;

/**
 * Compile-time proof that the public limits DTO covers exactly the frozen limit
 * names: `PublicLimits` must be usable wherever `ProfileLimits` is expected.
 */
export function publicLimitsOf(limits: PublicLimits): ProfileLimits {
  return limits;
}

/** The frozen set of limit names, exported for callers that iterate them. */
export const PUBLIC_LIMIT_NAMES: readonly LimitName[] = Object.freeze([...LIMIT_NAMES]);

export const BootstrapViewSchema = z.object({
  roots: z.array(RootDescriptorSchema),
  workspaces: z.array(WorkspaceCandidateSchema),
  /** Must equal the installed package version. */
  version: z.string().min(1),
  stage: z.literal('basic-management'),
  limits: PublicLimitsSchema,
  capabilities: CapabilitiesSchema,
  /**
   * Required. `null` means healthy; a degraded value carries the reason and the
   * scope. While degraded, refusals answer `FILE_MANAGER_UNAVAILABLE` / 503 with
   * `details.scope`, and unavailable history is never reported as empty history.
   */
  degraded: DegradedViewSchema.nullable(),
}).strict();
export type BootstrapView = z.infer<typeof BootstrapViewSchema>;

export const BootstrapRequestSchema = z.object({ op: z.literal('bootstrap'), ...readEnvelope });

/* ------------------------------------------------------------------ *
 * Roots
 * ------------------------------------------------------------------ */

export const RootsListRequestSchema = z.object({ op: z.literal('roots.list'), ...readEnvelope });
export const RootsListResultSchema = z.array(RootDescriptorSchema);

export const RootsAddRequestSchema = z.object({
  op: z.literal('roots.add'),
  /** The only operation that accepts an absolute path. */
  path: AbsoluteRootPathSchema,
  ...mutationEnvelope,
});
export const RootsAddResultSchema = RootDescriptorSchema;

export const RootsRemoveRequestSchema = z.object({
  op: z.literal('roots.remove'),
  rootId: RootIdSchema,
  ...mutationEnvelope,
});
/** Removing a grant never deletes disk data and never revokes by accident. */
export const RootsRemoveResultSchema = z.object({ rootId: RootIdSchema, removed: z.literal(true) }).strict();

/* ------------------------------------------------------------------ *
 * Entries
 * ------------------------------------------------------------------ */

export const EntriesListRequestSchema = z.object({
  op: z.literal('entries.list'),
  rootId: RootIdSchema,
  /** Defaults to the granted root. */
  path: EntryPathSchema.optional(),
  /** Defaults to 200; the Host rejects anything outside 1..500. */
  limit: z.number().int().min(1).max(500).optional(),
  /** Opaque continuation token minted by a previous page of the same directory. */
  cursor: z.string().min(1).optional(),
  ...readEnvelope,
});

export const EntriesListResultSchema = z.object({
  rootId: RootIdSchema,
  path: EntryPathSchema,
  /**
   * Addressable entries only, in the usual order. A name the path grammar cannot
   * express never appears here (R18).
   */
  entries: z.array(EntrySnapshotSchema),
  /**
   * Names in this page that the path grammar cannot express, in readdir order.
   * They carry no `path`, so they cannot be executed; the Client renders `name`
   * and `reason` and offers no entry, selection, reference or delete action.
   */
  unaddressable: z.array(UnaddressableEntrySchema),
  /** Number of addressable entries in the whole directory (not the page). */
  total: NonNegativeIntegerSchema,
  /** Continues over the full readdir order, unaddressable names included. */
  nextCursor: z.string().min(1).nullable(),
}).strict();
export type EntriesListView = z.infer<typeof EntriesListResultSchema>;

export const EntriesStatRequestSchema = z.object({
  op: z.literal('entries.stat'), rootId: RootIdSchema, path: EntryPathSchema, ...readEnvelope,
});
export const EntriesStatResultSchema = EntryStatSchema;

export const EntriesReferenceRequestSchema = z.object({
  op: z.literal('entries.reference'), rootId: RootIdSchema, path: EntryChildPathSchema, ...readEnvelope,
});
/** A reference into a session draft: an absolute path plus its `@`-mention form. */
export const EntriesReferenceResultSchema = z.object({
  rootId: RootIdSchema,
  path: EntryChildPathSchema,
  kind: z.enum(['file', 'directory']),
  absolutePath: z.string().min(1),
  mention: z.string().min(1),
}).strict();
export type EntriesReferenceView = z.infer<typeof EntriesReferenceResultSchema>;

export const TextReadRequestSchema = z.object({
  op: z.literal('text.read'), rootId: RootIdSchema, path: EntryPathSchema, ...readEnvelope,
});
export const TextReadResultSchema = TextSnapshotSchema;

export const EntriesCreateFileRequestSchema = z.object({
  op: z.literal('entries.create-file'), rootId: RootIdSchema, path: EntryChildPathSchema, ...mutationEnvelope,
});
/** Creating a file is always empty; content is written through the text route. */
export const EntriesCreateFileResultSchema = TextReceiptSchema;

export const EntriesCreateDirectoryRequestSchema = z.object({
  op: z.literal('entries.create-directory'), rootId: RootIdSchema, path: EntryChildPathSchema, ...mutationEnvelope,
});
export const EntriesCreateDirectoryResultSchema = EntryStatSchema;

export const EntriesRenameRequestSchema = z.object({
  op: z.literal('entries.rename'),
  rootId: RootIdSchema,
  path: EntryChildPathSchema,
  name: LeafNameSchema,
  /**
   * Required. A missing token is `VERSION_REQUIRED` / 409, a stale one is
   * `VERSION_CONFLICT` / 409; neither ever becomes an unchecked rename.
   */
  expectedVersion: EchoedVersionSchema.optional(),
  ...mutationEnvelope,
});
export const EntriesRenameResultSchema = EntryStatSchema;

/* ------------------------------------------------------------------ *
 * Deletion
 * ------------------------------------------------------------------ */

export const DeletePrepareRequestSchema = z.object({
  op: z.literal('delete.prepare'),
  /** 1..10000 selections; overlapping ancestor/descendant picks are de-duplicated. */
  items: z.array(RootPathRefSchema).min(1).max(10000),
  ...readEnvelope,
});
export const DeletePrepareResultSchema = DeletePlanSchema;

export const DeleteCommitRequestSchema = z.object({
  op: z.literal('delete.commit'),
  planId: z.string().min(1),
  /** Must be exactly `true`; otherwise `CONFIRMATION_REQUIRED` / 400. */
  confirmed: z.boolean().optional(),
  ...mutationEnvelope,
});
export const DeleteCommitResultSchemaRef = DeleteCommitResultSchema;

/* ------------------------------------------------------------------ *
 * Task history
 * ------------------------------------------------------------------ */

export const ActivityDismissRequestSchema = z.object({
  op: z.literal('activities.dismiss'),
  /**
   * Distinct descriptors. Unknown keys are rejected exactly as the Host rejects
   * them, and every descriptor is validated before any record closes. The 256
   * entry cap stays with the Host so an oversized batch keeps its `TOO_LARGE`
   * / 413 answer.
   */
  items: z.array(z.object({
    kind: z.enum(['task', 'transfer']),
    taskId: z.string().min(1).max(128),
    expectedHistoryRevision: z.number().int().nonnegative(),
  }).strict()).min(1),
  ...mutationEnvelope,
});
export const ActivityDismissResultSchema = z.object({ results: z.array(ActivityReceiptSchema) }).strict();

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

export const TaskSelectionSchema = z.object({
  rootId: RootIdSchema,
  path: EntryChildPathSchema,
  /**
   * The version observed when the entry was selected (caller echo). Only
   * non-empty is required here; a missing token is `VERSION_REQUIRED` / 409.
   */
  expectedVersion: EchoedVersionSchema.optional(),
  conflict: z.enum(['skip', 'rename', 'overwrite']).optional(),
  /** Explicit conflict name; required to resolve an existing `rename` target. */
  name: LeafNameSchema.optional(),
  /**
   * Required for `overwrite`: a **content-bound** target version. The engine
   * refuses a weak stamp with `STRONG_VERSION_REQUIRED` / 409, so this stays an
   * echoed field here and the token rule is enforced where it can be proven.
   */
  expectedTargetVersion: EchoedVersionSchema.optional(),
});

export const TasksStartRequestSchema = z.object({
  op: z.literal('tasks.start'),
  operation: z.enum(['copy', 'move']),
  items: z.array(TaskSelectionSchema).min(1),
  destination: RootPathRefSchema,
  conflict: z.enum(['skip', 'rename', 'overwrite']).optional(),
  ...mutationEnvelope,
});
export const TasksStartResultSchema = PublicTaskViewSchema;

export const TasksListRequestSchema = z.object({ op: z.literal('tasks.list'), ...readEnvelope });
export const TasksListResultSchema = z.array(PublicTaskViewSchema);

export const TasksGetRequestSchema = z.object({ op: z.literal('tasks.get'), taskId: z.string().min(1), ...readEnvelope });
export const TasksGetResultSchema = PublicTaskViewSchema;

export const TasksCancelRequestSchema = z.object({ op: z.literal('tasks.cancel'), taskId: z.string().min(1), ...mutationEnvelope });
export const TasksCancelResultSchema = PublicTaskViewSchema;

/** A retry patch may only change conflict handling, never the source selection. */
export const TaskRetryPatchSchema = z.object({
  id: z.string().min(1),
  conflict: z.enum(['skip', 'rename', 'overwrite']).optional(),
  name: LeafNameSchema.optional(),
  expectedTargetVersion: EchoedVersionSchema.optional(),
  expectedVersion: EchoedVersionSchema.optional(),
}).strict();

export const TasksRetryRequestSchema = z.object({
  op: z.literal('tasks.retry'),
  taskId: z.string().min(1),
  items: z.array(TaskRetryPatchSchema).optional(),
  ...mutationEnvelope,
});
export const TasksRetryResultSchema = PublicTaskViewSchema;

/* ------------------------------------------------------------------ *
 * Transfers
 * ------------------------------------------------------------------ */

export const UploadSourceSchema = z.object({
  path: TransferPathSchema,
  kind: z.enum(['file', 'directory']),
  /** Exact byte size; directories are always 0. */
  size: NonNegativeIntegerSchema,
  conflict: UploadConflictSchema.optional(),
  /** Required when `conflict` is `overwrite`; otherwise `VERSION_REQUIRED` / 409. */
  expectedVersion: EchoedVersionSchema.optional(),
});

export const TransfersBeginRequestSchema = z.object({
  op: z.literal('transfers.begin'),
  direction: z.enum(['upload', 'download']),
  rootId: RootIdSchema,
  /** Upload destination directory, or the entry to download; `''` is the root. */
  path: TransferPathSchema,
  /**
   * Upload manifest; absent for a download. The count, duplicate-path and
   * ancestor rules stay with the transfer engine so its `INVALID_MANIFEST` and
   * `TOO_LARGE` codes are preserved.
   */
  items: z.array(UploadSourceSchema).optional(),
  /** Download only: refuse if the selected entry already changed. */
  expectedVersion: EchoedVersionSchema.optional(),
  ...mutationEnvelope,
});
export const TransfersBeginResultSchema = PublicTransferViewSchema;

export const TransfersListRequestSchema = z.object({ op: z.literal('transfers.list'), ...readEnvelope });
export const TransfersListResultSchema = z.array(PublicTransferViewSchema);

export const TransfersGetRequestSchema = z.object({ op: z.literal('transfers.get'), taskId: z.string().min(1), ...readEnvelope });
export const TransfersGetResultSchema = PublicTransferViewSchema;

export const TransfersCancelRequestSchema = z.object({ op: z.literal('transfers.cancel'), taskId: z.string().min(1), ...mutationEnvelope });
export const TransfersCancelResultSchema = PublicTransferViewSchema;

export const TransfersRetryRequestSchema = z.object({ op: z.literal('transfers.retry'), taskId: z.string().min(1), ...mutationEnvelope });
export const TransfersRetryResultSchema = PublicTransferViewSchema;

/* ------------------------------------------------------------------ *
 * Unions and typed lookups
 * ------------------------------------------------------------------ */

export const ControlRequestSchema = z.discriminatedUnion('op', [
  BootstrapRequestSchema,
  RootsListRequestSchema,
  RootsAddRequestSchema,
  RootsRemoveRequestSchema,
  EntriesListRequestSchema,
  EntriesStatRequestSchema,
  EntriesReferenceRequestSchema,
  TextReadRequestSchema,
  EntriesCreateFileRequestSchema,
  EntriesCreateDirectoryRequestSchema,
  EntriesRenameRequestSchema,
  DeletePrepareRequestSchema,
  DeleteCommitRequestSchema,
  ActivityDismissRequestSchema,
  TasksStartRequestSchema,
  TasksListRequestSchema,
  TasksGetRequestSchema,
  TasksCancelRequestSchema,
  TasksRetryRequestSchema,
  TransfersBeginRequestSchema,
  TransfersListRequestSchema,
  TransfersGetRequestSchema,
  TransfersCancelRequestSchema,
  TransfersRetryRequestSchema,
]);
export type ControlRequest = z.infer<typeof ControlRequestSchema>;

export const TextRequestSchema = z.object({
  op: z.literal('save'),
  rootId: RootIdSchema,
  path: EntryChildPathSchema,
  text: z.string(),
  /** Required; a missing token is `VERSION_REQUIRED` / 409. */
  expectedVersion: EchoedVersionSchema.optional(),
  ...mutationEnvelope,
});
export type TextRequest = z.infer<typeof TextRequestSchema>;

/**
 * Per-operation result schemas. `ControlResult<Op>` is derived from this table,
 * so the Client can type one `api()` call per op without a second definition.
 */
export const CONTROL_RESULTS = {
  bootstrap: BootstrapViewSchema,
  'roots.list': RootsListResultSchema,
  'roots.add': RootsAddResultSchema,
  'roots.remove': RootsRemoveResultSchema,
  'entries.list': EntriesListResultSchema,
  'entries.stat': EntriesStatResultSchema,
  'entries.reference': EntriesReferenceResultSchema,
  'text.read': TextReadResultSchema,
  'entries.create-file': EntriesCreateFileResultSchema,
  'entries.create-directory': EntriesCreateDirectoryResultSchema,
  'entries.rename': EntriesRenameResultSchema,
  'delete.prepare': DeletePrepareResultSchema,
  'delete.commit': DeleteCommitResultSchemaRef,
  'activities.dismiss': ActivityDismissResultSchema,
  'tasks.start': TasksStartResultSchema,
  'tasks.list': TasksListResultSchema,
  'tasks.get': TasksGetResultSchema,
  'tasks.cancel': TasksCancelResultSchema,
  'tasks.retry': TasksRetryResultSchema,
  'transfers.begin': TransfersBeginResultSchema,
  'transfers.list': TransfersListResultSchema,
  'transfers.get': TransfersGetResultSchema,
  'transfers.cancel': TransfersCancelResultSchema,
  'transfers.retry': TransfersRetryResultSchema,
} as const satisfies Record<ControlOp, z.ZodType>;

export type ControlResult<Op extends ControlOp> = z.infer<(typeof CONTROL_RESULTS)[Op]>;
export type TextResult = z.infer<typeof TextReceiptSchema>;

/* ------------------------------------------------------------------ *
 * Parsing helpers (Host boundary)
 * ------------------------------------------------------------------ */

function parseOrReject<T>(schema: z.ZodType<T>, payload: unknown, message: string): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    fail('INVALID_REQUEST', message, 400, {
      issues: result.error.issues.slice(0, 8).map(issue => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return result.data;
}

/**
 * Admit a control payload. A non-object, an unknown `op` or a malformed field is
 * `INVALID_REQUEST` / 400; the Host then runs its own validation for the codes
 * the schema deliberately leaves to it.
 */
export function parseControlRequest(payload: unknown): ControlRequest {
  return parseOrReject(ControlRequestSchema, payload, 'A valid control request is required.');
}

/** Admit a text-save payload. */
export function parseTextRequest(payload: unknown): TextRequest {
  return parseOrReject(TextRequestSchema, payload, 'A valid text save request is required.');
}

/* ------------------------------------------------------------------ *
 * HTTP routes and admission
 * ------------------------------------------------------------------ */

/** Route ids, in registration order. */
export const ROUTE_IDS = ['control', 'manifest', 'text', 'upload', 'download', 'events'] as const;
export type RouteId = (typeof ROUTE_IDS)[number];

/** Frozen v2 route table. Legacy v1 routes must be refused with an upgrade error. */
export const ROUTES = {
  control: { path: '/api/file-manager/v2/control', methods: ['POST'], requestBody: 'streaming' },
  manifest: { path: '/api/file-manager/v2/manifest', methods: ['POST'], requestBody: 'streaming' },
  text: { path: '/api/file-manager/v2/text', methods: ['POST'], requestBody: 'streaming' },
  upload: { path: '/api/file-manager/v2/upload', methods: ['POST'], requestBody: 'streaming' },
  download: { path: '/api/file-manager/v2/download', methods: ['GET'], requestBody: 'buffered' },
  events: { path: '/api/file-manager/v2/events', methods: ['POST'], requestBody: 'streaming' },
} as const satisfies Record<RouteId, { path: string; methods: readonly string[]; requestBody: string }>;

/** Routes that existed before the v2 migration; they must answer with an upgrade error. */
export const LEGACY_ROUTES: readonly string[] = Object.freeze([
  '/api/file-manager/control',
  '/api/file-manager/text',
  '/api/file-manager/upload',
  '/api/file-manager/download',
  '/api/file-manager/events',
]);

/** Envelope bound for a route: small for control/text/events, manifest for the rest. */
export function routeEnvelopeBytes(route: RouteId): number {
  return route === 'manifest' ? MANIFEST_ENVELOPE_BYTES : CONTROL_ENVELOPE_BYTES;
}

/** Simultaneous-body admission for a route; excess requests are refused, not queued. */
export function routeAdmission(route: RouteId): number {
  return route === 'manifest' || route === 'upload' || route === 'download'
    ? LARGE_BODY_ADMISSION
    : SMALL_BODY_ADMISSION;
}

/** The manifest route accepts only the bulk operations, never a small control op. */
export function manifestRouteAccepts(op: unknown): boolean {
  return typeof op === 'string' && (MANIFEST_OPS as readonly string[]).includes(op);
}

export const UploadQuerySchema = z.object({
  taskId: z.string().min(1),
  itemId: z.string().min(1),
});
export type UploadQuery = z.infer<typeof UploadQuerySchema>;

export const DownloadQuerySchema = z.object({ taskId: z.string().min(1) });
export type DownloadQuery = z.infer<typeof DownloadQuerySchema>;

/* ------------------------------------------------------------------ *
 * Event stream
 * ------------------------------------------------------------------ */

export const WATCH_STATUSES = ['watching', 'polling', 'unavailable'] as const;
export const INVALIDATE_REASONS = ['watch', 'reconcile', 'recovered'] as const;

export const EventRequestSchema = z.object({
  /** At most 128 distinct directory targets. */
  targets: z.array(RootPathRefSchema).max(128),
  requestId: RequestIdSchema.optional(),
});
export type EventRequest = z.infer<typeof EventRequestSchema>;

const eventBase = { seq: NonNegativeIntegerSchema };
const eventTarget = { rootId: RootIdSchema, path: EntryPathSchema };

export const EventFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), reason: z.enum(['connected', 'overflow']), ...eventBase }),
  z.object({ kind: z.literal('heartbeat'), ...eventBase }),
  z.object({ kind: z.literal('invalidate'), reason: z.enum(INVALIDATE_REASONS), ...eventTarget, ...eventBase }),
  z.object({ kind: z.literal('watch-status'), status: z.enum(WATCH_STATUSES), code: z.string().min(1).optional(), ...eventTarget, ...eventBase }),
  z.object({ kind: z.literal('task'), taskId: z.string().min(1), summary: z.object({ status: TaskStatusSchema, progress: TaskProgressSchema, updatedAt: z.union([IsoTimestampSchema, EpochMillisSchema]) }).strict(), ...eventBase }),
  z.object({ kind: z.literal('transfer'), taskId: z.string().min(1), summary: z.object({ status: TaskStatusSchema, bytesTransferred: NonNegativeIntegerSchema, bytesTotal: NonNegativeIntegerSchema, itemsCompleted: NonNegativeIntegerSchema, itemsTotal: NonNegativeIntegerSchema }).strict(), ...eventBase }),
  z.object({ kind: z.literal('error'), code: z.string().min(1), ...eventBase }),
  z.object({ kind: z.literal('closed'), ...eventBase }),
]);
export type EventFrame = z.infer<typeof EventFrameSchema>;

/** Admit an event-subscription payload; `op` is not required on this route. */
export function parseEventRequest(payload: unknown): EventRequest {
  return parseOrReject(EventRequestSchema, payload, 'Provide up to 128 directory watch targets.');
}