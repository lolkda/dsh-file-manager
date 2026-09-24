# 冻结契约（src/contracts）

> **本文是 0.2.0 代次的冻结契约，保留原始冻结文本。** §9“迁移状态与未决项”记录的是当时的阶段状态，其中若干条已经完成；这些条目的最新事实见文末“§9 更新注记”。当前权威文档顺序仍为：[SPEC.md](../SPEC.md)（R1–R20）→ 本文 → `tests/contracts.test.mjs` → 实现。

状态：**已冻结（0.2.0）**。本文件描述 `src/contracts` 导出的接口与调用约定，是 Host 与 Client 两半必须共同遵守的唯一来源。
任何行为改动必须先修改本文件与 `tests/contracts.test.mjs`，再改实现；不允许在实现里新增未冻结的行为。

权威来源（按优先级）：`SPEC.md` 的 R1–R19（其中 R14–R19 是 0.2.0 TypeScript 重构的增量契约；R20 为 0.2.8 新增的路径栏布局规则，不改动本文件冻结的接口）→ 本文件 → `tests/contracts.test.mjs` → 迁移前实现（根目录 `index.js`、`host/*.js`、`contracts/errors.js`，仅作安全网与对照；这些文件已在 0.2.x 迁移中删除，此处仅作历史指引）。

验证命令：

```bash
./node_modules/.bin/tsc -p tsconfig.host.json      # Host 半（含 contracts）编译
./node_modules/.bin/tsc -p tsconfig.client.json    # Client 半类型检查
node --test tests/contracts.test.mjs tests/package-identity.test.mjs
```

`tests/contracts.test.mjs` 从 `dist/contracts/*.js` 导入，因此运行前必须先产出 `dist/`（`npm run build`，或仅契约层时 `./node_modules/.bin/tsc -p tsconfig.host.json`）。

---

## 1. 四个模块与导出清单

### `src/contracts/errors.ts`

| 导出 | 说明 |
| --- | --- |
| `class FileManagerError extends Error` | 字段 `code: string`、`status: number`、`details: ErrorDetails`，`name === 'FileManagerError'`；构造签名 `(code, message, status = 400, details = {})`。字段可写（既有实现有 `error.details = {...}` 的用法）。 |
| `fail(code, message, status = 400, details = {}): never` | 与迁移前 `contracts/errors.js` 语义完全一致。 |
| `type ErrorDetails = Record<string, unknown>` | 必须是 JSON 可序列化值。 |
| `type ErrorProfile = 'control' \| 'transfer'` | 仅影响两处文案（`EACCES/EPERM` 与兜底），不影响码与状态。 |
| `HOST_ERROR_CODES: readonly string[]` | Host 可铸造的错误码全集（见 §3）。 |
| `isHostErrorCode(code)` / `isCancellationCode(code)` / `isCancellationError(error)` / `isFileManagerError(error)` | 判定工具。 |
| `normalizeError(error, { profile?, signal? }): FileManagerError` | 集中归一化，顺序见 §3.2。 |
| `publicErrorDetails(details)` / `publicDetailKeys()` | errno 型错误只允许 `committed`、`cleanupFailed`、`stagingName` 三个 detail 键上线。 |

本模块不依赖 zod 与 Node 内置模块，Client 侧可直接 import。

### `src/contracts/limits.ts`

限制与预算的**唯一来源**（Host 设置 schema、HTTP 信封、任务/传输引擎、删除计划都从这里取数）：

