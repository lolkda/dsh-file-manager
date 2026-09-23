# task-6 独立验证计划（可执行清单）

> **历史文档：task-6 的计划文本与执行中状态快照。** task-6 已完成，**最终结果以 [docs/VERIFICATION-REPORT.md](VERIFICATION-REPORT.md) 为准**；本文保留当时的计划、红灯与自我修正记录，用于追溯判定过程，不代表当前状态：
> - 文中的“未 claim / 进行中 / 待 task-4、task-5 接通”是**计划定稿时**的状态，实现相关用例随后已接通并执行；
> - F-4“红灯保持”已修复并复验（见 VERIFICATION-REPORT.md §1.1 与 §3.4）；
> - 文中出现的 `/app/project/...` 绝对路径与 `docs/verification/**/*.log` 引用都是**本机路径与本地再生成的证据文件**：日志可用 `tests/verify-*.test.mjs` 重新生成，绝对路径在其他 checkout 上按仓库相对路径理解；
> - 行为基线请以 [SPEC.md](../SPEC.md)（R1–R20）为准，契约以 [docs/CONTRACT.md](CONTRACT.md) 为准。

状态（历史）：**计划已定稿，用例骨架已就位，实现相关用例待 task-4 / task-5 产物落地后接通并执行。**
负责人：contracts-verification。契约基线：`docs/CONTRACT.md`（0.2.0 已冻结）。行为基线：`SPEC.md` 的 R1–R13（V1）与 R14–R19（0.2.0 增量）。

本计划的目标不是"再跑一遍队友的测试"，而是**用独立观测点复现结论**：每条都必须给出可判定的观测手段，不能出现"测试通过但没证明任何事"。

## 执行状态（历史：计划定稿时的真实运行结果；最终状态见 VERIFICATION-REPORT.md）

| 文件 | 状态 | 覆盖 |
| --- | --- | --- |
| `tests/verify-metadata-boundary.test.mjs` | **14/14 通过** | A1–A4、B1–B6 + 3 条测量自测 |
| `tests/verify-scheduler.test.mjs` | **5/5 通过** | E1–E3（闸门确定性用例）+ 冻结边界自测 |
| `tests/verify-views-history.test.mjs` | **8/8 通过** | F1/F2、G1/G2/G3、H1 + 2 条自测 |
| `tests/verify-v2-boundary.test.mjs` | 8 通过 / 1 未接通 | C1/C2/C3、D1、D2、D4 通过；D3 = 未接通（真实 Connection bridge） |
| 契约侧 | `contracts` + `package-identity` **35/35**、`npm run typecheck` exit 0 | |

### 已确认的实现违反与修复状态（全部已修复并由我独立复验）

| 编号 | 契约条目 | 现象 | 修复后实测 |
| --- | --- | --- | --- |
| **F-1** | R15 计费口径 | 16 MiB 清单 + 32 MiB 预算被 `TOO_LARGE` 拒绝；阈值二分 94 MiB(5.88×) 仍拒、96 MiB(6.00×) 才过 → 按内部核验读取次数累加 | B5 `completed`；超预算用例 `rchar` 增量 **16,781,020 → 312**（规划阶段拒绝，未读内容）。证据：`docs/verification/task6-metadata/{budget-accounting,budget-planning-refusal}.log` |
| **F-2** | R17 `scope:'roots'` | `bootstrap` 被 503 打掉，前端拿不到降级原因 | `bootstrap` 200 + `roots: []` + `degraded.scope='roots'`；文件操作仍 503 + `details.scope='roots'`。证据：`docs/verification/task6-boundary/degradation-roots.log` |
| **F-3** | 契约 §3.3（wire 码集封闭） | 未映射 errno（`EIO`）原样上 wire（`items[0].error.code === 'EIO'`），使 wire 码成为开放集合 | 归一为 `IO_ERROR`/500 + `details.cause === 'EIO'`；持久化记录里的裸 errno 码在投影时同样归一（`ENOSPC → NO_SPACE`）。用例 `tests/contracts.test.mjs`（含变异验证）+ B4(b) 收紧断言。证据：`docs/verification/task6-metadata/budget-failure-semantics.log` |

