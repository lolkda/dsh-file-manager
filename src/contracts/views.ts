/**
 * Frozen public view contract: version-token vocabulary, wire primitives and the
 * whitelist projections that turn an internal record into what a caller may see.
 *
 * Three concepts are deliberately kept apart:
 *
 * 1. **Metadata snapshot** — `name/path/kind/size/modifiedAt/mode` plus a weak
 *    {@link MetadataVersion} (`dev:ino:size:mtimeNs:ctimeNs`). Cheap, listing-safe,
 *    and enough to browse, select and reference an entry. A weak version never
 *    authorizes an overwrite and never starts content hashing.
 * 2. **Content version** — a {@link ContentVersion} (`metadataVersion:sha256`).
 *    Only a bounded, cancellable read of the actual bytes can mint one. Wherever
 *    content may be replaced or verified, the *type* demands it and the Host
 *    re-checks it at runtime.
 * 3. **Recovery proof** — publication manifests, receipts, target-parent
 *    identities and digests. These are persisted with the raw operation record
 *    and are never part of a public view; see {@link RECOVERY_PROOF_FIELDS}.
 *
 * The projectors here accept the internal record as `unknown` and build the
 * public object field by field, so a new internal field can never leak by
 * accident: only explicitly picked fields survive, and a missing required field
 * is reported as an internal fault instead of being silently dropped.
 */

import { z } from 'zod';
import { fail, isErrnoCode, normalizeError, publicErrorDetails, type NormalizeOptions } from './errors.js';
import { RELATIVE_PATH_MAX_LENGTH } from './limits.js';

/* ------------------------------------------------------------------ *
 * Version tokens
 * ------------------------------------------------------------------ */

/** `dev:ino:size:mtimeNs:ctimeNs` — the weak listing stamp. */
export const METADATA_VERSION_PATTERN = /^\d+:\d+:\d+:\d+:\d+$/;
/** A lowercase hex SHA-256 digest. */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** `metadataVersion:sha256` — a version bound to the actual content bytes. */
export const CONTENT_VERSION_PATTERN = /^\d+:\d+:\d+:\d+:\d+:[0-9a-f]{64}$/;

export const MetadataVersionSchema = z.string().regex(METADATA_VERSION_PATTERN).brand<'MetadataVersion'>();
/** Weak, listing-scoped version. Never authorizes replacing content. */
export type MetadataVersion = z.infer<typeof MetadataVersionSchema>;

export const ContentVersionSchema = z.string().regex(CONTENT_VERSION_PATTERN).brand<'ContentVersion'>();
/** Strong, content-bound version. The only token that may authorize an overwrite. */
export type ContentVersion = z.infer<typeof ContentVersionSchema>;

export const Sha256Schema = z.string().regex(SHA256_PATTERN);

/**
 * A version field the **caller echoed back** — the value observed when the entry
 * was selected. The engine only requires it to be a non-empty string
 * (`versionOf`), and its authoritative check happens at execution time
 * (`VERSION_REQUIRED`, `STRONG_VERSION_REQUIRED`, `VERSION_CONFLICT`).
 *
 * It must never be constrained by the token grammar: a stored record that the
 * engine accepted would otherwise fail projection, and one bad record would take
 * the whole history down with `INVALID_STATE` — exactly what R13/R17 forbid.
 */
export const EchoedVersionSchema = z.string().min(1);

/**
 * Either **Host-minted** token. Use this for values the Host itself produced
 * (listing stamps, `stat`/`text.read` versions, publication receipts, deletion
 * manifests); use {@link EchoedVersionSchema} for values the caller echoed back.
 */
export const EntryVersionSchema = z.union([ContentVersionSchema, MetadataVersionSchema]);
export type EntryVersion = z.infer<typeof EntryVersionSchema>;

/** True when `value` is a content-bound (strong) version token. */
export function isContentVersion(value: unknown): value is ContentVersion {
  return typeof value === 'string' && CONTENT_VERSION_PATTERN.test(value);
}

/** True when `value` is a weak metadata version token. */
export function isMetadataVersion(value: unknown): value is MetadataVersion {
  return typeof value === 'string' && METADATA_VERSION_PATTERN.test(value);
}

/** The metadata half of either token; the digest half is dropped when present. */
export function metadataVersionOf(version: EntryVersion): MetadataVersion {
  const metadata = isContentVersion(version) ? version.slice(0, version.lastIndexOf(':')) : version;
  const parsed = MetadataVersionSchema.safeParse(metadata);
  if (!parsed.success) fail('INVALID_STATE', 'A version token is not well formed.', 500, { version: String(version) });
  return parsed.data;
}

/** Parse a version a caller selected; a missing token is `VERSION_REQUIRED` / 409. */
export function requireEntryVersion(value: unknown, message = 'An expected file version is required.'): EntryVersion {
  const parsed = EntryVersionSchema.safeParse(value);
  if (!parsed.success) fail('VERSION_REQUIRED', message, 409);
  return parsed.data;
}

/**
 * Parse a content-bound version. This is the runtime half of the strong-version
 * rule: a weak listing stamp, an absent token or a plain `string` fails here
 * even if a caller somehow bypassed the type system.
 */
export function requireContentVersion(
  value: unknown,
  message = 'Overwrite requires a content-bound destination version from an explicit file stat.',
): ContentVersion {
  const parsed = ContentVersionSchema.safeParse(value);
  if (!parsed.success) fail('STRONG_VERSION_REQUIRED', message, 409);
  return parsed.data;
}

