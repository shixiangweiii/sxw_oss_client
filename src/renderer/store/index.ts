import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { createUiSlice } from './uiSlice'
import { createFileSlice } from './fileSlice'
import type { StoreState } from './types'

/**
 * subscribeWithSelector 让组件之外也能按字段订阅（useStore.subscribe(selector, cb)），
 * 接入 Monaco 这类自带内部状态的第三方编辑器时会用到。
 *
 * 新增一个 slice：建好 xxxSlice.ts，在 store/types.ts 里并进 StoreState，再展开到下面。
 */
export const useStore = create<StoreState>()(
  subscribeWithSelector((...a) => ({
    ...createUiSlice(...a),
    ...createFileSlice(...a)
  }))
)

export type { StoreState } from './types'
