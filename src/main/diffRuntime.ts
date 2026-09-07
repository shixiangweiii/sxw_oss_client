import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import type { OssResult } from '../shared/types'
import { DiffManager } from './diff'
import { getSyncConnection, toOssError } from './oss'

/** 在 ipc.ts 统一注册；生命周期按 webContents 绑定，页面重新加载也会结束旧会话。 */
export function registerDiffIpcHandlers(): void {
  const manager = new DiffManager()
  const owners = new Set<number>()
  manager.subscribe(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed())
        win.webContents.send(IPC_CHANNELS.OSS_DIFF_STATE, manager.snapshot(win.webContents.id))
    }
  })
  const attach = (sender: Electron.WebContents): void => {
    if (owners.has(sender.id)) return
    owners.add(sender.id)
    sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) void manager.close(sender.id)
    })
    sender.once('destroyed', () => {
      owners.delete(sender.id)
      void manager.close(sender.id)
    })
  }
  const result = async <T>(work: () => T | Promise<T>): Promise<OssResult<T>> => {
    try {
      return { ok: true, data: await work() }
    } catch (error) {
      return { ok: false, error: toOssError(error) }
    }
  }
  ipcMain.handle(IPC_CHANNELS.OSS_DIFF_START, (event) =>
    result(() => {
      attach(event.sender)
      return { taskId: manager.start(event.sender.id, getSyncConnection(event.sender.id)) }
    })
  )
  ipcMain.handle(IPC_CHANNELS.OSS_DIFF_GET_STATE, (event) => {
    attach(event.sender)
    return manager.snapshot(event.sender.id)
  })
  ipcMain.handle(IPC_CHANNELS.OSS_DIFF_CANCEL, (event, taskId: string) =>
    result(() => {
      manager.cancel(event.sender.id, taskId)
      return null
    })
  )
  ipcMain.handle(IPC_CHANNELS.OSS_DIFF_ENTRIES, (event, taskId: string, offset: number) =>
    result(() => manager.entries(event.sender.id, taskId, offset))
  )
  ipcMain.handle(IPC_CHANNELS.OSS_DIFF_ISSUES, (event, taskId: string, offset: number) =>
    result(() => manager.issues(event.sender.id, taskId, offset))
  )
  ipcMain.handle(
    IPC_CHANNELS.OSS_DIFF_READ,
    (event, taskId: string, key: string, requestId: string) =>
      result(() => manager.read(event.sender.id, taskId, key, requestId))
  )
  ipcMain.handle(IPC_CHANNELS.OSS_DIFF_CANCEL_READ, (event, taskId: string, requestId: string) =>
    result(async () => {
      await manager.cancelRead(event.sender.id, taskId, requestId)
      return null
    })
  )
  ipcMain.handle(IPC_CHANNELS.OSS_DIFF_END, (event, taskId: string) =>
    result(async () => {
      await manager.close(event.sender.id, taskId)
      return null
    })
  )
}
