import { Component, Suspense, lazy, type ReactNode } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { DIFF_PAGE_SIZE, isDiffActive, isSyncActive } from '../../shared/constants'
import type { DiffPhase, DiffText } from '../../shared/types'
import { useStore } from '../store'

const DiffEditor = lazy(() => import('./DiffEditor'))
const labels: Record<DiffPhase, string> = {
  scanning: '扫描文件',
  comparing: '比较内容',
  cancelling: '正在取消',
  success: '扫描完成',
  partial: '部分文件未比较',
  cancelled: '扫描已取消',
  failed: '扫描失败，结果不完整'
}
const button =
  'rounded border border-gray-300 px-3 py-1 text-xs hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:hover:bg-gray-800'
const time = (value: string | null): string =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未知'
const size = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`

class EditorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(error: Error): { error: string } {
    return { error: error.message }
  }
  render(): ReactNode {
    return this.state.error ? (
      <p role="alert" className="p-4 text-sm text-red-500">
        对比视图加载失败：{this.state.error}。请返回后重新打开。
      </p>
    ) : (
      this.props.children
    )
  }
}

function Meta({ label, value }: { label: string; value: DiffText }): JSX.Element {
  return (
    <div className="min-w-0 flex-1 px-4 py-2">
      <strong>{label}</strong> · {size(value.size)} · {time(value.modifiedAt)}
      <p className="mt-1 text-gray-500 dark:text-gray-400">
        UTF-8{value.bom ? '（含 BOM）' : '（无 BOM）'} · {value.eol} ·{' '}
        {value.finalNewline ? '末尾有换行' : '末尾无换行'}
      </p>
    </div>
  )
}

function DiffDetail(): JSX.Element | null {
  const detail = useStore((s) => s.diffDetail)
  const state = useStore((s) => s.diffSnapshot.state)
  const busy = useStore((s) => s.diffSnapshot.busy || isSyncActive(s.syncState?.phase))
  const close = useStore((s) => s.closeDiffFile)
  const open = useStore((s) => s.openDiffFile)
  if (!detail) return null
  const result = detail.result
  const formatOnly =
    result?.kind === 'different' &&
    result.local.content.replace(/\r\n|\r/g, '\n') ===
      result.remote.content.replace(/\r\n|\r/g, '\n')
  return (
    <div
      data-testid="diff-detail"
      className="absolute inset-0 z-10 flex min-h-0 flex-col bg-white text-gray-800 dark:bg-gray-900 dark:text-gray-100"
    >
      <div className="titlebar-drag flex h-10 shrink-0 items-center gap-3 border-b border-gray-200 px-20 dark:border-gray-700">
        <button className="titlebar-no-drag shrink-0" title="返回差异列表" onClick={close}>
          <ArrowLeft size={16} />
        </button>
        <span title={detail.key} className="min-w-0 flex-1 truncate font-mono text-xs">
          {detail.key} · 只读对比
        </span>
        <button
          className={`titlebar-no-drag ${button}`}
          disabled={busy || detail.status === 'loading'}
          onClick={() => void open(detail.key)}
        >
          重新读取
        </button>
      </div>
      <p className="break-all px-4 py-2 text-xs text-gray-500">
        本地：{state?.localDir}/{detail.key}
        <br />
        云端：oss://{state?.bucket}/{detail.key}
      </p>
      {state?.stale && (
        <p role="status" className="px-4 py-1 text-xs text-amber-600">
          此 Bucket 已发生同步或保存，当前显示读取时的内容，可重新读取。
        </p>
      )}
      {detail.status === 'loading' && (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm">
          <Loader2 size={16} className="animate-spin" />
          正在读取两端内容…
        </div>
      )}
      {detail.error && (
        <p role="alert" className="p-4 text-sm text-red-500">
          {detail.error}
        </p>
      )}
      {result && result.kind !== 'different' && (
        <p role="status" className="p-4 text-sm">
          {result.message}
        </p>
      )}
      {result?.kind === 'different' && (
        <>
          <p className="px-4 text-xs text-gray-500">
            读取时间：{time(result.readAt)}
            {result.changed ? ' · 内容较扫描时已有变化，已展示最新结果' : ''}
          </p>
          <div className="mt-2 flex shrink-0 divide-x divide-gray-200 border-y border-gray-200 bg-gray-50 text-xs dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-800">
            <Meta label="本地" value={result.local} />
            <Meta label="云端" value={result.remote} />
          </div>
          {formatOnly && (
            <p role="status" className="px-4 py-2 text-xs text-amber-600">
              正文相同，原始字节存在差异；请查看两侧 BOM 和换行类型。
            </p>
          )}
          <EditorBoundary key={detail.requestId}>
            <Suspense fallback={<p className="p-4 text-sm">正在加载对比视图…</p>}>
              <DiffEditor local={result.local.content} remote={result.remote.content} />
            </Suspense>
          </EditorBoundary>
        </>
      )}
    </div>
  )
}

export function DiffPage(): JSX.Element | null {
  const visible = useStore((s) => s.diffVisible)
  const snapshot = useStore((s) => s.diffSnapshot)
  const pending = useStore((s) => s.diffPending)
  const syncBusy = useStore((s) => isSyncActive(s.syncState?.phase))
  const error = useStore((s) => s.diffError)
  const entries = useStore((s) => s.diffEntries)
  const issues = useStore((s) => s.diffIssues)
  const page = useStore((s) => s.diffPage)
  const pageLoading = useStore((s) => s.diffPageLoading)
  const start = useStore((s) => s.startDiff)
  const cancel = useStore((s) => s.cancelDiff)
  const close = useStore((s) => s.closeDiff)
  const load = useStore((s) => s.loadDiffPage)
  const loadIssues = useStore((s) => s.loadDiffIssues)
  const open = useStore((s) => s.openDiffFile)
  if (!visible) return null
  const state = snapshot.state
  const active = isDiffActive(state?.phase)
  const pages = Math.max(1, Math.ceil((state?.different ?? 0) / DIFF_PAGE_SIZE))
  return (
    <section
      data-testid="diff-page"
      aria-label="文本差异"
      className="absolute inset-0 z-40 flex min-h-0 flex-col bg-white text-gray-800 dark:bg-gray-900 dark:text-gray-100"
    >
      <div className="titlebar-drag flex h-10 shrink-0 items-center gap-3 border-b border-gray-200 px-20 dark:border-gray-700">
        <button
          disabled={pending}
          className="titlebar-no-drag disabled:opacity-40"
          title="返回文件列表"
          onClick={() => void close()}
        >
          <ArrowLeft size={16} />
        </button>
        <strong className="flex-1 text-xs">文本文件 Diff · 只读 · 两侧各不超过 2 MB</strong>
        {active ? (
          <button
            className={`titlebar-no-drag ${button}`}
            disabled={state?.phase === 'cancelling'}
            onClick={() => void cancel()}
          >
            取消扫描
          </button>
        ) : (
          <button
            className={`titlebar-no-drag ${button}`}
            disabled={pending || snapshot.busy || syncBusy}
            onClick={() => void start()}
          >
            重新扫描
          </button>
        )}
      </div>
      <div className="shrink-0 border-b border-gray-200 px-4 py-3 text-xs dark:border-gray-700">
        <p className="break-all">
          {state?.bucket} ↔ {state?.localDir}
        </p>
        <p role="status" className="mt-2">
          {state ? labels[state.phase] : '正在开始扫描…'} · 差异 {state?.different ?? 0} · 相同{' '}
          {state?.unchanged ?? 0} · 未比较 {state?.uncompared ?? 0}
        </p>
        {active && (
          <>
            <p className="mt-2">
              {state?.total === null
                ? `已发现 ${state.discovered} 个云端对象`
                : `已比较 ${state?.processed} / ${state?.total} 项`}
            </p>
            {state?.total !== null && (
              <progress
                className="mt-1 w-full"
                aria-label="Diff 扫描进度"
                value={state?.processed ?? 0}
                max={Math.max(1, state?.total ?? 0)}
              />
            )}
            <p className="truncate" title={state?.currentFile ?? ''}>
              {state?.currentFile}
            </p>
          </>
        )}
        {state?.message && <p className="mt-2 text-amber-600">{state.message}</p>}
        {state?.stale && (
          <p className="mt-2 text-amber-600">
            此 Bucket 已发生同步或保存，列表可能过期，请重新扫描。
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-red-500">
            {error}
          </p>
        )}
      </div>
      <div data-testid="diff-list-scroll" className="min-h-0 flex-1 overflow-auto">
        {!active && state && (
          <>
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-gray-50 text-gray-500 dark:bg-gray-800">
                <tr>
                  <th className="p-3">文件（相对路径）</th>
                  <th className="p-3">本地大小 / 修改时间</th>
                  <th className="p-3">云端大小 / 修改时间</th>
                  <th className="p-3">操作</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((file) => (
                  <tr key={file.key} className="border-b border-gray-100 dark:border-gray-800">
                    <td className="break-all p-3 font-mono">{file.key}</td>
                    <td className="whitespace-nowrap p-3">
                      {size(file.local.size)}
                      <br />
                      <span className="text-gray-500">{time(file.local.modifiedAt)}</span>
                    </td>
                    <td className="whitespace-nowrap p-3">
                      {size(file.remote.size)}
                      <br />
                      <span className="text-gray-500">{time(file.remote.modifiedAt)}</span>
                    </td>
                    <td className="p-3">
                      <button
                        className={button}
                        aria-label={`查看 ${file.key} 的 Diff`}
                        disabled={snapshot.busy || syncBusy || pending}
                        onClick={() => void open(file.key)}
                      >
                        Diff
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pageLoading && <p className="p-4 text-sm text-gray-500">正在加载结果…</p>}
            {!pageLoading && state.different === 0 && (
              <p role="status" className="p-6 text-center text-sm text-gray-500">
                {state.phase === 'success'
                  ? state.total === 0
                    ? '没有符合条件的两端文本文件'
                    : '符合条件的文本文件内容一致'
                  : '已完成比较的文件中未发现差异；本次扫描存在未比较项或尚未完成。'}
              </p>
            )}
            {pages > 1 && (
              <div className="flex items-center justify-center gap-4 p-3">
                <button
                  className={button}
                  disabled={page === 0 || pageLoading}
                  onClick={() => void load(page - 1)}
                >
                  上一页
                </button>
                <span className="text-xs">
                  {page + 1} / {pages}
                </span>
                <button
                  className={button}
                  disabled={page + 1 >= pages || pageLoading}
                  onClick={() => void load(page + 1)}
                >
                  下一页
                </button>
              </div>
            )}
            {state.uncompared > 0 && (
              <details className="m-4 rounded border border-amber-200 p-3 text-xs dark:border-amber-900">
                <summary className="cursor-pointer">未比较详情（{state.uncompared}）</summary>
                <ul className="mt-3 space-y-2">
                  {issues.map((item) => (
                    <li key={item.key} className="break-all">
                      {item.key || '任务'}：{item.message}
                      {item.requestId ? `（requestId: ${item.requestId}）` : ''}
                    </li>
                  ))}
                </ul>
                {issues.length < state.uncompared && (
                  <button className={`${button} mt-3`} onClick={() => void loadIssues(true)}>
                    加载更多详情
                  </button>
                )}
              </details>
            )}
          </>
        )}
      </div>
      <DiffDetail />
    </section>
  )
}