/* ------------------------------------------------------------------ *
 * Shared wire primitives
 * ------------------------------------------------------------------ */

export const RootIdSchema = z.string().min(1).max(128);
export const FileNameSchema = z.string().min(1);
/** An entry name as reported by the engine; the granted root reports an empty name. */
export const EntryNameSchema = z.string();
export const IsoTimestampSchema = z.iso.datetime();
/** Epoch milliseconds; the transfer engine stores numeric timestamps. */
export const EpochMillisSchema = z.number().int().nonnegative();
export const NonNegativeIntegerSchema = z.number().int().nonnegative();
export const ModeSchema = z.number().int().nonnegative().max(0o7777);

/**
 * Root-relative path grammar, documented in one place and **enforced by the
 * engine**, not by these schemas.
 *
 * `host/manager.ts` (`partsOf`) and `host/transfers.ts` (`relativePath`) own the
 * grammar so a malformed path keeps its `INVALID_PATH` / `INVALID_MANIFEST`
 * answer and its specific Client wording. The predicates below are the written
 * form of that grammar: the engine implements it, the verification tests
 * cross-check the engine against it. Nothing validates with them in production,
 * so there is exactly one enforcement point.
 */
export function entryPathViolation(value: string, allowRoot = true): string | undefined {
  if (value.length > RELATIVE_PATH_MAX_LENGTH) return `it exceeds ${RELATIVE_PATH_MAX_LENGTH} characters`;
  if (/[\x00-\x1f\\]/.test(value)) return 'it contains control characters or a backslash';
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return 'it is absolute';
  if (value === '') return allowRoot ? undefined : 'it names the granted root';
  if (value.split('/').some(part => part === '' || part === '.' || part === '..')) return 'it contains an empty or dot segment';
  return undefined;
}

/**
 * Transfer paths additionally refuse `DEL`, lone surrogates and a drive prefix,
 * exactly as the transfer engine does.
 */
export function transferPathViolation(value: string, allowRoot = true): string | undefined {
  const base = entryPathViolation(value, allowRoot);
  if (base !== undefined) return base;
  if (value.includes('\u007f')) return 'it contains a DEL character';
  if (/[\uD800-\uDFFF]/u.test(value)) return 'it contains an unpaired surrogate';
  return undefined;
}

/**
 * A root-relative path field: shape only. The empty string is the granted root,
 * and every grammar rule (traversal, absolute form, dot segments, length) is
 * judged by the engine so the wire keeps `INVALID_PATH` / 400.
 */
export const EntryPathSchema = z.string();
/** A root-relative path field that the engine must resolve to an entry. */
export const EntryChildPathSchema = z.string();
/** A transfer path field: same shape-only rule as {@link EntryPathSchema}. */
export const TransferPathSchema = z.string();
/** An absolute path field; only `roots.add` accepts one, and the engine validates it. */
export const AbsoluteRootPathSchema = z.string();
/** A single new name; one-segment enforcement belongs to the engine. */
export const LeafNameSchema = z.string();

/** `rootId + relative path`: the only addressing scheme any operation accepts. */
export const RootPathRefSchema = z.object({ rootId: RootIdSchema, path: EntryPathSchema });
export type RootPathRef = z.infer<typeof RootPathRefSchema>;

/** Request-id recorded in the mutation ledger. */
export const RequestIdSchema = z.string().min(8).max(128);

/* ------------------------------------------------------------------ *
 * Status vocabularies
 * ------------------------------------------------------------------ */

export const TASK_STATUSES = ['queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'] as const;
export const TASK_ITEM_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped', 'cancelled'] as const;
export const ENTRY_KINDS = ['file', 'directory', 'symlink', 'other'] as const;
export const REFERENCEABLE_KINDS = ['file', 'directory'] as const;

export const TaskStatusSchema = z.enum(TASK_STATUSES);
export const TaskItemStatusSchema = z.enum(TASK_ITEM_STATUSES);
export const EntryKindSchema = z.enum(ENTRY_KINDS);
export const NewlineStyleSchema = z.enum(['lf', 'crlf', 'cr', 'mixed']);
export const OperationSchema = z.enum(['copy', 'move']);
export const DirectionSchema = z.enum(['upload', 'download']);
export const TaskConflictSchema = z.enum(['skip', 'rename', 'overwrite']);
export const UploadConflictSchema = z.enum(['error', 'skip', 'overwrite']);
export const ActivityKindSchema = z.enum(['task', 'transfer']);

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskItemStatus = z.infer<typeof TaskItemStatusSchema>;
export type EntryKind = z.infer<typeof EntryKindSchema>;
export type NewlineStyle = z.infer<typeof NewlineStyleSchema>;
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

/* ------------------------------------------------------------------ *
 * Error DTO
 * ------------------------------------------------------------------ */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema),
]));

/**
 * Bounded, JSON-only failure details. `stack`, `cause` objects and file
 * descriptors can never be part of a public error.
 */
export const ErrorDetailsSchema = z.record(z.string(), JsonValueSchema).superRefine((details, ctx) => {
  if (Object.keys(details).length > 32) ctx.addIssue({ code: 'custom', message: 'Failure details carry at most 32 keys.' });
});
/** A stable business code: `INVALID_REQUEST`, `VERSION_CONFLICT`, or a raw errno. */
export const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
export const ErrorCodeSchema = z.string().regex(ERROR_CODE_PATTERN);
export const PublicErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1).max(2048),
  details: ErrorDetailsSchema,
}).strict();
export type PublicError = z.infer<typeof PublicErrorSchema>;

