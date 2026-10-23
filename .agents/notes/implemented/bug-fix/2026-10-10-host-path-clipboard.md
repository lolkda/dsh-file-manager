# Agent Note: 路径复制复用宿主剪贴板能力

Status: implemented

## Problem

用户报告当前目录路径复制在手机和桌面失败，而更多菜单内所选路径可复制。两个入口共享 usePathCopy，原实现直接解引用 window.navigator.clipboard.writeText，在浏览器不提供该 API 时失败。用户报告的入口差异没有在经过认证的实际页面复现，不能由源码推断存在不同实现或确定权限根因。

## Decision

结果的展示位置与保留时间由[会话内通知中心](../feature/2026-10-12-notification-center.md)部分接管；下面的宿主能力调用、成功判定、完整手动文本及文件任务剪贴板隔离继续有效，不因通知清除而改变。

两个入口继续共享同一 hook，系统写入委托给当前 DSH 公开的 writeClipboard(text): Promise<boolean>，不维护插件私有 execCommand 算法。当前宿主实现优先 async writeText；仅 API 缺失时使用同步 textarea+execCommand('copy')，API 明确拒绝时返回 false，不绕过拒绝。调用仍在用户点击调用栈内发起，不加预查询、网络请求或任务剪贴板操作。

只有明确 true 才显示成功；false、非boolean返回、抛错、缺失能力均保留原有完整只读路径文本兜底。注入边界可选，不提供能力时也不使面板崩溃。串行请求、卸载/重挂载迟到结果隔离、绝对路径、原样文本、多选按显示顺序 LF 连接及无尾换行规则不变。插件不添加未经验证的焦点恢复；宿主拥有临时 DOM 的创建与清理。

## Existing decision audit

- [路径文本复制](../feature/2026-10-09-copy-paths.md)：部分替代直接 async API 与缺失即手动兜底的决定。旧方案避免自维护过时 API 和焦点副作用的理由仍有效，本次以已有宿主公共 helper 接管浏览器差异；路径输出、选择隔离和失败保真规则保留，互链不归档。
- [统一选择](../simplification/2026-10-10-unified-file-selection.md)：选择集合与工具栏归属不变。
- [精简控件](../simplification/2026-10-10-compact-file-actions.md)：同时施工但责任分离，保存和祖先导航不受复制变化影响。
- 实施前 proposed/rejected 无其他同主题方案。

## Alternatives considered

- 继续仅调用 async Clipboard API：实现最简、没有临时 DOM，也避免 deprecated API；但无法覆盖不提供该 API 的上下文，即使宿主已有可用复制能力仍报失败，因此复用公共 helper。
- 自写 execCommand 自动兜底：可控制更细的失败及焦点策略；会重复宿主逻辑并增加维护边界，因此不采用。宿主明确拒绝时不另外绕过其策略。

## Testing

[原路径复制回归](../../../../tests/path-copy.test.mjs)17项完整保留，验证格式、显示顺序、链接位置、只读、无根、同步异常/异步拒绝、手动全文选择、并发、卸载、无新增请求及任务剪贴板隔离。[provider回归](../../../../tests/path-copy-provider.test.mjs)另增6项，真实Panel注入writer，验证两个入口同调用、true、false、非boolean、缺失能力、同步throw及异步reject。测试边界只模拟公共writer，不将其视为系统复制证据。针对性23/23，全量普通UID/GID1000的npm test为814/814，0失败、0跳过；npm run check通过。

集成审查发现测试文件曾被新provider案例误覆盖；在最终验证前恢复本轮开始时的原299行测试，新增案例放独立文件，核对原文件无diff，不删除旧验收。首次类型检查发现类型导入误改，修复后完整构建通过。

真实 Chromium 非安全 HTTP fixture 使用实际宿主 UI 公共模块和最终构建，390px手机、1440px桌面各实际点击目录复制和所选路径复制，再原生Control+V粘贴到textarea。isSecureContext=false、navigator.clipboard不可用；目录结果为“/fixture/中文 workspace/folder”，两项结果含中文、空格及真正LF，逆序勾选仍按列表顺序输出，逐字节一致；复制不改变勾选、不发文件API请求。公共helper独立探针也证明缺失API情况下可写入并实际粘贴，不把synthetic paste事件当成功。

最终浏览器9组（7组控件+2组复制）failures/errors均为空；最终client SHA256为 b20da66d29dfec61b0f9fd928f999b10606975831905f3188ea2cb0eb82095a8。复现脚本和metrics位于忽略的artifacts/compact-file-actions；探针位于artifacts/directory-copy-diagnostic。

## Consequences

目录和所选路径统一利用宿主对浏览器环境的处理，缺失async API不再必然失败；失败仍提供真实完整文本而不虚报成功。代价是复制能力随宿主版本和浏览器策略变化，不承诺所有浏览器都自动复制。fallback会创建并移除临时textarea；本轮不新增焦点策略、不升级宿主、不修改权限或TLS配置。

实际GUI匿名访问返回401，未查找登录凭据；用户报告的两个入口差异仍无法在其会话中精确归因。已证明并修复的是缺失async API这一能力缺口，以及最终两个入口的真实HTTP复制链路；物理设备策略和已认证页面激活须单独核对。
