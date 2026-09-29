import type OSS from 'ali-oss'
import { lstat } from 'fs/promises'
import { randomUUID } from 'crypto'
import { MAX_TEXT_DIFF_BYTES, isDiffActive } from '../shared/constants'
import { isTextFileName } from '../shared/path'
import type {
  DiffEntry,
  DiffIssue,
  DiffPage,
  DiffReadResult,
  DiffScanState,
  DiffSnapshot,
  DiffText
} from '../shared/types'
import { isDiffBusy, reserveDiff, subscribeContentChanges, subscribeDiffBusy } from './operations'
import { checkCancelled, prepareRoot, validateKey } from './syncFiles'
import { DiffResults } from './diffResults'
import {
  checkDiffRoot,
  locateDiffFile,
  readDiffPair,
  DiffDirectoryIndex,
  type DiffRoot,
  type LocalDiffFile
} from './diffFiles'

interface Connection {
  client: OSS
  bucket: string
  localDir: string
}
interface Session {
  state: DiffScanState
  connection: Connection
  root: DiffRoot | null
  entries: DiffResults<DiffEntry>
  allowed: Set<string>
  equalized: Set<string>
  issues: DiffResults<DiffIssue>
  controller: AbortController
  finished: Promise<void>
  read: { id: string; controller: AbortController; done: Promise<DiffReadResult> } | null
}
function issue(key: string, error: unknown): DiffIssue {
  const e = error as { message?: string; requestId?: string }
  return {
    key,
    message: e?.message ?? String(error),
    ...(e?.requestId ? { requestId: e.requestId } : {})
  }
}
function entry(key: string, local: DiffText, remote: DiffText): DiffEntry {
  const meta = (text: DiffText) => ({
    size: text.size,
    modifiedAt: text.modifiedAt,
    fingerprint: text.fingerprint
  })
  return { key, local: meta(local), remote: meta(remote) }
}
const byKey = (a: { key: string }, b: { key: string }): number =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0

