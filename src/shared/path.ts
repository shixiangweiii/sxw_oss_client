/**
 * 从完整路径取文件名。
 * 主进程组装窗口标题、渲染进程显示当前文件名都走这里，避免两侧各写一份导致行为漂移。
 */
export function fileName(filePath: string): string {
  const normalized = filePath.replace(/\/+$/, '')
  const index = normalized.lastIndexOf('/')
  return index === -1 ? normalized : normalized.slice(index + 1)
}

/** 视为纯文本、支持在线预览编辑的扩展名（小写） */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'log', 'html', 'htm', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'css', 'scss', 'less', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg',
  'properties', 'sh', 'bash', 'zsh', 'py', 'rb', 'go', 'java', 'c', 'h', 'cpp', 'hpp',
  'cs', 'php', 'sql', 'svg', 'env', 'gitignore', 'editorconfig', 'dockerfile'
])

/** 判断 object key 是否是可在线编辑的纯文本文件。无扩展名的点文件（.gitignore 等）也按文本处理 */
export function isTextFileName(name: string): boolean {
  const base = name.split('/').pop() ?? name
  if (base.startsWith('.') && !base.slice(1).includes('.')) return true
  const dot = base.lastIndexOf('.')
  if (dot === -1) return false
  return TEXT_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())
}