| 导出 | 值 |
| --- | --- |
| `LIMIT_DEFAULTS.maxTextBytes` | 5 MiB |
| `LIMIT_DEFAULTS.maxFileBytes` | 2 GiB |
| `LIMIT_DEFAULTS.maxTaskBytes` | 10 GiB |
| `LIMIT_DEFAULTS.maxTaskEntries` | 10000 |
| `LIMIT_DEFAULTS.transferConcurrency` | 2（重 IO 同时许可数） |
| `LIMIT_DEFAULTS.pollIntervalMs` | 2000 |
| `LIMIT_DEFAULTS.deletePlanTtlMs` | 300000 |
| `LIMIT_DEFAULTS.maxVerificationBytes` | 10 GiB（**新增**：单次内容核验预算） |
| `LIMIT_BOUNDS` / `resolveLimits(configured?)` / `isValidLimitValue(name, value)` | 边界与校验；越界或非整数 → `INVALID_STATE`/500，**不静默 clamp** |
| `SETTINGS_NAMESPACE` / `STORAGE_NAMESPACE` / `OPERATIONS_STORAGE_NAMESPACE` / `WIRE_STAGE` | `'local-file-manager'` / `'local_file_manager'` / `'local_file_manager_operations'` / `'basic-management'` |
| `HEAVY_IO_QUEUE_LIMIT` | 64（等待 `transferConcurrency` 许可的队列上限，超额 → `TOO_MANY_REQUESTS`/429） |
| `CONTROL_ENVELOPE_BYTES` / `MANIFEST_ENVELOPE_BYTES` | 256 KiB / 16 MiB |
| `MANIFEST_OPS` / `isManifestOp(op)` | `tasks.start`、`tasks.retry`、`transfers.begin` |
| `TEXT_ENVELOPE_MULTIPLIER` / `TEXT_ENVELOPE_OVERHEAD_BYTES` / `textEnvelopeBytes(max)` | 6 / 65536 / `max * 6 + 65536` |
| `REQUEST_ID_MIN_LENGTH` / `REQUEST_ID_MAX_LENGTH` / `REQUEST_LEDGER_CAPACITY` / `REQUEST_LEDGER_TTL_MS` | 8 / 128 / 256 / 600000 |
| `DIRECTORY_PAGE_DEFAULT` / `DIRECTORY_PAGE_MAX` / `RELATIVE_PATH_MAX_LENGTH` | 200 / 500 / 4096 |
| `DELETE_PLAN_MAX_SELECTIONS` / `DELETE_PLAN_MAX_ENTRIES` / `DELETE_PLAN_MAX_PENDING` | 10000 / 10000 / 64 |
| `ACTIVITY_DISMISS_MAX_ITEMS` | 256 |
| `WATCH_MAX_TARGETS` / `WATCH_MAX_RECORDS` / `EVENT_HEARTBEAT_MS` / `EVENT_MAX_QUEUED` | 128 / 512 / 15000 / 128 |
| `SMALL_BODY_ADMISSION` / `LARGE_BODY_ADMISSION` | 8 / 2 |
| `TASK_CONFLICT_POLICIES` / `UPLOAD_CONFLICT_POLICIES` | `skip\|rename\|overwrite` / `error\|skip\|overwrite` |

### `src/contracts/views.ts`

版本令牌、wire 基础类型、公开 DTO schema 与**白名单投影函数**（见 §4、§5）。`UnaddressableEntrySchema` + `toUnaddressableEntry` 承载 R18 的不可寻址条目。

### `src/contracts/protocol.ts`

每个 op 的请求/结果 zod 判别联合、信封、解析入口、HTTP 路由表、SSE 帧（见 §2、§6、§7）。

`protocol.ts` 还**只以类型形式**再导出 `views.ts` 的公开 DTO 类型（`PublicTaskView`、`EntrySnapshot`、`PublicError` 等）与 `limits.ts` 的冲突策略类型，便于消费者从单一模块取类型；schema 值仍只在 `views.ts`，Client 用 `import type` 时 zod 不会进入浏览器产物。

调用约定（重要）：

- **Client 必须用 `import type`** 引用 `protocol.ts` / `views.ts` 的类型，使 zod 不进入浏览器产物；`limits.ts` 与 `errors.ts` 可运行时 import（无 zod）。
- **Host 用 `parseControlRequest` / `parseTextRequest` / `parseEventRequest`** 做入口准入，再执行自己的领域校验；`CONTROL_RESULTS` 表用于结果类型。
- 投影只允许通过 `views.ts` 的 `toXxx()` 函数产出公开视图；不要手写对象字面量（会绕过白名单与 `INVALID_STATE` 自检）。

---

## 2. op 列表

`CONTROL_OPS`（24 个，`/v2/control` 与 `/v2/manifest` 路由共用同一分派）：

```
bootstrap
roots.list | roots.add | roots.remove
entries.list | entries.stat | entries.reference
text.read
entries.create-file | entries.create-directory | entries.rename
delete.prepare | delete.commit
activities.dismiss
tasks.start | tasks.list | tasks.get | tasks.cancel | tasks.retry
transfers.begin | transfers.list | transfers.get | transfers.cancel | transfers.retry
```

`TEXT_OPS`：`save`（仅 `/v2/text`）。

**变更类 op（`MUTATION_OPS`，13 个，必须带 `requestId`）**：

```
roots.add | roots.remove
entries.create-file | entries.create-directory | entries.rename
delete.commit | activities.dismiss
tasks.start | tasks.cancel | tasks.retry
transfers.begin | transfers.cancel | transfers.retry
```

其余 11 个为只读 op：允许携带 `requestId`（Client 统一携带），但不受 ledger 约束。

`requestId` 规则：长度 8–128；同一 `requestId` 在同一窗口（TTL 600 s、容量 256）内必须指纹一致，否则 `REQUEST_ID_REUSED`/409；指纹一致的重复请求返回首次结果，不重复执行。缺失 → `INVALID_REQUEST`/400。