### F-4（历史：当时待 host-core 定位、红灯保持；现已修复并复验）：冷重开的归一化**不幂等**，每次打开都改写记录
- 触发断言（Lead 强化要求，`tests/verify-views-history.test.mjs` 的 H2）：同一持久化快照连续打开两次，第二次**必须零写入**。
- 实测：`open1 writes=1 open2 writes=1`，唯一差异是 `updatedAt`：
  `snapshot item=failed/2 open1 writes=1 open2 writes=1 revision=2 changes=[updatedAt: "…16:03:43.554Z" -> "…16:03:43.557Z"]`
- 含义：每次打开历史都会重写记录并推进 `updatedAt`（revision 未漂移、关闭状态未被复活、恢复证明未丢——所以不是数据损坏，但"每次打开都改写"正是 Lead 要求捕获的退化）。同一记录状态在**独立脚本**里先多做一次 await（`docs/verification/repro-reopen-write.mjs`）时观测到 0 写，说明触发条件是"打开时重算/刷新 `updatedAt`"，在真实运行中时间必然前进，因此几乎每次打开都会命中。
- 证据：`docs/verification/task6-views/history-idempotence.log`；最小复现脚本：`docs/verification/repro-reopen-write.mjs`（该脚本当时使用本机绝对导入路径，在其他 checkout 上需先改为仓库相对路径才能运行）。
- **后续更新（0.2.8 前）**：F-4 已由 host-core 修复并独立复验——修复后 `open1 writes=0 open2 writes=0`，见 [docs/VERIFICATION-REPORT.md](VERIFICATION-REPORT.md) §3.4；`tests/verify-views-history.test.mjs` 的 H2 用例在该断言重新变红时会再次报警。上面记录的是**修复前**的观测。

### 记录项（不作为失败判据）
- 复制路径读放大 ≈10×（16 MiB 文件 → `rchar` ≈168 MiB）；Lead 已要求写入"已知限制"，不做降低校验强度的优化。
- 超预算操作在 F-1 修复前会先读完整份文件再拒绝；修复后由规划阶段拒绝（`rchar` 312）。
- 冷重开（`createTaskService({initialTasks})`）在"已关闭 + 重试已落地"的记录上会写一次；实测该次写入**不**复活记录、**不**重置 revision、**不**丢弃已记录的失败码（`dismissed=true/rev=2/item=failed/code=NOT_FOUND`），故不判为违反；本用例的"关闭/重开不得改写持久化记录"基线改为在关闭之后取样。
- 发布后持久化失败：修复前为裸 `EIO`，修复后为 `IO_ERROR` + `details.cause='EIO'`（`details.committed === true` 与"已提交内容不回收"始终成立）。

### G3 的计划修正（重要，避免虚报）
原计划要求"根相对路径 >4096 字符必须列为 `unaddressable`"。实测结论：**该场景在 Linux 上不可构造**——绝对路径会超过 `PATH_MAX`(4096)，真实 `readdir` 永远拿不到这样的相对路径（创建到 3800 字符即已是可达上限）。因此 G3 改为验证**可达的那一半**：深层嵌套（~95 层、相对路径 ~3800 字符）逐层 `entries.list` 必须 200 且**全部可寻址**、最深文件可 `entries.stat`；`>4096` 的分类本身由 `tests/contracts.test.mjs` 的语法 oracle 单测覆盖。

### 我自己的用例缺陷（已修正并记录，避免把测试错误当实现违反）
1. bulk op（`tasks.start`/`tasks.retry`/`transfers.begin`）必须走 `/v2/manifest`，走 control 会 400（实现符合契约）。
2. `entries.stat` 会消耗核验预算 → 改用测试自算令牌 `dev:ino:size:mtimeNs:ctimeNs:sha256` 取得 `expectedVersion`。
3. 文本保存必须用**内容强版本**（`text.read` 的 `version`）；用列表弱令牌会 409 `VERSION_CONFLICT`。
4. "拒绝前不得读完"是我自加、比 spec 更严的标准 → 降级为记录项。
5. "取消排队任务后状态必须立即变 `cancelled`"是我自加的标准 → 改为可观测事实（cancel 立即 200 + `cancelRequested=true` + 释放许可后终态 `cancelled`）。
6. 测量区间内不得包含测试自身的哈希（B6 首次把 `readFileSync` 算进了 `rchar`）。
7. 复制任务不 `sourceRemoved`（我误按 move 断言）。
8. 服务层 `get`/`retry` 是 **async**，且 `await obj.get(x).field` 会被解析为 `await (obj.get(x).field)` → 必须加括号。
9. `transfers.retry` 收**裸 id**，`tasks.retry` 收 `{taskId}`；只有**失败**记录可 retry。
10. 冷重开基线必须在"关闭之后"取样，否则会把 retry/关闭的正常变更误判为"重写历史"。

