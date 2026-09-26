/**
 * ESM 解析钩子（仅自检使用，不参与打包）：
 *  1. `@tauri-apps/plugin-sql` → 本地 node:sqlite 替身；
 *  2. `@/lib/tauri`            → 替身（isTauri = true）；
 *  3. `@/...` 别名             → src/**；
 *  4. 无扩展名的相对导入        → 补 .ts / .tsx / index.ts
 *     （tsconfig 用 moduleResolution: bundler，Node 的 ESM 解析器需要这一层补全）。
 * TS 文件本身由 Node 24 内置的类型擦除直接执行（项目 tsconfig 已开启
 * erasableSyntaxOnly，源码全部是可擦除语法）。
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(here, '..', '..')

const STUBS = new Map([
  ['@tauri-apps/plugin-sql', path.join(here, 'stub-plugin-sql.mjs')],
  ['@/lib/tauri', path.join(here, 'stub-lib-tauri.mjs')],
])

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS.get(specifier)
  if (stub) return { url: pathToFileURL(stub).href, shortCircuit: true }

  if (specifier.startsWith('@/')) {
    const target = path.join(srcRoot, specifier.slice(2))
    const resolved = firstExisting([`${target}.ts`, `${target}.tsx`, path.join(target, 'index.ts')])
    if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true }
  }

  if (specifier.startsWith('.') && context.parentURL && context.parentURL.startsWith('file:')) {
    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier)
    if (!/\.[cm]?[jt]sx?$/.test(base)) {
      const resolved = firstExisting([`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')])
      if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true }
    }
  }

  return nextResolve(specifier, context)
}
