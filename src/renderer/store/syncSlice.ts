import type { StateCreator } from 'zustand'
import type { StoreState, SyncSlice } from './types'
import { isSyncActive } from '../../shared/constants'

export const createSyncSlice: StateCreator<
  StoreState,
  [['zustand/subscribeWithSelector', never]],
  [],
  SyncSlice
> = (set, get) => ({
  syncState: null,
  syncIssues: [],
  syncError: null,
  syncRequestPending: false,
  applySyncState: (state) => {
    const current = get().syncState
    if (current && current.revision >= state.revision) return
    const newTask = current?.taskId !== state.taskId
    set({ syncState: state, ...(newTask ? { syncIssues: [], syncError: null } : {}) })
    if (
      state.direction === 'upload' &&
      !isSyncActive(state.phase) &&
      get().activeBucket === state.bucket
    ) {
      get().refreshBucket()
    }
  },
  startSync: async (direction) => {
    if (get().syncRequestPending || isSyncActive(get().syncState?.phase)) return
    set({ syncRequestPending: true, syncError: null })
    try {
      const result = await window.electronAPI?.startOssSync(direction)
      if (!result?.ok)
        throw new Error(result && !result.ok ? result.error.message : '无法调用主进程接口')
      const state = await window.electronAPI?.getOssSyncState()
      if (state) get().applySyncState(state)
    } catch (err) {
      set({ syncError: String(err) })
    } finally {
      set({ syncRequestPending: false })
    }
  },
  cancelSync: async () => {
    const state = get().syncState
    if (!state) return
    try {
      const result = await window.electronAPI?.cancelOssSync(state.taskId)
      if (result && !result.ok) throw new Error(result.error.message)
    } catch (err) {
      set({ syncError: String(err) })
    }
  },
  loadSyncIssues: async () => {
    const { syncState, syncIssues } = get()
    if (!syncState) return
    const offset = syncIssues.length
    try {
      const page = await window.electronAPI?.getOssSyncIssues(syncState.taskId, offset)
      if (
        page &&
        get().syncState?.taskId === syncState.taskId &&
        get().syncIssues.length === offset
      )
        set({ syncIssues: [...get().syncIssues, ...page.items] })
    } catch (err) {
      set({ syncError: String(err) })
    }
  }
})
