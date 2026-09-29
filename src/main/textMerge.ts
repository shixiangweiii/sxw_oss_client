import { createReadStream } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { MAX_TEXT_BYTES } from '../shared/constants'
import { checkCancelled, SyncCancelled } from './syncFiles'
import { MergeMarkerScanner, UnsupportedText } from './textMergeFormat'
import type { MergeWorkerResult } from './textMergeWorker'

export { MERGE_MARKERS, UnsupportedText, decodeMergeText, hasMergeMarkers } from './textMergeFormat'

export async function fileHasMergeMarkers(path: string, signal: AbortSignal): Promise<boolean> {
  const scanner = new MergeMarkerScanner()
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 })
  const abort = (): void => {
    stream.destroy(new SyncCancelled())
  }
  stream.on('error', () => {})
  signal.addEventListener('abort', abort, { once: true })
  try {
    checkCancelled(signal)
    for await (const chunk of stream) {
      checkCancelled(signal)
      if (scanner.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) return true
    }
    checkCancelled(signal)
    return scanner.finish()
  } finally {
    signal.removeEventListener('abort', abort)
    stream.destroy()
  }
}

/** Worker 只计算内存数据；墙钟预算由主进程独立控制，收尾必须等待线程退出。 */
export async function mergeText(
  localBytes: Buffer,
  remoteBytes: Buffer,
  signal: AbortSignal,
  timeout = 5000
): Promise<{ bytes: Buffer; blocks: number } | null> {
  checkCancelled(signal)
  if (localBytes.length > MAX_TEXT_BYTES || remoteBytes.length > MAX_TEXT_BYTES)
    throw new UnsupportedText('文本超过 5 MB，无法合并')
  const timeoutError = (): UnsupportedText =>
    new UnsupportedText('合并计算超过 5 秒预算，未写入本地文件')
  if (timeout <= 0) throw timeoutError()
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'textMergeWorker.js'), {
      workerData: { localBytes, remoteBytes, timeout }
    })
    let finishing = false
    const finish = async (error?: Error, result?: MergeWorkerResult): Promise<void> => {
      if (finishing) return
      finishing = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      try {
        // terminate 返回 Promise；在 exit 之前不能释放任务占用或接纳下一任务。
        await worker.terminate()
        checkCancelled(signal)
        if (error) throw error
        if (!result) throw new Error('合并线程未返回结果')
        if (!result.ok)
          throw result.unsupported ? new UnsupportedText(result.message) : new Error(result.message)
        resolve(
          result.value
            ? { bytes: Buffer.from(result.value.bytes), blocks: result.value.blocks }
            : null
        )
      } catch (failure) {
        reject(failure)
      } finally {
        worker.removeAllListeners()
      }
    }
    const abort = (): void => {
      void finish(new SyncCancelled())
    }
    worker.on('message', (result: MergeWorkerResult) => {
      void finish(undefined, result)
    })
    worker.on('error', (error) => {
      void finish(error)
    })
    worker.on('exit', (code) => {
      if (!finishing) void finish(new Error(`合并线程提前退出（${code}）`))
    })
    const timer = setTimeout(() => {
      void finish(timeoutError())
    }, timeout)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
