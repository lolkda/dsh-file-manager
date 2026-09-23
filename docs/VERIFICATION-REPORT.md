# TypeScript 重构与后续 UI 修复验证记录

> **本文件记录到 0.2.7 为止的验证。** 工作区当前版本为 0.2.8（含深路径面包屑修复 R20）：0.2.8 的版本验证与正式公开发布**尚未执行**，其最终测试计数与发布验证由 Lead 在完成后补记，本文件不预称已完成。当前权威文档：[SPEC.md](../SPEC.md)（行为规则与验收）、[README.md](../README.md)（版本与验证状态）。
> **粘贴弹窗 UI 修复及其验证结果见 §9。**
> §0–§8 保留 task-6 当时的独立验证快照；其中 502 项、166,591 字节是历史基线，不是 0.2.7 的统计。§9 由 Lead 在用户报告真实页面问题后追加，不冒称为队友独立验收。

> 状态：**最终交付**。task-6 已 claim 并完成（task-1…task-5 全部 complete 后执行）。
> 最终全量确认（`npm run build && npm test`，真实运行）：**502 项 / 502 通过 / 0 失败 / 0 跳过 / 0 取消**，`dist` 构建 166,591 字节。
> 本报告的独立验证套件合计 **79/79 通过**（14 + 5 + 9 + 9 + 7 + 35）。
> 判定口径：只有**真实运行**观察到的行为才算"通过"；不可构造或环境缺失的场景一律标注"未验证"，不以 stub 或静默跳过充数。
> 本报告全部结论可用文末"复现方式"逐条重跑。

## 0. 范围与角色

- 验证对象：`dsh-file-manager-ts` 的 TypeScript 移植实现（Host `dist/index.js`、`dist/host/*.js`、契约 `dist/contracts/*.js`），对照基准为只读的 legacy `dsh-file-manager` 与 `SPEC.md` R1–R19、冻结契约 `docs/CONTRACT.md`。
- 验证者：`contracts-verification`（独立于 host-core / client-ui 的实现方）。写入范围仅 `src/contracts/**`、`docs/**`、`tests/verify-*`、`tests/contracts.test.mjs`、`tests/package-identity.test.mjs`。
- 判据来源：`docs/VERIFICATION-PLAN.md`（含 Lead 逐轮裁定：R15 计费口径 A 方案、R17 roots 降级 A 方案、wire 码集封闭、冷重开归一化幂等）。

## 1. 结论摘要

### 1.1 套件状态（最终交付时的一次真实运行）

**全仓基线**：`npm run build && npm test` → `tests 502 / pass 502 / fail 0 / skipped 0 / cancelled 0`（构建产物 `dist/` = 166,591 字节）。`npm run typecheck` exit 0。

**本报告的独立验证套件**（均为真实运行，命令见 §8）：

| 套件 | 结果 |
| --- | --- |
| `tests/verify-metadata-boundary.test.mjs` | **14/14 通过** |
| `tests/verify-scheduler.test.mjs` | **5/5 通过** |
| `tests/verify-views-history.test.mjs` | **9/9 通过**（F-4 修复后复验通过） |
| `tests/verify-v2-boundary.test.mjs` | **9/9 通过**（含真实 Connection bridge 的 D3） |
| `tests/verify-client.test.mjs` | **7/7 通过**（Client 侧独立验证，见 §2.4） |
| `tests/contracts.test.mjs` + `tests/package-identity.test.mjs` | **35/35 通过、0 跳过** |
| `npm run typecheck` | exit 0 |

### 1.2 未验证项（**必须保留，不得因其余全绿而淡化**）

| 未验证项 | 现状与原因 |
| --- | --- |
| **2 GiB 单文件与默认核验预算的交互** | F-1 修复后按清单总量一次扣减，理论上 2 GiB 不再受 6× 放大影响，但**未跑 2 GiB 实测**（成本过高）；现有结论仅由 16 MiB 用例的比值与阈值二分**推断**，不作为已通过项。 |
| **浏览器端验收** | 本报告只覆盖 Host/契约/wire 与 `react-test-renderer` 层面的渲染断言；**真实浏览器中的页面验收由 Lead 负责**，不在本报告范围内。 |
| **D3 的鉴权半边未注入变异** | 无 cookie(401)/跨站(403) 拒绝由 **Connection 框架**提供（部署依赖），我用真实 bridge **观测**验证了"零文件字节泄漏"，但**未**对其注入变异（不在本仓范围内）；D3 的变异注入（M2）覆盖的是响应头/字节相等半边。 |
| **`>4096` 相对路径分类** | Linux 上不可构造（绝对路径必超 `PATH_MAX`），仅由 `contracts.test.mjs` 的语法 oracle 单测覆盖，见 §5。 |

