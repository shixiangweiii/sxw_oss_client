# Electron Mac Scaffold

本文件为 Claude Code（claude.ai/code）提供本仓库的工作指引。

## 命令

```bash
npm run dev           # electron-vite 开发服务器
npm run typecheck     # 两套 tsconfig 分别做类型检查
npm run lint          # ESLint（lint:fix 自动修复）
npm run format        # Prettier（format:check 只校验）
npm run build         # typecheck + 构建三进程产物
npm run preview       # 用构建产物启动，接近打包后的运行方式
npm run package       # 构建并打 macOS dmg
```

没有测试框架。`npm run typecheck && npm run lint && npm run build` 是唯一的静态验证手段；
涉及窗口行为、主题持久化、打包产物的改动，需要实际启动应用验证。

`.npmrc` 的依赖解析走 npm 官方源，只有 Electron 二进制走 npmmirror CDN，不要把 registry 一起改成镜像。

`AGENTS.md` 是本文件的精简副本，架构说明变更时保持两者一致。

## 架构

三进程结构，进程边界是硬的（`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`）：

- **`src/shared/`** — 两侧共用的类型与常量，**不依赖 electron 运行时**。`constants.ts` 是 IPC 通道名的唯一来源，`types.ts` 定义 `WindowConfig` / `ElectronAPI` / `MenuAction`，`path.ts` 的 `fileName` 被主进程和渲染层共用。
- **`src/main/`** — `index.ts` 启动并在窗口集合变化时重建菜单；`window.ts` 创建窗口、恢复尺寸、cascade 错开；`windowManager.ts` 管注册表、编号、标题组装；`menu.ts` 通过 `menu:action` 投递动作；`ipc.ts` 注册全部 handler；`settings.ts` 读写 `userData/settings.json`。
- **`src/preload/index.ts`** — `electronAPI` 是渲染层能触达主进程的**全部**表面积，实现必须满足 `shared/types.ts` 的 `ElectronAPI` 接口。preload 只用 `ipcRenderer` / `contextBridge`，不碰 Node 内建（这是能开 `sandbox: true` 的前提，新增能力时别破坏它）。
- **`src/renderer/`** — React + Zustand + Tailwind，路径别名 `@` → `src/renderer`。

### 新增 IPC 通道的四步

`shared/constants.ts` 登记通道名 → `shared/types.ts` 补类型并挂到 `ElectronAPI` →
`main/ipc.ts` 实现 handler → `preload/index.ts` 暴露方法。

第 2、4 步有 `ElectronAPI` 接口兜底，漏了 TS 会报错。**第 3 步没有类型关联**——忘记注册
handler 要到运行时才会报 `No handler registered`，改完记得跑一次。

### 窗口标题与配置继承

标题一律由主进程组装，渲染层只通过 `reportWindowState` 上报 `{ filePath, config }`。

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

### CSP

生产环境的 CSP 由 `electron.vite.config.ts` 的 `injectCspPlugin` 在 **build 时**注入 HTML meta，
且用 `injectTo: 'head-prepend'` 保证它排在 Vite 注入的 script 之前（排在后面等于不生效）。

不能写死在 `index.html` 里：dev 模式下 React Fast Refresh 会注入内联脚本，严格的 `script-src` 会拦掉热更新。
打包后走 `file://` 加载，`webRequest.onHeadersReceived` 不生效，所以也不能用响应头下发。

### 依赖分区规则

只有主进程 / preload 在运行时 `require` 的包（典型是原生模块）才放 `dependencies`；
React、Zustand 等渲染层依赖一律放 `devDependencies` —— 它们会被 Vite 打进 bundle，
留在 `dependencies` 会让 electron-builder 把 `node_modules` 再塞进 asar 一份，白白增大安装包。
`externalizeDepsPlugin()` 按 `dependencies` 决定主进程 bundle 的 external 列表。

### 依赖版本

**Electron 必须跟随官方维护窗口**（只维护最近三个大版本），落在窗口外就拿不到 Chromium 安全修复。
React / Tailwind / Zustand / TypeScript 不承担安全补丁职责，可以锁定大版本。

## 约定

- UI 文案、菜单标签、代码注释、提交信息一律中文（zh-CN）
- macOS 优先：Cmd 快捷键、`hiddenInset` 标题栏（配套 `.titlebar-drag` / `.titlebar-no-drag`）、只打 `--mac`
- Tailwind 用 class 暗色策略，由 store 的 `theme` 驱动 `document.documentElement.classList.toggle('dark', ...)`
- 注释解释「为什么」，不复述代码本身在做什么
