# 重命名直接兼容提交

## 1. 文档信息

- 文档标识：rename-direct-compatible
- 规格状态：已确认
- 最后更新：2026-11-14
- 实现状态：已实现
- 验证状态：通过
- 关联文档：[旧的 NFS 显式确认兼容重命名规格](nfs-compatible-rename.md)、[项目规格](../../SPEC.md)

## 2. 目标与范围

### 背景

旧规格要求：原子不覆盖失败后，先展示风险说明，用户勾选“我已了解”，再点击独立的“兼容重命名”按钮。现场 NFS 重命名因此需要额外阅读和二次确认。用户已明确要求去掉整段非原子提示、勾选和兼容按钮，重命名只使用“确认名称”。

### 目标

- 重命名对话框只保留名称输入、取消和“确认名称”。
- 单项重命名的第一次提交就直接授权 Host 在明确不支持原子不覆盖时使用普通 rename。
- 不显示兼容重命名提示、风险说明、勾选框或第二个提交按钮。
- NFS 上点击一次“确认名称”即可完成重命名。

### 非目标

- 不改变 Host 的优先顺序：仍先尝试原子不覆盖，只有文件系统被明确证明不支持时才走普通 rename。
- 不放宽复制、移动、上传、目录发布、暂存发布等其他操作；这些路径继续严格原子不覆盖。
- 不为其他操作增加全局兼容开关或持久授权。
- 不改变源版本校验、父目录身份校验、目标不存在复核、请求幂等和已提交错误语义。

## 3. 参与深度与委托

- 参与深度：功能与体验。
- 局部例外：无。
- 需要用户确认：重命名首次提交直接携带兼容授权（已确认）。
- 模型自主决定：协议字段保留方式、Client 状态清理、错误文案、测试迁移和具体实现。
- 当前执行授权：用户选择“新建独立草稿”并“先 Git 保存当前状态，再保存并开始开发”。Git 前置基线为 `b6b1ca4db0ed6f1b9d1e14d82d346e26292d411d`，工作树干净且与 `origin/main` 一致，无需新提交或推送。用户随后明确要求按 0.6.2 发布并安装，因此本次发布、推送标签和 profile 安装已获授权。

## 4. 行为要求与约束

### R-001：重命名对话框简化

- 参与者或触发方：用户在文件列表中选择一个文件、目录或符号链接并点击“重命名”。
- 前置条件与输入：写入能力可用，恰好选中一个可重命名条目。
- 必须满足的行为：对话框只显示标题、说明、名称输入、取消和“确认名称”。不得显示“无法保证原子不覆盖”提示、风险说明、“我已了解”勾选框或“兼容重命名”按钮。
- 输出或状态变化：名称编辑、取消、确认和错误展示沿用重命名对话框既有行为。
- 边界与失败行为：创建文件、创建目录继续使用同一对话框的既有简单形态；本规则不改变它们。

### R-002：首次提交直接授权兼容

- 参与者或触发方：用户点击“确认名称”或按 Enter 提交重命名。
- 前置条件与输入：对话框捕获了源条目的 `expectedVersion`，名称为单个合法路径段。
- 必须满足的行为：第一次且唯一一次重命名请求必须携带 `allowNonExclusiveRename: true`，使用新的 `requestId` 和对话框捕获的 `expectedVersion`。不得再出现第二次“兼容重命名”提交步骤。
- 输出或状态变化：Host 仍先执行 `renameat2(RENAME_NOREPLACE)`。原子不覆盖成功时行为与旧版本一致；文件系统明确不支持且错误详情标记 `compatibilityAvailable === true` 时，Host 按既有安全复核流程执行普通 rename。
- 边界与失败行为：Host 未证明文件系统可兼容时不得回退；helper 无法启动、权限错误、其他 errno、信号或 `ATOMIC_RENAME_UNCERTAIN` 都按原错误处理。

### R-003：错误与结果呈现

- 参与者或触发方：重命名请求失败，或重命名已提交但后续文档迁移/读取失败。
- 前置条件与输入：失败发生在本次重命名对话框内。
- 必须满足的行为：错误显示在重命名对话框内；不得重新出现兼容风险提示、勾选框或兼容按钮。`ATOMIC_RENAME_UNCERTAIN` 继续提示用户检查源和目标，避免重复操作造成误判。
- 输出或状态变化：成功仍记录普通“重命名”成功通知并刷新目录；失败保持对话框，允许修改名称或取消。
- 边界与失败行为：组件卸载后的持久请求失败继续进入通知历史，不伪造成功。

