import { parentPort, workerData } from 'worker_threads'
import { mergeTextCore } from './textMergeCore'
import { UnsupportedText } from './textMergeFormat'

export type MergeWorkerResult =
  | { ok: true; value: { bytes: Uint8Array; blocks: number } | null }
  | { ok: false; unsupported: boolean; message: string }

if (!parentPort) throw new Error('文本合并计算只能在 Worker 内运行')
let result: MergeWorkerResult
try {
  const { localBytes, remoteBytes, timeout } = workerData
  result = {
    ok: true,
    value: mergeTextCore(Buffer.from(localBytes), Buffer.from(remoteBytes), timeout)
  }
} catch (error) {
  result = {
    ok: false,
    unsupported: error instanceof UnsupportedText,
    message: (error as Error)?.message ?? String(error)
  }
}
parentPort.postMessage(result)
parentPort.close()
