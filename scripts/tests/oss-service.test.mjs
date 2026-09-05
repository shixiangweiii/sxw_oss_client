import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader, deferred, tick } from './source-loader.mjs'

function service() {
  let env = null,
    reads = 0,
    revision = 0
  let bytes = Buffer.from('old')
  let putCount = 0,
    blockPut = null
  const clients = []
  const headers = () => ({ etag: `"${revision}"`, 'content-length': String(bytes.length) })
  class Client {
    constructor(options) {
      this.options = options
      clients.push(this)
    }
    async head() {
      return { res: { headers: headers() } }
    }
    async get(_key, _file, options) {
      assert.equal(options.headers['If-Match'], headers().etag)
      return { content: bytes, res: { headers: headers() } }
    }
    async put(_key, data) {
      putCount++
      if (blockPut) await blockPut
      bytes = data
      revision++
      return { res: { headers: headers() } }
    }
  }
  const load = sourceLoader({
    'ali-oss': Client,
    electron: { app: { isPackaged: false, getAppPath: () => '/mock' } },
    fs: {
      existsSync: () => {
        reads++
        return env !== null
      },
      readFileSync: () => env
    }
  })
  const api = load('src/main/oss.ts')
  return {
    api,
    clients,
    config(value = 'one') {
      env = `oss_ak=mock-${value}\noss_sk=mock\noss_bucket=${value}`
    },
    get reads() {
      return reads
    },
    get putCount() {
      return putCount
    },
    set blockPut(value) {
      blockPut = value
    },
    get text() {
      return bytes.toString()
    },
    externalEdit() {
      bytes = Buffer.from('external')
      revision++
    }
  }
}

test('缺失配置可重试；重载只替换当前窗口的客户端与配置', () => {
  const s = service()
  assert.throws(() => s.api.getDefaultBucket(1), /凭据/)
  s.config()
  assert.equal(s.api.getDefaultBucket(1), 'one')
  assert.equal(s.api.getDefaultBucket(2), 'one')
  const first = s.api.getOssClient(1),
    other = s.api.getOssClient(2)
  s.config('two')
  assert.equal(s.api.getDefaultBucket(1), 'two')
  assert.notEqual(s.api.getOssClient(1), first)
  assert.equal(s.api.getOssClient(2), other)
  assert.equal(s.api.getOssClient(2).options.bucket, 'one')
  assert.equal(s.reads, 4)
  s.api.releaseOssConnection(2)
  assert.throws(() => s.api.getOssClient(2), /未就绪/)
})

test('各 Bucket 客户端固定绑定，异步读取不依赖 useBucket 可变状态', () => {
  const s = service()
  s.config()
  s.api.getDefaultBucket(1)
  const a = s.api.getOssClient(1, 'a'),
    b = s.api.getOssClient(1, 'b')
  assert.notEqual(a, b)
  assert.equal(a.options.bucket, 'a')
  assert.equal(b.options.bucket, 'b')
})

test('两个窗口同时保存相同旧版本，只能有一次写入，其余明确冲突', async () => {
  const s = service()
  s.config()
  s.api.getDefaultBucket(1)
  s.api.getDefaultBucket(2)
  const a = await s.api.getObjectText(1, 'one', 'a.txt')
  const b = await s.api.getObjectText(2, 'one', 'a.txt')
  const gate = deferred()
  s.blockPut = gate.promise
  const first = s.api.putObjectText(1, 'one', 'a.txt', 'first', a.version)
  await tick()
  const second = s.api.putObjectText(2, 'one', 'a.txt', 'second', b.version)
  const rejected = assert.rejects(second, (e) => e.code === 'EditConflict')
  await tick()
  assert.equal(s.putCount, 1)
  gate.resolve()
  const saved = await first
  await rejected
  assert.equal(s.text, 'first')
  assert.equal(saved.version.etag, '"1"')
  assert.equal(saved.size, 5)
  assert.equal(s.putCount, 1)
})

test('保存前已发生的外部修改被检测，草稿不会覆盖对象', async () => {
  const s = service()
  s.config()
  s.api.getDefaultBucket(1)
  const read = await s.api.getObjectText(1, 'one', 'a.txt')
  s.externalEdit()
  await assert.rejects(
    s.api.putObjectText(1, 'one', 'a.txt', 'mine', read.version),
    (e) => e.code === 'EditConflict'
  )
  assert.equal(s.putCount, 0)
  assert.equal(s.text, 'external')
})

test('服务端边界接受恰好 2 MB，拒绝多一个字节，并可再次打开', async () => {
  const s = service()
  s.config()
  s.api.getDefaultBucket(1)
  const read = await s.api.getObjectText(1, 'one', 'a.txt')
  await assert.rejects(
    s.api.putObjectText(1, 'one', 'a.txt', 'x'.repeat(2097153), read.version),
    /2 MB/
  )
  assert.equal(s.putCount, 0)
  const saved = await s.api.putObjectText(1, 'one', 'a.txt', 'x'.repeat(2097152), read.version)
  assert.equal(saved.size, 2097152)
  assert.equal((await s.api.getObjectText(1, 'one', 'a.txt')).size, 2097152)
})
