import { app, BrowserWindow } from 'electron'
import { fileName } from '../shared/path'
import type { WindowConfig } from '../shared/types'

interface WindowEntry {
  win: BrowserWindow
  title: string
  number: number
  /** 当前窗口打开/保存的文件完整路径。不放进 config，避免被新窗口继承 */
  filePath: string | null
  config: WindowConfig
}

const windows = new Map<number, WindowEntry>()
let onChangeCallback: (() => void) | null = null
let nextWindowNumber = 1
/** 记录最近一次获得焦点的窗口，供「新窗口继承配置」在无聚焦窗口时回退 */
let lastFocusedId: number | null = null

/**
 * 有文件时只显示文件名，仅当与其他窗口重名才追加窗口编号；
 * 无文件时用「应用名 - 编号」。
 */
function composeTitle(entry: WindowEntry): string {
  if (!entry.filePath) {
    return `${app.getName()} - ${entry.number}`
  }
  const name = fileName(entry.filePath)
  const duplicated = [...windows.values()].some(
    (other) => other !== entry && other.filePath !== null && fileName(other.filePath) === name
  )
  return duplicated ? `${name} - ${entry.number}` : name
}

/**
 * 重名消歧需要全局视角：任一窗口的文件名变化、或窗口开关，都可能改变别的窗口该不该带编号，
 * 所以只要有变动就重算所有窗口的标题。
 */
function recomputeAllTitles(): void {
  for (const entry of windows.values()) {
    if (entry.win.isDestroyed()) continue
    const next = composeTitle(entry)
    if (next === entry.title) continue
    entry.title = next
    entry.win.setTitle(next)
  }
  onChangeCallback?.()
}

export function registerWindow(win: BrowserWindow, config: WindowConfig): void {
  const id = win.id
  windows.set(id, {
    win,
    title: app.getName(),
    number: nextWindowNumber++,
    filePath: null,
    config: { ...config }
  })

  win.on('closed', () => {
    windows.delete(id)
    if (lastFocusedId === id) lastFocusedId = null
    recomputeAllTitles()
  })

  win.on('focus', () => {
    lastFocusedId = id
    // 「窗口」菜单里的单选标记要跟着焦点走
    onChangeCallback?.()
  })

  recomputeAllTitles()
}

export function setWindowFilePath(winId: number, filePath: string | null): void {
  const entry = windows.get(winId)
  if (!entry || entry.win.isDestroyed()) return
  // 早退：路径没变就不触发全窗口标题重算与菜单重建。
  // 渲染进程在主题切换时也会上报状态，没有这道判断会白跑一轮。
  if (entry.filePath === filePath) return

  entry.filePath = filePath
  // macOS 标题栏的代理图标：按住标题可直接拖出文件、右键可显示所在目录
  entry.win.setRepresentedFilename(filePath ?? '')
  recomputeAllTitles()
}

export function updateWindowConfig(winId: number, config: Partial<WindowConfig>): void {
  const entry = windows.get(winId)
  if (entry) Object.assign(entry.config, config)
}

export function getWindowConfig(winId: number): WindowConfig | null {
  const entry = windows.get(winId)
  return entry ? { ...entry.config } : null
}

/** 新窗口的配置来源：当前聚焦窗口 → 最近聚焦过的窗口 → null（由调用方决定默认值） */
export function getFocusedWindowConfig(): WindowConfig | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused) {
    const entry = windows.get(focused.id)
    if (entry) return { ...entry.config }
  }
  if (lastFocusedId !== null) {
    const entry = windows.get(lastFocusedId)
    if (entry) return { ...entry.config }
  }
  return null
}

export function getWindowList(): Array<{ id: number; title: string; focused: boolean }> {
  const focusedId = BrowserWindow.getFocusedWindow()?.id
  return [...windows.entries()].map(([id, entry]) => ({
    id,
    title: entry.title,
    focused: id === focusedId
  }))
}

export function focusWindow(id: number): void {
  const entry = windows.get(id)
  if (entry && !entry.win.isDestroyed()) {
    entry.win.show()
    entry.win.focus()
  }
}

export function getWindowNumber(winId: number): number {
  return windows.get(winId)?.number ?? 1
}

export function onWindowsChange(cb: () => void): void {
  onChangeCallback = cb
}
