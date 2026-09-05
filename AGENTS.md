# OSS Client

面向阿里云 OSS 的 macOS 桌面客户端：Electron 43 + React 18 + TypeScript + Zustand + Tailwind 3，electron-vite 构建。基于 electron-mac-scaffold 创建，脚手架的基础设施约定仍然全部适用。

## 命令

`npm run dev` / `typecheck` / `lint` / `format` / `build` / `preview` / `package`

无测试框架，`typecheck + lint + build` 是静态验证；窗口行为、持久化、打包相关改动需实际启动验证。

## 架构要点

三进程，边界硬（`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`）：

- `src/shared/` — 两侧共用类型与常量，不依赖 electron 运行时
- `src/main/` — `index.ts` 启动 / `window.ts` 建窗 / `windowManager.ts` 标题与注册表 / `menu.ts` 菜单 / `ipc.ts` handler / `settings.ts` 持久化
- `src/preload/index.ts` — `electronAPI` 是渲染层的全部能力边界；只用 `ipcRenderer` / `contextBridge`，不碰 Node 内建（`sandbox: true` 的前提）
- `src/renderer/` — React + Zustand + Tailwind

**新增 IPC 通道**：`shared/constants.ts` 登记 → `shared/types.ts` 补类型并挂到 `ElectronAPI` → `main/ipc.ts` 实现 → `preload/index.ts` 暴露。第 2、4 步 TS 会兜底，**第 3 步没有类型关联**，漏了要到运行时才报错。

**窗口标题**由主进程组装，渲染层只上报状态。`composeTitle` 当前只读 `filePath` 与窗口编号、**不读 config**；`updateWindowConfig` 先于 `setWindowFilePath` 只是为将来预留的约定。若让 config 参与标题，还需同步放宽 `setWindowFilePath` 的早退条件。

**初始化时序**：`reportWindowState` 被 `isInitialized` 门控，初始化完成前不上报——否则占位主题会覆写主进程 config，StrictMode 下还会被 `getInitConfig` 的 fallback 读回来，导致首窗主题错误并污染 settings。

**配置继承**：新窗口继承 `WindowConfig`，绝不继承 `filePath`。加字段到 `WindowConfig` 即可参与继承。

**主题**：优先级为用户持久化选择 > 系统外观，由主进程下发。只有 `settings:set-theme` 写偏好且仅在用户显式切换时调用；`window:report-state` 不碰持久化，否则「跟随系统」语义会失效。

**窗口尺寸**：resize 防抖写盘，全屏/最大化跳过，恢复时按工作区钳制。

**CSP** 仅在 build 时注入 HTML meta（`electron.vite.config.ts`），用 `head-prepend` 保证排在 script 之前；dev 注入会拦掉 Fast Refresh。

**依赖分区**：只有主进程/preload 运行时 require 的包（原生模块）放 `dependencies`；渲染层依赖放 `devDependencies`，否则 electron-builder 会把 node_modules 重复塞进 asar。

**依赖版本**：Electron 必须跟随官方维护窗口（最近三个大版本）；React / Tailwind 等可锁定大版本。

## 约定

中文文案与注释；macOS 优先（Cmd 快捷键、`hiddenInset`、只打 `--mac`）；Tailwind class 暗色策略。