### 1.3 实现违反清单

| 编号 | 契约条目 | 状态 |
| --- | --- | --- |
| **F-1** | R15 核验预算计费口径 | 已修复并复验（§3.1） |
| **F-2** | R17 `scope:'roots'` 降级时 bootstrap 不可读 | 已修复并复验（§3.2） |
| **F-3** | 契约 §3.3 wire 错误码集合封闭（未映射 errno 透传） | 已修复并复验（§3.3） |
| **F-4** | R13 冷重开归一化不幂等（每次打开都写盘） | 已修复并复验（§3.4） |

## 2. 逐条判定

### R14 元数据/内容版本边界（`verify-metadata-boundary`）

| 用例 | 判定 | 观察到的真实行为 | 证据 |
| --- | --- | --- | --- |
| A1 浏览与引用不读内容 | 通过 | 64 MiB 文件上 `entries.list` + `entries.reference` 的 `rchar` 增量**中位数 88 字节**（样本 88/88/89，扣同形基线）；列表令牌 = 测试用 `lstat(bigint)` 独立重算的 `dev:ino:size:mtimeNs:ctimeNs`，且不含摘要段 | `task6-metadata/metadata-boundary.log` |
| A2 不可读成员不破坏列表 | 通过 | mode-000 文件仍出现在列表与 `entries.reference`（元数据路径不读内容）；`text.read` → **403 `PERMISSION_DENIED`** | `…-permission.log` |
| A3 读内容处才出现强版本 | 通过 | `entries.stat` 读满 16 MiB（`rchar` 16,779,616），返回 `metadataVersion:sha256`，摘要与测试独立计算一致；弱半段等于 A1 的列表令牌 | `…-strong.log` |
| A4 弱令牌不能授权内容替换 | 通过 | 文本保存用弱令牌 → **409 `VERSION_CONFLICT`** 且文件未变；覆盖目标用弱令牌 → 逐项 **`STRONG_VERSION_REQUIRED`**/409 且目标未变；弱令牌仍可用于 rename（元数据操作） | `…-weak.log` |
| B1 超预算拒绝且不发布 | 通过 | 16 MiB 清单 + 1 MiB 预算 → `TOO_LARGE`/413，目标未创建，源字节/mtime 未变 | `budget-refuse.log` |
| B2 预算内必须真校验 | 通过 | 16 MiB 复制成功，`rchar` 16,779,412 ≥ 文件大小（未跳过校验），目标 SHA-256 = 源 | `budget-verify.log` |
| B3 预算按操作而非按底层调用 | 通过 | 3×0.5 MiB 清单 + 1 MiB 预算 → 整体 `failed`，三项均 `TOO_LARGE`，目标目录空 | `budget-per-operation.log` |
| B4 失败语义 | 通过 | 过期删除清单 `delete.commit` → **409 `VERSION_CONFLICT`** 且文件保持新内容（未删除）；发布后持久化失败 → `IO_ERROR` + `details.cause='EIO'` + **`details.committed === true`** 且已提交内容仍在 | `budget-failure-semantics.log` |
| B5 预算口径 = 清单总量 | 通过（修复后） | 16 MiB 清单 + 32 MiB 预算 → `completed`（修复前 `TOO_LARGE`，见 §3.1） | `budget-accounting.log` |
| B6 规划阶段拒绝 | 通过（修复后） | 16 MiB 清单 + 1 MiB 预算 → `TOO_LARGE`，`rchar` 增量 **308/304**（修复前 16,781,020） | `budget-planning-refusal.log` |

测量自测：`rchar-selftest.log`（元数据中位数 0 / 内容读 16,777,216，确认观测点有效且能反证）。

### R15/R16 调度器（`verify-scheduler`）

| 用例 | 判定 | 观察到的真实行为 | 证据 |
| --- | --- | --- | --- |
| E1 共享有界池 | 通过 | 用闸门持有 2 个许可时 `active=2`；复制任务 `queued≥1` 且未发布；释放后 `completed`、`peak≤2` | `task6-scheduler/scheduler-concurrency.log` |
| E2 状态查询与取消不占许可 | 通过 | 两许可被持有时 `tasks.get`/`tasks.list` 即时 200 且 `active` 不变；`cancel` 立即 200 + `cancelRequested=true`；释放后终态 `cancelled` 且未发布任何文件 | `scheduler-cancel.log` |
| E3 队列边界/异常释放/嵌套 | 通过 | 队列 64 满后第 65 个 → **`TOO_MANY_REQUESTS`/429** 且不占队列；异常操作释放许可；`concurrency:1` 下嵌套 `run` 不死锁 | `scheduler-bounds.log` |

