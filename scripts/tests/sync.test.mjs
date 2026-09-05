import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import OSS from 'ali-oss'
import { createServer } from 'node:http'
import { Readable, Writable } from 'node:stream'
import { sourceLoader, deferred, tick } from './source-loader.mjs'

const approve = async () => 'overwrite'
const modified = 'Wed, 01 Jan 2020 00:00:00 GMT'
const hash = (data) => createHash('sha256').update(data).digest('hex')
class Cloud {
  constructor(objects = {}) {
    this.objects = new Map(Object.entries(objects).map(([k, v]) => [k, Buffer.from(v)]))
    this.modified = new Map()
    this.puts = []
    this.gets = []
    this.pages = []
    this.aborts = []
  }
  info(key) {
    const data = this.objects.get(key)
    if (!data) throw Object.assign(new Error('不存在'), { status: 404 })
    return {
      etag: '"multipart-' + hash(data) + '"',
      'content-length': String(data.length),
      'last-modified': this.modified.has(key) ? this.modified.get(key) : modified
    }
  }
  async listV2(query, options) {
    assert.equal(query.delimiter, undefined)
    assert.equal(options.timeout, 120000)
    this.pages.push(query)
    const offset = Number(query['continuation-token'] ?? 0),
      all = [...this.objects.keys()].sort(),
      names = all.slice(offset, offset + 2)
    return {
      objects: names.map((name) => ({
        name,
        size: this.objects.get(name).length,
        etag: this.info(name).etag
      })),
      isTruncated: offset + 2 < all.length,
      nextContinuationToken: String(offset + 2)
    }
  }
  async head(key) {
    return { res: { headers: this.info(key) } }
  }
  async getStream(key, options) {
    this.gets.push(key)
    if (options.headers['If-Match'] !== this.info(key).etag)
      throw Object.assign(new Error('版本变化'), { status: 412 })
    return { stream: Readable.from([this.objects.get(key)]), res: { headers: this.info(key) } }
  }
  async put(key, value) {
    this.puts.push(key)
    const data = Buffer.isBuffer(value) ? value : await fsp.readFile(value)
    this.objects.set(key, data)
    return { res: { headers: this.info(key) } }
  }
  async initMultipartUpload() {
    return { uploadId: 'test-upload' }
  }
  async uploadPart(key, _id, number, file, start, end, options) {
    this.parts ??= []
    this.parts.push({ key, number, file, start, end, options })
    this.onPart?.()
    await this.multipartGate?.promise
    return { etag: `part-${number}` }
  }
  async completeMultipartUpload(key) {
    return this.put(key, this.parts[0].file)
  }
  async abortMultipartUpload(key, uploadId) {
    this.aborts.push([key, uploadId])
    if (this.abortError) throw new Error('无法清理分片')
  }
}
async function fixture(t, objects = {}, overrides = {}) {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'oss-sync-test-'))
  const root = await fsp.realpath(temp)
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const local = path.join(root, 'local'),
    userData = path.join(root, 'app')
  await fsp.mkdir(local)
  await fsp.mkdir(userData)
  const load = sourceLoader(overrides)
  const manager = new (load('src/main/sync.ts').SyncManager)(userData)
  const client = new Cloud(objects)
  const connection = { client, bucket: 'test-bucket', localDir: local }
  const write = async (key, data) => {
    await fsp.mkdir(path.dirname(path.join(local, key)), { recursive: true })
    await fsp.writeFile(path.join(local, key), data)
  }
  const read = (key) => fsp.readFile(path.join(local, key))
  const run = async (direction) => {
    manager.start(direction, connection, approve)
    await manager.wait()
    return manager.getState()
  }
  const clean = async () => {
    assert.deepEqual(
      JSON.parse(await fsp.readFile(path.join(userData, 'sync-temp-files.json'), 'utf8')),
      []
    )
    async function visit(dir) {
      for (const item of await fsp.readdir(dir, { withFileTypes: true })) {
        assert.ok(!item.name.startsWith('.oss-client-sync-'))
        if (item.isDirectory()) await visit(path.join(dir, item.name))
      }
    }
    await visit(local)
  }
  return { manager, client, root, local, userData, connection, load, write, read, run, clean }
}

for (const direction of ['download', 'upload'])
  test(`${direction} 覆盖矩阵：递归、隐藏、二进制、空目录、同 hash 跳过、不删除目标独有文件`, async (t) => {
    const f = await fixture(t, {
      same: 'same',
      changed: 'old!',
      'cloud-only': 'cloud',
      'nested/.hidden': Buffer.from([0, 255, 1]),
      'empty/': ''
    })
    await f.write('same', 'same')
    await f.write('changed', 'new!')
    await f.write('local-only', 'local')
    await f.write('local-deep/.env', 'local secret fixture')
    await fsp.mkdir(path.join(f.local, 'local-empty'))
    const before = await fsp.stat(path.join(f.local, 'same'), { bigint: true })
    const state = await f.run(direction)
    assert.equal(state.phase, 'success', JSON.stringify(f.manager.getIssues(state.taskId, 0)))
    assert.equal(state.unchanged, 1)
    assert.equal(state.overwritten, 1)
    assert.equal(state.processed, state.total)
    assert.equal(
      state.processed,
      state.created + state.overwritten + state.unchanged + state.skipped + state.failed
    )
    assert.ok(f.client.pages.length >= 3)
    if (direction === 'download') {
      assert.equal((await f.read('changed')).toString(), 'old!')
      assert.equal((await f.read('local-only')).toString(), 'local')
      assert.deepEqual(await f.read('nested/.hidden'), Buffer.from([0, 255, 1]))
      assert.ok((await fsp.stat(path.join(f.local, 'empty'))).isDirectory())
      assert.equal(
        (await fsp.stat(path.join(f.local, 'same'), { bigint: true })).mtimeNs,
        before.mtimeNs
      )
      assert.deepEqual(f.client.puts, [])
    } else {
      assert.equal(f.client.objects.get('changed').toString(), 'new!')
      assert.equal(f.client.objects.get('cloud-only').toString(), 'cloud')
      assert.ok(f.client.objects.has('local-empty/'))
      assert.ok(f.client.objects.has('local-deep/.env'))
      assert.ok(!f.client.puts.includes('same'))
    }
    await f.clean()
  })

