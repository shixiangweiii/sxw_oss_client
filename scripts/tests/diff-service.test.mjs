import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import OSS from 'ali-oss'
import { sourceLoader, deferred, tick } from './source-loader.mjs'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const limit = 2 * 1024 * 1024
async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (check()) return
    await tick()
  }
  assert.fail('等待 Diff 状态超时')
}
async function fixture(t, local = {}, remote = {}, overrides = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oss-diff-test-')))
  for (const [key, value] of Object.entries(local)) {
    await fs.mkdir(path.dirname(path.join(root, key)), { recursive: true })
    await fs.writeFile(path.join(root, key), value)
  }
  const objects = new Map(Object.entries(remote).map(([key, value]) => [key, Buffer.from(value)]))
  const traffic = []
  const headers = (key) => {
    const bytes = objects.get(key)
    if (!bytes) throw Object.assign(new Error('云端文件不存在'), { status: 404 })
    return {
      etag: `"${hash(bytes)}"`,
      'content-length': String(bytes.length),
      'last-modified': 'Wed, 01 Jan 2020 00:00:00 GMT'
    }
  }
  const client = {
    pageSize: 1000,
    async listV2(query) {
      traffic.push(['LIST', query])
      const offset = Number(query['continuation-token'] ?? 0)
      const all = [...objects].map(([name, value]) => ({ name, size: value.length }))
      const next = offset + this.pageSize
      return {
        objects: all.slice(offset, next),
        isTruncated: next < all.length,
        nextContinuationToken: String(next)
      }
    },
    async head(key) {
      traffic.push(['HEAD', key])
      return { res: { headers: headers(key) } }
    },
    async getStream(key, options) {
      traffic.push(['GET', key, options])
      assert.equal(options.headers['If-Match'], headers(key).etag)
      return { stream: Readable.from([objects.get(key)]), res: { headers: headers(key) } }
    },
    async put() {
      assert.fail('Diff 不得写 OSS')
    }
  }
  const load = sourceLoader(overrides)
  const manager = new (load('src/main/diff.ts').DiffManager)()
  const connection = { client, localDir: root, bucket: 'fixture' }
  t.after(async () => {
    await manager.close(1)
    await manager.close(2)
    manager.dispose()
    await fs.rm(root, { recursive: true, force: true })
  })
  const run = async (owner = 1) => {
    const id = manager.start(owner, connection)
    await manager.wait(owner, id)
    return id
  }
  return {
    root,
    client,
    connection,
    objects,
    traffic,
    manager,
    run,
    load,
    ops: load('src/main/operations.ts'),
    files: load('src/main/diffFiles.ts')
  }
}

test('完整分页扫描只列两端文本差异；时间不参与判断，深层目录无需展开', async (t) => {
  const f = await fixture(
    t,
    {
      'same.txt': 'same',
      'a.txt': 'aaaa',
      'deep/x/b.md': 'local',
      'only-local.txt': 'x',
      'a.png': 'x'
    },
    {
      'same.txt': 'same',
      'a.txt': 'bbbb',
      'deep/x/b.md': 'cloud',
      'only-cloud.txt': 'x',
      'a.png': 'y'
    }
  )
  f.client.pageSize = 2
  const before = await fs.stat(path.join(f.root, 'a.txt'))
  const id = await f.run()
  assert.equal(f.manager.snapshot(1).state.phase, 'success')
  assert.equal(f.manager.snapshot(1).state.unchanged, 1)
  assert.deepEqual(
    Array.from(f.manager.entries(1, id, 0).items, (v) => v.key),
    ['a.txt', 'deep/x/b.md']
  )
  assert.equal(f.traffic.filter(([method]) => method === 'LIST').length, 3)
  const after = await fs.stat(path.join(f.root, 'a.txt'))
  assert.equal(after.mtimeMs, before.mtimeMs)
  assert.equal(after.size, before.size)
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'aaaa')
  assert.equal(
    (await fs.readdir(f.root)).some((name) => name.startsWith('.oss-client-sync-')),
    false
  )
})

