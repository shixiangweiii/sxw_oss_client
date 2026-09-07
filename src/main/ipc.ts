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
import { registerDiffIpcHandlers } from './diffRuntime'
import {
  listBuckets as ossListBuckets,
  listObjects as ossListObjects,
  getObjectText,
  putObjectText,
  getDefaultBucket,
  getConnectionInfo,
  releaseOssConnection,
  toOssError
} from './oss'
import type {
  FileFilter,
  FileResult,
  InitConfig,
  OssBucketSummary,
  OssConnectionInfo,
  OssObjectListing,
  OssResult,
  OssTextContent,
  OssObjectVersion,
  OssTextSaveResult,
  SaveResult,
  Theme,
  WindowConfig,
  WindowState
} from '../shared/types'

const DEFAULT_FILTERS: FileFilter[] = [
  { name: '文本文件', extensions: ['txt', 'md', 'json', 'log'] },
  { name: '所有文件', extensions: ['*'] }
]

/**
 * fromWebContents 在窗口销毁的竞态下可能返回 null。
 * Electron 对空父窗口是容错的（退化成非模态对话框），但这里显式分支处理，
 * 避免用 `win!` 在类型上撒谎。
 */
function openDialog(
  win: BrowserWindow | null,
  options: Electron.OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue> {
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
}

function saveDialog(
  win: BrowserWindow | null,
  options: Electron.SaveDialogOptions
): Promise<Electron.SaveDialogReturnValue> {
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
}

async function promptAndWrite(
  win: BrowserWindow | null,
  content: string,
  filters?: FileFilter[]
): Promise<SaveResult | null> {
  const result = await saveDialog(win, { filters: filters ?? DEFAULT_FILTERS })
  if (result.canceled || !result.filePath) return null
  await writeFile(result.filePath, content, 'utf-8')
  return { path: result.filePath }
}

export function registerIpcHandlers(): void {
  registerDiffIpcHandlers()
  // 仅用于 beforeunload 的同步决定；不依赖可能滞后的异步状态上报。
  ipcMain.on(IPC_CHANNELS.WINDOW_CONFIRM_CLOSE, (event, saving: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) {
      event.returnValue = false
      return
    }
    if (saving) {
      dialog.showMessageBoxSync(win, {
        type: 'info',
        message: '文件正在保存，请等待保存完成后再关闭。',
        buttons: ['继续等待']
      })
      event.returnValue = false
      return
    }
    event.returnValue =
      dialog.showMessageBoxSync(win, {
        type: 'warning',
        message: '有未保存的修改，确定放弃吗？',
        detail: '选择取消可返回编辑器继续编辑或保存。',
        buttons: ['取消', '放弃修改'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      }) === 1
  })
  const connectionOwners = new Set<number>()

  // 说明：以下 handler 里的 readFile / writeFile 失败时会让 invoke 的 promise reject，
  // 由渲染层统一 try/catch 并弹出错误 toast（见 renderer/App.tsx）。
  ipcMain.handle(
    IPC_CHANNELS.FILE_OPEN,
    async (event, filters?: FileFilter[]): Promise<FileResult | null> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = await openDialog(win, {
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
      return promptAndWrite(BrowserWindow.fromWebContents(event.sender), content, filters)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.FILE_SAVE_AS,
    async (event, content: string, filters?: FileFilter[]): Promise<SaveResult | null> =>
      promptAndWrite(BrowserWindow.fromWebContents(event.sender), content, filters)
  )

  ipcMain.handle(IPC_CHANNELS.WINDOW_NEW, (_event, config?: WindowConfig) => {
    createWindow(config ?? getFocusedWindowConfig() ?? undefined)
  })

  ipcMain.handle(IPC_CHANNELS.WINDOW_REPORT_STATE, (event, state: WindowState) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    // 这条通道只做「状态同步」，不碰持久化 —— 偏好落盘走 settings:set-theme。
    //
    // 先落 config 再更新文件路径：当前 composeTitle 只读 filePath 与窗口编号，顺序其实无关，
    // 但保持这个顺序，是为了将来 config 里的字段参与标题组装时不必回头改这里。
    updateWindowConfig(win.id, state.config)
    setWindowFilePath(win.id, state.filePath)
  })

  // 只有用户显式切换外观才会走到这里，AppSettings.theme 的 null 语义（跟随系统）才成立
  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET_THEME, (_event, theme: Theme) => {
    updateSettings({ theme })
  })

  ipcMain.handle(IPC_CHANNELS.WINDOW_GET_INIT_CONFIG, (event): InitConfig => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { windowNumber: 1, config: resolveInitialConfig() }
    // pendingConfig 只在窗口首次加载时存在；开发期热重载或 Cmd+R 后它已被取走，
    // 这时回落到 windowManager 里保存的当前配置，避免刷新一次主题就被重置
    const config = consumePendingConfig(win.id) ?? getWindowConfig(win.id) ?? resolveInitialConfig()
    return { windowNumber: getWindowNumber(win.id), config }
  })

  // OSS 通道统一返回 OssResult：错误结构化携带 code/requestId，不走 promise reject
  //（自定义字段跨进程序列化会丢失，只剩 message，见 shared/types.ts 的注释）
  ipcMain.handle(
    IPC_CHANNELS.OSS_LIST_BUCKETS,
    async (event): Promise<OssResult<OssBucketSummary[]>> => {
      try {
        return { ok: true, data: await ossListBuckets(event.sender.id) }
      } catch (err) {
        return { ok: false, error: toOssError(err) }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OSS_LIST_OBJECTS,
    async (
      event,
      bucket: string,
      prefix: string,
      continuationToken?: string | null
    ): Promise<OssResult<OssObjectListing>> => {
      try {
        return {
          ok: true,
          data: await ossListObjects(event.sender.id, bucket, prefix, continuationToken ?? null)
        }
      } catch (err) {
        return { ok: false, error: toOssError(err) }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OSS_GET_CONFIG,
    (event, reload = false): OssResult<OssConnectionInfo> => {
      const owner = event.sender.id
      if (!connectionOwners.has(owner)) {
        connectionOwners.add(owner)
        event.sender.once('destroyed', () => {
          connectionOwners.delete(owner)
          releaseOssConnection(owner)
        })
      }
      try {
        getDefaultBucket(owner, reload)
        return { ok: true, data: getConnectionInfo(owner) }
      } catch (err) {
        return { ok: false, error: toOssError(err) }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OSS_GET_OBJECT_TEXT,
    async (event, bucket: string, key: string): Promise<OssResult<OssTextContent>> => {
      try {
        return { ok: true, data: await getObjectText(event.sender.id, bucket, key) }
      } catch (err) {
        return { ok: false, error: toOssError(err) }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OSS_PUT_OBJECT_TEXT,
    async (
      event,
      bucket: string,
      key: string,
      content: string,
      version: OssObjectVersion
    ): Promise<OssResult<OssTextSaveResult>> => {
      try {
        return {
          ok: true,
          data: await putObjectText(event.sender.id, bucket, key, content, version)
        }
      } catch (err) {
        return { ok: false, error: toOssError(err) }
      }
    }
  )
}