test('下载自动创建缺失根目录，上传缺失根目录失败且不会上传', async (t) => {
  const f = await fixture(t, { x: '' })
  await fsp.rmdir(f.local)
  assert.equal((await f.run('upload')).phase, 'failed')
  assert.deepEqual(f.client.puts, [])
  assert.equal((await f.run('download')).phase, 'success')
  assert.equal((await f.read('x')).length, 0)
})

test('下载跳过越界 key、符号链接、文件/目录冲突、非空目录对象，不触碰目录外数据', async (t) => {
  const f = await fixture(t, {
    '../escape': 'x',
    '/absolute': 'x',
    a: 'x',
    'a/b': 'x',
    'link/secret': 'overwrite',
    'file-link': 'overwrite',
    'bad/': 'data',
    ok: 'yes'
  })
  const outside = path.join(f.root, 'outside')
  await fsp.mkdir(outside)
  await fsp.writeFile(path.join(outside, 'secret'), 'keep')
  await fsp.symlink(outside, path.join(f.local, 'link'))
  await fsp.symlink(path.join(outside, 'secret'), path.join(f.local, 'file-link'))
  const state = await f.run('download')
  assert.equal(state.skipped, 7)
  assert.equal(state.created, 1)
  assert.equal((await fsp.readFile(path.join(outside, 'secret'))).toString(), 'keep')
  assert.equal((await f.read('ok')).toString(), 'yes')
  assert.equal(fs.existsSync(path.join(f.root, 'escape')), false)
  await f.clean()
})

test('上传跳过本地符号链接及云端文件/目录冲突', async (t) => {
  const f = await fixture(t, { 'a/b': 'old' })
  await f.write('a', 'file')
  await fsp.symlink('/does/not/exist', path.join(f.local, '.link'))
  await f.write('ok', 'data')
  const state = await f.run('upload')
  assert.equal(state.skipped, 2)
  assert.equal(state.created, 1)
  assert.deepEqual(f.client.puts, ['ok'])
})

test('按实际卷检测大小写和 Unicode 名称冲突，不覆盖相关条目', async (t) => {
  const f = await fixture(t, { Case: 'A', case: 'B', é: 'C', 'e\u0301': 'D', ok: 'E' })
  const temps = new (f.load('src/main/syncFiles.ts').SyncTemps)(f.userData)
  await temps.recover()
  const rules = await temps.volumeRules(f.local)
  const state = await f.run('download')
  assert.equal(
    state.skipped,
    (rules.caseSensitive ? 0 : 2) + (rules.normalizationSensitive ? 0 : 2)
  )
  assert.equal((await f.read('ok')).toString(), 'E')
})

test('下载流中断保留原文件，清理临时文件并继续其他文件', async (t) => {
  const f = await fixture(t, { a: 'replace', b: 'success' })
  await f.write('a', 'original')
  const original = f.client.getStream.bind(f.client)
  f.client.getStream = async (key, options) =>
    key === 'a'
      ? {
          stream: Readable.from(
            (async function* () {
              yield Buffer.from('partial')
              throw new Error('连接中断')
            })()
          )
        }
      : original(key, options)
  const state = await f.run('download')
  assert.equal(state.phase, 'partial')
  assert.equal(state.failed, 1)
  assert.equal(state.created, 1)
  assert.equal((await f.read('a')).toString(), 'original')
  assert.equal((await f.read('b')).toString(), 'success')
  await f.clean()
})

