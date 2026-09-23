# 审核报告 + TypeScript 迁移可行性（DSH 0.1.6-alpha.2 / Node 24.21）

> **历史文档：迁移开始前的只读审核与候选方案。** 本文的未决问题与推荐方案均已被后续实现取代，保留原文以留存当时的诊断证据：
> - 发布身份已定为 `@lolkda/dsh-file-manager`（运行时 unit id 仍为 `local-file-manager`）；
> - Host 最终采用**编译产物** `dist/`（`tsc` 编译为 ESM JavaScript），**不是**本文 §4.2 推荐的“零构建直接跑 `.ts`”；
> - Client 最终为 `src/client/*.tsx` 由 esbuild 打包到 `dist/client.js`，**不是**本文 §4.1 画的 `src/client/client.ts` + 根 `client.js`；
> - §五“需要确认的三件事”已全部决定。
>
> 当前权威文档：[SPEC.md](SPEC.md)（行为规则 R1–R20 与验收）、[docs/CONTRACT.md](docs/CONTRACT.md)（冻结契约）、[docs/VERIFICATION-REPORT.md](docs/VERIFICATION-REPORT.md)（验证记录）。
> §3 的 H1–H3 / C1–C6 是**迁移前**的原始观察，行号指向当时仍存在的 legacy 文件（根目录 `index.js`、`host/*.js`、`client.js`）；这些文件已在 0.2.x 迁移中删除，行号仅作历史对照，不代表当前代码。

审核对象：`/app/project/dsh-files/dsh-file-manager`（`@lolkda/dsh-file-manager` 0.1.4，4.9k 行源码 + 5.4k 行测试）——该路径是**当时本机的只读副本位置**，在其他机器上按仓库相对路径理解即可。
审核时间：本轮对话；全程只读，未修改任何项目文件。

---

## 一、结论速览

| 问题 | 结论 |
| --- | --- |
| DSH 支持 TypeScript 吗？ | **支持，但分平面**：Host 端**原生支持**（Node 24 类型擦除，无需构建）；Client 端**不支持运行时 TS**，必须构建成 `window.__ModuleLoader__.load(...)` 的 JS bundle |
| 现在能不能把本项目重写成 TS？ | 可以，且不需要改动 DSH 任何代码；Host 零构建，Client 加一个 esbuild/tsdown 构建步骤 |
| 迁移的主要成本在哪 | 不是"能不能"，而是**契约类型化**：1 个 op 分发点（`index.js:85-175`）+ 1 个 1309 行手写客户端 bundle；纯机械改名只占工作量约三成 |
| 当前代码质量 | **B**。设计纪律强（目录 fd + O_NOFOLLOW 逐段寻址、renameat2 无覆盖发布、幂等 ledger、四层串行队列），但有三处硬伤（见 §3.1） |

---

## 二、DSH 对 TypeScript 的支持（实证，非推断）

### 2.1 Host 端：原生支持，零构建

1. **Node 24.21 默认启用类型擦除**。实测 `node main.ts` 直接运行成功（无需任何 flag）。
2. **加载器链路把裸包名原样交给 Node**。`cordis-plugin-loader/lib/index.js:270-283` 对插件入口做 `import(specifier)`；它只对 `./`、`../` 开头的相对 specifier 做 `__rewriteRelativeImportExtension`（把 `.ts`→`.js`，见 `lib/index.js:147-152`），**裸包名不重写**。因此 `cordis.patch.yml` 里写 `name: '@lolkda/dsh-file-manager'`、由 `exports["."]` 指向 `./index.ts` 是最安全的 TS 路径。
3. **端到端实测**：构造 `@local/ts-probe`，`exports: {".": "./index.ts"}`，`index.ts` 里含 `interface`、泛型函数、可选链、`import { make } from './host/helper.ts'`（相对 `.ts` 导入）、`export default` + 具名 `apply`/`inject`/class，然后以裸包名 `import('@local/ts-probe')` 加载：

   ```
   apply= function  inject= []  default= function  class= function
   log: [ts-probe] apply: ts-probe x2
   ```

   即 Loader 的 `unwrapExports` 所需的 `default` / 具名 `apply` / `inject` 三种形态全部正常。
4. **语法约束**：只有"可擦除"语法可用。实测报错：

   | 语法 | 结果 |
   | --- | --- |
   | `enum` | `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript enum is not supported in strip-only mode` |
   | `namespace` | 同上 |
   | 构造器参数属性 `constructor(private x: number)` | 同上 |
   | `interface` / 泛型 / `satisfies` / `as const` / 相对 `.ts` 导入 | 正常 |

   对策：`tsconfig` 开 `erasableSyntaxOnly: true`（编译期拦截）+ `allowImportingTsExtensions: true` + `noEmit: true`。本项目现有代码不需要 enum/namespace，改造成本为零。