**服务级但非 wire 的 op**：`transfers.dismiss` 只存在于传输服务内部（`createTransferService().control`），迁移前 `index.js` 也不分派它。历史关闭统一走 `activities.dismiss`（批量、逐项结果）。不要把它加进 wire 契约。

**结果表**：`CONTROL_RESULTS` 为 `Record<ControlOp, z.ZodType>`，`ControlResult<'entries.list'>` 等类型由 `z.infer` 派生，Client 的 `api()` 直接用它，不要手写第二份 DTO。

---

## 3. 错误码

### 3.1 分类

| 分类 | 码 | 典型 HTTP |
| --- | --- | --- |
| 准入/参数 | `INVALID_REQUEST`、`INVALID_PATH`、`INVALID_MANIFEST`、`INVALID_TEXT`、`INVALID_CURSOR`、`INVALID_STATE`、`TOO_LARGE`、`TOO_MANY_REQUESTS`、`REQUEST_ID_REUSED`、`UNREPRESENTABLE_REFERENCE`（语义同时覆盖「引用语法不可表示」与「路径文法不可表示」两种场景，R18） | 400 / 409 / 413 / 429 |
| 授权与根身份 | `ROOT_NOT_FOUND`、`ROOT_UNAVAILABLE`、`ROOT_CHANGED`、`ROOT_OPERATION_NOT_ALLOWED`、`PATH_CHANGED`、`PERMISSION_DENIED`、`UNSUPPORTED_PLATFORM` | 403 / 404 / 409 / 422 |
| 版本与并发 | `VERSION_REQUIRED`、`STRONG_VERSION_REQUIRED`、`VERSION_CONFLICT`、`DIRECTORY_CHANGED`、`SAME_ENTRY`、`SELF_DESCENDANT`、`ALREADY_EXISTS`、`DIRECTORY_CONFLICT`、`PLAN_EXPIRED`、`PLAN_NOT_FOUND`、`CONFIRMATION_REQUIRED`、`CHECKSUM_MISMATCH`、`RECOVERY_REQUIRED`、`ATOMIC_RENAME_UNCERTAIN`、`UNSUPPORTED_ATOMIC_RENAME` | 409 / 422 / 501 |
| 条目类型与编码 | `UNSUPPORTED_ENTRY`、`UNSUPPORTED_ENCODING`、`NOT_DIRECTORY`、`NOT_FOUND`、`LINE_ENDING_MAPPING_LIMIT`、`INCOMPLETE_DOWNLOAD`、`SIZE_MISMATCH` | 404 / 422 / 409 |
| 任务与历史 | `TASK_NOT_FOUND`、`TASK_BUSY`、`TASK_CHANGED`、`ITEM_NOT_FOUND`、`ITEM_NOT_READY`、`NO_FAILED_ITEMS`、`HISTORY_REVISION_EXHAUSTED` | 404 / 409 |
| 取消 | `CANCELLED` | 499 |
| 资源与可用性 | `NO_SPACE`、`IO_ERROR`、`CLEANUP_FAILED`、`SOURCE_DELETE_FAILED`、`PERSISTENCE_FAILED`、`TASK_PERSISTENCE_FAILED`、`INTERRUPTED`、`SERVICE_STOPPED`、`FEATURE_UNAVAILABLE`、`FILE_MANAGER_UNAVAILABLE`（R17 降级拒绝，`details.scope` = `operations` 或 `roots`）、`INITIALIZATION_FAILED` | 500 / 503 / 507 |

`RESOURCE_CLOSED` 表示内部租约已释放（409）。完整清单以 `HOST_ERROR_CODES` 为准，测试会阻止它收缩。

Client 本地码（不进入 wire DTO，由 Client i18n 维护）：`TRANSPORT`、`DOCUMENT_NOT_FOUND`、`DOCUMENT_CONFLICT`、`INVALID_SNAPSHOT`、`INVALID_DELETE_PLAN`、`INVALID_HISTORY_RESULT`、`EVENT_STREAM_INVALID`、`REFERENCE_TARGET_UNAVAILABLE`、`REFERENCE_BUSY`、`REFERENCE_MISMATCH`、`UPLOAD_SOURCE_LOST`。

### 3.2 归一化顺序（`normalizeError`）