test('2 MB 按原始字节限制；中文、空文件、超限和无效文本准确分类', async (t) => {
  const full = Buffer.alloc(limit, 'a'),
    over = Buffer.alloc(limit + 1, 'b')
  const f = await fixture(
    t,
    {
      'full.txt': full,
      'local-big.txt': over,
      'cloud-big.txt': 'x',
      'bad.txt': 'abc',
      'nul.txt': 'abc',
      'empty.txt': '',
      'cn.txt': '中文',
      '.env': 'A=1'
    },
    {
      'full.txt': Buffer.alloc(limit, 'b'),
      'local-big.txt': 'x',
      'cloud-big.txt': over,
      'bad.txt': Buffer.from([0xff]),
      'nul.txt': 'a\0c',
      'empty.txt': '',
      'cn.txt': '汉字',
      '.env': 'A=2'
    }
  )
  const id = await f.run()
  const state = f.manager.snapshot(1).state
  assert.equal(state.phase, 'partial')
  assert.equal(state.different, 3)
  assert.equal(state.unchanged, 1)
  assert.equal(state.uncompared, 4)
  const detail = await f.manager.read(1, id, 'full.txt', 'full')
  assert.equal(detail.local.size, limit)
  assert.equal(detail.remote.content.length, limit)
  const problems = f.manager.issues(1, id, 0).items
  assert.match(problems.find((p) => p.key === 'bad.txt').message, /UTF-8/)
  assert.match(problems.find((p) => p.key === 'nul.txt').message, /NUL/)
})

test('BOM、换行和末尾换行以字节比较，元信息不会被解码抹掉', async (t) => {
  const f = await fixture(
    t,
    { 'bom.txt': '\ufeffhello\r\n', 'eol.txt': 'a\r\nb\r\n', 'end.txt': 'a', 'space.txt': ' a ' },
    { 'bom.txt': 'hello\r\n', 'eol.txt': 'a\nb\n', 'end.txt': 'a\n', 'space.txt': 'a' }
  )
  const id = await f.run()
  assert.equal(f.manager.snapshot(1).state.different, 4)
  const bom = await f.manager.read(1, id, 'bom.txt', 'bom')
  assert.equal(bom.local.bom, true)
  assert.equal(bom.remote.bom, false)
  assert.equal(bom.local.content, bom.remote.content)
  const eol = await f.manager.read(1, id, 'eol.txt', 'eol')
  assert.equal(eol.local.eol, 'CRLF')
  assert.equal(eol.remote.eol, 'LF')
  const end = await f.manager.read(1, id, 'end.txt', 'end')
  assert.equal(end.local.finalNewline, false)
  assert.equal(end.remote.finalNewline, true)
})

test('打开时重读；变为相同或消失会从差异列表移除；窗口和 key 均受会话约束', async (t) => {
  const f = await fixture(t, { 'a.txt': 'old', 'b.txt': 'old' }, { 'a.txt': 'new', 'b.txt': 'new' })
  const id = await f.run()
  assert.throws(() => f.manager.entries(2, id, 0), /不属于/)
  assert.throws(() => f.manager.read(1, id, '../outside.txt', 'bad'), /不属于/)
  assert.throws(() => f.manager.entries(1, id, -1), /分页/)
  await fs.writeFile(path.join(f.root, 'a.txt'), 'changed')
  const different = await f.manager.read(1, id, 'a.txt', 'changed')
  assert.equal(different.changed, true)
  assert.equal(different.local.content, 'changed')
  f.objects.set('a.txt', Buffer.from('changed'))
  assert.equal((await f.manager.read(1, id, 'a.txt', 'same')).kind, 'identical')
  await fs.unlink(path.join(f.root, 'b.txt'))
  assert.equal((await f.manager.read(1, id, 'b.txt', 'deleted')).kind, 'unavailable')
  assert.equal(f.manager.entries(1, id, 0).total, 0)
  assert.equal(f.manager.issues(1, id, 0).total, 1)
})

