/**
 * 从完整路径取文件名。
 * 主进程组装窗口标题、渲染进程显示当前文件名都走这里，避免两侧各写一份导致行为漂移。
 */
export function fileName(filePath: string): string {
  const normalized = filePath.replace(/\/+$/, '')
  const index = normalized.lastIndexOf('/')
  return index === -1 ? normalized : normalized.slice(index + 1)
}
