import { ipcMain, dialog, BrowserWindow } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { IPC_CHANNELS } from '../shared/constants'
import { createWindow, consumePendingConfig, resolveInitialConfig } from './window'
import {
  setWindowFilePath,
  updateWindowConfig,
  getFocusedWindowConfig,
  getWindowConfig,
  getWindowNumber
} from './windowManager'
import { updateSettings } from './settings'
import type {
  FileFilter,
  FileResult,
  InitConfig,
  SaveResult,
  WindowConfig,
  WindowState
} from '../shared/types'

const DEFAULT_FILTERS: FileFilter[] = [
  { name: '文本文件', extensions: ['txt', 'md', 'json', 'log'] },
  { name: '所有文件', extensions: ['*'] }
]

async function showSaveDialog(
  win: BrowserWindow | null,
  content: string,
  filters?: FileFilter[]
): Promise<SaveResult | null> {
  const result = await dialog.showSaveDialog(win!, { filters: filters ?? DEFAULT_FILTERS })
  if (result.canceled || !result.filePath) return null
  await writeFile(result.filePath, content, 'utf-8')
  return { path: result.filePath }
}

export function registerIpcHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.FILE_OPEN,
    async (event, filters?: FileFilter[]): Promise<FileResult | null> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = await dialog.showOpenDialog(win!, {
        filters: filters ?? DEFAULT_FILTERS,
        properties: ['openFile']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      const path = result.filePaths[0]
      return { path, content: await readFile(path, 'utf-8') }
    }
  )

  // 有路径就地覆盖，没路径才弹「另存为」—— 这样 Cmd+S 才是真正的保存而不是每次都问一遍
  ipcMain.handle(
    IPC_CHANNELS.FILE_SAVE,
    async (
      event,
      content: string,
      filePath: string | null,
      filters?: FileFilter[]
    ): Promise<SaveResult | null> => {
      if (filePath) {
        await writeFile(filePath, content, 'utf-8')
        return { path: filePath }
      }
      return showSaveDialog(BrowserWindow.fromWebContents(event.sender), content, filters)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.FILE_SAVE_AS,
    async (event, content: string, filters?: FileFilter[]): Promise<SaveResult | null> =>
      showSaveDialog(BrowserWindow.fromWebContents(event.sender), content, filters)
  )

  ipcMain.handle(IPC_CHANNELS.WINDOW_NEW, (_event, config?: WindowConfig) => {
    createWindow(config ?? getFocusedWindowConfig() ?? undefined)
  })

  ipcMain.handle(IPC_CHANNELS.WINDOW_REPORT_STATE, (event, state: WindowState) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    // 顺序要紧：标题组装读的是 entry.config，必须先落配置再重算标题，
    // 否则依赖 config 的标题会比实际状态慢一拍
    updateWindowConfig(win.id, state.config)
    setWindowFilePath(win.id, state.filePath)
    // 主题是用户显式选择的偏好，持久化后下次启动直接生效
    updateSettings({ theme: state.config.theme })
  })

  ipcMain.handle(IPC_CHANNELS.WINDOW_GET_INIT_CONFIG, (event): InitConfig => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { windowNumber: 1, config: resolveInitialConfig() }
    // pendingConfig 只在窗口首次加载时存在；开发期热重载或 Cmd+R 后它已被取走，
    // 这时回落到 windowManager 里保存的当前配置，避免刷新一次主题就被重置
    const config = consumePendingConfig(win.id) ?? getWindowConfig(win.id) ?? resolveInitialConfig()
    return { windowNumber: getWindowNumber(win.id), config }
  })
}
