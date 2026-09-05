# OSS Client

面向阿里云 OSS 的 macOS 桌面客户端，基于 electron-mac-scaffold 脚手架创建：
Electron + React 18 + TypeScript + Zustand + Tailwind，用 electron-vite 构建。
脚手架自带多窗口管理、文件读写、原生菜单、主题持久化与打包配置，`npm run dev` 就能出窗口。

## 快速开始

```bash
npm install
npm run dev
```

## 脚本

| 命令                              | 作用                                                   |
| --------------------------------- | ------------------------------------------------------ |
| `npm run dev`                     | 启动开发服务器，主进程与渲染进程都支持热更新           |
| `npm test`                        | 状态与 OSS 服务回归测试（内存替身，不连接真实 OSS）    |
| `npm run test:electron`           | 构建并启动隔离 Electron，验证 IPC、编辑与关闭流程      |
| `npm run typecheck`               | 分别按 node / web 两套 tsconfig 做类型检查             |
| `npm run build`                   | 先 typecheck，再构建三个进程的产物到 `out/`            |
| `npm run preview`                 | 用构建产物启动应用（不带热更新，接近打包后的运行方式） |
| `npm run lint` / `lint:fix`       | ESLint 检查 / 自动修复                                 |
| `npm run format` / `format:check` | Prettier 格式化 / 校验                                 |
| `npm run package`                 | 构建并打出 macOS dmg 到 `dist/`                        |
| `npm run make-icon`               | 重新生成 `resources/icon.png` 与 `icon.icns`           |

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

## OSS 接入约定

`ali-oss` 已放在 `dependencies`（主进程运行时 require，`externalizeDepsPlugin()` 会保持 external 并随包分发），
`@types/ali-oss` 在 `devDependencies`。接入业务时遵守：

- **SDK 只在主进程用**：`ali-oss` 依赖 Node 运行时，浏览器/渲染进程里跑不起来。
  `src/main/oss.ts` 维护客户端实例（当前从项目根 `.env` 读 region / bucket / 凭据，
  dev 专用、已进 .gitignore；后续换成凭据管理 UI + safeStorage），
  渲染进程一律通过 IPC 调用，照「怎么新增一个 IPC 通道」四步走
- **凭据只存主进程**：AccessKeySecret 绝不流经渲染层；`.env` 只在 dev 生效，
  打包后的凭据落盘后续用 `safeStorage` 加密，别明文写进 settings.json
- **文件对话框复用**：上传选文件 / 下载存文件可以直接复用现有的 `file:open` / `file:save`
  通道与过滤器机制

SDK 用法速查见 `docs/oss-sdk-notes.md`（基于官方文档 + 本地源码整理，含与桌面客户端的功能映射表）。

## 本地目录与 OSS 同步

在开发环境的 `.env` 中配置绝对路径：

```dotenv
sync_dir_local=/Users/你的用户名/Desktop/all-in-one
```

点击刷新重新加载配置后，Bucket 顶部显示“同步到本地”和“同步到云端”。根目录直接对应：本地 `all-in-one/docs/a.md` 对应云端 `docs/a.md`。未配置本地目录不影响 OSS 浏览；下载时可以创建缺失的根目录，上传时根目录必须已经存在。

| 当前状态           | 同步到本地             | 同步到云端   |
| ------------------ | ---------------------- | ------------ |
| 两端都有且内容相同 | 跳过，不改本地修改时间 | 跳过，不上传 |
| 两端都有但内容不同 | 云端覆盖本地           | 本地覆盖云端 |
| 仅云端有           | 下载                   | 保留云端文件 |
| 仅本地有           | 保留本地文件           | 上传         |