/** 与同步任务分离：整个服务只读文件和 OSS，结果按窗口保存在内存。 */
export class DiffManager {
  private sessions = new Map<number, Session>()
  private revision = 0
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: Array<() => void>
  constructor() {
    this.unsubscribe = [
      subscribeDiffBusy(() => this.changed(true)),
      subscribeContentChanges((bucket) => {
        for (const session of this.sessions.values())
          if (session.state.bucket === bucket) session.state.stale = true
        this.changed(true)
      })
    ]
  }
  dispose(): void {
    for (const owner of this.sessions.keys()) void this.close(owner)
    for (const unsubscribe of this.unsubscribe) unsubscribe()
    if (this.timer) clearTimeout(this.timer)
    this.listeners.clear()
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private changed(immediate = false): void {
    ++this.revision
    const emit = (): void => {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      for (const listener of this.listeners) listener()
    }
    if (immediate) emit()
    else if (!this.timer) this.timer = setTimeout(emit, 100)
  }
  snapshot(owner: number): DiffSnapshot {
    const state = this.sessions.get(owner)?.state
    return { revision: this.revision, busy: isDiffBusy(), state: state ? { ...state } : null }
  }
  private session(owner: number, taskId: string): Session {
    const session = this.sessions.get(owner)
    if (!session || session.state.taskId !== taskId)
      throw new Error('Diff 会话已结束或不属于当前窗口')
    return session
  }
  start(owner: number, connection: Connection): string {
    const release = reserveDiff()
    const session: Session = {
      connection,
      root: null,
      entries: new DiffResults(),
      allowed: new Set(),
      equalized: new Set(),
      issues: new DiffResults(),
      controller: new AbortController(),
      finished: Promise.resolve(),
      read: null,
      state: {
        taskId: randomUUID(),
        bucket: connection.bucket,
        localDir: connection.localDir,
        phase: 'scanning',
        discovered: 0,
        total: null,
        processed: 0,
        different: 0,
        unchanged: 0,
        uncompared: 0,
        currentFile: null,
        stale: false,
        completedAt: null,
        message: null
      }
    }
    this.sessions.set(owner, session)
    this.changed(true)
    session.finished = this.scan(session).finally(release)
    return session.state.taskId
  }
  async wait(owner: number, taskId: string): Promise<void> {
    await this.session(owner, taskId).finished
  }
  cancel(owner: number, taskId: string): void {
    const session = this.session(owner, taskId)
    if (!isDiffActive(session.state.phase)) return
    session.controller.abort()
    session.state.phase = 'cancelling'
    session.state.message = '正在取消，等待在途读取结束…'
    this.changed(true)
  }
  async close(owner: number, taskId?: string): Promise<void> {
    const session = taskId ? this.session(owner, taskId) : this.sessions.get(owner)
    if (!session) return
    this.sessions.delete(owner)
    session.controller.abort()
    session.read?.controller.abort()
    this.changed(true)
    await Promise.allSettled([session.finished, ...(session.read ? [session.read.done] : [])])
  }
  async cancelRead(owner: number, taskId: string, requestId: string): Promise<void> {
    const current = this.session(owner, taskId).read
    if (current?.id !== requestId) return
    current.controller.abort()
    await current.done.catch(() => {})
  }
  entries(owner: number, taskId: string, offset: number): DiffPage<DiffEntry> {
    return this.session(owner, taskId).entries.page(offset)
  }
  issues(owner: number, taskId: string, offset: number): DiffPage<DiffIssue> {
    return this.session(owner, taskId).issues.page(offset)
  }
  private updateCounts(session: Session): void {
    session.state.different = session.entries.size
    session.state.uncompared = session.issues.size
    this.changed()
  }
  private async scan(session: Session): Promise<void> {
    const { connection, state } = session
    const signal = session.controller.signal
    const localDirectories = new DiffDirectoryIndex()
    let failed = false
    try {
      const path = await prepareRoot(connection.localDir, false)
      const root: DiffRoot = { path, stat: await lstat(path, { bigint: true }) }
      session.root = root
      const objects: Array<{ key: string; size: number }> = []
      const keys = new Set<string>(),
        directories = new Set<string>(),
        tokens = new Set<string>()
      let token: string | undefined
      do {
        checkCancelled(signal)
        const page = await connection.client.listV2(
          { 'max-keys': 1000, ...(token ? { 'continuation-token': token } : {}) },
          { timeout: 60000 }
        )
        checkCancelled(signal)
        for (const object of page.objects ?? []) {
          if (keys.has(object.name)) throw new Error('云端列表出现重复 key，请重新扫描')
          keys.add(object.name)
          const parts = object.name.split('/')
          for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'))
          if (!object.name.endsWith('/') && isTextFileName(object.name))
            objects.push({ key: object.name, size: object.size })
          state.discovered++
        }
        this.changed()
        token = page.isTruncated ? page.nextContinuationToken : undefined
        if (page.isTruncated && (!token || tokens.has(token)))
          throw new Error('OSS 分页游标无效，扫描不完整')
        if (token) tokens.add(token)
      } while (token)

      const pairs: Array<{ key: string; local: LocalDiffFile; size: number }> = []
      const mappings = new Map<string, Map<string, Set<string>>>()
      for (const object of objects.sort(byKey)) {
        checkCancelled(signal)
        try {
          const parts = validateKey(object.key)
          if (
            parts.some((_part, i) => {
              const prefix = parts.slice(0, i + 1).join('/')
              return keys.has(prefix) && directories.has(prefix)
            })
          )
            throw new Error('云端文件与目录同名冲突')
          const local = await locateDiffFile(
            root,
            object.key,
            (logical, physical) => {
              const map = mappings.get(physical) ?? new Map<string, Set<string>>()
              const owners = map.get(logical) ?? new Set<string>()
              owners.add(object.key)
              map.set(logical, owners)
              mappings.set(physical, map)
            },
            localDirectories
          )
          if (local) pairs.push({ ...object, local })
        } catch (error) {
          session.issues.set(object.key, issue(object.key, error))
        }
        this.updateCounts(session)
      }
      for (const map of mappings.values()) {
        if (map.size > 1)
          for (const owners of map.values())
            for (const key of owners)
              session.issues.set(key, {
                key,
                message: '多个云端路径映射到同一本地路径，相关文件未比较'
              })
      }
      const candidates = pairs.filter((pair) => !session.issues.has(pair.key))
      state.total = candidates.length + session.issues.size
      state.processed = session.issues.size
      state.phase = 'comparing'
      this.updateCounts(session)
      let next = 0
      const worker = async (): Promise<void> => {
        while (!signal.aborted && next < candidates.length) {
          const pair = candidates[next++]
          state.currentFile = pair.key
          this.changed()
          try {
            if (
              pair.size > MAX_TEXT_DIFF_BYTES ||
              Number(pair.local.stat.size) > MAX_TEXT_DIFF_BYTES
            )
              throw new Error('文件超过 5 MB，未比较（两侧各自按字节限制）')
            const result = await readDiffPair(
              root,
              connection.client,
              pair.key,
              signal,
              pair.local,
              localDirectories
            )
            checkCancelled(signal)
            if (result.identical) state.unchanged++
            else {
              session.entries.set(pair.key, entry(pair.key, result.local, result.remote))
              session.allowed.add(pair.key)
            }
          } catch (error) {
            if (signal.aborted) return
            session.issues.set(pair.key, issue(pair.key, error))
          }
          state.processed++
          this.updateCounts(session)
        }
      }
      await Promise.all([worker(), worker(), worker()])
      checkCancelled(signal)
      await checkDiffRoot(root)
    } catch (error) {
      if (!signal.aborted) {
        failed = true
        const problem = issue('', error)
        session.issues.set('', problem)
        state.message = problem.message
      }
    } finally {
      localDirectories.clear()
      state.phase = signal.aborted
        ? 'cancelled'
        : failed
          ? 'failed'
          : session.issues.size
            ? 'partial'
            : 'success'
      if (signal.aborted) state.message = '扫描已取消，仅保留已完成比较的结果'
      state.currentFile = null
      state.completedAt = new Date().toISOString()
      this.updateCounts(session)
      this.changed(true)
    }
  }
  read(owner: number, taskId: string, key: string, requestId: string): Promise<DiffReadResult> {
    const session = this.session(owner, taskId)
    if (isDiffActive(session.state.phase)) throw new Error('请等待扫描完成后查看 Diff')
    if (!session.root || !session.allowed.has(key)) throw new Error('文件不属于本次差异扫描结果')
    if (typeof requestId !== 'string' || !requestId || requestId.length > 100)
      throw new Error('无效的读取请求')
    const release = reserveDiff()
    const root = session.root
    const controller = new AbortController()
    const previous = session.entries.get(key)
    const work = async (): Promise<DiffReadResult> => {
      try {
        const pair = await readDiffPair(root, session.connection.client, key, controller.signal)
        checkCancelled(controller.signal)
        session.issues.delete(key)
        if (session.state.phase === 'partial' && !session.issues.size)
          session.state.phase = 'success'
        if (pair.identical) {
          session.entries.delete(key)
          if (!session.equalized.has(key)) session.state.unchanged++
          session.equalized.add(key)
          return { kind: 'identical', key, message: '两端内容现在已经一致，已从差异列表移除' }
        }
        if (session.equalized.delete(key)) session.state.unchanged--
        session.entries.set(key, entry(key, pair.local, pair.remote))
        return {
          kind: 'different',
          key,
          local: pair.local,
          remote: pair.remote,
          readAt: new Date().toISOString(),
          changed:
            !!previous &&
            (previous.local.fingerprint !== pair.local.fingerprint ||
              previous.remote.fingerprint !== pair.remote.fingerprint)
        }
      } catch (error) {
        if (controller.signal.aborted) throw new Error('Diff 读取已取消')
        const problem = issue(key, error)
        if (session.equalized.delete(key)) session.state.unchanged--
        session.entries.delete(key)
        session.issues.set(key, problem)
        if (session.state.phase === 'success') session.state.phase = 'partial'
        return { kind: 'unavailable', key, message: problem.message }
      } finally {
        this.updateCounts(session)
      }
    }
    const done = work().finally(() => {
      if (session.read?.id === requestId) session.read = null
      release()
      this.changed(true)
    })
    session.read = { id: requestId, controller, done }
    return done
  }
}
