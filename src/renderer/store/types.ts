import type { Theme } from '../../shared/types'

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

export type StoreState = UiSlice & FileSlice
