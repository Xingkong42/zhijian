/**
 * ESM 解析钩子（仅 t6 自检使用，不参与打包）。
 *
 * 为什么不用 db 层 loader：它的 `@/` 别名分支在本机 Node 24（Windows + 中文路径）下
 * 实测会落到 nextResolve（其扩展名补全对「已带扩展名 / 指向 index」的别名不生效），
 * 但它的两个替身文件仍然复用 —— 本文件自行解析别名，只借用
 * `stub-plugin-sql.mjs` / `stub-lib-tauri.mjs`。
 *
 * 映射：
 *   1. `@tauri-apps/plugin-sql`    → src/db/__checks__/stub-plugin-sql.mjs（node:sqlite 适配器）
 *   2. `@tauri-apps/plugin-dialog` → 本目录 stub-plugin-dialog.mjs
 *   3. `@tauri-apps/plugin-fs`     → 本目录 stub-plugin-fs.mjs
 *   4. `@/lib/tauri`               → stub-lib-tauri.mjs（isTauri = true，与 db 层一致）
 *   5. `@/...`                     → src/**（无扩展名补 .ts/.tsx/index.ts）
 *   6. 相对导入 / 绝对路径          → 无扩展名补 .ts/.tsx/index.ts；裸 Windows 路径转 file: URL
 * TS 文件由 Node 24 内置类型擦除直接执行（源码全部是可擦除语法）。
 *
 * 参数通过 `register(..., { data })` 传入：{ dbStubDir, dialogStub, fsStub, srcRoot }。
 * 注意：模块钩子运行在独立线程，`globalThis` 不跨线程共享，状态一律放本模块作用域。
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let srcRoot = ''
const stubs = new Map()
const relStubs = new Map()

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 解析一个「无扩展名 / 带扩展名 / 指向目录」的路径：
 *   - 已带 .ts/.tsx/… 时原样优先，再退化为补扩展名 / index
 *   - 无扩展名时依次尝试 .ts / .tsx / 原样 / index.ts / index.tsx
 */
function resolveFileOrIndex(base) {
  const hasExt = /\.[cm]?[jt]sx?$/.test(base)
  const candidates = hasExt
    ? [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]
    : [`${base}.ts`, `${base}.tsx`, base, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
  return firstExisting(candidates)
}

/** 是否「裸 Windows 绝对路径」（如 F:\a\b.mjs）—— Node 会把它误判成 f: 协议 */
function isBareWindowsPath(value) {
  return typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value)
}

export async function initialize(data) {
  const { dbStubDir, dialogStub, fsStub, srcRoot: root, tauriStub, openerStub, eventStub } = data ?? {}
  srcRoot = root
  stubs.set('@tauri-apps/plugin-sql', pathToFileURL(path.join(dbStubDir, 'stub-plugin-sql.mjs')).href)
  stubs.set('@tauri-apps/plugin-dialog', pathToFileURL(dialogStub).href)
  stubs.set('@tauri-apps/plugin-fs', pathToFileURL(fsStub).href)
  // t17：「在文件管理器中打开数据目录」用 plugin-opener
  stubs.set('@tauri-apps/plugin-opener', pathToFileURL(openerStub).href)
  // t31：`@tauri-apps/api/event` 换成"可观测 + 可派发"的替身，
  // 让「派发一次事件 → 动作执行恰好一次」成为可断言的事实（D1 防复发）
  if (eventStub) stubs.set('@tauri-apps/api/event', pathToFileURL(eventStub).href)
  // `@/lib/tauri` 用本目录自己的替身：比 db 层的更完整（含 t12 新增的三个封装，
  // 且把 IPC 调用做成可观测的假实现，供 t13 断言）
  relStubs.set('@/lib/tauri', pathToFileURL(tauriStub).href)
}

export async function load(url, context, nextLoad) {
  // 调用方直接 import('F:\\...\\x.mjs') 时，Node 传给钩子的是裸路径而不是 file: URL
  if (isBareWindowsPath(url)) {
    return nextLoad(pathToFileURL(url).href, context)
  }
  return nextLoad(url, context)
}

export async function resolve(specifier, context, nextResolve) {
  const stub = stubs.get(specifier) ?? relStubs.get(specifier)
  if (stub) return { url: stub, shortCircuit: true }

  if (specifier.startsWith('@/')) {
    const resolved = resolveFileOrIndex(path.join(srcRoot, specifier.slice(2)))
    if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true }
  }

  if (isBareWindowsPath(specifier)) {
    const resolved = resolveFileOrIndex(specifier)
    if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true }
  }

  if (specifier.startsWith('.') && context.parentURL && context.parentURL.startsWith('file:')) {
    // 用 fileURLToPath 而不是手写 pathname 处理：Windows 盘符 + 中文/空格目录
    // 都能正确解码，避免 existsSync 因路径编码不符而全部为 false。
    const parentDir = path.dirname(fileURLToPath(context.parentURL))
    const resolved = resolveFileOrIndex(path.resolve(parentDir, specifier))
    if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true }
  }

  return nextResolve(specifier, context)
}