1. 已是 `FileManagerError`（含跨模块副本，按 `name`+`code`+`status` 判定）→ 原样返回，**主动取消不得退化**；
2. 取消特征：`name === 'AbortError'` 或 `code === 'ABORT_ERR'` → `CANCELLED`/499；
3. errno 表（control 面）：`ENOENT→NOT_FOUND/404`、`EACCES|EPERM→PERMISSION_DENIED/403`、`ENOTDIR→NOT_DIRECTORY/422`、`ELOOP→UNSUPPORTED_ENTRY/422`、`EEXIST→ALREADY_EXISTS/409`、`ENOSPC→NO_SPACE/507`、`ABORT_ERR→CANCELLED/499`；transfer 面另含 `EDQUOT→NO_SPACE/507`，且 `EACCES/EPERM` 与兜底文案不同；
4. 未分类错误但 `signal.aborted` → `CANCELLED`/499；
5. 兜底 → `IO_ERROR`/500。

errno 型错误的 `details` 只保留 `committed` / `cleanupFailed` / `stagingName`；path、syscall、fd 永不上线。

### 3.3 公开错误 DTO

```ts
{ code: string, message: string, details: Record<string, JsonValue> }   // details 必填，最多 32 键
```

- 不含 `stack`、`status`（HTTP 状态码已表达）、`cause` 对象。
- **wire 错误码集合是封闭的**，且**两条路径都必须归一**（只改一处会让历史记录重新开出开放码集）：
  1. **运行时归一**（`normalizeError`，Host 抛出/构造错误时）：未映射的系统 errno 一律归一为 `IO_ERROR`/500，原始 errno 放在 `details.cause`（字符串）；已映射的 errno 走各自稳定码（`ENOENT→NOT_FOUND`、`ENOSPC→NO_SPACE`…）且**不**加 `cause`。
  2. **投影期归一**（`toPublicError`，公开视图/回执投影时）：**持久化记录里遗留的裸 errno 码**（引擎早期版本把 `error.code` 原样存下）同样按上述规则归一——`ENOSPC → NO_SPACE`、`EIO`/`EXDEV` → `IO_ERROR` + `details.cause`。因此历史日志不会在 wire 上重新变成开放集合。
  两条路径共用同一张 errno 表与同一套判定（`isErrnoCode` / `isUnmappedErrno(code, profile)`），`HOST_ERROR_CODES` 的封闭集合语义不变，也不为 errno 新增码。已映射的 errno 走各自稳定码（`ENOENT→NOT_FOUND`、`ENOSPC→NO_SPACE`、`EDQUOT→NO_SPACE`(transfer) …）且不额外加 `cause`。持久化记录里遗留的裸 errno 码（例如引擎早期把 `error.code` 原样存下）在**投影时**同样归一，`details.cause` 保留原值——客户端因此只需处理封闭码集，`error.<CODE>` 文案不会退化成通用兜底。
- `views.toPublicError(value)` 同时接受**抛出的异常**与**已持久化的错误记录**（`{code,message,details}` 普通对象，例如任务项的 `error`）：后者按原样投影，否则会丢失业务码并退化成 `IO_ERROR`。
- `details` 必须是 JSON 值；投影时校验，违反即 `INVALID_STATE`/500（属内部缺陷，不允许把不可序列化对象发到线上）。

---

## 4. 版本令牌：快照 / 强版本 / 恢复证明

三类概念严格分离：

| 概念 | 形态 | 产生方式 | 能做什么 | 不能做什么 |
| --- | --- | --- | --- | --- |
| 元数据快照 `MetadataVersion` | `dev:ino:size:mtimeNs:ctimeNs`（`^\d+:\d+:\d+:\d+:\d+$`） | 目录列举 / `lstat`，廉价 | 选择、浏览、引用、重命名比对、删除清单比对 | 授权覆盖写入；不启动全文哈希 |
| 内容强版本 `ContentVersion` | `元数据版本:sha256`（`^...:[0-9a-f]{64}$`） | 有界、可取消的实际字节读取 | 保存文本、覆盖目标、内容搬运/核验 | —— |
| 恢复证明（私有） | `checkpoint`、`manifest`、`targetManifest`、`targetParent`、`receipt`、`identity`、`sha256`、`measured`、`destinationIdentity` | 任务/传输引擎在发布前后写入原始记录 | 冷启动恢复、删源前重证 | **永不进入公开视图** |

类型层与运行时层**双重执行**：

- 类型层：`ContentVersion` 与 `MetadataVersion` 是不同 brand，`ContentVersion` 不能由 `string` 或弱版本填充；`requireContentVersion` 的返回类型就是 `ContentVersion`。
- 运行时层：`requireContentVersion(value)` 对弱版本、空值、格式错误一律 `STRONG_VERSION_REQUIRED`/409；`requireEntryVersion(value)` 缺失即 `VERSION_REQUIRED`/409。
- Host 在真正替换内容前（覆盖、删源、发布后核验）必须再取一次强版本并比对；**任何"弱版本当作强版本"的路径都视为契约违规**。
- 目录/符号链接的版本是弱版本（`stamp`），目录一致性靠成员清单比对，不用哈希。