## 0. 纪律与前提

1. **不复用队友的结论**：task-4/task-5 报告里的命令与结果只作为对照，我独立复跑并独立取证。
2. **绝不触碰当前 profile 的真实存储**：所有"损坏/降级"场景一律用**注入的隔离 Storage/Settings 桩**（与 `tests/runtime-storage.test.mjs` 相同的 fake `storageDomain` 方式）构造；任何用例都不得读写 `$DSH_HOME` 下的真实 profile 数据。若某条无法在隔离桩上完成，该条记为"未验证"，不得用真实存储代替。
3. **不得静默跳过**：真实 Connection/Storage 集成用例在环境缺失时必须**失败**（或明确记为未验证），不允许 `skip` 后显示绿色。骨架里"就绪守卫"用例会直接失败，逐条用例在未就绪时带明确原因 skip（可见，不是通过）。
4. **一条一次变量**：每条用例只改一个输入，失败时回到最早的未定环节，不扩大探索。
5. **证据落地**：每条用例把真实命令与原始输出写入 `docs/verification/<run-id>/<case>.log`，并在 `docs/VERIFICATION-REPORT.md` 汇总（通过/失败/未验证三分）。`<run-id>` 形如 `2025-01-01T000000Z-task6`。

## 1. 核心观测点（Observability toolkit）

| 代号 | 观测点 | 能证明什么 | 本机状态 |
| --- | --- | --- | --- |
| **O1 rchar** | `/proc/self/io` 的 `rchar` 增量（进程经 `read`/`pread` 实际读入的字节数） | 实现是否真的读/哈希了文件内容 | ✅ 实测：读 32 MiB 文件 → 增量 33,554,549（噪声约 100 B） |
| **O2 版本形态** | 返回的 `version` 是否匹配 `MetadataVersionSchema`（无摘要段）/ `ContentVersionSchema`（`…:sha256`） | 浏览型令牌是否含内容摘要 | ✅ 契约层已有 schema |
| **O3 元数据重算** | 用测试自己的 `lstat({bigint:true})` 重算 `dev:ino:size:mtimeNs:ctimeNs` 并与返回令牌比对 | 令牌是元数据派生的，不需要读内容 | ✅ 与 `host/manager.js` 的 `stamp` 一致 |
| **O4 权限反证** | 目录内放 `mode 000` 文件：列表/引用仍成功；任何需要内容的操作失败 `EACCES` | 列表路径**不可能**读过内容 | ✅ 进程 uid=1000（非 root），权限确实生效 |
| **O5 结果侧不变量** | `entries[].path` 必须可寻址；`unaddressable` 项无 `path` | R18 的结构性保证 | ✅ 契约 schema 已强制 |
| **O6 发布事实** | 目标文件存在性与字节、`details.committed`、错误码 | 拒绝/失败时有没有偷偷改文件 | ✅ |
| **O7 调度器状态查询** | `scheduler.stats()` / 任务状态（进行中数量） | 并发上限是否被真正执行 | ⏳ 依赖 task-2 暴露的状态查询 |
| **O8 流式反证** | 读到第一个响应分片时任务状态仍为 `running`，且 `rchar` 远小于文件大小 | 下载响应未被整体缓存 | ✅ 与既有 `download-navigation.test.mjs` 同路 |
| **O9 原始记录字节** | 隔离存储桩里的原始记录（JSON 字节/Map 内容）前后比对 | 公开 DTO 未回写日志、损坏数据未被重置 | ✅ |