test('磁盘写入失败不截断旧文件，结果明确失败并完成清理', async (t) => {
  const f = await fixture(
    t,
    { a: 'new bytes' },
    {
      fs: {
        ...fs,
        createWriteStream: () =>
          new Writable({
            write(_chunk, _encoding, cb) {
              cb(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
            }
          })
      }
    }
  )
  await f.write('a', 'original')
  const state = await f.run('download')
  assert.equal(state.failed, 1)
  assert.equal(state.phase, 'partial')
  assert.equal((await f.read('a')).toString(), 'original')
  await f.clean()
})

test('上传仅把 404 当作缺失，403 不得触发覆盖，其他文件继续', async (t) => {
  const f = await fixture(t)
  await f.write('a', 'a')
  await f.write('b', 'b')
  const original = f.client.head.bind(f.client)
  f.client.head = async (key) => {
    if (key === 'a')
      throw Object.assign(new Error('permission denied'), { status: 403, requestId: 'req-test' })
    return original(key)
  }
  const state = await f.run('upload')
  assert.equal(state.phase, 'partial')
  assert.equal(state.failed, 1)
  assert.deepEqual(f.client.puts, ['b'])
  assert.equal(f.manager.getIssues(state.taskId, 0).items[0].requestId, 'req-test')
})

test('上传使用快照；后续来源变化不改变本次上传，扫描后变化的下一文件报告失败', async (t) => {
  const f = await fixture(t)
  await f.write('a', 'snapshot')
  await f.write('b', 'before')
  const original = f.client.head.bind(f.client)
  f.client.head = async (key) => {
    if (key === 'a') {
      await f.write('a', 'changed after snapshot')
      await f.write('b', 'changed after scan')
    }
    return original(key)
  }
  const state = await f.run('upload')
  assert.equal(f.client.objects.get('a').toString(), 'snapshot')
  assert.equal(state.failed, 1)
  assert.equal(f.client.objects.has('b'), false)
  await f.clean()
})

test('取消流式下载会保留原文件、不处理下一文件、清理后才终态', async (t) => {
  const f = await fixture(t, { a: 'new', b: 'next' })
  await f.write('a', 'old')
  const entered = deferred()
  f.client.getStream = async () => {
    const stream = new Readable({ read() {} })
    entered.resolve()
    return { stream }
  }
  const taskId = f.manager.start('download', f.connection, approve)
  await entered.promise
  await tick()
  f.manager.cancel(taskId)
  await f.manager.wait()
  const state = f.manager.getState()
  assert.equal(state.phase, 'cancelled')
  assert.equal(state.processed, 0)
  assert.equal((await f.read('a')).toString(), 'old')
  assert.equal(fs.existsSync(path.join(f.local, 'b')), false)
  await f.clean()
})

test('取消已提交的普通上传：等待请求结束，保留已成功写入，不启动下一文件', async (t) => {
  const f = await fixture(t)
  await f.write('a', 'one')
  await f.write('b', 'two')
  const entered = deferred(),
    finish = deferred(),
    original = f.client.put.bind(f.client)
  f.client.put = async (...args) => {
    entered.resolve()
    await finish.promise
    return original(...args)
  }
  const id = f.manager.start('upload', f.connection, approve)
  await entered.promise
  f.manager.cancel(id)
  assert.equal(f.manager.getState().phase, 'cancelling')
  finish.resolve()
  await f.manager.wait()
  assert.equal(f.manager.getState().phase, 'cancelled')
  assert.equal(f.manager.getState().created, 1)
  assert.deepEqual(f.client.puts, ['a'])
  await f.clean()
})

test('64 MiB 使用分片上传；取消等待分片结束再清理，清理失败明确报告', async (t) => {
  const f = await fixture(t)
  await f.write('large.bin', '')
  await fsp.truncate(path.join(f.local, 'large.bin'), 64 * 1024 * 1024)
  const entered = deferred(),
    gate = deferred()
  f.client.multipartGate = gate
  f.client.abortError = true
  f.client.onPart = () => entered.resolve()
  const id = f.manager.start('upload', f.connection, approve)
  await entered.promise
  await tick()
  f.manager.cancel(id)
  assert.equal(f.client.parts.length, 3)
  assert.equal(f.client.parts[0].end, 16 * 1024 * 1024)
  assert.deepEqual(f.client.aborts, [])
  gate.resolve()
  await f.manager.wait()
  assert.deepEqual(f.client.aborts, [['large.bin', 'test-upload']])
  assert.equal(f.manager.getState().phase, 'cancelled')
  assert.ok(f.manager.getIssues(id, 0).items.some((i) => i.phase === 'cleanup'))
  await f.clean()
})

test('进程级同步与在线保存原子互斥，终态后释放', async (t) => {
  const f = await fixture(t),
    ops = f.load('src/main/operations.ts')
  const gate = deferred(),
    save = ops.withTextWrite(() => gate.promise)
  assert.throws(() => f.manager.start('upload', f.connection, approve), /正在保存/)
  gate.resolve()
  await save
  const listed = deferred()
  f.client.listV2 = () => listed.promise
  const id = f.manager.start('upload', f.connection, approve)
  assert.throws(() => f.manager.start('download', f.connection, approve), /同步进行中/)
  await assert.rejects(
    ops.withTextWrite(async () => {}),
    /同步进行中/
  )
  f.manager.cancel(id)
  listed.resolve({ objects: [], isTruncated: false })
  await f.manager.wait()
  await ops.withTextWrite(async () => {})
})

test('错误分页游标终止任务，不伪报扫描成功', async (t) => {
  const f = await fixture(t)
  f.client.listV2 = async () => ({ objects: [], isTruncated: true, nextContinuationToken: 'same' })
  assert.equal((await f.run('download')).phase, 'failed')
})

test('残留临时目录按归属清理，不删除名称相似的用户目录；未知内容阻止清理', async (t) => {
  const f = await fixture(t),
    { SyncTemps } = f.load('src/main/syncFiles.ts')
  const temps = new SyncTemps(f.userData)
  await temps.recover()
  const owned = await temps.create(f.local)
  await fsp.writeFile(path.join(owned, 'content'), 'partial')
  const userDir = path.join(f.local, '.oss-client-sync-user')
  await fsp.mkdir(userDir)
  await fsp.writeFile(path.join(userDir, 'keep'), 'user')
  const recovered = new SyncTemps(f.userData)
  await recovered.recover()
  assert.equal(fs.existsSync(owned), false)
  assert.equal(fs.existsSync(path.join(userDir, 'keep')), true)
  const suspect = await recovered.create(f.local)
  await fsp.writeFile(path.join(suspect, 'user-file'), 'keep')
  const problems = await new SyncTemps(f.userData).recover()
  assert.ok(problems.some((p) => p.path === suspect && /未知文件/.test(p.message)))
  assert.equal(fs.existsSync(path.join(suspect, 'user-file')), true)
})

test('分片成功按序合并，分片失败必须等其余在途请求结束才能清理', async (t) => {
  for (const fail of [false, true]) {
    const f = await fixture(t)
    await f.write('large', '')
    await fsp.truncate(path.join(f.local, 'large'), 64 * 1024 * 1024)
    let completed = false,
      settled = 0,
      calls = 0
    const gate = deferred(),
      started = deferred()
    f.client.uploadPart = async (_key, _id, number, _file, start, end) => {
      calls++
      if (calls === 3) started.resolve()
      assert.ok(end - start <= 16 * 1024 * 1024)
      if (fail && number === 1) throw new Error('分片失败')
      if (fail) await gate.promise
      settled++
      return { etag: String(number) }
    }
    f.client.completeMultipartUpload = async (_key, _id, parts) => {
      assert.deepEqual(
        Array.from(parts, (p) => p.number),
        [1, 2, 3, 4]
      )
      completed = true
    }
    f.manager.start('upload', f.connection, approve)
    if (fail) {
      await started.promise
      await tick()
      assert.deepEqual(f.client.aborts, [])
      assert.equal(f.manager.active, true)
      gate.resolve()
    }
    await f.manager.wait()
    assert.equal(completed, !fail)
    assert.equal(f.manager.getState().phase, fail ? 'partial' : 'success')
    assert.equal(settled, fail ? 2 : 4)
    assert.equal(f.client.aborts.length, fail ? 1 : 0)
    await f.clean()
  }
})

test('同步根目录的中间符号链接不得穿越创建目标', async (t) => {
  const f = await fixture(t, { x: 'file' })
  const outside = path.join(f.root, 'outside')
  await fsp.mkdir(outside)
  await fsp.symlink(outside, path.join(f.root, 'alias'))
  f.connection.localDir = path.join(f.root, 'alias', 'new-dir')
  assert.equal((await f.run('download')).phase, 'failed')
  assert.equal(fs.existsSync(path.join(outside, 'new-dir')), false)
})

test('真实 ali-oss SDK 与本机 HTTP 服务验证列表、HEAD、条件流式下载和快照上传', async (t) => {
  const f = await fixture(t)
  const slashKey = 'notes/a\\b.txt'
  const data = new Map([
    ['a.bin', Buffer.from([0, 255, 4, 5])],
    [slashKey, Buffer.from('backslash')]
  ])
  const traffic = []
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url, 'http://localhost'),
        key = decodeURIComponent(url.pathname.slice(1))
      traffic.push([req.method, key, req.headers['if-match']])
      if (url.searchParams.get('list-type') === '2') {
        const xml =
          '<ListBucketResult><Name>test-bucket</Name><IsTruncated>false</IsTruncated>' +
          [...data]
            .map(
              ([name, value]) =>
                `<Contents><Key>${name}</Key><Size>${value.length}</Size><ETag>${hash(value)}</ETag><Type>Normal</Type></Contents>`
            )
            .join('') +
          '</ListBucketResult>'
        res.writeHead(200, {
          'content-type': 'application/xml',
          'x-oss-request-id': 'local-fixture'
        })
        res.end(xml)
        return
      }
      if (req.method === 'PUT') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        data.set(key, Buffer.concat(chunks))
        res.writeHead(200, {
          etag: '"' + hash(data.get(key)) + '"',
          'x-oss-request-id': 'local-fixture'
        })
        res.end()
        return
      }
      const value = data.get(key)
      if (!value) {
        res.writeHead(404)
        res.end()
        return
      }
      const version = '"' + hash(value) + '"'
      if (req.headers['if-match'] && req.headers['if-match'] !== version) {
        res.writeHead(412)
        res.end()
        return
      }
      res.writeHead(200, {
        etag: version,
        'content-length': value.length,
        'last-modified': modified,
        'x-oss-request-id': 'local-fixture'
      })
      res.end(req.method === 'HEAD' ? undefined : value)
    })().catch((error) => {
      res.writeHead(500)
      res.end(error.message)
    })
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
    bucket: 'test-bucket',
    endpoint: `http://127.0.0.1:${server.address().port}`,
    cname: true,
    secure: false
  })
  const downloaded = await f.run('download')
  assert.equal(
    downloaded.phase,
    'success',
    JSON.stringify(f.manager.getIssues(downloaded.taskId, 0))
  )
  assert.deepEqual(await f.read('a.bin'), data.get('a.bin'))
  assert.deepEqual(await f.read(slashKey), data.get(slashKey))
  assert.ok(
    traffic.some(([method, key, condition]) => method === 'GET' && key === 'a.bin' && condition)
  )
  const putCount = () => traffic.filter(([method]) => method === 'PUT').length
  await f.run('upload')
  assert.equal(putCount(), 0)
  await f.write('a.bin', Buffer.from([1, 2, 3, 4]))
  await f.write(slashKey, 'changed-backslash')
  const uploaded = await f.run('upload')
  assert.equal(uploaded.phase, 'success', JSON.stringify(f.manager.getIssues(uploaded.taskId, 0)))
  assert.equal(putCount(), 2)
  assert.equal(data.get(slashKey).toString(), 'changed-backslash')
  assert.deepEqual(data.get('a.bin'), Buffer.from([1, 2, 3, 4]))
  await f.clean()
})

