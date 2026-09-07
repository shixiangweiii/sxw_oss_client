import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader, deferred } from './source-loader.mjs'

function store(api = {}) {
  const load = sourceLoader({}, { window: { electronAPI: api } })
  let state,
    refreshes = 0
  const set = (p) => {
    state = { ...state, ...(typeof p === 'function' ? p(state) : p) }
  }
  state = {
    ...load('src/renderer/store/diffSlice.ts').createDiffSlice(set, () => state),
    ...load('src/renderer/store/syncSlice.ts').createSyncSlice(set, () => state),
    activeBucket: 'b',
    refreshBucket() {
      refreshes++
    }
  }
  return { get: () => state, refreshes: () => refreshes }
}
const progress = (revision, phase = 'scanning', taskId = 'task') => ({
  revision,
  phase,
  taskId,
  bucket: 'b',
  direction: 'upload'
})

test('同步状态按全局版本去重，旧快照不能覆盖事件；上传终态只刷新一次列表', () => {
  const s = store()
  s.get().applySyncState(progress(2, 'transferring'))
  s.get().applySyncState(progress(1))
  assert.equal(s.get().syncState.revision, 2)
  s.get().applySyncState(progress(3, 'partial'))
  s.get().applySyncState(progress(3, 'partial'))
  assert.equal(s.refreshes(), 1)
  s.get().applySyncState(progress(4, 'scanning', 'next'))
  s.get().applySyncState(progress(3, 'partial'))
  assert.equal(s.get().syncState.taskId, 'next')
})

test('旧任务的错误详情响应不能污染新任务，分页不重复追加', async () => {
  const pending = deferred()
  const s = store({ getOssSyncIssues: () => pending.promise })
  s.get().applySyncState(progress(1))
  const old = s.get().loadSyncIssues()
  s.get().applySyncState(progress(2, 'scanning', 'new'))
  pending.resolve({ items: [{ message: 'old' }], total: 1 })
  await old
  assert.equal(s.get().syncIssues.length, 0)
  await Promise.all([s.get().loadSyncIssues(), s.get().loadSyncIssues()])
  assert.equal(s.get().syncIssues.length, 1)
})

test('启动等待响应时阻止重复点击，主进程错误可见且解锁按钮', async () => {
  let calls = 0
  const pending = deferred()
  const s = store({
    startOssSync: () => {
      calls++
      return pending.promise
    }
  })
  const first = s.get().startSync('upload')
  await s.get().startSync('download')
  assert.equal(calls, 1)
  pending.resolve({ ok: false, error: { message: '正在保存' } })
  await first
  assert.match(s.get().syncError, /正在保存/)
  assert.equal(s.get().syncRequestPending, false)
})

test('等待确认保持任务活跃，不刷新云端列表、不允许启动下一任务', async () => {
  let starts = 0
  const s = store({
    startOssSync: async () => {
      starts++
    }
  })
  s.get().applySyncState(progress(1, 'confirming'))
  await s.get().startSync('upload')
  assert.equal(starts, 0)
  assert.equal(s.refreshes(), 0)
  s.get().applySyncState(progress(2, 'success'))
  assert.equal(s.refreshes(), 1)
})