5. **运行环境**：当前 Host 进程就是 `node /usr/local/bin/dsh --profile web --no-open`（Node 24.21），环境变量里没有 `NODE_OPTIONS` 之类会关闭类型擦除的设置。

### 2.2 Client 端：运行时 TS 不支持，必须有构建步骤

`dsh-client-modules` 的 Node 半边在 `resolveMeta()` 里把 `exports["./client"]` 解析为**文件路径**，随后 `readFileSync(clientPath)` 直接按字节读出来发给浏览器（`dsh-client-modules/lib/index.js:690-700`、`770-800`、`925`）。中间**没有任何转译**，浏览器拿到类型标注就会语法错误。

DSH 官方包的客户端产物统一是这个形态（`dsh-client-modules/lib/client.js:1`）：

```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-modules",
  factory: (require) => { var module = { exports: {} }; var exports = module.exports; ... },
});
```

本项目手写的 `client.js` 已经是这个格式，说明作者读懂了契约；迁移时只要让构建器产出**字节级等价的外壳**即可（esbuild `banner`/`footer` + `format: 'cjs'` + `external: ['react', '@deepseek-ai/dsh-client-ui-primitives', ...]`）。

### 2.3 工具链现状

部署里**没有** TypeScript/esbuild/tsdown（全局与 profile 的 `node_modules` 都没有），但 npm registry 可达（`npm view typescript version` → `7.0.2`），可作为插件项目的 devDependency 安装。

---

## 三、代码审核

### 3.0 项目状态与一个需要先定的事实

- `npm test`：**329/329 通过**（本机实测，5.8s）。这是迁移最可靠的安全网。
- **身份不一致**：profile 里已安装并启用的 bundle 是 `@local/dsh-file-manager@0.1.4`，依赖落在 `.../artifacts/local-dsh-file-manager-0.1.4.tgz`（tarball 快照）；而 workspace 源码已改名 `@lolkda/dsh-file-manager`，且 `tests/package-identity.test.mjs` 用断言把 `@lolkda/...` 钉死（Client 的 `__ModuleLoader__.load({id})` 也必须等于包名）。迁移前需要决定发布身份，否则会出现"源码测过、profile 里装的是另一个包"的错位。

### 3.1 Host 端（严重，按影响排序）

| # | 位置 | 问题 | 后果 | 复核 |
| --- | --- | --- | --- | --- |
| H1 | `index.js:99,102`；`host/manager.js:382,387,393,421,455,473`；`host/tasks.js:144,172,226`；`host/transfers.js:287,311,368,372,410,453,590` | 17 处 `io.stat` 未传 `maxBytes`，`host/io.js:87` 对文件一律 `openRead → hashHandle` 做**无上限全文件 SHA-256** | 认证客户端点一个大文件、或触发删除准备/重命名，即造成 GB 级读盘 + CPU 消耗，且不受 `maxFileBytes` 约束 | 已复核调用链 |
| H2 | `index.js:80-81`（先按 16 MiB 读完 body 才判 op）、`index.js:186`（text 路由允许 ~30 MiB+ 单请求） | 控制/文本路由缺少**并发闸门与内存闸门**；ledger 容量 256 只作用于突变路径 | 并发放大内存占用 | 已复核 |
| H3 | `host/transfers.js:178` `view()` 直接 `structuredClone(task)` | 未剥离 items 的 `expectedVersion/identity/sha256/committed` 与 `destinationIdentity/downloadKind`，与 `transfers.js:120` 的契约注释自相矛盾（对比 `tasks.js:72` 是剥离的） | 内部恢复态随 API 外泄 | 已复核 |