E1–E3 全部用**闸门（gated permits）**构造确定性时序，不依赖计时采样，因此不会 flaky。

### R17/R19 边界（`verify-v2-boundary`）

| 用例 | 判定 | 观察到的真实行为 | 证据 |
| --- | --- | --- | --- |
| C1 `operations` 降级 = 只读 | 通过 | bootstrap 200 + `degraded.scope='operations'` + `capabilities.write/tasks/taskHistory=false`，根列表仍有效；`entries.list`/`text.read` 仍 200；`roots.add`/`roots.remove`/`entries.create-file`/`entries.create-directory`/`entries.rename`/`delete.prepare`/`activities.dismiss`/文本保存全部 503 + `FILE_MANAGER_UNAVAILABLE` + `details.scope='operations'` | `task6-boundary/degradation-readonly.log` |
| C2 损坏记录保留不重写 | 通过 | 两条损坏记录（缺 `items`、`id` 与键不符）可读出、打开期间 **writes=0**、原始字节前后一致 | `degradation-preserve.log` |
| C3 roots 降级可读原因 | 通过（修复后） | bootstrap 200 + `roots: []` + `degraded.scope='roots'` + `capabilities` 全 false；`entries.list`/`text.read` 仍 503 + `details.scope='roots'`；文件未被改动 | `degradation-roots.log` |
| D1 路由表与旧路径拒绝 | 通过 | `ROUTE_TABLE` 与 `protocol.ROUTES` 逐字段（路径/方法/请求体模式）一致；5 条旧路径 → 404 + 升级文案且**不产生任何文件**；未知路径 → 404 | `v2-routes.log` |
| D2 准入 8/2 且先于读体 | 通过 | 小体并发 8 后第 9 个 → **429 `TOO_MANY_REQUESTS`**；大体并发 2 后第 3 个 → 429；被拒请求体被释放（未读完再拒） | `v2-admission.log` |
| D3 下载为鉴权 GET 且流式 | 通过 | 真实 Connection（真实签名 cookie + 真实 HTTP bridge）：鉴权 GET → 200 + **字节逐字节相等** + `content-disposition: attachment` + `cache-control: no-store` + `nosniff`；**无 cookie → 401 且零文件字节泄漏**；**跨站 Origin 持有效 cookie → 403 且零文件字节泄漏** | `download-auth.log` |
| D4 文本信封独立 | 通过 | `/v2/text` 保存 307,200 字节 → 200 且回执不含正文；同一 payload 走 `/v2/control` → **413 `TOO_LARGE`** | `v2-text.log` |

### 公开视图白名单、R18、任务历史（`verify-views-history`）

| 用例 | 判定 | 观察到的真实行为 | 证据 |
| --- | --- | --- | --- |
| F1 公开响应无恢复证明、日志仍有 | 通过 | 任务与传输的响应 JSON 中 `checkpoint/measured/identity/sha256/metadataVersion/targetManifest/destinationIdentity` **全部为 `leaks=none`**；持久化记录仍保留 `identity`/`sha256`/`version`；缺失源的项保留业务码 **`NOT_FOUND`**（未退化为 `IO_ERROR`） | `task6-views/views-whitelist.log` |
| F2 关闭回执五字段 | 通过 | 关闭回执 `task` 键集合恰为 `['canDismiss','dismissed','historyRevision','id','status']`；重复关闭幂等（`dismissed`，revision 不变）；可见记录 + 陈旧 revision → **`rejected` + `TASK_CHANGED`** 且记录仍可见 | `views-receipt.log` |
| G1 不可表达名安全逐项列出 | 通过 | 含反斜杠与 `\x01` 的名字进入 `unaddressable`，键集合恰为 `['kind','name','reason']` 且**无 `path`**；`total` 只计可寻址项（3）；`limit=1` 分页可走到每个可寻址项 | `r18-list.log` |
| G2 目录操作显式失败 | 通过 | `delete.prepare` → **422 `UNREPRESENTABLE_REFERENCE`** 且未删除任何内容；树复制 → 逐项 `UNREPRESENTABLE_REFERENCE`、未发布；ZIP 下载规划 → 422（不静默漏成员） | `r18-operations.log` |
| G3 深嵌套不降级为 500 | 通过 | 92 层 / 相对路径 3,771 字符：逐层 `entries.list` 均 200 且**全部可寻址**、最深文件可 `entries.stat`（`>4096` 见 §5） | `r18-deep-nesting.log` |
| H1 关闭不复活 / 旧关闭不隐藏新执行 | 通过 | 冷重开仍 `dismissed=true`、revision 不变、项错误码存活；重试中关闭 → **`TASK_BUSY`**；重试落地后用旧 revision 关闭 → **`TASK_CHANGED`** 且仍可见；再用当前 revision 关闭 → 成功；关闭后再重试 → 依 SPEC R13"新的重试重新显示"重新可见且 revision 递增 | `history-cold-reopen.log` |
| H2 冷重开归一化幂等 | 通过（修复后） | `open1 writes=0 open2 writes=0`，两次状态完全一致（修复前 `open1 writes=1 open2 writes=1`，仅 `updatedAt` 变化） | `history-idempotence.log` |