test('下载覆盖保留已有文件的读写执行位，新增文件保持私有默认权限', async (t) => {
  const f = await fixture(t, {
    'script.sh': 'new executable',
    'shared.txt': 'new data',
    unchanged: 'same',
    'new.txt': 'new'
  })
  for (const [name, mode] of [
    ['script.sh', 0o755],
    ['shared.txt', 0o640],
    ['unchanged', 0o644]
  ]) {
    await f.write(name, name === 'unchanged' ? 'same' : 'old')
    await fsp.chmod(path.join(f.local, name), mode)
  }
  const result = await f.run('download')
  assert.equal(result.phase, 'success')
  for (const [name, mode] of [
    ['script.sh', 0o755],
    ['shared.txt', 0o640],
    ['unchanged', 0o644],
    ['new.txt', 0o600 & ~process.umask()]
  ]) {
    assert.equal((await fsp.stat(path.join(f.local, name))).mode & 0o777, mode)
  }
  await f.clean()
})

test('两种同步方向均保留文件成功计数，临时清理错误单独报告', async (t) => {
  for (const direction of ['download', 'upload']) {
    let committed = false,
      failCleanup = true
    const f = await fixture(
      t,
      { file: 'cloud-old' },
      {
        'fs/promises': {
          ...fsp,
          unlink: async (file) => {
            if (committed && failCleanup && path.basename(file) === 'owner')
              throw Object.assign(new Error('清理权限不足'), { code: 'EACCES' })
            return fsp.unlink(file)
          },
          rename: async (from, to) => {
            await fsp.rename(from, to)
            if (path.basename(to) === 'file') committed = true
          }
        }
      }
    )
    await f.write('file', 'local-new')
    const put = f.client.put.bind(f.client)
    f.client.put = async (...args) => {
      const result = await put(...args)
      committed = true
      return result
    }
    const result = await f.run(direction)
    assert.equal(committed, true)
    assert.equal(result.phase, 'partial')
    assert.equal(result.overwritten, 1)
    assert.equal(result.failed, 0)
    assert.equal(result.processed, 1)
    assert.equal(
      direction === 'download'
        ? (await f.read('file')).toString()
        : f.client.objects.get('file').toString(),
      direction === 'download' ? 'cloud-old' : 'local-new'
    )
    const issues = f.manager.getIssues(result.taskId, 0).items
    assert.equal(issues.length, 1)
    assert.equal(issues[0].phase, 'cleanup')
    assert.ok(path.isAbsolute(issues[0].path))
    failCleanup = false
    await f.manager.recover()
    await f.clean()
  }
})