/**
 * A failure that was already normalized before it was persisted: the `error`
 * view stored on a task item is a plain `{ code, message, details }` record, not
 * an `Error`. Re-normalizing it would erase its code and report `IO_ERROR`.
 */
function isPublicErrorRecord(value: unknown): value is { code: string; message: string; details?: unknown } {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Error) return false;
  const record = value as { code?: unknown; message?: unknown };
  return typeof record.code === 'string'
    && ERROR_CODE_PATTERN.test(record.code)
    && typeof record.message === 'string'
    && record.message.length > 0;
}

/**
 * Project any failure into the wire error DTO.
 *
 * A thrown value is normalized first, so cancellation, errno and unknown
 * failures keep their distinction. A record that already carries a business code
 * is projected as-is, because the Host normalized it when it wrote it.
 */
export function toPublicError(error: unknown, options: NormalizeOptions = {}): PublicError {
  if (isPublicErrorRecord(error)) {
    // A persisted record may carry a raw errno code (the engine used to store
    // `error.code` verbatim). Normalize it so the wire code set stays closed, while
    // `details.cause` preserves the original errno.
    if (isErrnoCode(error.code)) {
      const normalized = normalizeError(Object.assign(new Error(error.message), { code: error.code }), options);
      return requireParsed(PublicErrorSchema, {
        code: normalized.code,
        message: normalized.message,
        details: { ...publicErrorDetails(error.details), ...normalized.details },
      }, 'failure');
    }
    return requireParsed(PublicErrorSchema, {
      code: error.code,
      message: error.message,
      details: error.details ?? {},
    }, 'failure');
  }
  const normalized = normalizeError(error, options);
  return requireParsed(PublicErrorSchema, {
    code: normalized.code,
    message: normalized.message,
    details: normalized.details,
  }, 'failure');
}

/* ------------------------------------------------------------------ *
 * Root and entry views
 * ------------------------------------------------------------------ */

export const RootDescriptorSchema = z.object({
  id: RootIdSchema,
  provider: z.literal('host-local'),
  path: z.string().min(1),
  label: z.string(),
  /** `dev:ino` of the granted directory, captured when the grant was added. */
  identity: z.string().regex(/^\d+:\d+$/),
  createdAt: IsoTimestampSchema,
}).strict();
export type RootDescriptor = z.infer<typeof RootDescriptorSchema>;

export const WorkspaceCandidateSchema = z.object({
  id: z.string(), path: z.string(), title: z.string(),
}).strict();
export type WorkspaceCandidate = z.infer<typeof WorkspaceCandidateSchema>;

/**
 * A metadata snapshot produced by a directory listing.
 *
 * Only **addressable** entries appear here: the engine keeps a name it cannot
 * express in the path grammar out of this array and reports it through
 * `unaddressable` instead (R18), so a listing entry can never become an
 * executable reference.
 */
export const EntrySnapshotSchema = z.object({
  name: FileNameSchema,
  path: z.string().min(1).superRefine((value, ctx) => {
    const violation = entryPathViolation(value, false);
    if (violation !== undefined) {
      ctx.addIssue({ code: 'custom', message: `A listing entry path must be addressable: ${violation}. Unaddressable names belong in "unaddressable".` });
    }
  }),
  kind: EntryKindSchema,
  size: NonNegativeIntegerSchema,
  modifiedAt: IsoTimestampSchema,
  /** Weak version: valid for selection and rename, never for replacing content. */
  version: MetadataVersionSchema,
  mode: ModeSchema,
}).strict();
export type EntrySnapshot = z.infer<typeof EntrySnapshotSchema>;

/**
 * A name the current path grammar cannot express (R18): control characters,
 * backslashes, a lone surrogate or an over-long relative path.
 *
 * It deliberately carries **no `path` field** — not a raw one, not an escaped
 * one — so a caller cannot turn it into a file operation by accident. `reason`
 * is the operator-facing explanation; `name` is the raw name and is safe once
 * JSON-escaped.
 */
export const UnaddressableEntrySchema = z.object({
  name: FileNameSchema,
  kind: EntryKindSchema,
  reason: z.string().min(1).max(200),
}).strict();
export type UnaddressableEntry = z.infer<typeof UnaddressableEntrySchema>;

/**
 * A metadata snapshot of one addressed entry. For regular files the Host
 * promotes it to a content-bound version and adds `sha256`, because the caller
 * may immediately authorize a write or an overwrite with it.
 */
export const EntryStatSchema = z.object({
  rootId: RootIdSchema,
  path: EntryPathSchema,
  name: EntryNameSchema,
  kind: EntryKindSchema,
  size: NonNegativeIntegerSchema,
  modifiedAt: IsoTimestampSchema,
  version: EntryVersionSchema,
  identity: z.string().regex(/^\d+:\d+$/),
  mode: ModeSchema,
  metadataVersion: MetadataVersionSchema.optional(),
  sha256: Sha256Schema.optional(),
}).strict();
export type EntryStat = z.infer<typeof EntryStatSchema>;

/**
 * The narrow entry summary embedded in committed task results: it identifies the
 * published entry and its version without repeating any recovery proof.
 */
