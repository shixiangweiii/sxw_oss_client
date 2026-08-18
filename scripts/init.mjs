#!/usr/bin/env node
/**
 * 把脚手架改名成你自己的项目。
 *
 * 设计成幂等的：每一项的默认值都从当前文件里读，所以可以反复执行；
 * 模板里本来就是可用的真实值（不是 __PLACEHOLDER__），不跑这个脚本也能直接 npm run dev。
 */
import { createInterface } from 'node:readline/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stdin, stdout } from 'node:process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const read = (relativePath) => readFileSync(join(ROOT, relativePath), 'utf-8')
const write = (relativePath, content) => writeFileSync(join(ROOT, relativePath), content, 'utf-8')

function toKebabCase(input) {
  const kebab = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // 纯中文应用名会被过滤成空串，这时保留原包名让用户自己填
  return kebab || ''
}

function replaceFirstHeading(markdown, title) {
  return markdown.replace(/^#\s+.*$/m, `# ${title}`)
}

const pkg = JSON.parse(read('package.json'))
const builderYml = read('electron-builder.yml')
const currentAppId = builderYml.match(/^appId:\s*(.+)$/m)?.[1]?.trim() ?? 'com.example.app'
const currentAuthor = typeof pkg.author === 'object' ? (pkg.author?.name ?? '') : (pkg.author ?? '')

const rl = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) })
// 用异步迭代器逐行取，而不是 rl.question()：
// 管道输入时所有行会瞬间涌入，question() 只来得及接住第一行，之后的行会丢失并永久挂起。
// 迭代器带背压，交互式与 `printf ... | node scripts/init.mjs` 两种方式都能正确工作。
const lines = rl[Symbol.asyncIterator]()
const ask = async (question, fallback) => {
  stdout.write(`${question} [${fallback}]: `)
  const { value, done } = await lines.next()
  // 没有更多输入（EOF）时一律采用默认值，保证脚本不会卡住
  if (done) {
    stdout.write('\n')
    return fallback
  }
  return String(value ?? '').trim() || fallback
}

console.log('\n为你的项目填几项基本信息，直接回车即采用方括号里的当前值。\n')

const productName = await ask('应用显示名（菜单栏与窗口标题）', pkg.productName ?? 'My App')
const packageName = await ask('npm 包名', toKebabCase(productName) || pkg.name)
const appId = await ask(
  'macOS appId（反向域名，用于签名与系统识别）',
  currentAppId.startsWith('com.example.')
    ? `com.example.${packageName.replace(/[^a-z0-9]/g, '')}`
    : currentAppId
)
const description = await ask('一句话描述', pkg.description ?? '')
const author = await ask('作者', currentAuthor)

rl.close()

// package.json：只改这几个字段，其余（含键顺序）原样保留
pkg.name = packageName
pkg.productName = productName
pkg.description = description
pkg.author = author
write('package.json', `${JSON.stringify(pkg, null, 2)}\n`)

write('electron-builder.yml', builderYml.replace(/^appId:\s*.+$/m, `appId: ${appId}`))

write(
  'src/renderer/index.html',
  read('src/renderer/index.html').replace(/<title>.*<\/title>/, `<title>${productName}</title>`)
)

for (const doc of ['README.md', 'CLAUDE.md', 'AGENTS.md']) {
  try {
    write(doc, replaceFirstHeading(read(doc), productName))
  } catch {
    // 文档被删掉了也不影响改名
  }
}

console.log(`
改名完成：

  应用显示名   ${productName}
  npm 包名     ${packageName}
  appId        ${appId}

接下来：

  npm install
  npm run dev

图标目前是占位图。把自己的 1024×1024 PNG 放到 resources/icon.png，
再执行 npm run make-icon -- --keep-png 即可重新生成 icns。

本脚本已完成使命，可以删掉 scripts/init.mjs 和 package.json 里的 init 脚本。
`)
