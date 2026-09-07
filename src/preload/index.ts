import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import type {
  ElectronAPI,
  FileFilter,
  MenuAction,
  OssObjectVersion,
  Theme,
  WindowConfig,
  WindowState
} from '../shared/types'

/**
 * 这里是渲染进程能触达主进程的**全部**表面积。
 * contextIsolation 开启、nodeIntegration 关闭，渲染层拿不到 require / fs / ipcRenderer 本体，
 * 只能调用下面这几个具名方法。
 */
const electronAPI: ElectronAPI = {
  startOssDiff: () => ipcRenderer.invoke(IPC_CHANNELS.OSS_DIFF_START),
  cancelOssDiff: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.OSS_DIFF_CANCEL, taskId),
  getOssDiffState: () => ipcRenderer.invoke(IPC_CHANNELS.OSS_DIFF_GET_STATE),
  getOssDiffEntries: (taskId, offset) =>
    ipcRenderer.invoke(IPC_CHANNELS.OSS_DIFF_ENTRIES, taskId, offset),
  getOssDiffIssues: (taskId, offset) =>
    ipcRenderer.invoke(IPC_CHANNELS.OSS_DIFF_ISSUES, taskId, offset),
  readOssDiff: (taskId, key, requestId) =>
    ipcRenderer.invoke(IPC_CHANNELS.OSS_DIFF_READ, taskId, key, requestId),
  cancelOssDiffRead: (taskId, requestId) =>
    ipcRenderer.invoke(IPC_CHANNELS.OSS_DIFF_CANCEL_READ, taskId, requestId),
  endOssDiff: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.OSS_DIFF_END, taskId),
  onOssDiffState: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      snapshot: Parameters<typeof callback>[0]
    ): void => callback(snapshot)
    ipcRenderer.on(IPC_CHANNELS.OSS_DIFF_STATE, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.OSS_DIFF_STATE, listener)
    }
  },
  startOssSync: (direction) => ipcRenderer.invoke(IPC_CHANNELS.OSS_SYNC_START, direction),
  cancelOssSync: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.OSS_SYNC_CANCEL, taskId),
  getOssSyncState: () => ipcRenderer.invoke(IPC_CHANNELS.OSS_SYNC_GET_STATE),
  getOssSyncIssues: (taskId, offset) =>
    ipcRenderer.invoke(IPC_CHANNELS.OSS_SYNC_ISSUES, taskId, offset),
  checkSyncUnload: () => ipcRenderer.sendSync(IPC_CHANNELS.OSS_SYNC_CHECK_UNLOAD),
  onOssSyncState: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      state: Parameters<typeof callback>[0]
    ): void => callback(state)
    ipcRenderer.on(IPC_CHANNELS.OSS_SYNC_STATE, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.OSS_SYNC_STATE, listener)
    }
  },
  confirmWindowClose: (saving) => ipcRenderer.sendSync(IPC_CHANNELS.WINDOW_CONFIRM_CLOSE, saving),
  openFile: (filters?: FileFilter[]) => ipcRenderer.invoke(IPC_CHANNELS.FILE_OPEN, filters),

  saveFile: (content: string, filePath: string | null, filters?: FileFilter[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_SAVE, content, filePath, filters),

  saveFileAs: (content: string, filters?: FileFilter[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_SAVE_AS, content, filters),

  newWindow: (config?: WindowConfig) => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_NEW, config),

  reportWindowState: (state: WindowState) =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW_REPORT_STATE, state),

  setThemePreference: (theme: Theme) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET_THEME, theme),

  getInitConfig: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_GET_INIT_CONFIG),

  onMenuAction: (callback: (action: MenuAction) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: MenuAction): void =>
      callback(action)
    ipcRenderer.on(IPC_CHANNELS.MENU_ACTION, listener)
    // 返回取消订阅函数，渲染层在 useEffect 的 cleanup 里调用
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.MENU_ACTION, listener)
    }
  },

  listOssBuckets: () => ipcRenderer.invoke(IPC_CHANNELS.OSS_LIST_BUCKETS),

  listOssObjects: (bucket: string, prefix: string, continuationToken?: string | null) =>
    ipcRenderer.invoke(IPC_CHANNELS.OSS_LIST_OBJECTS, bucket, prefix, continuationToken),

  getOssConfig: (reload = false) => ipcRenderer.invoke(IPC_CHANNELS.OSS_GET_CONFIG, reload),

  getOssObjectText: (bucket: string, key: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OSS_GET_OBJECT_TEXT, bucket, key),

  putOssObjectText: (bucket: string, key: string, content: string, version: OssObjectVersion) =>
    ipcRenderer.invoke(IPC_CHANNELS.OSS_PUT_OBJECT_TEXT, bucket, key, content, version)
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
