import { useEffect } from 'react'
import { ChevronRight, FileText, Folder, Loader2, RefreshCw } from 'lucide-react'
import { useStore } from '../store'
import type { OssDirState } from '../store/types'
import { isSyncActive } from '../../shared/constants'
import { isTextFileName } from '../../shared/path'

/** 字节数的人类可读格式 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit++
  } while (value >= 1024 && unit < units.length - 1)
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

/** GMT 字符串转本地时间展示，解析失败原样返回 */
function formatTime(gmt: string): string {
  const date = new Date(gmt)
  return Number.isNaN(date.getTime()) ? gmt : date.toLocaleString('zh-CN', { hour12: false })
}

/** 目录前缀 / 完整 key → 当前层级的显示名（去掉结尾 /） */
function baseName(key: string): string {
  return key.split('/').filter(Boolean).pop() ?? key
}

/**
 * 文件列表页：固定浏览 .env 配置的 bucket，目录懒加载、逐级展开的树形展示。
 * 状态与请求逻辑在 store/ossSlice，本组件只做渲染。
 */
export function OssPanel(): JSX.Element {
  const syncState = useStore((s) => s.syncState)
  const syncRequestPending = useStore((s) => s.syncRequestPending)
  const syncDirLocal = useStore((s) => s.syncDirLocal)
  const syncConfigError = useStore((s) => s.syncConfigError)
  const startSync = useStore((s) => s.startSync)
  const startDiff = useStore((s) => s.startDiff)
  const diffBusy = useStore((s) => s.diffSnapshot.busy || s.diffPending)
  const busy = isSyncActive(syncState?.phase) || syncRequestPending || diffBusy
  const activeBucket = useStore((s) => s.activeBucket)
  const configError = useStore((s) => s.configError)
  const dirStates = useStore((s) => s.dirStates)
  const bootstrap = useStore((s) => s.bootstrap)
  const toggleDir = useStore((s) => s.toggleDir)
  const loadMore = useStore((s) => s.loadMore)
  const openTextFile = useStore((s) => s.openTextFile)

  // 首屏引导：读 .env 连接配置并自动进入默认 bucket。
  // store action 不是 React setState，不受 set-state-in-effect 约束
  useEffect(() => {
    void bootstrap(false)
  }, [bootstrap])

  /** 文件行：纯文本文件可点击进入在线编辑，其余暂时只展示 */
  const renderFileRow = (
    file: { key: string; size: number; lastModified: string },
    depth: number
  ): JSX.Element => {
    const inner = (
      <>
        <FileText size={14} className="shrink-0 text-gray-400" />
        <span
          className={`truncate font-mono text-xs ${
            isTextFileName(file.key)
              ? 'text-blue-600 dark:text-blue-400'
              : 'text-gray-700 dark:text-gray-300'
          }`}
          title={file.key}
        >
          {baseName(file.key)}
        </span>
        <span className="ml-auto shrink-0 whitespace-nowrap text-[11px] text-gray-400">
          {formatSize(file.size)} · {formatTime(file.lastModified)}
        </span>
      </>
    )

    const style = { paddingLeft: depth * 18 + 10 }

    if (isTextFileName(file.key)) {
      return (
        <button
          type="button"
          key={file.key}
          onClick={() => openTextFile(file.key)}
          title="点击在线编辑"
          className="flex w-full items-center gap-1.5 rounded py-1 pr-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/60"
          style={style}
        >
          {inner}
        </button>
      )
    }
    return (
      <div key={file.key} className="flex items-center gap-1.5 rounded py-1 pr-3" style={style}>
        {inner}
      </div>
    )
  }

  /** 递归渲染某个目录的子内容（不含目录自身那一行） */
  const renderChildren = (prefix: string, depth: number): JSX.Element | null => {
    const state = dirStates[prefix]
    if (!state || !state.expanded) return null

    return (
      <>
        {state.dirs.map((dirPrefix) => renderDirRow(dirPrefix, depth))}
        {state.files.map((file) => renderFileRow(file, depth))}

        {state.status === 'loading' && (
          <div
            className="flex items-center gap-1.5 py-1 text-[11px] text-gray-400"
            style={{ paddingLeft: depth * 18 + 10 }}
          >
            <Loader2 size={12} className="animate-spin" />
            加载中…
          </div>
        )}

        {state.status === 'error' && (
          <div
            className="flex items-center gap-2 py-1 text-[11px] text-red-500"
            style={{ paddingLeft: depth * 18 + 10 }}
          >
            <span className="truncate">{state.error}</span>
            <button
              type="button"
              className="shrink-0 text-blue-600 hover:underline dark:text-blue-400"
              onClick={() => toggleDir(prefix)}
            >
              重试
            </button>
          </div>
        )}

        {state.status === 'loaded' && state.dirs.length === 0 && state.files.length === 0 && (
          <div className="py-1 text-[11px] text-gray-400" style={{ paddingLeft: depth * 18 + 10 }}>
            空目录
          </div>
        )}

        {state.nextToken && state.status !== 'loading' && state.status !== 'error' && (
          <button
            type="button"
            className="block py-1 text-[11px] text-blue-600 hover:underline dark:text-blue-400"
            style={{ paddingLeft: depth * 18 + 10 }}
            onClick={() => loadMore(prefix)}
          >
            加载更多
          </button>
        )}
      </>
    )
  }

  /** 目录行：箭头 + 文件夹图标 + 名称，点击展开/收起 */
  const renderDirRow = (dirPrefix: string, depth: number): JSX.Element => {
    const state: OssDirState | undefined = dirStates[dirPrefix]
    const expanded = state?.expanded ?? false
    const loading = state?.status === 'loading'

    return (
      <div key={dirPrefix}>
        <button
          type="button"
          onClick={() => toggleDir(dirPrefix)}
          title={dirPrefix}
          className="flex w-full items-center gap-1.5 rounded py-1 pr-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/60"
          style={{ paddingLeft: depth * 18 + 4 }}
        >
          <ChevronRight
            size={13}
            className={`shrink-0 text-gray-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
          {loading ? (
            <Loader2 size={14} className="shrink-0 animate-spin text-gray-400" />
          ) : (
            <Folder size={14} className="shrink-0 text-amber-500" />
          )}
          <span className="truncate font-mono text-xs font-medium text-gray-700 dark:text-gray-200">
            {baseName(dirPrefix)}
          </span>
          {state?.status === 'error' && (
            <span className="shrink-0 text-[11px] text-red-500">加载失败，点击重试</span>
          )}
        </button>
        {renderChildren(dirPrefix, depth + 1)}
      </div>
    )
  }

  const rootState = dirStates['']

  // 连接配置出错：给出原因与重试入口（过渡态，与列表无关，保留内边距）
  if (configError) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-600 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-400">
          <p>{configError}</p>
          <button
            type="button"
            className="mt-2 text-blue-600 hover:underline dark:text-blue-400"
            onClick={() => void bootstrap()}
          >
            重试
          </button>
        </div>
      </div>
    )
  }

  // 配置读取中
  if (!activeBucket) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-gray-400">
        <Loader2 size={14} className="animate-spin" />
        正在连接 OSS…
      </div>
    )
  }

  // 列表紧贴窗口四周：自身不带外边距/圆角/外框，上边框由工具栏的 border-b 提供
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
        <span className="font-mono text-xs font-medium text-gray-900 dark:text-gray-100">
          {activeBucket}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={busy || !syncDirLocal || !!syncConfigError}
            title={
              syncConfigError ??
              (busy
                ? '请等待当前同步、保存或 Diff 读取结束'
                : '比较本地与云端的文本内容（两侧各不超过 5 MB）')
            }
            onClick={() => void startDiff()}
            className="rounded border border-blue-600 px-3 py-1 text-xs text-blue-600 disabled:opacity-40 dark:text-blue-400"
          >
            Diff
          </button>
          <button
            type="button"
            disabled={busy || !syncDirLocal || !!syncConfigError}
            onClick={() => void startSync('download')}
            className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-40"
          >
            同步到本地
          </button>
          <button
            type="button"
            disabled={busy || !syncDirLocal || !!syncConfigError}
            onClick={() => void startSync('upload')}
            className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-40"
          >
            同步到云端
          </button>
          <button
            disabled={busy}
            type="button"
            title="刷新（重新读取配置并回到根目录）"
            aria-label="刷新"
            onClick={() => void bootstrap()}
            className="rounded p-1 text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>
      <div className="break-all border-b border-gray-200 px-3 py-1 text-xs text-gray-500 dark:border-gray-700">
        {syncConfigError ?? `本地目录：${syncDirLocal ?? '未配置'}`}
      </div>
      <div className="flex-1 overflow-auto py-1">
        {rootState?.status === 'error' ? (
          <p className="px-3 py-4 text-xs text-red-500">
            {rootState.error}
            <button
              type="button"
              className="ml-2 text-blue-600 hover:underline dark:text-blue-400"
              onClick={() => toggleDir('')}
            >
              重试
            </button>
          </p>
        ) : (
          renderChildren('', 0)
        )}
      </div>
    </div>
  )
}
