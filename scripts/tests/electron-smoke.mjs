/** 用隔离 userData 和内存 OSS 启动真实 Electron，验证构建产物、IPC 与窗口生命周期。 */
import electron from 'electron'
import Module, { createRequire } from 'node:module'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { Worker } from 'node:worker_threads'
import { createPackage } from '@electron/asar'
import { runDiffSmoke } from './electron-diff-smoke.mjs'

const { app, BrowserWindow, dialog } = electron
const unhandledErrors = []
process.on('unhandledRejection', (error) => {
  unhandledErrors.push(error)
  console.error('未处理的异步异常：', error)
})
const windowed = process.argv.includes('--windowed')
const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '../..')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-client-smoke-'))
const syncLocal = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oss-sync-smoke-')))
app.setPath('userData', userData)
process.on('exit', () => {
  fs.rmSync(userData, { recursive: true, force: true })
  fs.rmSync(syncLocal, { recursive: true, force: true })
})
let configBucket = 'fixture'
let configuredLocal = syncLocal
let failDownloadedCleanup = false
let answer = 0
const dialogs = []
dialog.showMessageBoxSync = (_win, options) => {
  dialogs.push(options.message)
  return answer
}
const nativeMessageBox = dialog.showMessageBox.bind(dialog)
let useNativeConfirmation = false
let holdConfirmation = false
let holdModeSelection = false
const confirmationDialogs = []
dialog.showMessageBox = (parent, options) => {
  if (options.buttons?.includes('合并文本到本地') && !holdModeSelection)
    return Promise.resolve({ response: 2 })
  if (useNativeConfirmation) {
    const box = { parent, options, closed: false }
    confirmationDialogs.push(box)
    return nativeMessageBox(parent, options).finally(() => {
      box.closed = true
    })
  }
  return new Promise((resolve) => {
    const respond = (response) => {
      options.signal.removeEventListener('abort', abort)
      resolve({ response, checkboxChecked: false })
    }
    const abort = () => respond(options.cancelId)
    options.signal.addEventListener('abort', abort, { once: true })
    confirmationDialogs.push({ parent, options, respond })
    if (options.signal.aborted) abort()
    else if (!holdConfirmation) respond(1)
  })
}
let revision = 0
let remote = 'initial'
let saveGate = null
const writes = []
let diffObjects = null
let diffGate = null
const diffTraffic = []
const diffHeaders = (key) => {
  const value = diffObjects.get(key)
  if (!value) throw new Error('测试云端文件不存在')
  return {
    etag: `"diff-${key}-${value.length}"`,
    'content-length': String(value.length),
    'last-modified': 'Wed, 01 Jan 2020 00:00:00 GMT'
  }
}
const headers = () => ({
  etag: `"${revision}"`,
  'content-length': String(Buffer.byteLength(remote)),
  'last-modified': 'Wed, 01 Jan 2020 00:00:00 GMT'
})
class FixtureOSS {
  constructor(options) {
    this.bucket = options.bucket
  }
  async listV2(query) {
    if (diffObjects) {
      const offset = Number(query['continuation-token'] ?? 0)
      const all = [...diffObjects].map(([name, value]) => ({ name, size: value.length }))
      return {
        objects: all.slice(offset, offset + 60),
        isTruncated: offset + 60 < all.length,
        nextContinuationToken: String(offset + 60)
      }
    }
    return {
      objects: [
        { name: 'a.txt', size: Buffer.byteLength(remote), lastModified: new Date().toISOString() }
      ],
      prefixes: [],
      isTruncated: false
    }
  }
  async head(key) {
    if (diffObjects) {
      diffTraffic.push(['HEAD', key])
      if (diffGate) await diffGate
      return { res: { headers: diffHeaders(key) } }
    }
    return { res: { headers: headers() } }
  }
  async get() {
    return { content: Buffer.from(remote), res: { headers: headers() } }
  }
  async getStream(key, options) {
    if (diffObjects) {
      diffTraffic.push(['GET', key])
      assert.equal(options.headers['If-Match'], diffHeaders(key).etag)
      return { stream: Readable.from([diffObjects.get(key)]), res: { headers: diffHeaders(key) } }
    }
    return { stream: Readable.from([Buffer.from(remote)]), res: { headers: headers() } }
  }
  async put(key, content) {
    if (saveGate) await saveGate
    remote = Buffer.isBuffer(content) ? content.toString() : fs.readFileSync(content, 'utf8')
    revision++
    writes.push({ bucket: this.bucket, key, content: remote })
    return { res: { headers: headers() } }
  }
}
const originalLoad = Module._load
Module._load = function (name, ...args) {
  if (name === 'ali-oss') return FixtureOSS
  if (name === 'fs/promises')
    return {
      ...fsp,
      unlink: async (file) => {
        if (
          failDownloadedCleanup &&
          file.startsWith(syncLocal + path.sep) &&
          path.basename(file) === 'owner'
        )
          throw new Error('模拟临时文件清理失败')
        return fsp.unlink(file)
      }
    }
  if (name === 'fs')
    return {
      ...fs,
      existsSync: (p) => path.basename(String(p)) === '.env' || fs.existsSync(p),
      readFileSync: (p, ...rest) =>
        path.basename(String(p)) === '.env'
          ? `oss_ak=fixture\noss_sk=fixture\noss_bucket=${configBucket}\nsync_dir_local=${configuredLocal}`
          : fs.readFileSync(p, ...rest)
    }
  return originalLoad.call(this, name, ...args)
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(check, label, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return
    await pause(30)
  }
  throw new Error(`等待超时：${label}`)
}
const js = async (win, code) => {
  let timer
  try {
    return await Promise.race([
      win.webContents.executeJavaScript(code),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`渲染执行超时：${code.slice(0, 180)}`)), 30000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
const text = (win) => js(win, 'document.body.innerText')
async function open(win) {
  await until(() => js(win, '!!document.querySelector("button[title=点击在线编辑]")'), '文件列表')
  await js(win, 'document.querySelector("button[title=点击在线编辑]").click()')
  await until(() => js(win, '!!document.querySelector("textarea")'), '编辑器')
}
async function draft(win, value) {
  await js(
    win,
    `(() => { const t=document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(value)}); t.dispatchEvent(new Event('input',{bubbles:true})); })()`
  )
}
const save = (win) =>
  js(
    win,
    "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('保存（')).click()"
  )
const timeout = setTimeout(() => {
  console.error('Electron smoke 总超时')
  app.exit(1)
}, 240000)

async function checkPackedMergeWorker() {
  const staging = path.join(userData, 'worker-package')
  await fsp.cp(path.join(root, 'out/main'), path.join(staging, 'out/main'), { recursive: true })
  await fsp.cp(
    path.dirname(require.resolve('diff/package.json')),
    path.join(staging, 'node_modules/diff'),
    { recursive: true }
  )
  const archive = path.join(userData, 'worker-fixture.asar')
  await createPackage(staging, archive)
  const worker = new Worker(path.join(archive, 'out/main/textMergeWorker.js'), {
    workerData: {
      localBytes: Buffer.from('local\n'),
      remoteBytes: Buffer.from('cloud\n'),
      timeout: 5000
    }
  })
  let timer
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('ASAR Worker 等待超时')), 5000)
      worker.once('message', resolve)
      worker.once('error', reject)
      worker.once('exit', (code) => {
        if (code) reject(new Error(`ASAR Worker 异常退出 ${code}`))
      })
    })
    assert.equal(result.ok, true, result.message)
    assert.match(Buffer.from(result.value.bytes).toString(), /local\n======= OSS-CLIENT\ncloud/)
  } finally {
    clearTimeout(timer)
    await worker.terminate()
  }
  console.log('PASS ASAR 内合并 Worker 入口、共享 chunk 与外置 diff 加载')
}
// macOS 全屏切换是异步动画，必须等待事件，而非只读瞬时标志。
const fullscreenWindows = new Set()
app.on('browser-window-created', (_event, win) => {
  // 同步专项仍使用真实窗口/IPC，只隔离依赖 macOS Spaces 的全屏动画。
  if (windowed) win.setFullScreen = () => {}
  win.on('enter-full-screen', () => fullscreenWindows.add(win.id))
  win.on('leave-full-screen', () => fullscreenWindows.delete(win.id))
})
async function checkStartupWindow(win) {
  if (windowed) {
    await until(() => win.isVisible() && win.isMaximized(), '窗口模式启动并最大化')
    return
  }
  await until(() => fullscreenWindows.has(win.id), '默认进入原生全屏', 700)
  assert.equal(win.isFullScreen(), true)
  win.setFullScreen(false)
  await until(() => !fullscreenWindows.has(win.id), '退出原生全屏', 700)
  await until(() => win.isMaximized(), '退出全屏后保持最大化')
}
async function run() {
  try {
    require(path.join(root, 'out/main/index.js'))
    await app.whenReady()
    await until(() => BrowserWindow.getAllWindows().length === 1, '首窗')
    const first = BrowserWindow.getAllWindows()[0]
    await checkStartupWindow(first)
    console.log(windowed ? 'PASS 首窗窗口模式启动并最大化' : 'PASS 首窗默认全屏，退出后最大化')
    await open(first)
    await draft(first, 'v1')
    let release
    saveGate = new Promise((r) => {
      release = r
    })
    await save(first)
    await until(async () => (await text(first)).includes('保存中'), '保存中')
    await draft(first, 'v2')
    first.close()
    await until(() => dialogs.length > 0, '保存中关闭提示')
    assert.equal(first.isDestroyed(), false)
    assert.match(dialogs.at(-1), /正在保存/)
    release()
    saveGate = null
    await until(async () => (await text(first)).includes('未保存'), '后续草稿保持未保存')
    assert.equal(remote, 'v1')
    console.log('PASS 保存中输入和关闭保护')

    const count = dialogs.length
    first.close()
    await until(() => dialogs.length > count, '未保存关闭确认')
    assert.equal(first.isDestroyed(), false)
    assert.equal(await js(first, 'document.querySelector("textarea").value'), 'v2')
    const quitCount = dialogs.length
    app.quit()
    await until(() => dialogs.length > quitCount, '退出确认')
    assert.equal(first.isDestroyed(), false)
    console.log('PASS 原生 close / app.quit 取消保留草稿')

    const reloadCount = dialogs.length
    first.webContents.reload()
    await until(() => dialogs.length > reloadCount, '刷新确认')
    assert.equal(await js(first, 'document.querySelector("textarea").value'), 'v2')
    console.log('PASS 页面刷新取消保留草稿')
    await save(first)
    await until(() => remote === 'v2', '第二次保存')
    await until(async () => (await text(first)).includes('已保存'), '保存结束')

    await js(first, 'window.electronAPI.newWindow()')
    await until(() => BrowserWindow.getAllWindows().length === 2, '第二窗口')
    const second = BrowserWindow.getAllWindows().find((w) => w !== first)
    await checkStartupWindow(second)
    console.log(windowed ? 'PASS 新窗口窗口模式启动并最大化' : 'PASS 新窗口默认全屏，退出后最大化')
    await open(second)
    await draft(first, 'first edit')
    await save(first)
    await until(() => remote === 'first edit', '第一窗口写入')
    await draft(second, 'second edit')
    await save(second)
    await until(async () => (await text(second)).includes('本次未写入'), '第二窗口冲突提示')
    assert.equal(remote, 'first edit')
    assert.equal(await js(second, 'document.querySelector("textarea").value'), 'second edit')
    console.log('PASS 跨窗口冲突保留草稿')

    answer = 1
    await js(second, 'document.querySelector("button[title=返回文件列表]").click()')
    await until(() => js(second, '!document.querySelector("textarea")'), '返回列表完成')
    configBucket = 'refreshed'
    await js(second, 'document.querySelector("button[aria-label=刷新]").click()')
    await until(async () => (await text(second)).includes('refreshed'), '重载 .env')
    await draft(first, 'still original bucket')
    await save(first)
    await until(() => remote === 'still original bucket', '原窗口继续保存')
    assert.equal(writes.at(-1).bucket, 'fixture')
    console.log('PASS 配置重载按窗口隔离')

    const clickSync = async (win, direction) => {
      const label = direction === 'upload' ? '同步到云端' : '同步到本地'
      await until(
        () =>
          js(
            win,
            `[...document.querySelectorAll('button')].some(b => b.textContent === '${label}' && !b.disabled)`
          ),
        '同步按钮可用'
      )
      const previous = await js(win, 'window.electronAPI.getOssSyncState()')
      await js(
        win,
        `[...document.querySelectorAll('button')].find(b => b.textContent === '${label}').click()`
      )
      await until(
        async () =>
          (await js(win, 'window.electronAPI.getOssSyncState()'))?.taskId !== previous?.taskId,
        '新同步任务启动'
      )
    }
    const syncState = (win) => js(win, 'window.electronAPI.getOssSyncState()')
    const syncFinished = async (win) => {
      await until(
        async () =>
          ['success', 'partial', 'cancelled', 'failed'].includes((await syncState(win))?.phase),
        '同步终态'
      )
      return syncState(win)
    }
    await clickSync(second, 'download')
    assert.equal((await syncFinished(second)).phase, 'success')
    assert.equal(fs.readFileSync(path.join(syncLocal, 'a.txt'), 'utf8'), remote)
    await until(async () => (await text(first)).includes('已完成'), '全窗口任务广播')
    console.log('PASS 下载按钮 / 实际本地文件 / 全窗口进度')

    remote = 'download preserving mode'
    revision++
    fs.chmodSync(path.join(syncLocal, 'a.txt'), 0o755)
    failDownloadedCleanup = true
    await clickSync(second, 'download')
    const cleanupState = await syncFinished(second)
    assert.equal(cleanupState.phase, 'partial')
    assert.equal(cleanupState.overwritten, 1)
    assert.equal(cleanupState.failed, 0)
    assert.equal(fs.statSync(path.join(syncLocal, 'a.txt')).mode & 0o777, 0o755)
    const cleanupIssues = await js(
      second,
      `window.electronAPI.getOssSyncIssues('${cleanupState.taskId}',0)`
    )
    assert.ok(cleanupIssues.items.some((i) => i.phase === 'cleanup' && i.kind === 'error'))
    assert.ok(
      cleanupIssues.items.filter((i) => i.kind === 'error').every((i) => i.phase === 'cleanup')
    )
    await until(async () => (await text(second)).includes('部分失败'), '清理错误独立显示')
    failDownloadedCleanup = false
    await clickSync(second, 'download')
    assert.equal((await syncFinished(second)).phase, 'success')
    assert.equal(fs.readFileSync(path.join(syncLocal, 'a.txt'), 'utf8'), remote)
    console.log('PASS 覆盖保留权限 / 清理失败计数准确 / 下次同步恢复清理')

    fs.writeFileSync(path.join(syncLocal, 'a.txt'), 'upload from local fixture')
    await clickSync(second, 'upload')
    await until(() => remote === 'upload from local fixture', '上传按钮写入')
    assert.equal((await syncFinished(second)).phase, 'success')
    console.log('PASS 上传按钮 / 本地快照上传 / 完成后列表刷新')
    if (process.env.OSS_SMOKE_SCREENSHOT)
      fs.writeFileSync(
        process.env.OSS_SMOKE_SCREENSHOT,
        (await second.webContents.capturePage()).toPNG()
      )

    // 真实 IPC/窗口与可控原生弹窗替身：等待、跳过、恢复及取消。
    holdConfirmation = true
    const originalLocal = fs.readFileSync(path.join(syncLocal, 'a.txt'), 'utf8')
    remote = 'new remote conflict'
    revision++
    let confirmCount = confirmationDialogs.length
    await clickSync(second, 'download')
    await until(() => confirmationDialogs.length === confirmCount + 1, '覆盖确认弹窗')
    await until(async () => (await text(first)).includes('等待覆盖确认'), '其他窗口等待状态')
    assert.equal(confirmationDialogs.at(-1).parent, second)
    assert.equal((await syncState(second)).processed, 0)
    assert.equal(fs.readFileSync(path.join(syncLocal, 'a.txt'), 'utf8'), originalLocal)
    const duplicateConfirmation = await js(first, "window.electronAPI.startOssSync('upload')")
    assert.equal(duplicateConfirmation.ok, false)
    answer = 0
    second.close()
    await until(() => confirmationDialogs.length === confirmCount + 2, '关闭取消后恢复同一确认')
    assert.equal(
      confirmationDialogs.at(-1).options.detail,
      confirmationDialogs.at(-2).options.detail
    )
    confirmationDialogs.at(-1).respond(0)
    const skipped = await syncFinished(second)
    assert.equal(skipped.skipped, 1)
    assert.equal(skipped.overwritten, 0)
    assert.equal(fs.readFileSync(path.join(syncLocal, 'a.txt'), 'utf8'), originalLocal)
    confirmCount = confirmationDialogs.length
    await clickSync(second, 'download')
    await until(() => confirmationDialogs.length === confirmCount + 1, '再次覆盖确认')
    confirmationDialogs.at(-1).respond(2)
    assert.equal((await syncFinished(second)).phase, 'cancelled')
    assert.equal(fs.readFileSync(path.join(syncLocal, 'a.txt'), 'utf8'), originalLocal)
    confirmCount = confirmationDialogs.length
    await clickSync(second, 'download')
    await until(() => confirmationDialogs.length === confirmCount + 1, '确认覆盖前等待')
    confirmationDialogs.at(-1).respond(1)
    assert.equal((await syncFinished(second)).overwritten, 1)
    assert.equal(fs.readFileSync(path.join(syncLocal, 'a.txt'), 'utf8'), remote)
    holdConfirmation = false
    console.log('PASS 覆盖确认 / 多窗口等待 / 关闭后恢复 / 跳过 / 取消 / 确认后实际覆盖')

    holdModeSelection = true
    holdConfirmation = true
    remote = '开头\n云端\n结尾\n'
    revision++
    fs.writeFileSync(path.join(syncLocal, 'a.txt'), '开头\n本地\n结尾\n')
    confirmCount = confirmationDialogs.length
    await clickSync(second, 'download')
    await until(() => confirmationDialogs.length === confirmCount + 1, '模式选择弹窗')
    await until(async () => (await text(first)).includes('等待选择同步方式'), '模式选择全窗口状态')
    assert.equal((await syncState(second)).precheck.different, 1)
    assert.deepEqual(confirmationDialogs.at(-1).options.buttons, [
      '取消本次同步',
      '合并文本到本地',
      '按原规则同步'
    ])
    assert.equal(confirmationDialogs.at(-1).options.defaultId, 0)
    assert.ok(confirmationDialogs.at(-1).options.detail.includes(path.join(syncLocal, 'a.txt')))
    const beforeMerge = fs.readFileSync(path.join(syncLocal, 'a.txt'), 'utf8')
    answer = 0
    second.close()
    await until(() => confirmationDialogs.length === confirmCount + 2, '模式选择收起后恢复')
    confirmationDialogs.at(-1).respond(0)
    assert.equal((await syncFinished(second)).phase, 'cancelled')
    assert.equal(fs.readFileSync(path.join(syncLocal, 'a.txt'), 'utf8'), beforeMerge)
    await js(second, 'document.querySelector("section[aria-label=同步任务] details").open = true')
    await until(
      async () => (await text(second)).includes('预检查：两端文本内容不同'),
      '取消后保留检查详情'
    )
    confirmCount = confirmationDialogs.length
    await clickSync(second, 'download')
    await until(() => confirmationDialogs.length === confirmCount + 1, '再次选择合并')
    await js(first, 'document.querySelector("section[aria-label=同步任务] details").open = true')
    await until(
      async () => (await text(first)).includes('预检查：两端文本内容不同'),
      '其他窗口查看检查记录'
    )
    confirmationDialogs.at(-1).respond(1)
    const mergedState = await syncFinished(second)
    assert.equal(mergedState.merged, 1)
    assert.equal(mergedState.overwritten, 0)
    const mergedText = fs.readFileSync(path.join(syncLocal, 'a.txt'), 'utf8')
    assert.match(mergedText, /本地\n======= OSS-CLIENT\n云端/)
    await until(async () => (await text(second)).includes('含待整理文件'), '待整理状态')
    const mergedIssues = await js(
      second,
      `window.electronAPI.getOssSyncIssues('${mergedState.taskId}',0)`
    )
    assert.equal(mergedIssues.items[0].kind, 'merge')
    assert.equal(mergedIssues.items[0].path, 'a.txt')
    assert.equal(mergedIssues.items[0].localPath, path.join(syncLocal, 'a.txt'))
    await until(
      async () => (await text(first)).includes('差异片段待整理'),
      '同数量记录更新后已展开详情自动刷新'
    )
    assert.equal(
      await js(
        first,
        'document.querySelectorAll("section[aria-label=同步任务] details li").length'
      ),
      1
    )
    holdModeSelection = false
    holdConfirmation = false
    const cloudBeforeUpload = remote
    await clickSync(second, 'upload')
    assert.equal((await syncFinished(second)).skipped, 1)
    assert.equal(remote, cloudBeforeUpload)
    fs.writeFileSync(path.join(syncLocal, 'a.txt'), remote)
    console.log('PASS 文本预检查 / 模式选择恢复与取消 / 双方合并 / 待整理详情 / 上传标记拦截')

    const commonLines = Array.from({ length: 20000 }, (_, i) => `共同-${i}\n`).join('')
    const addedLines = Array.from({ length: 10000 }, (_, i) => `云端新增-${i}\n`).join('')
    remote = commonLines + addedLines
    revision++
    fs.writeFileSync(path.join(syncLocal, 'a.txt'), commonLines)
    holdModeSelection = true
    holdConfirmation = true
    confirmCount = confirmationDialogs.length
    await clickSync(second, 'download')
    await until(() => confirmationDialogs.length === confirmCount + 1, '万行追加模式选择')
    const mergeStart = Date.now()
    confirmationDialogs.at(-1).respond(1)
    assert.equal((await syncFinished(second)).merged, 1)
    assert.ok(fs.readFileSync(path.join(syncLocal, 'a.txt'), 'utf8').includes(addedLines))
    console.log(`PASS 真实 Electron Worker 合并两万行后的万行追加（${Date.now() - mergeStart} ms）`)
    holdModeSelection = false
    holdConfirmation = false
    fs.writeFileSync(path.join(syncLocal, 'a.txt'), remote)

    if (process.argv.includes('--native-confirmation'))
      for (const nativeModeSelection of [false, true]) {
        useNativeConfirmation = true
        holdModeSelection = nativeModeSelection
        remote = 'native dialog fixture'
        revision++
        confirmCount = confirmationDialogs.length
        const beforeNative = fs.readFileSync(path.join(syncLocal, 'a.txt'), 'utf8')
        await clickSync(second, 'download')
        await until(() => confirmationDialogs.length === confirmCount + 1, '真实原生覆盖弹窗')
        await pause(600)
        assert.equal(
          (await syncState(second)).phase,
          nativeModeSelection ? 'choosing' : 'confirming'
        )
        answer = 0
        app.quit()
        await until(() => confirmationDialogs.length === confirmCount + 2, '真实原生弹窗收起后恢复')
        assert.equal(confirmationDialogs.at(-2).closed, true)
        await pause(600)
        assert.equal(
          (await syncState(second)).phase,
          nativeModeSelection ? 'choosing' : 'confirming'
        )
        const nativeTask = await syncState(second)
        await js(first, `window.electronAPI.cancelOssSync('${nativeTask.taskId}')`)
        assert.equal((await syncFinished(second)).phase, 'cancelled')
        await until(() => confirmationDialogs.at(-1).closed, '取消信号关闭真实原生弹窗')
        assert.equal(fs.readFileSync(path.join(syncLocal, 'a.txt'), 'utf8'), beforeNative)
        useNativeConfirmation = false
        holdModeSelection = false
        console.log(
          `PASS 真实 macOS ${nativeModeSelection ? '模式选择' : '覆盖确认'}弹窗展示 / 退出时收起和恢复 / 取消信号关闭 / 保留目标`
        )
      }

    // 在途上传可取消，但必须等待请求结束再关闭；其他窗口的草稿仍需单独确认。
    await draft(first, 'unsaved during sync')
    fs.writeFileSync(path.join(syncLocal, 'a.txt'), 'pending fixture upload')
    saveGate = new Promise((r) => {
      release = r
    })
    await clickSync(second, 'upload')
    await until(async () => (await syncState(second))?.phase === 'transferring', '同步传输阶段')
    await js(second, 'window.electronAPI.newWindow()')
    await until(() => BrowserWindow.getAllWindows().length === 3, '同步中新窗口')
    const third = BrowserWindow.getAllWindows().find((w) => w !== first && w !== second)
    await checkStartupWindow(third)
    await until(
      () => js(third, '!!document.querySelector("button[title=点击在线编辑]")'),
      '同步中新窗口仍可初始化浏览'
    )
    await until(async () => (await text(third)).includes('传输中'), '同步中新窗口恢复进度')
    console.log('PASS 同步中新建窗口初始化与任务恢复')
    const blocked = await js(
      first,
      "window.electronAPI.putOssObjectText('fixture', 'a.txt', 'not allowed', {etag:'invalid',versionId:null})"
    )
    assert.equal(blocked.ok, false)
    const duplicate = await js(first, "window.electronAPI.startOssSync('download')")
    assert.equal(duplicate.ok, false)
    answer = 0
    const syncQuitDialogs = dialogs.length
    app.quit()
    await until(() => dialogs.length > syncQuitDialogs, '同步退出确认')
    assert.equal(first.isDestroyed(), false)
    assert.match(dialogs.at(-1), /同步进行中/)
    console.log('PASS 同步和在线保存互斥 / 重复任务拒绝 / 继续同步取消退出')

    answer = 1
    first.close()
    await until(async () => (await syncState(second)).phase === 'cancelling', '取消等待中')
    assert.equal(first.isDestroyed(), false)
    answer = 0 // 取消同步结束后的编辑草稿确认仍选择保留。
    release()
    saveGate = null
    await until(() => /未保存/.test(dialogs.at(-1)), '取消同步后仍检查草稿')
    assert.equal(first.isDestroyed(), false)
    assert.equal((await syncState(second)).phase, 'cancelled')
    assert.equal(await js(first, 'document.querySelector("textarea").value'), 'unsaved during sync')
    console.log('PASS 取消同步等待清理 / 关闭时保留其他未保存草稿')

    fs.writeFileSync(path.join(syncLocal, 'a.txt'), 'cancel by button')
    saveGate = new Promise((r) => {
      release = r
    })
    await clickSync(second, 'upload')
    await until(async () => (await syncState(second)).phase === 'transferring', '再次同步')
    await js(
      second,
      "[...document.querySelectorAll('button')].find(b=>b.textContent==='取消同步').click()"
    )
    await until(async () => (await syncState(second)).phase === 'cancelling', '取消按钮')
    release()
    saveGate = null
    assert.equal((await syncFinished(second)).phase, 'cancelled')
    console.log('PASS 取消同步按钮')

    fs.writeFileSync(path.join(syncLocal, 'a.txt'), 'cancel before reload')
    saveGate = new Promise((r) => {
      release = r
    })
    await clickSync(second, 'upload')
    await until(async () => (await syncState(second)).phase === 'transferring', '刷新前同步')
    answer = 1
    second.webContents.reload()
    await until(async () => (await syncState(second)).phase === 'cancelling', '刷新时取消同步')
    const reloaded = new Promise((resolve) => second.webContents.once('did-finish-load', resolve))
    release()
    saveGate = null
    await reloaded
    await until(async () => (await text(second)).includes('已取消'), '重载恢复终态')
    assert.equal((await syncState(second)).phase, 'cancelled')
    console.log('PASS 取消同步后刷新页面 / 重载恢复状态')

    remote = 'a'.repeat(5 * 1024 * 1024)
    revision++
    await open(second)
    assert.equal(
      await js(second, 'document.querySelector("textarea").value.length'),
      5 * 1024 * 1024
    )
    await draft(second, 'b' + remote.slice(1))
    await save(second)
    await until(() => remote.startsWith('b'), '5 MB 文本保存')
    await until(async () => (await text(second)).includes('已保存'), '5 MB 保存完成')
    const savedRevision = revision
    await draft(second, remote + 'x')
    await until(async () => (await text(second)).includes('超过 5 MB'), '超限提示')
    assert.equal(
      await js(
        second,
        '[...document.querySelectorAll("button")].find(b => b.textContent.includes("保存（")).disabled'
      ),
      true
    )
    assert.equal(revision, savedRevision)
    answer = 1
    await js(second, 'document.querySelector("button[title=返回文件列表]").click()')
    console.log('PASS 在线编辑实际读取/保存恰好 5 MB，超限草稿保留且禁止保存')

    await checkPackedMergeWorker()

    await runDiffSmoke({
      win: second,
      other: third,
      localDir: syncLocal,
      js,
      text,
      until,
      configure: (objects) => {
        diffObjects = objects
      },
      setGate: (gate) => {
        diffGate = gate
      },
      traffic: diffTraffic,
      writes
    })
    diffObjects = null

    configuredLocal = 'relative/path'
    await js(second, 'document.querySelector("button[aria-label=刷新]").click()')
    await until(async () => (await text(second)).includes('必须是绝对路径'), '配置错误提示')
    assert.equal(
      await js(
        second,
        "[...document.querySelectorAll('button')].filter(b=>['同步到本地','同步到云端'].includes(b.textContent)).every(b=>b.disabled)"
      ),
      true
    )
    assert.equal(await js(second, '!!document.querySelector("button[title=点击在线编辑]")'), true)
    console.log('PASS 同步配置错误禁用按钮但保留 OSS 浏览')

    answer = 1

    await draft(first, 'discard me')
    first.close()
    await until(() => first.isDestroyed(), '放弃修改关闭')
    if (!third.isDestroyed()) third.close()
    await until(() => third.isDestroyed(), '额外窗口关闭')
    second.close()
    await until(() => second.isDestroyed(), '干净窗口关闭')
    console.log('PASS 放弃关闭 / 干净关闭')
    await pause(0)
    assert.equal(unhandledErrors.length, 0, 'Electron 流程不得遗留未处理的异步异常')
    clearTimeout(timeout)
    app.exit(0)
  } catch (error) {
    console.error(error)
    for (const win of BrowserWindow.getAllWindows())
      console.error('FIXTURE UI:', await text(win).catch(() => 'unavailable'))
    clearTimeout(timeout)
    app.exit(1)
  }
}
void run()
