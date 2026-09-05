import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import type { OssResult, SyncDirection } from '../shared/types'
import { getSyncConnection, toOssError } from './oss'
import { SyncManager, type ConfirmOverwrite } from './sync'

let manager: SyncManager
let pendingExit = false
let exitDecision: { promise: Promise<void>; resume: () => void } | null = null
let activeConfirmation: { controller: AbortController; closed: Promise<void> } | null = null

function confirmationFor(win: BrowserWindow): ConfirmOverwrite {
  return async (request, signal) => {
    while (!signal.aborted && !win.isDestroyed()) {
      // 退出确认期间保留当前文件，不把程序收起弹窗当成用户跳过。
      if (exitDecision) await exitDecision.promise
      // 此处直到登记 activeConfirmation 之间不能引入 await，以免退出确认插入其间。
      if (signal.aborted || win.isDestroyed()) return 'cancel'
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      signal.addEventListener('abort', abort, { once: true })
      let closed!: () => void
      const current = {
        controller,
        closed: new Promise<void>((resolve) => {
          closed = resolve
        })
      }
      activeConfirmation = current
      let response: number
      try {
        const format = (time: number): string =>
          new Date(time).toLocaleString('zh-CN', { hour12: false, timeZoneName: 'short' })
        const target = request.direction === 'upload' ? '云端' : '本地'
        const source = request.direction === 'upload' ? '本地' : '云端'
        const result = await dialog.showMessageBox(win, {
          type: 'warning',
          message: `${target}文件比${source}文件更新，是否覆盖${target}文件？`,
          detail: [
            `文件：${request.key}`,
            `方向：${source} → ${target}`,
            `本地路径：${request.localPath}`,
            `云端位置：oss://${request.bucket}/${request.key}`,
            `本地修改时间：${format(request.localModifiedAt)}`,
            `云端修改时间：${format(request.remoteModifiedAt)}`
          ].join('\n'),
          buttons: ['跳过此文件', '确认覆盖', '取消本次同步'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          signal: controller.signal
        })
        response = result.response
      } finally {
        signal.removeEventListener('abort', abort)
        if (activeConfirmation === current) activeConfirmation = null
        closed()
      }
      // 程序收起和用户跳过可能返回同一 cancelId，必须先区分任务取消、临时收起，再解释按钮。
      if (signal.aborted || win.isDestroyed()) return 'cancel'
      if (controller.signal.aborted) continue
      if (response === 0) return 'skip'
      if (response === 1) return 'overwrite'
      if (response === 2) return 'cancel'
      throw new Error('无效的覆盖确认选择')
    }
    return 'cancel'
  }
}

/** 同步取消等待放在主进程，原窗口即使尚未收到进度事件也不能跳过保护。 */
function deferExit(win: BrowserWindow | null, action: () => void, label: string): void {
  if (pendingExit) return
  pendingExit = true
  let resume!: () => void
  exitDecision = {
    promise: new Promise<void>((resolve) => {
      resume = resolve
    }),
    resume: () => resume()
  }
  const confirmation = activeConfirmation
  confirmation?.controller.abort()
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    pendingExit = false
    exitDecision?.resume()
    exitDecision = null
  }
  const decide = async (): Promise<void> => {
    try {
      if (confirmation) await confirmation.closed
      const options: Electron.MessageBoxSyncOptions = {
        type: 'warning',
        message: `同步进行中，是否取消同步后${label}？`,
        detail: '已经完成的文件会保留。取消后需等待在途上传结束并清理临时文件。',
        buttons: ['继续同步', `取消同步后${label}`],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      }
      const parent = win && !win.isDestroyed() ? win : BrowserWindow.getFocusedWindow()
      const answer = parent
        ? dialog.showMessageBoxSync(parent, options)
        : dialog.showMessageBoxSync(options)
      if (answer !== 1) return
      const running = manager.getState()
      if (running) manager.cancel(running.taskId)
      await manager.wait()
      if (activeConfirmation) await activeConfirmation.closed
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
      finish()
      action() // 正常 close/quit/reload 仍会走编辑器的草稿保护。
    } finally {
      finish()
    }
  }
  void decide().catch((err) => {
    console.warn('[sync] 窗口关闭确认失败：', toOssError(err).message)
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
        if (pendingExit) throw new Error('请等待当前关闭、退出或刷新操作处理完成')
        if (activeConfirmation) throw new Error('请等待当前覆盖确认窗口关闭')
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win || win.isDestroyed()) throw new Error('发起同步的窗口已关闭')
        const taskId = manager.start(
          direction,
          getSyncConnection(event.sender.id),
          confirmationFor(win)
        )
        const onClosed = (): void => manager.cancel(taskId)
        win.once('closed', onClosed)
        void manager.wait().finally(() => win.removeListener('closed', onClosed))
        return {
          ok: true,
          data: { taskId }
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
