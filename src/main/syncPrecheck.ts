import type OSS from 'ali-oss'
import type { BigIntStats } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { MAX_TEXT_BYTES } from '../shared/constants'
import { isTextFileName } from '../shared/path'
import type { SyncPrecheckSummary } from '../shared/types'
import {
  checkDiffRoot,
  DiffDirectoryIndex,
  readDiffBytes,
  TextSizeError,
  type DiffRoot
} from './diffFiles'
import {
  checkCancelled,
  isSyncTempDirectory,
  maybeStat,
  safePath,
  sameFile,
  SyncSkip,
  validateKey
} from './syncFiles'
import { decodeMergeText, hasMergeMarkers, UnsupportedText } from './textMerge'

export interface DownloadEntry {
  key: string
  size: number
  kind: 'file' | 'directory' | 'skip'
  etag?: string
}
export type TextPair = Awaited<ReturnType<typeof readDiffBytes>>
export interface DownloadCheck {
  local: BigIntStats | null
  kind:
    'missing' | 'directory' | 'nontext' | 'same' | 'different' | 'unsupported' | 'failed' | 'skip'
  problem?: unknown
  remote?: { etag: string; versionId: string | null }
  localHash?: string
  remoteHash?: string
}
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const unquote = (value: string): string => value.replace(/^"|"$/g, '')

/** 缓存只按原始字节计费，不保留解码字符串；单项过大也不能突破总上限。 */
export class TextPairCache {
  private items = new Map<string, TextPair>()
  private bytes = 0
  constructor(private readonly limit = 64 * 1024 * 1024) {}
  get(key: string): TextPair | undefined {
    const pair = this.items.get(key)
    if (pair) {
      this.items.delete(key)
      this.items.set(key, pair)
    }
    return pair
  }
  set(key: string, pair: TextPair): void {
    const previous = this.items.get(key)
    if (previous) this.bytes -= previous.local.bytes.length + previous.remote.bytes.length
    this.items.delete(key)
    const size = pair.local.bytes.length + pair.remote.bytes.length
    if (size > this.limit) return
    this.items.set(key, pair)
    this.bytes += size
    while (this.bytes > this.limit) {
      const [oldest, value] = this.items.entries().next().value!
      this.items.delete(oldest)
      this.bytes -= value.local.bytes.length + value.remote.bytes.length
    }
  }
  clear(): void {
    this.items.clear()
    this.bytes = 0
  }
}

export class DownloadPrecheck {
  readonly checks = new Map<string, DownloadCheck>()
  readonly cache = new TextPairCache()
  readonly summary: SyncPrecheckSummary
  private directories = new DiffDirectoryIndex()
  constructor(
    readonly root: string,
    private readonly identity: BigIntStats | null,
    private readonly client: OSS,
    total: number
  ) {
    this.summary = { checked: 0, total, different: 0, unavailable: 0, failed: 0 }
  }
  private get diffRoot(): DiffRoot {
    if (!this.identity) throw new Error('预检查时本地根目录不存在')
    return { path: this.root, stat: this.identity }
  }
  async checkRoot(): Promise<void> {
    if (this.identity) await checkDiffRoot(this.diffRoot)
  }
  clear(): void {
    this.cache.clear()
    this.directories.clear()
  }
  async inspect(entry: DownloadEntry, signal: AbortSignal): Promise<void> {
    checkCancelled(signal)
    const record: DownloadCheck = { local: null, kind: 'missing' }
    this.checks.set(entry.key, record)
    try {
      const parts = validateKey(entry.key)
      if (parts.some(isSyncTempDirectory)) throw new SyncSkip('保留应用同步临时目录，不参与同步')
      const path = this.identity
        ? await safePath(this.root, entry.key, false, true)
        : join(this.root, ...parts)
      record.local = await maybeStat(path)
      if (record.local?.isSymbolicLink()) throw new SyncSkip('跳过符号链接')
      if (!record.local) return
      if (entry.kind === 'directory') {
        if (!record.local.isDirectory()) throw new SyncSkip('文件与目录同名冲突')
        record.kind = 'directory'
        return
      }
      if (!record.local.isFile()) throw new SyncSkip('文件与目录或特殊文件冲突')
      if (!isTextFileName(entry.key)) {
        record.kind = 'nontext'
        return
      }
      if (entry.size > MAX_TEXT_BYTES || Number(record.local.size) > MAX_TEXT_BYTES)
        throw new UnsupportedText('两侧文本各须不超过 5 MB，无法合并')
      const pair = await readDiffBytes(
        this.diffRoot,
        this.client,
        entry.key,
        signal,
        { path, stat: record.local },
        this.directories,
        120000
      )
      if (
        pair.remote.bytes.length !== entry.size ||
        (entry.etag && unquote(entry.etag) !== unquote(pair.remote.etag))
      )
        throw new Error('云端文件在列举后发生变化，请重新检查')
      record.remote = { etag: pair.remote.etag, versionId: pair.remote.versionId }
      record.localHash = hash(pair.local.bytes)
      record.remoteHash = hash(pair.remote.bytes)
      this.cache.set(entry.key, pair)
      if (pair.local.bytes.equals(pair.remote.bytes)) {
        record.kind = 'same'
        return
      }
      const local = decodeMergeText(pair.local.bytes),
        remote = decodeMergeText(pair.remote.bytes)
      if (hasMergeMarkers(local.content) || hasMergeMarkers(remote.content))
        throw new UnsupportedText('存在本工具未整理的合并标记，请先整理')
      record.kind = 'different'
      this.summary.different++
    } catch (error) {
      if (signal.aborted) throw error
      record.problem = error
      if (error instanceof UnsupportedText || error instanceof TextSizeError) {
        record.kind = 'unsupported'
        this.summary.unavailable++
      } else if (error instanceof SyncSkip) record.kind = 'skip'
      else {
        record.kind = 'failed'
        this.summary.failed++
      }
    } finally {
      this.summary.checked++
    }
  }
  async assertLocal(key: string, record: DownloadCheck): Promise<void> {
    await this.checkRoot()
    const path = await safePath(this.root, key, false, true)
    const now = await maybeStat(path)
    if (record.local?.isDirectory() && now?.isDirectory() && !now.isSymbolicLink()) {
      if (record.local.dev === now.dev && record.local.ino === now.ino) return
    } else if (record.local ? now && !now.isSymbolicLink() && sameFile(record.local, now) : !now)
      return
    throw new Error('本地目标在预检查后发生变化，已保留当前文件，请重新检查')
  }
  assertRemote(record: DownloadCheck, etag: string, versionId: string | null): void {
    if (record.remote && (record.remote.etag !== etag || record.remote.versionId !== versionId))
      throw new Error('云端文件在预检查后发生变化，请重新检查')
  }
  async pair(key: string, record: DownloadCheck, signal: AbortSignal): Promise<TextPair> {
    await this.assertLocal(key, record)
    const cached = this.cache.get(key)
    if (cached) return cached
    if (!record.local) throw new Error('合并文件缺少本地检查记录')
    const pair = await readDiffBytes(
      this.diffRoot,
      this.client,
      key,
      signal,
      { path: await safePath(this.root, key), stat: record.local },
      this.directories,
      120000
    )
    this.assertRemote(record, pair.remote.etag, pair.remote.versionId)
    if (
      hash(pair.local.bytes) !== record.localHash ||
      hash(pair.remote.bytes) !== record.remoteHash
    )
      throw new Error('重新读取的内容与预检查不一致，已保留本地文件')
    this.cache.set(key, pair)
    return pair
  }
}
