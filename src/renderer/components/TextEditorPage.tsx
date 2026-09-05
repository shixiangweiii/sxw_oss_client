import { useEffect, useRef } from 'react'
import { ArrowLeft, Loader2, Save } from 'lucide-react'
import { useStore } from '../store'
import { fileName } from '../../shared/path'
import type { OssEditorState } from '../store/types'

/**
 * 全屏文本编辑页：覆盖文件列表（fixed inset-0）。
 * 只负责渲染，内容与保存逻辑在 store/ossSlice。
 */
export function TextEditorPage(): JSX.Element | null {
  const editor = useStore((s) => s.editor)
  if (!editor) return null
  return <EditorView editor={editor} />
}

function EditorView({ editor }: { editor: OssEditorState }): JSX.Element {
  const setEditorDraft = useStore((s) => s.setEditorDraft)
  const saveEditor = useStore((s) => s.saveEditor)
  const closeEditor = useStore((s) => s.closeEditor)
  const openTextFile = useStore((s) => s.openTextFile)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 打开即聚焦；key 变化（切文件）时重新聚焦
  useEffect(() => {
    textareaRef.current?.focus()
  }, [editor.key])

  const dirty = editor.draft !== editor.savedContent

  const handleClose = (): void => {
    if (dirty && !window.confirm('有未保存的修改，确定关闭吗？')) return
    closeEditor()
  }

  // Cmd/Ctrl+S 保存、Esc 关闭（带脏确认）
  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void saveEditor()
    }
    if (event.key === 'Escape') {
      handleClose()
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col bg-white dark:bg-gray-900"
      onKeyDown={handleKeyDown}
    >
      {/* 顶栏：左右 px-20 给 macOS 红绿灯留位；整条可拖拽窗口，按钮 no-drag */}
      <div className="titlebar-drag flex h-10 shrink-0 items-center justify-between border-b border-gray-200 bg-gray-50 px-20 dark:border-gray-700 dark:bg-gray-800">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            title="返回文件列表"
            aria-label="返回文件列表"
            onClick={handleClose}
            className="titlebar-no-drag rounded p-1 text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          >
            <ArrowLeft size={16} />
          </button>
          <span
            className="truncate font-mono text-xs font-medium text-gray-900 dark:text-gray-100"
            title={editor.key}
          >
            {fileName(editor.key)}
          </span>
          {editor.status === 'saving' ? (
            <span className="shrink-0 text-[11px] text-gray-400">保存中…</span>
          ) : dirty ? (
            <span className="shrink-0 text-[11px] text-amber-500">未保存</span>
          ) : (
            editor.status === 'loaded' && (
              <span className="shrink-0 text-[11px] text-gray-400">已保存</span>
            )
          )}
        </div>

        <button
          type="button"
          onClick={() => void saveEditor()}
          disabled={!dirty || editor.status === 'saving'}
          className="titlebar-no-drag flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {editor.status === 'saving' ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Save size={13} />
          )}
          保存（⌘S）
        </button>
      </div>

      {/* 内容区 */}
      {editor.status === 'loading' ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-gray-400">
          <Loader2 size={16} className="animate-spin" />
          正在读取 {fileName(editor.key)} …
        </div>
      ) : editor.status === 'error' ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="max-w-md rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-600 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-400">
            <p className="break-all">{editor.error}</p>
            <div className="mt-3 flex gap-3">
              <button
                type="button"
                className="text-blue-600 hover:underline dark:text-blue-400"
                onClick={() => openTextFile(editor.key)}
              >
                重试
              </button>
              <button
                type="button"
                className="text-gray-500 hover:underline dark:text-gray-400"
                onClick={closeEditor}
              >
                返回列表
              </button>
            </div>
          </div>
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          value={editor.draft}
          onChange={(e) => setEditorDraft(e.target.value)}
          spellCheck={false}
          // 保存中仍可编辑：只锁快捷键与按钮，不打断输入
          className="flex-1 resize-none bg-transparent p-6 font-mono text-sm leading-relaxed text-gray-900 outline-none dark:text-gray-100"
          placeholder="(空文件)"
        />
      )}
    </div>
  )
}
