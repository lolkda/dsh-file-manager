# Agent Note: 删除目录位置管理，固定浏览 Host 根目录

Status: implemented

## Problem

用户要求完全删除截图中的“目录位置”及对应代码，并明确确认默认直接进入 `/`，随后要求使用 Agent Team，由 Lead review 成员修改。当前动态入口贯穿界面、roots.* 协议、V1 根授权存储、状态检查与显式恢复；只隐藏按钮会留下无法维护的入口状态，新安装也没有可浏览目录。

## Decision

- 插件不再提供可配置/增删的浏览入口，启动时直接使用 Host `/`；不依赖 Session 或 workspaceRegistry，不读取/写入旧根授权存储。原存储文件留在原地，不删除用户磁盘文件或任务历史。
- bootstrap 使用单个 `root`（初始化失败时为 null），删除 roots 数组、workspaces 候选、persistentRoots 与全部 roots.* 操作。Client/Host 同批更新，不做旧客户端兼容分支。
- Host manager 只有初始化时确定、不可变的根资源。默认路径为 `/`；内部构造参数可用临时目录供隔离测试，不暴露为插件设置/API。标识绑定规范路径和本次目录身份，相同身份重启保持相同 ID，身份变化产生不同 ID；每次 I/O 保留 dev:ino、规范路径、descriptor-relative walk、O_NOFOLLOW 检查。
- 不保存跨重启的根授权身份，也不再要求重新授权。旧 ID 的任务/草稿/剪贴板不自动绑定到 `/`；文档草稿保留但标记不可写，失效浏览位置回到新根，失效任务剪贴板清空。历史记录不被清除，不将旧根相对路径解释为新根路径。
- 前端删除位置抽屉、入口、添加表单、移除/重新授权确认、状态刷新、通知目的地、专用翻译/CSS/恢复模块。首次打开直接列出 `/`，同一插件生命周期中仍保留有效浏览位置；仅启动恢复的失效子目录在 NOT_FOUND 时回到根，普通导航失败保留位置与勾选，其他错误原样报告，不循环请求。
- 编辑、上传下载、任务、引用、通知、勾选、脏文档和路径安全机制不做无关改写。固定 `/` 的绝对路径拼接必须避免 `//`。

## Ownership and history audit

检索 proposed/implemented/rejected 中目录位置、根目录、root、入口、授权：

- [根入口显式恢复](../../archived/bug-fix/2026-10-12-root-reauthorization.md)：新决定完全取代动态授权/恢复。旧方案最强理由是持久授权不因 inode 变化静默扩张，避免草稿/任务错误改绑；本方案保留 I/O 身份核验和旧 ID 隔离，但明确由用户选择的固定 `/` 取代持久授权，旧篇已同批归档，保留当时的防坑理由与验证记录。
- [通知中心](../../implemented/feature/2026-10-12-notification-center.md)：部分重叠，仅移除 roots 通知目标和恢复确认；事件与业务状态分离仍有效，更新并互链。
- [响应式查看器](../../implemented/feature/2026-10-09-responsive-file-viewer.md)、[精简文件导航](../../implemented/simplification/2026-10-10-compact-file-actions.md)：部分重叠，仅删除位置侧栏/空入口描述，其他布局和导航决定不变。
- 路径复制、直接编辑、统一勾选、宿主剪贴板笔记与本次根管理退出决定无实质重叠，不归档。

分工：Host 成员独占 src/host、src/contracts、src/index.ts；Client 成员独占 src/client；QA 成员独占 tests；Lead 独占笔记、README/SPEC/CONTRACT 和最终 review/集成构建。既有未提交改动基线在 artifacts/remove-locations-2026-10-12/baseline，不将已有变更当作本次贡献。

## Alternatives considered

- 只移除 UI：改动小，旧授权模型和存储保持兼容；但隐藏后无法管理与恢复，且不满足用户删除对应逻辑及默认 `/` 的要求，不采用。
- 自动添加 `/` 但保留动态 roots API/持久化：可复用大量现有测试与逻辑；但仍保留本次明确要删除的状态机，容器 inode 变化问题也仍存在，不采用。
- 删除所有 rootId，所有操作改成绝对路径：表面协议更简洁；但会无关扩大任务/传输/编辑器重写，并失去区分旧资源与新资源的低成本边界，因此保留单个不可变根的资源 ID，不保留入口管理能力。

## Implementation and review