### 2.4 Client 侧独立验证（`verify-client`，本轮新增）

**复跑说明**：本套件针对**已构建**的 `dist/client.js`。task-5 完成后（client-ui-2 落地 5 处产品缺陷修复：分页 append 被丢弃、引用链路缺 `referenceScope`、无会话时引用按钮仍可用、上传评审弹窗不可 await、task-panel 定时器桩被忽略）我在最终构建（166,591 字节）上**复跑，7/7 保持不变**。这些断言读取的是渲染属性与记录的请求（而非内部实现），因此能穿过该轮重构仍然成立。

此前 task-6 只覆盖 Host 与契约，Client 是盲区。本轮新增 `tests/verify-client.test.mjs` + 本套件**自己的** harness（`tests/verify-client-harness.mjs`：自行加载 `dist/client.js`、自建 Cordis 上下文、自建 HTTP 桩、用 `react-test-renderer` 自行检查渲染树），因此不是复读作者的用例——每条断言都指明了它读取的渲染属性或记录的请求。

| 用例 | 判定 | 观察到的真实行为 | 证据 |
| --- | --- | --- | --- |
| C1 迟到的 `useSessions` 真的被使用 | 通过 | 无 hook 时引用动作 `disabled=true` 且无会话选择器；hook 到达后（用真实 hook `useSyncExternalStore` 建模）hook 被调用 3 次，选中条目后引用动作可用，打开后选择器渲染出 `['', 's1', 's2']`（占位项 + hook 提供的两个会话）——**hook 的数据确实到达了 UI** | `task6-client/c1-late-hook.log` |
| C2 分页不重复请求游标、不重复行 | 通过 | 同一帧连点两次"加载更多"：`entries.list` 的游标序列为 `<none>,cursor-1`（`cursor-1` **恰好一次**），渲染行 `normal.txt,second.txt` 无重复 | `c2-paging.log` |
| C3 主动取消不退化为 IO 故障 | 通过 | `i18n.failureCode(AbortError/ABORT_ERR)` = **`CANCELLED`**，两种取消形状的消息均为"操作已取消。"，且不等于 `EIO` 的通用文案；取消导致的列表失败**不会**在面板上渲染通用 IO 故障文案 | `c3-cancellation.log` |
| C6 SSE 截断的多字节尾部必须报错 | 通过 | 完整帧（`seq=1`）先交付，随后截断的 3 字节字符尾部使 `consumeEvents` 以 `EVENT_STREAM_INVALID` 失败；**没有**任何 `\uFFFD` 被当作正常帧发出 | `c6-sse-flush.log` |
| R18 不可表达条目渲染 | 通过 | 可表达条目渲染为 `data-fm-path=normal.txt,folder`；特殊名渲染为 `data-fm-unaddressable-name="bad\name"` 且**不进入** `data-fm-path`，原因文本可见，该节点内**无任何操作入口** | `r18-render.log` |
| R17 降级渲染 | 通过 | 降级时渲染"任务历史不可用，已结束的卡片仍保留在 Host 上，未丢失。· 操作记录不可用"（原因可见），写类动作全部 `disabled`；**差分对照**：同样的空历史在健康态**不出现**该提示——即"不可用"没有被渲染成"为空" | `r17-degraded.log` |

## 2.5 变异注入：证明关键断言真的能咬住

方法：对实现注入对应缺陷 → 构建 → 跑目标断言 → 必须变红 → 完整还原 → 重建 → 复绿。

| 注入 | 注入内容 | 目标断言 | 结果 |
| --- | --- | --- | --- |
| **M1** | `src/host/io.ts` 忽略 `metadataOnly`，让元数据路径也哈希内容 | A1「64 MiB 浏览+引用 `rchar` 中位数 88 字节」 | **变红**（`pass 0 / fail 1`）——证明该断言真的在约束"浏览不得读内容" |
| **M2** | `src/host/transfers.ts` 下载响应去掉 `cache-control: no-store` | D3「下载是鉴权 GET 且流式」 | **变红**（`pass 0 / fail 1`）——证明响应头断言有效 |
| **M3** | `src/host/tasks.ts` 恢复循环无条件持久化（重放 F-4 缺陷） | H2「冷重开归一化幂等」 | **变红**：`open1 writes=1 open2 writes=1`（修复态为 `0/0`）——证明幂等断言有效 |
| **M4** | 契约投影期归一关闭（`toPublicError` 不再归一裸 errno） | F-3 的契约用例 | **变红**——证明"历史裸 errno 也不得在 wire 上开出开放码集"被真正固定 |

