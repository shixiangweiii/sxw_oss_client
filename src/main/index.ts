import { app, BrowserWindow } from 'electron'
import { createWindow } from './window'
import { registerIpcHandlers } from './ipc'
import { buildMenu } from './menu'
import { onWindowsChange } from './windowManager'

app.whenReady().then(() => {
  registerIpcHandlers()
  // 「窗口」菜单里列的是实时窗口列表，窗口增删或焦点变化都要重建菜单
  onWindowsChange(buildMenu)
  buildMenu()
  createWindow()

  // macOS：点 Dock 图标时如果没有窗口就新开一个
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // macOS 上关掉所有窗口不等于退出应用
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
