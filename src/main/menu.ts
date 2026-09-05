import { app, BrowserWindow, Menu } from 'electron'
import { createWindow } from './window'
import { getFocusedWindowConfig, getWindowList, focusWindow } from './windowManager'
import { IPC_CHANNELS } from '../shared/constants'
import type { MenuAction } from '../shared/types'

const isDev = !app.isPackaged

/**
 * 菜单项不直接改渲染层状态，而是把动作投递给当前聚焦窗口。
 * 这样菜单和工具栏按钮共用同一套 handler（渲染进程侧见 hooks/useMenuAction.ts），
 * 新增一个入口不需要把逻辑实现两遍。
 */
function dispatch(action: MenuAction): void {
  BrowserWindow.getFocusedWindow()?.webContents.send(IPC_CHANNELS.MENU_ACTION, action)
}

export function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: `关于 ${app.name}` },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${app.name}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${app.name}` }
      ]
    },
    {
      label: '文件',
      submenu: [
        {
          label: '新建窗口',
          accelerator: 'CmdOrCtrl+N',
          // 新窗口继承当前聚焦窗口的配置；一个窗口都没有时用默认值
          click: () => createWindow(getFocusedWindowConfig() ?? undefined)
        },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        {
          label: '切换深色外观',
          accelerator: 'Shift+CmdOrCtrl+L',
          click: () => dispatch('view:toggle-theme')
        },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏幕' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        // 窗口列表随开关窗口和焦点变化实时重建（main/index.ts 里订阅了 onWindowsChange）
        ...getWindowList().map((w) => ({
          label: w.title,
          type: 'radio' as const,
          checked: w.focused,
          click: (): void => focusWindow(w.id)
        }))
      ]
    }
  ]

  if (isDev) {
    template.push({
      label: '开发',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '切换开发者工具' }
      ]
    })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
