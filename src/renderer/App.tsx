import { useCallback, useEffect } from 'react'
import { useStore } from './store'
import { Toolbar } from './components/Toolbar'
import { useMenuAction } from './hooks/useMenuAction'
import { fileName } from '../shared/path'

/** 只读预览的字符上限：打开超大文件时不把整段塞进 DOM */
const PREVIEW_LIMIT = 20_000

/**
 * Electron 会把主进程抛出的错误包装成
 * "Error invoking remote method 'file:open': Error: EACCES ..."，
 * 直接展示噪音太大，这里剥掉两层前缀只留真实原因。
 */
function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '')
}

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
  const filePath = useStore((s) => s.filePath)
  const content = useStore((s) => s.content)

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
  useEffect(() => {
    if (!isInitialized) return
    window.electronAPI?.reportWindowState({ filePath, config: { theme } })
  }, [isInitialized, filePath, theme])

  const handleOpen = useCallback(async () => {
    try {
      const result = await window.electronAPI?.openFile()
      if (!result) return
      useStore.getState().setFile(result.path, result.content)
    } catch (error) {
      useStore.getState().showToast(`打开失败：${describeError(error)}`, 'error')
    }
  }, [])

  // 有路径直接覆盖写入，没有则弹「另存为」——由主进程判断，渲染层不关心
  const handleSave = useCallback(async () => {
    const store = useStore.getState()
    try {
      const saved = await window.electronAPI?.saveFile(store.content, store.filePath)
      if (!saved) return
      store.setFilePath(saved.path)
      store.showToast(`已保存 ${fileName(saved.path)}`, 'success')
    } catch (error) {
      store.showToast(`保存失败：${describeError(error)}`, 'error')
    }
  }, [])

  const handleSaveAs = useCallback(async () => {
    const store = useStore.getState()
    try {
      const saved = await window.electronAPI?.saveFileAs(store.content)
      if (!saved) return
      store.setFilePath(saved.path)
      store.showToast(`已另存为 ${fileName(saved.path)}`, 'success')
    } catch (error) {
      store.showToast(`另存为失败：${describeError(error)}`, 'error')
    }
  }, [])

  const handleClear = useCallback(() => {
    useStore.getState().clearFile()
  }, [])

  // 切换外观的唯一入口：改 store 的同时把偏好落盘。
  // 只有走到这里才算「用户显式选择」，settings.json 里 theme 为 null 时的「跟随系统」才成立。
  const handleToggleTheme = useCallback(() => {
    const next = useStore.getState().theme === 'dark' ? 'light' : 'dark'
    useStore.getState().setTheme(next)
    window.electronAPI?.setThemePreference(next)
  }, [])

  // 菜单项与工具栏按钮共用同一批 handler
  useMenuAction({
    'file:open': handleOpen,
    'file:save': handleSave,
    'file:save-as': handleSaveAs,
    'view:toggle-theme': handleToggleTheme
  })

  return (
    <div className="flex h-full flex-col bg-white dark:bg-gray-900">
      <Toolbar
        onOpen={handleOpen}
        onSave={handleSave}
        onSaveAs={handleSaveAs}
        onClear={handleClear}
        onToggleTheme={handleToggleTheme}
      />

      <main className="flex-1 overflow-auto p-8">
        <div className="mx-auto max-w-2xl">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Hello World</h1>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            这是脚手架的示例面板。删掉本文件的内容换成你自己的界面即可，
            下面列出的能力都已经接好、可以直接用。
          </p>

          <ul className="mt-6 space-y-2 text-sm text-gray-600 dark:text-gray-300">
            <li>• 多窗口（Cmd+N）：窗口编号、标题重名消歧、「窗口」菜单实时列表</li>
            <li>• 新窗口继承当前窗口配置，主题偏好与窗口尺寸自动持久化</li>
            <li>• 文件打开（Cmd+O）/ 保存（Cmd+S）/ 另存为（Shift+Cmd+S）</li>
            <li>• 菜单项与工具栏按钮共用一套 handler，经 menu:action 通道下发</li>
            <li>• 深浅色外观（Shift+Cmd+L），跟随系统或记住你的选择</li>
          </ul>

          <section className="mt-8 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
            <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200">当前文件</h2>
            {filePath ? (
              <>
                <dl className="mt-2 space-y-1 text-xs text-gray-500 dark:text-gray-400">
                  <div>
                    <dt className="inline font-medium">路径：</dt>
                    <dd className="inline break-all">{filePath}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">大小：</dt>
                    <dd className="inline">
                      {content.length.toLocaleString()} 字符
                      {content.length > PREVIEW_LIMIT && '（预览已截断）'}
                    </dd>
                  </div>
                </dl>
                <pre className="mt-3 max-h-80 overflow-auto rounded bg-gray-100 p-3 text-xs leading-relaxed text-gray-800 dark:bg-gray-800 dark:text-gray-100">
                  {content.slice(0, PREVIEW_LIMIT)}
                </pre>
              </>
            ) : (
              <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                还没有打开文件。用工具栏的「打开文件」或按 Cmd+O 选一个文本文件试试。
              </p>
            )}
          </section>
        </div>
      </main>

      <Toast />
    </div>
  )
}

export default App
