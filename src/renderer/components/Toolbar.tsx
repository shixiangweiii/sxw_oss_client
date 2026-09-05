import { AppWindow, Moon, Sun } from 'lucide-react'
import { IconButton } from './common/IconButton'
import { useStore } from '../store'

interface ToolbarProps {
  onToggleTheme: () => void
}

export function Toolbar({ onToggleTheme }: ToolbarProps): JSX.Element {
  const theme = useStore((s) => s.theme)
  const windowNumber = useStore((s) => s.windowNumber)

  const handleNewWindow = (): void => {
    // 把当前配置带给新窗口，主进程只负责透传
    window.electronAPI?.newWindow({ theme: useStore.getState().theme })
  }

  return (
    // 左右两侧 px-20 给 macOS 红绿灯按钮和右侧留出空间；整条是拖拽区，按钮各自 no-drag
    <div className="titlebar-drag flex h-10 items-center gap-1 border-b border-gray-200 bg-gray-50 px-20 dark:border-gray-700 dark:bg-gray-800">
      <div className="titlebar-no-drag flex items-center gap-1">
        <IconButton icon={<AppWindow size={16} />} label="新建窗口" onClick={handleNewWindow} />
      </div>

      <div className="titlebar-drag flex-1" />

      <span className="titlebar-no-drag select-none text-xs font-medium text-gray-500 dark:text-gray-400">
        OSS Client
        <span className="ml-2 text-gray-400 dark:text-gray-500">#{windowNumber}</span>
      </span>

      <div className="titlebar-drag flex-1" />

      <div className="titlebar-no-drag">
        <IconButton
          icon={theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          label={theme === 'dark' ? '切换为浅色外观' : '切换为深色外观'}
          onClick={onToggleTheme}
        />
      </div>
    </div>
  )
}