test('本地扫描后变化、云端 HEAD/GET 版本变化均不能被当作正常比较', async (t) => {
  const f = await fixture(t, { 'a.txt': 'old' }, { 'a.txt': 'new' })
  const root = { path: f.root, stat: await fs.lstat(f.root, { bigint: true }) }
  const expected = await f.files.locateDiffFile(root, 'a.txt')
  await fs.writeFile(path.join(f.root, 'a.txt'), 'changed')
  await assert.rejects(
    f.files.readDiffPair(root, f.client, 'a.txt', new AbortController().signal, expected),
    /扫描后发生变化/
  )
  const original = f.client.getStream
  f.client.getStream = async (...args) => {
    const result = await original.apply(f.client, args)
    result.res.headers.etag = 'changed-after-head'
    return result
  }
  const id = await f.run()
  assert.match(f.manager.issues(1, id, 0).items[0].message, /云端文件在读取期间发生变化/)
})

test('云端实际读取超出 2 MB 时记录未比较', async (t) => {
  const f = await fixture(t, { 'a.txt': 'a' }, { 'a.txt': 'b' })
  f.client.getStream = async (key) => ({
    stream: Readable.from([Buffer.alloc(limit + 1, 'c')]),
    res: { headers: (await f.client.head(key)).res.headers }
  })
  const id = await f.run()
  assert.match(f.manager.issues(1, id, 0).items[0].message, /2 MB/)
  assert.equal(f.manager.snapshot(1).state.different, 0)
})

test('本地读取期间被修改时丢弃本次内容，文件句柄正确关闭', async (t) => {
  let modified = false,
    closed = false
  const f = await fixture(
    t,
    { 'a.txt': 'original' },
    { 'a.txt': 'cloud' },
    {
      'fs/promises': {
        ...fs,
        open: async (...args) => {
          const handle = await fs.open(...args)
          const nativeRead = handle.read.bind(handle)
          const nativeClose = handle.close.bind(handle)
          handle.read = async (...readArgs) => {
            const result = await nativeRead(...readArgs)
            if (!modified) {
              modified = true
              await fs.writeFile(args[0], 'externally changed')
            }
            return result
          }
          handle.close = async () => {
            closed = true
            await nativeClose()
          }
          return handle
        }
      }
    }
  )
  const id = await f.run()
  assert.equal(f.manager.snapshot(1).state.different, 0)
  assert.match(f.manager.issues(1, id, 0).items[0].message, /本地文件在读取期间发生变化/)
  assert.equal(closed, true)
})

test('重复重新读取在不同、相同和不可读之间转换时计数准确', async (t) => {
  const f = await fixture(t, { 'a.txt': 'local' }, { 'a.txt': 'cloud' })
  const id = await f.run()
  f.objects.set('a.txt', Buffer.from('local'))
  await f.manager.read(1, id, 'a.txt', 'same1')
  await f.manager.read(1, id, 'a.txt', 'same2')
  assert.equal(f.manager.snapshot(1).state.unchanged, 1)
  f.objects.set('a.txt', Buffer.from('different'))
  await f.manager.read(1, id, 'a.txt', 'different')
  assert.equal(f.manager.snapshot(1).state.unchanged, 0)
  assert.equal(f.manager.snapshot(1).state.different, 1)
  f.objects.delete('a.txt')
  await f.manager.read(1, id, 'a.txt', 'missing')
  assert.equal(f.manager.snapshot(1).state.phase, 'partial')
  f.objects.set('a.txt', Buffer.from('local'))
  await f.manager.read(1, id, 'a.txt', 'repaired')
  assert.equal(f.manager.snapshot(1).state.phase, 'success')
  assert.equal(f.manager.snapshot(1).state.uncompared, 0)
  assert.equal(f.manager.snapshot(1).state.unchanged, 1)
})

test('单文件权限失败继续其他文件，并保留 OSS requestId', async (t) => {
  const f = await fixture(
    t,
    { 'a.txt': 'local', 'b.txt': 'local' },
    { 'a.txt': 'cloud', 'b.txt': 'cloud' }
  )
  const head = f.client.head
  f.client.head = async (key) => {
    if (key === 'a.txt')
      throw Object.assign(new Error('AccessDenied'), { status: 403, requestId: 'fixture-request' })
    return head(key)
  }
  const id = await f.run()
  assert.equal(f.manager.entries(1, id, 0).items[0].key, 'b.txt')
  assert.equal(f.manager.issues(1, id, 0).items[0].requestId, 'fixture-request')
})