export const PublicEntrySummarySchema = z.object({
  rootId: RootIdSchema,
  path: EntryPathSchema,
  kind: EntryKindSchema,
  size: NonNegativeIntegerSchema,
  modifiedAt: IsoTimestampSchema,
  version: EntryVersionSchema,
  mode: ModeSchema,
}).strict();
export type PublicEntrySummary = z.infer<typeof PublicEntrySummarySchema>;

/* ------------------------------------------------------------------ *
 * Storage degradation (R17)
 * ------------------------------------------------------------------ */

/**
 * The Host could not open or validate the operation journal while the root
 * grants are trustworthy: browsing and text reads still work, everything that
 * writes is refused, and unavailable history must never be presented as empty
 * history. `readOnly` is a literal so an illegal combination cannot be built.
 */
export const DegradedOperationsSchema = z.object({
  scope: z.literal('operations'),
  /** Host business code describing the cause, e.g. `INITIALIZATION_FAILED`. */
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(300),
  readOnly: z.literal(true),
}).strict();

/**
 * The root grants themselves are not trustworthy: file access is refused
 * outright and the bootstrap reports no usable roots.
 */
export const DegradedRootsSchema = z.object({
  scope: z.literal('roots'),
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(300),
  readOnly: z.literal(false),
}).strict();

/**
 * `bootstrap.degraded` is a required, nullable field: `null` means healthy, and
 * an absent field is not a health signal. Every refusal that follows from a
 * degradation answers `FILE_MANAGER_UNAVAILABLE` / 503 with `details.scope`.
 */
export const DegradedViewSchema = z.discriminatedUnion('scope', [DegradedOperationsSchema, DegradedRootsSchema]);
export type DegradedView = z.infer<typeof DegradedViewSchema>;
export type DegradedOperations = z.infer<typeof DegradedOperationsSchema>;
export type DegradedRoots = z.infer<typeof DegradedRootsSchema>;

/* ------------------------------------------------------------------ *
 * Text views
 * ------------------------------------------------------------------ */

export const TextSnapshotSchema = z.object({
  rootId: RootIdSchema,
  path: EntryChildPathSchema,
  text: z.string(),
  bytes: NonNegativeIntegerSchema,
  /** Content-bound version; a save must return exactly this value. */
  version: ContentVersionSchema,
  encoding: z.literal('utf-8'),
  bom: z.boolean(),
  newline: NewlineStyleSchema,
  mode: ModeSchema,
}).strict();
export type TextSnapshot = z.infer<typeof TextSnapshotSchema>;

/** A text receipt: the snapshot without the body, safe to replay for one requestId. */
export const TextReceiptSchema = TextSnapshotSchema.omit({ text: true });
export type TextReceipt = z.infer<typeof TextReceiptSchema>;

/* ------------------------------------------------------------------ *
 * Delete confirmation views
 * ------------------------------------------------------------------ */

export const DeletePlanEntrySchema = z.object({
  rootId: RootIdSchema,
  path: EntryChildPathSchema,
  kind: z.enum(['file', 'directory', 'symlink']),
  size: NonNegativeIntegerSchema,
  version: EntryVersionSchema,
}).strict();

export const DeletePlanSchema = z.object({
  id: z.string().min(1),
  scope: z.literal('selected-trees'),
  targets: z.array(RootPathRefSchema).min(1),
  entryCount: NonNegativeIntegerSchema,
  expiresAt: EpochMillisSchema,
  permanent: z.literal(true),
  entries: z.array(DeletePlanEntrySchema),
}).strict();
export type DeletePlan = z.infer<typeof DeletePlanSchema>;

export const DeleteCommitResultSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['completed', 'partial']),
  results: z.array(z.object({
    rootId: RootIdSchema,
    path: EntryChildPathSchema,
    status: z.enum(['completed', 'failed']),
    removed: z.boolean().optional(),
    /** Descendants may have been removed even if the selected directory remains. */
    contentsChanged: z.boolean().optional(),
    error: z.object({ code: ErrorCodeSchema, message: z.string().min(1) }).strict().optional(),
  }).strict()),
}).strict();
export type DeleteCommitResult = z.infer<typeof DeleteCommitResultSchema>;

/* ------------------------------------------------------------------ *
 * Task and transfer views
 * ------------------------------------------------------------------ */

export const TaskProgressSchema = z.object({
  total: NonNegativeIntegerSchema,
  completed: NonNegativeIntegerSchema,
  failed: NonNegativeIntegerSchema,
  skipped: NonNegativeIntegerSchema,
  cancelled: NonNegativeIntegerSchema,
  bytes: NonNegativeIntegerSchema,
  totalBytes: NonNegativeIntegerSchema,
}).strict();
export type TaskProgress = z.infer<typeof TaskProgressSchema>;

export const PublicTaskItemSchema = z.object({
  id: z.string().min(1),
  source: z.object({ rootId: RootIdSchema, path: EntryChildPathSchema, expectedVersion: EchoedVersionSchema }).strict(),
  conflict: TaskConflictSchema,
  name: LeafNameSchema.optional(),
  /** Echoed by the caller; the engine proves the strong-version rule at execution. */
  expectedTargetVersion: EchoedVersionSchema.optional(),
  destination: RootPathRefSchema,
  status: TaskItemStatusSchema,
  attempts: NonNegativeIntegerSchema,
  bytesTransferred: NonNegativeIntegerSchema,
  /** Committed summary: what was published, not how it can be recovered. */
  result: z.object({
    destination: PublicEntrySummarySchema,
    bytes: NonNegativeIntegerSchema,
    sourceRemoved: z.boolean(),
    method: z.enum(['copy', 'copy-delete', 'rename']),
  }).strict().optional(),
  error: PublicErrorSchema.optional(),
}).strict();
export type PublicTaskItem = z.infer<typeof PublicTaskItemSchema>;

