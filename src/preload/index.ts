import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import type {
  ElectronAPI,
  FileFilter,
  MenuAction,
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

  getOssConfig: () => ipcRenderer.invoke(IPC_CHANNELS.OSS_GET_CONFIG),

  getOssObjectText: (bucket: string, key: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OSS_GET_OBJECT_TEXT, bucket, key),

  putOssObjectText: (bucket: string, key: string, content: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OSS_PUT_OBJECT_TEXT, bucket, key, content)
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