test('取消时已完成上传仍计入成功，清理失败不会被取消状态吞掉', async (t) => {
  let committed = false,
    failCleanup = true
  const f = await fixture(
    t,
    {},
    {
      'fs/promises': {
        ...fsp,
        unlink: async (file) => {
          if (committed && failCleanup && path.basename(file) === 'owner')
            throw new Error('cleanup failure')
          return fsp.unlink(file)
        }
      }
    }
  )
  await f.write('file', 'uploaded')
  const entered = deferred(),
    finish = deferred(),
    original = f.client.put.bind(f.client)
  f.client.put = async (...args) => {
    entered.resolve()
    await finish.promise
    const r = await original(...args)
    committed = true
    return r
  }
  const id = f.manager.start('upload', f.connection, approve)
  await entered.promise
  f.manager.cancel(id)
  finish.resolve()
  await f.manager.wait()
  const state = f.manager.getState()
  assert.equal(state.phase, 'cancelled')
  assert.equal(state.created, 1)
  assert.equal(state.failed, 0)
  assert.ok(f.manager.getIssues(id, 0).items.every((i) => i.phase === 'cleanup'))
  assert.ok(state.issueCount > 0)
  failCleanup = false
  await f.manager.recover()
  await f.clean()
})

test('上传按本地卷检测云端大小写和 Unicode 别名，不创建无法往返的重复 key', async (t) => {
  const f = await fixture(t)
  await f.write('docs/a.txt', 'local-case')
  await f.write('é.txt', 'local-unicode')
  const actualUnicode = (await fsp.readdir(f.local)).find((n) => n.endsWith('.txt'))
  const otherUnicode =
    actualUnicode === actualUnicode.normalize('NFD')
      ? actualUnicode.normalize('NFC')
      : actualUnicode.normalize('NFD')
  f.client.objects.set('Docs/a.txt', Buffer.from('cloud-case'))
  f.client.objects.set(otherUnicode, Buffer.from('cloud-unicode'))
  const temps = new (f.load('src/main/syncFiles.ts').SyncTemps)(f.userData)
  await temps.recover()
  const rules = await temps.volumeRules(f.local)
  const result = await f.run('upload')
  assert.equal(
    result.skipped,
    (rules.caseSensitive ? 0 : 1) + (rules.normalizationSensitive ? 0 : 1)
  )
  if (!rules.caseSensitive) assert.equal(f.client.objects.has('docs/a.txt'), false)
  if (!rules.normalizationSensitive) assert.equal(f.client.objects.has(actualUnicode), false)
  assert.equal(f.client.objects.get('Docs/a.txt').toString(), 'cloud-case')
  assert.equal(f.client.objects.get(otherUnicode).toString(), 'cloud-unicode')
  await f.clean()
})

test(
  'macOS/POSIX 内部反斜杠可双向无损同步，开头反斜杠和越界仍拒绝',
  { skip: process.platform === 'win32' },
  async (t) => {
    const key = 'notes/a\\b.txt'
    const f = await fixture(t, { [key]: Buffer.from([0, 255, 9]) })
    assert.equal((await f.run('download')).created, 1)
    assert.deepEqual(await f.read(key), Buffer.from([0, 255, 9]))
    await f.write(key, Buffer.from([1, 2, 3]))
    assert.equal((await f.run('upload')).overwritten, 1)
    assert.deepEqual(f.client.objects.get(key), Buffer.from([1, 2, 3]))
    const { validateKey } = f.load('src/main/syncFiles.ts')
    for (const value of ['\\bad', '../bad', '/bad', 'a/../bad', 'a\0bad'])
      assert.throws(() => validateKey(value))
    await f.clean()
  }
)

