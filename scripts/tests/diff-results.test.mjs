import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from './source-loader.mjs'

test('结果按 key 排序，连续翻页复用快照；元信息和同数量替换都会失效', () => {
  const { DiffResults } = sourceLoader()('src/main/diffResults.ts')
  const results = new DiffResults()
  let keyReads = 0
  for (let i = 104; i >= 0; i--) {
    const key = `${String(i).padStart(3, '0')}.txt`
    results.set(key, {
      get key() {
        keyReads++
        return key
      },
      size: i
    })
  }
  const first = results.page(0)
  assert.equal(first.items.length, 100)
  assert.equal(first.items[0].key, '000.txt')
  const afterFirst = keyReads
  const second = results.page(100)
  results.page(0)
  assert.equal(keyReads, afterFirst, '连续翻页不得重新读取所有 key 进行排序')
  assert.equal(second.items.length, 5)
  assert.equal(second.items[0].key, '100.txt')
  results.set('000.txt', { key: '000.txt', size: 999 })
  assert.equal(results.page(0).items[0].size, 999)
  results.delete('000.txt')
  results.set('999.txt', { key: '999.txt', size: 999 })
  assert.equal(results.size, 105)
  assert.equal(results.page(0).items[0].key, '001.txt')
  assert.equal(results.page(100).items.at(-1).key, '999.txt')
  results.delete('999.txt')
  results.set('000.txt', { key: '000.txt', size: 1 })
  assert.equal(results.page(0).items[0].key, '000.txt')
  for (const offset of [-1, 0.5, NaN, Infinity])
    assert.throws(() => results.page(offset), /分页位置/)
})
