import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { UPLOAD_PREVIEW_PAGE_SIZE } from '../../shared/constants'
import type { UploadPreviewPage, UploadDecision } from '../../shared/types'
import { useStore } from '../store'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`
}

function PreviewDialog({ taskId }: { taskId: string }): JSX.Element | null {
  const [page, setPage] = useState<UploadPreviewPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [finished, setFinished] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const requestId = useRef({ value: 0 })
  const deciding = useRef(false)

  const loadPage = useCallback(
    async (offset: number): Promise<void> => {
      const id = ++requestId.current.value
      setLoading(true)
      setError(null)
      try {
        const result = await window.electronAPI!.getOssUploadPreview(taskId, offset)
        if (id !== requestId.current.value) return
        if (!result.ok) throw new Error(result.error.message)
        setPage(result.data)
      } catch (failure) {
        if (id === requestId.current.value) setError(String(failure))
      } finally {
        if (id === requestId.current.value) setLoading(false)
      }
    },
    [taskId]
  )

  useEffect(() => {
    // 首次读取延后到微任务，StrictMode 清理后不接受上一轮的结果。
    const requests = requestId.current
    const id = ++requests.value
    void Promise.resolve().then(() => {
      if (id === requests.value) void loadPage(0)
    })
    return () => {
      ++requests.value
    }
  }, [loadPage])

  const visible = !finished && (page !== null || error !== null)
  useEffect(() => {
    const element = dialog.current
    if (visible && element && !element.open) {
      element.showModal()
      cancelButton.current?.focus()
    }
  }, [visible])

  const decide = async (decision: UploadDecision): Promise<void> => {
    if (deciding.current) return
    deciding.current = true
    setSubmitting(true)
    setError(null)
    try {
      const result = await window.electronAPI!.confirmOssUpload(taskId, decision)
      if (!result.ok) throw new Error(result.error.message)
      ++requestId.current.value
      dialog.current?.close()
      setFinished(true)
    } catch (failure) {
      setError(String(failure))
    } finally {
      deciding.current = false
      setSubmitting(false)
    }
  }

  if (!visible) return null
  const button =
    'rounded border border-gray-300 px-3 py-1.5 disabled:opacity-40 dark:border-gray-600'
  return (
    <dialog
      ref={dialog}
      aria-labelledby="upload-preview-title"
      aria-describedby="upload-preview-note"
      className="m-auto w-[min(48rem,calc(100vw-3rem))] max-w-none rounded-xl border border-gray-200 bg-white p-0 text-sm text-gray-900 shadow-xl backdrop:bg-black/40 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
      onCancel={(event) => {
        event.preventDefault()
        void decide('cancel')
      }}
    >
      <div className="flex max-h-[85vh] flex-col">
        <div className="flex shrink-0 items-center justify-between border-b px-5 py-4 dark:border-gray-700">
          <h2 id="upload-preview-title" className="text-base font-semibold">
            确认同步到云端
          </h2>
          <button
            type="button"
            aria-label="关闭上传预览"
            disabled={submitting}
            onClick={() => void decide('cancel')}
            className="rounded p-1 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <X size={18} />
          </button>
        </div>
        {page && (
          <>
            <div className="shrink-0 space-y-1 break-all px-5 py-3">
              <p>
                目标 Bucket：<span className="font-mono">{page.bucket}</span>
              </p>
              <p>
                本地目录：<span className="font-mono">{page.localDir}</span>
              </p>
              <p className="pt-1 font-medium">
                本次同步范围：{page.fileCount} 个文件，共 {formatBytes(page.totalBytes)}
                {page.directoryCount > 0 && `，另有 ${page.directoryCount} 个空目录`}
              </p>
            </div>
            <div
              className="mx-5 min-h-0 overflow-auto rounded border dark:border-gray-700"
              aria-label="上传候选列表"
              aria-busy={loading}
            >
              <table className="w-full table-fixed text-left">
                <thead className="sticky top-0 bg-gray-100 dark:bg-gray-800">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      相对路径
                    </th>
                    <th scope="col" className="w-28 px-3 py-2 text-right font-medium">
                      大小
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((item) => (
                    <tr key={item.key} className="border-t dark:border-gray-700">
                      <td className="whitespace-pre-wrap break-all px-3 py-2 font-mono text-xs">
                        {item.key}
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-gray-500 dark:text-gray-400">
                        {item.kind === 'directory' ? '空目录' : formatBytes(item.size)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex shrink-0 items-center justify-between px-5 py-3 text-xs">
              <span>
                第 {Math.floor(page.offset / UPLOAD_PREVIEW_PAGE_SIZE) + 1} /{' '}
                {Math.ceil(page.total / UPLOAD_PREVIEW_PAGE_SIZE)} 页 · 共 {page.total} 项
                {loading && ' · 加载中…'}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={button}
                  disabled={loading || submitting || page.offset === 0}
                  onClick={() => void loadPage(page.offset - UPLOAD_PREVIEW_PAGE_SIZE)}
                >
                  上一页
                </button>
                <button
                  type="button"
                  className={button}
                  disabled={loading || submitting || page.offset + page.items.length >= page.total}
                  onClick={() => void loadPage(page.offset + UPLOAD_PREVIEW_PAGE_SIZE)}
                >
                  下一页
                </button>
              </div>
            </div>
          </>
        )}
        {error && (
          <div role="alert" className="shrink-0 px-5 py-2 text-red-600 dark:text-red-400">
            {error}{' '}
            <button
              type="button"
              className="underline"
              disabled={loading || submitting}
              onClick={() => void loadPage(page?.offset ?? 0)}
            >
              重新加载预览
            </button>
          </div>
        )}
        <div
          id="upload-preview-note"
          className="shrink-0 space-y-1 px-5 pb-4 text-xs text-gray-500 dark:text-gray-400"
        >
          <p>内容相同的文件会自动跳过。普通同步遇到云端较新的文件时，仍会逐个询问是否覆盖。</p>
          <p className="text-amber-700 dark:text-amber-400">
            一键同步全部：包括覆盖较新的云端文件，本次不再逐文件确认。排除规则仍然生效。
          </p>
          <p>扫描中无法同步的项目会在任务详情中说明。</p>
        </div>
        <div className="flex shrink-0 justify-end gap-3 border-t bg-gray-50 px-5 py-4 dark:border-gray-700 dark:bg-gray-800">
          <button
            type="button"
            ref={cancelButton}
            className={button}
            disabled={submitting}
            onClick={() => void decide('cancel')}
          >
            取消
          </button>
          <button
            type="button"
            className={button}
            disabled={!page || loading || submitting || !!error}
            onClick={() => void decide('normal')}
          >
            确认同步到云端
          </button>
          <button
            type="button"
            className="rounded bg-blue-600 px-4 py-1.5 text-white hover:bg-blue-700 disabled:opacity-40"
            disabled={!page || loading || submitting || !!error}
            onClick={() => void decide('overwrite-all')}
          >
            一键同步全部
          </button>
        </div>
      </div>
    </dialog>
  )
}

export function UploadPreview(): JSX.Element | null {
  const state = useStore((s) => s.syncState)
  return state?.phase === 'previewing' ? (
    <PreviewDialog key={state.taskId} taskId={state.taskId} />
  ) : null
}