强版本要求出现在：`text save` 的 `expectedVersion`、`entries.rename` 的 `expectedVersion`、覆盖类 `expectedTargetVersion`、`io.openRead/removeEntry` 的内部证明、`maxVerificationBytes` 计费的核验操作。

`maxVerificationBytes`（默认 10 GiB/操作）：按一次操作清单内**文件字节总量**计费；超限拒绝（`TOO_LARGE`/413），**不得降级或跳过校验**。纯核验失败不改动任何文件；发布之后失败必须准确报告 `details.committed === true`。

---

## 5. 公开视图字段白名单

投影函数（`views.ts`）逐个字段取值并做 schema 自检；缺字段 → `INVALID_STATE`/500（**不静默丢弃**），多字段 → 不会出现（白名单，不是黑名单）。`leaksRecoveryProof(view)` 用于测试断言。

- `toRootDescriptor` → `{ id, provider:'host-local', path, label, identity, createdAt }`
- `toEntrySnapshot`（列举项）→ `{ name, path, kind, size, modifiedAt, version(弱), mode }`；**只允许可寻址条目**，`path` 必须满足 §6.1 的路径文法（否则 schema 直接拒绝，属实现缺陷）
- `toUnaddressableEntry`（R18 不可寻址项）→ `{ name, kind, reason }`，**结构上没有任何 `path` 字段**（不是原始 path、也不是百分号编码后的 path），因此不可能被前端当作可执行引用；`reason` 是面向操作者的原因说明（1–200 字符）
- `toEntryStat`（`entries.stat`/新建目录/重命名结果）→ 上述 + `{ rootId, identity }`；文件额外含 `metadataVersion`、`sha256`、`version(强)`
- `toTextSnapshot` → `{ rootId, path, text, bytes, version(强), encoding:'utf-8', bom, newline, mode }`
- `toTextReceipt` = `toTextSnapshot` 去掉 `text`（可安全重放同一 requestId）
- `toDeletePlan` → `{ id, targets[{rootId,path}], entryCount, expiresAt, permanent:true, entries[{rootId,path,kind,size,version}] }`（`identity`、`children` 不外泄）
- `toDeleteCommitResult` → `{ id, status, results[{rootId,path,status,removed?,error?{code,message}}] }`
- `toPublicTask`（任务视图）
  - 保留：`id, operation, status, createdAt, updatedAt, dismissed, historyRevision, canDismiss, destination, conflict, progress{total,completed,failed,skipped,cancelled,bytes,totalBytes}, items[], cancelRequested?, persistenceError?`
  - 每项保留：`id, source{rootId,path,expectedVersion}, conflict, name?, expectedTargetVersion?, destination, status, attempts, bytesTransferred, result?{destination(摘要),bytes,sourceRemoved,method}, error?`
  - `result.destination` 是 `PublicEntrySummary`（`rootId,path,kind,size,modifiedAt,version,mode`），不含 `identity`/`sha256`
  - **移除**：`checkpoint`、`measured`、`identity`、`sha256`、`metadataVersion`、`targetManifest`、`targetParent`、`manifest`、`receipt`、`removed`
- `toPublicTransfer`（传输视图）
  - 保留：`id, type:'transfer', direction, rootId, path, status, createdAt(ms), updatedAt(ms), dismissed, historyRevision, canDismiss, bytesTransferred, bytesTotal, itemsTotal, itemsCompleted, wireBytesTransferred?, completion?, downloadKind?, downloadName?, cancelRequested?, error?, items[]`
  - 每项保留：`id, path, archivePath?, kind, size, status, bytesTransferred, committed, conflict?, expectedVersion?, error?`
  - **移除**：`destinationIdentity`、`identity`、`sha256`、`version`、`mode`、`modifiedAt`
- `toActivityDismissedReceipt` → `{ kind, taskId, outcome:'dismissed', task{id,status,dismissed,historyRevision,canDismiss} }`（**恰好 5 个键**）
- `toActivityRejectedReceipt` → `{ kind, taskId, outcome:'rejected', error }`
- `toPublicError` → 见 §3.3

### R17 存储降级（`BootstrapView.degraded`）

```ts
degraded: DegradedView | null     // 必填可空字段：null = 健康
type DegradedView =
  | { scope: 'operations'; code: string(1..64); message: string(1..300); readOnly: true }
  | { scope: 'roots';      code: string(1..64); message: string(1..300); readOnly: false }
```

