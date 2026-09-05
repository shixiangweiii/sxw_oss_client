/** 文本读取与保存共用的 UTF-8 字节上限。 */
export const MAX_TEXT_EDIT_BYTES = 2 * 1024 * 1024

/**
 * 渲染进程与主进程之间的全部通道名。
 * 新增通道时：先在这里登记，再到 main/ipc.ts 注册 handler，最后在 preload/index.ts 暴露方法。
 */
export const IPC_CHANNELS = {
  OSS_SYNC_START: 'oss:sync-start',
  OSS_SYNC_CANCEL: 'oss:sync-cancel',
  OSS_SYNC_STATE: 'oss:sync-state',
  OSS_SYNC_GET_STATE: 'oss:sync-get-state',
  OSS_SYNC_ISSUES: 'oss:sync-issues',
  OSS_SYNC_CHECK_UNLOAD: 'oss:sync-check-unload',
  FILE_OPEN: 'file:open',
  FILE_SAVE: 'file:save',
  FILE_SAVE_AS: 'file:save-as',
  WINDOW_CONFIRM_CLOSE: 'window:confirm-close',
  WINDOW_NEW: 'window:new',
  WINDOW_REPORT_STATE: 'window:report-state',
  WINDOW_GET_INIT_CONFIG: 'window:get-init-config',
  /**
   * 主题偏好持久化。刻意与 window:report-state 分开：
   * 上报通道只负责「同步当前状态」，这条只负责「记录用户的显式选择」。
   * 两件事混在一条通道上会让 AppSettings.theme 的 null 语义（跟随系统）失效。
   */
  SETTINGS_SET_THEME: 'settings:set-theme',
  /** 唯一的主进程 → 渲染进程通道，用 webContents.send 单向投递菜单动作 */
  MENU_ACTION: 'menu:action',
  OSS_LIST_BUCKETS: 'oss:list-buckets',
  OSS_LIST_OBJECTS: 'oss:list-objects',
  OSS_GET_CONFIG: 'oss:get-config',
  OSS_GET_OBJECT_TEXT: 'oss:get-object-text',
  OSS_PUT_OBJECT_TEXT: 'oss:put-object-text'
} as const

export function isSyncActive(phase: string | undefined): boolean {
  return (
    phase === 'scanning' ||
    phase === 'comparing' ||
    phase === 'transferring' ||
    phase === 'cancelling'
  )
}
