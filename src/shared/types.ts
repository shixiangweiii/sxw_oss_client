export type Theme = 'dark' | 'light'

/**
 * 新窗口从「打开它的那个窗口」继承的配置。
 *
 * 扩展点：业务想让某个偏好在新窗口间传递（编辑模式、缩放比例、侧栏开关……），
 * 加一个字段到这里就够了，主进程只负责原样透传、不解释具体含义。
 *
 * 注意 filePath 刻意不在这里 —— 一旦混进来，新窗口就会继承父窗口的文件。
 */
export interface WindowConfig {
  theme: Theme
}

/** 渲染进程上报的窗口状态。窗口标题由主进程统一组装，渲染层不直接设置标题。 */
export interface WindowState {
  filePath: string | null
  config: WindowConfig
}

export interface InitConfig {
  windowNumber: number
  config: WindowConfig
}

/** 与 Electron 的 FileFilter 结构一致，单独定义以免 shared 层依赖 electron 类型 */
export interface FileFilter {
  name: string
  extensions: string[]
}

export interface FileResult {
  path: string
  content: string
}

export interface SaveResult {
  path: string
}

/** 菜单项投递给渲染进程的动作。新增菜单项时在这里加一个成员，TS 会提示所有该处理的地方。 */
export type MenuAction = 'file:open' | 'file:save' | 'file:save-as' | 'view:toggle-theme'

// ---------- OSS ----------

export interface OssBucketSummary {
  name: string
  /** bucket 所在地域，如 oss-cn-hangzhou-a */
  region: string
  /** 创建时间（GMT 字符串） */
  creationDate: string
  /** Standard / IA / Archive */
  storageClass: string
}

export interface OssObjectSummary {
  /** 完整 object key，如 dir/sub/a.txt */
  name: string
  lastModified: string
  etag: string
  /** 字节数 */
  size: number
  /** Normal / Multipart / Appendable */
  type: string
  storageClass: string
}

export interface OssObjectListing {
  bucket: string
  /** 本次列出的目录前缀（不含 delimiter 的公共前缀） */
  prefix: string
  /** 当前层级的文件 */
  objects: OssObjectSummary[]
  /** 当前层级的子目录（以 / 结尾的公共前缀） */
  prefixes: string[]
  isTruncated: boolean
  nextContinuationToken: string | null
}

/** OSS 错误的结构化回传。requestId 可直接提交给阿里云排查 */
export interface OssErrorInfo {
  message: string
  code?: string
  status?: number
  requestId?: string
}

/** OSS 连接信息（当前来自主进程 .env 解析） */
export interface OssConnectionInfo {
  /** .env 里 oss_bucket 指定的默认 bucket，用于首屏自动进入 */
  defaultBucket: string | null
  syncDirLocal: string | null
  syncConfigError: string | null
}

export type SyncDirection = 'download' | 'upload'
export type SyncDownloadMode = 'merge' | 'original'
export interface SyncPrecheckSummary {
  checked: number
  total: number
  different: number
  unavailable: number
  failed: number
}
export type SyncPhase =
  | 'scanning'
  | 'prechecking'
  | 'choosing'
  | 'merging'
  | 'comparing'
  | 'confirming'
  | 'transferring'
  | 'cancelling'
  | 'success'
  | 'partial'
  | 'cancelled'
  | 'failed'
export interface SyncState {
  taskId: string
  revision: number
  direction: SyncDirection
  bucket: string
  localDir: string
  phase: SyncPhase
  discovered: number
  total: number | null
  processed: number
  created: number
  overwritten: number
  merged: number
  downloadMode: SyncDownloadMode | null
  precheck: SyncPrecheckSummary | null
  unchanged: number
  skipped: number
  failed: number
  currentFile: string | null
  issueCount: number
  issueRevision: number
  message: string | null
}
export interface SyncIssue {
  /** 对象相关记录统一使用 key；清理及任务级问题可使用实际路径。 */
  path: string
  localPath?: string
  phase: string
  kind: 'error' | 'skip' | 'merge' | 'check'
  message: string
  requestId?: string
}
export interface SyncIssuePage {
  items: SyncIssue[]
  total: number
}

/** 内容版本来自实际读取响应，不能从列表推测。 */
export interface OssObjectVersion {
  etag: string
  versionId: string | null
}

export interface OssTextSaveResult {
  key: string
  size: number
  version: OssObjectVersion
}

/** 文本文件的在线预览/编辑内容，UTF-8 编码 */
export interface OssTextContent {
  version: OssObjectVersion
  key: string
  content: string
  /** 字节数（不是字符数） */
  size: number
}

export type DiffPhase =
  'scanning' | 'comparing' | 'cancelling' | 'success' | 'partial' | 'cancelled' | 'failed'