- **必填**：`degraded` 缺失不是健康信号，只有 `null` 才是健康。
- 用判别联合而不是布尔标志：非法组合（`scope:'operations'` + `readOnly:false`、`scope:'roots'` + `readOnly:true`、未知 `scope`）在 schema 层就被拒绝。
- `scope:'operations'`（根授权可信、操作记录不可用）：`bootstrap` 仍返回**有效根列表**，浏览与 `text.read` 可用；写入、`roots.add/remove`、任务执行、历史写入一律以 **`FILE_MANAGER_UNAVAILABLE`/503** 拒绝并在 `details` 带 `scope:'operations'`；`capabilities.write/tasks/transfers/taskHistory` 为 `false`；**历史不可用不得被呈现为空历史**（`tasks.list` 不得返回 `[]`）。
- `scope:'roots'`（根授权不可信）：`bootstrap` 返回**空根列表** + 该降级；所有文件操作以 `FILE_MANAGER_UNAVAILABLE`/503 拒绝，`details.scope = 'roots'`。
- 复用既有 `FILE_MANAGER_UNAVAILABLE` 码，不新增错误码；降级是**只读**的：任何损坏或未知状态都必须保留原始记录，不得自动重置、丢弃或改写（R17）。

`entries.list` 结果（`EntriesListResultSchema`）的 R18 语义：

- `entries`：**仅可寻址条目**，分页与排序断言不变；
- `unaddressable`：**当前页**内不可寻址的子项（按底层 readdir 自然顺序落位），字段固定为 `{ name, kind, reason }`，**无 `path`**；不新增目录级计数字段；
- `total`：整个目录中**可寻址**条目数量（正常目录下等于全部子项）；
- `nextCursor`：语义不变，仍在**完整 readdir 顺序（含不可寻址项）**上推进，因此游标稳定性与 `DIRECTORY_CHANGED` 判定不受影响；一页可寻址条目数可能少于 `limit`，这是允许的；
- 枚举必须**逐项隔离**：单个不可寻址名称只让该项进入 `unaddressable`，不得使 `entries.list` 或整个目录枚举失败；
- 目录复制、打包或删除遇到不可寻址条目时，该项明确失败并使用既有 `UNREPRESENTABLE_REFERENCE`/422（不新增错误码），其余项遵守 R8 部分成功语义；
- 本版不为这些名称新增重命名、删除或引用能力；前端必须渲染 `name` 与 `reason`，且不得为它们伪造 path、不得提供进入/选中/引用/复制/移动/删除入口。

### 版本字段的严格程度取决于「谁铸造」（判据）

> 版本字段的严格程度取决于**谁铸造**它：Host 铸造的令牌必须匹配令牌文法（强/弱版本可区分）；调用方回显的字段只要求非空字符串，其权威校验发生在执行期。任何"调用方回显"字段都不得用令牌 schema 约束，否则一条历史记录即可让整份历史不可读。

- **Host 铸造**（用 `EntryVersionSchema` / `ContentVersionSchema` / `MetadataVersionSchema`）：目录列举的 `version`、`entries.stat` / `text.read` 的 `version`、发布回执 `result.destination.version`、删除清单 `entries[].version`。这些值由 Host 自己产生，必须能区分强弱版本。
- **调用方回显**（用 `EchoedVersionSchema = z.string().min(1)`）：`tasks.start` 每项的 `expectedVersion` / `expectedTargetVersion`、`tasks.retry` 的补丁字段、上传清单的 `expectedVersion`、下载的 `expectedVersion`、`entries.rename` 与文本保存的 `expectedVersion`，以及公开视图里 `items[].source.expectedVersion`、`items[].expectedTargetVersion`、传输项 `expectedVersion`。引擎只要求"非空字符串"（`versionOf`），真正的判定在执行期：缺失 → `VERSION_REQUIRED`/409，覆盖时非强令牌 → `STRONG_VERSION_REQUIRED`/409，与当前版本不符 → `VERSION_CONFLICT`/409。
- 空串与缺失仍被拒（`min(1)` 是真实边界）；非字符串仍被拒（字段类型由契约负责）。

**"整体 500"的边界（已裁定）**：引擎在打开存储时已经校验记录（`refOf` / `versionOf` / `attempts` / 清单越界等），因此**凡是引擎接受的记录都必须可投影**。若某条记录仍无法投影，说明实现有 bug，此时**保持响亮失败（`INVALID_STATE`/500）是正确的**——静默丢弃历史会违反 R13/R17。契约**不**引入"逐条跳过坏记录"的容错投影，也不得为了健壮性把投影改成跳过。

约定：`canDismiss` 由服务派生、**不持久化**；原始记录（持久化日志）始终保存完整恢复证明，公开 DTO **不得回写**日志。`completion === 'server-stream-finished'` 只表示服务端流结束，不代表浏览器已落盘。

