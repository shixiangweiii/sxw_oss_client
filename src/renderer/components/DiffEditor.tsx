import { useEffect, useRef, useState } from 'react'
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/features/codicon/register'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker&inline'
import { useStore } from '../store'
import {
  createDiffEditorSession,
  type DiffComputation,
  type DiffRuntime
} from './diffEditorSession'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

export default function DiffEditor({
  local,
  remote
}: {
  local: string
  remote: string
}): JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const editorRef = useRef<DiffRuntime | null>(null)
  const theme = useStore((s) => s.theme)
  const [computation, setComputation] = useState<DiffComputation>('computing')
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!container.current) return
    const session = createDiffEditorSession(
      monaco.editor,
      container.current,
      local,
      remote,
      (state, count) => {
        setComputation(state)
        setCount(count)
      }
    )
    editorRef.current = session.editor
    return () => {
      editorRef.current = null
      session.dispose()
    }
  }, [local, remote])
  useEffect(() => {
    monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
  }, [theme])

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="diff-editor"
      data-computation={computation}
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-gray-200 px-4 py-2 text-xs dark:border-gray-700">
        <span role="status" className="flex-1">
          {computation === 'computing'
            ? '正在计算差异…'
            : computation === 'incomplete'
              ? '差异计算未完成（已达到 5 秒预算）'
              : computation === 'error'
                ? '差异计算失败，请返回后重新打开'
                : `逐行对比完成 · ${count} 处正文差异`}
        </span>
        {computation === 'incomplete' && (
          <button
            className="text-blue-600"
            onClick={() => {
              setComputation('computing')
              editorRef.current?.updateOptions({ maxComputationTime: 0 })
            }}
          >
            继续计算
          </button>
        )}
        <button
          disabled={computation !== 'complete' || !count}
          className="disabled:opacity-40"
          onClick={() => editorRef.current?.goToDiff('previous')}
        >
          上一处差异
        </button>
        <button
          disabled={computation !== 'complete' || !count}
          className="disabled:opacity-40"
          onClick={() => editorRef.current?.goToDiff('next')}
        >
          下一处差异
        </button>
      </div>
      <div ref={container} className="min-h-0 flex-1" />
    </div>
  )
}
