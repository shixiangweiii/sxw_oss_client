import type { StateCreator } from 'zustand'
import type { FileSlice, StoreState } from './types'

export const createFileSlice: StateCreator<
  StoreState,
  [['zustand/subscribeWithSelector', never]],
  [],
  FileSlice
> = (set) => ({
  filePath: null,
  content: '',

  setFile: (path, content) => set({ filePath: path, content }),
  setFilePath: (path) => set({ filePath: path }),
  // 清空即与原文件解绑，窗口标题会跟着回落到「应用名 - 编号」
  clearFile: () => set({ filePath: null, content: '' })
})
