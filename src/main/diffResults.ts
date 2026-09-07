import { DIFF_PAGE_SIZE } from '../shared/constants'
import type { DiffPage } from '../shared/types'

/** 按内容变更失效，而非按数量失效；同 key 的大小/时间更新也不能留在旧快照中。 */
export class DiffResults<T extends { key: string }> {
  private items = new Map<string, T>()
  private sorted: T[] | null = null
  get size(): number {
    return this.items.size
  }
  get(key: string): T | undefined {
    return this.items.get(key)
  }
  has(key: string): boolean {
    return this.items.has(key)
  }
  set(key: string, item: T): void {
    this.items.set(key, item)
    this.sorted = null
  }
  delete(key: string): boolean {
    const deleted = this.items.delete(key)
    if (deleted) this.sorted = null
    return deleted
  }
  page(offset: number): DiffPage<T> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('无效的分页位置')
    this.sorted ??= [...this.items.values()].sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0
    )
    return { items: this.sorted.slice(offset, offset + DIFF_PAGE_SIZE), total: this.sorted.length }
  }
}