### R-004：范围隔离

- 参与者或触发方：任何非单项 rename 的文件变更。
- 前置条件与输入：复制、移动、上传、目录发布、暂存发布或任务重试。
- 必须满足的行为：这些操作不得携带或继承 `allowNonExclusiveRename`，继续使用严格原子不覆盖。
- 输出或状态变化：无变化。
- 边界与失败行为：文件系统不支持严格原子操作时仍明确失败，不自动普通 rename。

### 相关约束

- 普通 rename 仍是原子更名，但不能原子保证不覆盖：最后一次目标不存在检查后，其他进程或 NFS 客户端仍可能创建同名文件或空目录，并被普通 rename 替换。用户已明确选择首次直接授权，界面不再单独提示该并发窗口。
- 源版本、父目录身份、目标不存在、请求幂等和已提交状态继续由 Host 校验。

## 5. 关键决定

### D-001：首次提交直接兼容

- 状态：已确认
- 结论：所有单项重命名第一次提交即携带 `allowNonExclusiveRename: true`；Host 仍先尝试原子不覆盖。
- 理由：用户要求 NFS 重命名一次点击完成，不再经过额外兼容确认。
- 考虑过的备选：首次严格、失败后自动二次尝试；保持严格失败。
- 未采用原因：自动二次尝试不是用户选择的交互；保持严格失败无法完成目标 NFS 场景。
- 影响范围：R-002、R-003、AC-002、AC-003。

### D-002：移除兼容确认 UI

- 状态：已确认
- 结论：删除风险标题、风险正文、“我已了解”勾选和“兼容重命名”按钮，只保留“取消”和“确认名称”。
- 理由：用户明确要求去掉非原子提示、勾选和兼容名称确认。
- 考虑过的备选：保留轻量提示；保留成功后的提示。
- 未采用原因：均不符合“直接使用确认名称”的要求。
- 影响范围：R-001、R-003、AC-001、AC-004。

### D-003：Host 保持严格优先与范围隔离

- 状态：委托范围内决定
- 结论：协议字段 `allowNonExclusiveRename` 保留；Client 对单项重命名始终发送 true；Host 仍先原子尝试，只在明确不支持标记下回退；其他操作不继承。
- 理由：保留可验证的安全边界，避免把兼容 fallback 扩散到复制、移动、上传和发布。
- 考虑过的备选：Host 无条件自动普通 rename；删除协议字段。
- 未采用原因：会削弱原子保护并扩大风险范围。
- 影响范围：R-002、R-004、AC-003、AC-005。

### D-004：新建独立规格

- 状态：已确认
- 结论：新建本规格记录新行为；旧 [NFS 显式确认兼容重命名规格](nfs-compatible-rename.md) 保留其历史决策，只需标注本规格已取代其当前重命名交互要求。
- 理由：用户选择独立草稿，不改写旧规格正文。
- 考虑过的备选：直接更新旧规格。
- 未采用原因：用户选择独立文档。
- 影响范围：文档维护。

## 6. 验收标准

### AC-001：对话框没有兼容确认

- 对应规则：R-001、D-002
- 前置条件：选中一个文件并打开重命名对话框。
- 操作或输入：检查对话框。
- 预期结果：可见操作只有取消和确认名称；不存在兼容风险区块、风险标题、“我已了解”勾选框或兼容重命名按钮；确认名称默认可用（名称为非空合法值）。
- 验证状态：通过
- 验证证据：[客户端回归日志](../../artifacts/rename-direct-compatible/client-tests.log)：8/8 通过，其中 `the rename dialog has no compatibility UI...` 断言兼容 UI 完全不存在且确认名称可提交。

### AC-002：首次请求直接携带兼容授权

- 对应规则：R-002、D-001、D-003
- 前置条件：重命名对话框已捕获源版本。
- 操作或输入：点击一次“确认名称”或按 Enter。
- 预期结果：只发送一次重命名请求；请求包含 `allowNonExclusiveRename: true`、新的 `requestId` 和捕获的 `expectedVersion`；不存在不携带该字段的首次请求，也不存在等待勾选的第二次提交。
- 验证状态：通过
- 验证证据：[客户端回归日志](../../artifacts/rename-direct-compatible/client-tests.log)：`the rename dialog has no compatibility UI...` 与 `Enter submits...` 两项均断言首次请求携带 true、同一源版本，并且只发送一次；双提交用例仅产生一次请求。真实 GUI 临时热加载 0.6.2 构建后验证：对话框只有“取消/确认名称”，一次确认请求载荷含 `allowNonExclusiveRename: true`，文件成功改名；验证后已还原安装副本。

