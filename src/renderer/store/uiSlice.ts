import type { StateCreator } from 'zustand'
import type { StoreState, UiSlice } from './types'

export const createUiSlice: StateCreator<
  StoreState,
  [['zustand/subscribeWithSelector', never]],
  [],
  UiSlice
> = (set) => ({
  // 真正的初始主题由主进程通过 getInitConfig 下发（持久化偏好 > 系统外观），
  // 这里只是首帧渲染前的占位值
  theme: 'light',
  windowNumber: 1,
  toastMessage: null,
  toastType: null,

  setTheme: (theme) => set({ theme }),
  toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
  setWindowNumber: (num) => set({ windowNumber: num }),
  showToast: (message, type) => set({ toastMessage: message, toastType: type }),
  clearToast: () => set({ toastMessage: null, toastType: null })
})