- 单根公开描述符为 `{ id, path, label, identity }`，没有 provider/createdAt；`/` 的 label 为 `/`。ID 为规范路径、NUL 与 dev:ino 的 SHA-256 前 32 位，不增加身份持久状态；依赖操作系统 dev:ino，不声称能识别同一 inode 的重用。
- 非法根构造参数返回 INVALID_STATE/500；不存在、无权限、非目录或末级链接返回 ROOT_UNAVAILABLE/500（Linux 的末级目录链接 errno 为 ENOTDIR）。默认真实 `/` 初始化仅只读；不可用时 bootstrap.root=null、scope=filesystem，其余操作拒绝。
- Lead review 已要求修复：旧剪贴板失效判断不依赖有无打开文档；NOT_FOUND 回根只限启动恢复保存目录，普通导航失败仍保留旧路径与勾选；新根首次列举失败不得渲染旧相对路径；ROOT_CHANGED 文案明确需重新加载 Host 插件而非重开面板。
- 旧任务历史仍可读，retry 保持既有异步语义：可以记录一次重试并在执行阶段逐项 ROOT_NOT_FOUND 失败，但不改 rootId、不向新根发布文件。无需为同步拒绝而新增任务语义。
- Lead review 发现新根关闭检查误伤已经排队的 mutation：createFile 入队后立即 close 会拒绝已接收写。Host 以 stopping（停止接收）和 closed（排空后）区分边界；关闭先排空 mutation，再释放 I/O，已接收保存/重命名/删除仍完成。排空窗口内允许内部及外部读使用现有根，关闭完成后一律 SERVICE_STOPPED；不引入 async 上下文或恢复状态机。QA 使用真实 gated rename 验证排空，不能以 staged abort 冒充此契约。

## Verification

- 新安装无需添加目录，bootstrap 返回 `/`，客户端首个 entries.list 指向它；不存在任何位置抽屉/添加/移除/恢复/状态刷新调用。
- 全部 roots.* 被拒绝为 INVALID_REQUEST；旧根存储不存在、损坏或包含过期 inode 都不参与初始化；操作 journal 的只读降级仍有效。
- 固定根跨相同身份重启稳定，路径身份变化后旧 ID 被拒绝；目录链接不跟随、越界路径拒绝、系统权限错误不绕过。隔离夹具验证写入，不对真实 `/` 做修改测试。
- UI 仍可浏览/编辑/保存、上传下载、任务操作与引用；引用与复制绝对路径不出现多余 `/`。
- 新测试覆盖移除表面、旧状态隔离、默认根、初始化/权限失败、普通文件操作；完整测试以普通 UID/GID 1000 运行，统一 typecheck/build/check-dist 与 verify-notes。

最终实测（Lead 执行，不将成员私有冒烟累计为验收数量）：

- `npm run check`：Host/Client 类型检查、构建及 20 个产物语法检查通过；Client 产物 1,317,467 字节，SHA-256 `17f4b4b42303848172e39ca7daa7131eaf4cd7943691987830181856f29c48a3`。
- `setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/tmp npm test`：**903/903 通过，0 失败、0 取消、0 跳过**；权限与 EXDEV 用例均实际运行。首轮 900 项仅 host-config 仍断言已移除的 workspaceRegistry 依赖而失败；已改为 inject 严格等于 connection/storageDomain，并补齐 3 项生命周期回归后完整复跑。
- QA 最终针对性 52/52（包含在上述全量中）：真实入队 rename 在 close 发起后仍落盘、新请求拒绝；13 项固定根 Client 回归包含真正 dirty 草稿保留、无打开文档的旧剪贴板清理、迟到 NOT_FOUND 卸载守卫、权限/根错误不回退且继续同步任务、失败位置与勾选保留；10 项 Host Config 与 29 项 mutation 回归。
- 复用现有真实 Host UI/theme 与 Chromium 的隔离只读数据夹具，在 1440×900、624×938、390×844 下验证无位置 DOM/按钮/roots.* 请求、首个根目录请求、面包屑 `/`、无横向溢出、点击文件→编辑→保存→返回列表及根路径导航；后台 watch 状态变化不恢复旧占位。Lead 查看 624px 根列表/编辑器及 390px 根列表截图。现有 GUI URL 返回 401，未访问认证凭据、未启动替代服务器、未安装或重启运行插件，因此这些结果不代表线上激活。
- 旧根恢复笔记已归档并封印，活跃入站链接与部分重叠笔记同步；`npm run verify-notes`、`git diff --check` 通过。

重放证据在本地忽略目录 `artifacts/remove-locations-2026-10-12`：baseline/source.tgz 保留既有未提交改动；full-test-final.log 为全量日志；qa-target.log 为独立针对性日志；verify-browser.mjs 与 browser/after/metrics.json、截图记录隔离浏览器验收。历史验证文档保留当时结果，不把旧根 API 的历史记述当作当前契约。

## Consequences

删除了目录管理 UI、状态机、协议和根存储维护，首次使用与容器重建都不再依赖人工添加/恢复。代价是 Client/Host 须一起升级；若以后重新要求多用户或受限目录选择，应重新设计独立权限边界，而非恢复隐藏的根管理 API。

浏览边界从显式子树改为 DSH 进程可访问的整个 `/`，这是用户已确认的行为变化，系统权限仍生效。旧入口对应的未完成任务不能自动恢复到新根，必须重新发起；保留历史用于查询。当前浏览器调试连接不可用，构建成功不代表现有 GUI 已加载新版本，未验证的运行态必须明确报告。