还原后复跑：`verify-metadata-boundary` 14/14、`verify-scheduler` 5/5、`verify-views-history` 9/9、`verify-v2-boundary` 9/9、`verify-client` 7/7、`contracts`+`package-identity` 35/35（合计 **79/79**），`npm run typecheck` exit 0。

> 操作教训（已记入 §7）：`npm run build` 会先 `rm -rf dist/`，因此**变异注入期间必须独占构建**——本轮 M3 第一次注入因 `noUnusedLocals`（`changed` 变成未使用）导致构建失败并清空了 `dist/`，表现为"全部套件失败"的假象。已还原并复绿。

## 3. 已确认的实现违反

### 3.1 F-1（R15 计费口径）——已修复并复验

- **契约**：`maxVerificationBytes` 默认 10 GiB/操作，"按该操作清单涉及的文件字节总量计费，不按底层函数调用重置"。
- **修复前**：16 MiB 清单 + 32 MiB 预算被拒；阈值二分显示 94 MiB（5.88×）仍拒、96 MiB（6.00×）才过 → 计费约为清单总量的 **6 倍**（按内部核验读取次数累加）。
- **修复后**：同一用例 `completed`；超预算用例 `rchar` 增量 **16,781,020 → 308**（规划阶段一次扣减并拒绝，未读内容）。
- **证据**：`budget-accounting.log`、`budget-planning-refusal.log`。
- **保留性检查**：逐次快照硬上限、`sha256` 逐字节核验、提交前复核均未削弱——B2 证明预算内复制 `rchar ≥ 文件大小` 且目标摘要 = 源摘要；B4 证明发布后失败仍报 `committed=true` 且不回收已提交内容。

### 3.2 F-2（R17 `scope:'roots'`）——已修复并复验

- **契约**：roots 降级时 `bootstrap` 返回空根列表 + 该降级；文件操作以 `FILE_MANAGER_UNAVAILABLE`/503 拒绝。
- **修复前**：`bootstrap` 被 503 打掉（`{"code":"FILE_MANAGER_UNAVAILABLE","details":{"scope":"roots"}}`），前端无法区分"根授权不可用"与"Host 挂了"。
- **修复后**：bootstrap 200 + `roots: []` + `degraded.scope='roots'` + `capabilities` 全 false；`entries.list`/`text.read` 仍 503 + `details.scope='roots'`。
- **证据**：`degradation-roots.log`。

### 3.3 F-3（契约 §3.3 wire 码集封闭）——已修复并复验

- **契约**（Lead 裁定）：未映射的系统 errno 不得原样透传，归一为 `IO_ERROR`/500 并把原始值放入 `details.cause`；不新增码、不改 `HOST_ERROR_CODES` 的封闭语义。
- **修复前**：发布后持久化失败的项错误码为裸 `EIO`（wire 码成为开放集合，客户端只能退化成通用兜底文案）。
- **修复后**：`items[0].error.code === 'IO_ERROR'` + `details.cause === 'EIO'`，`details.committed === true` 与"已提交内容不回收"不变。
- **实现要点**：运行时归一（`normalizeError`）与投影期归一（`toPublicError`）两条路径共用同一张 errno 表与 `isErrnoCode`/`isUnmappedErrno`；持久化记录里的裸 errno（`ENOSPC → NO_SPACE`、`EIO/EXDEV → IO_ERROR` + `cause`）在投影时同样归一，历史日志不会在 wire 上重新开出开放码集。`docs/CONTRACT.md` §3.3 已写明两条路径。
- **证据**：`budget-failure-semantics.log`；契约侧新增用例含**变异验证**（关掉投影期归一立刻变红）。

### 3.4 F-4（R13 冷重开归一化幂等）——已修复并复验

- **要求**（Lead 强化裁定）：同一持久化快照连续打开两次，第二次必须零写入，且两次观察到的状态完全一致。
- **修复前**：
  ```
  open1 writes=1 open2 writes=1
  changes=[updatedAt: "2026-09-21T16:03:43.554Z" -> "2026-09-21T16:03:43.557Z"]
  ```
  每次打开历史都会重写记录并推进 `updatedAt`；`revision` 未漂移、关闭状态未复活、恢复证明未丢——不是数据损坏，但是不该发生的写入。
