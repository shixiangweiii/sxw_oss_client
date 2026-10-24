import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from './source-loader.mjs'

const { parseSyncIgnore, SyncIgnore } = sourceLoader()('src/main/syncIgnore.ts')

test('sync_ignore 拆分空白、空项、去重；空配置不排除', () => {
  assert.deepEqual(Array.from(parseSyncIgnore(' .git, , .idea , .git,')), ['.git', '.idea'])
  for (const value of [undefined, '', ' , , '])
    assert.equal(new SyncIgnore(parseSyncIgnore(value)).matches('.git', true), false)
})

test('当前四项规则匹配任意层级及隐藏名称，完整名称且大小写敏感', () => {
  const ignore = new SyncIgnore(parseSyncIgnore('.git,.gitignore,.DS_Store,.idea'))
  for (const name of ['.git', '.gitignore', '.DS_Store', '.idea'])
    for (const prefix of ['', 'project/', 'a/b/'])
      for (const directory of [false, true])
        assert.equal(ignore.matches(prefix + name, directory), true, prefix + name)
  for (const key of ['.github', '.gitignore.bak', 'my.git', '.Idea', 'a/.ds_store'])
    assert.equal(ignore.matches(key, true), false, key)
})

test('glob 支持名称 * 和 ?、跨目录 **、目录限定及根相对路径', () => {
  const cases = [
    ['*.log', 'a/b/.debug.log', false, true],
    ['*.log', 'a/b/debug.txt', false, false],
    ['file?.txt', 'a/file中.txt', false, true],
    ['file?.txt', 'a/file12.txt', false, false],
    ['build/', 'a/build', true, true],
    ['build/', 'a/build', false, false],
    ['/build/', 'build', true, true],
    ['/build/', 'a/build', true, false],
    ['docs/private/**', 'docs/private', true, true],
    ['docs/private/**', 'docs/private', false, false],
    ['docs/private/**', 'docs/private/a/b.txt', false, true],
    ['docs/private/**', 'project/docs/private/a.txt', false, false],
    ['docs/**/temp?.txt', 'docs/temp1.txt', false, true],
    ['docs/**/temp?.txt', 'docs/a/b/temp2.txt', false, true],
    ['docs/*/temp?.txt', 'docs/a/b/temp2.txt', false, false],
    ['**/.cache/**', '.cache', true, true],
    ['**/.cache/**', 'a/.cache', true, true],
    ['*.log', 'a/with\nnewline.log', false, true],
    ['a\\b.txt', 'dir/a\\b.txt', false, true],
    ['[draft].txt', '[draft].txt', false, true],
    ['[draft].txt', 'd.txt', false, false]
  ]
  for (const [pattern, key, directory, expected] of cases)
    assert.equal(new SyncIgnore([pattern]).matches(key, directory), expected, `${pattern}: ${key}`)
})

test('无效路径规则明确报错，避免默默丢失排除意图', () => {
  for (const pattern of ['/', 'a//b', '../a', 'a/./b', 'a\0b'])
    assert.throws(() => new SyncIgnore([pattern]), /无效的 sync_ignore/)
})
