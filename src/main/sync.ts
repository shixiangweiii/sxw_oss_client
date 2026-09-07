import type OSS from 'ali-oss'
import { randomUUID } from 'crypto'
import { chmod, mkdir, readdir, rename } from 'fs/promises'
import { dirname, join } from 'path'
import type { BigIntStats } from 'fs'
import type { SyncDirection, SyncIssue, SyncIssuePage, SyncPhase, SyncState } from '../shared/types'
import { isSyncActive } from '../shared/constants'
import { reserveSync, notifyContentChanged } from './operations'
import {
  SyncCancelled,
  SyncSkip,
  SyncTemps,
  isSyncTempDirectory,
  type TempProblem,
  checkCancelled,
  hashStream,
  maybeStat,
  prepareRoot,
  safePath,
  sameFile,
  snapshotFile,
  validateKey
} from './syncFiles'

// ali-oss 会修改调用 options（尤其 listV2 的 subres），每次调用都提供新对象。
function requestOptions(): { timeout: number } {
  return { timeout: 120000 }
}
export interface SyncConnection {
  client: OSS
  bucket: string
  localDir: string
}
export interface SyncConfirmation {
  taskId: string
  direction: SyncDirection
  bucket: string
  key: string
  localPath: string
  localModifiedAt: number
  remoteModifiedAt: number
}
export type ConfirmOverwrite = (
  request: SyncConfirmation,
  signal: AbortSignal
) => Promise<'overwrite' | 'skip' | 'cancel'>
interface Entry {
  key: string
  size: number
  kind: 'file' | 'directory' | 'skip'
  etag?: string
  reason?: string
  scanError?: boolean
  stat?: BigIntStats
}
type Outcome = 'created' | 'overwritten' | 'unchanged' | 'skipped'
function errorInfo(err: unknown): { message: string; requestId?: string } {
  const e = err as { message?: string; requestId?: string }
  return { message: e?.message ?? String(err), ...(e?.requestId ? { requestId: e.requestId } : {}) }
}
function status(err: unknown): number | undefined {
  return (err as { status?: number })?.status
}
function etag(value: string): string {
  return value.replace(/^"|"$/g, '')
}
function headInfo(head: OSS.HeadObjectResult): {
  size: number
  etag: string
  modifiedAt: number | null
} {
  const h = head.res.headers as Record<string, string>
  const size = Number(h['content-length'])
  if (!Number.isSafeInteger(size) || size < 0 || !h.etag)
    throw new Error('OSS 未返回有效大小或 ETag')
  const modifiedAt = Date.parse(h['last-modified'])
  return { size, etag: h.etag, modifiedAt: Number.isFinite(modifiedAt) ? modifiedAt : null }
}

/** 建立路径树，一次性识别大小写、Unicode 别名和文件/目录冲突；冲突传播到子级。 */
function conflicts(
  entries: Entry[],
  rules: { caseSensitive: boolean; normalizationSensitive: boolean }
): Map<string, string> {
  const canonical = (s: string): string => {
    const n = rules.normalizationSensitive ? s : s.normalize('NFD')
    return rules.caseSensitive ? n : n.toLowerCase()
  }
  const nodes = new Map<string, { path: string; directory: boolean }>()
  const blocked = new Set<string>()
  const result = new Map<string, string>()
  for (const entry of entries) {
    try {
      const parts = validateKey(entry.key)
      for (let i = 1; i <= parts.length; i++) {
        const path = parts.slice(0, i).join('/')
        const id = canonical(path)
        const directory = i < parts.length || entry.kind === 'directory'
        const previous = nodes.get(id)
        if (previous && (previous.path !== path || previous.directory !== directory))
          blocked.add(id)
        else nodes.set(id, { path, directory })
      }
    } catch (err) {
      result.set(entry.key, errorInfo(err).message)
    }
  }
  for (const entry of entries) {
    const parts = entry.key.replace(/\/$/, '').split('/')
    if (parts.some((_p, i) => blocked.has(canonical(parts.slice(0, i + 1).join('/')))))
      result.set(entry.key, '名称或文件/目录冲突，已跳过相关路径')
  }
  return result
}

