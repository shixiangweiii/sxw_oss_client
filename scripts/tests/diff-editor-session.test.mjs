import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader, tick } from './source-loader.mjs'

function fixture(failure = null, brokenDispose = null) {
  const created = [],
    disposed = [],
    updates = [],
    logs = []
  const injected = new Error(`模拟初始化失败：${failure}`)
  let listener,
    modelNumber = 0,
    rejectWait
  const waiting = new Promise((_resolve, reject) => {
    rejectWait = reject
  })
  const resource = (kind) => {
    if (failure === kind) throw injected
    created.push(kind)
    return {
      dispose() {
        disposed.push(kind)
        if (brokenDispose === kind) throw new Error('模拟清理失败')
      }
    }
  }
  const api = {
    createDiffEditor() {
      return {
        ...resource('editor'),
        getDiffComputationResult:
          failure === 'capability' ? undefined : () => ({ quitEarly: false, changes: [1, 2] }),
        onDidUpdateDiff(callback) {
          listener = callback
          return resource('subscription')
        },
        createViewModel() {
          return {
            ...resource('view'),
            waitForDiff() {
              if (failure === 'wait') throw injected
              return waiting
            }
          }
        },
        setModel() {
          if (failure === 'binding') throw injected
        }
      }
    },
    createModel() {
      return resource(`model${++modelNumber}`)
    }
  }
  const load = sourceLoader({}, { console: { error: (...args) => logs.push(args) } })
  const create = load('src/renderer/components/diffEditorSession.ts').createDiffEditorSession
  return {
    created,
    disposed,
    updates,
    logs,
    injected,
    open: () => create(api, {}, 'local', 'cloud', (...args) => updates.push(args)),
    notify: () => listener?.(),
    reject: () => rejectWait(new Error('模拟异步计算失败'))
  }
}

for (const phase of [
  'editor',
  'capability',
  'model1',
  'model2',
  'subscription',
  'view',
  'binding',
  'wait'
]) {
  test(`Monaco 初始化在 ${phase} 阶段失败时回收此前已创建资源`, () => {
    const f = fixture(phase)
    assert.throws(
      () => f.open(),
      (error) =>
        phase === 'capability' ? /不支持差异计算状态/.test(error.message) : error === f.injected
    )
    assert.deepEqual([...f.disposed].sort(), [...f.created].sort())
    assert.equal(new Set(f.disposed).size, f.disposed.length)
    f.notify()
    assert.equal(f.updates.length, 0)
  })
}

test('正常卸载按依赖顺序清理且幂等；晚到的计算回调不再更新页面', async () => {
  const f = fixture()
  const session = f.open()
  f.notify()
  assert.deepEqual(f.updates, [['complete', 2]])
  session.dispose()
  session.dispose()
  assert.deepEqual(f.disposed, ['subscription', 'editor', 'view', 'model2', 'model1'])
  f.notify()
  f.reject()
  await tick()
  assert.equal(f.updates.length, 1)
})

test('清理中的单个异常不会跳过其他资源，也不会覆盖原始初始化异常', () => {
  const f = fixture('binding', 'editor')
  assert.throws(
    () => f.open(),
    (error) => error === f.injected
  )
  assert.deepEqual([...f.disposed].sort(), [...f.created].sort())
  assert.equal(f.logs.length, 1)
  assert.match(f.logs[0][0], /资源释放失败/)
})

test('已完成初始化后的异步计算失败显示错误，资源仍在卸载时回收', async () => {
  const f = fixture()
  const session = f.open()
  f.reject()
  await tick()
  assert.deepEqual(f.updates, [['error', 0]])
  session.dispose()
  assert.deepEqual([...f.disposed].sort(), [...f.created].sort())
})
