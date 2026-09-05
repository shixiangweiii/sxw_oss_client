import { useStore } from './store'

/** 每次卸载同步读取最新草稿，覆盖原生关闭、退出以及页面刷新。 */
export function handleBeforeUnload(event: BeforeUnloadEvent): void {
  if (window.electronAPI?.checkSyncUnload && !window.electronAPI.checkSyncUnload()) {
    event.preventDefault()
    event.returnValue = ''
    return
  }
  const editor = useStore.getState().editor
  if (!editor) return
  const saving = editor.status === 'saving'
  if (!saving && editor.draft === editor.savedContent) return
  const mayClose = window.electronAPI?.confirmWindowClose(saving) ?? false
  if (saving || !mayClose) {
    event.preventDefault()
    event.returnValue = ''
  }
}
