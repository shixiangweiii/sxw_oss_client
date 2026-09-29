# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# OSS Client

面向阿里云 OSS 的 macOS 桌面客户端（Electron 43 + React 18 + TypeScript + Zustand + Tailwind 3，electron-vite 构建），
基于 electron-mac-scaffold 脚手架创建。当前功能：Bucket / 对象浏览、在线文本编辑、本地目录 ↔ Bucket 双向同步、
本地与云端文本文件的只读 Diff。

## 命令

```bash
npm run dev           # electron-vite 开发服务器
npm run typecheck     # node / web 两套 tsconfig 分别做类型检查
npm run lint          # ESLint（lint:fix 自动修复）
npm run format        # Prettier（format:check 只校验）
npm run build         # typecheck + 构建三进程产物到 out/
npm run preview       # 用构建产物启动，接近打包后的运行方式
npm run package       # 构建并打 macOS dmg

npm test                                    # node --test 跑 scripts/tests/*.test.mjs
node --test scripts/tests/sync.test.mjs     # 单个测试文件
node --test --test-name-pattern='关键字' scripts/tests/diff-service.test.mjs   # 按用例名过滤
npm run test:electron        # 先 build，再用真实 Electron 跑冒烟（含 electron-diff-smoke.mjs）
npm run test:electron:sync   # 同上，窗口模式；当前 macOS 做不了全屏动画时用（不验证原生全屏）
```

所有测试都用隔离的临时目录 / userData 和内存 OSS 替身（或让真实 `ali-oss` SDK 连本机 HTTP 服务），
**不读实际 `.env`、不碰真实 Bucket**。构建后 `npx electron scripts/tests/electron-smoke.mjs --windowed --native-confirmation`
可额外验证真实的原生覆盖确认框（不自动点击）。

完整验证是 `typecheck + lint + test + build`；窗口行为、持久化、打包产物相关的改动仍需实际启动应用确认。

`.npmrc` 的依赖解析走 npm 官方源，只有 Electron 二进制走 npmmirror CDN，不要把 registry 一起改成镜像。

`AGENTS.md` 是本文件的精简副本，架构说明变更时保持两者一致。

### 测试加载器的约束

`scripts/tests/source-loader.mjs` 不经过 Vite：用 `ts.transpileModule` 把单个 TS 文件转成 CJS 放进 `vm` 执行，
相对导入一律按「路径 + `.ts`」解析，`electron` 等外部模块通过 `overrides` 替换，`window.electronAPI` 通过 `globals` 注入。
所以被测模块（`src/main` 的业务模块、store slice、`closeGuard.ts`、`diffEditorSession.ts`）：

- 运行时导入只能用**不带扩展名、指向 `.ts` 文件的相对路径**——不能用 `@/` 别名，不能导入 `.tsx` 或目录 index
- 想测依赖 DOM / 第三方组件的逻辑，要像 `diffEditorSession.ts` 那样抽成只引用类型的 `.ts`，`.tsx` 只负责挂载

## 架构

三进程结构，进程边界是硬的（`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`）：

- **`src/shared/`** — 两侧共用的类型与常量，**不依赖 electron 运行时**。`constants.ts` 是 IPC 通道名的唯一来源
  （另含 5 MB 文本上限、sync / diff 的活动相位判断），`types.ts` 定义全部跨进程类型与 `ElectronAPI`。
- **`src/main/`** — 见下方「主进程分层」。
- **`src/preload/index.ts`** — `electronAPI` 是渲染层能触达主进程的**全部**表面积，实现必须满足 `ElectronAPI` 接口。
  只用 `ipcRenderer` / `contextBridge`，不碰 Node 内建（这是能开 `sandbox: true` 的前提，新增能力时别破坏它）。
- **`src/renderer/`** — React + Zustand（ui / file / oss / diff / sync 五个 slice）+ Tailwind，路径别名 `@` → `src/renderer`。
  主体是 `OssPanel`（文件树），`TextEditorPage` / `DiffPage` 作为全屏层覆盖其上，`SyncPanel` 固定在底部。

测试加载器为主进程 Worker 提供 `.js` 到当前 `.ts` 的入口映射，在线程内直接加载源码；真实 Electron 冒烟仍使用构建产物验证 Worker 路径。

### 主进程分层

业务逻辑与 Electron 胶水分开：业务模块不 import `electron`，因此能被 Node 测试直接加载。

- **同步**：`sync.ts`（`SyncManager`）+ `syncFiles.ts`（路径安全校验、快照、临时文件清单）+ `syncPrecheck.ts`（检查与缓存）是纯逻辑；
  `syncRuntime.ts` 负责 IPC 注册、下载模式选择框、逐文件覆盖确认框、关闭 / 退出拦截
- **文本合并**：`textMerge.ts` 管理 Worker、预算、取消与上传标记扫描；`textMergeCore.ts` / `textMergeFormat.ts` 负责纯计算与格式。
  `textMergeWorker.ts` 由 electron-vite 作为独立主进程入口构建，必须随 `out/` 一起分发；等待 Worker 退出后才能解除同步占用。
