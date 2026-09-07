import type OSS from 'ali-oss'
import { constants, type BigIntStats } from 'fs'
import { lstat, open, readdir } from 'fs/promises'
import { join } from 'path'
import { createHash } from 'crypto'
import { TextDecoder } from 'util'
import type { Readable } from 'stream'
import { MAX_TEXT_DIFF_BYTES } from '../shared/constants'
import type { DiffText } from '../shared/types'
import { checkCancelled, isSyncTempDirectory, maybeStat, sameFile, validateKey } from './syncFiles'

export interface DiffRoot {
  path: string
  stat: BigIntStats
}
export interface LocalDiffFile {
  path: string
  stat: BigIntStats
}

interface DirectoryNames {
  stat: BigIntStats
  exact: Set<string>
  normalized: Map<string, string>
  folded: Map<string, string>
}

/** 仅复用目录名称查询；每次调用仍携带新取得的目录身份与修改时间。 */
export class DiffDirectoryIndex {
  private directories = new Map<string, DirectoryNames>()
  private nameCount = 0
  constructor(
    private readonly maxDirectories = 256,
    private readonly maxNames = 100000
  ) {}
  clear(): void {
    this.directories.clear()
    this.nameCount = 0
  }
  async lookup(
    path: string,
    stat: BigIntStats,
    name: string
  ): Promise<{ actual: string | undefined; alias: string | undefined }> {
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('路径不再是普通目录')
    const identity = `${stat.dev}:${stat.ino}`
    let index = this.directories.get(identity)
    if (index && sameFile(index.stat, stat)) {
      // 刷新 LRU 顺序，同一目录的多个路径别名共享同一份索引。
      this.directories.delete(identity)
      this.directories.set(identity, index)
    } else {
      if (index) {
        this.directories.delete(identity)
        this.nameCount -= index.exact.size
      }
      const names = await readdir(path)
      const after = await lstat(path, { bigint: true })
      if (!after.isDirectory() || after.isSymbolicLink() || !sameFile(stat, after))
        throw new Error('目录在读取名称期间发生变化，请重新扫描')
      index = { stat: after, exact: new Set(names), normalized: new Map(), folded: new Map() }
      for (const value of names) {
        const normalized = value.normalize('NFD')
        const folded = normalized.toLowerCase()
        if (!index.normalized.has(normalized)) index.normalized.set(normalized, value)
        if (!index.folded.has(folded)) index.folded.set(folded, value)
      }
      // 并发 miss 可能已经填充同一目录，替换时先扣除旧条目的计数。
      const previous = this.directories.get(identity)
      if (previous) this.nameCount -= previous.exact.size
      this.directories.delete(identity)
      this.directories.set(identity, index)
      this.nameCount += index.exact.size
      while (
        this.directories.size > 1 &&
        (this.directories.size > this.maxDirectories || this.nameCount > this.maxNames)
      ) {
        const oldest = this.directories.entries().next().value!
        this.directories.delete(oldest[0])
        this.nameCount -= oldest[1].exact.size
      }
    }
    const normalized = name.normalize('NFD')
    const actual = index.exact.has(name) ? name : index.normalized.get(normalized)
    return { actual, alias: actual ?? index.folded.get(normalized.toLowerCase()) }
  }
}

export async function checkDiffRoot(root: DiffRoot): Promise<BigIntStats> {
  const now = await lstat(root.path, { bigint: true })
  if (
    !now.isDirectory() ||
    now.isSymbolicLink() ||
    now.dev !== root.stat.dev ||
    now.ino !== root.stat.ino
  )
    throw new Error('本地根目录已变化，请重新扫描')
  return now
}

/** 只读解析。不存在是正常的单边文件；不可访问和名称冲突必须明确报告。 */
export async function locateDiffFile(
  root: DiffRoot,
  key: string,
  record?: (logical: string, physical: string) => void,
  directories = new DiffDirectoryIndex()
): Promise<LocalDiffFile | null> {
  const parts = validateKey(key)
  if (parts.some(isSyncTempDirectory)) throw new Error('跳过应用保留的同步临时目录')
  const currentRoot = await checkDiffRoot(root)
  let current = root.path
  let parentStat = currentRoot
  for (let i = 0; i < parts.length; i++) {
    const next = join(current, parts[i])
    const stat = await maybeStat(next)
    if (!stat) return null
    if (stat.isSymbolicLink()) throw new Error('跳过符号链接')
    const { actual, alias } = await directories.lookup(current, parentStat, parts[i])
    // 目录以 inode 识别别名；文件以实际目录项识别，避免把不同名称的硬链接误判为同一路径。
    record?.(
      parts.slice(0, i + 1).join('/'),
      stat.isDirectory()
        ? `directory:${stat.dev}:${stat.ino}`
        : `file:${parentStat.dev}:${parentStat.ino}:${alias ?? parts[i]}`
    )
    if (!actual) throw new Error('名称与本地路径发生大小写冲突')
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error('文件与目录同名冲突')
    if (i === parts.length - 1) {
      if (!stat.isFile()) throw new Error('对应本地路径不是普通文件')
      return { path: next, stat }
    }
    current = next
    parentStat = stat
  }
  return null
}

function checkSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('文件大小无效，无法比较')
  if (size > MAX_TEXT_DIFF_BYTES) throw new Error('文件超过 2 MB，未比较（两侧各自按字节限制）')
}

