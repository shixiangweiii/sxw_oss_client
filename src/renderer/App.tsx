import { useCallback, useEffect } from 'react'
import { useStore } from './store'
import { Toolbar } from './components/Toolbar'
import { OssPanel } from './components/OssPanel'
import { TextEditorPage } from './components/TextEditorPage'
import { SyncPanel } from './components/SyncPanel'
import { useMenuAction } from './hooks/useMenuAction'

function Toast(): JSX.Element | null {
  const message = useStore((s) => s.toastMessage)
  const type = useStore((s) => s.toastType)
  const clearToast = useStore((s) => s.clearToast)

  useEffect(() => {
    if (!message) return
    const timer = setTimeout(clearToast, 3000)
    return () => clearTimeout(timer)
  }, [message, clearToast])

  if (!message) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed bottom-4 right-4 z-50 rounded-lg px-4 py-2 text-sm text-white shadow-lg ${
        type === 'error' ? 'bg-red-500' : 'bg-green-500'
      }`}
    >
      {message}
    </div>
  )
}

function App(): JSX.Element {
  const theme = useStore((s) => s.theme)
  const isInitialized = useStore((s) => s.isInitialized)

  useEffect(() => {
    const api = window.electronAPI
    if (!api) return
    let mounted = true
    const unsubscribe = api.onOssSyncState((state) => {
      if (mounted) useStore.getState().applySyncState(state)
    })
    void api
      .getOssSyncState()
      .then((state) => {
        if (mounted && state) useStore.getState().applySyncState(state)
      })
      .catch((err) => {
        if (mounted) useStore.setState({ syncError: String(err) })
      })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  // Tailwind 的 darkMode: 'class' 依赖 <html> 上的 dark 类
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  // 读取初始配置：新窗口继承自打开它的窗口，首个窗口取「持久化偏好 > 系统外观」
  useEffect(() => {
    window.electronAPI?.getInitConfig().then((init) => {
      const store = useStore.getState()
      store.setWindowNumber(init.windowNumber)
      store.setTheme(init.config.theme)
      store.markInitialized()
    })
  }, [])

  // 窗口标题由主进程统一组装（含重名消歧），渲染层只上报自己的状态。
  //
  // isInitialized 门控是必须的：effect 在挂载时就会跑，而此时 store 里还是占位主题，
  // 抢在 getInitConfig 返回之前上报的话，主进程侧的 entry.config 会被占位值覆写；
  // dev 的 StrictMode 下 effect 双跑，第二次 getInitConfig 还会把这个被污染的值当成
  // fallback 读回来，最终导致首窗主题解析错误。
  //
  // filePath 恒为 null：当前应用不绑定本地文件（fileSlice 保留给将来的下载/预览复用）
  useEffect(() => {
    if (!isInitialized) return
    window.electronAPI?.reportWindowState({ filePath: null, config: { theme } })
  }, [isInitialized, theme])

  // 切换外观的唯一入口：改 store 的同时把偏好落盘。
  // 只有走到这里才算「用户显式选择」，settings.json 里 theme 为 null 时的「跟随系统」才成立。
  const handleToggleTheme = useCallback(() => {
    const next = useStore.getState().theme === 'dark' ? 'light' : 'dark'
    useStore.getState().setTheme(next)
    window.electronAPI?.setThemePreference(next)
  }, [])

  useMenuAction({
    'view:toggle-theme': handleToggleTheme
  })

  return (
    <div className="flex h-full flex-col bg-white dark:bg-gray-900">
      <div className="relative flex min-h-0 flex-1 flex-col">
        <Toolbar onToggleTheme={handleToggleTheme} />

        <main className="flex-1 overflow-hidden">
          <OssPanel />
        </main>

        {/* 全屏文本编辑页，非空时覆盖文件列表 */}
        <TextEditorPage />
      </div>
      <SyncPanel />

      <Toast />
    </div>
  )
}

export default App
