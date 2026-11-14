# NFS 显式确认兼容重命名

## 1. 文档信息

- 文档标识：nfs-compatible-rename
- 规格状态：已取代
- 最后更新：2026-11-14
- 实现状态：已实现
- 验证状态：通过
- 关联文档：[项目规格](../../SPEC.md)、[冻结契约](../CONTRACT.md)、[重命名直接兼容提交（当前行为）](rename-direct-compatible.md)

> 本规格的风险提示、勾选确认和独立“兼容重命名”按钮已被 [重命名直接兼容提交](rename-direct-compatible.md) 取代。正文保留为原显式确认方案的实现与验证历史；其中的源码行号和验证表是当时快照，不随后续代码变化更新。

## 2. 目标与范围

### 背景

现场 NFSv4.2 挂载可写，临时目录通过现有 manager 重命名返回 `UNSUPPORTED_ATOMIC_RENAME`/501，普通 `rename` 成功。测试目录已清理，用户原目录未改。前端缺少对应文案，显示通用 I/O 错误。

### 目标

用户选择需确认的 NFS 兼容模式：默认原子不覆盖，明确不支持时展示风险，单次确认后允许普通重命名。

### 非目标

不放宽复制/移动任务、暂存发布、保存或上传规则；不改挂载、权限或用户原目录；不实现跨客户端锁；不自动重启 DSH，构建不代表安装生效。

## 3. 参与深度与委托

- 参与深度：功能与体验。
- 局部例外：无。
- 需要用户确认：每次实际兼容重命名的风险；开发授权不是原目录操作授权。
- 模型自主决定：协议字段、实现和测试，不扩大降级范围。
- 当前执行授权：用户要求 Agent Team 修改、汇报文件行号，由 Lead review；保留已有 dirty 修改，真实挂载只用自建临时目录。

## 4. 行为要求与约束

### R-001：默认原子不覆盖

`entries.rename` 缺省/false 兼容授权仍使用 `renameat2(RENAME_NOREPLACE)`。明确不支持返回 `UNSUPPORTED_ATOMIC_RENAME`/501，不自动普通 rename。目标已存在拒绝，源不变。

### R-002：单次确认兼容

true 也先尝试原子调用；仅明确不支持时重新核验父目录、原先源版本和目标不存在，再对持有父描述符的叶子路径执行普通 rename。源变化、目标出现、权限错误、helper 启动失败或结果不确定不得被降级掩盖。成功沿用目录同步、结果读取和已提交后失败标记。

普通 rename 是原子更名，但不能原子保证不覆盖：最后检查后其他进程/NFS 客户端创建的同名文件或空目录可能被覆盖。确认前必须明确说明。

### R-003：逐次授权体验

仅本次单项 rename 的可兼容不支持错误显示风险、默认未勾选确认及独立“兼容重命名”按钮。普通确认/Enter 不授权兼容；未勾选或 busy 不可兼容。取消不提交；改名、重开、后续错误、提交后清除确认，不沿用到其他名称/条目。兼容请求使用新 requestId、原 expectedVersion，成功沿用草稿迁移和刷新。

### R-004：错误与路径隔离

中英文明确提示原子重命名不支持及结果不确定；未知结果要求先检查源/目标，无兼容入口。其他任务继续严格原子不覆盖，无全局开关或永久授权。

### 相关约束

沿用根/父目录描述符边界、源版本规则、请求幂等和已提交错误语义。普通 rename 不是全局锁，源版本复核不是内核 CAS。

## 5. 关键决定

### D-001：显式兼容

- 状态：已确认
- 结论：保留默认保护，仅单次确认后兼容。
- 理由：满足 NFS 需求并告知风险。
- 考虑过的备选：只修提示、自动回退。
- 未采用原因：前者不能完成重命名，后者静默削弱保证。
- 影响范围：R-001、R-002、R-003。

### D-002：仅 manager 单项 rename 降级

- 状态：委托范围内决定
- 结论：共享 helper 只报告明确不支持，不执行回退。
- 理由：任务/发布不能继承未经确认的降级。
- 考虑过的备选：共享 helper 回退。
- 未采用原因：扩大变更范围。
- 影响范围：R-002、R-004。

## 6. 验收标准

### AC-001：默认保护

