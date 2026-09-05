import OSS from 'ali-oss'
import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join, isAbsolute, resolve, parse, relative, sep } from 'path'
import { lstatSync } from 'fs'
import { assertSyncIdle, withTextWrite } from './operations'
import { MAX_TEXT_EDIT_BYTES } from '../shared/constants'
import type {
  OssBucketSummary,
  OssErrorInfo,
  OssObjectListing,
  OssTextContent,
  OssObjectVersion,
  OssConnectionInfo,
  OssTextSaveResult
} from '../shared/types'

/**
 * OSS 客户端管理（主进程独占）。
 *
 * 凭据来源分阶段：
 * - 现在：dev 期从项目根 .env 读取（oss_ak / oss_sk / oss_endpoint / oss_bucket），
 *   .env 已进 .gitignore，打包后不存在
 * - 将来：接入凭据管理 UI + safeStorage 加密落盘后，从这里换成读持久化配置
 */

interface OssEnvConfig {
  accessKeyId: string
  accessKeySecret: string
  endpoint?: string
  region?: string
  bucket?: string
  syncDirLocal?: string
}

/** 最小 .env 解析：KEY=VALUE 逐行，支持 # 注释与成对引号。不引 dotenv 依赖，够用就好 */
function parseDotEnv(raw: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key) vars[key] = value
  }
  return vars
}

function loadEnvConfig(): OssEnvConfig | null {
  // dev 下 app.getAppPath() 是项目根；打包后 .env 不随包分发，读到也不该用
  if (app.isPackaged) return null
  const envPath = join(app.getAppPath(), '.env')
  let config: OssEnvConfig | null = null
  try {
    if (existsSync(envPath)) {
      const vars = parseDotEnv(readFileSync(envPath, 'utf-8'))
      if (vars.oss_ak && vars.oss_sk) {
        config = {
          accessKeyId: vars.oss_ak,
          accessKeySecret: vars.oss_sk,
          endpoint: vars.oss_endpoint || undefined,
          region: vars.oss_region || undefined,
          bucket: vars.oss_bucket || undefined,
          syncDirLocal: vars.sync_dir_local || undefined
        }
      }
    }
  } catch (err) {
    // .env 读不出来只影响 OSS 功能，不拖垮整个应用
    console.warn('[oss] 读取 .env 失败：', err)
  }
  return config
}

// 每个窗口保留自己的配置快照；刷新一个窗口不能更换另一个编辑器使用的凭据。
const connections = new Map<number, { config: OssEnvConfig | null; clients: Map<string, OSS> }>()

export function releaseOssConnection(owner: number): void {
  connections.delete(owner)
}

export function getDefaultBucket(owner: number, reload = true): string | null {
  const current = connections.get(owner)
  if (!reload && current) {
    if (!current.config) throw new Error('缺少 OSS 凭据：请配置 .env 后点击重试')
    return current.config.bucket ?? null
  }
  if (reload || current) assertSyncIdle()
  const config = loadEnvConfig()
  connections.set(owner, { config, clients: new Map() })
  if (!config) throw new Error('缺少 OSS 凭据：请配置 .env 中的 oss_ak / oss_sk，然后点击重试')
  return config.bucket ?? null
}

