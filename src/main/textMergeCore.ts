import { diffLines } from 'diff'
import { MAX_TEXT_BYTES } from '../shared/constants'
import { decodeMergeText, hasMergeMarkers, MERGE_MARKERS, UnsupportedText } from './textMergeFormat'

export function mergeTextCore(
  localBytes: Buffer,
  remoteBytes: Buffer,
  timeout = 5000
): { bytes: Buffer; blocks: number } | null {
  const local = decodeMergeText(localBytes),
    remote = decodeMergeText(remoteBytes)
  if (hasMergeMarkers(local.content) || hasMergeMarkers(remote.content))
    throw new UnsupportedText('存在本工具未整理的合并标记，请先整理')
  const normalize = (text: string): string => text.replace(/\r\n|\r/g, '\n')
  const a = normalize(local.content),
    b = normalize(remote.content)
  if (a === b) return null
  const changes = diffLines(a, b, { timeout })
  if (!changes) throw new UnsupportedText('合并计算超过 5 秒预算，未写入本地文件')
  const chunks: string[] = []
  let size = local.bom ? 3 : 0,
    blocks = 0,
    localOffset = 0,
    remoteOffset = 0
  const append = (value: string): void => {
    const formatted = value.replace(/\n/g, local.eol)
    size += Buffer.byteLength(formatted)
    if (size > MAX_TEXT_BYTES) throw new UnsupportedText('合并结果超过 5 MB，未写入本地文件')
    chunks.push(formatted)
  }
  for (let i = 0; i < changes.length;) {
    const change = changes[i]
    if (!change.added && !change.removed) {
      append(change.value)
      localOffset += change.value.length
      remoteOffset += change.value.length
      i++
      continue
    }
    let ours = '',
      theirs = ''
    while (i < changes.length && (changes[i].added || changes[i].removed)) {
      const part = changes[i++]
      if (part.removed) ours += part.value
      else theirs += part.value
    }
    localOffset += ours.length
    remoteOffset += theirs.length
    const label = (index: 0 | 2, text: string, offset: number): string =>
      MERGE_MARKERS[index] +
      (offset === text.length ? `（文件末尾${text.endsWith('\n') ? '有' : '无'}换行）` : '')
    append(label(0, a, localOffset) + '\n')
    append(ours + (ours && !ours.endsWith('\n') ? '\n' : ''))
    append(MERGE_MARKERS[1] + '\n')
    append(theirs + (theirs && !theirs.endsWith('\n') ? '\n' : ''))
    append(label(2, b, remoteOffset) + '\n')
    blocks++
  }
  return { bytes: Buffer.from((local.bom ? '\uFEFF' : '') + chunks.join('')), blocks }
}
