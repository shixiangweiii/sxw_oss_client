import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { sourceLoader, tick, deferred } from './source-loader.mjs'

const api = sourceLoader()('src/main/textMerge.ts')
const limit = 5 * 1024 * 1024
const merge = (a, b) => api.mergeText(Buffer.from(a), Buffer.from(b), new AbortController().signal)

test('两路合并保留共同片段和重复行，双方及单侧片段均带来源标记', async () => {
  const result = await merge('开头\n重复\n重复\n本地\n结尾\n', '开头\n重复\n重复\n云端\n结尾\n')
  const text = result.bytes.toString()
  assert.ok(text.startsWith('开头\n重复\n重复\n'))
  assert.ok(text.endsWith('结尾\n'))
  assert.match(
    text,
    /<<<<<<< OSS-CLIENT 本地\n本地\n======= OSS-CLIENT\n云端\n>>>>>>> OSS-CLIENT 云端/
  )
  assert.equal(result.blocks, 1)
  const single = await merge('A\n新增\nZ\n', 'A\nZ\n')
  assert.match(single.bytes.toString(), /新增\n======= OSS-CLIENT\n>>>>>>>/)
  const empty = await merge('', '云端')
  assert.match(empty.bytes.toString(), /文件末尾无换行/)
  assert.match(empty.bytes.toString(), /云端\n>>>>>>>/)
})

test('采用本地 BOM 与首个换行，纯格式不写入，空白和末尾换行仍区分', async () => {
  assert.equal(await merge('\uFEFFA\r\n', 'A\n'), null)
  assert.equal(await merge('相同', '相同'), null)
  const text = (await merge('\uFEFFA\r\nL\r\n', 'A\nR\n')).bytes.toString()
  assert.ok(text.startsWith('\uFEFFA\r\n'))
  assert.ok(!text.replaceAll('\r\n', '').includes('\n'))
  assert.match((await merge('x', 'x\n')).bytes.toString(), /文件末尾无换行/)
  assert.equal((await merge('a \n\n', 'a\n')).blocks > 0, true)
})

test('拒绝无效 UTF-8、NUL 和专用残留标记，普通 Git 标记仍允许', async () => {
  assert.throws(() => api.decodeMergeText(Buffer.from([0xff])), /UTF-8/)
  assert.throws(() => api.decodeMergeText(Buffer.from('a\0b')), /NUL/)
  for (const marker of api.MERGE_MARKERS) {
    assert.equal(api.hasMergeMarkers('\uFEFF' + marker + '\r'), true)
    await assert.rejects(merge(marker, 'other'), /先整理/)
  }
  assert.equal(api.hasMergeMarkers('<<<<<<< HEAD\n=======\n>>>>>>> branch'), false)
  assert.equal(api.hasMergeMarkers('正文 <<<<<<< OSS-CLIENT 本地'), false)
})

test('输入及输出恰好 5 MB 可处理，多一个字节拒绝且不截断', async () => {
  const bytes = Buffer.alloc(limit, 97)
  assert.equal(await merge(bytes, bytes), null)
  await assert.rejects(merge(Buffer.alloc(limit + 1), ''), /5 MB/)
  const base = await merge('L\n', 'R\n')
  const prefix = 'a'.repeat(limit - base.bytes.length - 1) + '\n'
  assert.equal((await merge(prefix + 'L\n', prefix + 'R\n')).bytes.length, limit)
  await assert.rejects(merge('a' + prefix + 'L\n', 'a' + prefix + 'R\n'), /结果超过/)
  assert.throws(() => api.decodeMergeText(Buffer.from('中'.repeat(Math.ceil(limit / 3)))), /5 MB/)
})

test('计算预算耗尽不产生结果；取消等待线程退出后拒绝迟到结果', async () => {
  await assert.rejects(
    api.mergeText(Buffer.from('a\nb\n'), Buffer.from('x\ny\n'), new AbortController().signal, -1),
    /预算/
  )
  const exited = deferred()
  const workers = []
  class HeldWorker extends EventEmitter {
    constructor() {
      super()
      workers.push(this)
    }
    terminate() {
      return exited.promise.then(() => {
        this.emit('exit', 1)
        return 1
      })
    }
  }
  const fake = sourceLoader({
    worker_threads: { Worker: HeldWorker }
  })('src/main/textMerge.ts')
  const controller = new AbortController()
  let settled = false
  const pending = fake.mergeText(Buffer.from('a'), Buffer.from('b'), controller.signal)
  const worker = workers[0]
  pending.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  controller.abort()
  await tick()
  assert.equal(settled, false)
  worker.emit('message', { ok: true, value: { bytes: Buffer.from('late'), blocks: 1 } })
  exited.resolve()
  await assert.rejects(pending, /取消/)
  assert.equal(worker.eventNames().length, 0)
})

test('上传标记流式检查覆盖 BOM、CR、跨块中文和超过 5 MB 的文件', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oss-marker-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'text')
  for (const text of [
    '\uFEFF' + api.MERGE_MARKERS[0],
    'x'.repeat(65530) + '\r' + api.MERGE_MARKERS[2],
    'x'.repeat(limit + 1) + '\n' + api.MERGE_MARKERS[1]
  ]) {
    await fs.writeFile(file, text)
    assert.equal(await api.fileHasMergeMarkers(file, new AbortController().signal), true)
  }
  await fs.writeFile(file, 'x'.repeat(limit + 1) + '\n<<<<<<< HEAD')
  assert.equal(await api.fileHasMergeMarkers(file, new AbortController().signal), false)
})

test('Buffer 标记扫描在每个字节分界及单字节分块保持整行语义', () => {
  const { MergeMarkerScanner } = sourceLoader()('src/main/textMergeFormat.ts')
  const cases = []
  for (const marker of api.MERGE_MARKERS) {
    for (const prefix of ['', '\uFEFF', 'x'.repeat(180) + '\r', '正文\r\n\uFEFF'])
      for (const suffix of ['', '\r', '\n后续', '（文件末尾无换行）\n'])
        cases.push([prefix + marker + suffix, true])
    for (const text of [
      'a' + marker,
      ' ' + marker,
      marker + 'x',
      marker + '(',
      'x'.repeat(180) + marker + '\n'
    ])
      if (text !== marker) cases.push([text, false])
  }
  for (const [text, expected] of cases) {
    const bytes = Buffer.from(text)
    for (let split = 0; split <= bytes.length; split++) {
      const scanner = new MergeMarkerScanner()
      scanner.push(bytes.subarray(0, split))
      scanner.push(bytes.subarray(split))
      assert.equal(scanner.finish(), expected, `${JSON.stringify(text)} / split=${split}`)
    }
    const scanner = new MergeMarkerScanner()
    for (const byte of bytes) scanner.push(Buffer.from([byte]))
    assert.equal(scanner.finish(), expected, JSON.stringify(text))
  }
})
