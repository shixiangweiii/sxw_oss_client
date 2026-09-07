import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader, deferred, tick } from './source-loader.mjs'

const ok = (data) => ({ ok: true, data })
function store(api = {}) {
  const load = sourceLoader({}, { window: { electronAPI: api } })
  let state
  const set = (patch) => {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  }
  state = {
    ...load('src/renderer/store/diffSlice.ts').createDiffSlice(set, () => state),
    showToast() {}
  }
  return () => state
}
const snapshot = (revision, phase = 'success', taskId = 'task') => ({
  revision,
  busy: phase === 'scanning',
  state: { taskId, phase, different: 201, uncompared: 0 }
})

test('Diff 事件先到时旧快照不能覆盖；其他窗口忙态不会获得扫描结果', () => {
  const get = store()
  get().applyDiffSnapshot(snapshot(2))
  get().applyDiffSnapshot(snapshot(1, 'scanning'))
  assert.equal(get().diffSnapshot.state.phase, 'success')
  get().applyDiffSnapshot({ revision: 3, state: null, busy: true })
  assert.equal(get().diffSnapshot.state, null)
  assert.equal(get().diffSnapshot.busy, true)
  assert.equal(get().diffVisible, false)
})

test('差异列表分页请求乱序返回时只保留最后选择；关闭后旧响应失效', async () => {
  const a = deferred(),
    b = deferred()
  let calls = 0
  const get = store({
    getOssDiffEntries: () => (++calls === 1 ? a.promise : b.promise),
    endOssDiff: async () => ok(null)
  })
  get().applyDiffSnapshot(snapshot(1))
  get().diffVisible = true
  const first = get().loadDiffPage(0),
    second = get().loadDiffPage(1)
  b.resolve(ok({ items: [{ key: 'new' }], total: 201 }))
  await second
  a.resolve(ok({ items: [{ key: 'old' }], total: 201 }))
  await first
  assert.equal(get().diffEntries[0].key, 'new')
  assert.equal(get().diffPage, 1)
  const late = get().loadDiffPage(2)
  await get().closeDiff()
  await late
  assert.equal(get().diffVisible, false)
  assert.equal(get().diffEntries.length, 0)
  assert.equal(get().diffPage, 0)
})

test('快速切换文件先取消旧请求；晚到响应和返回后的响应不能覆盖详情', async () => {
  const a = deferred(),
    b = deferred(),
    cancelled = []
  const get = store({
    readOssDiff: (_task, key) => (key === 'a.txt' ? a.promise : b.promise),
    cancelOssDiffRead: async (_task, id) => {
      cancelled.push(id)
      return ok(null)
    }
  })
  get().applyDiffSnapshot(snapshot(1))
  const first = get().openDiffFile('a.txt')
  get().applyDiffSnapshot({ ...snapshot(2), busy: true })
  const second = get().openDiffFile('b.txt')
  await tick()
  b.resolve(ok({ kind: 'different', key: 'b.txt' }))
  await second
  a.resolve(ok({ kind: 'different', key: 'a.txt' }))
  await first
  assert.equal(cancelled.length, 1)
  assert.equal(get().diffDetail.key, 'b.txt')
  get().applyDiffSnapshot({ ...snapshot(3), busy: false })
  const late = get().openDiffFile('a.txt')
  get().closeDiffFile()
  await late
  assert.equal(get().diffDetail, null)
})

for (const [label, occupied] of [
  [
    '其他 Diff 任务',
    (state) => {
      state.diffSnapshot.busy = true
    }
  ],
  [
    '同步运行',
    (state) => {
      state.syncState = { phase: 'transferring' }
    }
  ],
  [
    '同步启动等待',
    (state) => {
      state.syncRequestPending = true
    }
  ],
  [
    'Diff 启停等待',
    (state) => {
      state.diffPending = true
    }
  ]
]) {
  test(`${label}占用时提前提示，并保留当前已加载详情`, async () => {
    let calls = 0
    const get = store({
      readOssDiff: async () => {
        calls++
        return ok(null)
      }
    })
    get().applyDiffSnapshot(snapshot(1))
    const previous = { key: 'a.txt', status: 'loaded', result: { kind: 'different' } }
    get().diffDetail = previous
    const notices = []
    get().showToast = (message) => notices.push(message)
    occupied(get())
    await get().openDiffFile('b.txt')
    assert.equal(calls, 0)
    assert.equal(get().diffDetail, previous)
    assert.equal(notices.length, 1)
  })
}

test('扫描启动期间重复点击被抑制；失败可重试并保留明确错误', async () => {
  const pending = deferred()
  let starts = 0
  const get = store({
    startOssDiff: () => {
      starts++
      return pending.promise
    }
  })
  const first = get().startDiff()
  await get().startDiff()
  assert.equal(starts, 1)
  pending.resolve({ ok: false, error: { message: '同步正在运行' } })
  await first
  assert.equal(get().diffPending, false)
  assert.match(get().diffError, /同步正在运行/)
})

test('重新读取后差异计数不变，列表仍更新大小与修改时间', async () => {
  const get = store({
    readOssDiff: async () => ok({ kind: 'different', key: 'a.txt' }),
    getOssDiffEntries: async () =>
      ok({ items: [{ key: 'a.txt', local: { size: 9, modifiedAt: 'new time' } }], total: 1 }),
    getOssDiffIssues: async () => ok({ items: [], total: 0 })
  })
  get().applyDiffSnapshot(snapshot(1))
  get().diffVisible = true
  get().diffEntries = [{ key: 'a.txt', local: { size: 3, modifiedAt: 'old time' } }]
  await get().openDiffFile('a.txt')
  await tick()
  assert.equal(get().diffEntries[0].local.size, 9)
  assert.equal(get().diffEntries[0].local.modifiedAt, 'new time')
})

test('终态自动加载结果；未比较详情的旧响应不能混入新扫描', async () => {
  const old = deferred()
  let calls = 0
  const get = store({
    getOssDiffEntries: async () => ok({ items: [], total: 0 }),
    getOssDiffIssues: () =>
      ++calls === 1 ? old.promise : Promise.resolve(ok({ items: [{ key: 'new' }], total: 1 }))
  })
  get().diffVisible = true
  get().applyDiffSnapshot(snapshot(1, 'scanning', 'old'))
  get().applyDiffSnapshot(snapshot(2, 'partial', 'old'))
  get().applyDiffSnapshot(snapshot(3, 'scanning', 'new'))
  get().applyDiffSnapshot(snapshot(4, 'partial', 'new'))
  await tick()
  old.resolve(ok({ items: [{ key: 'old' }], total: 1 }))
  await tick()
  assert.equal(get().diffIssues[0].key, 'new')
})
