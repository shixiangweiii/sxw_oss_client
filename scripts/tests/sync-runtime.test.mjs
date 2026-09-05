import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { sourceLoader, deferred, tick } from './source-loader.mjs'

async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await tick()
  }
  assert.fail('等待运行时确认超时')
}

async function runtime() {
  const handlers = new Map(),
    events = new Map(),
    boxes = [],
    windows = []
  const instances = []
  let exitAnswer = 0,
    exits = 0
  class Window extends EventEmitter {
    constructor() {
      super()
      this.webContents = {
        id: windows.length + 1,
        send() {},
        reload: () => {
          this.reloads++
        }
      }
      this.destroyed = false
      this.reloads = 0
      windows.push(this)
    }
    static getAllWindows() {
      return windows.filter((w) => !w.destroyed)
    }
    static getFocusedWindow() {
      return windows.find((w) => !w.destroyed) ?? null
    }
    static fromWebContents(sender) {
      return windows.find((w) => w.webContents === sender) ?? null
    }
    isDestroyed() {
      return this.destroyed
    }
    isMinimized() {
      return false
    }
    show() {}
    focus() {}
    close() {
      const e = {
        prevented: false,
        preventDefault() {
          this.prevented = true
        }
      }
      this.emit('close', e)
      if (!e.prevented) this.destroy()
    }
    destroy() {
      this.destroyed = true
      this.emit('closed')
    }
  }
  const app = new EventEmitter()
  app.getPath = () => '/unused-test-user-data'
  app.quit = () => {
    const e = {
      prevented: false,
      preventDefault() {
        this.prevented = true
      }
    }
    app.emit('before-quit', e)
    if (!e.prevented) exits++
  }
  class Manager {
    constructor() {
      instances.push(this)
      this.active = false
    }
    async recover() {}
    subscribe() {}
    getState() {
      return this.state
    }
    getIssues() {
      return { items: [], total: 0 }
    }
    start(direction, _connection, confirm) {
      assert.equal(this.active, false)
      this.active = true
      this.signal = new AbortController()
      this.state = { taskId: 'task', phase: 'confirming', issueCount: 0 }
      this.finished = Promise.resolve().then(async () => {
        const cancelled = new Promise((resolve) =>
          this.signal.signal.addEventListener('abort', () => resolve('cancel'), { once: true })
        )
        this.answer = await Promise.race([
          cancelled,
          confirm(
            {
              taskId: 'task',
              direction,
              bucket: 'fixture',
              key: 'folder/a.txt',
              localPath: '/test/folder/a.txt',
              localModifiedAt: 1704067200000,
              remoteModifiedAt: 1704067210000
            },
            this.signal.signal
          )
        ])
        this.state.phase =
          this.signal.signal.aborted || this.answer === 'cancel' ? 'cancelled' : 'success'
        this.active = false
      })
      return 'task'
    }
    cancel() {
      this.signal.abort()
    }
    wait() {
      return this.finished
    }
  }
  const load = sourceLoader({
    electron: {
      app,
      BrowserWindow: Window,
      ipcMain: {
        handle: (key, handler) => handlers.set(key, handler),
        on: (key, handler) => events.set(key, handler)
      },
      dialog: {
        showMessageBox: (_win, options) => {
          const gate = deferred()
          const box = { options, win: _win, gate, closed: false }
          boxes.push(box)
          const abort = () => gate.resolve({ response: options.cancelId })
          options.signal.addEventListener('abort', abort, { once: true })
          if (options.signal.aborted) abort()
          return gate.promise.finally(() => {
            box.closed = true
            options.signal.removeEventListener('abort', abort)
          })
        },
        showMessageBoxSync: () => {
          assert.ok(
            boxes.every((box) => box.closed),
            '退出确认不能叠在覆盖确认框上'
          )
          return exitAnswer
        }
      }
    },
    './sync': { SyncManager: Manager },
    './oss': { getSyncConnection: () => ({}), toOssError: (err) => ({ message: err.message }) }
  })
  await load('src/main/syncRuntime.ts').initializeSync()
  const first = new Window(),
    second = new Window()
  app.emit('browser-window-created', {}, first)
  app.emit('browser-window-created', {}, second)
  return {
    manager: instances[0],
    first,
    second,
    boxes,
    app,
    exits: () => exits,
    exitAnswer: (value) => {
      exitAnswer = value
    },
    start: () => handlers.get('oss:sync-start')({ sender: first.webContents }, 'upload'),
    cancel: () => handlers.get('oss:sync-cancel')({}, 'task'),
    reload: () => {
      const event = { sender: first.webContents }
      events.get('oss:sync-check-unload')(event)
      return event.returnValue
    }
  }
}

for (const [response, result] of [
  [0, 'skip'],
  [1, 'overwrite'],
  [2, 'cancel']
]) {
  test(
    `原生覆盖确认选择 ${result}：绑定发起窗、默认与 Esc 跳过、完整路径和时间`,
    { timeout: 5000 },
    async () => {
      const f = await runtime()
      assert.equal(f.start().ok, true)
      await until(() => f.boxes.length === 1)
      const box = f.boxes[0]
      assert.equal(box.win, f.first)
      assert.equal(box.options.defaultId, 0)
      assert.equal(box.options.cancelId, 0)
      assert.deepEqual(Array.from(box.options.buttons), ['跳过此文件', '确认覆盖', '取消本次同步'])
      assert.match(box.options.detail, /oss:\/\/fixture\/folder\/a.txt/)
      assert.match(box.options.detail, /本地修改时间/)
      assert.match(box.options.detail, /云端修改时间/)
      assert.equal(f.start().ok, false)
      box.gate.resolve({ response })
      await f.manager.wait()
      assert.equal(f.manager.answer, result)
      assert.equal(f.first.listenerCount('closed'), 0)
    }
  )
}

for (const operation of ['close', 'quit', 'reload']) {
  test(
    `等待覆盖确认时 ${operation}：继续恢复同一文件，取消后才执行窗口操作`,
    { timeout: 5000 },
    async () => {
      const f = await runtime()
      f.start()
      await until(() => f.boxes.length === 1)
      const act = () => {
        if (operation === 'close') f.first.close()
        else if (operation === 'quit') f.app.quit()
        else assert.equal(f.reload(), false)
      }
      act()
      await until(() => f.boxes.length === 2)
      assert.equal(f.boxes[0].closed, true)
      assert.equal(f.boxes[1].options.detail, f.boxes[0].options.detail)
      assert.equal(f.manager.active, true)
      assert.equal(f.first.destroyed, false)
      f.exitAnswer(1)
      act()
      await f.manager.wait()
      await until(() =>
        operation === 'close'
          ? f.first.destroyed
          : operation === 'quit'
            ? f.exits() === 1
            : f.first.reloads === 1
      )
      assert.equal(f.manager.state.phase, 'cancelled')
      assert.equal(f.boxes.length, 2)
      assert.ok(f.boxes.every((box) => box.closed))
    }
  )
}

for (const operation of ['cancel', 'destroy']) {
  test(`等待覆盖确认时 ${operation}：终止原生弹窗等待`, { timeout: 5000 }, async () => {
    const f = await runtime()
    f.start()
    await until(() => f.boxes.length === 1)
    if (operation === 'cancel') f.cancel()
    else f.first.destroy()
    await f.manager.wait()
    assert.equal(f.manager.state.phase, 'cancelled')
    assert.equal(f.boxes[0].closed, true)
  })
}