async function collect(stream: Readable, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  // 取消可能发生在 async iterator 安装监听前，仍需接住 destroy 的异步 error。
  stream.on('error', () => {})
  const abort = (): void => {
    stream.destroy(new Error('Diff 读取已取消'))
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try {
    for await (const value of stream) {
      checkCancelled(signal)
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      size += chunk.length
      checkSize(size)
      chunks.push(chunk)
    }
    checkCancelled(signal)
    return Buffer.concat(chunks, size)
  } finally {
    signal.removeEventListener('abort', abort)
    stream.destroy()
  }
}

function textInfo(bytes: Buffer, modifiedAt: string | null): DiffText {
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new Error('不是有效的 UTF-8 文本，未比较')
  }
  if (content.includes('\0')) throw new Error('内容包含 NUL，按非文本文件跳过')
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  if (bom) content = content.slice(1)
  const breaks = content.match(/\r\n|\r|\n/g) ?? []
  const kinds = new Set(
    breaks.map((value) => (value === '\r\n' ? 'CRLF' : value === '\r' ? 'CR' : 'LF'))
  )
  return {
    content,
    bom,
    size: bytes.length,
    modifiedAt,
    fingerprint: createHash('sha256').update(bytes).digest('hex'),
    eol: kinds.size ? [...kinds].sort().join(' / ') : '无换行',
    finalNewline: /[\r\n]$/.test(content)
  }
}

async function readLocal(
  root: DiffRoot,
  key: string,
  file: LocalDiffFile,
  signal: AbortSignal,
  directories: DiffDirectoryIndex
) {
  checkSize(Number(file.stat.size))
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!sameFile(file.stat, await handle.stat({ bigint: true })))
      throw new Error('本地文件在读取前发生变化')
    // 直接读取句柄，保留 fd 到读取后 stat 校验结束；销毁 FileHandle 流会提前关闭 fd。
    const chunks: Buffer[] = []
    let length = 0
    while (true) {
      checkCancelled(signal)
      const chunk = Buffer.alloc(Math.min(65536, MAX_TEXT_DIFF_BYTES + 1 - length))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, length)
      if (!bytesRead) break
      length += bytesRead
      checkSize(length)
      chunks.push(chunk.subarray(0, bytesRead))
    }
    checkCancelled(signal)
    const bytes = Buffer.concat(chunks, length)
    const after = await locateDiffFile(root, key, undefined, directories)
    if (
      !after ||
      !sameFile(file.stat, after.stat) ||
      !sameFile(file.stat, await handle.stat({ bigint: true })) ||
      bytes.length !== Number(file.stat.size)
    )
      throw new Error('本地文件在读取期间发生变化，请重新扫描')
    return { bytes, text: textInfo(bytes, new Date(Number(file.stat.mtimeMs)).toISOString()) }
  } finally {
    await handle.close()
  }
}

async function readRemote(client: OSS, key: string, signal: AbortSignal) {
  checkCancelled(signal)
  const head = await client.head(key, { timeout: 60000 })
  checkCancelled(signal)
  const headers = head.res.headers as Record<string, string>
  const size = Number(headers['content-length'])
  checkSize(size)
  if (!headers.etag) throw new Error('OSS 未返回有效版本，无法比较')
  const response = await client.getStream(key, {
    timeout: 60000,
    headers: {
      'If-Match': headers.etag,
      ...(size > 0 ? { Range: `bytes=0-${MAX_TEXT_DIFF_BYTES}` } : {})
    }
  })
  const bytes = await collect(response.stream, signal)
  const actual = response.res.headers as Record<string, string>
  if (
    actual.etag !== headers.etag ||
    (headers['x-oss-version-id'] && actual['x-oss-version-id'] !== headers['x-oss-version-id'])
  )
    throw new Error('云端文件在读取期间发生变化，请重新扫描')
  if (bytes.length !== size) throw new Error('云端内容长度与 HEAD 不一致，未比较')
  const time = Date.parse(headers['last-modified'])
  return {
    bytes,
    text: textInfo(bytes, Number.isFinite(time) ? new Date(time).toISOString() : null)
  }
}

export async function readDiffPair(
  root: DiffRoot,
  client: OSS,
  key: string,
  signal: AbortSignal,
  expected?: LocalDiffFile,
  directories = new DiffDirectoryIndex()
) {
  checkCancelled(signal)
  const local = await locateDiffFile(root, key, undefined, directories)
  if (!local) throw new Error('本地文件已不存在')
  if (expected && !sameFile(expected.stat, local.stat))
    throw new Error('本地文件在扫描后发生变化，请重新扫描')
  checkSize(Number(local.stat.size))
  // 等待两端读取都结束再释放任务占用，不能让失败一侧遗留在途读取。
  const results = await Promise.allSettled([
    readLocal(root, key, local, signal, directories),
    readRemote(client, key, signal)
  ])
  checkCancelled(signal)
  const a = results[0],
    b = results[1]
  if (a.status === 'rejected') throw a.reason
  if (b.status === 'rejected') throw b.reason
  await checkDiffRoot(root)
  return {
    local: a.value.text,
    remote: b.value.text,
    identical: a.value.bytes.equals(b.value.bytes)
  }
}
