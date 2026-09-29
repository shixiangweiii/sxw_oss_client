import { TextDecoder } from 'util'
import { MAX_TEXT_BYTES } from '../shared/constants'
import { SyncSkip } from './syncFiles'

export const MERGE_MARKERS = [
  '<<<<<<< OSS-CLIENT 本地',
  '======= OSS-CLIENT',
  '>>>>>>> OSS-CLIENT 云端'
] as const
const markerBytes = MERGE_MARKERS.map((marker) => Buffer.from(marker))
const bomBytes = Buffer.from('\uFEFF')
const noteBytes = Buffer.from('（')
const lookbehind = Math.max(...markerBytes.map((marker) => marker.length)) + 8

export class UnsupportedText extends SyncSkip {}

export function decodeMergeText(bytes: Buffer): { content: string; bom: boolean; eol: string } {
  if (bytes.length > MAX_TEXT_BYTES) throw new UnsupportedText('文本超过 5 MB，无法合并')
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new UnsupportedText('不是有效的 UTF-8 文本，无法合并')
  }
  if (content.includes('\0')) throw new UnsupportedText('文本含 NUL，无法合并')
  const bom = content.startsWith('\uFEFF')
  if (bom) content = content.slice(1)
  return { content, bom, eol: content.match(/\r\n|\r|\n/)?.[0] ?? '\n' }
}

function containsMarker(bytes: Buffer, first: boolean, final: boolean): boolean {
  const lineStart = (offset: number): boolean =>
    offset === 0 ? first : offset > 0 && (bytes[offset - 1] === 10 || bytes[offset - 1] === 13)
  for (const marker of markerBytes) {
    let offset = bytes.indexOf(marker)
    while (offset !== -1) {
      const start =
        lineStart(offset) ||
        (offset >= 3 &&
          bytes.subarray(offset - 3, offset).equals(bomBytes) &&
          lineStart(offset - 3))
      const end = offset + marker.length
      if (
        start &&
        ((final && end === bytes.length) ||
          bytes[end] === 10 ||
          bytes[end] === 13 ||
          bytes.subarray(end, end + noteBytes.length).equals(noteBytes))
      )
        return true
      offset = bytes.indexOf(marker, offset + 1)
    }
  }
  return false
}

/** Buffer 搜索跳过整段无关内容；尾部仅保留跨块标记所需的有限前后文。 */
export class MergeMarkerScanner {
  private tail = Buffer.alloc(0)
  private total = 0
  private found = false
  push(chunk: Buffer): boolean {
    if (this.found) return true
    const first = this.total === this.tail.length
    const bytes = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk
    this.total += chunk.length
    this.found = containsMarker(bytes, first, false)
    this.tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - lookbehind)))
    return this.found
  }
  finish(): boolean {
    return this.found || containsMarker(this.tail, this.total === this.tail.length, true)
  }
}

export function hasMergeMarkers(content: string): boolean {
  return containsMarker(Buffer.from(content), true, true)
}