- **性质**（Lead 判定）：**移植回归**——legacy 在 `createTaskService({initialTasks})` 打开时只做内存内校验与默认值填充，不写盘；新实现在打开路径上多了一次持久化。
- **修复后**：
  ```
  snapshot item=failed/2 open1 writes=0 open2 writes=0 revision=2 changes=[]
  ```
  打开不再写盘（`changes=[]`），第二次打开零写入且状态一致；H1 语境的打开写入也从 1 降为 **0**（`writes on reopen=0 statuses=none`），而 H1 的三条语义保持不变（仍 `dismissed=true`、revision 不变、项错误码 `NOT_FOUND` 存活；重试后重新可见且 revision 递增）。
- **证据与复现**：`history-idempotence.log`、`history-cold-reopen.log`；最小复现脚本 `docs/verification/repro-reopen-write.mjs`；用例 `tests/verify-views-history.test.mjs` 的 H2。

### 3.5 过程噪音（不是未解决问题）

| 现象 | 归因 |
| --- | --- |
| 00:13 一次全量跑出现 3 条 `verify-client` 红 | **我自己正在改写该文件**造成的瞬时红（client-ui-2 用当时文件复跑为 7/7）；并发编辑期间的红不代表实现问题。 |
| 变异注入 M3 首次应用后"所有套件失败" | `npm run build` 会先 `rm -rf dist/`；M3 首版触发 `noUnusedLocals` 构建失败并清空 `dist/`，属**操作过程**假象。已还原、重建、复绿（§2.5）。 |

## 4. 记录项（不作为失败判据）

1. **读放大 ≈10×**：16 MiB 复制的 `rchar` 增量 ≈167.8 MiB（同一份字节在规划、复核、复制流、目标校验等步骤被反复读取）。已按 Lead 要求记入"已知限制"，不做降低校验强度的优化。
2. **超预算操作的读行为**：修复前会先读完整份文件再拒绝（16,781,020）；修复后由规划阶段拒绝（308）。"拒绝前不得读完"原本是我自加、比 spec 更严的标准，已降级为记录项。
3. **冷重开的写入（H1 语境）**：H1 序列中曾观察到打开写 1 次；独立复现同一记录状态时为 0 写，故当时未判为违反，而是用 H2 的确定性序列把真正的退化固定下来（即 F-4，现已修复：打开写 0 次）。
4. **发布后持久化失败的码**：修复前裸 `EIO`（F-3），修复后 `IO_ERROR` + `details.cause='EIO'`。
5. **`degradation-readonly` 的 `tasks.list`**：我的 fixture 未组装任务服务，因此该调用返回 **503 `FEATURE_UNAVAILABLE`**（而非降级专用码）。断言"不得以 200 + `[]` 表示不可用历史"成立，但**未能**在同一条里验证"降级时的历史码"——列为 §6 残余未验证项。
6. **下载的拒绝响应体**：无 cookie → 401（12 字节错误信封）、跨站 → 403（9 字节错误信封）；断言的是**零文件字节泄漏**（不是零字节响应），避免把错误信封误判为泄漏。

## 5. 计划修正：G3 的 `>4096` 为什么只能靠 oracle 覆盖

R18 还要求"根相对路径长度 >4096 的条目必须列为 `unaddressable`"。**该场景在 Linux 上不可构造**：条目相对路径 >4096 意味着绝对路径必然超过 `PATH_MAX`(4096)，`mkdir`/`open` 会直接 `ENAMETOOLONG`，真实 `readdir` 永远拿不到这样的相对路径（实测可创建到 ~3800 字符 / 92 层已是上限）。

因此 G3 拆成两半，且都覆盖：
- **集成侧**：验证可达的那一半——92 层 / 相对路径 3,771 字符，逐层 `entries.list` 200 且全部可寻址、最深文件可 `entries.stat`（`r18-deep-nesting.log`）。
- **分类侧**：`>4096` 的判定由 `tests/contracts.test.mjs` 的语法 oracle（`entryPathViolation`）单测覆盖，并配合结果侧不变量"`entries[].path` 必须可寻址"。

本报告明确写出这一点，以免读者误以为漏测。

## 6. 残余风险与未验证项

