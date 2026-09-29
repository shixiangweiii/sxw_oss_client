import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as workerThreads from 'node:worker_threads'
import vm from 'node:vm'
import ts from 'typescript'

const loaderPath = fileURLToPath(import.meta.url)
/** 保持真实线程边界，只把编译产物入口映射到当前 TS 源码，不依赖旧 out/。 */
class SourceWorker extends workerThreads.Worker {
  constructor(filename, options) {
    const file = filename.replace(/\.js$/, '.ts')
    super(
      `import(${JSON.stringify(pathToFileURL(loaderPath).href)}).then(({ sourceLoader }) => sourceLoader()(${JSON.stringify(file)}));`,
      {
        ...options,
        eval: true
      }
    )
  }
}

/** 直接执行仓库 TS 源码；替身只放在 IPC/SDK 等外部边界，不生成文件。 */
export function sourceLoader(overrides = {}, globals = {}) {
  const cache = new Map()
  function load(file) {
    const path = resolve(file)
    if (cache.has(path)) return cache.get(path).exports
    const module = { exports: {} }
    cache.set(path, module)
    const nativeRequire = createRequire(path)
    const source = ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true
      }
    }).outputText
    const require = (name) => {
      if (Object.hasOwn(overrides, name)) return overrides[name]
      if (name === 'worker_threads') return { ...workerThreads, Worker: SourceWorker }
      if (name.startsWith('.')) return load(resolve(dirname(path), name + '.ts'))
      return nativeRequire(name)
    }
    vm.runInNewContext(
      source,
      {
        exports: module.exports,
        module,
        require,
        __dirname: dirname(path),
        Buffer,
        TextEncoder,
        AbortController,
        setTimeout,
        clearTimeout,
        console,
        ...globals
      },
      { filename: path }
    )
    return module.exports
  }
  return load
}

export function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
export const tick = () => new Promise((r) => setImmediate(r))
