#!/usr/bin/env node
/**
 * 生成占位应用图标：resources/icon.png（1024×1024）与 resources/icon.icns。
 *
 * 纯 Node 手写 PNG 编码，不引入任何图形依赖；再用 macOS 自带的 sips / iconutil 转 icns。
 * 这只是让打包链路开箱能跑通的占位图，正式图标请把自己的 1024×1024 PNG 放到
 * resources/icon.png 后重新执行本脚本（会跳过绘制、直接转换）。
 */
import { deflateSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SIZE = 1024

// ---------- 最小 PNG 编码器（RGBA / 8bit / 无滤波） ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([length, typeBuf, data, crc])
}

function encodePng(width, height, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------- 绘制 ----------

/** 圆角矩形的有向距离场，返回 0~1 的覆盖率（带 1px 软边做抗锯齿） */
function roundRectCoverage(px, py, x0, y0, x1, y1, radius) {
  const cx = Math.min(Math.max(px, x0 + radius), x1 - radius)
  const cy = Math.min(Math.max(py, y0 + radius), y1 - radius)
  const distance = Math.hypot(px - cx, py - cy)
  return Math.min(Math.max(radius - distance + 0.5, 0), 1)
}

function blend(pixels, index, r, g, b, a) {
  if (a <= 0) return
  const inv = 1 - a
  pixels[index] = Math.round(r * a + pixels[index] * inv)
  pixels[index + 1] = Math.round(g * a + pixels[index + 1] * inv)
  pixels[index + 2] = Math.round(b * a + pixels[index + 2] * inv)
  pixels[index + 3] = Math.round(255 * a + pixels[index + 3] * inv)
}

function draw() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4) // 全透明起手
  // macOS 图标惯例：内容留出约 10% 边距，圆角约为边长的 22%
  const margin = SIZE * 0.1
  const outer = { x0: margin, y0: margin, x1: SIZE - margin, y1: SIZE - margin }
  const outerRadius = (outer.x1 - outer.x0) * 0.22

  // 内部「窗口」：象征桌面应用
  const win = { x0: SIZE * 0.26, y0: SIZE * 0.32, x1: SIZE * 0.74, y1: SIZE * 0.68 }
  const winRadius = 36
  const titleBarBottom = win.y0 + 76

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4
      const px = x + 0.5
      const py = y + 0.5

      // 背景：自上而下的靛蓝 → 紫色渐变
      const bg = roundRectCoverage(px, py, outer.x0, outer.y0, outer.x1, outer.y1, outerRadius)
      if (bg > 0) {
        const t = (py - outer.y0) / (outer.y1 - outer.y0)
        blend(pixels, i, 79 + (124 - 79) * t, 70 + (58 - 70) * t, 229 + (237 - 229) * t, bg)
      }

      const winCoverage = roundRectCoverage(px, py, win.x0, win.y0, win.x1, win.y1, winRadius)
      if (winCoverage > 0) {
        if (py < titleBarBottom) {
          blend(pixels, i, 226, 232, 240, winCoverage * 0.97) // 标题栏：浅灰
        } else {
          blend(pixels, i, 255, 255, 255, winCoverage * 0.97) // 内容区：白
        }
      }

      // 标题栏左侧的三个红绿灯圆点
      const dotY = win.y0 + 38
      const colors = [
        [237, 106, 94],
        [245, 191, 79],
        [98, 197, 84]
      ]
      for (let d = 0; d < 3; d++) {
        const dotX = win.x0 + 40 + d * 46
        const coverage = Math.min(Math.max(13 - Math.hypot(px - dotX, py - dotY) + 0.5, 0), 1)
        if (coverage > 0) blend(pixels, i, ...colors[d], coverage)
      }
    }
  }

  return pixels
}

// ---------- 转 icns ----------

const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024]
]

function toIcns(basePngPath, outIcnsPath) {
  const workDir = mkdtempSync(join(tmpdir(), 'icns-'))
  const iconset = join(workDir, 'icon.iconset')
  execFileSync('mkdir', ['-p', iconset])
  for (const [name, size] of ICONSET) {
    execFileSync(
      'sips',
      ['-z', String(size), String(size), basePngPath, '--out', join(iconset, name)],
      {
        stdio: 'ignore'
      }
    )
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', outIcnsPath])
  rmSync(workDir, { recursive: true, force: true })
}

// ---------- main ----------

if (process.platform !== 'darwin') {
  console.error('本脚本依赖 macOS 自带的 sips / iconutil，只能在 macOS 上运行。')
  process.exit(1)
}

const pngPath = join(ROOT, 'resources', 'icon.png')
const icnsPath = join(ROOT, 'resources', 'icon.icns')

if (existsSync(pngPath) && process.argv.includes('--keep-png')) {
  console.log('沿用已有的 resources/icon.png')
} else {
  writeFileSync(pngPath, encodePng(SIZE, SIZE, draw()))
  console.log(`已生成 resources/icon.png（${readFileSync(pngPath).length} 字节）`)
}

toIcns(pngPath, icnsPath)
console.log(`已生成 resources/icon.icns（${readFileSync(icnsPath).length} 字节）`)
