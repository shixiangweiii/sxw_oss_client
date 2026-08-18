# Electron Mac Scaffold

面向 macOS 桌面应用的脚手架：Electron + React 18 + TypeScript + Zustand + Tailwind，
用 electron-vite 构建。开箱带好多窗口管理、文件读写、原生菜单、主题持久化与打包配置，
`npm run dev` 就能出窗口。

## 快速开始

```bash
node scripts/init.mjs   # 交互式改名（应用名 / 包名 / appId / 作者），可跳过
npm install
npm run dev
```

## 脚本

| 命令                              | 作用                                                   |
| --------------------------------- | ------------------------------------------------------ |
| `npm run dev`                     | 启动开发服务器，主进程与渲染进程都支持热更新           |
| `npm run typecheck`               | 分别按 node / web 两套 tsconfig 做类型检查             |
| `npm run build`                   | 先 typecheck，再构建三个进程的产物到 `out/`            |
| `npm run preview`                 | 用构建产物启动应用（不带热更新，接近打包后的运行方式） |
| `npm run lint` / `lint:fix`       | ESLint 检查 / 自动修复                                 |
| `npm run format` / `format:check` | Prettier 格式化 / 校验                                 |
| `npm run package`                 | 构建并打出 macOS dmg 到 `dist/`                        |
| `npm run make-icon`               | 重新生成 `resources/icon.png` 与 `icon.icns`           |
| `node scripts/init.mjs`           | 交互式改名（应用名 / 包名 / appId / 作者），可反复执行 |

## 目录结构

```
src/
├── shared/            # 主进程与渲染进程共用的类型和常量，不依赖 electron 运行时
│   ├── constants.ts   # IPC 通道名
│   ├── types.ts       # 跨进程类型：WindowConfig / ElectronAPI / MenuAction …
│   └── path.ts        # 文件名提取，两侧共用同一实现
├── main/              # 主进程
│   ├── index.ts       # 启动、activate、window-all-closed
│   ├── menu.ts        # 菜单模板与快捷键，通过 menu:action 投递动作
│   ├── window.ts      # BrowserWindow 创建、尺寸恢复、cascade 错开
│   ├── windowManager.ts # 窗口注册表、编号、标题组装与重名消歧
│   ├── settings.ts    # userData/settings.json 读写
│   └── ipc.ts         # 所有 ipcMain.handle
├── preload/index.ts   # contextBridge 暴露的全部能力
└── renderer/          # React 界面
```

进程边界是硬的：渲染进程 `contextIsolation: true`、`nodeIntegration: false`，
拿不到 `require` / `fs` / `ipcRenderer`，只能调用 preload 暴露的具名方法。

## 内置能力

- **多窗口**：Cmd+N 新建，窗口编号、「窗口」菜单实时列表、焦点跟踪
- **窗口标题**：主进程统一组装。有文件时只显示文件名，**只有与其他窗口重名时才追加编号**
- **配置继承**：新窗口继承打开它的那个窗口的 `WindowConfig`，但不继承文件路径
- **文件读写**：打开 / 保存（有路径就地覆盖）/ 另存为，并设置 macOS 标题栏代理图标
- **原生菜单**：中文菜单 + 标准快捷键，菜单项与界面按钮共用同一套 handler
- **主题**：深浅色切换，优先级为「用户持久化选择 > 系统外观」
- **窗口尺寸记忆**：resize 防抖后写入 settings，新窗口相对当前窗口错开 24px
- **CSP**：生产构建时注入严格策略（见 `electron.vite.config.ts`），dev 不注入以免拦掉热更新
- **渲染进程沙箱**：`sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`，
  preload 只用 `ipcRenderer` / `contextBridge`，不依赖任何 Node 内建
- **外链白名单**：只有 `http` / `https` / `mailto` 会交给系统浏览器，其余 scheme 直接丢弃

## 怎么新增一个 IPC 通道

四步：

1. **登记通道名** — `src/shared/constants.ts` 的 `IPC_CHANNELS` 加一个成员
2. **定义类型** — `src/shared/types.ts` 里补参数/返回值类型，并在 `ElectronAPI` 接口上加方法签名
3. **主进程实现** — `src/main/ipc.ts` 里 `ipcMain.handle(IPC_CHANNELS.XXX, ...)`
4. **preload 暴露** — `src/preload/index.ts` 的 `electronAPI` 对象加对应实现

第 2、4 步漏了 TS 会直接报错（`ElectronAPI` 接口双向约束 preload 实现与渲染层调用）。
但**第 3 步没有类型兜底**：通道常量与 `ipcMain.handle` 之间没有类型关联，忘记注册 handler
要到运行时调用才会失败（报 `No handler registered for '<通道名>'`），记得跑一次验证。

