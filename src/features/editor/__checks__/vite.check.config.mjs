/**
 * 编辑器自检用的独立构建配置（归属：编辑器成员 / t4）。
 * 用 .mjs 而不是 .ts：tsconfig.app.json 的 include 覆盖整个 src/，
 * 而它没有开 esModuleInterop，`import path from 'node:path'` 会被类型检查拦下。
 *
 * 为什么需要它：生产构建的入口是 index.html → App.tsx，而 App.tsx 目前仍是骨架版
 * （按契约由集成成员 t10 接入 features/），所以 `pnpm vite build` 的产物里**没有**
 * 编辑器代码，无法用它衡量 CodeMirror / Shiki 的 chunk 体积。这个配置只把自检页
 * 作为入口打一遍，用来报告「编辑器真正入包时」的体积与代码分割情况。
 *
 * 运行：
 *   pnpm vite build --config src/features/editor/__checks__/vite.check.config.mjs
 * 产物：node_modules/.tmp/editor-check-dist（仓库外，不污染 src）
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const here = path.dirname(fileURLToPath(import.meta.url))
/** 仓库根目录：src/features/editor/__checks__ → 上溯 4 层 */
const projectRoot = path.resolve(here, '../../../..')

export default defineConfig({
  root: projectRoot,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(projectRoot, 'src') } },
  build: {
    target: 'es2021',
    outDir: path.resolve(projectRoot, 'node_modules/.tmp/editor-check-dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(here, 'harness.html'),
      output: { chunkFileNames: 'assets/[name]-[hash].js' },
    },
  },
})