> **O1 的使用规则**（最容易写成空断言的地方，必须按此写）：
> 0. **重复 3 次取中位数，并扣除基线**：同一操作连测 3 次（每次之间做一次同类型预热），取 3 次增量的中位数；同时测量一条**对照操作**（空目录 `entries.list` 或同尺寸的 `lstat`-only 路径）作为**基线**，断言用「中位数 − 基线」判定。小文件场景下噪声（约 100 B/次，含读 `/proc/self/io` 自身）会淹没信号，因此**任何"不读内容"的断言都必须在 ≥16 MiB 的文件上做**，小文件只用于功能正确性断言。
> 1. 每个测量用例**先做一次同类型预热**，再测量；测量区间内只调用被测操作。
> 2. 同时测一条**对照操作**（例如空目录 `entries.list`），把它的增量作为噪声上界；断言用**严格不等式**且留 ≥8× 余量（例：64 MiB 文件，断言增量 < 1 MiB，而对照约几 KiB）。
> 3. `/proc/self/io` 不可读时该用例**必须失败**（本环境是 Linux-only，读不到就是环境异常，不是"跳过"）。
> 4. 断言必须写成"**小于**文件大小的一个明确比例"（证明没读全文），**不是**"小于某个很大常数"（那是空断言）。反向用例（必须读过）用"**大于等于**文件大小"。
> 5. 与 O2/O3 联合使用：rchar 证明"没读"，O2/O3 证明"令牌不含摘要"。两者同时成立才算证明。

## 2. 用例清单

每条格式：**契约条目 → 命令/fixture → 判定标准 → 证据路径**。文件后缀 `.log` 均位于 `docs/verification/<run-id>/`。

### A. R14 概念分离（元数据快照 vs 内容强版本 vs 恢复证明）

**A1 浏览不读内容**
- 条目：R14「列表、信息查询、引用，不读取全文」。
- 命令/fixture：`node --test tests/verify-metadata-boundary.test.mjs`；临时根下建 1 个 64 MiB 普通文件（`writeFileSync` 随机/重复字节）与 1 个 64 MiB 稀疏文件（`truncate -s 64M`），`entries.list` 目录 + `entries.reference` 该文件。
- 判定：两次操作的 `rchar` 增量都 **< 1 MiB**（文件 64 MiB）；返回 `version` 满足 `MetadataVersionSchema` 且 `isContentVersion === false`；令牌等于测试用 `lstat(bigint)` 重算的 `stamp`（O3）；`entries.reference` 返回的 `absolutePath`/`mention` 正确且不触发读。
- 证据：`metadata-boundary.log`。

**A2 浏览在"内容不可读"时仍成功（O4 反证）**
- 命令/fixture：目录内建 `mode 000` 文件；`entries.list` + `entries.reference`；随后对该文件发起需要内容的操作（`text.read` 与 `transfers.begin(download)`）。
- 判定：列表与引用成功且返回该条目；内容类操作失败（`EACCES→PERMISSION_DENIED`/403 或 `UNSUPPORTED_ENCODING`/`TOO_LARGE` 之外的合理码，逐条记录实际码），**不得**因为读失败而让整个 `entries.list` 失败。
- 证据：`metadata-boundary-permission.log`。

**A3 强版本只在需要内容时出现**
- 命令/fixture：同一文件先 `entries.list`（弱），再 `entries.stat`（应为强，含 `sha256`），再 `text.read`（强）。
- 判定：`entries.stat`/`text.read` 的 `version` 满足 `ContentVersionSchema` 且 `metadataVersionOf(version)` 等于列表返回的弱令牌；`entries.stat` 的 `rchar` 增量 **≥ 文件大小**（证明真的读了并算了摘要，即**没有**降级为"只给弱版本冒充强版本"）。
- 证据：`metadata-boundary-strong.log`。

**A4 弱版本不能冒充强版本（负面）**
- 命令/fixture：用列表返回的弱 `version` 作为 `text save` 的 `expectedVersion` 与覆盖类 `expectedTargetVersion`。
- 判定：拒绝且码为 `STRONG_VERSION_REQUIRED`/409（覆盖场景）或 `VERSION_CONFLICT`/409（保存场景），磁盘内容与 mtime **未变**（O6）。
- 证据：`metadata-boundary-weak.log`。

### B. R15 资源预算（含"不得降级校验"）

