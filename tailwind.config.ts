import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx}'],
  // 暗色由 store 的 theme 驱动：document.documentElement.classList.toggle('dark', ...)
  darkMode: 'class',
  theme: {
    extend: {}
  },
  plugins: []
}

export default config