渲染层通过 `window.electronAPI?.xxx()` 调用，类型自动来自 `ElectronAPI`。

主进程要主动通知渲染进程时，走已有的 `menu:action` 模式：
`webContents.send(通道, 载荷)` + preload 里包一个返回退订函数的 `onXxx(callback)`。

## 怎么新增一个 store slice

1. 建 `src/renderer/store/xxxSlice.ts`，仿照 `uiSlice.ts` 写 `StateCreator`
2. 在 `store/types.ts` 定义接口，并并入 `StoreState`
3. 在 `store/index.ts` 里展开进 `create()`

## 怎么让配置在新窗口间传递

往 `src/shared/types.ts` 的 `WindowConfig` 加字段即可。主进程只负责原样透传，
不解释具体含义，所以不需要改 main 里的任何代码。

注意 `filePath` 刻意不在 `WindowConfig` 里 —— 一旦混进去，新窗口会继承父窗口的文件。

## 换应用图标

把 1024×1024 的 PNG 放到 `resources/icon.png`，然后：

```bash
npm run make-icon -- --keep-png
```

会用 macOS 自带的 `sips` / `iconutil` 生成 `resources/icon.icns`。
不加 `--keep-png` 则会重新绘制占位图并覆盖 PNG。

## 签名与公证

分发给他人前必须配置，本地自用可以跳过。`electron-builder.yml` 里已经留好注释掉的配置项：

1. `mac.identity` 填签名身份（`security find-identity -v -p codesigning` 可列出）
2. 打开 `hardenedRuntime` 并提供 entitlements plist
3. 打开 `notarize`，凭据通过环境变量传入：`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`

## 依赖版本

版本策略分两类，**不要一刀切**：

- **Electron 必须跟随官方维护窗口。** 官方只维护最近三个大版本，落在窗口外意味着累积的
  Chromium 安全修复不会再回灌。脚手架当前用 Electron 43（Chromium 150 / Node 24）。
  开新项目前请确认它仍在维护窗口内，否则先升级——本仓库只用 `BrowserWindow` / `dialog` /
  `Menu` / `nativeTheme` / `screen` / `shell` 这些稳定 API，跨大版本升级通常改动很小。
- **React / Tailwind / Zustand / TypeScript 可以锁定。** 它们不承担安全补丁职责，锁在
  React 18 + Tailwind 3 是为了避免 Tailwind 4 的 CSS-first 配置改写和 React 19 的生态兼容验证。

`.npmrc` 的策略是：**依赖解析走 npm 官方源**（lockfile 里的 `resolved` 因此通用），
**只有 Electron 二进制和 electron-builder 工具链走 npmmirror 公网 CDN**（避免从 GitHub 拉取超时）。
海外或有稳定代理时，删掉 `.npmrc` 里那两行镜像配置即可。

## 依赖该放 dependencies 还是 devDependencies

反直觉但很重要：**React、Zustand 这类只有渲染层用的库要放 `devDependencies`。**

渲染层的代码会被 Vite 全量打进 `out/renderer/assets/*.js`，如果这些包同时还留在
`dependencies` 里，electron-builder 会把 `node_modules` 再原样塞进 asar 一份，
等于同样的代码打包两遍（实测 .app 因此多出约 26MB）。

`dependencies` 只放**主进程或 preload 在运行时真正 require 的包**，典型是原生模块
（`better-sqlite3`、`sharp` 之类）。`externalizeDepsPlugin()` 正是按 `dependencies`
把它们标成 external、不打进主进程 bundle，所以这类包必须留在 `dependencies` 里才能被正确分发。

## 没有内置的东西

以下都属于「看具体应用」的选择，刻意没放进主干，需要时自行接入：

- 自动更新（`electron-updater`）
- 国际化 / 多语言
- 自定义协议与深链接（`app.setAsDefaultProtocolClient`）
- 系统托盘（`Tray`）
- 崩溃上报（Sentry 等）
- 单元测试（Vitest；main 走 node 环境、renderer 走 jsdom，需要分别配置）
- Web Worker（在 `electron.vite.config.ts` 的 renderer 段加 `worker: { format: 'es' }`）
- 编辑器组件（Monaco 等）

## 跨平台

主干按 macOS 优先做的：`titleBarStyle: 'hiddenInset'`、`trafficLightPosition`、
Cmd 系快捷键、`window-all-closed` 不退出、只打 dmg。

要支持 Windows / Linux：

- 在 `electron-builder.yml` 增加 `win` / `linux` 段
- 在 `window.ts` 里按 `process.platform` 分支处理标题栏样式
- `src/shared/path.ts` 的 `fileName` 只按 `/` 切分，Windows 路径需要改成同时处理 `\`
  （或在主进程侧改用 Node 的 `basename`，但要保证渲染层拿到同样的结果）