export class SyncManager {
  private state: SyncState | null = null
  private issues: SyncIssue[] = []
  private revision = 0
  private controller: AbortController | null = null
  private finished: Promise<void> = Promise.resolve()
  private listeners = new Set<(state: SyncState) => void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private temps: SyncTemps
  private recoveryProblems: TempProblem[] = []
  private phase: string = 'scanning'
  private confirmOverwrite!: ConfirmOverwrite
  constructor(private readonly userData: string) {
    this.temps = new SyncTemps(userData)
  }
  async recover(): Promise<void> {
    this.recoveryProblems = await this.temps.recover()
  }
  get active(): boolean {
    return isSyncActive(this.state?.phase)
  }
  getState(): SyncState | null {
    return this.state ? { ...this.state } : null
  }
  getIssues(taskId: string, offset: number): SyncIssuePage {
    if (taskId !== this.state?.taskId) return { items: [], total: 0 }
    const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
    return {
      items: this.issues.slice(start, start + 50).map((i) => ({ ...i })),
      total: this.issues.length
    }
  }
  subscribe(listener: (state: SyncState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  wait(): Promise<void> {
    return this.finished
  }
  cancel(taskId: string): void {
    if (!this.active || this.state?.taskId !== taskId) return
    this.controller?.abort()
    this.change({ phase: 'cancelling', message: '正在取消，等待在途上传结束并清理临时文件…' })
  }
  private emit(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const state = this.getState()
    if (state) for (const listener of this.listeners) listener(state)
  }
  private change(patch: Partial<SyncState>, immediate = false): void {
    if (!this.state) return
    Object.assign(this.state, patch, { revision: ++this.revision })
    if (immediate) this.emit()
    else if (!this.timer) this.timer = setTimeout(() => this.emit(), 200)
  }
  private step(phase: 'scanning' | 'comparing' | 'transferring', file?: string): void {
    this.phase = phase
    this.change({
      phase: this.controller?.signal.aborted ? 'cancelling' : phase,
      ...(file !== undefined ? { currentFile: file } : {})
    })
  }
  private issue(
    path: string,
    err: unknown,
    kind: 'error' | 'skip' = 'error',
    phase = this.phase
  ): void {
    const info = errorInfo(err)
    if (
      phase === 'cleanup' &&
      this.issues.some(
        (issue) => issue.path === path && issue.phase === phase && issue.message === info.message
      )
    )
      return
    this.issues.push({ path, phase, kind, ...info })
    this.change({ issueCount: this.issues.length })
  }
  start(direction: SyncDirection, connection: SyncConnection, confirm: ConfirmOverwrite): string {
    if (direction !== 'download' && direction !== 'upload') throw new Error('无效的同步方向')
    if (typeof confirm !== 'function') throw new Error('缺少同步覆盖确认处理器')
    const release = reserveSync()
    this.confirmOverwrite = confirm
    this.controller = new AbortController()
    const taskId = randomUUID()
    this.issues = []
    this.state = {
      taskId,
      revision: ++this.revision,
      direction,
      bucket: connection.bucket,
      localDir: connection.localDir,
      phase: 'scanning',
      discovered: 0,
      total: null,
      processed: 0,
      created: 0,
      overwritten: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
      currentFile: null,
      issueCount: 0,
      message: null
    }
    this.emit()
    this.finished = this.run(direction, connection, this.controller.signal).finally(release)
    return taskId
  }
  private async cloudEntries(client: OSS, signal: AbortSignal, count: boolean): Promise<Entry[]> {
    const entries: Entry[] = []
    const tokens = new Set<string>()
    const keys = new Set<string>()
    let token: string | undefined
    do {
      checkCancelled(signal)
      const page = await client.listV2(
        { 'max-keys': 1000, ...(token ? { 'continuation-token': token } : {}) },
        requestOptions()
      )
      checkCancelled(signal)
      for (const object of page.objects ?? []) {
        if (keys.has(object.name))
          throw new Error('云端列表出现重复 key，来源可能正在变化，请重新同步')
        keys.add(object.name)
        const directory = object.name.endsWith('/')
        entries.push({
          key: object.name,
          size: object.size,
          etag: object.etag,
          kind: directory ? (object.size === 0 ? 'directory' : 'skip') : 'file',
          ...(directory && object.size !== 0 ? { reason: '非零字节的目录对象无法映射到本地' } : {})
        })
      }
      if (count) this.change({ discovered: entries.length })
      token = page.isTruncated ? page.nextContinuationToken : undefined
      if (page.isTruncated && (!token || tokens.has(token)))
        throw new Error('OSS 分页游标无效，不能保证完整扫描')
      if (token) tokens.add(token)
    } while (token)
    return entries
  }
  private async localEntries(root: string, signal: AbortSignal): Promise<Entry[]> {
    const entries: Entry[] = []
    const visit = async (prefix: string): Promise<void> => {
      checkCancelled(signal)
      const path = prefix ? await safePath(root, prefix) : root
      const stat = await maybeStat(path)
      if (!stat?.isDirectory()) throw new Error('来源目录已变化')
      const names = (await readdir(path)).sort()
      if (!names.length && prefix)
        entries.push({ key: prefix + '/', kind: 'directory', size: 0, stat })
      for (const name of names) {
        checkCancelled(signal)
        const key = prefix ? prefix + '/' + name : name
        try {
          validateKey(key)
          const child = await maybeStat(join(path, name))
          if (!child) throw new Error('扫描期间文件被删除')
          if (
            this.temps.protects(join(path, name)) ||
            (child.isDirectory() && isSyncTempDirectory(name))
          ) {
            entries.push({
              key,
              size: 0,
              kind: 'skip',
              reason: '保留残留临时目录，未上传；请查看清理详情或确认后手动处理'
            })
          } else if (child.isDirectory() && !child.isSymbolicLink()) await visit(key)
          else
            entries.push({
              key,
              size: Number(child.size),
              stat: child,
              kind: child.isFile() && !child.isSymbolicLink() ? 'file' : 'skip',
              reason: '跳过符号链接或特殊文件'
            })
        } catch (err) {
          if (signal.aborted) throw err
          entries.push({
            key,
            size: 0,
            kind: 'skip',
            reason: errorInfo(err).message,
            scanError: !(err instanceof SyncSkip)
          })
        }
        this.change({ discovered: entries.length })
      }
    }
    await visit('')
    return entries
  }
  private async run(
    direction: SyncDirection,
    connection: SyncConnection,
    signal: AbortSignal
  ): Promise<void> {
    let fatal = false
    try {
      const recoveryProblems = await this.temps.recover()
      for (const problem of [...this.recoveryProblems, ...recoveryProblems])
        this.issue(problem.path, problem, 'error', 'cleanup')
      this.recoveryProblems = []
      checkCancelled(signal)
      const root = await prepareRoot(connection.localDir, direction === 'download')
      const cloud = await this.cloudEntries(connection.client, signal, direction === 'download')
      const entries = direction === 'download' ? cloud : await this.localEntries(root, signal)
      const rules = await this.temps.volumeRules(root, (path, err) =>
        this.issue(path, err, 'error', 'cleanup')
      )
      const invalid = conflicts(direction === 'download' ? entries : [...cloud, ...entries], rules)
      entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      this.change({ total: entries.length, discovered: entries.length })
      for (const entry of entries) {
        checkCancelled(signal)
        this.step('comparing', entry.key)
        let outcome: Outcome | 'failed'
        try {
          const parts = validateKey(entry.key)
          if (
            this.temps.protects(join(root, ...parts)) ||
            parts.some(
              (part, index) =>
                isSyncTempDirectory(part) &&
                (index < parts.length - 1 || entry.kind === 'directory')
            )
          )
            throw new SyncSkip('保留残留临时目录，不参与同步')
          if (entry.scanError) throw new Error(entry.reason)
          if (invalid.has(entry.key)) throw new SyncSkip(invalid.get(entry.key))
          if (entry.kind === 'skip') throw new SyncSkip(entry.reason)
          outcome =
            direction === 'download'
              ? await this.download(connection.client, root, entry, signal)
              : await this.upload(connection.client, root, entry, signal)
        } catch (err) {
          if (signal.aborted) throw new SyncCancelled()
          outcome = err instanceof SyncSkip ? 'skipped' : 'failed'
          this.issue(entry.key, err, outcome === 'skipped' ? 'skip' : 'error')
        }
        const state = this.state!
        this.change({ processed: state.processed + 1, [outcome]: state[outcome] + 1 })
      }
    } catch (err) {
      if (!signal.aborted) {
        fatal = true
        this.issue((err as { path?: string })?.path ?? this.state?.currentFile ?? '', err)
        this.change({ message: errorInfo(err).message })
      }
    } finally {
      for (const path of this.temps.paths) {
        try {
          await this.temps.remove(path)
        } catch (err) {
          this.issue(path, err, 'error', 'cleanup')
        }
      }
      const errors = this.issues.some((i) => i.kind === 'error')
      if (this.state && this.state.created + this.state.overwritten > 0)
        notifyContentChanged(connection.bucket)
      const phase: SyncPhase = signal.aborted
        ? 'cancelled'
        : fatal
          ? 'failed'
          : errors
            ? 'partial'
            : 'success'
      this.change(
        {
          phase,
          currentFile: null,
          message: signal.aborted
            ? errors
              ? '已取消，部分清理或文件操作失败，请查看详情'
              : '已取消；已经完成的文件保留'
            : (this.state?.message ?? null)
        },
        true
      )
    }
  }
  private async cleanupTemp(path: string): Promise<void> {
    try {
      await this.temps.remove(path)
    } catch (err) {
      this.issue(path, err, 'error', 'cleanup')
    }
  }
  private async confirmIfNewer(
    key: string,
    localPath: string,
    localModifiedAt: number,
    remoteModifiedAt: number | null,
    signal: AbortSignal
  ): Promise<void> {
    checkCancelled(signal)
    if (remoteModifiedAt === null || !Number.isFinite(localModifiedAt))
      throw new Error('无法获取有效的文件修改时间，已保留目标文件')
    const state = this.state!
    const local = Math.floor(localModifiedAt / 1000)
    const remote = Math.floor(remoteModifiedAt / 1000)
    if (state.direction === 'upload' ? remote <= local : local <= remote) return
    this.phase = 'confirming'
    this.change({ phase: 'confirming', currentFile: key }, true)
    const request: SyncConfirmation = {
      taskId: state.taskId,
      direction: state.direction,
      bucket: state.bucket,
      key,
      localPath,
      localModifiedAt,
      remoteModifiedAt
    }
    // 即使 UI 处理器没有响应取消，也必须释放任务等待；迟到的选择不会继续写入。
    let abort: () => void = () => {}
    const confirm = this.confirmOverwrite
    let answer: Awaited<ReturnType<ConfirmOverwrite>>
    try {
      answer = await new Promise<Awaited<ReturnType<ConfirmOverwrite>>>((resolve, reject) => {
        abort = () => reject(new SyncCancelled())
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) return abort()
        Promise.resolve()
          .then(() => {
            checkCancelled(signal)
            return confirm(request, signal)
          })
          .then(resolve, reject)
      })
    } finally {
      signal.removeEventListener('abort', abort)
    }
    checkCancelled(signal)
    if (answer === 'cancel') {
      this.cancel(state.taskId)
      throw new SyncCancelled()
    }
    if (answer === 'skip')
      throw new SyncSkip(`${state.direction === 'upload' ? '云端' : '本地'}文件较新，用户选择跳过`)
    if (answer !== 'overwrite') throw new Error('无效的覆盖确认结果，已保留目标文件')
    this.step('comparing', request.key)
  }
  private async remoteHash(
    client: OSS,
    key: string,
    signal: AbortSignal,
    expected: string,
    destination?: string
  ) {
    checkCancelled(signal)
    const response = await client.getStream(key, {
      ...requestOptions(),
      headers: { 'If-Match': expected }
    })
    if (signal.aborted) {
      response.stream.destroy()
      throw new SyncCancelled()
    }
    return hashStream(response.stream, signal, destination)
  }
  private async download(
    client: OSS,
    root: string,
    entry: Entry,
    signal: AbortSignal
  ): Promise<Outcome> {
    const target = await safePath(root, entry.key, true)
    const before = await maybeStat(target)
    if (entry.kind === 'directory') {
      const info = headInfo(await client.head(entry.key, requestOptions()))
      if (info.size !== 0) throw new Error('目录对象在扫描后发生变化')
      checkCancelled(signal)
      if (before && !before.isDirectory()) throw new SyncSkip('文件与目录同名冲突')
      if (!before) await mkdir(target)
      return before ? 'unchanged' : 'created'
    }
    if (before && !before.isFile()) throw new SyncSkip('文件与目录或特殊文件冲突')
    const info = headInfo(await client.head(entry.key, requestOptions()))
    if ((entry.etag && etag(info.etag) !== etag(entry.etag)) || info.size !== entry.size)
      throw new Error('对象在扫描后发生变化，请重新同步')
    if (before && Number(before.size) !== info.size)
      await this.confirmIfNewer(entry.key, target, Number(before.mtimeMs), info.modifiedAt, signal)
    checkCancelled(signal)
    const dir = await this.temps.create(dirname(target))
    try {
      const temp = join(dir, 'content')
      this.step('transferring', entry.key)
      const incoming = await this.remoteHash(client, entry.key, signal, info.etag, temp)
      if (incoming.size !== info.size) throw new Error('下载大小不符，已保留原文件')
      await safePath(root, entry.key)
      if (before && Number(before.size) === incoming.size) {
        const existing = await snapshotFile(target, signal)
        if (!sameFile(before, existing.stat))
          throw new Error('本地目标在同步期间变化，已保留当前文件')
        if (existing.hash === incoming.hash) return 'unchanged'
        await this.confirmIfNewer(
          entry.key,
          target,
          Number(before.mtimeMs),
          info.modifiedAt,
          signal
        )
      }
      checkCancelled(signal)
      const now = await maybeStat(target)
      if (before ? !now || !sameFile(before, now) : now !== null)
        throw new Error('本地目标在同步期间变化，已保留当前文件')
      await safePath(root, entry.key)
      // 只保留已有目标的基本读写执行位，不将临时文件的 0600 强加给已有文件。
      if (before) await chmod(temp, Number(before.mode & 0o777n))
      checkCancelled(signal)
      await rename(temp, target)
      return before ? 'overwritten' : 'created'
    } finally {
      await this.cleanupTemp(dir)
    }
  }
  private async multipart(
    client: OSS,
    key: string,
    file: string,
    size: number,
    mime: string,
    signal: AbortSignal
  ): Promise<void> {
    const { uploadId } = await client.initMultipartUpload(key, { ...requestOptions(), mime })
    try {
      // 与 SDK 的大小调整规则一致，最多 10,000 个分片；显式批次确保错误后等待所有在途请求。
      const partSize = Math.max(16 * 1024 * 1024, Math.ceil(size / 10000))
      const parts: Array<{ number: number; etag: string }> = []
      const count = Math.ceil(size / partSize)
      for (let startPart = 1; startPart <= count; startPart += 3) {
        checkCancelled(signal)
        const numbers = Array.from(
          { length: Math.min(3, count - startPart + 1) },
          (_v, i) => startPart + i
        )
        const results = await Promise.allSettled(
          numbers.map(async (number) => {
            const start = (number - 1) * partSize
            const result = await client.uploadPart(
              key,
              uploadId,
              number,
              file,
              start,
              Math.min(start + partSize, size),
              requestOptions()
            )
            return { number, etag: result.etag }
          })
        )
        const error = results.find((result) => result.status === 'rejected')
        if (error?.status === 'rejected') throw error.reason
        for (const result of results) if (result.status === 'fulfilled') parts.push(result.value)
      }
      checkCancelled(signal)
      await client.completeMultipartUpload(key, uploadId, parts, requestOptions())
    } catch (err) {
      try {
        await client.abortMultipartUpload(key, uploadId, requestOptions())
      } catch (cleanup) {
        if (status(cleanup) !== 404) this.issue(key, cleanup, 'error', 'cleanup')
      }
      throw err
    }
  }
  private async upload(
    client: OSS,
    root: string,
    entry: Entry,
    signal: AbortSignal
  ): Promise<Outcome> {
    const source = await safePath(root, entry.key)
    if (entry.kind === 'directory') {
      const stat = await maybeStat(source)
      if (!stat?.isDirectory() || (await readdir(source)).length)
        throw new Error('空目录在扫描后发生变化')
      let exists = false
      try {
        const info = headInfo(await client.head(entry.key, requestOptions()))
        if (info.size !== 0) throw new SyncSkip('云端目录标记包含数据')
        exists = true
      } catch (err) {
        if (status(err) !== 404) throw err
      }
      checkCancelled(signal)
      if (!exists) await client.put(entry.key, Buffer.alloc(0), requestOptions())
      return exists ? 'unchanged' : 'created'
    }
    const stat = await maybeStat(source)
    if (!stat || !entry.stat || !sameFile(entry.stat, stat))
      throw new Error('本地来源在扫描后发生变化')
    const dir = await this.temps.create(this.userData)
    try {
      const temp = join(dir, 'content')
      const snapshot = await snapshotFile(source, signal, temp)
      if (!sameFile(entry.stat, snapshot.stat)) throw new Error('本地来源在建立快照前发生变化')
      let existing: ReturnType<typeof headInfo> | null = null
      try {
        existing = headInfo(await client.head(entry.key, requestOptions()))
      } catch (err) {
        if (status(err) !== 404) throw err
      }
      if (existing?.size === snapshot.size) {
        const remote = await this.remoteHash(client, entry.key, signal, existing.etag)
        if (remote.size !== existing.size) throw new Error('云端比较读取大小不符')
        if (remote.hash === snapshot.hash) return 'unchanged'
      }
      if (existing)
        await this.confirmIfNewer(
          entry.key,
          source,
          Number(snapshot.stat.mtimeMs),
          existing.modifiedAt,
          signal
        )
      checkCancelled(signal)
      this.step('transferring', entry.key)
      // 快照文件无扩展名，上传 MIME 必须从原始 key 推导，不能取临时路径。
      const mime = mimeForKey(entry.key)
      if (snapshot.size < 64 * 1024 * 1024)
        await client.put(entry.key, temp, { ...requestOptions(), mime })
      else await this.multipart(client, entry.key, temp, snapshot.size, mime, signal)
      return existing ? 'overwritten' : 'created'
    } finally {
      await this.cleanupTemp(dir)
    }
  }
}

/** 常见文档及二进制 MIME；未知类型按字节文件处理。 */
function mimeForKey(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase()
  const types: Record<string, string> = {
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    html: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    pdf: 'application/pdf',
    zip: 'application/zip',
    csv: 'text/csv',
    xml: 'application/xml'
  }
  return types[ext] ?? 'application/octet-stream'
}
