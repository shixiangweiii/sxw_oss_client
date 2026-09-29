import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** 使用真实构建、preload、Worker 和 macOS 窗口，数据仅来自隔离夹具。 */
export async function runDiffSmoke({
  win,
  other,
  localDir,
  js,
  text,
  until,
  configure,
  setGate,
  traffic,
  writes
}) {
  win.show()
  win.focus()
  const objects = new Map()
  const add = (key, local, remote) => {
    const file = path.join(localDir, key)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, local)
    objects.set(key, Buffer.from(remote))
  }
  for (let i = 0; i < 103; i++)
    add(
      `notes/${String(i).padStart(3, '0')}.txt`,
      `local ${i}\nsecond line\nthird line`,
      `cloud ${i}\nsecond line\nchanged third line`
    )
  add('bom.txt', '\ufeffhello\r\n', 'hello\r\n')
  add('eol.txt', 'a\r\nb\r\n', 'a\nb\n')
  add('long.txt', 'a'.repeat(5 * 1024 * 1024 - 1) + 'x', 'a'.repeat(5 * 1024 * 1024 - 1) + 'y')
  add(
    'many.txt',
    Array.from({ length: 65000 }, (_, i) => `text-${i}-line\n`).join(''),
    Array.from({ length: 65000 }, (_, i) =>
      i === 10 ? 'changed line\n' : `text-${i}-line\n`
    ).join('')
  )
  add(
    'budget.txt',
    Array.from({ length: 150 }, (_, i) => `local-${i}-line\n`).join(''),
    Array.from({ length: 150 }, (_, i) => `cloud-${i}-changed\n`).join('')
  )
  add('same.txt', 'same', 'same')
  add('empty.txt', '', '')
  add('oversized.txt', 'x'.repeat(5 * 1024 * 1024 + 1), 'x')
  add('invalid.txt', 'text', Buffer.from([0xff]))
  objects.set('only-cloud.txt', Buffer.from('cloud'))
  configure(objects)
  const writeCount = writes.length
  const before = fs.statSync(path.join(localDir, 'notes/102.txt'))
  const errors = []
  const listener = (event) => {
    const value = event.message
    if (
      value &&
      /Could not create web worker|Refused to|Content Security Policy|worker.*error/i.test(value)
    )
      errors.push(value)
  }
  win.webContents.on('console-message', listener)
  await js(
    win,
    `(() => {
    self.MonacoEnvironment = { globalAPI: true };
    window.__diffWorkers = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        const record = { url: String(url), sent: 0, received: 0, errors: [] };
        window.__diffWorkers.push(record);
        this.addEventListener('message', () => record.received++);
        this.addEventListener('error', (event) => record.errors.push(event.message));
        const post = this.postMessage.bind(this);
        this.postMessage = (...args) => { record.sent++; return post(...args); };
      }
    };
  })()`
  )
  const click = (label) =>
    js(
      win,
      `[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)} && !b.disabled).click()`
    )
  await click('Diff')
  const state = () => js(win, 'window.electronAPI.getOssDiffState()')
  await until(
    async () => ['partial', 'success'].includes((await state()).state?.phase),
    'Diff 扫描完成',
    600
  )
  const scan = (await state()).state
  assert.equal(scan.different, 108)
  assert.equal(scan.unchanged, 2)
  assert.equal(scan.uncompared, 2)
  await until(
    () => js(win, 'document.querySelectorAll("[data-testid=diff-page] tbody tr").length===100'),
    '差异第一页'
  )
  assert.equal((await js(other, 'window.electronAPI.getOssDiffState()')).state, null)
  const stolen = await js(
    other,
    `window.electronAPI.getOssDiffEntries(${JSON.stringify(scan.taskId)},0)`
  )
  assert.equal(stolen.ok, false)
  await click('下一页')
  await until(
    () => js(win, 'document.querySelectorAll("[data-testid=diff-page] tbody tr").length===8'),
    '差异第二页'
  )
  await js(win, 'document.querySelector("[data-testid=diff-list-scroll]").scrollTop=80')
  const position = await js(
    win,
    'document.querySelector("[data-testid=diff-list-scroll]").scrollTop'
  )
  const open = async (key) => {
    // 服务已验证 key 归属；这里通过真实行按钮打开。
    await js(
      win,
      `document.querySelector('button[aria-label=${JSON.stringify(`查看 ${key} 的 Diff`)}]').click()`
    )
    await until(
      () =>
        js(
          win,
          'document.querySelector("[data-testid=diff-editor]")?.dataset.computation === "complete"'
        ),
      `Monaco 完成 ${key}`,
      1000
    )
  }
  await open('notes/102.txt')
  assert.equal(
    await js(
      win,
      '(async () => (await document.fonts.load("16px codicon")).some(font => font.status === "loaded"))()'
    ),
    true,
    '差异图标字体必须实际加载'
  )
  assert.match(await text(win), /只读对比/)
  assert.equal(await js(win, 'monaco.editor.getDiffEditors().length'), 1)
  assert.equal(await js(win, 'monaco.editor.getModels().length'), 2)
  assert.equal(
    await js(
      win,
      'monaco.editor.getEditors().every(e=>e.getOption(monaco.editor.EditorOption.readOnly))'
    ),
    true
  )
  const values = await js(win, 'monaco.editor.getModels().map(m=>m.getValue())')
  await js(win, 'monaco.editor.getDiffEditors()[0].getModifiedEditor().focus()')
  win.webContents.sendInputEvent({ type: 'char', keyCode: 'Z' })
  await js(
    win,
    '(() => { const data = new DataTransfer(); data.setData("text/plain", "paste attempt"); document.activeElement.dispatchEvent(new ClipboardEvent("paste", {bubbles:true, clipboardData:data})); })()'
  )
  assert.deepEqual(await js(win, 'monaco.editor.getModels().map(m=>m.getValue())'), values)
  await click('下一处差异')
  await click('上一处差异')
  const workers = await js(win, 'window.__diffWorkers')
  assert.ok(
    workers.some(
      (worker) =>
        worker.url.startsWith('blob:') &&
        worker.sent > 0 &&
        worker.received > 0 &&
        !worker.errors.length
    ),
    `生产构建必须实际使用内联 Worker：${JSON.stringify(workers)}；${errors.join('\n')}`
  )
  const imagePath = path.join(os.tmpdir(), 'oss-diff-smoke-light.png')
  if (await js(win, 'document.documentElement.classList.contains("dark")'))
    win.webContents.send('menu:action', 'view:toggle-theme')
  await js(win, 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  fs.writeFileSync(imagePath, (await win.webContents.capturePage()).toPNG())
  console.log(`PASS Diff 分页、只读双栏、真实 Worker、前后跳转（截图 ${imagePath}）`)
  await js(win, 'document.querySelector("button[title=返回差异列表]").click()')
  await until(() => js(win, 'monaco.editor.getModels().length===0'), '释放 Monaco 模型')
  assert.equal(
    await js(win, 'document.querySelector("[data-testid=diff-list-scroll]").scrollTop'),
    position
  )
  for (const failure of ['editor', 'capability', 'second-model', 'view', 'binding']) {
    await js(
      win,
      `(() => {
      const api = monaco.editor;
      const createEditor = api.createDiffEditor;
      const createModel = api.createModel;
      window.__restoreDiffInitialization = () => {
        api.createDiffEditor = createEditor;
        api.createModel = createModel;
      };
      const failure = ${JSON.stringify(failure)};
      let models = 0;
      api.createModel = (...args) => {
        if (failure === 'second-model' && ++models === 2) throw new Error('模拟第二个模型初始化失败');
        return createModel(...args);
      };
      api.createDiffEditor = (...args) => {
        if (failure === 'editor') throw new Error('模拟编辑器初始化失败');
        const instance = createEditor(...args);
        if (failure === 'capability') instance.getDiffComputationResult = undefined;
        if (failure === 'view') instance.createViewModel = () => { throw new Error('模拟 viewModel 初始化失败'); };
        if (failure === 'binding') {
          const bind = instance.setModel.bind(instance);
          let failed = false;
          instance.setModel = (...values) => {
            const result = bind(...values);
            if (!failed) { failed = true; throw new Error('模拟绑定后初始化失败'); }
            return result;
          };
        }
        return instance;
      };
    })()`
    )
    try {
      await js(
        win,
        'document.querySelector(\'button[aria-label="查看 notes/102.txt 的 Diff"]\').click()'
      )
      await until(
        async () => (await text(win)).includes('对比视图加载失败'),
        `Error Boundary 捕获 ${failure}`
      )
      assert.equal(
        await js(win, 'monaco.editor.getDiffEditors().length'),
        0,
        `${failure} 后编辑器必须释放`
      )
      assert.equal(
        await js(win, 'monaco.editor.getEditors().length'),
        0,
        `${failure} 后子编辑器必须释放`
      )
      assert.equal(
        await js(win, 'monaco.editor.getModels().length'),
        0,
        `${failure} 后模型必须释放`
      )
    } finally {
      await js(
        win,
        'window.__restoreDiffInitialization(); delete window.__restoreDiffInitialization'
      )
      await js(win, 'document.querySelector("button[title=返回差异列表]").click()')
    }
    await open('notes/102.txt')
    await js(win, 'document.querySelector("button[title=返回差异列表]").click()')
    await until(() => js(win, 'monaco.editor.getModels().length === 0'), '恢复后正常卸载')
  }
  console.log('PASS 五种初始化故障由 Error Boundary 捕获、编辑器与模型零残留、恢复后可重新打开')
  await click('上一页')
  await until(
    () => js(win, '!!document.querySelector(\'button[aria-label="查看 bom.txt 的 Diff"]\')'),
    '返回第一页'
  )
  await open('bom.txt')
  assert.match(await text(win), /正文相同，原始字节存在差异/)
  await js(win, 'document.querySelector("button[title=返回差异列表]").click()')
  await open('eol.txt')
  assert.match(await text(win), /CRLF/)
  await js(win, 'document.querySelector("button[title=返回差异列表]").click()')
  console.log('PASS Diff BOM 和换行元信息')
  await open('long.txt')
  assert.equal(await js(win, 'monaco.editor.getModels()[0].getValueLength()'), 5 * 1024 * 1024)
  await js(win, 'document.querySelector("button[title=返回差异列表]").click()')
  console.log('PASS Diff 5 MB 长行')
  await open('many.txt')
  await js(win, 'document.querySelector("button[title=返回差异列表]").click()')
  console.log('PASS Diff 65000 行文本')
  await open('budget.txt')
  await js(win, 'monaco.editor.getDiffEditors()[0].updateOptions({maxComputationTime: 1})')
  await until(
    () =>
      js(
        win,
        'document.querySelector("[data-testid=diff-editor]")?.dataset.computation === "incomplete"'
      ),
    '计算超时明确提示',
    700
  )
  await click('继续计算')
  await until(
    () =>
      js(
        win,
        'document.querySelector("[data-testid=diff-editor]")?.dataset.computation === "complete"'
      ),
    '继续计算完成',
    1000
  )
  console.log('PASS Diff 计算超时和继续计算')
  const oldBounds = win.getBounds()
  win.setSize(1000, 740)
  win.webContents.send('menu:action', 'view:toggle-theme')
  await until(
    () =>
      js(
        win,
        'document.documentElement.classList.contains("dark") && !!document.querySelector(".monaco-editor.vs-dark")'
      ),
    '真实主题切换'
  )
  await js(win, 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  fs.writeFileSync(
    path.join(os.tmpdir(), 'oss-diff-smoke-dark.png'),
    (await win.webContents.capturePage()).toPNG()
  )
  win.setBounds(oldBounds)
  console.log('PASS BOM、换行、恰好 5 MB 长行、大文本、计算超时与继续计算、主题和窗口尺寸')
  await js(win, 'document.querySelector("button[title=返回差异列表]").click()')

  // 打开时重读，已相同的文件必须移出列表。
  fs.writeFileSync(path.join(localDir, 'bom.txt'), objects.get('bom.txt'))
  await js(win, 'document.querySelector(\'button[aria-label="查看 bom.txt 的 Diff"]\').click()')
  await until(async () => (await text(win)).includes('两端内容现在已经一致'), '相同文件移除')
  await js(win, 'document.querySelector("button[title=返回差异列表]").click()')
  assert.equal((await state()).state.different, 107)

  let release
  setGate(
    new Promise((resolve) => {
      release = resolve
    })
  )
  const heads = traffic.length
  await click('重新扫描')
  await until(() => traffic.length > heads, 'Diff 在途读取')
  assert.equal((await js(other, 'window.electronAPI.startOssSync("upload")')).ok, false)
  assert.equal((await js(other, 'window.electronAPI.startOssDiff()')).ok, false)
  const rejectedWrite = await js(
    other,
    'window.electronAPI.putOssObjectText("refreshed","a.txt","blocked",{etag:"bad",versionId:null})'
  )
  assert.equal(rejectedWrite.ok, false)
  await click('取消扫描')
  assert.equal((await state()).busy, true)
  release()
  setGate(null)
  await until(
    async () => (await state()).state.phase === 'cancelled' && !(await state()).busy,
    '取消释放读取占用'
  )
  await js(
    win,
    'document.querySelector("[data-testid=diff-page] button[title=返回文件列表]").click()'
  )
  await until(async () => !(await state()).state, '结束差异会话')

  // 页面刷新直接取消只读任务，不弹覆盖确认。
  setGate(
    new Promise((resolve) => {
      release = resolve
    })
  )
  const beforeReload = traffic.length
  await click('Diff')
  await until(() => traffic.length > beforeReload, '刷新前读取')
  const reloaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
  win.webContents.reload()
  release()
  setGate(null)
  await reloaded
  await until(async () => !(await state()).state && !(await state()).busy, '刷新清理会话')

  setGate(
    new Promise((resolve) => {
      release = resolve
    })
  )
  const beforeClose = traffic.length
  assert.equal((await js(other, 'window.electronAPI.startOssDiff()')).ok, true)
  await until(() => traffic.length > beforeClose, '关闭前读取')
  const closed = new Promise((resolve) => other.once('closed', resolve))
  other.close()
  await closed
  release()
  setGate(null)
  await until(async () => !(await state()).busy, '关闭窗口取消读取并释放占用')
  assert.equal(writes.length, writeCount)
  const after = fs.statSync(path.join(localDir, 'notes/102.txt'))
  assert.equal(after.mtimeMs, before.mtimeMs)
  assert.equal(after.size, before.size)
  assert.equal(errors.length, 0, errors.join('\n'))
  win.webContents.removeListener('console-message', listener)
  console.log('PASS 打开时重读、跨窗口互斥与归属、取消/刷新/关闭清理、无本地或 OSS 写入')
}
