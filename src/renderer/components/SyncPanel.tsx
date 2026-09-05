import { useStore } from '../store'
import { isSyncActive } from '../../shared/constants'
import type { SyncPhase } from '../../shared/types'

const labels: Record<SyncPhase, string> = {
  scanning: '扫描中',
  comparing: '比较内容',
  confirming: '等待覆盖确认',
  transferring: '传输中',
  cancelling: '取消中',
  success: '已完成',
  partial: '部分失败',
  cancelled: '已取消',
  failed: '任务失败'
}
const issueStages: Record<string, string> = {
  scanning: '扫描',
  comparing: '比较',
  confirming: '覆盖确认',
  transferring: '传输',
  cleanup: '清理'
}

export function SyncPanel(): JSX.Element | null {
  const state = useStore((s) => s.syncState)
  const error = useStore((s) => s.syncError)
  const issues = useStore((s) => s.syncIssues)
  const cancel = useStore((s) => s.cancelSync)
  const loadIssues = useStore((s) => s.loadSyncIssues)
  if (!state && !error) return null
  return (
    <section
      aria-label="同步任务"
      className="z-50 max-h-[35vh] shrink-0 overflow-auto border-t border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
    >
      {error && (
        <p role="alert" className="text-red-500">
          {error}
        </p>
      )}
      {state && (
        <>
          <div className="flex items-center justify-between gap-2">
            <strong>
              {state.direction === 'download' ? '同步到本地' : '同步到云端'} · {labels[state.phase]}
            </strong>
            {isSyncActive(state.phase) && (
              <button
                type="button"
                disabled={state.phase === 'cancelling'}
                onClick={() => void cancel()}
                className="rounded border px-2 py-1 disabled:opacity-40"
              >
                取消同步
              </button>
            )}
          </div>
          <p className="mt-1 break-all">
            {state.bucket} ↔ {state.localDir}
          </p>
          <p role="status" className="mt-1">
            {state.total === null
              ? `已发现 ${state.discovered} 项`
              : `已处理 ${state.processed} / ${state.total} 项`}{' '}
            · 新增 {state.created} · 覆盖 {state.overwritten} · 内容相同 {state.unchanged} · 已跳过{' '}
            {state.skipped} · 失败 {state.failed}
          </p>
          {state.total !== null && (
            <progress
              aria-label="同步进度"
              value={state.processed}
              max={Math.max(1, state.total)}
              className="mt-1 w-full"
            />
          )}
          {state.currentFile && (
            <p className="truncate" title={state.currentFile}>
              当前：{state.currentFile}
            </p>
          )}
          {state.message && <p className="mt-1">{state.message}</p>}
          {state.issueCount > 0 && (
            <details
              className="mt-1"
              onToggle={(e) => {
                if (e.currentTarget.open && !issues.length) void loadIssues()
              }}
            >
              <summary className="cursor-pointer">查看失败与跳过详情（{state.issueCount}）</summary>
              <ul className="mt-1 space-y-1">
                {issues.map((issue, index) => (
                  <li key={index} className="break-all">
                    {issue.path || '任务'} · {issueStages[issue.phase] ?? issue.phase} ·{' '}
                    {issue.message}
                    {issue.requestId ? `（requestId: ${issue.requestId}）` : ''}
                  </li>
                ))}
              </ul>
              {issues.length < state.issueCount && (
                <button
                  type="button"
                  onClick={() => void loadIssues()}
                  className="mt-1 text-blue-600"
                >
                  加载更多详情
                </button>
              )}
            </details>
          )}
        </>
      )}
    </section>
  )
}
