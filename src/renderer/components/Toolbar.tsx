import { AppWindow, Download, Eraser, FileText, FolderOpen, Moon, Save, Sun } from 'lucide-react'
import { IconButton } from './common/IconButton'
import { useStore } from '../store'
import { fileName } from '../../shared/path'

interface ToolbarProps {
  onOpen: () => void
  onSave: () => void
  onSaveAs: () => void
  onClear: () => void
}

export function Toolbar({ onOpen, onSave, onSaveAs, onClear }: ToolbarProps): JSX.Element {
  const theme = useStore((s) => s.theme)
  const toggleTheme = useStore((s) => s.toggleTheme)
  const windowNumber = useStore((s) => s.windowNumber)
  const filePath = useStore((s) => s.filePath)

  const handleNewWindow = (): void => {
    // 把当前配置带给新窗口，主进程只负责透传
    window.electronAPI?.newWindow({ theme: useStore.getState().theme })
  }

  return (
    // 左右两侧 px-20 给 macOS 红绿灯按钮和右侧留出空间；整条是拖拽区，按钮各自 no-drag
    <div className="titlebar-drag flex h-10 items-center gap-1 border-b border-gray-200 bg-gray-50 px-20 dark:border-gray-700 dark:bg-gray-800">
      <div className="titlebar-no-drag flex items-center gap-1">
        <IconButton icon={<AppWindow size={16} />} label="新建窗口" onClick={handleNewWindow} />
        <div className="mx-1 h-5 w-px bg-gray-300 dark:bg-gray-600" />
        <IconButton icon={<FolderOpen size={16} />} label="打开文件" onClick={onOpen} />
        <IconButton icon={<Save size={16} />} label="保存" onClick={onSave} />
        <IconButton icon={<Download size={16} />} label="另存为" onClick={onSaveAs} />
        <IconButton
          icon={<Eraser size={16} />}
          label="清空"
          onClick={onClear}
          disabled={filePath === null}
        />
      </div>

      <div className="titlebar-drag flex-1" />

      <span className="titlebar-no-drag select-none text-xs font-medium text-gray-500 dark:text-gray-400">
        <FileText size={14} className="mr-1 inline" />
        {filePath ? (
          <span className="inline-block max-w-[240px] truncate align-bottom" title={filePath}>
            {fileName(filePath)}
          </span>
        ) : (
          '未打开文件'
        )}
        <span className="ml-2 text-gray-400 dark:text-gray-500">#{windowNumber}</span>
      </span>

      <div className="titlebar-drag flex-1" />

      <div className="titlebar-no-drag">
        <IconButton
          icon={theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          label={theme === 'dark' ? '切换为浅色外观' : '切换为深色外观'}
          onClick={toggleTheme}
        />
      </div>
    </div>
  )
}
