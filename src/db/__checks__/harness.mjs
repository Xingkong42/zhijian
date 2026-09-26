/**
 * 自检公共护栏（t28）—— 专治两类"偶发但危险"的问题：
 *
 * 1. **工作区污染**：任何把 `<临时卷>\纸笺\x` 误当**相对路径**的调用，都会在
 *    进程 CWD（= 仓库根目录）里落一个 `x`。这里把注入 db 层的 FsPort 包一层
 *    {@link guardFsPort}：**只允许"绝对路径且位于本次运行的临时根之内"**的访问，
 *    越界立即抛出点名到方法/路径的错误，并记入 `violations`。
 *    ⇒ "写进仓库"从"偶发且静默"变成"必然且刺眼"。
 * 2. **临时目录残留**：每个运行用 `mkdtemp` 的唯一根（{@link makeRunRoot}），
 *    并在 `finally` 里清理（各套件负责调用 {@link cleanupRunRoot}）。
 *
 * 另提供工作区快照/对比（{@link snapshotWorkspace} / {@link diffWorkspace}），
 * 供套件收尾断言「仓库根目录没有新增文件」。
 *
 * 只被 __checks__ 使用，不参与应用打包（纯 JS，不走 tsc）。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 清理**陈旧的**自检临时根（t28）。
 *
 * 为什么需要：清理虽在 `finally` 里，但进程被**外部杀掉**时它不会执行 ——
 * 最常见的触发方式就是在 PowerShell 里 `node 自检.mjs | Select-Object -First 3`
 * （管道提前关闭 → 上游进程被杀 → 临时根残留）。历史上就这样累积出 40+ 个残留目录。
 * 于是每次运行前顺手扫一遍 `%TEMP%`：只删**本套件前缀 + 超过 maxAgeMs 未动过**的目录，
 * 绝不碰正在使用的（新）目录，也绝不碰其它前缀。
 *
 * @param {{ prefix?: string, maxAgeMs?: number }} [options]
 * @returns {Promise<string[]>} 被清理的目录名
 */
export async function pruneStaleRunRoots(options = {}) {
  const prefix = options.prefix ?? 'zhijian-'
  const maxAgeMs = options.maxAgeMs ?? 60 * 60 * 1000
  const now = Date.now()
  const pruned = []
  let entries = []
  try {
    entries = await fsp.readdir(os.tmpdir(), { withFileTypes: true })
  } catch {
    return pruned
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
    const full = path.join(os.tmpdir(), entry.name)
    try {
      const info = await fsp.stat(full)
      if (now - info.mtimeMs < maxAgeMs) continue
      await fsp.rm(full, { recursive: true, force: true })
      pruned.push(entry.name)
    } catch {
      /* 正在被别的实例使用 / 权限问题：跳过 */
    }
  }
  return pruned
}

/**
 * 建一个**进程唯一**的临时根：
 *  - 先顺手清掉陈旧的同类临时根（被外部杀掉的运行留下的）；
 *  - `mkdtemp` 保证唯一（并发/残留都不会撞名）；
 *  - 并断言它确实是绝对路径、已存在、且带了随机后缀。
 *
 * @param {string} tag 用途标签（进入目录名前缀）
 * @returns {Promise<string>} 绝对路径
 */
export async function makeRunRoot(tag) {
  await pruneStaleRunRoots().catch(() => undefined)
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `zhijian-${tag}-`))
  if (!path.isAbsolute(root) || path.resolve(root) !== root) {
    throw new Error(`[自检护栏] 临时根不是绝对路径：${root}`)
  }
  if (!existsSync(root)) {
    throw new Error(`[自检护栏] 临时根创建后不存在：${root}`)
  }
  const suffix = path.basename(root).slice(`zhijian-${tag}-`.length)
  if (suffix.length < 4) {
    throw new Error(`[自检护栏] 临时根缺少随机后缀（可能撞名）：${root}`)
  }
  return root
}

/**
 * 清理临时根（幂等；失败不抛，避免掩盖真正的断言失败）
 * @param {string | null | undefined} root
 */
