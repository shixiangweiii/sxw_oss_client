import { constants, createWriteStream, type BigIntStats } from 'fs'
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile
} from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, parse, sep } from 'path'
import { createHash, randomUUID } from 'crypto'
import { Transform, Writable, type Readable } from 'stream'
import { pipeline } from 'stream/promises'

export class SyncSkip extends Error {}
export class SyncCancelled extends Error {
  constructor() {
    super('同步已取消')
  }
}
export function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new SyncCancelled()
}
export function validateKey(key: string): string[] {
  const value = key.endsWith('/') ? key.slice(0, -1) : key
  const parts = value.split('/')
  if (
    !value ||
    isAbsolute(value) ||
    value.includes('\0') ||
    value.startsWith('\\') ||
    (sep === '\\' && value.includes('\\')) ||
    parts.some((p) => !p || p === '.' || p === '..')
  ) {
    throw new SyncSkip('路径无法安全映射到本地目录')
  }
  return parts
}
export async function maybeStat(path: string) {
  try {
    return await lstat(path, { bigint: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}
export async function prepareRoot(path: string, create: boolean): Promise<string> {
  if (!isAbsolute(path)) throw new Error('同步目录必须是绝对路径')
  const absolute = resolve(path)
  let parent = parse(absolute).root
  for (const part of relative(parent, absolute).split(sep).filter(Boolean)) {
    parent = join(parent, part)
    const current = await maybeStat(parent)
    if (current?.isSymbolicLink()) throw new Error('同步目录路径不能经过符号链接')
    if (!current && create) await mkdir(parent)
    else if (!current || !current.isDirectory()) throw new Error('同步根目录不存在或不是普通目录')
  }
  const stat = await maybeStat(path)
  if (!stat?.isDirectory() || stat.isSymbolicLink())
    throw new Error('同步根目录不存在或不是普通目录')
  await access(path, constants.R_OK | (create ? constants.W_OK : 0))
  return realpath(path)
}

/** 每个路径分量单独校验，不让 mkdir/rename 穿过目标目录中的符号链接。 */
export async function safePath(root: string, key: string, makeParents = false): Promise<string> {
  const parts = validateKey(key)
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new SyncSkip('同步根目录已被替换')
  let current = root
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    // 在实际卷上识别已有名称的大小写别名，不能悄悄覆盖另一个 key。
    const next = join(current, part)
    const stat = await maybeStat(next)
    if (stat) {
      const names = await readdir(current)
      if (!names.some((name) => name.normalize('NFD') === part.normalize('NFD'))) {
        throw new SyncSkip('名称与已有路径发生大小写冲突')
      }
      if (stat.isSymbolicLink()) throw new SyncSkip('跳过符号链接')
      if (i < parts.length - 1 && !stat.isDirectory()) throw new SyncSkip('文件与目录同名冲突')
    } else if (i < parts.length - 1) {
      if (!makeParents) throw new Error('来源目录已被删除')
      await mkdir(next)
    }
    current = next
  }
  const rel = relative(root, current)
  if (rel.startsWith('..' + sep) || isAbsolute(rel)) throw new SyncSkip('路径越界')
  return current
}

export function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  )
}

export async function hashStream(
  stream: Readable,
  signal: AbortSignal,
  destination?: string
): Promise<{ hash: string; size: number }> {
  const hash = createHash('sha256')
  let size = 0
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length
      hash.update(chunk)
      callback(null, chunk)
    }
  })
  const sink = destination
    ? createWriteStream(destination, { flags: 'wx', mode: 0o600 })
    : new Writable({
        write(_chunk, _encoding, callback) {
          callback()
        }
      })
  await pipeline(stream, meter, sink, { signal })
  return { hash: hash.digest('hex'), size }
}
export async function snapshotFile(path: string, signal: AbortSignal, destination?: string) {
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) throw new SyncSkip('跳过符号链接或特殊文件')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!sameFile(before, opened)) throw new Error('文件在读取前发生变化')
    const result = await hashStream(
      handle.createReadStream({ autoClose: false }),
      signal,
      destination
    )
    const after = await lstat(path, { bigint: true })
    if (!sameFile(before, after) || !sameFile(opened, await handle.stat({ bigint: true })))
      throw new Error('文件在读取期间发生变化')
    return { ...result, stat: after }
  } finally {
    await handle.close()
  }
}

interface TempRecord {
  path: string
  token: string
  parent: string
  dev?: string
  ino?: string
}
export interface TempProblem {
  path: string
  message: string
}
const TEMP_UUID =
  /^\.oss-client-sync-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isSyncTempDirectory(name: string): boolean {
  return TEMP_UUID.test(name)
}
function validRecord(value: unknown): value is TempRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as Partial<TempRecord>
  return (
    typeof r.path === 'string' &&
    typeof r.parent === 'string' &&
    typeof r.token === 'string' &&
    isAbsolute(r.path) &&
    dirname(r.path) === r.parent &&
    r.path === join(r.parent, '.oss-client-sync-' + r.token) &&
    isSyncTempDirectory(basename(r.path)) &&
    (r.dev === undefined || typeof r.dev === 'string') &&
    (r.ino === undefined || typeof r.ino === 'string')
  )
}
function pathError(path: string, err: unknown): Error & { path: string } {
  return Object.assign(new Error(`${path}：${(err as Error)?.message ?? String(err)}`), { path })
}