export const PublicTaskViewSchema = z.object({
  id: z.string().min(1),
  operation: OperationSchema,
  status: TaskStatusSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  dismissed: z.boolean(),
  historyRevision: NonNegativeIntegerSchema,
  canDismiss: z.boolean(),
  destination: RootPathRefSchema,
  conflict: TaskConflictSchema,
  progress: TaskProgressSchema,
  items: z.array(PublicTaskItemSchema),
  cancelRequested: z.literal(true).optional(),
  persistenceError: PublicErrorSchema.optional(),
}).strict();
export type PublicTaskView = z.infer<typeof PublicTaskViewSchema>;

export const PublicTransferItemSchema = z.object({
  id: z.string().min(1),
  path: EntryPathSchema,
  archivePath: z.string().min(1).optional(),
  kind: z.enum(['file', 'directory']),
  size: NonNegativeIntegerSchema,
  status: TaskItemStatusSchema,
  bytesTransferred: NonNegativeIntegerSchema,
  /** True when the destination already holds this item's published bytes. */
  committed: z.boolean(),
  conflict: UploadConflictSchema.optional(),
  /** Caller-supplied overwrite version; the transfer engine validates it at use. */
  expectedVersion: EchoedVersionSchema.optional(),
  error: PublicErrorSchema.optional(),
}).strict();
export type PublicTransferItem = z.infer<typeof PublicTransferItemSchema>;

export const PublicTransferViewSchema = z.object({
  id: z.string().min(1),
  type: z.literal('transfer'),
  direction: DirectionSchema,
  rootId: RootIdSchema,
  path: EntryPathSchema,
  status: TaskStatusSchema,
  createdAt: EpochMillisSchema,
  updatedAt: EpochMillisSchema,
  dismissed: z.boolean(),
  historyRevision: NonNegativeIntegerSchema,
  canDismiss: z.boolean(),
  bytesTransferred: NonNegativeIntegerSchema,
  bytesTotal: NonNegativeIntegerSchema,
  itemsTotal: NonNegativeIntegerSchema,
  itemsCompleted: NonNegativeIntegerSchema,
  /** Wire bytes including ZIP headers; payload accounting uses `bytesTransferred`. */
  wireBytesTransferred: NonNegativeIntegerSchema.optional(),
  /** `server-stream-finished` means server EOF, never "the browser saved the file". */
  completion: z.literal('server-stream-finished').optional(),
  downloadKind: z.enum(['zip', 'file']).optional(),
  downloadName: z.string().min(1).optional(),
  cancelRequested: z.literal(true).optional(),
  error: PublicErrorSchema.optional(),
  items: z.array(PublicTransferItemSchema),
}).strict();
export type PublicTransferView = z.infer<typeof PublicTransferViewSchema>;

/* ------------------------------------------------------------------ *
 * Task-history receipts
 * ------------------------------------------------------------------ */

export const ActivityDismissedReceiptSchema = z.object({
  kind: ActivityKindSchema,
  taskId: z.string().min(1),
  outcome: z.literal('dismissed'),
  task: z.object({
    id: z.string().min(1),
    status: TaskStatusSchema,
    dismissed: z.boolean(),
    historyRevision: NonNegativeIntegerSchema,
    canDismiss: z.boolean(),
  }).strict(),
}).strict();

export const ActivityRejectedReceiptSchema = z.object({
  kind: ActivityKindSchema,
  taskId: z.string().min(1),
  outcome: z.literal('rejected'),
  error: PublicErrorSchema,
}).strict();

export const ActivityReceiptSchema = z.discriminatedUnion('outcome', [
  ActivityDismissedReceiptSchema, ActivityRejectedReceiptSchema,
]);
export type ActivityReceipt = z.infer<typeof ActivityReceiptSchema>;
export type ActivityDismissedReceipt = z.infer<typeof ActivityDismissedReceiptSchema>;
export type ActivityRejectedReceipt = z.infer<typeof ActivityRejectedReceiptSchema>;

/* ------------------------------------------------------------------ *
 * Recovery-proof exclusion
 * ------------------------------------------------------------------ */

/**
 * Fields that belong to the private recovery journal. They are persisted with
 * the raw record, re-read on cold start, and must never appear on a public view:
 * a public DTO must not become a forgeable recovery token, and it must not leak
 * the identity chain or digests that authorize deleting a source.
 */
export const RECOVERY_PROOF_FIELDS = [
  'checkpoint',
  'measured',
  'identity',
  'sha256',
  'metadataVersion',
  'destinationIdentity',
  'targetManifest',
  'targetParent',
  'manifest',
  'receipt',
  'removed',
] as const;