export interface DiffScanState {
  taskId: string
  bucket: string
  localDir: string
  phase: DiffPhase
  discovered: number
  total: number | null
  processed: number
  different: number
  unchanged: number
  uncompared: number
  currentFile: string | null
  stale: boolean
  completedAt: string | null
  message: string | null
}
/** 状态只返回当前窗口的会话，busy 表示全应用的 Diff 读取占用。 */
export interface DiffSnapshot {
  revision: number
  busy: boolean
  state: DiffScanState | null
}
export interface DiffFileMeta {
  size: number
  modifiedAt: string | null
  fingerprint: string
}
export interface DiffEntry {
  key: string
  local: DiffFileMeta
  remote: DiffFileMeta
}
export interface DiffIssue {
  key: string
  message: string
  requestId?: string
}
export interface DiffPage<T> {
  items: T[]
  total: number
}
export interface DiffText extends DiffFileMeta {
  content: string
  bom: boolean
  eol: string
  finalNewline: boolean
}
export type DiffReadResult =
  | {
      kind: 'different'
      key: string
      local: DiffText
      remote: DiffText
      readAt: string
      changed: boolean
    }
  | { kind: 'identical' | 'unavailable'; key: string; message: string }

/**
 * OSS 通道的统一返回形状。
 * 刻意不用 promise reject：ipcMain 抛出的自定义字段会在序列化时丢失、只剩 message，
 * code/requestId 这类对排障关键的信惁就没了，所以用可辨别的 Result 交 union 显式携带。
 */
export type OssResult<T> = { ok: true; data: T } | { ok: false; error: OssErrorInfo }

/** 持久化到 userData/settings.json 的内容 */
export interface AppSettings {
  /**
   * null 表示用户从未手动切换过，此时跟随系统外观。
   * 只有 settings:set-theme 会写这个字段——即只有用户显式切换才落盘，
   * 否则首次启动解析出的系统外观会被记成"用户选择"，"跟随系统"就永久失效了。
   */
  theme: Theme | null
  windowBounds: { width: number; height: number } | null
}

/** preload 通过 contextBridge 暴露给渲染进程的全部能力 */
export interface ElectronAPI {
  startOssDiff: () => Promise<OssResult<{ taskId: string }>>
  cancelOssDiff: (taskId: string) => Promise<OssResult<null>>
  getOssDiffState: () => Promise<DiffSnapshot>
  onOssDiffState: (callback: (snapshot: DiffSnapshot) => void) => () => void
  getOssDiffEntries: (taskId: string, offset: number) => Promise<OssResult<DiffPage<DiffEntry>>>
  getOssDiffIssues: (taskId: string, offset: number) => Promise<OssResult<DiffPage<DiffIssue>>>
  readOssDiff: (
    taskId: string,
    key: string,
    requestId: string
  ) => Promise<OssResult<DiffReadResult>>
  cancelOssDiffRead: (taskId: string, requestId: string) => Promise<OssResult<null>>
  endOssDiff: (taskId: string) => Promise<OssResult<null>>
  startOssSync: (direction: SyncDirection) => Promise<OssResult<{ taskId: string }>>
  cancelOssSync: (taskId: string) => Promise<OssResult<null>>
  getOssSyncState: () => Promise<SyncState | null>
  getOssSyncIssues: (taskId: string, offset: number) => Promise<SyncIssuePage>
  onOssSyncState: (callback: (state: SyncState) => void) => () => void
  /** 主进程同步检查任务，避免进度事件尚未到达时卸载页面。 */
  checkSyncUnload: () => boolean

  /** beforeunload 必须同步取得决定；保存中始终阻止关闭。 */
  confirmWindowClose: (saving: boolean) => boolean
  openFile: (filters?: FileFilter[]) => Promise<FileResult | null>
  /** filePath 非空时直接覆盖写入，为空时弹出「另存为」对话框 */
  saveFile: (
    content: string,
    filePath: string | null,
    filters?: FileFilter[]
  ) => Promise<SaveResult | null>
  saveFileAs: (content: string, filters?: FileFilter[]) => Promise<SaveResult | null>
  newWindow: (config?: WindowConfig) => Promise<void>
  reportWindowState: (state: WindowState) => Promise<void>
  /** 仅在用户显式切换外观时调用，用于持久化偏好 */
  setThemePreference: (theme: Theme) => Promise<void>
  getInitConfig: () => Promise<InitConfig>
  /** 返回取消订阅函数 */
  onMenuAction: (callback: (action: MenuAction) => void) => () => void
  listOssBuckets: () => Promise<OssResult<OssBucketSummary[]>>
  /** prefix 为空字符串表示 bucket 根目录；continuationToken 用于翻页 */
  listOssObjects: (
    bucket: string,
    prefix: string,
    continuationToken?: string | null
  ) => Promise<OssResult<OssObjectListing>>
  getOssConfig: (reload?: boolean) => Promise<OssResult<OssConnectionInfo>>
  /** 拉取文本文件内容（UTF-8）。超过大小上限会返回错误 */
  getOssObjectText: (bucket: string, key: string) => Promise<OssResult<OssTextContent>>
  /** 用编辑后的内容覆盖原对象（UTF-8） */
  putOssObjectText: (
    bucket: string,
    key: string,
    content: string,
    version: OssObjectVersion
  ) => Promise<OssResult<OssTextSaveResult>>
}