export function getConnectionInfo(owner: number): OssConnectionInfo {
  const config = connections.get(owner)?.config
  const localDir = config?.syncDirLocal ?? null
  let error: string | null = null
  if (!localDir) error = '请在 .env 中配置 sync_dir_local'
  else if (!isAbsolute(localDir)) error = 'sync_dir_local 必须是绝对路径'
  else {
    try {
      const absolute = resolve(localDir)
      let path = parse(absolute).root
      for (const part of relative(path, absolute).split(sep).filter(Boolean)) {
        path = join(path, part)
        const stat = lstatSync(path)
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          error = '同步目录路径必须由普通目录组成，不能经过文件或符号链接'
          break
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') error = '无法访问同步目录'
    }
  }
  return { defaultBucket: config?.bucket ?? null, syncDirLocal: localDir, syncConfigError: error }
}

/** 每个任务使用独立 SDK 实例，取消分片不会污染窗口的浏览客户端。 */
export function getSyncConnection(owner: number): {
  client: OSS
  bucket: string
  localDir: string
} {
  const info = getConnectionInfo(owner)
  const config = connections.get(owner)?.config
  if (!config || !info.defaultBucket) throw new Error('OSS 连接未就绪，请先刷新配置')
  if (info.syncConfigError || !info.syncDirLocal)
    throw new Error(info.syncConfigError ?? '未配置同步目录')
  return {
    client: new OSS({ ...config, secure: true, timeout: 120000 }),
    bucket: info.defaultBucket,
    localDir: resolve(info.syncDirLocal)
  }
}

export function getOssClient(owner: number, bucket?: string): OSS {
  const connection = connections.get(owner)
  const config = connection?.config
  if (!connection || !config) throw new Error('OSS 连接未就绪，请刷新连接配置')
  const target = bucket ?? config.bucket ?? ''
  let client = connection.clients.get(target)
  if (!client) {
    client = new OSS({
      ...config,
      bucket: target || undefined,
      secure: true,
      timeout: 60000
    })
    connection.clients.set(target, client)
  }
  return client
}

/**
 * 把 SDK 抛出的任意错误压成可序列化的结构。
 * ali-oss 的错误带 name/code/status/requestId（见 docs/oss-sdk-notes.md 第 8 节），
 * request id 是找阿里云排障的唯一凭据，必须保留。
 */
export function toOssError(err: unknown): OssErrorInfo {
  if (err instanceof Error || (typeof err === 'object' && err !== null)) {
    const e = err as {
      name?: string
      message?: string
      code?: string
      status?: number
      requestId?: string
    }
    return {
      message: e.message ?? String(err),
      code: e.code ?? e.name,
      status: typeof e.status === 'number' ? e.status : undefined,
      requestId: e.requestId
    }
  }
  return { message: String(err) }
}

export async function listBuckets(owner: number): Promise<OssBucketSummary[]> {
  const client = getOssClient(owner)
  // @types 把返回标成 Bucket[]，运行时实为 { buckets, owner, isTruncated, nextMarker }，
  // 见 docs/oss-sdk-notes.md 第 10 节，这里断言后只取需要的字段
  const res = (await client.listBuckets({ 'max-keys': 100 })) as unknown as {
    buckets?: Array<{
      name: string
      region: string
      creationDate: string
      StorageClass?: string
      storageClass?: string
    }>
  }
  return (res.buckets ?? []).map((b) => ({
    name: b.name,
    region: b.region,
    creationDate: b.creationDate,
    storageClass: b.StorageClass ?? b.storageClass ?? 'Standard'
  }))
}

export async function listObjects(
  owner: number,
  bucket: string,
  prefix: string,
  continuationToken: string | null
): Promise<OssObjectListing> {
  const client = getOssClient(owner, bucket)

  const query: OSS.ListV2ObjectsQuery = {
    delimiter: '/',
    'max-keys': 200
  }
  if (prefix) query.prefix = prefix
  if (continuationToken) query['continuation-token'] = continuationToken

  const res = await client.listV2(query)
  return {
    bucket,
    prefix,
    objects: (res.objects ?? []).map((o) => ({
      name: o.name,
      lastModified: o.lastModified,
      etag: o.etag,
      size: o.size,
      type: o.type,
      storageClass: o.storageClass
    })),
    prefixes: res.prefixes ?? [],
    isTruncated: res.isTruncated,
    nextContinuationToken: res.isTruncated ? res.nextContinuationToken : null
  }
}

/** 在线编辑的常见文本 mime，未命中同 text/plain。保证覆盖写回后 Content-Type 不退化成 octet-stream */
const TEXT_MIME: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  json: 'application/json',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  csv: 'text/csv',
  md: 'text/markdown',
  markdown: 'text/markdown'
}