/** True when a public view (including its nested items) leaked a recovery field. */
export function leaksRecoveryProof(view: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (value: unknown): string | undefined => {
    if (typeof value !== 'object' || value === null || seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = walk(entry);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if ((RECOVERY_PROOF_FIELDS as readonly string[]).includes(key)) return key;
      const found = walk(record[key]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(view);
}

/* ------------------------------------------------------------------ *
 * Projection helpers
 * ------------------------------------------------------------------ */

function requireParsed<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    fail('INVALID_STATE', `A stored ${what} does not satisfy the public contract.`, 500, {
      issues: result.error.issues.slice(0, 8).map(issue => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return result.data;
}

function objectOf(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('INVALID_STATE', `A stored ${what} is not an object.`, 500);
  }
  return value as Record<string, unknown>;
}

function arrayOf(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) fail('INVALID_STATE', `A stored ${what} is not an array.`, 500);
  return value;
}

function requireField(record: Record<string, unknown>, key: string, what: string): unknown {
  const value = record[key];
  if (value === undefined) fail('INVALID_STATE', `A stored ${what} is missing "${key}".`, 500, { field: key });
  return value;
}

function stringField(record: Record<string, unknown>, key: string, what: string): string {
  const value = requireField(record, key, what);
  if (typeof value !== 'string') fail('INVALID_STATE', `A stored ${what} has a non-string "${key}".`, 500, { field: key });
  return value;
}

function integerField(record: Record<string, unknown>, key: string, what: string): number {
  const value = requireField(record, key, what);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_STATE', `A stored ${what} has an invalid "${key}".`, 500, { field: key });
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function optionalInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Copy optional keys only when present, so `exactOptionalPropertyTypes` holds. */
function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

/* ------------------------------------------------------------------ *
 * Projectors
 * ------------------------------------------------------------------ */

/** Project a stored root grant. */
export function toRootDescriptor(root: unknown): RootDescriptor {
  const record = objectOf(root, 'root grant');
  return requireParsed(RootDescriptorSchema, {
    id: stringField(record, 'id', 'root grant'),
    provider: requireField(record, 'provider', 'root grant'),
    path: stringField(record, 'path', 'root grant'),
    label: stringField(record, 'label', 'root grant'),
    identity: stringField(record, 'identity', 'root grant'),
    createdAt: stringField(record, 'createdAt', 'root grant'),
  }, 'root grant');
}

/** Project a listing entry: metadata snapshot only. */
export function toEntrySnapshot(entry: unknown): EntrySnapshot {
  const record = objectOf(entry, 'listing entry');
  return requireParsed(EntrySnapshotSchema, {
    name: stringField(record, 'name', 'listing entry'),
    path: stringField(record, 'path', 'listing entry'),
    kind: requireField(record, 'kind', 'listing entry'),
    size: integerField(record, 'size', 'listing entry'),
    modifiedAt: stringField(record, 'modifiedAt', 'listing entry'),
    version: stringField(record, 'version', 'listing entry'),
    mode: integerField(record, 'mode', 'listing entry'),
  }, 'listing entry');
}

/** Project an addressed entry stat, keeping the digest only for regular files. */
export function toEntryStat(entry: unknown): EntryStat {
  const record = objectOf(entry, 'entry stat');
  const sha256 = optionalString(record, 'sha256');
  const metadataVersion = optionalString(record, 'metadataVersion');
  return requireParsed(EntryStatSchema, {
    rootId: stringField(record, 'rootId', 'entry stat'),
    path: stringField(record, 'path', 'entry stat'),
    name: stringField(record, 'name', 'entry stat'),
    kind: requireField(record, 'kind', 'entry stat'),
    size: integerField(record, 'size', 'entry stat'),
    modifiedAt: stringField(record, 'modifiedAt', 'entry stat'),
    version: stringField(record, 'version', 'entry stat'),
    identity: stringField(record, 'identity', 'entry stat'),
    mode: integerField(record, 'mode', 'entry stat'),
    ...optional('metadataVersion', metadataVersion),
    ...optional('sha256', sha256),
  }, 'entry stat');
}

/**
 * Project one unaddressable listing entry. The whitelist has exactly three
 * fields: there is no code path that could add a `path`.
 */
export function toUnaddressableEntry(entry: unknown): UnaddressableEntry {
  const record = objectOf(entry, 'unaddressable entry');
  return requireParsed(UnaddressableEntrySchema, {
    name: stringField(record, 'name', 'unaddressable entry'),
    kind: requireField(record, 'kind', 'unaddressable entry'),
    reason: stringField(record, 'reason', 'unaddressable entry'),
  }, 'unaddressable entry');
}

/** Project the narrow summary embedded in a committed task result. */
export function toPublicEntrySummary(entry: unknown): PublicEntrySummary {
  const record = objectOf(entry, 'publication receipt');
  return requireParsed(PublicEntrySummarySchema, {
    rootId: stringField(record, 'rootId', 'publication receipt'),
    path: stringField(record, 'path', 'publication receipt'),
    kind: requireField(record, 'kind', 'publication receipt'),
    size: integerField(record, 'size', 'publication receipt'),
    modifiedAt: stringField(record, 'modifiedAt', 'publication receipt'),
    version: stringField(record, 'version', 'publication receipt'),
    mode: integerField(record, 'mode', 'publication receipt'),
  }, 'publication receipt');
}

/** Project a text snapshot, or its bodyless receipt when `withBody` is false. */
export function toTextSnapshot(snapshot: unknown): TextSnapshot {
  const record = objectOf(snapshot, 'text snapshot');
  return requireParsed(TextSnapshotSchema, {
    rootId: stringField(record, 'rootId', 'text snapshot'),
    path: stringField(record, 'path', 'text snapshot'),
    text: stringField(record, 'text', 'text snapshot'),
    bytes: integerField(record, 'bytes', 'text snapshot'),
    version: stringField(record, 'version', 'text snapshot'),
    encoding: requireField(record, 'encoding', 'text snapshot'),
    bom: record.bom === true,
    newline: requireField(record, 'newline', 'text snapshot'),
    mode: integerField(record, 'mode', 'text snapshot'),
  }, 'text snapshot');
}

export function toTextReceipt(snapshot: unknown): TextReceipt {
  const { text: _text, ...receipt } = toTextSnapshot(snapshot);
  return receipt;
}

/** Project a prepared deletion confirmation. */
export function toDeletePlan(plan: unknown): DeletePlan {
  const record = objectOf(plan, 'delete plan');
  const targets = arrayOf(requireField(record, 'targets', 'delete plan'), 'delete plan targets').map(target => {
    const ref = objectOf(target, 'delete target');
    return { rootId: stringField(ref, 'rootId', 'delete target'), path: stringField(ref, 'path', 'delete target') };
  });
  const entries = arrayOf(requireField(record, 'entries', 'delete plan'), 'delete plan entries').map(entry => {
    const item = objectOf(entry, 'delete plan entry');
    return {
      rootId: stringField(item, 'rootId', 'delete plan entry'),
      path: stringField(item, 'path', 'delete plan entry'),
      kind: requireField(item, 'kind', 'delete plan entry'),
      size: integerField(item, 'size', 'delete plan entry'),
      version: stringField(item, 'version', 'delete plan entry'),
    };
  });
  return requireParsed(DeletePlanSchema, {
    id: stringField(record, 'id', 'delete plan'),
    scope: requireField(record, 'scope', 'delete plan'),
    targets,
    entryCount: integerField(record, 'entryCount', 'delete plan'),
    expiresAt: integerField(record, 'expiresAt', 'delete plan'),
    permanent: requireField(record, 'permanent', 'delete plan'),
    entries,
  }, 'delete plan');
}

/** Project a deletion outcome. */
export function toDeleteCommitResult(result: unknown): DeleteCommitResult {
  const record = objectOf(result, 'delete result');
  const results = arrayOf(requireField(record, 'results', 'delete result'), 'delete results').map(entry => {
    const item = objectOf(entry, 'delete result entry');
    const removed = item.removed;
    const error = item.error === undefined ? undefined : objectOf(item.error, 'delete result error');
    return {
      rootId: stringField(item, 'rootId', 'delete result entry'),
      path: stringField(item, 'path', 'delete result entry'),
      status: requireField(item, 'status', 'delete result entry'),
      ...(typeof removed === 'boolean' ? { removed } : {}),
      ...(typeof item.contentsChanged === 'boolean' ? { contentsChanged: item.contentsChanged } : {}),
      ...(error === undefined ? {} : {
        error: { code: stringField(error, 'code', 'delete result error'), message: stringField(error, 'message', 'delete result error') },
      }),
    };
  });
  return requireParsed(DeleteCommitResultSchema, {
    id: stringField(record, 'id', 'delete result'),
    status: requireField(record, 'status', 'delete result'),
    results,
  }, 'delete result');
}

function toTaskProgress(progress: unknown): TaskProgress {
  const record = objectOf(progress, 'task progress');
  return requireParsed(TaskProgressSchema, {
    total: integerField(record, 'total', 'task progress'),
    completed: integerField(record, 'completed', 'task progress'),
    failed: integerField(record, 'failed', 'task progress'),
    skipped: integerField(record, 'skipped', 'task progress'),
    cancelled: integerField(record, 'cancelled', 'task progress'),
    bytes: integerField(record, 'bytes', 'task progress'),
    totalBytes: integerField(record, 'totalBytes', 'task progress'),
  }, 'task progress');
}

function toTaskItem(item: unknown): PublicTaskItem {
  const record = objectOf(item, 'task item');
  const source = objectOf(requireField(record, 'source', 'task item'), 'task item source');
  const destination = objectOf(requireField(record, 'destination', 'task item'), 'task item destination');
  const result = record.result === undefined ? undefined : objectOf(record.result, 'task item result');
  return requireParsed(PublicTaskItemSchema, {
    id: stringField(record, 'id', 'task item'),
    source: {
      rootId: stringField(source, 'rootId', 'task item source'),
      path: stringField(source, 'path', 'task item source'),
      expectedVersion: stringField(source, 'expectedVersion', 'task item source'),
    },
    conflict: requireField(record, 'conflict', 'task item'),
    ...optional('name', optionalString(record, 'name')),
    ...optional('expectedTargetVersion', optionalString(record, 'expectedTargetVersion')),
    destination: {
      rootId: stringField(destination, 'rootId', 'task item destination'),
      path: stringField(destination, 'path', 'task item destination'),
    },
    status: requireField(record, 'status', 'task item'),
    attempts: integerField(record, 'attempts', 'task item'),
    bytesTransferred: integerField(record, 'bytesTransferred', 'task item'),
    ...(result === undefined ? {} : {
      result: {
        destination: toPublicEntrySummary(requireField(result, 'destination', 'task item result')),
        bytes: integerField(result, 'bytes', 'task item result'),
        sourceRemoved: result.sourceRemoved === true,
        method: requireField(result, 'method', 'task item result'),
      },
    }),
    ...optional('error', record.error === undefined ? undefined : toPublicError(record.error)),
  }, 'task item');
}

/**
 * Project a task record. `checkpoint`, `measured` and every manifest/receipt
 * field stay behind: only progress, the committed summary and the bounded error
 * cross this boundary.
 */
export function toPublicTask(task: unknown): PublicTaskView {
  const record = objectOf(task, 'task record');
  const destination = objectOf(requireField(record, 'destination', 'task record'), 'task destination');
  const items = arrayOf(requireField(record, 'items', 'task record'), 'task items').map(toTaskItem);
  const persistenceError = record.persistenceError === undefined ? undefined : toPublicError(record.persistenceError);
  return requireParsed(PublicTaskViewSchema, {
    id: stringField(record, 'id', 'task record'),
    operation: requireField(record, 'operation', 'task record'),
    status: requireField(record, 'status', 'task record'),
    createdAt: stringField(record, 'createdAt', 'task record'),
    updatedAt: stringField(record, 'updatedAt', 'task record'),
    dismissed: record.dismissed === true,
    historyRevision: optionalInteger(record, 'historyRevision') ?? 0,
    canDismiss: record.canDismiss === true,
    destination: { rootId: stringField(destination, 'rootId', 'task destination'), path: stringField(destination, 'path', 'task destination') },
    conflict: requireField(record, 'conflict', 'task record'),
    progress: toTaskProgress(requireField(record, 'progress', 'task record')),
    items,
    ...(record.cancelRequested === true ? { cancelRequested: true as const } : {}),
    ...optional('persistenceError', persistenceError),
  }, 'task view');
}

function toTransferItem(item: unknown): PublicTransferItem {
  const record = objectOf(item, 'transfer item');
  return requireParsed(PublicTransferItemSchema, {
    id: stringField(record, 'id', 'transfer item'),
    path: stringField(record, 'path', 'transfer item'),
    ...optional('archivePath', optionalString(record, 'archivePath')),
    kind: requireField(record, 'kind', 'transfer item'),
    size: integerField(record, 'size', 'transfer item'),
    status: requireField(record, 'status', 'transfer item'),
    bytesTransferred: integerField(record, 'bytesTransferred', 'transfer item'),
    committed: record.committed === true,
    ...optional('conflict', optionalString(record, 'conflict')),
    ...optional('expectedVersion', optionalString(record, 'expectedVersion')),
    ...optional('error', record.error === undefined ? undefined : toPublicError(record.error)),
  }, 'transfer item');
}

/** Project a transfer record; `destinationIdentity` and item digests stay private. */
export function toPublicTransfer(task: unknown): PublicTransferView {
  const record = objectOf(task, 'transfer record');
  const items = arrayOf(requireField(record, 'items', 'transfer record'), 'transfer items').map(toTransferItem);
  const error = record.error === undefined ? undefined : toPublicError(record.error);
  return requireParsed(PublicTransferViewSchema, {
    id: stringField(record, 'id', 'transfer record'),
    type: requireField(record, 'type', 'transfer record'),
    direction: requireField(record, 'direction', 'transfer record'),
    rootId: stringField(record, 'rootId', 'transfer record'),
    path: stringField(record, 'path', 'transfer record'),
    status: requireField(record, 'status', 'transfer record'),
    createdAt: integerField(record, 'createdAt', 'transfer record'),
    updatedAt: integerField(record, 'updatedAt', 'transfer record'),
    dismissed: record.dismissed === true,
    historyRevision: optionalInteger(record, 'historyRevision') ?? 0,
    canDismiss: record.canDismiss === true,
    bytesTransferred: integerField(record, 'bytesTransferred', 'transfer record'),
    bytesTotal: integerField(record, 'bytesTotal', 'transfer record'),
    itemsTotal: integerField(record, 'itemsTotal', 'transfer record'),
    itemsCompleted: optionalInteger(record, 'itemsCompleted') ?? 0,
    items,
    ...optional('wireBytesTransferred', optionalInteger(record, 'wireBytesTransferred')),
    ...optional('downloadKind', optionalString(record, 'downloadKind')),
    ...optional('downloadName', optionalString(record, 'downloadName')),
    ...(record.completion === 'server-stream-finished' ? { completion: 'server-stream-finished' as const } : {}),
    ...(record.cancelRequested === true ? { cancelRequested: true as const } : {}),
    ...optional('error', error),
  }, 'transfer view');
}

/** Project the small receipt returned for one closed history record. */
export function toActivityDismissedReceipt(kind: ActivityKind, taskId: string, task: unknown): ActivityDismissedReceipt {
  const record = objectOf(task, `${kind} receipt`);
  return requireParsed(ActivityDismissedReceiptSchema, {
    kind, taskId, outcome: 'dismissed',
    task: {
      id: stringField(record, 'id', `${kind} receipt`),
      status: requireField(record, 'status', `${kind} receipt`),
      dismissed: record.dismissed === true,
      historyRevision: optionalInteger(record, 'historyRevision') ?? 0,
      canDismiss: record.canDismiss === true,
    },
  }, `${kind} receipt`);
}

/** Project one rejected entry of a batch close. */
export function toActivityRejectedReceipt(kind: ActivityKind, taskId: string, error: unknown): ActivityRejectedReceipt {
  return requireParsed(ActivityRejectedReceiptSchema, {
    kind, taskId, outcome: 'rejected', error: toPublicError(error),
  }, `${kind} rejection`);
}