test('有效残留含未知文件不再堵塞任务，残留不会上传，人工处理后可恢复清理', async (t) => {
  const f = await fixture(t),
    { SyncTemps } = f.load('src/main/syncFiles.ts')
  const temps = new SyncTemps(f.userData)
  await temps.recover()
  const leftover = await temps.create(f.local)
  await fsp.writeFile(path.join(leftover, 'content'), 'partial secret')
  await fsp.writeFile(path.join(leftover, 'unknown'), 'user content')
  await f.write('ok', 'normal')
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await f.run('upload')
    assert.equal(state.phase, 'partial')
    assert.equal(state.failed, 0)
    assert.equal(state.skipped, 1)
    assert.ok(
      f.manager
        .getIssues(state.taskId, 0)
        .items.some((i) => i.phase === 'cleanup' && i.path === leftover)
    )
    assert.deepEqual([...f.client.objects.keys()], ['ok'])
    assert.equal((await fsp.readFile(path.join(leftover, 'unknown'))).toString(), 'user content')
  }
  await fsp.unlink(path.join(leftover, 'unknown'))
  assert.equal((await f.run('upload')).phase, 'success')
  assert.equal(fs.existsSync(leftover), false)
  await f.clean()
})

test('坏清单原样备份并恢复可用；失去清单的可疑临时目录不会被误传或删除', async (t) => {
  const f = await fixture(t)
  const orphan = path.join(f.local, '.oss-client-sync-' + randomUUID())
  await fsp.mkdir(orphan)
  await fsp.writeFile(path.join(orphan, 'content'), 'private snapshot')
  const raw = '{ damaged manifest'
  await fsp.writeFile(path.join(f.userData, 'sync-temp-files.json'), raw)
  await f.write('ok', 'yes')
  await f.write('.oss-client-sync-user/keep', 'normal hidden dir')
  await f.manager.recover() // 启动恢复告警仍须保留到任务详情。
  const result = await f.run('upload')
  assert.equal(result.phase, 'partial')
  assert.equal(result.failed, 0)
  assert.equal(result.skipped, 1)
  assert.deepEqual([...f.client.objects.keys()].sort(), ['.oss-client-sync-user/keep', 'ok'])
  const backup = (await fsp.readdir(f.userData)).find((n) =>
    n.startsWith('sync-temp-files.corrupt-')
  )
  assert.equal(await fsp.readFile(path.join(f.userData, backup), 'utf8'), raw)
  assert.ok(
    f.manager
      .getIssues(result.taskId, 0)
      .items.some(
        (i) =>
          i.path === path.join(f.userData, 'sync-temp-files.json') && i.message.includes(backup)
      )
  )
  const restarted = new (f.load('src/main/sync.ts').SyncManager)(f.userData)
  restarted.start('upload', f.connection, approve)
  await restarted.wait()
  assert.equal(restarted.getState().phase, 'success')
  assert.equal(restarted.getState().skipped, 1)
  assert.equal(await fsp.readFile(path.join(orphan, 'content'), 'utf8'), 'private snapshot')
})

test('崩溃后缺少 owner 的已登记空目录按目录身份回收，未知身份仅保留不阻塞', async (t) => {
  const f = await fixture(t),
    { SyncTemps } = f.load('src/main/syncFiles.ts')
  const temps = new SyncTemps(f.userData)
  await temps.recover()
  const empty = await temps.create(f.local)
  await fsp.unlink(path.join(empty, 'owner'))
  assert.equal((await new SyncTemps(f.userData).recover()).length, 0)
  assert.equal(fs.existsSync(empty), false)
  const otherTemps = new SyncTemps(f.userData)
  await otherTemps.recover()
  const unknown = await otherTemps.create(f.local)
  await fsp.unlink(path.join(unknown, 'owner'))
  const manifest = path.join(f.userData, 'sync-temp-files.json')
  const records = JSON.parse(await fsp.readFile(manifest, 'utf8'))
  delete records[0].dev
  delete records[0].ino
  await fsp.writeFile(manifest, JSON.stringify(records))
  await f.write('ok', 'data')
  const state = await f.run('upload')
  assert.equal(state.phase, 'partial')
  assert.equal(state.created, 1)
  assert.equal(state.skipped, 1)
  assert.ok(fs.existsSync(unknown))
})

