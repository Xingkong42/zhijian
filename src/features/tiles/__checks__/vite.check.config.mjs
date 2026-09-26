/**
 * 磁贴自检用的独立构建配置（归属：编辑器成员 / t24）。
 *
 * 为什么需要：`pnpm vite:build` 的入口是 `index.html → main.tsx`，而 `main.tsx` 归 architect、
 * 目前还没有接 `<TileApp>`（t20 才接线）—— 所以生产构建**不会**打包 tiles 目录，
 * 单跑它无法证明磁贴代码可打包。这里把自检页当入口再打一遍，
 * 既验证「磁贴 + 它的动态 import + tile.css」能正常产出，也顺手给出体积。
 *
 * 运行：pnpm vite build --config src/features/tiles/__checks__/vite.check.config.mjs
 * 产物：node_modules/.tmp/tiles-check-dist（仓库外，不污染 src）
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const here = path.dirname(fileURLToPath(import.meta.url))
/** 仓库根目录：src/features/tiles/__checks__ → 上溯 4 层 */
const projectRoot = path.resolve(here, '../../../..')

export default defineConfig({
  root: projectRoot,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(projectRoot, 'src') } },
  build: {
    target: 'es2021',
    outDir: path.resolve(projectRoot, 'node_modules/.tmp/tiles-check-dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(here, 'harness.html'),
      output: { chunkFileNames: 'assets/[name]-[hash].js' },
    },
  },
})