**B1 预算超限必须拒绝且不读全文**
- 命令/fixture：隔离 Settings 桩把 `maxVerificationBytes` 设为 1 MiB；源文件 16 MiB；发起 `tasks.start(copy)`。
- 判定：失败码 `TOO_LARGE`/413（核验限额），`details` 指明是核验预算（记录实际字段）；目标不存在（O6）；源文件字节与 mtime 未变。**实测修正（task-6）**：实现是"边哈希边计费"，因此超预算操作会先读完整份文件再拒绝（16 MiB 文件 + 1 MiB 预算 → `rchar` 增量 ≈16.8 MiB）。这**不是**冻结标准的违反（R15 只要求明确拒绝且不降级校验），已降级为效率观察并记入证据，不作为失败判据。
- 证据：`budget-refuse.log`。

**B2 预算内必须真的校验（正面对照）**
- 命令/fixture：同一 fixture，`maxVerificationBytes` 设为 64 MiB；复制 16 MiB 文件。
- 判定：成功；`rchar` 增量 **≥ 16 MiB**（读了内容才算过，证明没有跳过校验）；目标强版本 `sha256` 等于源的 `sha256`；再对目标内容做一次独立哈希比对（测试自己算）。
- 证据：`budget-verify.log`。

**B5 预算口径 = 清单文件字节总量（实测为失败用例，已上报）**
- 条目：R15「按该操作清单涉及的文件字节总量计费，不按底层函数调用重置」。
- 命令/fixture：`node --test tests/verify-metadata-boundary.test.mjs`；`maxVerificationBytes = 2 × 16 MiB`，单文件 16 MiB 复制。
- 判定：**必须成功**（清单 16 MiB ≤ 预算 32 MiB）。
- 实测（task-6，真实运行）：**失败**。阈值二分结果：16 MiB 清单在预算 94 MiB（5.88×）时仍被 `TOO_LARGE` 拒绝，96 MiB（6.00×）才成功 → 计费约为**清单总量的 6 倍**（按内部核验读取次数累加）。推论（基于实测比值，未跑 2 GiB 实测）：默认预算 10 GiB 下，单个 2 GiB 文件复制需约 12 GiB → 会被 `TOO_LARGE` 拒绝，与 R9 冻结的"单文件 2 GiB"不一致。
- 证据：`budget-accounting.log`。

**B3 预算按"操作清单总量"计费，不按底层调用重置**
- 命令/fixture：`maxVerificationBytes = 1 MiB`；一个 `tasks.start(copy)` 清单含 3 个各 0.5 MiB 文件（单文件都低于预算，合计 1.5 MiB）。
- 判定：整单拒绝 `TOO_LARGE`/413（若实现按"每次调用"重置预算则本用例会通过复制 → 用例失败）；目标目录内**没有任何**已发布文件（逐项列出实际残留，若存在残留则判失败并记录）。
- 证据：`budget-per-operation.log`。

**B4 纯核验失败不改文件；发布后失败必须报告已提交**
- 命令/fixture：(a) 在源哈希与发布之间改动源（`writeFileSync` 同尺寸不同内容）→ 期望 `VERSION_CONFLICT`/409，源与目标字节均与操作前一致；(b) 注入"发布成功后立即改目标"的故障 → 期望 `details.committed === true`，且**不**声称回滚。
- 判定：逐条比对操作前后源/目标 SHA-256 与 mtime；错误 DTO 的 `details.committed` 取值符合 R15。
- 证据：`budget-failure-semantics.log`。

### C. R17 持久化与只读降级（**只用隔离桩**）

**C1 操作记录不可用 → 只读降级**
- 命令/fixture：注入 fake `storageDomain`：`local_file_manager`（根授权）正常、`local_file_manager_operations` 打开时抛错。绝不使用真实 profile。
- 判定：`bootstrap` 成功且 `capabilities.write === false`、任务/传输/历史能力为 false，并给出**降级原因**（字段形状见 §4 待裁决项）；`entries.list` / `text.read` 成功；`roots.add`、`entries.create-file`、`tasks.start`、`activities.dismiss` 全部被拒绝且码为 **`FILE_MANAGER_UNAVAILABLE`/503**、`details.scope === 'operations'`（**不得** 200）；`tasks.list` **不得**返回 `[]`（禁止把不可用历史显示为空历史）。
- 证据：`degradation-readonly.log`。