- **Diff**：`diff.ts`（`DiffManager`）+ `diffFiles.ts` + `diffResults.ts` 是纯逻辑；`diffRuntime.ts` 负责 IPC 注册与按 webContents 的生命周期
- **OSS 浏览与文本读写**：`oss.ts`（仅用 `electron.app` 定位 `.env`）
- **全局互斥**：`operations.ts`
- **窗口 / 菜单 / 设置**：`window.ts` / `windowManager.ts` / `menu.ts` / `settings.ts`

IPC handler 分散在三处：`ipc.ts`（窗口、文件、设置、OSS 浏览与文本读写，并在开头调用 `registerDiffIpcHandlers()`）、
`diffRuntime.ts`，以及 `syncRuntime.ts` 的 `initializeSync()`——后者由 `index.ts` 在 `registerIpcHandlers()` 之前 await，
先恢复上次残留的同步临时文件。

### 新增 IPC 通道的四步

`shared/constants.ts` 登记通道名 → `shared/types.ts` 补类型并挂到 `ElectronAPI` →
主进程实现 handler（按功能放 `ipc.ts` / `syncRuntime.ts` / `diffRuntime.ts`）→ `preload/index.ts` 暴露方法。

第 2、4 步有 `ElectronAPI` 接口兜底，漏了 TS 会报错。**第 3 步没有类型关联**——忘记注册
handler 要到运行时才会报 `No handler registered`，改完记得实际调用一次。

IPC 约定：

- OSS / sync / diff 的 handler 统一返回 `OssResult<T>`（`{ ok: true, data } | { ok: false, error }`，错误经 `toOssError` 压平），
  **不走 promise reject**——Error 的自定义字段（code / status / requestId）跨进程序列化会丢，而 requestId 是阿里云排障的唯一凭据
- 主进程 → 渲染层的推送有三条：`menu:action`、`oss:sync-state`（广播给所有窗口，全应用共享一个同步任务）、
  `oss:diff-state`（按窗口生成快照，结果只属于发起窗口，其他窗口只看到忙态）。preload 包成返回退订函数的 `onXxx(callback)`
- `window:confirm-close`、`oss:sync-check-unload` 是 `ipcMain.on` + `sendSync` 的同步通道，只给 `beforeunload` 用（那里不能 await）

### OSS 连接与凭据

- `ali-oss` **只在主进程使用**（依赖 Node stream）；AccessKeySecret 绝不流经渲染层。
- 凭据目前从项目根 `.env` 读取（`oss_ak` / `oss_sk` / `oss_endpoint` / `oss_region` / `oss_bucket` / `sync_dir_local`），
  仅 dev 生效（`app.isPackaged` 时直接不读）。后续换成凭据管理 UI + `safeStorage`，别明文写进 `settings.json`。
- 连接按 **webContents.id** 隔离：每个窗口持有自己的配置快照和按 bucket 缓存的 SDK 实例，刷新只重建当前窗口的连接，
  webContents 销毁时释放。同步 / Diff 每个任务新建独立 SDK 实例，取消分片不会污染浏览用的客户端。
- 在线保存用读取时的 ETag / versionId 做冲突检查，同一 Bucket/key 的检查与写入在主进程串行。这只防本客户端多窗口互相覆盖；
  HEAD 与 PUT 之间的外部写入仍有竞态（PutObject 不支持 `If-Match`）。
- SDK 默认 `secure: false`，新建实例时必须显式开启 HTTPS。

### 全局互斥（`operations.ts`）

同步、Diff 扫描 / 详情读取、在线文本保存三者互斥；全应用最多一个同步任务、一个 Diff 占用。
`reserveSync` / `reserveDiff` / `withTextWrite` 的「检查 + 占用」之间**不能插入 await**，否则闸门失效。
预检查最多 3 对并发，终止前等待全部读取；执行时即使判为内容相同也须 HEAD 复核云端版本。
检查记录在模式选择前可用、取消后仍保留；执行时原位更新，`issueRevision` 保护详情重读及分页竞态。
同步或保存写入成功后 `notifyContentChanged(bucket)` 会把该 Bucket 的 Diff 结果标记为可能过期。

### 关闭 / 退出 / 刷新保护

两层叠加，改动任一层都要兼顾另一层：

1. 主进程 `syncRuntime.ts` 在同步进行中拦截窗口 `close` 和 `before-quit`，询问「继续同步 / 取消同步后继续」。
   若模式选择框或覆盖确认框正开着，先程序化收起（**不算用户跳过**），用户选继续后恢复同一次模式选择或文件确认。
2. 渲染层 `closeGuard.ts` 的 `beforeunload`：先 `checkSyncUnload()`，再检查编辑器草稿并 `confirmWindowClose()`。

Diff 会话绑定 webContents：主框架导航（刷新）或销毁时由 `diffRuntime.ts` 自动结束并取消请求。

### 窗口标题与配置继承

标题一律由主进程组装，渲染层只通过 `reportWindowState` 上报 `{ filePath, config }`。
目前渲染层固定上报 `filePath: null`（`fileSlice` 留给将来的下载 / 预览复用），但这套机制保持可用。