test('只读路径解析拒绝符号链接、越界、临时目录和云端文件目录冲突', async (t) => {
  const reserved = '.oss-client-sync-11111111-1111-1111-1111-111111111111/a.txt'
  const f = await fixture(
    t,
    { 'a.txt': 'old', 'node.txt': 'old' },
    {
      'a.txt': 'new',
      'link.txt': 'x',
      '../outside.txt': 'x',
      [reserved]: 'x',
      'node.txt': 'new',
      'node.txt/sub.txt': 'x'
    }
  )
  await fs.symlink(path.join(f.root, 'a.txt'), path.join(f.root, 'link.txt'))
  const id = await f.run()
  assert.equal(f.manager.entries(1, id, 0).total, 1)
  const problems = f.manager.issues(1, id, 0).items
  assert.equal(problems.length, 5)
  assert.match(problems.find((p) => p.key === 'link.txt').message, /符号链接/)
  assert.match(problems.find((p) => p.key === 'node.txt').message, /同名冲突/)
})

test('Unicode 或大小写别名不会让两个云端 key 接管同一本地文件', async (t) => {
  const f = await fixture(t, { 'é.txt': 'old' }, { 'é.txt': 'new', 'e\u0301.txt': 'other' })
  const alias = await fs.lstat(path.join(f.root, 'e\u0301.txt')).catch(() => null)
  const id = await f.run()
  if (alias) {
    assert.equal(f.manager.entries(1, id, 0).total, 0)
    assert.equal(f.manager.issues(1, id, 0).total, 2)
    assert.ok(
      f.manager.issues(1, id, 0).items.every((item) => item.message.includes('多个云端路径'))
    )
  } else assert.equal(f.manager.entries(1, id, 0).total, 1)
})

test('大小写碰撞跳过双方，不同名称的硬链接仍按各自路径比较', async (t) => {
  const f = await fixture(
    t,
    { 'a.txt': 'local', 'hard-one.txt': 'same inode' },
    {
      'a.txt': 'cloud',
      'A.txt': 'other',
      'hard-one.txt': 'one',
      'hard-two.txt': 'two'
    }
  )
  await fs.link(path.join(f.root, 'hard-one.txt'), path.join(f.root, 'hard-two.txt'))
  const caseAlias = await fs.lstat(path.join(f.root, 'A.txt')).catch(() => null)
  const id = await f.run()
  const keys = Array.from(f.manager.entries(1, id, 0).items, (item) => item.key)
  assert.ok(keys.includes('hard-one.txt') && keys.includes('hard-two.txt'))
  if (caseAlias) {
    assert.equal(keys.includes('a.txt'), false)
    assert.equal(f.manager.issues(1, id, 0).total, 2)
  } else assert.ok(keys.includes('a.txt'))
})

test('并发最多三个文件对；扫描、读取、同步、保存互斥，取消等待在途任务', async (t) => {
  const local = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`${i}.txt`, 'old']))
  const remote = Object.fromEntries(Object.keys(local).map((key) => [key, 'new']))
  const f = await fixture(t, local, remote)
  const gate = deferred(),
    original = f.client.getStream
  let active = 0,
    peak = 0
  f.client.getStream = async (...args) => {
    active++
    peak = Math.max(peak, active)
    await gate.promise
    active--
    return original.apply(f.client, args)
  }
  const id = f.manager.start(1, f.connection)
  await until(() => peak === 3)
  assert.equal(f.manager.snapshot(2).busy, true)
  assert.equal(f.manager.snapshot(2).state, null)
  assert.throws(() => f.manager.start(2, f.connection), /Diff/)
  assert.throws(() => f.ops.reserveSync(), /Diff/)
  await assert.rejects(
    f.ops.withTextWrite(async () => {}),
    /Diff/
  )
  f.manager.cancel(1, id)
  assert.equal(f.manager.snapshot(1).state.phase, 'cancelling')
  assert.equal(f.ops.isDiffBusy(), true)
  gate.resolve()
  await f.manager.wait(1, id)
  assert.equal(f.manager.snapshot(1).state.phase, 'cancelled')
  assert.equal(f.ops.isDiffBusy(), false)
  assert.equal(peak, 3)
  await f.run()
  assert.equal(f.manager.snapshot(1).state.different, 8)
  const releaseSync = f.ops.reserveSync()
  assert.throws(() => f.manager.start(1, f.connection), /同步/)
  releaseSync()
  const saving = deferred()
  const write = f.ops.withTextWrite(() => saving.promise)
  assert.throws(() => f.manager.start(1, f.connection), /保存/)
  saving.resolve()
  await write
})

