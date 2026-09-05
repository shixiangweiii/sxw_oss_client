import type { StateCreator } from 'zustand'
import type { OssDirState, OssSlice, StoreState } from './types'
import type { OssErrorInfo, OssObjectListing } from '../../shared/types'
import { MAX_TEXT_EDIT_BYTES, isSyncActive } from '../../shared/constants'
import { fileName } from '../../shared/path'

/** 错误格式化成一行可读文本（渲染层不关心结构，只负责展示） */
function describeOssError(error: OssErrorInfo): string {
  const code = error.code ? `[${error.code}] ` : ''
  const requestId = error.requestId ? `（requestId: ${error.requestId}）` : ''
  return `${code}${error.message}${requestId}`
}

function emptyDir(): OssDirState {
  return { expanded: false, status: 'loading', dirs: [], files: [], nextToken: null, error: null }
}

/**
 * OSS 文件树 slice。
 *
 * 数据按目录懒加载：展开某目录才请求该 prefix 的内容，结果落在 dirStates[prefix]。
 * 状态放 store 而不是组件 useState：目录展开是跨组件、可编程触发的行为，
 * 且 zustand 的 get() 能在 action 内读到最新状态做竞态防护，不需要 ref 镜像。
 */
export const createOssSlice: StateCreator<
  StoreState,
  [['zustand/subscribeWithSelector', never]],
  [],
  OssSlice