---

## 6. HTTP 路由与准入

| 路由 | 方法 | 请求体模式 | 操作 | 信封上限 | 并发准入 |
| --- | --- | --- | --- | --- | --- |
| `/api/file-manager/v2/control` | POST | streaming | 除 manifest 类以外的全部 control op | 256 KiB | 8 |
| `/api/file-manager/v2/manifest` | POST | streaming | 仅 `tasks.start`、`tasks.retry`、`transfers.begin` | 16 MiB | 2 |
| `/api/file-manager/v2/text` | POST | streaming | 仅 `op: 'save'` | `maxTextBytes * 6 + 64 KiB` | 8 |
| `/api/file-manager/v2/upload` | POST | streaming | `?taskId=&itemId=` 原始字节；目录项空体 | 由 `maxFileBytes`/`maxTaskBytes` 约束 | 2 |
| `/api/file-manager/v2/download` | GET | buffered | `?taskId=` 原始文件或流式 ZIP | —— | 2 |
| `/api/file-manager/v2/events` | POST | streaming | SSE，`{ targets: [{rootId,path}] }`（≤128） | 256 KiB | 8 |

准入规则：

- 非 JSON `content-type` → `INVALID_REQUEST`/415；方法不符 → 405；体缺失 → 400；超信封 → `TOO_LARGE`/413（**先拒绝并释放请求体**）。
- 并发超额 → 立即 `TOO_MANY_REQUESTS`/429，不排队、不缓冲整个请求体。
- 下载必须保持 `GET` + 流式响应；**响应文件不得被整体缓存**（`requestBody: 'buffered'` 只作用于请求体）。
- 鉴权与跨站校验沿用 Connection 既有能力：已认证且无 Origin 的原生 GET 返回正确字节；未认证或跨站仍被拒绝。**不得为绕过 GET 构造问题而放宽权限或取消资源限制。**
- 旧路由（`/api/file-manager/{control,text,upload,download,events}`，见 `LEGACY_ROUTES`）必须返回明确的升级错误（`INVALID_REQUEST`/404 或等价），不得静默继续服务。
- 存储初始化失败 → `FILE_MANAGER_UNAVAILABLE`/503，只使文件管理器不可用，不阻断 Host。

响应信封：

```ts
{ ok: true, value } | { ok: false, error: { code, message, details }, value? }   // 传输类失败可同时带任务视图
```

响应头固定：`content-type: application/json; charset=utf-8`、`cache-control: no-store`、`x-content-type-options: nosniff`；SSE 额外 `no-transform`、`x-accel-buffering: no`。

### 6.1 契约拒绝 vs Host 拒绝（重要）

契约 schema 负责：op 身份、信封字段、`requestId` 格式、**字段类型**、id 形态、以及**请求级上限**（`entries.list` 分页 1–500、`delete.prepare` ≤10000、`events.targets` ≤128）。

契约**故意不**负责、由 Host 引擎保留既有业务码的语义判断：

- **路径文法**（父目录穿越、绝对路径、空段与点段、反斜杠、长度）——由 `host/manager.ts` 的 `partsOf` 与 `host/transfers.ts` 的 `relativePath` 负责，wire 码保持 `INVALID_PATH`/400 与 `INVALID_MANIFEST`/422。`views.ts` 的 `entryPathViolation` / `transferPathViolation` 是该文法的**书面形式与测试对照**，生产代码不用它们做校验，因此只有引擎一个执行点，也保住了 Client 的 `error.INVALID_PATH` 文案；
- 版本令牌缺失（`VERSION_REQUIRED`/409）、强版本缺失（`STRONG_VERSION_REQUIRED`/409）；
- 空上传清单、重复路径、文件作为祖先、目录 + overwrite（`INVALID_MANIFEST`/422）；
- 覆盖目标版本不符（`VERSION_CONFLICT`/409）；
- `delete.commit` 未确认（`CONFIRMATION_REQUIRED`/400）；
- `activities.dismiss` 超过 256 条（`TOO_LARGE`/413）与逐项校验（`INVALID_REQUEST`/400）；
- 路径不存在、无权限、符号链接绕行、不可寻址名称等文件系统判定（后者为 `UNREPRESENTABLE_REFERENCE`/422）。

被契约直接拒绝的请求统一是 `INVALID_REQUEST`/400（含 `issues` 详情），Host 不会再看到它。契约在**结果侧**保留更强的不变量：`entries[].path` 必须是可寻址路径（不可寻址名称只能出现在 `unaddressable` 里），公开任务/传输视图不得含恢复证明字段。

---

## 7. 事件流（SSE）帧

`EventFrameSchema`（每帧带递增 `seq`）：

