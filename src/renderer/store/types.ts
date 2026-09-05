import type {
  OssObjectVersion,
  Theme,
  SyncDirection,
  SyncState,
  SyncIssue
} from '../../shared/types'

export interface UiSlice {
  theme: Theme
  /**
   * 主进程下发的初始配置是否已落地。
   * 在它变 true 之前，渲染层不得向主进程上报状态——否则会把占位值当成真实状态报上去。
   */
  isInitialized: boolean
  /** 主进程分配的窗口序号，用于在界面上区分多个窗口 */
  windowNumber: number
  toastMessage: string | null
  toastType: 'success' | 'error' | null

  setTheme: (theme: Theme) => void
  markInitialized: () => void
  setWindowNumber: (num: number) => void
  showToast: (message: string, type: 'success' | 'error') => void
  clearToast: () => void
}

export interface FileSlice {
  /** 当前窗口关联的文件完整路径，null 表示尚未关联任何文件 */
  filePath: string | null
  content: string

  setFile: (path: string | null, content: string) => void
  setFilePath: (path: string | null) => void
  clearFile: () => void
}

export type StoreState = UiSlice & FileSlice & OssSlice & SyncSlice

// ---------- OSS 文件树 ----------

/** 文件条目（object 已剥去所在目录前缀的部分由渲染层展示时处理，这里存完整 key） */
export interface OssFileEntry {
  /** 完整 object key */
  key: string
  size: number
  lastModified: string
  storageClass: string
}

/** 每个目录（含根 ''）的懒加载状态。status 为 loading 时保留已有内容，翻页不清屏 */
export interface OssDirState {
  expanded: boolean
  status: 'loading' | 'loaded' | 'error'
  /** 子目录的完整前缀（以 / 结尾） */
  dirs: string[]
  files: OssFileEntry[]
  /** 翻页游标，null 表示没有更多 */
  nextToken: string | null
  error: string | null
}

/** 文本编辑器状态。savedContent 与 draft 的差异即脏状态 */
export interface OssEditorState {
  sessionId: number
  bucket: string
  version: OssObjectVersion | null
  /** 正在编辑的 object key */
  key: string
  /** 服务端最新内容，保存成功后更新，用于脏检测 */
  savedContent: string
  draft: string
  status: 'loading' | 'loaded' | 'error' | 'saving'
  error: string | null
}

export interface OssSlice {
  syncDirLocal: string | null
  syncConfigError: string | null
  refreshBucket: () => void
  /** 当前浏览的 bucket；固定来自 .env 配置，null 表示尚未就绪 */
  activeBucket: string | null
  /** 连接配置错误（如 .env 未配置 oss_bucket） */
  configError: string | null
  /** 目录前缀 → 状态。根目录用空字符串作 key */
  dirStates: Record<string, OssDirState>
  /** 非空时渲染全屏编辑页，覆盖文件列表 */
  editor: OssEditorState | null

  /** 首屏引导：读连接配置并自动进入 .env 指定的默认 bucket */
  bootstrap: (reload?: boolean) => Promise<void>
  openBucket: (name: string) => void
  /** 展开已加载的目录 / 懒加载未加载目录 / 重试失败目录 */
  toggleDir: (prefix: string) => void
  loadMore: (prefix: string) => void
  /** 拉取某目录一页内容；通常不直接从 UI 调，而是经 openBucket/toggleDir/loadMore */
  fetchDirPage: (bucket: string, prefix: string, token: string | null) => Promise<void>
  /** 拉取文本内容并进入编辑页 */
  openTextFile: (key: string) => void
  setEditorDraft: (content: string) => void
  /** 把当前草稿覆盖回 OSS，成功后同步目录条目的大小/时间 */
  saveEditor: () => Promise<void>
  closeEditor: () => void
}

export interface SyncSlice {
  syncState: SyncState | null
  syncIssues: SyncIssue[]
  syncError: string | null
  syncRequestPending: boolean
  applySyncState: (state: SyncState) => void
  startSync: (direction: SyncDirection) => Promise<void>
  cancelSync: () => Promise<void>
  loadSyncIssues: () => Promise<void>
}