**C2 损坏的原始记录被保留、不被重置**
- 命令/fixture：隔离桩中预置一条**故意损坏**的 operations 记录（例如 `{id:'x'}` 缺 `items`，以及一条 `id` 与 key 不匹配的记录）。
- 判定：初始化失败进入降级；操作后**原始记录字节完全一致**（O9，前后 JSON 比对）；不出现"自动重建为空日志"的行为；重新以正常桩打开时，能读到原始记录（说明未被丢弃/改写）。
- 证据：`degradation-preserve.log`。

**C3 根授权不可信 → 拒绝访问**
- 命令/fixture：隔离桩里预置 `roots` 记录为非法形状（`identity` 非 `d:d`、`path` 非绝对）。
- 判定：拒绝文件访问（非 200），且**不静默丢弃**该授权（原始记录字节不变）。
- 证据：`degradation-roots.log`。

### D. R19 HTTP 边界 + 鉴权/跨站

**D1 v2 路由表与旧入口拒绝**
- 命令/fixture：`apply(ctx)` 用桩 ctx（与 `tests/api.test.mjs` 同法）注册；断言注册的路由集合与 `protocol.ROUTES` 完全一致（路径/方法/请求体模式）。
- 判定：6 条 v2 路由精确匹配；对 5 条旧路径发写请求 → 明确升级/刷新错误（记录实际码，期望 `INVALID_REQUEST`/404 或等价），**且磁盘上没有任何文件被创建/修改**（旧入口不得被当作 v2 写请求）。
- 证据：`v2-routes.log`。

**D2 准入：小体 8 / 大体 2，超额先拒绝并释放请求体**
- 命令/fixture：并发发起 N 个慢速小体请求与 M 个慢速大体请求（用可控的流式 body 保持占用），观察超额请求的响应。
- 判定：第 9 个并发小体与第 3 个并发大体立即得到 `TOO_MANY_REQUESTS`/429；**请求体被释放**（服务端在拒绝前未读完 → 用"发送方写入被取消/连接被关闭"或 `rchar` 不随大体量增长来证明）；大体不得"读完才拒"。
- 证据：`v2-admission.log`。

**D3 下载 GET + 流式 + 鉴权/跨站（真实 Connection）**
- 命令/fixture：沿用既有真实 Connection 方式（`tests/runtime-storage.test.mjs` / `download-navigation.test.mjs` 的启动路径）起真实运行时，真实 HTTP：已认证无 Origin 的原生 GET → 200 且字节正确；目录下载 → 真实 ZIP（用 `yauzl` 校验条目名/内容/空目录）；未认证 → 拒绝；跨站 Origin → 拒绝。
- 判定：字节逐一比对；ZIP 条目与层级一致；**流式反证**：读到首个分片时任务状态仍为 `running`，且此时 `rchar` 明显小于文件大小（O8）；请求体缓冲模式不得导致响应文件被整体缓存。
- 证据：`v2-download-auth.log`。
- 未就绪处理：若真实运行时不可用 → 本用例**失败**（不得 skip），并在报告中记为"未验证：环境不可用"。

**D4 文本保存走文本入口，大文本不受小信封限制**
- 命令/fixture：`/v2/text` 的 `op:'save'` 保存 > 256 KiB 文本（上限 `maxTextBytes*6+64 KiB`）；再对 `/v2/control` 发同一 payload。
- 判定：文本入口成功且回执不含正文；control 入口对同一 payload 得到 `TOO_LARGE`/413（信封区分正确）。
- 证据：`v2-text.log`。

### E. R16 共享重 IO 调度

**E1 并发上限 2 被真正执行**
- 命令/fixture：`transferConcurrency=2`；同时发起 4 个受控复制任务（源文件由测试控制在 IO 中途暂停）；读调度器状态（O7）与任务状态。
- 判定：任意时刻"进行中"的重 IO 操作 ≤ 2；第 3/4 个任务处于等待；全部完成后 4 个任务都成功。
- 证据：`scheduler-concurrency.log`。

**E2 状态查询与取消不占许可**
- 命令/fixture：持有 2 个许可（两个受控任务卡在 IO 中途），此时调用 `tasks.list` / `tasks.get` / `tasks.cancel`（对第 3 个排队任务）。
- 判定：状态查询立即返回（不阻塞、不占用许可）；取消生效（排队任务变为 `cancelled`）且**没有**获得许可；取消被取消任务后其暂存被清理（O6）。
- 证据：`scheduler-cancel.log`。

