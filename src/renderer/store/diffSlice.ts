import type { StateCreator } from 'zustand'
import { DIFF_PAGE_SIZE, isDiffActive, isSyncActive } from '../../shared/constants'
import type { OssResult } from '../../shared/types'
import type { DiffSlice, StoreState } from './types'

function data<T>(result: OssResult<T> | undefined): T {
  if (!result) throw new Error('无法调用主进程接口')
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

export const createDiffSlice: StateCreator<
  StoreState,
  [['zustand/subscribeWithSelector', never]],
  [],
  DiffSlice
> = (set, get) => {
  let epoch = 0,
    pages = 0,
    issues = 0,
    reads = 0
  return {
    diffSnapshot: { revision: -1, busy: false, state: null },
    diffVisible: false,
    diffPending: false,
    diffError: null,
    diffEntries: [],
    diffIssues: [],
    diffPage: 0,
    diffPageLoading: false,
    diffDetail: null,
    applyDiffSnapshot: (snapshot) => {
      const previous = get().diffSnapshot
      if (snapshot.revision <= previous.revision) return
      set({ diffSnapshot: snapshot })
      const state = snapshot.state
      if (
        get().diffVisible &&
        state &&
        !isDiffActive(state.phase) &&
        (previous.state?.taskId !== state.taskId ||
          isDiffActive(previous.state?.phase) ||
          previous.state?.different !== state.different ||
          previous.state?.uncompared !== state.uncompared)
      ) {
        void get().loadDiffPage()
        void get().loadDiffIssues()
      }
    },
    startDiff: async () => {
      if (
        get().diffPending ||
        get().diffSnapshot.busy ||
        isSyncActive(get().syncState?.phase) ||
        get().syncRequestPending ||
        get().editor
      )
        return
      const current = ++epoch
      ++reads
      ++pages
      ++issues
      set({
        diffVisible: true,
        diffPending: true,
        diffError: null,
        diffEntries: [],
        diffIssues: [],
        diffPage: 0,
        diffDetail: null
      })
      try {
        data(await window.electronAPI?.startOssDiff())
        const snapshot = await window.electronAPI?.getOssDiffState()
        if (current === epoch && snapshot) {
          get().applyDiffSnapshot(snapshot)
          if (snapshot.state && !isDiffActive(snapshot.state.phase)) {
            await get().loadDiffPage()
            await get().loadDiffIssues()
          }
        }
      } catch (error) {
        if (current === epoch) set({ diffError: String(error) })
      } finally {
        if (current === epoch) set({ diffPending: false })
      }
    },
    cancelDiff: async () => {
      const taskId = get().diffSnapshot.state?.taskId
      if (!taskId) return
      try {
        data(await window.electronAPI?.cancelOssDiff(taskId))
      } catch (error) {
        set({ diffError: String(error) })
      }
    },
    closeDiff: async () => {
      if (get().diffPending) return
      const taskId = get().diffSnapshot.state?.taskId
      ++epoch
      ++reads
      ++pages
      ++issues
      set({
        diffVisible: false,
        diffPending: true,
        diffDetail: null,
        diffEntries: [],
        diffIssues: [],
        diffError: null,
        diffPage: 0,
        diffPageLoading: false
      })
      try {
        if (taskId) data(await window.electronAPI?.endOssDiff(taskId))
      } catch (error) {
        get().showToast(String(error), 'error')
      } finally {
        set({ diffPending: false })
      }
    },
    loadDiffPage: async (requested) => {
      const state = get().diffSnapshot.state
      if (!state || !get().diffVisible || isDiffActive(state.phase)) return
      const page = Math.max(
        0,
        Math.min(
          requested ?? get().diffPage,
          Math.max(0, Math.ceil(state.different / DIFF_PAGE_SIZE) - 1)
        )
      )
      const request = ++pages,
        current = epoch
      set({ diffPage: page, diffPageLoading: true })
      try {
        const result = data(
          await window.electronAPI?.getOssDiffEntries(state.taskId, page * DIFF_PAGE_SIZE)
        )
        if (
          current === epoch &&
          request === pages &&
          get().diffSnapshot.state?.taskId === state.taskId
        )
          set({ diffEntries: result.items })
      } catch (error) {
        if (current === epoch && request === pages) set({ diffError: String(error) })
      } finally {
        if (current === epoch && request === pages) set({ diffPageLoading: false })
      }
    },
    loadDiffIssues: async (more = false) => {
      const state = get().diffSnapshot.state
      if (!state || !get().diffVisible || isDiffActive(state.phase)) return
      const offset = more ? get().diffIssues.length : 0
      const request = ++issues,
        current = epoch
      try {
        const result = data(await window.electronAPI?.getOssDiffIssues(state.taskId, offset))
        if (
          current === epoch &&
          request === issues &&
          get().diffSnapshot.state?.taskId === state.taskId
        )
          set({ diffIssues: more ? [...get().diffIssues, ...result.items] : result.items })
      } catch (error) {
        if (current === epoch && request === issues) set({ diffError: String(error) })
      }
    },
    openDiffFile: async (key) => {
      const state = get().diffSnapshot.state
      if (!state || isDiffActive(state.phase)) return
      const previous = get().diffDetail
      if (get().diffPending || get().syncRequestPending || isSyncActive(get().syncState?.phase)) {
        get().showToast('同步或任务切换进行中，请稍后查看 Diff', 'error')
        return
      }
      // 自己的 loading 请求可以先取消再切换；其他任务的占用不应清空当前详情。
      if (get().diffSnapshot.busy && previous?.status !== 'loading') {
        get().showToast('其他 Diff 读取进行中，请稍后重试', 'error')
        return
      }
      const request = ++reads,
        current = epoch
      const requestId = `${current}-${request}`
      set({ diffDetail: { key, requestId, status: 'loading', result: null, error: null } })
      try {
        if (previous?.status === 'loading')
          data(await window.electronAPI?.cancelOssDiffRead(state.taskId, previous.requestId))
        if (request !== reads || current !== epoch) return
        const result = data(await window.electronAPI?.readOssDiff(state.taskId, key, requestId))
        if (
          request !== reads ||
          current !== epoch ||
          get().diffSnapshot.state?.taskId !== state.taskId
        )
          return
        set({ diffDetail: { key, requestId, status: 'loaded', result, error: null } })
        // 内容仍不同时计数可能不变，仍需刷新该行的大小、时间与指纹。
        void get().loadDiffPage()
        void get().loadDiffIssues()
      } catch (error) {
        if (request === reads && current === epoch)
          set({
            diffDetail: { key, requestId, status: 'error', result: null, error: String(error) }
          })
      }
    },
    closeDiffFile: () => {
      const detail = get().diffDetail,
        taskId = get().diffSnapshot.state?.taskId
      ++reads
      set({ diffDetail: null })
      if (taskId && detail?.status === 'loading')
        void window.electronAPI?.cancelOssDiffRead(taskId, detail.requestId).catch(() => {})
    }
  }
}