- 对应规则：R-001、R-004。
- 前置条件：原子明确不支持。
- 操作或输入：缺省/false 授权。
- 预期结果：501 带可兼容标记，源在目标不在；中英文不是通用 I/O 提示。
- 验证状态：通过
- 验证证据：真实工作区 [完整回归日志](../../artifacts/nfs-rename-review/full-suite-final.log)（970/970、0 失败、0 跳过），其中包含对应协议、后端和客户端行为测试；涉及挂载行为另见 [真实 NFS 结果](../../artifacts/nfs-rename-review/nfs-probe.log)。

### AC-002：确认后成功

- 对应规则：R-002。
- 前置条件：原子不支持、源版本一致、目标不存在。
- 操作或输入：true 授权，文件/目录/符号链接。
- 预期结果：旧名消失新名存在，内容/链接目标不变；真实 NFS 临时目录完成拒绝→确认成功。
- 验证状态：通过
- 验证证据：真实工作区 [完整回归日志](../../artifacts/nfs-rename-review/full-suite-final.log)（970/970、0 失败、0 跳过），其中包含对应协议、后端和客户端行为测试；涉及挂载行为另见 [真实 NFS 结果](../../artifacts/nfs-rename-review/nfs-probe.log)。

### AC-003：复核与不适用降级

- 对应规则：R-001、R-002、R-004。
- 前置条件：确认期间/原子返回前源变化、目标出现、父目录替换，或 helper 失败/结果不确定。
- 操作或输入：true 授权。
- 预期结果：拒绝且不普通 rename；同步失败保留 committed；其他移动/发布严格；本地原子竞态不丢数据。
- 验证状态：通过
- 验证证据：真实工作区 [完整回归日志](../../artifacts/nfs-rename-review/full-suite-final.log)（970/970、0 失败、0 跳过），其中包含对应协议、后端和客户端行为测试；涉及挂载行为另见 [真实 NFS 结果](../../artifacts/nfs-rename-review/nfs-probe.log)。

### AC-004：界面隔离

- 对应规则：R-003、R-004。
- 前置条件：重命名对话框。
- 操作或输入：首次提交、不支持、未勾选/Enter、勾选兼容、改名、取消重开、busy、未知结果。
- 预期结果：仅勾选并点击兼容动作的后续请求带 true、新 requestId；其他步骤不复用授权；文案完整；成功刷新并保留草稿。
- 验证状态：通过
- 验证证据：真实工作区 [完整回归日志](../../artifacts/nfs-rename-review/full-suite-final.log)（970/970、0 失败、0 跳过），其中包含对应协议、后端和客户端行为测试；涉及挂载行为另见 [真实 NFS 结果](../../artifacts/nfs-rename-review/nfs-probe.log)。

### AC-005：协议与幂等

- 对应规则：R-001、R-002、R-003。
- 前置条件：控制协议。
- 操作或输入：缺省/false/true/字符串/null、重放、同 requestId 改授权。
- 预期结果：仅 boolean/缺省合法，字段到达 manager；重放复用回执；改授权要新 requestId。
- 验证状态：通过
- 验证证据：真实工作区 [完整回归日志](../../artifacts/nfs-rename-review/full-suite-final.log)（970/970、0 失败、0 跳过），其中包含对应协议、后端和客户端行为测试；涉及挂载行为另见 [真实 NFS 结果](../../artifacts/nfs-rename-review/nfs-probe.log)。

## 7. 未决问题与假设

无阻塞行为决策。Chrome 调试连接不可用，真实网页未验证；组件/API 测试不代替安装页面验证。当前安装来自打包快照而非源码软链接。

## 8. 技术设计

`POST /api/file-manager/v2/control` 的 `entries.rename` 沿用认证、rootId/path/name/expectedVersion/requestId 与 EntryStat 回执，增加以下契约。

| 字段路径 | 类型 | 必填/出现条件 | 可为 null | 默认行为 | 含义与约束 |
|---|---|---|---|---|---|
| allowNonExclusiveRename | boolean | 可选，仅 entries.rename | 否 | 缺省/false 严格 | true 授权本次并发覆盖风险，仍优先原子不覆盖 |
| error.details.compatibilityAvailable | boolean | 原子 helper 明确不支持 | 否 | 缺失不提供兼容 | 仅 true 且 UNSUPPORTED_ATOMIC_RENAME 可兼容，不是持久授权 |