| 项 | 说明 |
| --- | --- |
| F-4 已修复复验 | 修复后 H2 零写入、H1 三条语义不变；同一断言会在"打开即改写"回归时重新变红。 |
| `operations` 降级下的历史码 | C1 用未组装任务服务的 fixture，只证明"不以空历史表示不可用"；未在同一路径验证降级专用码（见 §4.5）。 |
| `>4096` 分类 | 仅 oracle 单测覆盖（见 §5）。 |
| 2 GiB 单文件与默认预算的交互 | F-1 修复后按清单总量一次扣减，理论上 2 GiB 文件不再受 6× 放大影响；**未跑 2 GiB 实测**（成本过高），仅由 16 MiB 用例的比值与阈值推断，故不作为已通过项。 |
| Client 侧的构建时点 | `verify-client` 针对**已构建**的 `dist/client.js`；task-5 仍在进行，若 client-ui-2 后续落地改动，需复跑本套件（断言基于渲染属性与记录的请求，不依赖内部实现）。 |
| D3 的鉴权半边 | 无 cookie / 跨站拒绝由 **Connection 框架**提供（属部署依赖），我用真实 bridge 观测验证，但**未**对其注入变异（不在本仓范围内）；D3 的变异注入覆盖的是响应头/字节相等半边。 |
| 变异注入的独占性 | 注入期间必须独占 `npm run build`（会清空 `dist/`）；多人并行时需先协调。 |
| 真实 profile 存储 | 全部降级用例使用隔离桩（`storageStub`/临时目录），**未触碰**真实 `$DSH_HOME`。 |

## 7. 自查用例缺陷清单（测试错误，非实现违反）

保留此清单以区分"实现违反"与"验证者自身错误"：

1. bulk op（`tasks.start`/`tasks.retry`/`transfers.begin`）必须走 `/v2/manifest`，走 control 会 400（实现符合契约）。
2. `entries.stat` 会消耗核验预算 → 改用测试自算令牌 `dev:ino:size:mtimeNs:ctimeNs:sha256` 取得 `expectedVersion`。
3. 文本保存必须用**内容强版本**（`text.read` 的 `version`）；用列表弱令牌会 409 `VERSION_CONFLICT`。
4. "拒绝前不得读完"是我自加、比 spec 更严的标准 → 降级为记录项。
5. "取消排队任务后状态必须立即变 `cancelled`"是我自加的标准 → 改为可观测事实（cancel 立即 200 + `cancelRequested=true` + 释放许可后终态 `cancelled`）。
6. 测量区间内不得包含测试自身的哈希（B6 首次把 `readFileSync` 算进 `rchar`）。
7. 复制任务不 `sourceRemoved`（误按 move 断言）。
8. 服务层 `get`/`retry` 是 **async**，且 `await obj.get(x).field` 会被解析为 `await (obj.get(x).field)`，必须加括号。
9. `transfers.retry` 收**裸 id**，`tasks.retry` 收 `{taskId}`；且只有**失败**记录可 retry（完成的复制任务 → `NO_FAILED_ITEMS`）。
10. 冷重开基线必须在"关闭之后"取样，否则会把 retry/关闭的正常变更误判为"重写历史"。
11. H1 的写入计数断言曾把 1 次写入当作违反；独立复现同一记录状态得到 0 写，因此**先证明再判定**，改用 H2 的确定性序列固定真正的退化（F-4）。
12. Client C1 第一版把 `useSessions` 写成**普通函数**，React 报"hook 顺序变化"——那是我的桩不是 hook，**不是**实现缺陷；改为 `useSyncExternalStore` 建模后正常。若当时直接上报，就是一次误报。
13. Client 桩的能力字段名写错（`reference` vs 契约里的 **`references`**），导致引用动作恒为 disabled；属我的桩错误。
14. `verify-client-harness` 会安装进程级 `globalThis.fetch`/`window`，因此**两个 harness 不能同时存活**；R17 的降级/健康差分必须顺序执行（我第一版并行创建，导致健康桩抢走了降级请求）。
15. 会话选择器的 `<option>` 含一个空占位项，断言需过滤占位而非直接 `deepEqual`。
16. 变异注入时 `npm run build` 会清空 `dist/`；M3 首次注入触发 `noUnusedLocals` 构建失败，表现为"所有套件失败"的假象——已还原复绿，并记入 §2.5 的操作教训。

## 8. 复现方式

```bash
cd dsh-file-manager-ts
npm run build                     # 必须先构建：测试全部从 dist/ 导入
node --test tests/verify-metadata-boundary.test.mjs   # 14/14
node --test tests/verify-scheduler.test.mjs           # 5/5
node --test tests/verify-v2-boundary.test.mjs         # 9/9（D3 需要真实 DSH 运行时）
node --test tests/verify-views-history.test.mjs       # 9/9（含 H2 幂等）
node --test tests/verify-client.test.mjs              # 7/7（Client 侧独立验证，针对已构建产物）
node --test tests/contracts.test.mjs tests/package-identity.test.mjs   # 35/35
npm run typecheck                 # exit 0
npm test                          # 全仓基线：502/502、0 跳过、0 取消
```