中级（选摘，均有行号）：`host/io.js:49-51` 目录枚举因单个非法文件名（含 `\` 或控制字符，Linux 合法）**整目录失败**，而 `manager.js:165-175` 不校验 → 行为不一致；`host/io.js:237` 的 `.dsh-fm-*.tmp/.dir` staging **无启动回收**，崩溃即永久残留并出现在列表里；`manager.js:197-201` `readText` 的 lstat/open 之间未比对 identity（TOCTOU，可能返回错误 version/mode）；`manager.js:405` 删除清单 ≤64 份 × 1 万条目常驻无定时清理；`host/state.js:82-89` 单条记录损坏即抛错 → `index.js:274` 整个插件降级、连根授权一起失效，且 `version:1` 无迁移路径；`tasks.js:41` 与 `transfers.js:140` 各自计数同一个 `transferConcurrency`（峰值 2×2）；`ENOTEMPTY/EISDIR/EXDEV` 在 `index.js:63` 落成 `IO_ERROR 500`。

可维护性：错误码映射两套（`index.js:53` / `transfers.js:66`）；状态机两套（`statusOf` vs `summarize`）；`nextHistoryRevision` 两份实现（`tasks.js:67` / `transfers.js:14`）；路径校验三份（`manager.partsOf` / `transfers.relativePath` / `tasks.refOf`，后者靠假 rootId 借道）。

### 3.2 Client 端（已逐条复核）

| # | 位置 | 问题 | 严重度 |
| --- | --- | --- | --- |
| C1 | `client.js:433` | `const sessionCatalog = useSessions ? useSessions(...) : {...}` —— **条件调用 Hook**。`useSessions` 是 slot inject 传入的 prop；一旦它在挂载期间从 undefined 变为函数，Hook 顺序错乱、组件崩溃 | 高（潜在） |
| C2 | `client.js:519` | `append` 分支读的是渲染闭包里的 `listing.nextCursor`；同一帧内连续 append 会用同一个 cursor，出现重复页 | 中 |
| C3 | `client.js:500-502` | `if (failure.code) throw failure`：`AbortError` 的 `code` 是数字 20（真值），于是被原样抛出，最终在 `errorText` 里退化成 `IO_ERROR`；用户主动取消会显示成错误 | 低 |
| C4 | `client.js:506` | 每次 `api()` 都新生成 `requestId()`，只有 `client.js:639` 复用 attempt id → 其余突变重试在新 id 下丢失 Host 幂等去重 | 低-中 |
| C5 | `client.js:1156,1197,1223,1242,1269,1273` | 多处用数组下标作 React key（1242 重命名输入框最明显） | 中 |
| C6 | `client.js:364` | SSE 解码缺少流结束时 decoder 的最后一次 flush，截断字节静默丢弃 | 低 |

**两份子审查中被我否掉的误报**（写在这里，避免以讹传讹）：

- ❌"SSE `client.js:791` 重连时 `sequence` 归零导致丢帧"：服务端 `index.js:205` 的 `sequence` 也是**每连接从 0 开始**（`encode` 里 `++sequence`），客户端按连接重置是**正确的**；且 `ready` 帧会触发全量 resync。
- ❌"`client.js:974/986` 替换 AbortController 导致 cancel 无法终止在途请求"：`980` 行 abort 的就是在途 fetch 持有的那个 controller（`923` 在调用时读取），取消失效不成立。
- ⚠️"`client.js:818` 卸载后 setState"：`817` 行已 `if (closed || aborted) break`，属于过度解读；真正的残留只是清理后仍可能留下一个 ≤30s 的退避定时器。

### 3.3 结论

设计纪律明显高于平均水平（SPEC 里的行为规则基本都能在代码里找到对应实现，并有 329 个测试兜住），失分在"边界与一致性"：字节上限执行不彻底、DTO 剥离不一致、重复的校验/状态机、少量前端闭包与 Hook 纪律问题。

---

## 四、TypeScript 迁移方案

### 4.1 目标形态

```
dsh-file-manager/
├─ tsconfig.json                  # 严格 + erasableSyntaxOnly + noEmit + allowImportingTsExtensions
├─ src/
│  ├─ index.ts                    # 原 index.js（Host 入口：exports["."] → ./src/index.ts 或 ./index.ts）
│  ├─ contracts/errors.ts
│  ├─ contracts/protocol.ts       # 新增：op 判别联合 + zod 边界模型（z.infer 出类型）
│  ├─ host/{io,manager,tasks,transfers,state,watch,requests,atomic-rename,line-endings}.ts
│  └─ client/client.ts            # 原 client.js（1292 行 require 场景用 declare module 声明）
├─ client.js                      # 构建产物（保持 __ModuleLoader__ 外壳，仍需与包名一致）
├─ host/native/rename-no-replace.c  # 不动
└─ tests/*.test.mjs               # 见 4.4
```

### 4.2 Host：零构建，直接跑 `.ts`

- `package.json`：`exports: { ".": "./index.ts", "./client": "./client.js" }`，`engines.node >= 24`（已是），`files` 加 `src`。
- 相对导入全部写 `./host/manager.ts` 形式（Node 不做扩展名推断，必须带扩展名）。
- 保留 `default apply` / 具名 `apply`+`inject` 的导出形态不变（已实测可用）。
- 备选：用 esbuild 产出 `dist/*.js`（可发布到任意 Node 版本，代价是双份产物 + 每个改动点都要构建）。**当前项目 `os/cpu` 已锁 linux x64、`engines` 已锁 ≥24，Host 侧我推荐零构建方案。**

### 4.3 Client：加一个构建步骤

- 源码 `src/client/client.ts`，**保留 `React.createElement`**（首轮不改 TSX：1309 行、194 处 `h(...)`，改 JSX 会让 diff 与测试断言一起翻新；TS 下 `h()` 照样获得 intrinsic props 类型）。后续可选做 TSX 化。
- 构建：`esbuild src/client/client.ts --bundle --format=cjs --platform=browser --external:react --external:@deepseek-ai/dsh-client-ui-primitives --banner:js='window.__ModuleLoader__.load({ id: "...", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' --footer:js='  return module.exports; } });'`
- 产物 `client.js` 提交进仓库（DSH 不做构建），并在 CI 里加"产物与源码一致"的门禁。

### 4.4 测试：建议先留 `.mjs`，只改导入后缀

测试里有大量**故意非法**的输入（越界路径、错类型 body、伪造 version）。转成 `.ts` 会迫使每个非法样例写 `as unknown as X`，噪声大而收益小。首轮只把 `import '../index.js'` 改成 `'../index.ts'`（Node 允许 `.mjs` 导入 `.ts`），329 个用例作为迁移的等价性红线；是否把测试也 TS 化放在最后一阶段单独决定。

### 4.5 验收标准

1. `npx tsc --noEmit` 零错误（`strict` + `noUncheckedIndexedAccess` + `erasableSyntaxOnly`）。
2. `npm test` **329/329 全绿**，且测试文件只允许出现"导入后缀"这一类改动（用 `git diff --stat` 复核）。
3. `client.js` 与构建产物逐字节一致，且 `id` 等于包名（`tests/package-identity.test.mjs` 继续通过）。
4. 打包 → 安装 bundle → Host 激活 `applied`；在现有 `http://127.0.0.1:3080` 页面确认主面板/侧栏入口、目录浏览、文本预览可用。
5. `npm run build:native` + 原生助手仍通过。

### 4.6 分期与风险

| 阶段 | 内容 | 主要风险 |
| --- | --- | --- |
| S0 | 定发布身份（`@lolkda/...` vs `@local/...`）、tsconfig、装 typescript/esbuild devDep、CI 改 `tsc --noEmit` | 身份不一致会让"安装验证"失真 |
| S1 | Host 机械迁移：`index.js` + `contracts` + `host/*.ts`，导入后缀，`tsc --noEmit` 通过，329 绿 | 擦除型语法约束、`catch (e: unknown)` 下的 errno 访问 |
| S2 | 契约类型化：`contracts/protocol.ts` 用 zod 定义每个 op 的请求/响应，`z.infer` 出判别联合，`index.js:85-175` 的 switch 改为穷尽检查；顺带修 H1/H2/H3 | 校验变严可能让个别宽容用例失败 → 用测试反馈逐个确认是"测试依赖了宽容"还是"行为退化" |
| S3 | Client TS 化 + 构建管线 + 产物门禁；顺带修 C1–C6 | 手写 bundle → 构建产物，需逐字节/行为对齐；`require()` 与 slot inject 的类型声明 |
| S4 | 打包 0.2.0、安装、页面验收、（可选）测试 TS 化 | 已安装 bundle 是 tarball 快照，替换后需 `restart-required` |

### 4.7 迁移顺带能修掉的东西

`zod` 已在依赖里（`host/state.js` 在用），把 `index.js:85-175` 的 40 多个 op 收敛成 `ControlRequest = z.discriminatedUnion('op', [...])` 之后：请求体校验、Host/Client 错误码同源、Client 端 `api()` 的类型安全就是同一份声明推出来的 —— 这是本次重写最大的实际收益，比"把 js 后缀改成 ts"重要得多。

---

## 五、需要确认的三件事

1. **迁移范围**：只迁 Host（S1–S2）／Host + Client（S1–S3，推荐）／连测试一起全量 TS 化（S1–S4）。
2. **Host 运行形态**：原生跑 `.ts`（推荐，零构建）／编译到 `dist/*.js`（传统 npm 包形态）。
3. **发布身份**：保持 `@lolkda/dsh-file-manager`（源码现状、identity 测试已锁）并把 profile 里的 `@local/dsh-file-manager@0.1.4` 替换掉／维持 `@local` 现状。