export async function cleanupRunRoot(root) {
  if (!root) return
  try {
    await fsp.rm(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

/**
 * 工作区快照：只记录**直接子项**（不遍历 node_modules），名字 → 类型/大小/mtime
 * @param {string} root
 * @returns {Map<string, {isDirectory: boolean, size: number, mtimeMs: number}>}
 */
export function snapshotWorkspace(root) {
  const snapshot = new Map()
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    let size = -1
    let mtimeMs = 0
    try {
      const info = statSync(path.join(root, entry.name))
      size = info.size
      mtimeMs = Math.trunc(info.mtimeMs)
    } catch {
      /* 读不到元信息也算"存在" */
    }
    snapshot.set(entry.name, { isDirectory: entry.isDirectory(), size, mtimeMs })
  }
  return snapshot
}

/**
 * 对比两份快照。**只有"新增文件"才算污染**（新增目录与本项内容变化仅报告）：
 * 其它成员可能同时跑构建（`dist/` 会被重写），只比名字可避免误报。
 *
 * @param {Map<string, {isDirectory: boolean, size: number, mtimeMs: number}>} before
 * @param {Map<string, {isDirectory: boolean, size: number, mtimeMs: number}>} after
 */
export function diffWorkspace(before, after) {
  const addedFiles = []
  const addedDirs = []
  for (const [name, info] of after) {
    if (before.has(name)) continue
    if (info.isDirectory) addedDirs.push(name)
    else addedFiles.push(name)
  }
  const removed = [...before.keys()].filter((name) => !after.has(name))
  const changed = [...after.keys()].filter((name) => {
    const previous = before.get(name)
    const current = after.get(name)
    if (!previous || !current) return false
    return previous.size !== current.size || previous.mtimeMs !== current.mtimeMs
  })
  return { addedFiles, addedDirs, removed, changed }
}

/**
 * 列出根目录下的 **0 字节文件**（t28：`x` 类垃圾文件的指纹）。
 *
 * 用途：收尾时"提示"这些已存在的可疑文件。**不判失败**——它们可能是本次运行之前
 * 由别的命令留下的（t28 事故现场就是这种：先有 0 字节 `x`，随后某次运行报 ENOENT），
 * 而"本 run 新增文件"才由 {@link diffWorkspace} 负责判失败。
 *
 * @param {string} root
 * @returns {string[]}
 */
export function listZeroByteRootFiles(root) {
  const found = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    try {
      if (statSync(path.join(root, entry.name)).size === 0) found.push(entry.name)
    } catch {
      /* ignore */
    }
  }
  return found
}

/**
 * 判定某个路径是否"绝对且在给定根之内" —— 护栏的判定核心。
 *
 * @param {string} root 允许的根（绝对路径）
 * @param {string} candidate 待检查路径
 * @returns {boolean}
 */
export function isInsideRoot(root, candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return false
  const allow = path.resolve(root)
  const resolved = path.resolve(candidate)
  return resolved === allow || resolved.startsWith(allow + path.sep)
}

/**
 * 断言某路径在给定根之内（供**绕过 FsPort 的直接 fs 调用**使用）。
 * 违规立即抛错 —— 与 guardFsPort 同一套判定，避免"直接 fs 写入"成为盲区。
 *
 * @param {string} root 允许的根（绝对路径）
 * @param {string} candidate 待检查路径
 * @param {string} label 出错时的调用者标签
 */
export function assertInsideRoot(root, candidate, label) {
  if (isInsideRoot(root, candidate)) return
  throw new Error(
    `[自检护栏] ${label} 直接操作了临时根之外的路径：${JSON.stringify(candidate)}` +
      `（本次运行临时根=${path.resolve(root)}）—— 这类调用会在仓库或 CWD 里制造垃圾文件，已阻止`,
  )
}

/**
 * 把 FsPort 包成"只在本次运行的临时根内可用"的护栏端口：
 *  - 每个**路径参数**都必须是绝对路径且位于 root 之内（数据参数除外）；
 *  - 违规立即抛错（附方法名与路径），并记入 `violations`。
 *
 * @param {object} port 真实 FsPort（node-fs-port.mjs）
 * @param {{ root: string, label: string }} options
 * @returns {{ port: object, violations: string[], root: string }}
 */
export function guardFsPort(port, options) {
  const allow = path.resolve(options.root)
  const violations = []

  /** 各方法的**路径参数下标**（绝不校验数据参数：writeTextFile 的第二个参数是内容） */
  const PATH_ARGS = {
    exists: [0],
    mkdir: [0],
    readDir: [0],
    readTextFile: [0],
    readFileBytes: [0],
    writeTextFile: [0],
    rename: [0, 1],
    remove: [0],
    stat: [0],
    copyFile: [0, 1],
  }

  const isInsideRoot = (candidate) => {
    if (!path.isAbsolute(candidate)) return false
    const resolved = path.resolve(candidate)
    return resolved === allow || resolved.startsWith(allow + path.sep)
  }

  const validate = (method, args) => {
    for (const index of PATH_ARGS[method] ?? []) {
      const arg = args[index]
      if (typeof arg !== 'string') continue
      if (isInsideRoot(arg)) continue
      const message =
        `[自检护栏] ${options.label}.${method}() 收到临时根之外/相对路径：${JSON.stringify(arg)}` +
        `（本次运行临时根=${allow}）—— 这类调用会在仓库或 CWD 里制造垃圾文件，已阻止`
      violations.push(message)
      throw new Error(message)
    }
  }

  const wrap = (method) => async (...args) => {
    validate(method, args)
    return port[method](...args)
  }

  return {
    port: {
      exists: wrap('exists'),
      mkdir: wrap('mkdir'),
      readDir: wrap('readDir'),
      readTextFile: wrap('readTextFile'),
      readFileBytes: wrap('readFileBytes'),
      writeTextFile: wrap('writeTextFile'),
      rename: wrap('rename'),
      remove: wrap('remove'),
      stat: wrap('stat'),
      copyFile: wrap('copyFile'),
    },
    violations,
    root: allow,
  }
}
