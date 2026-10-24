/** sync_ignore 仅是逗号分隔的上传排除规则，不读取 .gitignore。 */
export function parseSyncIgnore(value = ''): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ]
}

function segmentPattern(value: string): RegExp {
  const escaped = [...value]
    .map((char) => {
      if (char === '*') return '[\\s\\S]*'
      if (char === '?') return '[\\s\\S]'
      return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
  return new RegExp(`^${escaped}$`, 'u')
}

/** 只实现明确约定的 *、?、独立分量 **；路径始终使用 OSS 的 / 分隔。 */
export class SyncIgnore {
  private readonly rules: { directoriesOnly: boolean; parts: (RegExp | null)[] }[]

  constructor(patterns: readonly string[] = []) {
    this.rules = patterns.map((pattern) => {
      const directoriesOnly = pattern.endsWith('/')
      const rooted = pattern.startsWith('/')
      const path = pattern.replace(/^\//, '').replace(/\/$/, '')
      const parts = path.split('/')
      if (
        !path ||
        parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))
      )
        throw new Error(`无效的 sync_ignore 规则：${pattern}`)
      if (!rooted && parts.length === 1) parts.unshift('**')
      return {
        directoriesOnly,
        parts: parts.map((part) => (part === '**' ? null : segmentPattern(part)))
      }
    })
  }

  matches(key: string, isDirectory: boolean): boolean {
    const names = key.split('/')
    return this.rules.some(({ directoriesOnly, parts }) => {
      if (directoriesOnly && !isDirectory) return false
      // 动态规划处理 ** 的零层/多层匹配，避免路径回溯爆炸。
      let positions = new Set([0])
      for (const [index, part] of parts.entries()) {
        const next = new Set<number>()
        if (part === null) {
          // a/** 也剪枝目录 a，但不排除名为 a 的普通文件。
          const start =
            Math.min(...positions) + (index === parts.length - 1 && !isDirectory ? 1 : 0)
          for (let i = start; i <= names.length; i++) next.add(i)
        } else {
          for (const i of positions) if (i < names.length && part.test(names[i])) next.add(i + 1)
        }
        positions = next
        if (!positions.size) return false
      }
      return positions.has(names.length)
    })
  }
}
