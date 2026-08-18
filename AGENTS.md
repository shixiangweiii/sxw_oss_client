# Electron Mac Scaffold

macOS 桌面应用脚手架：Electron 33 + React 18 + TypeScript + Zustand + Tailwind 3，electron-vite 构建。

## 命令

`npm run dev` / `npm run typecheck` / `npm run lint` / `npm run build` / `npm run package`

无测试框架，`typecheck + lint + build` 是唯一验证手段。

## 架构要点

三进程，边界硬（`contextIsolation: true`、`nodeIntegration: false`）：

- `src/shared/` — 两侧共用类型与常量，不依赖 electron 运行时
- `src/main/` — `index.ts` 启动 / `window.ts` 建窗 / `windowManager.ts` 标题与注册表 / `menu.ts` 菜单 / `ipc.ts` handler / `settings.ts` 持久化
- `src/preload/index.ts` — `electronAPI` 是渲染层的全部能力边界
- `src/renderer/` — React + Zustand + Tailwind

**新增 IPC 通道**：`shared/constants.ts` 登记 → `shared/types.ts` 补类型并挂到 `ElectronAPI` → `main/ipc.ts` 实现 → `preload/index.ts` 暴露。

**窗口标题**由主进程组装，渲染层只上报状态；`updateWindowConfig` 必须先于 `setWindowFilePath`。
有文件时只显示文件名，重名才加编号，因此任一窗口变化都要重算全部标题。

**配置继承**：新窗口继承 `WindowConfig`，绝不继承 `filePath`。加字段到 `WindowConfig` 即可参与继承。

**主题优先级**：用户持久化选择 > 系统外观，由主进程下发，渲染层不自行读 `prefers-color-scheme`。

**CSP** 仅在 build 时注入 HTML meta（`electron.vite.config.ts`），dev 注入会拦掉 Fast Refresh。

**依赖分区**：只有主进程/preload 运行时 require 的包（原生模块）放 `dependencies`；渲染层依赖放 `devDependencies`，否则 electron-builder 会把 node_modules 重复塞进 asar。

## 约定

中文文案与注释；macOS 优先（Cmd 快捷键、`hiddenInset`、只打 `--mac`）；Tailwind class 暗色策略。