/** 残留清理失败逐条报告并保留记录；不能确认归属的目录永远不会递归删除。 */
export class SyncTemps {
  private records: TempRecord[] = []
  private loaded = false
  constructor(private readonly userData: string) {}
  private get manifest(): string {
    return join(this.userData, 'sync-temp-files.json')
  }
  private async persist(): Promise<void> {
    const next = this.manifest + '.next'
    try {
      await writeFile(next, JSON.stringify(this.records), { mode: 0o600 })
      await rename(next, this.manifest)
    } catch (err) {
      throw pathError(this.manifest, err)
    }
  }
  async recover(): Promise<TempProblem[]> {
    const problems: TempProblem[] = []
    await mkdir(this.userData, { recursive: true })
    if (!this.loaded) {
      let raw: string | null = null
      try {
        raw = await readFile(this.manifest, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw pathError(this.manifest, err)
      }
      if (raw !== null) {
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          parsed = null
        }
        this.records = Array.isArray(parsed) ? parsed.filter(validRecord) : []
        if (!Array.isArray(parsed) || this.records.length !== parsed.length) {
          // 先原样保留坏清单，再建立新清单；可解析的有效记录仍继续恢复。
          const backup = join(this.userData, `sync-temp-files.corrupt-${randomUUID()}.json`)
          try {
            await rename(this.manifest, backup)
          } catch (err) {
            throw pathError(this.manifest, err)
          }
          await this.persist()
          problems.push({
            path: this.manifest,
            message: `临时文件清单损坏，已原样备份到 ${backup}；可疑临时目录保留且不会上传`
          })
        }
      }
      this.loaded = true
    }
    for (const record of [...this.records]) {
      try {
        await this.remove(record.path)
      } catch (err) {
        problems.push({ path: record.path, message: (err as Error).message })
      }
    }
    return problems
  }
  async create(base: string): Promise<string> {
    const parent = await realpath(base)
    const token = randomUUID()
    const path = join(parent, '.oss-client-sync-' + token)
    const record: TempRecord = { path, token, parent }
    this.records.push(record)
    await this.persist()
    await mkdir(path, { mode: 0o700 })
    // 在创建/删除 owner 前持久化目录身份，崩溃留下的空目录可以安全回收。
    const stat = await lstat(path, { bigint: true })
    record.dev = String(stat.dev)
    record.ino = String(stat.ino)
    await this.persist()
    await writeFile(join(path, 'owner'), token, { flag: 'wx', mode: 0o600 })
    return path
  }
  async remove(path: string): Promise<void> {
    const record = this.records.find((r) => r.path === path)
    if (!record) throw new Error('临时目录归属未知，拒绝清理')
    const stat = await maybeStat(path)
    if (stat) {
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await realpath(record.parent)) !== record.parent
      )
        throw new Error('临时目录路径已变化，保留目录')
      const names = await readdir(path)
      const owner = await maybeStat(join(path, 'owner'))
      if (!owner) {
        if (names.length || record.dev !== String(stat.dev) || record.ino !== String(stat.ino))
          throw new Error('临时目录缺少归属标记，保留目录并跳过同步')
      } else {
        if (
          !owner.isFile() ||
          owner.isSymbolicLink() ||
          (await readFile(join(path, 'owner'), 'utf8')) !== record.token
        )
          throw new Error('临时目录标记不匹配，保留目录')
        if (names.some((n) => !['owner', 'content', 'é'].includes(n.normalize('NFC'))))
          throw new Error('临时目录含未知文件，保留目录并跳过同步')
        // 为旧清单补充当前已验证目录身份，保证 owner 删除后的中断可恢复。
        record.dev = String(stat.dev)
        record.ino = String(stat.ino)
        await this.persist()
        for (const name of names.filter((n) => n !== 'owner')) await unlink(join(path, name))
        await unlink(join(path, 'owner'))
      }
      await rmdir(path)
    }
    this.records = this.records.filter((r) => r !== record)
    await this.persist()
  }
  protects(path: string): boolean {
    return (
      this.records.some((r) => path === r.path || path.startsWith(r.path + sep)) ||
      path.split(sep).some(isSyncTempDirectory)
    )
  }
  async volumeRules(
    root: string,
    onCleanupError?: (path: string, err: unknown) => void
  ): Promise<{ caseSensitive: boolean; normalizationSensitive: boolean }> {
    // 优先使用同卷 userData，上传只读目录不必为了探测而向来源目录写文件。
    const rootStat = await lstat(root, { bigint: true })
    const appStat = await lstat(this.userData, { bigint: true })
    const base = rootStat.dev === appStat.dev ? this.userData : root
    const dir = await this.create(base)
    try {
      await writeFile(join(dir, 'content'), '')
      await writeFile(join(dir, 'é'), '')
      return {
        caseSensitive: !(await maybeStat(join(dir, 'CONTENT'))),
        normalizationSensitive: !(await maybeStat(join(dir, 'e\u0301')))
      }
    } finally {
      try {
        await this.remove(dir)
      } catch (err) {
        if (onCleanupError) onCleanupError(dir, err)
        else throw err
      }
    }
  }
  get paths(): string[] {
    return this.records.map((r) => r.path)
  }
}