```ts
{ kind:'ready', reason:'connected'|'overflow' }
{ kind:'heartbeat' }
{ kind:'invalidate', reason:'watch'|'reconcile'|'recovered', rootId, path }
{ kind:'watch-status', status:'watching'|'polling'|'unavailable', code?, rootId, path }
{ kind:'task', taskId, summary:{ status, progress, updatedAt } }
{ kind:'transfer', taskId, summary:{ status, bytesTransferred, bytesTotal, itemsCompleted, itemsTotal } }
{ kind:'error', code }
{ kind:'closed' }
```

Client 约定：`ready` 触发一次重同步；溢出时服务端清队列并只发 `ready(reason:'overflow')`；解码必须 flush 尾部字节；断线重连按退避并重新同步；取消不得显示为普通 IO 故障。

---

## 8. 持久化命名（冻结，与包名解耦）

| 用途 | 命名 |
| --- | --- |
| Loader 配置 entry id（kebab-case；不再调用 Settings.register） | `local-file-manager` |
| 根授权存储单元（snake_case） | `local_file_manager` |
| 操作日志存储单元 | `local_file_manager_operations` |
| bundle 单元 id | `local-file-manager` |
| bootstrap `stage` | `basic-management` |
| bootstrap `version` | 必须等于已安装包的 `package.json` 版本 |

限制字段沿用既有 7 项并包含 `maxVerificationBytes`，由插件导出的 `Config` schema 校验 entry 的 `config:`；省略字段恢复默认值，完整配置覆盖时需保留所有希望继续生效的自定义字段。`transferConcurrency` 表示重 IO 同时许可数（复制/移动/上传/下载/全文核验共用一个调度器）。普通启动期限制不属于 volatile 表单字段；旧 `local-file-manager` Settings 段若存在，应在升级前显式迁移，不能忽略导入拒绝。

---

## 9. 迁移状态与未决项

- `dist/` 为生成物；测试统一从 `dist/` 导入实现。`npm run build` 需要 `src/index.ts` 与 `src/client/index.tsx` 同时存在（task-4 / task-5 负责），在它们落地前契约层可用 `./node_modules/.bin/tsc -p tsconfig.host.json` 单独产出 `dist/contracts/`。
- 根目录 legacy JS（`index.js`、`client.js`、`host/*.js`、`contracts/errors.js`）在本阶段保留为参考实现与安全网；契约测试在它们存在时用作对照 oracle，被 Lead 清理后自动退化为对冻结字面量的断言（不会静默跳过）。
- R17 降级形状已按 Lead 裁定冻结为 `BootstrapView.degraded: DegradedView | null`（见 §5）：host-core 在 task-4 的 `bootstrap` 与拒绝路径中实现，client-ui 按 `degraded` 渲染原因，不得把不可用历史显示为空。
- R18 结果侧不变量（`entries[].path` 必须可寻址，含相对路径总长 > 4096）已获批准：引擎遇到违反文法的子项必须**分类进 `unaddressable`**；schema 抛 `INVALID_STATE`/500 是"实现漏了分类"的哨兵，不是生产路径。
- `tests/bootstrap.test.mjs` 仍断言 `exports['.'] === './index.js'` 且 `version === '0.1.4'`：随包切换到 `dist/` 与 0.2.0 后这两条需由 task-4 更新（不在 task-1 写入范围）。
- 尚未验证：`dist/client.js` 的模块 id（待 task-5 产出客户端产物后由 `tests/package-identity.test.mjs` 强断言）；真实 2 GiB / 10000 条目压力测试；真实页面验收。

## 9.1 §9 更新注记（0.2.8 发布前）

以下为 §9 原始条目的**当前事实**，原文保留不改：

- `src/index.ts`、`src/client/index.tsx` 均已落地，`dist/` 由 `npm run build`（`tsc` + esbuild）产出；契约测试从 `dist/contracts/*.js` 导入。
- 根目录 legacy JS（`index.js`、`client.js`、`host/*.js`、`contracts/errors.js`）已在 0.2.x 迁移中删除，§9 第 2 条的“本阶段保留”不再成立；`tests/contracts.test.mjs` 按原设计退化为对冻结字面量的断言。
- §9 最后两条“待 task-4 / task-5”已完成：`tests/bootstrap.test.mjs` 现断言 `exports['.'] === './dist/index.js'`、`exports['./client'] === './dist/client.js'`；`dist/client.js` 的模块 id 由 `tests/package-identity.test.mjs` 与 `.github/workflows/ci.yml` 强断言等于包名。
- 仍未验证：真实 2 GiB / 10,000 条目压力测试；R20 的三档宽度与键盘操作页面验收；0.2.8 的版本验证与公开发布。