最终交付时的实测：本报告套件 **79/79**（14+5+9+9+7+35），全仓 **502/502**，构建 `dist/` = 166,591 字节。

- 真实 Connection bridge（D3）复用 `tests/download-navigation.test.mjs` 的 fixture 写法；无 DSH 运行时的机器用 `FILE_MANAGER_DSH_RUNTIME_ROOT` 指定安装路径，否则该用例显式报告环境缺失而非静默跳过。
- 证据目录：`docs/verification/task6-{metadata,boundary,views,scheduler}/`。
- 所有测量遵循同一协议：同形基线扣除 + 重复 3 次取中位数；"必须不读"类断言只在 ≥16 MiB 文件上做。

## 9. 0.2.7：用户截图反馈后的粘贴弹窗修复

### 范围与实际改动

- 只调整粘贴弹窗：原生下拉框替换为现有 UI primitives 的 `Menu + Button`。菜单使用 `portal`，避免被内容滚动区裁切；圆角、悬停与选中标记使用共享主题菜单，未重做一套列表样式。
- 触发控件为一个原生 button，不再套用 select 的外描边；聚焦时只改变已有边框颜色。文件名、字段标签与控件分组留白，长名称允许换行。
- 仅显示文件名，不再展示源路径 → 目标路径、绑定版本折叠项与原始版本串。标签改为“重名处理”；选“改名”时展开“新名称”输入框。
- 使用单一菜单展开状态。Esc 在菜单打开时只关闭菜单，不向外层 Modal 传播；单纯开关菜单不提交任务。
- 复制、剪切、目标版本绑定、目录不合并等 Host 逻辑未改。既有的覆盖拒绝及目录改名测试只更换控件操作方式，保留文件内容/任务结果断言。

### 实际执行的验证

1. 新增 6 条粘贴 UI 回归，先在旧产物运行：**0/6 通过、6 条断言失败**，分别观察到原生 select、路径重复及主题菜单行为缺失；不是构建失败伪装的 RED。
2. 实现后运行粘贴 UI + 原有 Client + task-panel 套件：**85/85 通过**。
3. 最终串联执行 `npm run check && npm test && npm run pack:check`：**exit 0，505/505 通过，0 失败、0 跳过、0 取消**。构建 Client 176,040 字节，19 个 JS 产物解析通过。
4. 全量测试另外出现一条 `ReferenceDialog` 的 React “Each child in a list should have a unique key prop” 警告，位于独立 Client C1 验证中。该引用视图不在本轮修改范围；本次并非“完全无警告”运行，未将警告隐去。
5. 打包检查：**81 个条目**，Client 模块 id、Host VERSION 与原生助手可执行位通过；原项目的 **154 个基线校验和全部匹配**。

历史总数变化：502 项移除 4 条临时 legacy 差分用例后为 498，随后增加 1 条样式回归为 499，本轮增加 6 条为 505。

### 安装与页面验证边界

- 仅调用一次安装更新至 `@lolkda/dsh-file-manager@0.2.7`；结果 **enabled=true，application=restart-required**。
- 安装目录内的 Client 与通过测试的构建逐字节一致。保存成功不等于已在打开的页面上激活；没有将旧 slot 的存在当作新版已经渲染的证据。
- 本轮没有浏览器控制工具。组件测试使用明确的外部 primitive 边界，仅验证插件传给 Menu 的 props、状态/事件处理及真实 Host 操作，不用于证明 CSS 几何、实际焦点移动或截图外观。
- **仍需页面复验**：保存草稿并重启 DSH 后，在当前 GUI 打开粘贴菜单，检查展开列表不再是原生蓝色选项框、没有双层描边/滚动裁切，路径和版本串不再显示，并检查改名和 Esc 操作。
- 本报告前述大文件压力测试等未验证项保持未验证，本次小范围 UI 修复不会把它们自动转为通过。

```text
Package SHA-256:
f7ccde5829d32cbd67fd805b1db039d32418036acc356fbb58a4b1e2dfffc60b
Installed Client SHA-256:
528e2247ce1003d49c884c24d9fe59f62d7e64b53530ed39cbc06ef2d20de793
```

证据（**均为本机历史文件**：`artifacts/` 已被 `.gitignore` 忽略，仓库与 npm 包内不提供下载，路径为当时本机绝对路径；需要复核时在本机用 `npm pack` 与对应测试重新生成）：
- 粘贴 UI 红灯记录：`artifacts/ts-refactor/paste-ui/red.log`
- 全量检查、测试和打包记录：`artifacts/ts-refactor/paste-ui/check-test-pack.log`
- 0.2.7 安装快照：`artifacts/ts-refactor/dsh-file-manager-0.2.7.tgz`