helper 协议/参数不变，明确不支持 errno 增加标记；manager 检查授权并复核；UI 只使用本次 rename 自身错误。

### 工作分配

- rename-host：后端及后端回归。
- rename-client：界面、中英文及客户端回归。
- Lead：规格/契约测试，逐文件 review，统一构建/回归、真实 NFS 临时目录验证、团队文件行号报告。

## 9. Review 与验证记录

- Lead 对后端逐文件 review：只有已确认的单项 rename 可降级，共享 helper/移动/目录发布保持严格模式；控制接口布尔值与幂等边界已验证。
- Lead 发现并要求修正：同一测试反复 patch spawn 会按清理次序遗留 mock；现改为独立用例并主动检测残留。
- Lead 发现并要求修正：客户端模拟响应未传 HTTP status；重命名成功后的读取错误不能留存旧兼容授权；卸载后持久请求失败不能被局部错误处理吞掉；通用不支持提示不能指向不存在的兼容按钮。
- Lead 执行 `npm run build:host` 和协议/后端兼容/原子竞态/普通修改/API 写入回归：112/112 通过。
- 真实 NFS 使用 [临时目录验证脚本](../../artifacts/nfs-rename-review/probe.mjs) 与新构建控制处理器，三种条目均默认 501→确认 200；内容、链接与幂等回执保留；已有目标和陈旧源版本均 409。见 [NFS 日志](../../artifacts/nfs-rename-review/nfs-probe.log)。用户原目录未改，临时目录已清理。
- root 会绕过 chmod 0500，导致 3 个既有任务权限用例失败；未修改或跳过测试，Lead 使用 UID 1000 重跑 33/33 通过，见 [权限回归日志](../../artifacts/nfs-rename-review/tasks-unprivileged.log)。
- Lead 完整执行 `npm run build`（含 Host/Client TypeScript 检查）、`npm run check:dist`（20 个产物解析通过），并统一真实树回归。首次 UID 1000 运行暴露新增测试被写成 root:root 0600，已将本次新测试/规格/验证脚本设为仓库常规 0644；未改变测试断言。最终命令 `setpriv --reuid=1000 --regid=1000 --clear-groups node --test --test-concurrency=4 tests/*.test.mjs`：970/970、0 失败、0 跳过，见 [完整回归日志](../../artifacts/nfs-rename-review/full-suite-final.log)。
- `git diff --check` 通过。Lead 已 review 两位成员的全部生产改动与新回归；发现的问题已修正后重新构建验证，无本次范围内未解决的阻断问题。开发验收当时尚未更新已安装插件、未验证真实网页；后续安装状态见 §11。始终不声称并发原子不覆盖。

## 10. 团队改动报告

以下为本次改动的最终行号（不是整个 dirty 工作区的 diff）。两位成员均已交付文件级报告，Lead 已独立读取实现、检查修复及运行集成测试。