### AC-003：兼容文件系统一次点击成功

- 对应规则：R-002
- 前置条件：文件系统明确不支持原子不覆盖，Host 返回 `compatibilityAvailable === true`。
- 操作或输入：一次确认名称。
- 预期结果：Host 完成安全复核后执行普通 rename；旧名称消失、新名称存在；对话框关闭并刷新列表；没有额外兼容操作或提示。
- 验证状态：通过
- 验证证据：[Host 回归日志](../../artifacts/rename-direct-compatible/host-tests.log) 28/28 通过，覆盖文件、目录、符号链接及 ENOSYS/ENOTSUP/EINVAL 回退；[真实 NFS 探针](../../artifacts/rename-direct-compatible/nfs-probe.log) 在 `/mnt/beike` 临时目录返回 `atomic=UNSUPPORTED_ATOMIC_RENAME compatibilityAvailable=true` 后，`allowNonExclusiveRename: true` 一次调用成功，临时目录已清理。

### AC-004：不可证明的兼容失败不回退

- 对应规则：R-002、R-003
- 前置条件：helper 无法启动、权限错误、未知 errno、未知结果，或错误详情没有 `compatibilityAvailable === true`。
- 操作或输入：一次确认名称。
- 预期结果：不执行普通 rename；源保持不变；对话框显示对应错误；没有兼容按钮、勾选框或风险说明。
- 验证状态：通过
- 验证证据：[客户端回归日志](../../artifacts/rename-direct-compatible/client-tests.log) 的 `a helper that cannot start...` 与 `an uncertain outcome...` 两项通过；[Host 回归日志](../../artifacts/rename-direct-compatible/host-tests.log) 覆盖 helper 启动失败、信号、权限、未知结果及无标记错误。

### AC-005：其他操作保持严格

- 对应规则：R-004、D-003
- 前置条件：复制、移动、上传、目录发布或暂存发布遇到原子不覆盖不可用。
- 操作或输入：执行相应操作。
- 预期结果：继续失败，不携带 `allowNonExclusiveRename`，不自动普通 rename。
- 验证状态：通过
- 验证证据：[Host 回归日志](../../artifacts/rename-direct-compatible/host-tests.log)：共享 IO move 与目录发布在相同不支持文件系统上仍拒绝，不执行普通 rename。

### AC-006：错误与通知语义

- 对应规则：R-003
- 前置条件：重命名失败，或已提交后文档读取失败。
- 操作或输入：一次确认名称。
- 预期结果：失败留在重命名对话框；不确定结果提示检查源和目标；成功后记录普通重命名成功通知；卸载后持久失败进入通知历史。
- 验证状态：通过
- 验证证据：[客户端回归日志](../../artifacts/rename-direct-compatible/client-tests.log) 覆盖对话框内错误、不确定提示、成功刷新、草稿迁移及卸载后通知；[检查日志](../../artifacts/rename-direct-compatible/check.log) 显示类型检查、构建和 20 个产物解析通过。

## 7. 未决问题与假设

无。实现范围、回退方式和 UI 文案方向均已确认；具体错误文案由模型在实现中保持简洁、可理解，不重新引入兼容确认说明。

## 8. 技术设计

- `NameDialog` 删除 `compatibility` 属性和兼容风险区块，footer 仅保留取消与 `applyName`。
- `Panel` 删除 `nameRefusal`、`nameCompatibility`、`allowsNonExclusiveRename`、`nameCompatibilityOffer`；`submitName` 不再接收兼容布尔值。
- 单项重命名请求始终发送 `allowNonExclusiveRename: true`，保留 `expectedVersion` 和每次提交的新 `requestId`。
- `i18n` 删除 `renameCompatibilityTitle`、`renameCompatibilityRisk`、`renameCompatibilityAck`、`renameCompatibilitySubmit`；`error.UNSUPPORTED_ATOMIC_RENAME` 改为普通失败语义，`error.ATOMIC_RENAME_UNCERTAIN` 保留检查源与目标的要求。
- Host 协议字段和 manager 的安全复核逻辑保持不变；只调整 Client 调用方式和相关测试。
- 旧的 `rename-compatibility-client.test.mjs` 按本规格改写为“首次直接兼容、无兼容 UI”的回归套件；Host 兼容测试继续验证 true 授权下的安全回退。