test('真实 SDK 两页/三页及重复扫描无游标污染，后续 HEAD/GET/PUT 不携带列表参数', async (t) => {
  const f = await fixture(t)
  await f.manager.recover()
  let total = 1001
  const values = new Map(),
    requests = []
  const valueFor = (key) => values.get(key) ?? Buffer.from('x')
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url, 'http://localhost'),
        key = decodeURIComponent(url.pathname.slice(1))
      const token = url.searchParams.get('continuation-token')
      requests.push({ method: req.method, key, token, list: url.searchParams.has('list-type') })
      if (url.searchParams.has('list-type')) {
        const offset = token ? Number(token.slice(1)) : 0
        const next = offset + 1000 < total
        const objects = Array.from({ length: Math.min(1000, total - offset) }, (_v, i) => {
          const name = `k${String(offset + i).padStart(4, '0')}`,
            data = valueFor(name)
          return `<Contents><Key>${name}</Key><Size>${data.length}</Size><ETag>${hash(data)}</ETag><Type>Normal</Type></Contents>`
        }).join('')
        res.writeHead(200, { 'content-type': 'application/xml' })
        res.end(
          `<ListBucketResult><Name>test-bucket</Name><IsTruncated>${next}</IsTruncated>${next ? `<NextContinuationToken>t${offset + 1000}</NextContinuationToken>` : ''}${objects}</ListBucketResult>`
        )
        return
      }
      if (token) {
        res.writeHead(400)
        res.end()
        return
      }
      if (req.method === 'PUT') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        values.set(key, Buffer.concat(chunks))
        res.writeHead(200, { etag: '"' + hash(valueFor(key)) + '"' })
        res.end()
        return
      }
      const data = valueFor(key),
        version = '"' + hash(data) + '"'
      if (req.headers['if-match'] && req.headers['if-match'] !== version) {
        res.writeHead(412)
        res.end()
        return
      }
      res.writeHead(200, {
        etag: version,
        'content-length': data.length,
        'last-modified': modified
      })
      res.end(req.method === 'HEAD' ? undefined : data)
    })().catch((err) => {
      res.writeHead(500)
      res.end(err.message)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections()
        server.close(r)
      })
  )
  const client = new OSS({
    accessKeyId: 'fixture',
    accessKeySecret: 'fixture',
    bucket: 'test-bucket',
    endpoint: `http://127.0.0.1:${server.address().port}`,
    secure: false,
    cname: true
  })
  // 本用例直接检查各协议阶段，先建立完整的任务上下文。
  await f.run('upload')
  for (total of [1001, 2001, 1001]) {
    const start = requests.length
    const entries = await f.manager.cloudEntries(client, new AbortController().signal, false)
    assert.equal(entries.length, total)
    assert.equal(new Set(entries.map((e) => e.key)).size, total)
    assert.deepEqual(
      requests.slice(start).map((r) => r.token),
      total === 1001 ? [null, 't1000'] : [null, 't1000', 't2000']
    )
    f.manager.state.direction = 'download'
    // 文件身份来自本次操作参数，不依赖预先设置进度字段。
    f.manager.confirmOverwrite = async (request) => {
      assert.equal(request.key, entries[0].key)
      assert.equal(request.localPath, path.join(f.local, entries[0].key))
      assert.equal(f.manager.getState().currentFile, entries[0].key)
      return 'overwrite'
    }
    await f.write(entries[0].key, 'outdated')
    await f.manager.download(client, f.local, entries[0], new AbortController().signal)
    assert.deepEqual(await f.read(entries[0].key), valueFor(entries[0].key))
    f.manager.state.direction = 'upload'
    await f.write(entries[0].key, 'new value ' + total)
    await f.manager.upload(
      client,
      f.local,
      {
        ...entries[0],
        stat: await fsp.lstat(path.join(f.local, entries[0].key), { bigint: true })
      },
      new AbortController().signal
    )
    assert.equal(valueFor(entries[0].key).toString(), 'new value ' + total)
    assert.ok(
      requests
        .slice(start)
        .filter((r) => !r.list)
        .every((r) => r.token === null)
    )
  }
  assert.ok(requests.some((r) => r.method === 'PUT'))
  await f.clean()
})

