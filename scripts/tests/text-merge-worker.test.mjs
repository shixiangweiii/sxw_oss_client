import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import { sourceLoader, deferred, tick } from './source-loader.mjs'

test('真实 Worker 在预算内合并空文件和万行追加，主线程保持响应', { timeout: 20000 }, async () => {
  const { mergeText } = sourceLoader()('src/main/textMerge.ts')
  const base = Array.from({ length: 20000 }, (_, i) => `共同 ${i}\n`).join('')
  const extra = Array.from({ length: 10000 }, (_, i) => `追加 ${i}\n`).join('')
  for (const [name, local, remote] of [
    ['空文件 vs 万行', '', extra],
    ['两万行后追加万行', base, base + extra]
  ]) {
    let beats = 0
    const timer = setInterval(() => beats++, 10)
    const start = performance.now()
    try {
      const result = await mergeText(
        Buffer.from(local),
        Buffer.from(remote),
        new AbortController().signal
      )
      const elapsed = performance.now() - start
      assert.ok(elapsed < 5000, `${name}: ${elapsed} ms`)
      assert.ok(beats > 0, '线程计算不能阻塞主进程计时器')
      assert.equal(result.blocks, 1)
      assert.ok(result.bytes.toString().includes(extra))
      if (local) assert.ok(result.bytes.toString().startsWith(local))
      console.log(`Worker 规模验证：${name}，${Math.round(elapsed)} ms，主线程响应 ${beats} 次`)
    } finally {
      clearInterval(timer)
    }
  }
})

test('真实 Worker 取消高编辑距离计算，迟到结果不返回成功', { timeout: 7000 }, async () => {
  const { mergeText } = sourceLoader()('src/main/textMerge.ts')
  const controller = new AbortController()
  const a = Array.from({ length: 20000 }, (_, i) => `local-${i}\n`).join('')
  const b = Array.from({ length: 20000 }, (_, i) => `cloud-${i}\n`).join('')
  const pending = mergeText(Buffer.from(a), Buffer.from(b), controller.signal)
  const timer = setTimeout(() => controller.abort(), 200)
  try {
    await assert.rejects(pending, /取消/)
  } finally {
    clearTimeout(timer)
  }
})

for (const action of ['timeout', 'error', 'exit']) {
  test(`Worker ${action} 等待终止完成，随后拒绝结果并移除监听`, async () => {
    const stop = deferred(),
      terminationStarted = deferred()
    const workers = []
    class HeldWorker extends EventEmitter {
      constructor() {
        super()
        workers.push(this)
      }
      terminate() {
        terminationStarted.resolve()
        return stop.promise.then(() => {
          this.emit('exit', 1)
          return 1
        })
      }
    }
    const { mergeText } = sourceLoader({ worker_threads: { Worker: HeldWorker } })(
      'src/main/textMerge.ts'
    )
    let settled = false
    const pending = mergeText(
      Buffer.from('a'),
      Buffer.from('b'),
      new AbortController().signal,
      action === 'timeout' ? 5 : 5000
    )
    const worker = workers[0]
    pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    if (action === 'error') worker.emit('error', new Error('fixture worker failure'))
    if (action === 'exit') worker.emit('exit', 2)
    await terminationStarted.promise
    await tick()
    assert.equal(settled, false)
    worker.emit('message', { ok: true, value: { bytes: Buffer.from('late'), blocks: 1 } })
    stop.resolve()
    await assert.rejects(
      pending,
      action === 'timeout' ? /预算/ : action === 'error' ? /fixture worker/ : /提前退出/
    )
    assert.equal(worker.eventNames().length, 0)
  })
}

test('Worker 创建失败明确拒绝，不遗留计算或定时器', async () => {
  const { mergeText } = sourceLoader({
    worker_threads: {
      Worker: class {
        constructor() {
          throw new Error('fixture spawn failure')
        }
      }
    }
  })('src/main/textMerge.ts')
  await assert.rejects(
    mergeText(Buffer.from('a'), Buffer.from('b'), new AbortController().signal),
    /spawn failure/
  )
})