test('取消单文件读取和关闭会话不会发布旧结果，也不会提前释放读取占用', async (t) => {
  const f = await fixture(t, { 'a.txt': 'old' }, { 'a.txt': 'new' })
  const id = await f.run(),
    gate = deferred(),
    entered = deferred()
  const original = f.client.head
  f.client.head = async (...args) => {
    entered.resolve()
    await gate.promise
    return original.apply(f.client, args)
  }
  const read = f.manager.read(1, id, 'a.txt', 'request')
  const rejected = assert.rejects(read, /取消/)
  await entered.promise
  const closed = f.manager.close(1, id)
  assert.equal(f.manager.snapshot(1).state, null)
  assert.equal(f.ops.isDiffBusy(), true)
  gate.resolve()
  await closed
  await rejected
  assert.equal(f.ops.isDiffBusy(), false)
})

test('列表和详情每页 100 条；内容写入通知只使对应 Bucket 的结果过期', async (t) => {
  const local = Object.fromEntries(
    Array.from({ length: 103 }, (_, i) => [`${String(i).padStart(3, '0')}.txt`, 'old'])
  )
  const f = await fixture(
    t,
    local,
    Object.fromEntries(Object.keys(local).map((key) => [key, 'new']))
  )
  const id = await f.run()
  assert.equal(f.manager.entries(1, id, 0).items.length, 100)
  assert.equal(f.manager.entries(1, id, 100).items.length, 3)
  f.ops.notifyContentChanged('other')
  assert.equal(f.manager.snapshot(1).state.stale, false)
  f.ops.notifyContentChanged('fixture')
  assert.equal(f.manager.snapshot(1).state.stale, true)
})

test('本地根目录缺失和云端分页失败终止扫描，不创建根目录或声称一致', async (t) => {
  const f = await fixture(t)
  f.connection.localDir = path.join(f.root, 'missing')
  await f.run()
  assert.equal(f.manager.snapshot(1).state.phase, 'failed')
  assert.equal(await fs.lstat(f.connection.localDir).catch(() => null), null)
  f.connection.localDir = f.root
  f.client.listV2 = async () => ({ objects: [], isTruncated: true })
  await f.run()
  assert.equal(f.manager.snapshot(1).state.phase, 'failed')
  assert.match(f.manager.snapshot(1).state.message, /分页游标/)
})

test('真实 ali-oss SDK 经本机 HTTP 执行分页、HEAD、条件 GET；无写请求', async (t) => {
  const f = await fixture(t, { 'a.txt': 'local' }, { 'a.txt': 'cloud' })
  const requests = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    requests.push({
      method: req.method,
      url,
      match: req.headers['if-match'],
      range: req.headers.range
    })
    if (url.searchParams.get('list-type') === '2') {
      res.writeHead(200, { 'content-type': 'application/xml', 'x-oss-request-id': 'local-diff' })
      res.end(
        '<ListBucketResult><Name>fixture</Name><IsTruncated>false</IsTruncated><Contents><Key>a.txt</Key><Size>5</Size><ETag>v1</ETag><Type>Normal</Type></Contents></ListBucketResult>'
      )
    } else {
      res.writeHead(200, {
        etag: '"v1"',
        'content-length': 5,
        'last-modified': 'Wed, 01 Jan 2020 00:00:00 GMT',
        'x-oss-request-id': 'local-diff'
      })
      res.end(req.method === 'HEAD' ? undefined : 'cloud')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      })
  )
  f.connection.client = new OSS({
    accessKeyId: 'fixture',
    accessKeySecret: 'fixture',
    bucket: 'fixture',
    endpoint: `http://127.0.0.1:${server.address().port}`,
    cname: true,
    secure: false
  })
  const id = await f.run()
  assert.equal(
    f.manager.snapshot(1).state.phase,
    'success',
    JSON.stringify(f.manager.issues(1, id, 0))
  )
  assert.equal(f.manager.entries(1, id, 0).total, 1)
  const get = requests.find((r) => r.method === 'GET' && r.url.pathname === '/a.txt')
  assert.equal(get.match, '"v1"')
  assert.equal(get.range, `bytes=0-${limit}`)
  assert.ok(requests.every((r) => r.method === 'HEAD' || r.method === 'GET'))
})

