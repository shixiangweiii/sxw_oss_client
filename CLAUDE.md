# Electron Mac Scaffold

本文件为 Claude Code（claude.ai/code）提供本仓库的工作指引。

## 命令

```bash
npm run dev        # electron-vite 开发服务器
npm run typecheck  # 两套 tsconfig 分别做类型检查
npm run build      # typecheck + 构建三进程产物
npm run lint       # ESLint
npm run package    # 构建并打 macOS dmg
```

没有测试框架。`npm run typecheck && npm run lint && npm run build` 是唯一的验证手段。

`.npmrc` 的依赖解析走 npm 官方源，只有 Electron 二进制走 npmmirror CDN，不要把 registry 一起改成镜像。

`AGENTS.md` 是本文件的精简副本，架构说明变更时保持两者一致。

## 架构

三进程结构，进程边界是硬的（`contextIsolation: true`、`nodeIntegration: false`）：

- **`src/shared/`** — 两侧共用的类型与常量，**不依赖 electron 运行时**。`constants.ts` 是 IPC 通道名的唯一来源，`types.ts` 定义 `WindowConfig` / `ElectronAPI` / `MenuAction`，`path.ts` 的 `fileName` 被主进程和渲染层共用。
- **`src/main/`** — `index.ts` 启动并在窗口集合变化时重建菜单；`window.ts` 创建窗口、恢复尺寸、cascade 错开，并把继承配置暂存在 `pendingConfigs`；`windowManager.ts` 管注册表、编号、标题组装；`menu.ts` 通过 `menu:action` 投递动作；`ipc.ts` 注册全部 handler；`settings.ts` 读写 `userData/settings.json`。
- **`src/preload/index.ts`** — `electronAPI` 是渲染层能触达主进程的**全部**表面积，实现必须满足 `shared/types.ts` 的 `ElectronAPI` 接口。
- **`src/renderer/`** — React + Zustand + Tailwind，路径别名 `@` → `src/renderer`。

### 新增 IPC 通道的四步

`shared/constants.ts` 登记通道名 → `shared/types.ts` 补类型并挂到 `ElectronAPI` →
`main/ipc.ts` 实现 handler → `preload/index.ts` 暴露方法。漏任何一步 TS 都会报错。

### 窗口标题与配置继承

标题一律由主进程组装，渲染层只通过 `reportWindowState` 上报 `{ filePath, config }`。
`updateWindowConfig` 必须在 `setWindowFilePath` 之前调用，否则依赖 config 的标题会慢一拍。

有文件时标题只显示文件名，**仅当与其他窗口重名才追加窗口编号**，所以任一窗口的文件变化都要重算所有窗口标题。

新窗口继承 `WindowConfig`，但绝不继承 `filePath` —— 这正是 filePath 被排除在 `WindowConfig` 之外的原因。
业务想让某个偏好参与继承，往 `WindowConfig` 加字段即可，主进程只透传不解释。

### 主题与持久化

优先级：用户持久化的选择 > 系统外观。首窗口由主进程 `resolveInitialConfig()` 定夺，
新窗口继承自打开它的窗口。渲染层不读 `prefers-color-scheme`，一切以主进程下发的为准。

### CSP

生产环境的 CSP 由 `electron.vite.config.ts` 的 `injectCspPlugin` 在 **build 时**注入 HTML meta。
不能写死在 `index.html` 里：dev 模式下 React Fast Refresh 会注入内联脚本，严格的 `script-src` 会拦掉热更新。
打包后走 `file://` 加载，`webRequest.onHeadersReceived` 不生效，所以也不能用响应头下发。

### 依赖分区规则

只有主进程 / preload 在运行时 `require` 的包（典型是原生模块）才放 `dependencies`；
React、Zustand 等渲染层依赖一律放 `devDependencies` —— 它们会被 Vite 打进 bundle，
留在 `dependencies` 会让 electron-builder 把 `node_modules` 再塞进 asar 一份，白白增大安装包。
`externalizeDepsPlugin()` 按 `dependencies` 决定主进程 bundle 的 external 列表。

## 约定

- UI 文案、菜单标签、代码注释、提交信息一律中文（zh-CN）
- macOS 优先：Cmd 快捷键、`hiddenInset` 标题栏（配套 `.titlebar-drag` / `.titlebar-no-drag`）、只打 `--mac`
- Tailwind 用 class 暗色策略，由 store 的 `theme` 驱动 `document.documentElement.classList.toggle('dark', ...)`
- 注释解释「为什么」，不复述代码本身在做什么