> = (set, get) => {
  let bootstrapId = 0
  let treeId = 0
  let editorId = 0
  const directoryRequests = new Map<string, symbol>()
  return {
    syncDirLocal: null,
    syncConfigError: null,
    activeBucket: null,
    configError: null,
    dirStates: {},
    editor: null,

    bootstrap: async (reload = true) => {
      // 编辑期间不得更换连接；刷新隐藏在编辑页后，action 本身也做保护。
      if (get().editor || (reload && isSyncActive(get().syncState?.phase))) return
      const requestId = ++bootstrapId
      ++treeId
      directoryRequests.clear()
      set({ configError: null, activeBucket: null, dirStates: {} })
      let configRes
      try {
        configRes = await window.electronAPI?.getOssConfig(reload)
        if (!configRes) throw new Error('无法调用主进程接口')
      } catch (err) {
        if (requestId === bootstrapId) set({ configError: String(err) })
        return
      }
      if (requestId !== bootstrapId) return

      if (!configRes.ok) {
        set({ configError: describeOssError(configRes.error) })
        return
      }
      set({
        syncDirLocal: configRes.data.syncDirLocal ?? null,
        syncConfigError: configRes.data.syncConfigError ?? null
      })
      const { defaultBucket } = configRes.data
      if (!defaultBucket) {
        set({ configError: '未配置默认 bucket：请在项目根 .env 中设置 oss_bucket' })
        return
      }
      get().openBucket(defaultBucket)
    },

    openBucket: (name) => {
      if (get().editor) return
      ++treeId
      directoryRequests.clear()
      // 切 bucket / 重进 bucket：树整体作废，从根重新拉
      set({ activeBucket: name, dirStates: {} })
      void get().fetchDirPage(name, '', null)
    },

    refreshBucket: () => {
      const bucket = get().activeBucket
      if (!bucket) return
      ++treeId
      directoryRequests.clear()
      set({ dirStates: {} })
      void get().fetchDirPage(bucket, '', null)
    },

    toggleDir: (prefix) => {
      const { activeBucket, dirStates } = get()
      if (!activeBucket) return
      const state = dirStates[prefix]

      if (!state || state.status === 'error') {
        // 未加载过或上次失败：（重新）拉取，fetchDirPage 会把 expanded 置 true
        void get().fetchDirPage(activeBucket, prefix, null)
        return
      }
      if (state.status === 'loading') return // 请求在路上，别重复发

      // 已加载：纯本地展开/收起
      set({
        dirStates: {
          ...dirStates,
          [prefix]: { ...state, expanded: !state.expanded }
        }
      })
    },

    loadMore: (prefix) => {
      const { activeBucket, dirStates } = get()
      const state = dirStates[prefix]
      if (!activeBucket || !state?.nextToken || state.status === 'loading') return
      void get().fetchDirPage(activeBucket, prefix, state.nextToken)
    },

    /** 拉取某目录的一页内容。token 为 null 表示首页（重置该目录），否则追加 */
    fetchDirPage: async (bucket, prefix, token) => {
      const generation = treeId
      const request = Symbol(prefix)
      directoryRequests.set(prefix, request)
      // 标记 loading 但保留已有内容：翻页/重试时已渲染的行不闪烁
      set((s) => ({
        dirStates: {
          ...s.dirStates,
          [prefix]: {
            ...(s.dirStates[prefix] ?? emptyDir()),
            status: 'loading',
            expanded: true,
            error: null
          }
        }
      }))

      let result
      try {
        result = await window.electronAPI?.listOssObjects(bucket, prefix, token)
        if (!result) throw new Error('无法调用主进程接口')
      } catch (err) {
        result = { ok: false as const, error: { message: String(err) } }
      }

      // 响应回来时 bucket 可能已被切换，丢弃过期结果
      if (
        generation !== treeId ||
        directoryRequests.get(prefix) !== request ||
        get().activeBucket !== bucket
      )
        return

      if (result.ok) {
        const listing: OssObjectListing = result.data
        set((s) => {
          const current = s.dirStates[prefix] ?? emptyDir()
          return {
            dirStates: {
              ...s.dirStates,
              [prefix]: {
                ...current,
                status: 'loaded',
                expanded: true,
                error: null,
                dirs: token ? [...current.dirs, ...listing.prefixes] : listing.prefixes,
                files: token
                  ? [
                      ...current.files,
                      ...listing.objects.map((o) => ({
                        key: o.name,
                        size: o.size,
                        lastModified: o.lastModified,
                        storageClass: o.storageClass
                      }))
                    ]
                  : listing.objects.map((o) => ({
                      key: o.name,
                      size: o.size,
                      lastModified: o.lastModified,
                      storageClass: o.storageClass
                    })),
                nextToken: listing.nextContinuationToken
              }
            }
          }
        })
      } else {
        set((s) => ({
          dirStates: {
            ...s.dirStates,
            [prefix]: {
              ...(s.dirStates[prefix] ?? emptyDir()),
              status: 'error',
              error: describeOssError(result.error)
            }
          }
        }))
      }
    },

    openTextFile: (key) => {
      const bucket = get().activeBucket
      if (!bucket) return
      if (get().editor?.status === 'saving') return
      const sessionId = ++editorId
      set({
        editor: {
          sessionId,
          bucket,
          version: null,
          key,
          savedContent: '',
          draft: '',
          status: 'loading',
          error: null
        }
      })

      void (async () => {
        let result
        try {
          result = await window.electronAPI?.getOssObjectText(bucket, key)
          if (!result) throw new Error('无法调用主进程接口')
        } catch (err) {
          result = { ok: false as const, error: { message: String(err) } }
        }
        // 防过期：期间编辑器可能已关闭或切到了别的文件
        const current = get().editor
        if (!current || current.sessionId !== sessionId || get().activeBucket !== bucket) return
        if (result.ok) {
          set({
            editor: {
              key,
              bucket,
              sessionId,
              version: result.data.version,
              savedContent: result.data.content,
              draft: result.data.content,
              status: 'loaded',
              error: null
            }
          })
        } else {
          set({ editor: { ...current, status: 'error', error: describeOssError(result.error) } })
        }
      })()
    },

    setEditorDraft: (content) => {
      set((s) => (s.editor ? { editor: { ...s.editor, draft: content } } : {}))
    },

    saveEditor: async () => {
      const { editor, activeBucket } = get()
      if (!editor || !activeBucket) return
      if (isSyncActive(get().syncState?.phase)) {
        get().showToast('同步进行中，暂不能保存在线文本', 'error')
        return
      }
      if (editor.status !== 'loaded' || !editor.version) return
      if (new TextEncoder().encode(editor.draft).length > MAX_TEXT_EDIT_BYTES) {
        const error = '文本超过 2 MB，缩减内容后才能保存（按 UTF-8 字节计算）'
        set({ editor: { ...editor, error } })
        get().showToast(error, 'error')
        return
      }
      if (editor.draft === editor.savedContent) return // 没有修改就不发请求

      set((s) => (s.editor ? { editor: { ...s.editor, status: 'saving', error: null } } : {}))
      const generation = treeId
      let result
      try {
        result = await window.electronAPI?.putOssObjectText(
          editor.bucket,
          editor.key,
          editor.draft,
          editor.version
        )
        if (!result) throw new Error('无法调用主进程接口')
      } catch (err) {
        result = { ok: false as const, error: { message: String(err) } }
      }

      const current = get().editor
      if (!current || current.sessionId !== editor.sessionId) return // 编辑器已关或已切换

      if (result && result.ok) {
        set({
          editor: {
            ...current,
            savedContent: editor.draft,
            version: result.data.version,
            status: 'loaded',
            error: null
          }
        })

        // 同步目录列表里该条目的大小与时间，省一次重新拉取
        const dirPrefix = editor.key.slice(0, editor.key.lastIndexOf('/') + 1)
        const size = result.data.size
        const lastModified = new Date().toISOString()
        set((s) => {
          const dir = s.dirStates[dirPrefix]
          if (!dir || generation !== treeId || get().activeBucket !== editor.bucket) return {}
          return {
            dirStates: {
              ...s.dirStates,
              [dirPrefix]: {
                ...dir,
                files: dir.files.map((f) =>
                  f.key === editor.key ? { ...f, size, lastModified } : f
                )
              }
            }
          }
        })
        get().showToast(`已保存 ${fileName(editor.key)}`, 'success')
      } else {
        const error = result && !result.ok ? describeOssError(result.error) : '保存失败：未知错误'
        set({ editor: { ...current, status: 'loaded', error } })
        get().showToast(error, 'error')
      }
    },

    closeEditor: () => {
      if (get().editor?.status === 'saving') return
      ++editorId
      set({ editor: null })
    }
  }
}
