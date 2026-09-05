import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import type { OssResult, SyncDirection } from '../shared/types'
import { getSyncConnection, toOssError } from './oss'
import { SyncManager } from './sync'

let manager: SyncManager
let pendingExit = false

/** 同步取消等待放在主进程，原窗口即使尚未收到进度事件也不能跳过保护。 */
function deferExit(win: BrowserWindow | null, action: () => void, label: string): void {
  if (pendingExit) return
  const options: Electron.MessageBoxSyncOptions = {
    type: 'warning',
    message: `同步进行中，是否取消同步后${label}？`,
    detail: '已经完成的文件会保留。取消后需等待在途上传结束并清理临时文件。',
    buttons: ['继续同步', `取消同步后${label}`],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }
  const answer = win ? dialog.showMessageBoxSync(win, options) : dialog.showMessageBoxSync(options)
  if (answer !== 1) return
  pendingExit = true
  const state = manager.getState()
  if (state) manager.cancel(state.taskId)
  void manager.wait().then(() => {
    const state = manager.getState()
    if (state) {
      const cleanup: string[] = []
      for (let offset = 0; offset < state.issueCount; offset += 50) {
        for (const issue of manager.getIssues(state.taskId, offset).items)
          if (issue.phase === 'cleanup' && issue.kind === 'error')
            cleanup.push(`${issue.path}：${issue.message}`)
      }
      if (cleanup.length)
        dialog.showMessageBoxSync({
          type: 'warning',
          message: '同步已停止，但部分临时文件或上传分片未能清理。',
          detail: cleanup.slice(0, 10).join('\n'),
          buttons: ['知道了']
        })
    }
    pendingExit = false
    action() // 正常 close/quit/reload 仍会走编辑器的草稿保护。
  })
}

export async function initializeSync(): Promise<void> {
  manager = new SyncManager(app.getPath('userData'))
  // 清理错误留给下一次任务显示，不阻止普通 OSS 浏览。
  try {
    await manager.recover()
  } catch (err) {
    console.warn('[sync] 临时文件恢复失败：', toOssError(err).message)
  }
  manager.subscribe((state) => {
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.OSS_SYNC_STATE, state)
  })
  app.on('browser-window-created', (_event, win) => {
    win.on('close', (event) => {
      if (!manager.active && !pendingExit) return
      event.preventDefault()
      deferExit(
        win,
        () => {
          if (!win.isDestroyed()) win.close()
        },
        '关闭窗口'
      )
    })
  })
  app.on('before-quit', (event) => {
    if (!manager.active && !pendingExit) return
    event.preventDefault()
    deferExit(BrowserWindow.getFocusedWindow(), () => app.quit(), '退出应用')
  })
  ipcMain.on(IPC_CHANNELS.OSS_SYNC_CHECK_UNLOAD, (event) => {
    if (!manager.active && !pendingExit) {
      event.returnValue = true
      return
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    deferExit(
      win,
      () => {
        if (win && !win.isDestroyed()) win.webContents.reload()
      },
      '刷新页面'
    )
    event.returnValue = false
  })
  ipcMain.handle(
    IPC_CHANNELS.OSS_SYNC_START,
    (event, direction: SyncDirection): OssResult<{ taskId: string }> => {
      try {
        return {
          ok: true,
          data: { taskId: manager.start(direction, getSyncConnection(event.sender.id)) }
        }
      } catch (err) {
        return { ok: false, error: toOssError(err) }
      }
    }
  )
  ipcMain.handle(IPC_CHANNELS.OSS_SYNC_CANCEL, (_event, taskId: string): OssResult<null> => {
    manager.cancel(taskId)
    return { ok: true, data: null }
  })
  ipcMain.handle(IPC_CHANNELS.OSS_SYNC_GET_STATE, () => manager.getState())
  ipcMain.handle(IPC_CHANNELS.OSS_SYNC_ISSUES, (_event, taskId: string, offset: number) =>
    manager.getIssues(taskId, offset)
  )
}