**E3 队列上限 64 → 429；异常释放许可；嵌套复用不死锁**
- 命令/fixture：直接对调度器压 65 个等待者；再注入一次操作异常；再触发嵌套（核验内部再取许可）。
- 判定：第 65 个得到 `TOO_MANY_REQUESTS`/429；异常后许可数恢复（后续操作能继续）；嵌套场景在有限时间内完成（不死锁）。
- 证据：`scheduler-bounds.log`。（task-2 已有单元级覆盖，本条是**集成侧**复核。）

### F. 公开视图白名单（真实 HTTP 取证）

**F1 响应里没有恢复证明，日志里必须还有**
- 命令/fixture：真实 manager + 临时根，跑一次真实 `tasks.start(copy)` 与一次 `transfers.begin(download)`；抓取 v2 响应的**原始 JSON 文本**；同时读取隔离存储桩里的原始记录。
- 判定：响应的 JSON 文本中 `"checkpoint"`、`"measured"`、`"identity"`、`"sha256"`、`"metadataVersion"`、`"targetManifest"`、`"destinationIdentity"` **全部不出现**；而原始记录里**必须仍然存在**恢复证明字段（证明没被从存储里删掉）；`items[].result.destination` 不含 `identity`/`sha256`；`items[].error.code` 保持业务码（不因投影退化成 `IO_ERROR`）。
- 证据：`views-whitelist.log`。

**F2 关闭回执恰好五个字段**
- 判定：`activities.dismiss` 返回的 `task` 键集合恰为 `['canDismiss','dismissed','historyRevision','id','status']`；被拒项为 `{kind,taskId,outcome:'rejected',error}`。
- 证据：`views-receipt.log`。

### G. R18 特殊文件名（真实文件系统）

**G1 逐项隔离与不可执行性**
- 命令/fixture：临时目录内建：普通文件、`bad\\name`（反斜杠）、含 `\x01` 的名称、目录、符号链接；`entries.list`。
- 判定：HTTP 200；普通条目在 `entries`；特殊名称在 `unaddressable`，字段恰为 `{name,kind,reason}`（**无 path**）；`total` 只计可寻址条目；`nextCursor` 仍按完整 readdir 推进（分页多次能取完全部可寻址项，且不可寻址项按页分布）；整目录不因单个特殊名称失败。
- 证据：`r18-list.log`。

**G3 深嵌套导致相对路径 > 4096 → 必须分类为不可寻址，不得 500**
- **后续更新（0.2.8 前）**：本条 fixture 的前提已被实测推翻——>4096 的相对路径在 Linux 上不可构造，实际执行的是上面的“G3 的计划修正”（~95 层、相对路径 ~3800 字符，全部可寻址且不得 500）；`>4096` 的分类只由 `tests/contracts.test.mjs` 的语法 oracle 覆盖。下面保留的是**原始计划文本**。
- 条目：R18 + 契约结果侧不变量（Lead 已批准：>4096 的相对路径语义上不可寻址）。
- 命令/fixture：在临时根下逐层创建目录（每层名长约 40 字符，深度使其相对路径总长 > 4096），最深层放一个普通文件；`entries.list` 根目录并逐层分页到深层。
- 判定：`entries.list` **必须成功**（HTTP 200，无 `INVALID_STATE`/500）；深层项出现在 **`unaddressable`**（带 `reason`，无 `path`）而不是出现在 `entries`、也不是让整次枚举失败；同目录其他普通条目照常返回；`total` 只计可寻址条目。
- 失败判据（本用例的哨兵）：出现 `INVALID_STATE`/500、或该深层项出现在 `entries`、或整目录枚举失败 → 判失败，并记录实际响应体。
- 证据：`r18-deep-nesting.log`。

**G2 目录操作明确失败、不静默遗漏**
- 命令/fixture：对含不可寻址条目的目录发起 `delete.prepare`、`tasks.start(copy)`、`transfers.begin(download)`（ZIP）。
- 判定：该目录项失败且码为 `UNREPRESENTABLE_REFERENCE`/422（不新增码）；同批其他条目遵守 R8 部分成功语义（成功/失败逐项记录）；**不得**静默跳过特殊条目后报告"全部成功"。
- 证据：`r18-operations.log`。