// 固定时间保证判断不依赖测试机器的时钟或文件系统亚秒精度。
const localTime = Date.UTC(2024, 0, 1) / 1000
async function setLocalTime(f, key, seconds = localTime) {
  await fsp.utimes(path.join(f.local, key), seconds, seconds)
}
for (const direction of ['upload', 'download']) {
  test(`${direction} 内容与时间矩阵：同 hash 优先、较新逐个确认、同秒直接更新`, async (t) => {
    for (const [localContent, remoteContent] of [
      ['same', 'same'],
      ['new!', 'old!'],
      ['long local', 'x']
    ]) {
      for (const delta of [-10, 0, 10]) {
        const f = await fixture(t, { a: remoteContent })
        await f.write('a', localContent)
        await setLocalTime(f, 'a', localTime + 0.8)
        f.client.modified.set('a', new Date((localTime + delta) * 1000).toUTCString())
        const prompts = []
        f.manager.start(direction, f.connection, async (request) => {
          prompts.push(request)
          assert.equal(f.manager.getState().phase, 'confirming')
          assert.equal(f.manager.getState().processed, 0)
          assert.deepEqual(f.client.puts, [])
          assert.equal((await f.read('a')).toString(), localContent)
          return 'overwrite'
        })
        await f.manager.wait()
        const state = f.manager.getState()
        assert.equal(state.phase, 'success')
        const same = localContent === remoteContent
        const newer = direction === 'upload' ? delta > 0 : delta < 0
        assert.equal(prompts.length, Number(!same && newer))
        assert.equal(state.unchanged, Number(same))
        assert.equal(state.overwritten, Number(!same))
        assert.equal(
          direction === 'upload'
            ? f.client.objects.get('a').toString()
            : (await f.read('a')).toString(),
          direction === 'upload' ? localContent : remoteContent
        )
        if (prompts.length) {
          assert.equal(prompts[0].localPath, path.join(f.local, 'a'))
          assert.equal(prompts[0].direction, direction)
          assert.equal(prompts[0].bucket, 'test-bucket')
        }
        await f.clean()
      }
    }
  })

  test(`${direction} 跳过保留目标并继续下一个文件；同内容不受无效时间影响`, async (t) => {
    const f = await fixture(t, { a: 'remote a', b: 'remote b', same: 'same' })
    for (const key of ['a', 'b', 'same']) {
      await f.write(key, key === 'same' ? 'same' : `local ${key}`)
      await setLocalTime(f, key)
      f.client.modified.set(
        key,
        new Date((localTime + (direction === 'upload' ? 10 : -10)) * 1000).toUTCString()
      )
    }
    f.client.modified.set('same', 'invalid')
    const calls = []
    const before = await fsp.stat(path.join(f.local, 'a'), { bigint: true })
    f.manager.start(direction, f.connection, async ({ key }) => {
      calls.push(key)
      return key === 'a' ? 'skip' : 'overwrite'
    })
    await f.manager.wait()
    const state = f.manager.getState()
    assert.deepEqual(calls, ['a', 'b'])
    assert.equal(state.skipped, 1)
    assert.equal(state.overwritten, 1)
    assert.equal(state.unchanged, 1)
    assert.equal(state.processed, 3)
    assert.equal(state.phase, 'success')
    assert.equal((await f.read('a')).toString(), 'local a')
    assert.equal(f.client.objects.get('a').toString(), 'remote a')
    assert.equal(
      (await fsp.stat(path.join(f.local, 'a'), { bigint: true })).mtimeNs,
      before.mtimeNs
    )
    assert.match(f.manager.getIssues(state.taskId, 0).items[0].message, /用户选择跳过/)
    if (direction === 'download') assert.ok(!f.client.gets.includes('a'))
    await f.clean()
  })

  test(
    `${direction} 等待确认可取消，迟到的覆盖决定无效且不处理下一项`,
    { timeout: 5000 },
    async (t) => {
      const f = await fixture(t, { a: 'old', b: 'old' })
      await f.write('a', 'new')
      await f.write('b', 'new')
      for (const key of ['a', 'b']) {
        await setLocalTime(f, key)
        f.client.modified.set(
          key,
          new Date((localTime + (direction === 'upload' ? 10 : -10)) * 1000).toUTCString()
        )
      }
      const entered = deferred(),
        decision = deferred()
      const id = f.manager.start(direction, f.connection, () => {
        entered.resolve()
        return decision.promise
      })
      await entered.promise
      await tick()
      assert.equal(f.manager.active, true)
      assert.equal(f.manager.getState().processed, 0)
      f.manager.cancel(id)
      await f.manager.wait()
      decision.resolve('overwrite')
      await tick()
      assert.equal(f.manager.getState().phase, 'cancelled')
      assert.equal(f.manager.getState().processed, 0)
      assert.equal(f.manager.getState().skipped, 0)
      assert.deepEqual(f.client.puts, [])
      assert.equal((await f.read('a')).toString(), 'new')
      assert.equal((await f.read('b')).toString(), 'new')
      await f.clean()
    }
  )

  test(`${direction} 无效时间保留不同内容，缺失目标仍可创建`, async (t) => {
    const f = await fixture(t, { bad: 'cloud', missing: 'cloud' })
    await f.write('bad', 'local')
    f.client.modified.set('bad', undefined)
    f.client.modified.set('missing', undefined)
    if (direction === 'upload') await f.write('new', 'local')
    let calls = 0
    f.manager.start(direction, f.connection, async () => {
      calls++
      return 'overwrite'
    })
    await f.manager.wait()
    assert.equal(calls, 0)
    assert.equal(f.manager.getState().failed, 1)
    assert.equal(f.manager.getState().created, 1)
    assert.equal(f.manager.getState().phase, 'partial')
    assert.equal((await f.read('bad')).toString(), 'local')
    assert.equal(f.client.objects.get('bad').toString(), 'cloud')
    await f.clean()
  })
}

test('下载同大小比较只读取一次云端；确认期间目标变化不能覆盖', async (t) => {
  const f = await fixture(t, { a: 'old' })
  await f.write('a', 'new')
  await setLocalTime(f, 'a')
  f.manager.start('download', f.connection, async () => {
    assert.deepEqual(f.client.gets, ['a'])
    await f.write('a', 'edited during dialog')
    return 'overwrite'
  })
  await f.manager.wait()
  assert.equal(f.manager.getState().failed, 1)
  assert.equal((await f.read('a')).toString(), 'edited during dialog')
  assert.deepEqual(f.client.gets, ['a'])
  await f.clean()
})

test('确认框取消及确认异常均保留目标，取消不计为跳过', async (t) => {
  for (const answer of ['cancel', 'invalid', 'throw']) {
    const f = await fixture(t, { a: 'old' })
    await f.write('a', 'new')
    f.manager.start('download', f.connection, async () => {
      if (answer === 'throw') throw new Error('弹窗失败')
      return answer
    })
    await f.manager.wait()
    assert.equal(f.manager.getState().phase, answer === 'cancel' ? 'cancelled' : 'partial')
    assert.equal(f.manager.getState().skipped, 0)
    assert.equal((await f.read('a')).toString(), 'new')
    await f.clean()
  }
})

test('较新的云端大文件必须确认后才初始化分片；跳过不提交任何分片', async (t) => {
  for (const answer of ['skip', 'overwrite']) {
    const f = await fixture(t, { large: 'old' })
    await f.write('large', '')
    await fsp.truncate(path.join(f.local, 'large'), 64 * 1024 * 1024)
    await setLocalTime(f, 'large')
    f.client.modified.set('large', new Date((localTime + 10) * 1000).toUTCString())
    let inits = 0
    f.client.initMultipartUpload = async () => {
      inits++
      return { uploadId: 'id' }
    }
    f.manager.start('upload', f.connection, async () => {
      assert.equal(inits, 0)
      assert.equal(f.client.parts, undefined)
      return answer
    })
    await f.manager.wait()
    assert.equal(inits, answer === 'skip' ? 0 : 1)
    assert.equal(f.manager.getState()[answer === 'skip' ? 'skipped' : 'overwritten'], 1)
    await f.clean()
  }
})
