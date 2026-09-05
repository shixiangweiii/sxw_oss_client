# ali-oss SDK 学习笔记

依据官方 Node.js SDK 文档（help.aliyun.com/zh/oss/developer-reference/nodejs-sdk/）与本地
`node_modules/ali-oss@6.23.0`（README 即官方文档同源全文、`lib/` 源码）整理。
供本客户端开发速查，API 细节以 `@types/ali-oss` 与源码为准。

## 1. 实例化

```ts
import OSS from 'ali-oss'

const client = new OSS({
  region: 'oss-cn-hangzhou',      // 或 endpoint（endpoint 优先于 region）
  accessKeyId: '...',
  accessKeySecret: '...',
  bucket: 'my-bucket',            // 可选，也可 useBucket(name) 切换
  secure: true,                   // ⚠️ 默认 false（HTTP），桌面客户端必须显式开启
  timeout: '60s',                 // 实例级超时，默认 60000ms
  // stsToken / refreshSTSToken / refreshSTSTokenInterval  // STS 临时凭据场景
  // cname: true + endpoint: 'cdn.example.com'              // 自定义域名场景
  // authorizationV4: true                                  // V4 签名（新规范，配合 signatureUrlV4）
})
```

源码确认的默认值（`lib/common/client/initOptions.js`）：
`region: 'oss-cn-hangzhou'`、`secure: false`、`timeout: 60000`、`retryMax: 0`（不自动重试）、
`internal: false`、`cname: false`。accessKeyId/Secret 必填且会 trim。

Electron 约定：**实例只建在主进程**（CJS 包，`export = OSS`；依赖 Node stream）。
按 bucket/region 维度缓存实例，凭据变更时重建。

## 2. Bucket 操作（客户端首屏 & 管理页）

| 需求 | API | 要点 |
| --- | --- | --- |
| 列出所有 bucket | `listBuckets({ prefix, marker, 'max-keys' })` | max-keys 上限 1000；返回 `{ buckets, owner, isTruncated, nextMarker }`（⚠️ @types 标成 `Bucket[]`，需断言） |
| bucket 详情 | `getBucketInfo(name)` | 含 Extranet/IntranetEndpoint、StorageClass、Versioning |
| 存储统计 | `getBucketStat(name)` | 容量/对象数，**非实时**（延迟可超 1h） |
| 所属 region | `getBucketLocation(name)` | |
| 创建/删除 | `putBucket(name, { acl, storageClass, dataRedundancyType })` / `deleteBucket(name)` | 删除仅限空 bucket；重名抛 BucketAlreadyExistsError |
| ACL | `getBucketACL` / `putBucketACL(name, 'private'\|'public-read'\|'public-read-write')` | |

Bucket 元数据字段：`name / region(如 oss-cn-hangzhou-a) / creationDate(GMT 字符串) / storageClass`。

## 3. Object 列表（文件浏览器核心）

```ts
// listV2 官方推荐（分页令牌语义更清晰）
const res = await client.listV2({
  prefix: 'fun/',            // 当前目录前缀
  delimiter: '/',            // 只列当前层，子目录折叠进 prefixes
  'max-keys': 200,
  'continuation-token': token // 翻页：上一页的 nextContinuationToken
})
// res: { objects, prefixes, isTruncated, nextContinuationToken, keyCount }
// object: { name(完整 key), url, lastModified(GMT 字符串), etag, size(Number 字节),
//           type('Normal'|'Multipart'), storageClass, owner, restoreInfo? }
```

- `prefixes: string[]` 就是「子文件夹」列表 —— 文件浏览器 = objects + prefixes 合并渲染。
- 翻页条件：`isTruncated === true` 时带 `nextContinuationToken`（listV2）或 `nextMarker`（list）再请求。
- `restoreInfo.ongoingRequest` 可判断归档文件解冻状态。
- 版本控制 bucket 用 `getBucketVersions`；get/head/delete/copy 均支持 `versionId`。

## 4. 上传

```ts
// 简单上传：Node 下直接传本地路径字符串，小文件首选
await client.put('dir/a.txt', '/local/path/a.txt', { mime, meta, headers })

// 分片上传：大文件 / 需要进度 / 断点续传
await client.multipartUpload('dir/big.zip', '/local/path/big.zip', {
  parallel: 4,
  partSize: 1024 * 1024,             // 默认 1MB，最小 100KB
  progress: (percentage, checkpoint, res) => {
    // percentage 0~1；checkpoint 用于断点续传，需持久化
  },
  checkpoint: savedCheckpoint        // 传入则续传，否则新建 uploadId
})
```

