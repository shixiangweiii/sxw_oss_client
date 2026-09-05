import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader, deferred, tick } from './source-loader.mjs'

const version = { etag: 'v0', versionId: null }
function store(api) {
  const load = sourceLoader({}, { window: { electronAPI: api } })
  let state
  const set = (patch) => {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  }
  state = {
    ...load('src/renderer/store/ossSlice.ts').createOssSlice(set, () => state),
    showToast() {}
  }
  return () => state
}
const content = (value) => ({ ok: true, data: { content: value, size: value.length, version } })
async function opened(api = {}) {
  const get = store({ getOssObjectText: async () => content('old'), ...api })
  get().activeBucket = 'bucket'
  get().openTextFile('a.txt')
  await tick()
  return get
}
const page = (name, next = null) => ({
  ok: true,
  data: { prefixes: [], objects: [{ name, size: 1 }], nextContinuationToken: next }
})

test('保存期间继续输入：提交快照成为已保存基线，后续草稿仍为脏状态', async () => {
  const pending = deferred()
  const calls = []
  const get = await opened({
    putOssObjectText: (...args) => {
      calls.push(args)
      return pending.promise
    }
  })
  get().setEditorDraft('v1')
  const save = get().saveEditor()
  get().setEditorDraft('v2')
  pending.resolve({
    ok: true,
    data: { key: 'a.txt', size: 2, version: { etag: 'v1', versionId: null } }
  })
  await save
  assert.equal(calls[0][2], 'v1')
  assert.equal(get().editor.savedContent, 'v1')
  assert.equal(get().editor.draft, 'v2')
  assert.equal(get().editor.version.etag, 'v1')
  await get().saveEditor()
  assert.equal(calls.length, 2)
  assert.equal(calls[1][3].etag, 'v1')
})

test('同文件关闭重开后，旧读取响应不能覆盖新草稿', async () => {
  const a = deferred(),
    b = deferred()
  let calls = 0
  const get = store({ getOssObjectText: () => (++calls === 1 ? a.promise : b.promise) })
  get().activeBucket = 'bucket'
  get().openTextFile('a.txt')
  get().closeEditor()
  get().openTextFile('a.txt')
  b.resolve(content('new'))
  await tick()
  get().setEditorDraft('my draft')
  a.resolve(content('old'))
  await tick()
  assert.equal(get().editor.draft, 'my draft')
})

test('保存中不允许关闭、换文件或刷新配置，避免丢失在途写入', async () => {
  const pending = deferred()
  let configs = 0
  const get = await opened({
    putOssObjectText: () => pending.promise,
    getOssConfig: () => {
      configs++
    }
  })
  get().setEditorDraft('changed')
  const save = get().saveEditor()
  get().closeEditor()
  get().openTextFile('b.txt')
  await get().bootstrap()
  assert.equal(get().editor.key, 'a.txt')
  assert.equal(get().editor.status, 'saving')
  assert.equal(configs, 0)
  pending.resolve({ ok: false, error: { message: '网络失败' } })
  await save
  assert.equal(get().editor.draft, 'changed')
  assert.equal(get().editor.status, 'loaded')
})

test('刷新同一 Bucket 后，旧首页或旧分页响应均失效', async () => {
  for (const pagination of [false, true]) {
    const old = deferred(),
      fresh = deferred()
    let calls = 0
    const get = store({
      listOssObjects: () => {
        calls++
        if (pagination && calls === 1) return Promise.resolve(page('initial.txt', 'next'))
        return calls === (pagination ? 2 : 1) ? old.promise : fresh.promise
      }
    })
    get().openBucket('bucket')
    if (pagination) {
      await tick()
      get().loadMore('')
    }
    get().openBucket('bucket')
    fresh.resolve(page('new.txt'))
    await tick()
    old.resolve(page('old.txt'))
    await tick()
    assert.deepEqual(
      Array.from(get().dirStates[''].files, (f) => f.key),
      ['new.txt']
    )
  }
})

test('重复引导的旧配置响应不能重新打开旧 Bucket', async () => {
  const a = deferred(),
    b = deferred()
  let calls = 0
  const get = store({
    getOssConfig: () => (++calls === 1 ? a.promise : b.promise),
    listOssObjects: async () => page('x')
  })
  const first = get().bootstrap(),
    second = get().bootstrap()
  b.resolve({ ok: true, data: { defaultBucket: 'new' } })
  await second
  a.resolve({ ok: true, data: { defaultBucket: 'old' } })
  await first
  assert.equal(get().activeBucket, 'new')
})

test('IPC 拒绝与冲突都保留草稿并退出 saving', async () => {
  for (const fail of [
    async () => {
      throw new Error('断连')
    },
    async () => ({ ok: false, error: { code: 'EditConflict', message: '版本冲突' } })
  ]) {
    const get = await opened({ putOssObjectText: fail })
    get().setEditorDraft('keep me')
    await get().saveEditor()
    assert.equal(get().editor.status, 'loaded')
    assert.equal(get().editor.savedContent, 'old')
    assert.equal(get().editor.draft, 'keep me')
    assert.ok(get().editor.error)
  }
})

test('UTF-8 超限的多字节草稿不进入 IPC', async () => {
  let calls = 0
  const get = await opened({
    putOssObjectText: () => {
      calls++
    }
  })
  get().setEditorDraft('中'.repeat(700000))
  await get().saveEditor()
  assert.equal(calls, 0)
  assert.match(get().editor.error, /2 MB/)
})

test('beforeunload 同步检查 dirty 和 saving，取消关闭时阻止卸载', () => {
  for (const [status, draft, allowed, shouldBlock] of [
    ['loaded', 'old', false, false],
    ['loaded', 'new', false, true],
    ['loaded', 'new', true, false],
    ['saving', 'old', true, true]
  ]) {
    let blocked = false
    const load = sourceLoader(
      {
        './store': {
          useStore: { getState: () => ({ editor: { status, draft, savedContent: 'old' } }) }
        }
      },
      { window: { electronAPI: { confirmWindowClose: () => allowed } } }
    )
    load('src/renderer/closeGuard.ts').handleBeforeUnload({
      preventDefault() {
        blocked = true
      }
    })
    assert.equal(blocked, shouldBlock)
  }
})
