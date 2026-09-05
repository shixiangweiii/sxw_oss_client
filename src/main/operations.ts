/** 同步和在线保存共用一个主进程闸门，检查与占用之间没有 await。 */
let syncRunning = false
let textWrites = 0

export function assertSyncIdle(): void {
  if (syncRunning) throw new Error('同步进行中，请等待完成或取消同步')
}

export function reserveSync(): () => void {
  assertSyncIdle()
  if (textWrites) throw new Error('文件正在保存，请等待保存完成后再同步')
  syncRunning = true
  return () => {
    syncRunning = false
  }
}

export async function withTextWrite<T>(work: () => Promise<T>): Promise<T> {
  assertSyncIdle()
  textWrites++
  try {
    return await work()
  } finally {
    textWrites--
  }
}
