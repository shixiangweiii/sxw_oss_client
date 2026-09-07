/** 同步和在线保存共用一个主进程闸门，检查与占用之间没有 await。 */
let syncRunning = false
let textWrites = 0
let diffRunning = false
const diffListeners = new Set<() => void>()
const changeListeners = new Set<(bucket: string) => void>()

export function isDiffBusy(): boolean {
  return diffRunning
}
export function subscribeDiffBusy(listener: () => void): () => void {
  diffListeners.add(listener)
  return () => {
    diffListeners.delete(listener)
  }
}
export function subscribeContentChanges(listener: (bucket: string) => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}
export function notifyContentChanged(bucket: string): void {
  for (const listener of changeListeners) listener(bucket)
}

export function assertSyncIdle(): void {
  if (syncRunning) throw new Error('同步进行中，请等待完成或取消同步')
  if (diffRunning) throw new Error('Diff 正在读取，请等待完成或取消比较')
}

export function reserveDiff(): () => void {
  assertSyncIdle()
  if (textWrites) throw new Error('文件正在保存，请等待保存完成后再比较')
  diffRunning = true
  for (const listener of diffListeners) listener()
  let released = false
  return () => {
    if (released) return
    released = true
    diffRunning = false
    for (const listener of diffListeners) listener()
  }
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