`composeTitle` 目前**只读 `filePath` 和窗口编号，不读 config**。`ipc.ts` 里先 `updateWindowConfig`
再 `setWindowFilePath` 的顺序是为将来 config 参与标题预留的约定，不是当前的正确性要求。
真要让 config 参与标题，还必须同步放宽 `setWindowFilePath` 里「路径没变就早退」的条件，
否则只改 config 的场景标题不会重算。

有文件时标题只显示文件名，**仅当与其他窗口重名才追加窗口编号**，所以任一窗口的文件变化都要重算所有窗口标题。

新窗口继承 `WindowConfig`，但绝不继承 `filePath` —— 这正是 filePath 被排除在 `WindowConfig` 之外的原因。
业务想让某个偏好参与继承，往 `WindowConfig` 加字段即可，主进程只透传不解释。

### 初始化时序（改渲染层状态同步时务必注意）

渲染层挂载时 store 里是**占位状态**，真实配置要等 `getInitConfig` 返回才落地。
因此 `reportWindowState` 被 `isInitialized` 门控：初始化完成前一律不上报。

去掉这道门控会引入一个真实存在过的 bug——占位主题抢先上报，覆写主进程的 `entry.config`；
dev 的 StrictMode 下 effect 双跑，第二次 `getInitConfig` 的 fallback 又把这个被污染的值读回来，
最终首窗主题解析错误、并把错误值写进 `settings.json` 影响后续启动。

### 主题与持久化

优先级：用户持久化的选择 > 系统外观。首窗口由主进程 `resolveInitialConfig()` 定夺，
新窗口继承自打开它的窗口。渲染层不读 `prefers-color-scheme`，一切以主进程下发的为准。

**只有 `settings:set-theme` 会写主题偏好**，且只在用户显式切换时调用（`App.handleToggleTheme`
是唯一入口，store 刻意不提供 `toggleTheme`）。`window:report-state` 只做状态同步、不碰持久化——
两者混在一条通道上，会把首次启动解析出的系统外观记成「用户选择」，`AppSettings.theme` 为 null
时的「跟随系统」语义就永久失效了。

窗口尺寸在 resize 防抖后写盘，但全屏 / 最大化时跳过（那是临时态），恢复时按屏幕工作区钳制。

### CSP 与 Monaco

生产环境的 CSP 由 `electron.vite.config.ts` 的 `injectCspPlugin` 在 **build 时**注入 HTML meta，
且用 `injectTo: 'head-prepend'` 保证它排在 Vite 注入的 script 之前（排在后面等于不生效）。

不能写死在 `index.html` 里：dev 模式下 React Fast Refresh 会注入内联脚本，严格的 `script-src` 会拦掉热更新。
打包后走 `file://` 加载，`webRequest.onHeadersReceived` 不生效，所以也不能用响应头下发。

Diff 双栏用的 Monaco（精确锁定 `0.56.0`）随应用打包、首次打开时懒加载；它的 Worker 依赖 renderer 段的
`worker: { format: 'es' }` 和 CSP 里的 `worker-src 'self' blob:`，改这两处要回归 Diff 页。

### 依赖分区规则

只有主进程 / preload / Worker 在运行时 `require` 的包（目前为 `ali-oss`、`diff`，典型还有原生模块）才放 `dependencies`；
React、Zustand、Monaco 等渲染层依赖一律放 `devDependencies` —— 它们会被 Vite 打进 bundle，
留在 `dependencies` 会让 electron-builder 把 `node_modules` 再塞进 asar 一份，白白增大安装包。
`externalizeDepsPlugin()` 按 `dependencies` 决定主进程 bundle 的 external 列表。

### 依赖版本

**Electron 必须跟随官方维护窗口**（只维护最近三个大版本），落在窗口外就拿不到 Chromium 安全修复。
React / Tailwind / Zustand / TypeScript 不承担安全补丁职责，可以锁定大版本。

## 参考文档

- `README.md` — 同步 / Diff / 文本编辑的**行为规格**（覆盖判定表、大小上限、并发、取消语义、
  `.oss-client-sync-<UUID>` 临时目录命名空间等）。改这些行为时同步更新 README。
- `docs/oss-sdk-notes.md` — ali-oss SDK 速查，含从源码确认的默认值与 `@types` 的已知偏差。
- `sxw_aicoding/实施方案/`、`sxw_aicoding/代码评审/` — 按日期命名的实施方案与代码评审报告，想弄清某个设计决定的来由时先查这里。

## 约定

- UI 文案、菜单标签、代码注释、提交信息一律中文（zh-CN）
- macOS 优先：Cmd 快捷键、`hiddenInset` 标题栏（配套 `.titlebar-drag` / `.titlebar-no-drag`）、只打 `--mac`
- Tailwind 用 class 暗色策略，由 store 的 `theme` 驱动 `document.documentElement.classList.toggle('dark', ...)`
- 注释解释「为什么」，不复述代码本身在做什么