test('共享目录索引减少真实目录枚举，扫描读取仍保持根目录身份校验', async (t) => {
  const count = 256
  const local = Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`${String(i).padStart(4, '0')}.txt`, 'local'])
  )
  let reads = 0,
    rootStats = 0,
    rootPath
  const f = await fixture(
    t,
    local,
    Object.fromEntries(Object.keys(local).map((key) => [key, 'cloud'])),
    {
      'fs/promises': {
        ...fs,
        readdir: async (...args) => {
          reads++
          return fs.readdir(...args)
        },
        lstat: async (...args) => {
          if (args[0] === rootPath) rootStats++
          return fs.lstat(...args)
        }
      }
    }
  )
  rootPath = f.root
  const root = { path: f.root, stat: await fs.lstat(f.root, { bigint: true }) }
  for (const key of Object.keys(local)) await f.files.locateDiffFile(root, key)
  const independentReads = reads
  assert.equal(independentReads, count)
  reads = 0
  const index = new f.files.DiffDirectoryIndex()
  for (const key of Object.keys(local)) await f.files.locateDiffFile(root, key, undefined, index)
  assert.equal(reads, 1)
  reads = 0
  rootStats = 0
  const id = await f.run()
  assert.equal(f.manager.entries(1, id, 0).total, count)
  assert.equal(reads, 1, '配对与三个读取 worker 应共享同一目录名称索引')
  assert.ok(rootStats >= count * 4, '根目录检查不能被名称缓存替代')
  console.info(
    `Diff 目录计数：${count} 文件，独立解析 readdir=${independentReads}，共享扫描 readdir=${reads}，根目录校验=${rootStats}`
  )
  reads = 0
  await f.run()
  assert.equal(reads, 1, '新扫描必须重新建立索引')
})

test('目录索引在新增、删除、重命名及目录替换后失效，仍拒绝符号链接', async (t) => {
  const f = await fixture(t, { 'dir/a.txt': 'a' }, { 'dir/a.txt': 'cloud' })
  const root = { path: f.root, stat: await fs.lstat(f.root, { bigint: true }) }
  const index = new f.files.DiffDirectoryIndex()
  const locate = (key) => f.files.locateDiffFile(root, key, undefined, index)
  const original = await locate('dir/a.txt')
  await fs.writeFile(path.join(f.root, 'dir/b.txt'), 'b')
  assert.ok(await locate('dir/b.txt'))
  await fs.rename(path.join(f.root, 'dir/b.txt'), path.join(f.root, 'dir/c.txt'))
  assert.equal(await locate('dir/b.txt'), null)
  assert.ok(await locate('dir/c.txt'))
  await fs.unlink(path.join(f.root, 'dir/c.txt'))
  assert.equal(await locate('dir/c.txt'), null)
  await fs.rename(path.join(f.root, 'dir'), path.join(f.root, 'original-dir'))
  await fs.mkdir(path.join(f.root, 'dir'))
  await fs.writeFile(path.join(f.root, 'dir/a.txt'), 'new')
  await assert.rejects(
    f.files.readDiffPair(
      root,
      f.client,
      'dir/a.txt',
      new AbortController().signal,
      original,
      index
    ),
    /扫描后发生变化/
  )
  await fs.rm(path.join(f.root, 'dir'), { recursive: true })
  await fs.symlink(path.join(f.root, 'original-dir'), path.join(f.root, 'dir'))
  await assert.rejects(locate('dir/a.txt'), /符号链接/)
})