function checkTextSize(size: number): void {
  if (!Number.isFinite(size) || size < 0 || size > MAX_TEXT_EDIT_BYTES) {
    throw new Error('文本过大或大小无效，在线编辑上限 2 MB（按 UTF-8 字节计算）')
  }
}

function objectVersion(raw: unknown): OssObjectVersion {
  const headers = raw as Record<string, unknown>
  const etag = headers.etag
  if (typeof etag !== 'string' || !etag)
    throw new Error('OSS 未返回 ETag，无法安全编辑，请重新读取')
  return {
    etag,
    versionId: typeof headers['x-oss-version-id'] === 'string' ? headers['x-oss-version-id'] : null
  }
}

/** HEAD 与 GET 用相同 ETag 绑定；GET 再限制范围和校验实际字节数。 */
export async function getObjectText(
  owner: number,
  bucket: string,
  key: string
): Promise<OssTextContent> {
  const client = getOssClient(owner, bucket)
  const head = await client.head(key)
  const headers = head.res.headers as Record<string, string>
  const length = Number(headers['content-length'])
  checkTextSize(length)
  const version = objectVersion(headers)
  const res = await client.get(key, undefined, {
    headers: {
      'If-Match': version.etag,
      ...(length > 0 ? { Range: `bytes=0-${MAX_TEXT_EDIT_BYTES}` } : {})
    }
  })
  checkTextSize(res.content.length)
  return {
    key,
    content: res.content.toString('utf-8'),
    size: res.content.length,
    version: objectVersion(res.res.headers)
  }
}

// OSS PutObject 没有文档化的目标 ETag 条件覆盖参数。锁覆盖所有窗口的检查和写入，
// 防止本进程内的 TOCTOU；外部写入者不受此锁约束，不能声称跨客户端原子性。
const writes = new Map<string, Promise<void>>()
async function withObjectWrite<T>(bucket: string, key: string, work: () => Promise<T>): Promise<T> {
  const id = JSON.stringify([bucket, key])
  const previous = writes.get(id) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  writes.set(id, current)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (writes.get(id) === current) writes.delete(id)
  }
}

function conflict(): Error {
  return Object.assign(
    new Error(
      '文件已被其他窗口或客户端修改或删除，本次未写入。请先复制保留草稿，再重新读取最新内容。'
    ),
    { code: 'EditConflict' }
  )
}

/** 保存前检查读取时的版本；成功后返回本次 PUT 的版本，不用后续 HEAD 冒充。 */
export async function putObjectText(
  owner: number,
  bucket: string,
  key: string,
  content: string,
  expected: OssObjectVersion
): Promise<OssTextSaveResult> {
  checkTextSize(Buffer.byteLength(content, 'utf-8'))
  if (!expected || typeof expected.etag !== 'string' || !expected.etag)
    throw new Error('缺少编辑版本，请重新读取文件')
  // 在等待锁之前绑定客户端，配置刷新不能改变排队写入的目标。
  const client = getOssClient(owner, bucket)
  return withTextWrite(() =>
    withObjectWrite(bucket, key, async () => {
      let head
      try {
        head = await client.head(key)
      } catch (err) {
        if (toOssError(err).status === 404) throw conflict()
        throw err
      }
      const actual = objectVersion(head.res.headers)
      if (actual.etag !== expected.etag || actual.versionId !== expected.versionId) throw conflict()
      const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase()
      const res = await client.put(key, Buffer.from(content, 'utf-8'), {
        mime: TEXT_MIME[ext] ?? 'text/plain'
      })
      return {
        key,
        size: Buffer.byteLength(content, 'utf-8'),
        version: objectVersion(res.res.headers)
      }
    })
  )
}
