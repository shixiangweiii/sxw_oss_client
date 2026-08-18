import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import type { AppSettings, Theme } from '../shared/types'

const DEFAULTS: AppSettings = {
  theme: null,
  windowBounds: null
}

// 读一次就缓存：settings 很小，且写入永远经过 updateSettings，不存在外部改动需要重读的场景
let cache: AppSettings | null = null

function settingsPath(): string {
  // userData 目录由 Electron 保证存在（macOS 下是 ~/Library/Application Support/<appName>）
  return join(app.getPath('userData'), 'settings.json')
}

function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light'
}

function toBounds(value: unknown): AppSettings['windowBounds'] {
  if (typeof value !== 'object' || value === null) return null
  const { width, height } = value as { width?: unknown; height?: unknown }
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null
  if ((width as number) <= 0 || (height as number) <= 0) return null
  return { width: width as number, height: height as number }
}

/**
 * settings.json 是用户可以直接编辑的文件，形状不可信。
 * 逐字段校验后再用，避免脏值（例如 windowBounds: "abc"）一路流进 BrowserWindow 选项。
 */
function sanitize(raw: unknown): AppSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULTS }
  const { theme, windowBounds } = raw as { theme?: unknown; windowBounds?: unknown }
  return {
    theme: isTheme(theme) ? theme : null,
    windowBounds: toBounds(windowBounds)
  }
}

export function getSettings(): AppSettings {
  if (cache) return cache
  try {
    cache = sanitize(JSON.parse(readFileSync(settingsPath(), 'utf-8')))
  } catch {
    // 首次启动没有文件，或文件被改坏 —— 两种情况都回落到默认值，不打断启动
    cache = { ...DEFAULTS }
  }
  return cache
}

export function updateSettings(patch: Partial<AppSettings>): void {
  const current = getSettings()
  const next = { ...current, ...patch }
  // 值没变就不写盘。窗口 resize 会高频调用这里，没有这道判断会产生大量无谓的同步 IO
  if (JSON.stringify(next) === JSON.stringify(current)) return

  cache = next
  try {
    writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf-8')
  } catch (err) {
    // 配置写不进去不该影响应用运行
    console.warn('[settings] 写入失败：', err)
  }
}