- 递归处理普通文件，包括隐藏文件（如 `.env`）、无扩展名文件和二进制文件，保留空目录；不使用 `.gitignore` 等排除规则，不受文本编辑器 2 MB 上限约束。
- 不传播删除；删除后反向同步会恢复来源端仍然存在的文件。没有定时任务、文件监听、历史记录或跨任务断点续传。
- 内容比较使用原始字节的 SHA-256；大小不同直接覆盖，大小相同时需要读取两端内容，不能把 multipart ETag 当成 MD5。因此“相同跳过”仍可能有云端读取流量。
- 下载先写同文件系统临时文件，完整成功后原子替换；上传先复制为稳定快照。不会用半个下载文件覆盖已有文件，也不会在上传期间混入后续输入。
- 小于 64 MiB 使用普通上传，达到 64 MiB 使用 SDK 分片 API。初始分片 16 MiB、并发 3，根据 10,000 分片限制调整大小；显式等待全部在途分片结束后再清理，避免 SDK 高级并发接口提前返回导致残留。每个 OSS 请求超时 120 秒。
- 全应用只允许一个同步任务；所有窗口共享进度。同步时禁用连接刷新和在线文本保存，已有草稿保留；在线保存进行中不能开始同步。
- 可以取消同步，或在关闭/退出/刷新页面时选择“继续同步”或“取消同步后继续操作”。流式读取尽快中止，已提交的上传请求需等待结束或超时，未完成的分片任务尝试清理。取消不回滚已经完成的文件，之后仍会检查编辑器未保存草稿。
- 任务面板区分全部成功、部分失败、取消和任务失败，显示新增、覆盖、内容相同、其他跳过、失败计数及分页详情。单文件失败会继续；根目录或扫描失败会终止任务。归档对象未恢复、无权限等错误会显示在详情中，不自动改变存储状态。
- 两种同步方向均按本地卷规则检查大小写/Unicode 名称碰撞，避免上传出无法再下载到本地的重复目录树；冲突时跳过，不合并或重命名云端 key。跳过符号链接、特殊文件、越界 key 和文件/目录同名冲突。非零字节的 `/` 结尾对象无法映射为目录，也会跳过；不会为处理冲突删除或重命名用户内容。macOS/POSIX 支持名称内部的反斜杠（如 `notes/a\b.txt`），按普通字符原样映射；仍拒绝以反斜杠开头的 key、绝对路径、NUL 和 `..` 路径分量。
- 同步文件内容与目录结构，不从云端复制权限、属主、时间或扩展属性；覆盖已有文件保留其基本读写执行位，新增文件默认 0600（受 umask 影响）。它不是目录级原子快照；扫描后新出现的文件留到下轮，读取前已变化的文件报错。上传以本次本地快照为准，外部客户端并发写入的最终结果取决于提交顺序。
- 临时目录包含归属标记，清单保存在 userData 的 `sync-temp-files.json`。启动/下次同步会逐条恢复：可确认归属的残留清理，无法确认的保留并报告具体路径，不再阻断其他文件同步。清单损坏时原样备份为 `sync-temp-files.corrupt-<UUID>.json`，保留可解析的有效记录后继续。
- `.oss-client-sync-<UUID>` 是本应用保留的临时目录命名空间。已登记残留及使用该命名的可疑目录不会上传或被同步覆盖；不会按前缀删除用户文件，`.oss-client-sync-user` 等普通隐藏目录不受影响。可按错误详情检查、手动处理残留后再次同步。缺失 owner 的空目录只有在记录的设备号和 inode 仍匹配时才自动清理。
- 文件提交成功与清理结果分别统计：清理失败不会把已经新增/覆盖的文件改计为传输失败，但任务会显示部分失败并列出清理错误。分片清理需要对应的 OSS 权限，失败同样单独报告。

`npm test` 包含真实临时目录测试、内存 OSS 替身，以及真实 `ali-oss` SDK 连接本机 HTTP 测试服务的验证。`npm run test:electron` 使用真实 Electron 和临时同步目录验证按钮、进度、多窗口互斥、取消与关闭保护；如当前 macOS 无法完成全屏动画，可用 `npm run test:electron:sync` 在窗口模式运行相同同步业务验证（该命令不验证原生全屏）；均不读取实际 `.env`，不触碰真实同步目录或真实 Bucket。

## 文本编辑与冲突处理

- 保存期间可以继续输入；“已保存”只对应本次提交的内容，后续输入仍保留为未保存草稿。
- 读取和保存共用 2 MB 的 UTF-8 字节上限，超过上限时保留草稿并禁止保存。
- 读取响应和保存响应绑定编辑会话；目录请求绑定刷新代次，过期响应不会覆盖当前状态。
- 返回列表、关闭窗口、退出应用和刷新页面都会保护未保存草稿。保存中先等待完成；有未保存修改时可取消或明确放弃，取消后可继续保存。
- `.env` 的重试/刷新会重新读取配置并重建当前窗口的客户端；其他窗口继续使用自己的连接快照。编辑期间不能切换连接。
- 保存会核对读取时的 ETag / versionId，同一个主进程对同一 Bucket/key 的检查与写入串行执行，避免本客户端多个窗口互相覆盖。冲突时保留草稿，先复制需要的内容，再使用“重新读取”取得新版本。

**外部并发边界**：[OSS PutObject 官方文档](https://www.alibabacloud.com/help/en/oss/developer-reference/putobject) 未提供目标对象的 ETag 条件覆盖参数，因此这里没有使用未经支持确认的 `If-Match` 写入头。版本检查可以发现写入前已发生的外部修改，但其他进程/客户端恰好在 HEAD 与 PUT 之间写入仍有竞态；本地串行锁不提供跨客户端原子性。读取的 HEAD/GET 则使用 GET 支持的 `If-Match` 绑定内容版本。

`npm test` 直接在内存中执行当前 TypeScript 源码，模拟 IPC/SDK 边界；`npm run test:electron` 使用真实 Electron、构建后的 preload 和渲染页面，但替换 OSS 和原生确认框的选择结果，并使用独立临时 userData。两者都不会读取实际 `.env` 或写入真实 OSS；本机 HTTP 用例只验证 SDK 协议调用，不代表阿里云真实网络与权限环境的验证。

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
- Vitest / jsdom 等测试框架（已有 Node 内置运行器回归测试和 Electron 冒烟脚本）
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
