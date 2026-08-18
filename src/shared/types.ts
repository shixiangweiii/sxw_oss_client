export type Theme = 'dark' | 'light'

/**
 * 新窗口从「打开它的那个窗口」继承的配置。
 *
 * 扩展点：业务想让某个偏好在新窗口间传递（编辑模式、缩放比例、侧栏开关……），
 * 加一个字段到这里就够了，主进程只负责原样透传、不解释具体含义。
 *
 * 注意 filePath 刻意不在这里 —— 一旦混进来，新窗口就会继承父窗口的文件。
 */
export interface WindowConfig {
  theme: Theme
}

/** 渲染进程上报的窗口状态。窗口标题由主进程统一组装，渲染层不直接设置标题。 */
export interface WindowState {
  filePath: string | null
  config: WindowConfig
}

export interface InitConfig {
  windowNumber: number
  config: WindowConfig
}

/** 与 Electron 的 FileFilter 结构一致，单独定义以免 shared 层依赖 electron 类型 */
export interface FileFilter {
  name: string
  extensions: string[]
}

export interface FileResult {
  path: string
  content: string
}

export interface SaveResult {
  path: string
}

/** 菜单项投递给渲染进程的动作。新增菜单项时在这里加一个成员，TS 会提示所有该处理的地方。 */
export type MenuAction = 'file:open' | 'file:save' | 'file:save-as' | 'view:toggle-theme'

/** 持久化到 userData/settings.json 的内容 */
export interface AppSettings {
  /**
   * null 表示用户从未手动切换过，此时跟随系统外观。
   * 只有 settings:set-theme 会写这个字段——即只有用户显式切换才落盘，
   * 否则首次启动解析出的系统外观会被记成"用户选择"，"跟随系统"就永久失效了。
   */
  theme: Theme | null
  windowBounds: { width: number; height: number } | null
}

/** preload 通过 contextBridge 暴露给渲染进程的全部能力 */
export interface ElectronAPI {
  openFile: (filters?: FileFilter[]) => Promise<FileResult | null>
  /** filePath 非空时直接覆盖写入，为空时弹出「另存为」对话框 */
  saveFile: (
    content: string,
    filePath: string | null,
    filters?: FileFilter[]
  ) => Promise<SaveResult | null>
  saveFileAs: (content: string, filters?: FileFilter[]) => Promise<SaveResult | null>
  newWindow: (config?: WindowConfig) => Promise<void>
  reportWindowState: (state: WindowState) => Promise<void>
  /** 仅在用户显式切换外观时调用，用于持久化偏好 */
  setThemePreference: (theme: Theme) => Promise<void>
  getInitConfig: () => Promise<InitConfig>
  /** 返回取消订阅函数 */
  onMenuAction: (callback: (action: MenuAction) => void) => () => void
}