- **取消/中止**：同一实例 `client.cancel()`（捕获后 `client.isCancel()` 判断）；
  `client.abortMultipartUpload(name, uploadId)` 彻底废弃服务端分片。
- checkpoint 含 `{ file, name, fileSize, partSize, uploadId, doneParts[{number, etag}] }`，
  序列化落盘（key: `${bucket}:${name}:${fileSize}`）即可实现跨会话续传。
- `ConnectionTimeoutError`：减小 partSize / 增大 timeout / 业务侧重试。
- `retryMax` 自动重试仅限网络错误/超时，**stream 请求不会重试**（流只能消费一次）。

## 5. 下载

```ts
// 直接落盘（Node 独占能力，file 参数是本地路径）
await client.get('dir/a.txt', '/local/path/a.txt', { timeout: 120000 })

// 拿 Buffer（仅小文件）
const { content } = await client.get('dir/a.txt')

// 流式（边下边写/管道）
const { stream } = await client.getStream('dir/big.zip')

// Range 断点/分段
await client.get('dir/big.zip', '/tmp/part', { headers: { Range: 'bytes=0-104857599' } })
```

注意：`get` 的 file 参数**省略时**第二个参数会被当成 options（`get(name, {versionId})`）。
ResponseTimeoutError 默认 60s，大文件务必传 `timeout`。

## 6. 元信息 / 删除 / 复制

```ts
const { status, meta } = await client.head('dir/a.txt')     // 用户 meta；304 时 meta 为 null
const h = (await client.getObjectMeta('dir/a.txt')).res.headers // ETag/Content-Length/Last-Modified
await client.delete('dir/a.txt')                            // 幂等：不存在也成功
await client.deleteMulti(['a', 'b'], { quiet: true })       // 批量，单次上限 1000
await client.copy('newKey', 'oldKey')                       // 同 bucket；跨 bucket 传第三参
```

## 7. 签名 URL（分享/外部预览）

```ts
client.signatureUrl('dir/a.txt', {                      // V1，同步
  expires: 3600,
  response: { 'content-disposition': 'attachment; filename="a.txt"' }
})
await client.signatureUrlV4('GET', 3600, undefined, 'dir/a.txt')  // V4，推荐
```

## 8. 错误处理

错误对象结构：`{ name, message, code, status, requestId, hostId }` —— `requestId` 可提交给
阿里云排查。高频错误码：

| 场景 | 错误 | status |
| --- | --- | --- |
| 凭据错误/无权限 | SignatureDoesNotMatch / AccessDenied / InvalidAccessKeyId | 403/400 |
| bucket 不存在 / 非空删除 | NoSuchBucket / BucketNotEmpty | 404/409 |
| 文件不存在 | NoSuchKey | 404 |
| STS 过期 | SecurityTokenExpired | 403 |
| 网络中断 / 连接超时 | RequestError / ConnectionTimeoutError | -1 / -2 |
| 本机时间偏差 >15min | RequestTimeTooSkewed | 403 |

统一在主进程 IPC handler 里 catch，转成 `{ message, code?, requestId? }` 结构回传渲染层。

## 9. 与桌面客户端的功能映射

| 客户端功能 | SDK API |
| --- | --- |
| 连接测试（凭据校验） | `listBuckets({ 'max-keys': 1 })` |
| bucket 列表/切换 | `listBuckets` / `useBucket` |
| 文件浏览器 | `listV2`（prefix + delimiter + 翻页） |
| 上传（拖拽/选文件） | 小 `put`、大 `multipartUpload` + checkpoint 持久化 |
| 下载 / 另存为 | `get(key, savePath)`（复用现有 file:save 对话框） |
| 删除（含批量） | `delete` / `deleteMulti` |
| 重命名/移动 | `copy` 到新 key + `delete` 原 key |
| 复制签名链接 | `signatureUrl` / `signatureUrlV4` |
| 传输进度 | multipartUpload 的 `progress` 回调 → `webContents.send` 推送渲染层 |
| 归档文件预热 | `restore(name)` + `restoreInfo` 状态展示 |
| 存储统计 | `getBucketStat`（展示时标注"非实时"） |

## 10. TypeScript 注意事项

- `@types/ali-oss` 与运行时有出入，已知：`listBuckets` 实际返回 `{ buckets, ... }` 而类型标为
  `Promise<Bucket[]>`（用 `as` 断言或在 `src/main/oss.ts` 里包一层自己的返回类型）；
  `signatureUrl` 第三参 `strictObjectNameValidation` 在实例方法类型里被省略。
- `import OSS from 'ali-oss'` + `"esModuleInterop": true` 已在 tsconfig 配好；
  main 进程 bundle 由 `externalizeDepsPlugin()` 保持 external，打包时随 `dependencies` 进 asar。
