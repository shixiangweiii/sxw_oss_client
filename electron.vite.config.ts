import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// 生产环境的内容安全策略。
// 打包后渲染进程走 file:// 加载，webRequest.onHeadersReceived 对 file:// 不生效，
// 所以 CSP 只能落在 HTML 的 meta 上。
// 但 dev 模式下 @vitejs/plugin-react 会往 HTML 注入内联的 Fast Refresh preamble，
// 严格的 script-src 'self' 会把它拦掉、热更新就废了 —— 因此这条 meta 仅在 build 时注入。
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // React 的 style={{}} 内联样式属性受 style-src 约束，必须放开 unsafe-inline
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'"
].join('; ')

function injectCspPlugin(): Plugin {
  return {
    name: 'inject-prod-csp',
    apply: 'build',
    transformIndexHtml(html: string) {
      // 用 head-prepend 而不是拼字符串：CSP 必须出现在它要约束的 script 标签**之前**，
      // 而 Vite 是把打包后的 script 追加进 head 的，手工替换 </head> 会排在脚本后面、形同虚设。
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: PROD_CSP },
            injectTo: 'head-prepend'
          }
        ]
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    worker: { format: 'es' },
    resolve: {
      alias: {
        '@': resolve('src/renderer')
      }
    },
    plugins: [react(), injectCspPlugin()],
    css: {
      postcss: './postcss.config.js'
    }
    // 需要 Web Worker 时在这里加 worker: { format: 'es' }，
    // 否则 Vite 默认按 iife 打包，worker 里无法使用 import。
  }
})