test('缓存存在时根目录替换仍报错；目录枚举期间变化不能形成可用索引', async (t) => {
  let mutateDuringList = false
  const f = await fixture(
    t,
    { 'a.txt': 'a' },
    {},
    {
      'fs/promises': {
        ...fs,
        readdir: async (...args) => {
          const names = await fs.readdir(...args)
          if (mutateDuringList) {
            mutateDuringList = false
            await fs.writeFile(path.join(args[0], 'inserted.txt'), 'changed')
          }
          return names
        }
      }
    }
  )
  const root = { path: f.root, stat: await fs.lstat(f.root, { bigint: true }) }
  const index = new f.files.DiffDirectoryIndex()
  mutateDuringList = true
  await assert.rejects(
    f.files.locateDiffFile(root, 'a.txt', undefined, index),
    /目录在读取名称期间发生变化/
  )
  assert.ok(await f.files.locateDiffFile(root, 'inserted.txt', undefined, index))
  const moved = f.root + '-original'
  t.after(() => fs.rm(moved, { recursive: true, force: true }))
  await fs.rename(f.root, moved)
  await fs.mkdir(f.root)
  await fs.writeFile(path.join(f.root, 'a.txt'), 'replacement')
  await assert.rejects(f.files.locateDiffFile(root, 'a.txt', undefined, index), /根目录已变化/)
})

test('目录缓存淘汰和清空后会重读，超大目录可独占缓存而不重复枚举', async (t) => {
  let reads = 0
  const f = await fixture(
    t,
    { 'large/a.txt': 'a', 'large/b.txt': 'b', 'small/c.txt': 'c' },
    {},
    {
      'fs/promises': {
        ...fs,
        readdir: async (...args) => {
          reads++
          return fs.readdir(...args)
        }
      }
    }
  )
  const index = new f.files.DiffDirectoryIndex(2, 1)
  const lookup = async (dir, name) => {
    const folder = path.join(f.root, dir)
    return index.lookup(folder, await fs.lstat(folder, { bigint: true }), name)
  }
  assert.equal((await lookup('large', 'a.txt')).actual, 'a.txt')
  assert.equal((await lookup('large', 'b.txt')).actual, 'b.txt')
  assert.equal(reads, 1)
  await lookup('small', 'c.txt')
  await lookup('large', 'a.txt')
  assert.equal(reads, 3)
  index.clear()
  await lookup('large', 'a.txt')
  assert.equal(reads, 4)
})

test('并发乱序完成的分页仍排序，重读后排序缓存反映最新元信息和条目恢复', async (t) => {
  const f = await fixture(
    t,
    { 'a.txt': 'local', 'b.txt': 'local', 'c.txt': 'local' },
    { 'a.txt': 'cloud', 'b.txt': 'cloud', 'c.txt': 'cloud' }
  )
  const gate = deferred(),
    original = f.client.getStream
  f.client.getStream = async (key, ...rest) => {
    if (key === 'a.txt') await gate.promise
    return original.call(f.client, key, ...rest)
  }
  const id = f.manager.start(1, f.connection)
  await until(() => f.manager.snapshot(1).state.different === 2)
  assert.deepEqual(
    Array.from(f.manager.entries(1, id, 0).items, (value) => value.key),
    ['b.txt', 'c.txt']
  )
  gate.resolve()
  await f.manager.wait(1, id)
  assert.deepEqual(
    Array.from(f.manager.entries(1, id, 0).items, (value) => value.key),
    ['a.txt', 'b.txt', 'c.txt']
  )
  await fs.writeFile(path.join(f.root, 'a.txt'), 'new local value')
  await f.manager.read(1, id, 'a.txt', 'changed')
  assert.equal(f.manager.entries(1, id, 0).items[0].local.size, 15)
  f.objects.set('a.txt', Buffer.from('new local value'))
  await f.manager.read(1, id, 'a.txt', 'equal')
  assert.equal(f.manager.entries(1, id, 0).items[0].key, 'b.txt')
  f.objects.set('a.txt', Buffer.from('different again'))
  await f.manager.read(1, id, 'a.txt', 'restored')
  assert.equal(f.manager.entries(1, id, 0).items[0].key, 'a.txt')
})
