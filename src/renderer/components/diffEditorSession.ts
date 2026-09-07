import type * as monaco from 'monaco-editor/editor/editor.api'

export type DiffComputation = 'computing' | 'complete' | 'incomplete' | 'error'

/** 0.56.0 运行时提供完整计算结果，公开声明只暴露 void 更新事件。 */
export type DiffRuntime = monaco.editor.IStandaloneDiffEditor & {
  getDiffComputationResult: () => { quitEarly: boolean; changes: unknown[] } | null
}

/** 只管理本次初始化成功取得的资源；任一后续步骤失败都先清理，再保留原始错误。 */
export function createDiffEditorSession(
  api: Pick<typeof monaco.editor, 'createDiffEditor' | 'createModel'>,
  container: HTMLElement,
  local: string,
  remote: string,
  onUpdate: (state: DiffComputation, count: number) => void
): { editor: DiffRuntime; dispose: () => void } {
  let editor: DiffRuntime | undefined
  let original: monaco.editor.ITextModel | undefined
  let modified: monaco.editor.ITextModel | undefined
  let subscription: monaco.IDisposable | undefined
  let view: monaco.editor.IDiffEditorViewModel | undefined
  let active = true
  const dispose = (): void => {
    if (!active) return
    active = false
    const errors: unknown[] = []
    // 先断开订阅与编辑器，再释放 viewModel / 文本，避免释放过程继续更新 React。
    for (const resource of [subscription, editor, view, modified, original]) {
      try {
        resource?.dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    subscription = undefined
    editor = undefined
    view = undefined
    modified = undefined
    original = undefined
    if (errors.length) console.error('Diff 资源释放失败：', ...errors)
  }
  try {
    editor = api.createDiffEditor(container, {
      automaticLayout: true,
      readOnly: true,
      domReadOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: false,
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
      ignoreTrimWhitespace: false,
      diffAlgorithm: 'advanced',
      maxComputationTime: 5000,
      maxFileSize: 50,
      minimap: { enabled: false },
      lineNumbers: 'on',
      renderWhitespace: 'all',
      wordWrap: 'on',
      diffWordWrap: 'on',
      stopRenderingLineAfter: -1,
      contextmenu: false,
      links: false,
      folding: false,
      scrollBeyondLastLine: false,
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
      originalAriaLabel: '本地只读文本',
      modifiedAriaLabel: '云端只读文本'
    }) as DiffRuntime
    if (typeof editor.getDiffComputationResult !== 'function')
      throw new Error('Monaco 版本不支持差异计算状态，请检查锁定的依赖版本')
    original = api.createModel(local, 'plaintext')
    modified = api.createModel(remote, 'plaintext')
    subscription = editor.onDidUpdateDiff(() => {
      if (!active) return
      const result = editor!.getDiffComputationResult()
      if (result) onUpdate(result.quitEarly ? 'incomplete' : 'complete', result.changes.length)
    })
    view = editor.createViewModel({ original, modified })
    editor.setModel(view)
    void view.waitForDiff().catch(() => {
      if (active) onUpdate('error', 0)
    })
    return { editor, dispose }
  } catch (error) {
    dispose()
    throw error
  }
}