| 成员 | 文件与行号 | 修改方式 |
|---|---|---|
| rename-host | [atomic-rename.ts:4、56–84](../../src/host/atomic-rename.ts#L56-L84) | 仅明确不支持 errno 加可兼容标记；新增严格错误判定函数；不在共享 helper 回退 |
| rename-host | [manager.ts:551–606](../../src/host/manager.ts#L551-L606) | 布尔授权校验；优先原子，只有明确授权和不支持时复核父目录/源版本/目标后普通 rename；保留提交后错误语义 |
| rename-host | [http.ts:171](../../src/host/http.ts#L171) | 传递单次兼容授权；复用请求指纹与幂等层 |
| rename-host | [protocol.ts:270–278](../../src/contracts/protocol.ts#L270-L278) | 新增可选 boolean 字段，缺省严格，拒绝非布尔 |
| rename-host | [rename-compatibility-host.test.mjs:1–596](../../tests/rename-compatibility-host.test.mjs#L1-L596) | 新增 596 行、28 用例，覆盖源/目标/父目录竞争、helper 异常不降级、文件/目录/链接、提交后失败、协议/幂等及其他路径隔离 |
| rename-client | [panel.tsx:141–153](../../src/client/panel.tsx#L141-L153)、[254–260](../../src/client/panel.tsx#L254-L260)、[1104–1194](../../src/client/panel.tsx#L1104-L1194)、[1312–1318](../../src/client/panel.tsx#L1312-L1318)、[1578–1584](../../src/client/panel.tsx#L1578-L1584) | 隔离展示错误、rename 拒绝与确认；同步防双提交；新 requestId+原版本；修改/取消清授权；后续读取与卸载失败不丢失 |
| rename-client | [dialogs.tsx:117–175](../../src/client/dialogs.tsx#L117-L175) | 独立兼容按钮、风险说明、默认未勾选确认；Enter/普通按钮保持严格 |
| rename-client | [i18n.ts:50–53](../../src/client/i18n.ts#L50-L53)、[113–114](../../src/client/i18n.ts#L113-L114)、[155–158](../../src/client/i18n.ts#L155-L158)、[218–219](../../src/client/i18n.ts#L218-L219) | 中英文风险和明确不支持/结果不确定提示；不承诺不存在的兼容入口 |
| rename-client | [rename-compatibility-client.test.mjs:1–472](../../tests/rename-compatibility-client.test.mjs#L1-L472) | 新增 472 行、13 用例，覆盖逐次确认、Enter、双击、错误隔离、草稿与刷新、后续读取/卸载失败及文案 |
| Lead | [contracts.test.mjs:419–435](../../tests/contracts.test.mjs#L419-L435) | 新增 18 行、2 项契约回归：授权类型和错误详情隔离；已观测旧实现失败、新实现通过 |
| Lead | [SPEC.md:55](../../SPEC.md#L55)、[170](../../SPEC.md#L170) | 明确用户确认的 R6.1 单项例外并对齐历史说明 |
| Lead | [CONTRACT.md:261–267](../CONTRACT.md#L261-L267) | 固化请求字段、错误详情和幂等边界 |
| Lead | [README.md:181](../../README.md#L181) | 同步使用步骤、并发覆盖风险与不支持降级的情形 |
| Lead | [本规格](nfs-compatible-rename.md) | 记录共识、验收、review 修复与团队文件报告 |
| Lead | [probe.mjs:1–81](../../artifacts/nfs-rename-review/probe.mjs#L1-L81) | 可重放的真实 NFS 临时目录控制接口验证；路径核验后清理，不触碰原目录 |

上述开发阶段只更新了工作区生成产物，未安装、未执行 git commit；用户随后要求安装，最新状态如下。

## 11. 实际安装记录（2026-10-15，只安装不重启）

用户反馈仍失败后，核实 web profile 仍引用旧快照，已安装前后端哈希均与修复构建不同。用户明确选择“只安装，我稍后手动重启”，因此此次没有重启 DSH。

- 已通过官方 `dsh plugin --profile web add` 安装修复 [快照包](../../artifacts/install-nfs-compatible-IhREMv/lolkda-dsh-file-manager-0.6.0.tgz)，使用 `--offline --ignore-scripts`，命令退出码 0。安装引用已持久化到 web profile。
- 新包 SHA-256：`8420378d5c253fc3261e6c5114fce596985b5b6b298401f9b650307394d79a8d`。
- 旧插件及 profile 安装信息已备份到本次安装产物目录的私有 backup 子目录。其余声明的插件、bundle 列表、用户 patch 与 pnpm workspace 设置未变化。
- 已逐项校验实际安装的 Client、manager、atomic-rename、HTTP、protocol 与 native helper，均与已验证构建哈希一致，见 [安装校验](../../artifacts/install-nfs-compatible-IhREMv/installation-verification.json)。
- 使用**实际安装目录**导入的代码在独立进程复测：NFS 文件、目录、链接均严格 501→确认 200，重名/陈旧源仍拒绝且内容保留，见 [安装后 NFS 日志](../../artifacts/install-nfs-compatible-IhREMv/nfs-installed.log)；已安装包后端回归 28/28 通过，见 [安装后测试日志](../../artifacts/install-nfs-compatible-IhREMv/installed-host-tests.log)。测试未触碰原目录，临时目录已清理。
- DSH PID 1 启动时间仍为 `2026-10-14 21:02:12`，明确没有重启。以上证明磁盘安装产物正确，**不表示运行中旧进程已加载新代码**；尚未进行重启后的实际网页验收。

用户后续步骤：保存草稿 → 手动重启 DSH → 刷新网页 → 再次重命名。NFS 首次严格提交仍可能提示无法原子不覆盖，此时阅读风险、勾选确认并点击独立的“兼容重命名”，而不是重复点击普通确认。

