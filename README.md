# DSH 文件管理器 V1

独立于会话的 DSH Web 文件管理面板。以 profile bundle 安装，不修改官方 preset，不替换应用根或会话面板。

## 当前版本与验证状态

当前适配版为 **0.5.0**，面向 DSH **0.1.7-rc.1**。本代次将永久删除改为“所选目录整体删除”：准备不再扫描后代或受子树 10,000 条目上限限制，确认期间新增或修改的目录内容也在删除范围内；Client/Host 通过 `scope: 'selected-trees'` 同步确认语义，其余保存、覆盖和传输强校验不变。0.4.0 的主题上传确认与 0.3.0 的内联语法高亮继续保留。**发布与安装状态不在仓库内声明**——本仓库不记录 registry 发布结果，也不记录安装到某个 DSH 实例的结果，公开状态以 [npm registry](https://www.npmjs.com/package/@lolkda/dsh-file-manager) 为准。开发期验证记录：类型检查、构建与 **728 项回归（0 失败 0 跳过）**，另含真实多小文件目录删除、竞态与部分失败验收；真实完整页面的键盘/输入法与像素滚动仍未验收。下方保留旧版本验证记录。

- GitHub 基线版本：**0.2.8**（TypeScript 结构性重构代次）。本代次在**独立副本** `dsh-file-manager-ts/` 中进行：原始项目 `dsh-file-manager/` 全程只读，不在其中运行测试、构建或修改文件。0.2.8 发布前已重新通过 `npm run check`（类型检查、构建与产物语法检查）、`npm run build:native` 与全量 **518 项测试（0 失败、0 跳过）**；公开发布状态以 [npm registry](https://www.npmjs.com/package/@lolkda/dsh-file-manager/v/0.2.8) 为准。
- 重构前的副本基线（改动前实测）：`npm test` **329/329 通过、0 跳过**，`npm run check` 与 `npm run build:native` 通过。该基线是本次重构的等价性红线。
- 0.1.4 发布快照：`artifacts/local-dsh-file-manager-0.1.4.tgz`，SHA-256：`96a7c542331d81c860a002ce9be8ea5f27103d87fb70ca3423170162b182bce1`。
- 0.1.3 安装时返回 `restart-required`；用户后续截图已显示默认 `/` 与文本预览，并发现旧下载记录缺少关闭入口。该版实际安装模块通过 4 项 HTTP 与 4 项 Storage 回归。本次 0.1.4 的安装保存与运行时激活单独核对。
- 0.1.3 快照：`artifacts/local-dsh-file-manager-0.1.3.tgz`，SHA-256：`82abb194a7d40458ab30192b5b33c1f02af1cec01b0258bbd32b19b8eda3f062`。解包快照通过 63 项 Client/HTTP/Storage 回归；对比确认所有 `host/` 文件与 0.1.2 相同，本次仅修改入口请求适配和前端行为。
- **0.1.0 已撤回，不应再启用。** 用户重启时暴露 `invalid unit name 'local-file-manager'`；之前 235 项测试没有覆盖真实存储后端命名校验。这是插件缺陷，不是目录数据损坏。
- 0.1.1 阶段先恢复包引用并停用故障版，再安装启动修复包；随后用户的实际页面截图确认新版界面已经显示。
- 用户最新截图确认 0.1.2 的重复选择文案已消失，随后暴露下载失败、默认路径和删除提示问题。0.1.3 的实际安装/激活结果单独核对，测试通过不替代页面加载确认。
- 0.1.2 快照：`artifacts/local-dsh-file-manager-0.1.2.tgz`，SHA-256：`531f76445c7133649f490aba0c8f6104e1cb907cae20f772130a1d3c2ef5d7e7`。打包后 5 项 UI 与 4 项真实存储回归均通过；与 0.1.1 比较确认所有 Host I/O 实现字节未变，Host 入口仅更新版本号。
- 0.1.1 的解包快照及实际安装目录均以 `agent (1000:1000)` 在新 Node 进程中通过 4 项真实后端回归。安装快照：`artifacts/local-dsh-file-manager-0.1.1.tgz`，SHA-256：`9a1aa07df33282ea0a137876c162aad0ce2ca9957e629acb5caaacdf5284627f`。
- 以上 `artifacts/**/*.tgz` 与 `artifacts/ts-refactor/` 下的日志均为**本机历史快照与证据文件**（`artifacts/` 已被 `.gitignore` 忽略），仓库与 npm 包内**不提供下载**；需要复核时在本机用 `npm pack` 与对应测试重新生成。

### DSH 0.1.7-rc.1 兼容修复

- 新版 DSH 不再提供 `SettingsProvider.register/get`。资源限制改由插件导出的 `Config` schema 校验，并通过 `local-file-manager` bundle entry 的 `config:` 传入；不配置时保留全部原默认值。
- 修复旧版初始化异常被降级路径捕获、导致面板看似加载但文件功能不可用的问题。根授权、任务日志的存储单元和数据格式不变，Client 的面包屑与文件操作逻辑不变。
- 新增 10 项配置回归；修复后已在 `0.1.6-alpha.2` 与 `0.1.7-rc.1` 的真实 Connection/Storage 运行时各通过 528 项测试。完整 Web 组合的冷启动和页面结果由安装态验收另行记录。
- 已有旧 `settings.yaml` 中的 `local-file-manager` 限制值应在升级前迁入同名 entry 的 `config:`。新版原生 Settings 自动导入只接受 volatile 字段，而这些启动期限制是普通 Config 字段；不能把导入警告当成成功。此次部署未发现该旧段。

### 0.5.0：多小文件目录整体删除

- 删除准备只检查所选目标及父路径，不再递归扫描子树；`entryCount` 仅统计去重后的所选目标，目录内超过 10,000 个条目不再导致清单超限。
- 按用户明确选择，确认后删除所选目录及其全部内容，**确认期间新增或修改的内容也在删除范围内**。单独选中文件的元数据冲突检查、所选目录及父目录身份、授权根、符号链接、确认期限与幂等保护继续保留。
- 实际删除使用逐层持有目录描述符的遍历，文件 I/O 有界并发，每个变化目录批量同步；不读取文件内容或计算哈希，也不通过无条件 `fs.rm` 绕过链接边界。失败可已有部分内容删除，回执会区分所选目标已移除与子树已有变化；草稿仍保留。
- **Client/Host 需同步升级**：计划和提交都携带 `scope: 'selected-trees'`。旧 Client 不携带 scope 的提交会被拒绝，不能按旧文案误删整个目录。构建不等于运行中 GUI 已更新；仍需按安装流程加载新代次并刷新原页面。
- 本修订验收：`npm run check` 通过（20 个 JavaScript 产物）；使用实际 DSH 0.1.7-rc.1 的两个运行时根变量运行完整 `npm test`，**728/728 通过，0 失败、0 跳过**。新增 45 项后端、协议、竞态/故障和 UI 回归，原有删除测试按已批准语义迁移，其余内容强校验保持。
- 独立临时根复测两次：10,000 个空文件另加一个 socket 的目录，准备 **2 / 3 ms**、实际删除 **2729 / 3308 ms**，未选兄弟保持不变；另有 12,000 个空文件目录的真实删除回归。复测命令：`node --test --test-name-pattern='a directory holding more than 10000 entries' tests/delete-metadata.test.mjs`。这些是本机测量，不是任意磁盘、深度或规模的耗时保证。
- 本修订的完整规则见 [SPEC.md](<SPEC.md>) R7；下方 0.4.0 的清单限制和测试计数是历史基线，不代表本修订的行为或验证结果。

### 0.4.0 增量契约：上传确认与元数据删除清单（历史基线）

- 上传策略使用主题 Portal 菜单，触发按钮不绘制外圈描边；焦点和展开状态使用主题背景/文字提示。文件名、策略和改名输入纵向排版，长名称及多项内容不能撑偏弹窗；底部操作使用标准按钮尺寸。
- 永久删除准备和提交都使用元数据与目录成员清单，不读取文件内容、不计算 SHA-256。确认、取消、过期、变更检查、链接边界及部分失败语义保留；保存、覆盖、传输与跨卷移动删源的内容核验不变。
- 删除仍有目录枚举与文件系统操作成本，仍有 10,000 条目上限；不承诺任意规模目录瞬时完成。上述契约的源码、自动测试和真实页面验收须分别记录，不能把本地构建成功当作当前 GUI 已加载修复。
- 本次工作区验证：`npm run check`（类型检查、构建、19 个 JavaScript 产物语法检查）通过；在真实 DSH 0.1.7-rc.1 运行时路径下完整 `npm test` **683/683 通过，0 失败、0 跳过**。新增上传回归见 [upload-ui.test.mjs](tests/upload-ui.test.mjs)，删除元数据与限额回归见 [delete-metadata.test.mjs](tests/delete-metadata.test.mjs)。
- 上传浏览器验收：默认明暗主题 × 1280×800 / 800×464 / 600×464 / 600×360 × 单文件/长名称多文件，共 **16 组**通过；检查了真实类名、标题/描述可见性、无外圈描边且可见的键盘焦点、36px 操作按钮、卡片居中与菜单 Portal/末行/Escape 行为。该隔离组件夹具不代表某个运行中 GUI 已安装修复。
- 在独立临时根中对同一份 16 MiB 稀疏文件复核，安装态基线准备/提交的 `rchar` 增量为 16,779,679 / 33,559,189 字节，修复构建为 186 / 296 字节（包含观测自身开销）。这说明删除不再全量读取文件内容，不是物理磁盘流量或耗时 SLA；保存、覆盖与传输强校验未被裁剪。

### 0.2.8 深路径面包屑修复

- 深路径挤压已修复：路径栏保持单行，完整面包屑只在面包屑区域内横向滚动，刷新控件不再被压缩，列表与预览列也不被撑宽；每一级目录名不换行、不收缩、不折叠为省略层级，导航、禁用与错误语义不变（见 [SPEC.md](SPEC.md) 的 R20 与验收第 11 条）。
- 新增 13 项路径栏回归：真实渲染结构与产物实际输出的样式声明契约，以及真实 Host 上的导航、禁用与错误控制流。在 0.2.7 基础上加入这 13 项后，全量套件 **518 项通过**（真实运行，0 失败）。
- 用户已在真实页面确认该修复效果良好。
- 仍未验证：1620×900 / 1000px / 600px 三档宽度下的路径栏表现与键盘操作；真实 2 GiB 文件与 10,000 条目压力测试。**自动化发布前验证已通过，不替代上述真实页面与压力验收。**

### 0.1.4 任务记录关闭与折叠

- 已完全停止的复制/移动/上传/下载卡片显示 **× 关闭**，任务栏提供 **清理已结束** 与 **折叠/展开**；失败记录不会自动消失。
- 关闭仅持久化当前 profile 的隐藏标记，不删除文件、任务结果或私有恢复证明。刷新及 Host 冷重启不会使同一轮记录复活；明确重试会重新显示。
- 排队、运行、流收尾、取消尾部保存和重试/关闭过渡中的记录不能关闭。折叠保留活动数，面板、监听、编辑器草稿和传输运行时继续存在。
- 单条及批量关闭通过同一认证控制接口，按点击时的候选逐项处理、每批最多 256 项；保存失败或任务已变化的项保留并显示错误，其他成功项可关闭。
- `historyRevision` 随成功关闭/重试递增；前端拒绝旧快照和旧回执覆盖新一轮状态。完整 raw journal 保留，派生 `canDismiss` 不落盘；元数据保存成功后才发布关闭结果。
- 已验证 19 项复制/移动历史、19 项传输历史、17 项任务区组件/真实服务回归，以及新增 API/JSON/HTTP 检查；包含真实 Cookie 401/403、不取消排队任务、冷重开保持关闭和持久化失败后的可见性。
- 本版不新增历史管理页、自动清空策略或断点续传。真实页面上的按钮/折叠布局仍需新版本激活后在原 GUI 核对。

### 0.1.3 默认路径、下载与确认修复

- 添加目录默认固定为 `/`。工作区候选只供主动选择，bootstrap 不再覆盖默认值或用户已输入的路径；不会自动授权 `/`。
- 原生下载 GET 配置为无流式请求体的 `buffered` 模式，**响应文件仍逐块流式输出**。旧配置使真实 Connection 桥接抛出 `Request with GET/HEAD method cannot have body`，尚未进入下载处理器，所以任务一直排队；该错误已用实际安装的 0.1.2 模块复现。
- 文本读取统一走现有控制操作 `text.read`；`/api/file-manager/text` 仅接收 POST 保存，保存和上传仍使用流式请求体。没有通过关闭鉴权或全量缓存大文件绕过问题。
- 永久删除立即打开准备/预览对话框，展示准备失败并允许取消。完整清单、人工勾选和确认缺一不可；取消中止准备，代次检查防止迟到结果重开或旧确认回调触发删除。
- 左侧“×”改为移除入口确认，明确说明不删除磁盘数据。取消保留根授权和文件。
- 新增 HTTP 测试加载部署中的真实 Cordis、Connection、签名 Cookie 鉴权和 JSON Storage，在测试自有临时监听端口验证文件字节、ZIP 层级/空目录、完成状态、401/403及流式大保存。它不是替代 GUI，也不读取用户登录凭据。
- 用 `FILE_MANAGER_TEST_PACKAGE_ROOT` 可让同一 HTTP 测试加载实际安装目录的生产模块；测试用解码器等开发依赖仍来自工作区。安装后的新页面布局及浏览器落盘结果仍需在原 GUI 核对。
- 更新后请从文件管理器重新发起下载，不要依赖浏览器旧失败记录的“继续”；本版没有断点续传，旧任务在 Host 重启后可能标为中断，源版本变化时需要重新规划。

### 0.1.2 界面修复

- 文件行改为紧凑复选框列与文件名列；“选择：文件名”仅保留为 `aria-label`/悬停提示，不再作为第二份可见文件名挤占行宽。原生键盘选择和多选行为保留。
- 新建文件、目录、重命名及冲突改名字段使用公共 UI `Input`，不依赖主面板祖先样式。
- 每个 Modal 通过公共 `contentClassName` 获得自己的 `dsh-fm-dialog` 作用域；名称标签与输入框纵向排列，表单控件填满可用宽度。
- 永久删除的确认复选框仍保留可见风险说明，没有全局隐藏所有 Checkbox 标签。
- 本次没有改变文件 I/O、持久化、覆盖、删除或传输逻辑。

### 0.1.1 启动修复

- Settings 名称继续使用 `local-file-manager`；Storage 单元改为合法的 `local_file_manager` 和 `local_file_manager_operations`。两者的命名规则不同。
- 使用实际 `BackendRegistry`、`JsonStorageBackend`、`DomainFacility` 复现同一错误后修复，覆盖根登记、任务/传输恢复证明、完整 Host apply、关闭后冷重开。
- 存储初始化失败时关闭已打开的资源，保留原始元数据并返回 `503 FILE_MANAGER_UNAVAILABLE`，不开放文件写操作，也不再将该异常抛出以阻断整个 DSH 启动。
- 故障在真实后端校验描述符时发生；修复不删除用户目录、不清空或伪造授权状态。
- 存储集成测试默认使用当前 DSH 安装位置；其他环境可设置 `FILE_MANAGER_DSH_RUNTIME_ROOT` 指向 DSH 包根目录。

完整行为约束见 [SPEC.md](SPEC.md)。

## 已实现

- **独立主面板**：根入口、目录分页、面包屑、文本预览与编辑，无需先打开会话。
- **根授权**：工作区候选和显式输入的 Host 目录；根登记持久化。移除入口不删除磁盘目录，也不扩大 Agent 权限。
- **文件操作**：新建文件/目录、重命名、永久删除。删除准备只核对所选目标与父目录；确认绑定目标身份、单独选中文件的元数据和确认期限。需要人工明确勾选并确认，目录内全部内容（含确认期间新增/修改）在范围内；准备不扫描子树，执行不读取文件内容。
- **草稿保护**：切换主面板保留草稿；关闭时保存/放弃/取消；外部修改显示冲突，外部删除不自动重建文件。保存回包不会抹掉请求期间的新输入。
- **复制/移动**：多选与复制/剪切/粘贴，逐项结果、取消、失败重试。同名文件可跳过/改名/显式覆盖，目录不隐式合并。
- **传输**：文件及目录上传，原始文件下载，目录流式 ZIP；上传 ZIP 不解压。保留空目录需要浏览器的原生目录句柄选择器。
- **刷新**：真实 OS 监听加定期校准；SSE 推送失效和任务进度，断线、降级及重同步明确显示。
- **引用**：选择既有会话，按 `draftRev` 追加绝对路径引用，不重建整份草稿、不自动发送。忙碌、失效或 CAS 拒绝时保留请求供人工重试。

## 安全与数据边界

- Linux I/O 通过持有的目录描述符逐层访问，检查根和父目录身份，不跟随符号链接读取或写入。链接自身可以重命名/删除；复制和 ZIP 遇到不支持条目会明确失败。
- 列表与永久删除准备使用轻量元数据。删除准备仅记录所选目标及父目录身份，目录绑定 `dev/ino/type`，单独选中文件/链接仍核对 `size/mtimeNs/ctimeNs`；不扫描后代、不读取内容、不计算 SHA-256，也不受 `maxVerificationBytes` 限制。保留所选目标数上限、确认期限和路径/根/链接保护，不再建立后代逐项快照。普通文件的显式版本读取、保存、覆盖、传输及跨卷移动删源继续使用内容强校验；弱元数据版本不能授权覆盖。
- 无覆盖重命名和目录发布使用 Linux `renameat2(RENAME_NOREPLACE)`。内核/文件系统不支持时拒绝操作，**不回退**到有竞争漏洞的“检查不存在再普通 rename”。
- 跨卷移动先完成复制、验证和发布，再逐项删源。每项删除前重新核验对应目标强版本及父目录身份；证明缺失、目标消失或改变时保留剩余源。
- 正常取消、断线和卸载会清理未提交暂存；已经提交的项不会伪装回滚。进程非正常终止不承诺无残留或断电事务恢复，中断任务不会自动重放。
- 删除是永久删除，没有回收站。禁用/卸载插件不能撤销已经确认的磁盘操作。
- 原子无覆盖、版本检查和有界快照不等于对任意外部写进程的全局锁或内核内容 CAS；目录复制/ZIP 不承诺事务快照。

## 默认限制

| 项目 | 默认值 |
| --- | --- |
| UTF-8 编辑 | 5 MiB |
| 单文件传输 | 2 GiB |
| 单任务文件 payload | 10 GiB |
| 单任务条目 | 10,000 |
| 传输/指纹规划并发 | 2 |
| 目录校准间隔 | 2 秒 |
| 删除确认有效期 | 5 分钟 |
| 删除所选目标数 | 10,000（不限制所选目录的后代数） |
| 删除叶子 I/O 并发 | 8（每个变化目录批量同步） |
| 修改请求重试窗口 | 10 分钟，最多 256 条 |
| 小控制请求 / 大清单请求 | 256 KiB / 16 MiB |

资源限制由 `local-file-manager` entry 的 `config:` 配置，插件导出的 `Config` schema 补全缺省值并拒绝越界值；不再注册独立 Settings namespace。这些启动期限制在插件重新挂载后生效。Profile patch 的 `config:` 覆盖是完整对象替换：保留所有希望继续生效的自定义字段，省略的字段会恢复 schema 默认值，并非必须手工填写全部 8 项。ZIP 元数据开销另计入 `wireBytesTransferred`；服务端流完成不表示浏览器已将文件写入磁盘。

## 环境与构建

本发布包面向当前 **Linux x64 / Node 24+** Host。包内带原生无覆盖重命名助手及其 C 源码；不设置自动安装脚本。

0.2.0 起源码为 TypeScript，位于 `src/`：Host 半边由 `tsc` 编译为真实 ESM JavaScript 到 `dist/`，Client 半边由 esbuild 打包为 `dist/client.js`，并包在 DSH 要求的 `window.__ModuleLoader__.load({ id: "<包名>", factory })` 外壳中。**发布产物是编译后的 JavaScript，不依赖 Node 在 `node_modules` 内直接运行 TypeScript。**

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build:native
npm run build        # tsc 编译 Host + esbuild 打包 Client 到 dist/
npm run typecheck    # 仅类型检查（Host + Client 两套 tsconfig）
npm run check        # typecheck + build + 对 dist/ 每个产物做 node --check
npm test             # 测试从 dist/ 导入被测实现
```

`npm run build:host` 只编译 Host 半边，便于在 Client 尚未就绪时分阶段验证。

`build:native` 使用系统 `cc` 显式编译。不要在助手缺失、不匹配或不支持时以普通 rename 代替。

`tests/runtime-storage.test.mjs` 与 `tests/download-navigation.test.mjs` 针对**真实部署的 DSH**运行，默认从 `/usr/local/lib/node_modules/@deepseek-ai/dsh` 解析，可用 `FILE_MANAGER_DSH_RUNTIME_ROOT` 指向别的安装。找不到运行时时它们会**明确跳过并打印原因**，不再让整个文件在导入期崩溃；CI 会安装 `@deepseek-ai/dsh@0.1.6-alpha.2` 并断言其可解析，因此 runner 上跑的是完整覆盖而不是静默跳过。

## 安装与升级

使用 DSH 的 `plugin_manager` 安装本包或打包快照，不手工修改 profile 的安装结果。正式更新建议使用打包快照，避免继续依赖开发目录的动态链接。

安装后分别核对保存状态、Host 激活结果、Client 注册和实际页面。**替换已加载的包需要重启以加载新的 JavaScript 模块代次**；`restart-required` 不是已上线。无需启动另一台 Web 服务器，目标仍为现有 http://127.0.0.1:3080。

从 P0 升级时，旧的根登记仅存在于旧进程内存，可能需要重新添加一次。V1 的根和任务恢复记录使用 DSH storage domain，任务私有恢复证明不会被公共 DTO 剥掉。

### 包身份改名（0.1.4 起）

npm 包名已从 `@local/dsh-file-manager` 改为 **`@lolkda/dsh-file-manager`**，以支持标准发布。改名只触及**包身份**（npm 名、bundle patch 的 `name`、`client.js` 的模块 id）；**运行时命名空间与 unit id 保持 `local-file-manager` 不变**，否则会重演 0.1.0 的存储命名事故，并让已保存的设置与 storage domain 失联。`tests/package-identity.test.mjs` 锁住这条边界。

改名后，profile 里那份旧名 `@local/dsh-file-manager@0.1.4` 的安装是磁盘上的独立副本，**不会自动跟随**改名；要采用新身份需用 `plugin_manager` 移除旧包再安装新包，结果为 `restart-required`，重启 DSH 并刷新页面才生效。该替换已经执行：当前 profile 安装的是新身份 `@lolkda/dsh-file-manager@0.2.7`（`enabled=true`，安装器返回 `restart-required`，记录见 [docs/VERIFICATION-REPORT.md](https://github.com/lolkda/dsh-file-manager/blob/main/docs/VERIFICATION-REPORT.md) §9）。

## 真实页面验收状态

- 已在真实页面确认（0.2.7）：深路径面包屑修复效果良好，粘贴弹窗 UI 修复效果良好。
- 仍需在真实页面核对：
  1. 新建、编辑、复制粘贴、传输和任务区的完整操作链。
  2. 专用测试目录中的保存、外部改动冲突、切换面板保留草稿、永久删除取消与确认。
  3. 含空目录的文件夹上传、ZIP 下载及浏览器落盘后的内容核对。
  4. 选择一个已有草稿/引用的会话，确认引用只追加到该会话且不发送。
  5. 明暗主题、键盘操作、重启后根登记和中断任务状态。
  6. 1620×900 / 1000px / 600px 三档宽度下的路径栏表现与键盘滚动查看完整层级。
  7. 语法高亮（R21）：真实物理键盘与输入法组合、autoclose 等只在真实输入事件上触发的输入处理器、几何布局与像素滚动、宿主主题解析后的 computed 颜色（明暗两套），以及 macOS 上的 Cmd+S 物理按键。

## 已知限制

- React 组件声明测试不替代真实浏览器验收；本次上传弹窗另做了隔离 Chromium 的实际控件、默认明暗主题及几何检查，但它不代表全功能页面或某个实例的部署状态已验证。
- `webkitdirectory` 降级只提供文件清单，无法发现空目录；界面明确提示该限制。需要包含空目录时使用支持目录句柄选择器的浏览器。
- 草稿、剪贴板和浏览器 File 句柄跨主面板切换保留，不承诺跨整页刷新/浏览器崩溃恢复。重启后的上传需要重新选择丢失的浏览器源文件。
- 混合换行映射有复杂度预算，超限会拒绝保存并保留草稿，不静默规范化。
- 含双引号或控制字符的路径不能安全表示为当前会话引用语法，引用操作会明确拒绝。
- 尚未执行真实 2 GiB 文件和 10,000 条目全链路压力测试；本次新增上万条目删除清单的限额拒绝回归，但它不等于完整删除/传输压力验收，不宣称压力性能。
- 复制/移动路径的内部读取放大在 N× 量级：同一份字节会在规划期强校验、复制流、目标校验、删源前重证里各读一次，16 MiB 文件实测 `rchar` 增量约为文件大小的 10 倍，尚未做 2 GiB 实测。这是已知的实现特性，**不是校验被裁剪**——核验预算按操作清单的文件字节总量一次性扣减，逐次读取仍有硬上限，`sha256` 仍逐字节核验。后续若优化，只允许复用已算出的摘要或合并同一字节的重复全量哈希，不得以减少校验次数换取吞吐。
- 语法高亮的自动化只断言着色引用的是宿主 token 变量（`--shiki-token-*`/`--dsw-*`），不断言主题解析后的 computed 颜色；真实输入法、物理按键与像素滚动未自动化（边界见 SPEC 的 R21.11）。

## 开发与复核记录

- 通过 Agent Teams 分离文件内核、传输、前端和 Host 集成写入范围；同一文件只有一个写入者，交接后才由 Lead 集成。
- 独立只读复核复现了无覆盖 rename 竞争丢数据和跨卷清理证明过期；均加入真实文件系统失败回归后修复。
- 原生竞争、真实 `/tmp` → `/dev/shm` EXDEV、目标消失/同尺寸修改/父容器替换、持久化失败与关闭竞争均有回归。
- 测试仅使用独立临时目录并清理，没有在用户真实目录中做破坏性实验。
- TDD 技能引用的测试附录未随环境提供，已执行主文的 Red–Green–Refactor、真实行为断言和全套回归。
- 语法高亮（R21）在**构建产物**上做独立 jsdom 真实 DOM 验收（`tests/editor-dom.test.mjs` 与共享 `tests/editor-dom-harness.mjs`，53 项）：着色只统计实际渲染 span 用到的类所映射出的颜色值；首批 11 种语言加 JSX/TSX 共 13 组样本在预览与编辑两种模式下都断言原文逐字不变且 ≥2 个不同 token 颜色；预算、降级、只读、程序性回流、跨文档隔离与卸载释放同样按真实 DOM 断言。该过程中发现并修复：`editor` 命名空间缺预算 re-export、CodeMirror 内 Ctrl/Cmd+S 为空桩、`limited` 只改状态未撤文法、失败态与视图生命周期、卸载/换文档后陈旧视图仍送达快捷键、降级只读面的 `onChange` 未按 `canWrite` 门控、编辑面缺 `tabindex="0"`。
- 捆绑第三方代码的许可原文见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)，其回归用例从构建产物实际内联的包反查声明完整性。

## 发布流程

仓库带有两条 GitHub Actions 工作流，均为 Node 24 / Linux x64：

- `.github/workflows/ci.yml`：push 到 `main`、PR 与手动触发时执行 `npm ci` → `build:native` → `check`（类型检查 + 构建 + 产物语法检查）→ 断言 `dist/client.js` 注册的模块 id 等于包名 → 安装 DSH 运行时 → `test` → `npm pack`，断言压缩包确实含 `dist/index.js`、`dist/client.js`、`dist/host/scheduler.js`、`cordis.patch.yml` 与 `host/native/rename-no-replace`，然后上传为构建产物。上传步骤为**尽力而为**（`continue-on-error`）：Actions 产物存储有配额，配额耗尽不应让每次运行变红，真正的闸门是打包与断言。
- `.github/workflows/release.yml`：推送 `v*` 标签时先构建并校验 **tag 与 `package.json` 的 `version` 一致，且构建后的 `dist/index.js` 导出的 `VERSION` 与之一致**，通过后才发布到 npmjs.com。

顺序不是随意的：`build:native` 必须早于 `npm test`，因为助手缺失时会有 3 项原子发布测试失败；而助手被 `.gitignore` 排除，全新 checkout 里并不存在。打包断言同样必要，否则会发出一个装上即坏的包。

`npm publish` 会先执行 `prepublishOnly`（`check` + `build:native` + `test`），所以未经校验的构建无法到达 registry。`publishConfig` 把发布目标固定为 `https://registry.npmjs.org/`，避免本机指向镜像源时误发。

发布身份来自 **npm 可信发布（Trusted Publishing / OIDC）**：`publish` 作业在 GitHub-hosted runner 上只申请 `contents: read` 与 `id-token: write`，用该作业的 OIDC 身份换取短期发布令牌，**不读取、也不需要任何存储凭据**；缺少发布身份时作业直接失败，不会静默跳过。可信发布要求 npm ≥ 11.5.1 与 Node ≥ 22.14，因此发布前显式安装 `npm@11.19.0`（不假设 runner 自带版本够新）。仓库与包均为公开时 provenance 自动生成，无需额外传 `--provenance`。`workflow_dispatch` 在分支上只做校验、不发布；发布只在匹配版本的 tag 上发生。

首次发布前需在 npm 侧为该仓库配置 Trusted Publisher：owner `lolkda`、repo `dsh-file-manager`、workflow 文件名 `release.yml`、Environment 留空、Allowed actions 包含 `npm publish`。仓库 Secrets 中不再需要 npm token。

发布 `@lolkda/dsh-file-manager` 的步骤：

```sh
# 1. 同步版本号（单一来源）
#    package.json 的 version 是唯一来源；构建后的 dist/index.js 导出的 VERSION 由它派生
# 2. 提交并推送
git commit -am "release 0.2.8" && git push
# 3. 打标签触发发布
git tag v0.2.8 && git push origin v0.2.8
```

## License

UNLICENSED —— 保留全部权利。包会发布到 npmjs.com 公开 registry，但未授予他人使用、修改或再分发的许可。

### 捆绑第三方代码的许可

`dist/client.js` 内联的编辑器依赖（27 个 MIT 包）各自的完整许可原文见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)；该文件随包发布，本项目自身仍是 UNLICENSED。回归用例 `tests/package-notices.test.mjs` 从构建产物实际内联的包反查声明是否完整。
