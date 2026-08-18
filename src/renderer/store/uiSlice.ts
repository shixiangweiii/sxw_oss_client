import type { StateCreator } from 'zustand'
import type { StoreState, UiSlice } from './types'

export const createUiSlice: StateCreator<
  StoreState,
  [['zustand/subscribeWithSelector', never]],
  [],
  UiSlice
> = (set) => ({
  // 真正的初始主题由主进程通过 getInitConfig 下发（持久化偏好 > 系统外观），
  // 这里只是首帧渲染前的占位值 —— 正因为是占位值，isInitialized 之前不能对外上报
  theme: 'light',
  isInitialized: false,
  windowNumber: 1,
  toastMessage: null,
  toastType: null,

  // 刻意不提供 toggleTheme：切换外观必须同时持久化用户偏好，
  // 统一由 App 的 handleToggleTheme 承担，避免有人直接改 store 导致偏好丢失
  setTheme: (theme) => set({ theme }),
  markInitialized: () => set({ isInitialized: true }),
  setWindowNumber: (num) => set({ windowNumber: num }),
  showToast: (message, type) => set({ toastMessage: message, toastType: type }),
  clearToast: () => set({ toastMessage: null, toastType: null })
})
