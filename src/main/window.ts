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
/** 允许交给系统浏览器打开的 scheme，其余一律丢弃 */
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

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

/**
 * 恢复上次的窗口尺寸，并按当前屏幕工作区钳制。
 * 不钳制的话，在外接大屏上记下的尺寸回到笔记本屏幕会超出边界，而 macOS 不会自动收缩窗口。
 */
function resolveSize(): { width: number; height: number } {
  const { windowBounds } = getSettings()
  if (!windowBounds) return DEFAULT_SIZE
  const { workAreaSize } = screen.getPrimaryDisplay()
  return {
    width: Math.max(MIN_SIZE.width, Math.min(windowBounds.width, workAreaSize.width)),
    height: Math.max(MIN_SIZE.height, Math.min(windowBounds.height, workAreaSize.height))
  }
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
  const size = resolveSize()
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
      // preload 只用到 ipcRenderer / contextBridge，不碰任何 Node 内建，
      // 因此可以开启沙箱（Electron 默认值，也是官方推荐的更严姿态）
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  pendingConfigs.set(win.id, finalConfig)
  registerWindow(win, finalConfig)

  // 默认最大化打开（macOS 的 zoom 状态，绿按钮会同步点亮）。
  // 在 ready-to-show 之前调，首帧就是最大化，无白屏/尺寸跳动；
  // resize 写盘逻辑会跳过最大化状态，settings 里不会被记入全屏尺寸
  win.maximize()

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
      // 全屏 / 最大化时的尺寸是临时态：记下来的话，下次会以「和屏幕一样大但没全屏」的
      // 窗口启动。getNormalBounds() 返回的是非全屏尺寸，双保险。
      if (win.isFullScreen() || win.isMaximized()) return
      const { width, height } = win.getNormalBounds()
      updateSettings({ windowBounds: { width, height } })
    }, BOUNDS_SAVE_DEBOUNCE)
  })

  win.on('closed', () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    pendingConfigs.delete(win.id)
  })

  // 外链交给系统浏览器，不在应用内开新窗口。
  // 先校验 scheme：不加白名单的话 file:// 或自定义协议也会被原样转发给系统。
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (EXTERNAL_SCHEMES.has(new URL(url).protocol)) shell.openExternal(url)
    } catch {
      // URL 解析不了就直接丢弃
    }
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
