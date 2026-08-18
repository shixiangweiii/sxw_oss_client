import { app, BrowserWindow, nativeTheme, screen, shell } from 'electron'
import { join } from 'path'
import { registerWindow } from './windowManager'
import { getSettings, updateSettings } from './settings'
import type { WindowConfig } from '../shared/types'

const isDev = !app.isPackaged

const DEFAULT_SIZE = { width: 1200, height: 800 }
const MIN_SIZE = { width: 800, height: 600 }
/** 新窗口相对父窗口错开的像素（macOS 惯例，避免完全盖住） */
const CASCADE_OFFSET = 24
/** 尺寸写盘的防抖，拖动窗口边缘会高频触发 resize */
const BOUNDS_SAVE_DEBOUNCE = 400

/**
 * 新窗口的初始配置暂存区：BrowserWindow 创建时渲染进程还没起来，
 * 等它自己通过 getInitConfig 来取（取走即删）。
 */
const pendingConfigs = new Map<number, WindowConfig>()

/**
 * 没有父窗口可继承时的初始配置。
 * 主题优先级：用户持久化的选择 > 系统外观。
 */
export function resolveInitialConfig(): WindowConfig {
  const { theme } = getSettings()
  return { theme: theme ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') }
}

/** 从当前聚焦窗口错开一点；越界则回到工作区左上角重新开始 */
function nextPosition(width: number, height: number): { x: number; y: number } | null {
  const parent = BrowserWindow.getFocusedWindow()
  if (!parent || parent.isDestroyed()) return null

  const [px, py] = parent.getPosition()
  const x = px + CASCADE_OFFSET
  const y = py + CASCADE_OFFSET
  const { workArea } = screen.getDisplayNearestPoint({ x: px, y: py })

  const overflowsRight = x + width > workArea.x + workArea.width
  const overflowsBottom = y + height > workArea.y + workArea.height
  if (overflowsRight || overflowsBottom) {
    return { x: workArea.x + CASCADE_OFFSET, y: workArea.y + CASCADE_OFFSET }
  }
  return { x, y }
}

export function createWindow(config?: WindowConfig): BrowserWindow {
  const finalConfig = config ?? resolveInitialConfig()
  const { windowBounds } = getSettings()
  const size = windowBounds ?? DEFAULT_SIZE
  const position = nextPosition(size.width, size.height)

  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    ...(position ?? {}),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    // 先隐藏，等首帧渲染好再显示，避免白屏闪烁
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 10 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  pendingConfigs.set(win.id, finalConfig)
  registerWindow(win, finalConfig)

  win.on('ready-to-show', () => {
    win.show()
  })

  // 窗口标题由 windowManager 统一组装。页面加载完成时 Electron 默认会用 document.title
  // 覆盖窗口标题，把编号和重名消歧的结果冲掉，所以这里拦掉这个默认行为。
  win.on('page-title-updated', (event) => {
    event.preventDefault()
  })

  let boundsTimer: NodeJS.Timeout | null = null
  win.on('resize', () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      if (win.isDestroyed()) return
      const [width, height] = win.getSize()
      updateSettings({ windowBounds: { width, height } })
    }, BOUNDS_SAVE_DEBOUNCE)
  })

  win.on('closed', () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    pendingConfigs.delete(win.id)
  })

  // 外链交给系统浏览器，不在应用内开新窗口
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

export function consumePendingConfig(winId: number): WindowConfig | null {
  const config = pendingConfigs.get(winId)
  pendingConfigs.delete(winId)
  return config ?? null
}