### H. R13 升级与冷重开

**H1 关闭不复活、旧关闭不隐藏新执行、恢复证明保留**
- 命令/fixture：隔离桩；完成一次下载 → `activities.dismiss` → 关闭服务 → 用**同一桩数据**冷重开 → `transfers.list`；再 `retry` 并重新完成；再用**旧** `expectedHistoryRevision` 关闭。
- 判定：冷重开后该记录仍 `dismissed`（不复活）且 revision 不变；重试后重新可见（`dismissed=false`，revision 递增）；旧关闭动作得到 `TASK_CHANGED`/409 且**不隐藏**新执行；原始记录里的恢复证明字节不变（O9）。
- 证据：`history-cold-reopen.log`。

### I. 回归与不变量（贯穿）

**I1 契约回归**：`node --test tests/contracts.test.mjs tests/package-identity.test.mjs`（32 项）必须保持全绿。
**I2 全量套件**：`npm run typecheck && npm run build && npm run check:dist && node --test tests/*.test.mjs`，记录 tests/pass/fail/skipped 真实数字；**skipped 必须为 0**（若不为 0，逐条列出 skip 原因并判定是否违规）。
**I3 未削弱断言**：用 `git diff` 逐文件复核 task-4/task-5 对既有测试的改动，只允许"导入改 dist / 路由改 v2 / 新增用例"，不允许删减或放宽断言（重点核对：`TOO_LARGE`/413、`VERSION_REQUIRED`/409、`CONFIRMATION_REQUIRED`/400、`SOURCE_DELETE_FAILED`、`TASK_BUSY`、`HISTORY_REVISION_EXHAUSTED`、恢复证明断言、Client 渲染断言）。
**I4 原始项目未被修改**：`git -C /app/project/dsh-files/dsh-file-manager status --porcelain` 只应显示既有未跟踪文件，且哈希与副本基线一致。（`/app/project/...` 为**当时本机的只读副本路径**，其他 checkout 按仓库相对路径理解。）

## 3. 判定与报告口径

- 每条用例的结论只能是 **通过 / 失败 / 未验证** 三选一，并附真实命令与输出片段。
- "未验证"必须写明原因（环境不可用、依赖未落地、无法隔离等）与影响面；不得用"通过"替代。
- 任何"通过但没证明"的用例（例如断言只检查了 HTTP 200）视为不合格，必须补强观测点后重跑。
- 报告：`docs/VERIFICATION-REPORT.md`（task-6 交付物），含：环境、命令、原始输出摘要、逐条结论、与队友报告的差异、剩余风险。

## 4. 需要 Lead 裁决 / 依赖项

1. ~~R17 降级原因字段形状~~ **已裁决并冻结**：`bootstrap.degraded: DegradedView | null`（判别联合，必填可空；`scope:'operations'` → `readOnly:true`，`scope:'roots'` → `readOnly:false`）。C1 按此断言：降级拒绝码为 `FILE_MANAGER_UNAVAILABLE`/503 且 `details.scope` 匹配；`tasks.list` 不得返回 `[]`。
2. **核验预算错误码**：本计划按 `TOO_LARGE`/413 + `details` 指明预算来判定（不新增错误码）。若 Lead 要求独立码，请指定。
3. **调度器状态查询接口**（阻塞 E1/E2）：需要 task-2 的 `src/host/scheduler.ts` 暴露一个**不占许可**的状态查询（例如 `stats(): { active: number; queued: number }`）。若接口名不同，我按实际调整。
4. **真实 Connection/Storage 用例的启动方式**：沿用 `tests/runtime-storage.test.mjs` 的既有路径；若 task-4 改了启动方式，需 host-core 提供新的启动片段（否则 D3 记为未验证）。
5. **不可寻址名称的判定集合**：我按契约把"控制字符、反斜杠、空段/点段、相对路径 > 4096"都算不可寻址（`entries[].path` 结果侧不变量）。若引擎的实际判定集合不同（例如不含长度），请裁决后我调整契约与 G1 的期望集合。
