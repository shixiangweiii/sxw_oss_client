import OSS from 'ali-oss'
import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { OssBucketSummary, OssErrorInfo, OssObjectListing, OssTextContent } from '../shared/types'

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

/** 三态缓存：undefined 未读过 / null 没配 / 有配置 */
let cachedEnv: OssEnvConfig | null | undefined

function loadEnvConfig(): OssEnvConfig | null {
  if (cachedEnv !== undefined) return cachedEnv
  // dev 下 app.getAppPath() 是项目根；打包后 .env 不随包分发，读到也不该用
  const envPath = join(app.getAppPath(), '.env')
  cachedEnv = null
  try {
    if (existsSync(envPath)) {
      const vars = parseDotEnv(readFileSync(envPath, 'utf-8'))
      if (vars.oss_ak && vars.oss_sk) {
        cachedEnv = {
          accessKeyId: vars.oss_ak,
          accessKeySecret: vars.oss_sk,
          endpoint: vars.oss_endpoint || undefined,
          region: vars.oss_region || undefined,
          bucket: vars.oss_bucket || undefined
        }
      }
    }
  } catch (err) {
    // .env 读不出来只影响 OSS 功能，不拖垮整个应用
    console.warn('[oss] 读取 .env 失败：', err)
  }
  return cachedEnv
}

let cachedClient: OSS | null = null

export function getOssClient(): OSS {
  if (cachedClient) return cachedClient
  const config = loadEnvConfig()
  if (!config) {
    throw new Error('缺少 OSS 凭据：请在项目根 .env 配置 oss_ak / oss_sk（dev 期）')
  }
  cachedClient = new OSS({
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    // SDK 默认 secure: false（HTTP），桌面客户端显式走 HTTPS
    secure: true,
    timeout: 60000
  })
  return cachedClient
}

/** .env 里指定的默认 bucket，用于首屏自动选中 */
export function getDefaultBucket(): string | null {
  return loadEnvConfig()?.bucket ?? null
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

export async function listBuckets(): Promise<OssBucketSummary[]> {
  const client = getOssClient()
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
  bucket: string,
  prefix: string,
  continuationToken: string | null
): Promise<OssObjectListing> {
  const client = getOssClient()
  client.useBucket(bucket)

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

/** 在线编辑的大小上限：再大就不适合整段塞进渲染层的 DOM 了 */
const MAX_TEXT_EDIT_BYTES = 2 * 1024 * 1024

/** 读取文本文件内容（UTF-8）。先 head 校验大小，避免把超大对象整段读进内存 */
export async function getObjectText(bucket: string, key: string): Promise<OssTextContent> {
  const client = getOssClient()
  client.useBucket(bucket)

  const head = await client.head(key)
  // @types 把 res.headers 标成 {}，运行时是 Node 的响应头对象
  const headers = head.res.headers as Record<string, string | string[] | undefined>
  const length = Number(headers['content-length'] ?? '0')
  if (Number.isFinite(length) && length > MAX_TEXT_EDIT_BYTES) {
    throw new Error(
      `文件过大（${(length / 1024 / 1024).toFixed(1)} MB），在线编辑上限 2 MB`
    )
  }

  const res = await client.get(key)
  return { key, content: res.content.toString('utf-8'), size: res.content.length }
}

/** 用编辑后的内容覆盖原对象（UTF-8），保持合理的 Content-Type */
export async function putObjectText(
  bucket: string,
  key: string,
  content: string
): Promise<{ key: string }> {
  const client = getOssClient()
  client.useBucket(bucket)

  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase()
  await client.put(key, Buffer.from(content, 'utf-8'), {
    mime: TEXT_MIME[ext] ?? 'text/plain'
  })
  return { key }
}
