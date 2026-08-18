import type { ElectronAPI } from '../../shared/types'

declare global {
  interface Window {
    /**
     * preload 通过 contextBridge 注入。
     * 标记为可选是因为在浏览器里单独跑渲染层（纯 UI 调试）时它不存在，
     * 所以调用处一律写 `window.electronAPI?.xxx`。
     */
    electronAPI?: ElectronAPI
  }
}
