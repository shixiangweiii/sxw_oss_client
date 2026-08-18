import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import type { AppSettings } from '../shared/types'

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

export function getSettings(): AppSettings {
  if (cache) return cache
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8')) as Partial<AppSettings>
    cache = { ...DEFAULTS, ...parsed }
  } catch {
    // 首次启动没有文件，或文件被改坏 —— 两种情况都回落到默认值，不打断启动
    cache = { ...DEFAULTS }
  }
  return cache
}

export function updateSettings(patch: Partial<AppSettings>): void {
  const next = { ...getSettings(), ...patch }
  cache = next
  try {
    writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf-8')
  } catch (err) {
    // 配置写不进去不该影响应用运行
    console.warn('[settings] 写入失败：', err)
  }
}
