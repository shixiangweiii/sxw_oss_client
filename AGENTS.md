# OSS Client

面向阿里云 OSS 的 macOS 桌面客户端：Electron 43 + React 18 + TypeScript + Zustand + Tailwind 3，electron-vite 构建。基于 electron-mac-scaffold 创建，脚手架的基础设施约定仍然全部适用。

## 命令

`npm run dev` / `typecheck` / `lint` / `format` / `build` / `preview` / `package`

`npm test`（Node 内置运行器，单文件 `node --test scripts/tests/xxx.test.mjs`）；`npm run test:electron` 先 build 再用真实 Electron 冒烟，`test:electron:sync` 为窗口模式。测试全用临时目录与 OSS 替身，不读实际 `.env`、不碰真实 Bucket。完整验证是 `typecheck + lint + test + build`；窗口行为、持久化、打包相关改动需实际启动验证。

测试加载器 `scripts/tests/source-loader.mjs` 用 `ts.transpileModule` 逐文件执行源码、相对导入按「路径 + `.ts`」解析；Worker 测试将同名 `.js` 入口映射到当前 `.ts`，在真实线程内加载源码，不依赖旧 `out/`：被测模块的运行时导入不能用 `@/` 别名、不能导入 `.tsx`。

## 架构要点

三进程，边界硬（`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`）：

- `src/shared/` — 两侧共用类型与常量，不依赖 electron 运行时
- `src/main/` — 业务逻辑与 Electron 胶水分开：`sync.ts` / `syncFiles.ts` / `syncPrecheck.ts` / `textMerge.ts` / `textMergeCore.ts` / `textMergeFormat.ts` / `diff.ts` / `diffFiles.ts` / `diffResults.ts` / `operations.ts` 不 import `electron`（可被 Node 测试直接加载）；`syncRuntime.ts` / `diffRuntime.ts` 负责 IPC、下载模式选择和逐文件覆盖确认；`oss.ts` 管 SDK 连接；另有 `window.ts` / `windowManager.ts` / `menu.ts` / `ipc.ts` / `settings.ts`
- `src/preload/index.ts` — `electronAPI` 是渲染层的全部能力边界；只用 `ipcRenderer` / `contextBridge`，不碰 Node 内建（`sandbox: true` 的前提）
- `src/renderer/` — React + Zustand + Tailwind

**新增 IPC 通道**：`shared/constants.ts` 登记 → `shared/types.ts` 补类型并挂到 `ElectronAPI` → 主进程实现（按功能放 `ipc.ts` / `syncRuntime.ts` / `diffRuntime.ts`）→ `preload/index.ts` 暴露。第 2、4 步 TS 会兜底，**第 3 步没有类型关联**，漏了要到运行时才报错。

**IPC 约定**：OSS / sync / diff handler 统一返回 `OssResult<T>`（错误经 `toOssError` 压平），不走 reject——自定义字段（requestId 等）跨进程会丢。主进程推送有 `menu:action`、`oss:sync-state`（全窗口共享）、`oss:diff-state`（结果只属于发起窗口）；`window:confirm-close`、`oss:sync-check-unload` 是给 `beforeunload` 用的 sendSync 通道。

**OSS 连接**：`ali-oss` 只在主进程用，Secret 不进渲染层；凭据暂从 dev 的 `.env` 读（打包后不读）。连接按 webContents.id 隔离，同步 / Diff 每个任务新建 SDK 实例。

**文本合并**：编辑 / Diff / 合并输入与输出统一为 5 MB。`textMerge.ts` 管理 Worker 与取消，`textMergeWorker.ts` 是独立构建入口；计算、格式处理和结果组装在线程内完成。终止时必须等待 Worker 退出再释放同步占用。预检查最多 3 对并发，取消等待全部在途读取；内容相同也在执行时复核云端版本。检查详情与执行结果按文件更新，`issueRevision` 防止同数量更新留下旧分页。

**全局互斥**（`operations.ts`）：同步、Diff、在线保存三者互斥，「检查 + 占用」之间不能插 await。关闭 / 退出 / 刷新保护由 `syncRuntime.ts`（同步中拦截 close / before-quit）与 `closeGuard.ts`（beforeunload 查同步与草稿）两层叠加。

**窗口标题**由主进程组装，渲染层只上报状态。`composeTitle` 当前只读 `filePath` 与窗口编号、**不读 config**；`updateWindowConfig` 先于 `setWindowFilePath` 只是为将来预留的约定。若让 config 参与标题，还需同步放宽 `setWindowFilePath` 的早退条件。

**初始化时序**：`reportWindowState` 被 `isInitialized` 门控，初始化完成前不上报——否则占位主题会覆写主进程 config，StrictMode 下还会被 `getInitConfig` 的 fallback 读回来，导致首窗主题错误并污染 settings。

**配置继承**：新窗口继承 `WindowConfig`，绝不继承 `filePath`。加字段到 `WindowConfig` 即可参与继承。

**主题**：优先级为用户持久化选择 > 系统外观，由主进程下发。只有 `settings:set-theme` 写偏好且仅在用户显式切换时调用；`window:report-state` 不碰持久化，否则「跟随系统」语义会失效。

**窗口尺寸**：resize 防抖写盘，全屏/最大化跳过，恢复时按工作区钳制。

**CSP** 仅在 build 时注入 HTML meta（`electron.vite.config.ts`），用 `head-prepend` 保证排在 script 之前；dev 注入会拦掉 Fast Refresh。Monaco Worker 依赖 `worker: { format: 'es' }` 与 CSP 的 `worker-src 'self' blob:`。

**依赖分区**：只有主进程/preload/Worker 运行时 require 的包（当前 `ali-oss`、`diff`，也包括原生模块）放 `dependencies`；渲染层依赖放 `devDependencies`，否则 electron-builder 会把 node_modules 重复塞进 asar。

**依赖版本**：Electron 必须跟随官方维护窗口（最近三个大版本）；React / Tailwind 等可锁定大版本。

README 记录同步 / Diff / 文本编辑的行为规格，改行为时同步更新；`docs/oss-sdk-notes.md` 是 SDK 速查；`sxw_aicoding/` 下是实施方案与代码评审报告。

## 约定

中文文案与注释；macOS 优先（Cmd 快捷键、`hiddenInset`、只打 `--mac`）；Tailwind class 暗色策略。
