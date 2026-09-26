/**
 * 存储位置与文件系统端口（FsPort）。
 * ==================================================================
 * 「md 文件是唯一真相源」意味着 db 层所有写操作最终落到用户文档目录下的文件。
 * 为了同时满足两个约束：
 *   1. 应用内通过 Tauri 插件（`plugin-fs`，受 capabilities 的 fs scope 约束）读写；
 *   2. 自检脚本在**纯 Node**（无 Tauri）下用真实临时目录跑同一套 db 代码，
 * 这里把文件系统抽象成 {@link FsPort}，由外部注入实现：
 *   - 生产：`resolveStorage()` 解析 `documentDir()/纸笺` 并返回 Tauri 端口；
 *   - 自检：`configureStorage({ fs: nodeFsPort, vaultRoot: 临时目录, … })`。
 *
 * 目录布局（详见 docs/ARCHITECTURE.md §4.12）：
 * ```
 * <文档>/纸笺/                  ← vault 根（documentDir + 纸笺，不存在则创建）
 *   ├─ 我的笔记.md              ← 收件箱（根目录即收件箱）
 *   ├─ 工作/                    ← 文件夹 = 子目录
 *   │   ├─ 项目.md
 *   │   └─ 子目录/
 *   ├─ .trash/                  ← 软删除（保留文件）
 *   └─ .paper/                  ← 元数据（tags.json / folders.json / trash.json / migrated.json）
 * ```
 */

import type Database from '@tauri-apps/plugin-sql'
import { assertAbsolutePath, isAbsolutePath, joinPath, toRelPosix } from './paths'

/** 目录项 */
export interface DirEntryInfo {
  name: string
  isDirectory: boolean
  isFile: boolean
}

/** 文件元信息 */
export interface FileStatInfo {
  isDirectory: boolean
  isFile: boolean
  mtimeMs: number
  size: number
}

/** 文件系统端口：db 层只依赖这些能力 */
export interface FsPort {
  exists(path: string): Promise<boolean>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  readDir(path: string): Promise<DirEntryInfo[]>
  readTextFile(path: string): Promise<string>
  /** 二进制读取（t37：严格 UTF-8 校验与 sha256 校验用） */
  readFileBytes?(path: string): Promise<Uint8Array>
  writeTextFile(path: string, contents: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string, options?: { recursive?: boolean }): Promise<void>
  stat(path: string): Promise<FileStatInfo>
  copyFile(from: string, to: string): Promise<void>
}

/** 存储配置（绝对路径均为系统原生分隔符） */
export interface StorageConfig {
  fs: FsPort
  /** vault 根目录绝对路径：<文档>/纸笺 */
  vaultRoot: string
  /** 应用数据目录绝对路径（旧库备份、迁移日志落点） */
  appDataDir: string
  /** 旧 SQLite 库绝对路径（迁移源 + 索引库） */
  legacyDbPath: string
}

/** vault 目录名（中文系统显示为「文档」，实际路径为 <用户>/Documents） */
export const VAULT_DIR_NAME = '纸笺'

/** 软删除目录名（vault 根下） */
export const TRASH_DIR_NAME = '.trash'

/** 元数据目录名（vault 根下） */
export const META_DIR_NAME = '.paper'

/** 索引库文件名（位于应用数据目录） */
export const INDEX_DB_FILE = 'zhijian.db'

/**
 * "当前数据目录"的持久化文件名（位于**应用数据目录**，不在 vault 内 —— 因此换目录时
 * 不会被复制/搬走，也不会随 vault 一起被搬错）。t37：设置面板更换数据目录后写这里，
 * `resolveStorage()` 启动时优先读它，从而让切换在重启后依然生效。
 */
export const VAULT_LOCATION_FILE = 'vault-location.json'

let storage: StorageConfig | null = null

/**
 * 注入存储配置（自检 / 测试用；生产由 resolveStorage() 解析）。
 * **在注入点就校验绝对路径**（t28）：让"根目录为空/相对"这种配置错误立刻暴露，
 * 而不是等到某次写文件时把文件丢进进程工作目录。
 */
export function configureStorage(config: StorageConfig): void {
  assertAbsolutePath(config.vaultRoot, '文件存储根目录（vaultRoot）异常')
  assertAbsolutePath(config.appDataDir, '应用数据目录（appDataDir）异常')
  assertAbsolutePath(config.legacyDbPath, '索引库路径（legacyDbPath）异常')
  storage = config
}

/** 清除注入（测试收尾用） */
export function resetStorage(): void {
  storage = null
}

/** 是否已配置存储 */
export function isStorageConfigured(): boolean {
  return storage !== null
}

/** 取存储配置；未配置时抛可读 Error */
export function getStorage(): StorageConfig {
  if (!storage) {
    throw new Error('文件存储尚未初始化：请先 await initDb()（或自检中调用 configureStorage()）')
  }
  return storage
}

/* --------------------- 数据目录位置持久化（t37） --------------------- */

/** 位置文件绝对路径（按注入的 appDataDir 计算，未初始化时也能算） */
export function vaultLocationFilePath(appDataDir?: string): string {
  const directory = appDataDir ?? getStorage().appDataDir
  return joinPath(directory, VAULT_LOCATION_FILE)
}

/**
 * 读取"已保存的数据目录"；不存在 / 损坏 / 非绝对路径 → 返回 null（调用方回落默认目录）。
 * 只读，不抛错。
 */
export async function loadVaultLocation(fs: FsPort, appDataDir: string): Promise<string | null> {
  try {
    const path = vaultLocationFilePath(appDataDir)
    if (!(await fs.exists(path))) return null
    const raw = await fs.readTextFile(path)
    const parsed: unknown = JSON.parse(raw)
    const value = typeof parsed === 'object' && parsed !== null ? (parsed as { vaultRoot?: unknown }).vaultRoot : null
    if (typeof value !== 'string' || value.length === 0 || !isAbsolutePath(value)) return null
    return value
  } catch {
    return null
  }
}

/**
 * 保存"当前数据目录"（更换数据目录的最后一步）。
 * 写失败会抛错 —— 调用方（relocateVault）据此判定"未切换"，保持原配置不变。
 */
export async function writeVaultLocation(vaultRoot: string): Promise<void> {
  const { fs, appDataDir } = getStorage()
  assertAbsolutePath(vaultRoot, '要保存的数据目录异常')
  await fs.mkdir(appDataDir, { recursive: true })
  await writeFileAtomic(vaultLocationFilePath(appDataDir), `${JSON.stringify({ vaultRoot }, null, 2)}\n`)
}

/** 库内相对路径（POSIX）→ 绝对路径（**强制绝对**：绝不回落到进程工作目录，见 t28） */
export function vaultPath(relPosix: string): string {
  const { vaultRoot } = getStorage()
  assertAbsolutePath(vaultRoot, '文件存储根目录（vaultRoot）异常')
  const rel = toRelPosix(relPosix)
  return rel.length === 0
    ? vaultRoot
    : assertAbsolutePath(joinPath(vaultRoot, rel), `库内路径非法（${rel}）`)
}

/** vault 根下的绝对路径（按段拼接，段内不转义） */
export function vaultJoin(...segments: string[]): string {
  const { vaultRoot } = getStorage()
  assertAbsolutePath(vaultRoot, '文件存储根目录（vaultRoot）异常')
  return assertAbsolutePath(joinPath(vaultRoot, ...segments), `库内路径非法（${segments.join('/')}）`)
}

/** `.paper/<name>` 的绝对路径 */
export function metaPath(name: string): string {
  return vaultJoin(META_DIR_NAME, name)
}

/**
 * 解析生产存储配置：
 *  - vault 根 = `documentDir()` + 「纸笺」（中文系统显示「文档」，实际是 Documents），
 *    不存在则创建；
 *  - 应用数据目录 = `appDataDir()`；
 *  - 旧库 = 应用数据目录 / zhijian.db。
 * 非 Tauri 环境抛可读 Error（调用方应在纯 Node 下先 configureStorage）。
 */
export async function resolveStorage(): Promise<StorageConfig> {
  if (storage) return storage
  const { isTauri } = await import('@/lib/tauri')
  if (!isTauri) {
    throw new Error('文件存储不可用：当前不在 Tauri 运行环境（自检请先 configureStorage()）')
  }
  const [{ documentDir, appDataDir }, fsPort] = await Promise.all([
    import('@tauri-apps/api/path'),
    Promise.resolve(createTauriFsPort()),
  ])
  const [documents, appData] = await Promise.all([documentDir(), appDataDir()])
  // t28 加固：系统 API 万一返回空串/相对路径，绝不能"相对 CWD"写文件
  assertAbsolutePath(documents, '系统文档目录（documentDir()）异常')
  assertAbsolutePath(appData, '系统应用数据目录（appDataDir()）异常')
  const defaultVault = assertAbsolutePath(joinPath(documents, VAULT_DIR_NAME), '库根目录（documentDir/纸笺）拼接异常')

  // t37：优先使用「设置里更换过的数据目录」（位置文件在应用数据目录，不随 vault 搬动）
  const saved = await loadVaultLocation(fsPort, appData)
  let vaultRoot = defaultVault
  if (saved && toRelPosix(saved) !== toRelPosix(defaultVault)) {
    try {
      assertAbsolutePath(saved, '已保存的数据目录异常')
      await fsPort.mkdir(saved, { recursive: true })
      vaultRoot = saved
    } catch (error) {
      // 换了目录但目标不可用（被删/无权限）→ 回落默认目录，不让应用打不开
      console.warn(`[纸笺] 已保存的数据目录不可用，回退到默认目录：${String(error)}`)
    }
  }

  const config: StorageConfig = {
    fs: fsPort,
    vaultRoot,
    appDataDir: appData,
    legacyDbPath: assertAbsolutePath(joinPath(appData, INDEX_DB_FILE), '索引库路径拼接异常'),
  }
  await config.fs.mkdir(vaultRoot, { recursive: true })
  storage = config
  return config
}

/** Tauri 端口：全部走 plugin-fs（capabilities 已授予 document/appdata 递归读写） */
export function createTauriFsPort(): FsPort {
  return {
    async exists(path) {
      const { exists } = await import('@tauri-apps/plugin-fs')
      return exists(path)
    },
    async mkdir(path, options) {
      const { mkdir } = await import('@tauri-apps/plugin-fs')
      await mkdir(path, { recursive: options?.recursive ?? false })
    },
    async readDir(path) {
      const { readDir } = await import('@tauri-apps/plugin-fs')
      const entries = await readDir(path)
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory,
        isFile: entry.isFile,
      }))
    },
    async readTextFile(path) {
      const { readTextFile } = await import('@tauri-apps/plugin-fs')
      return readTextFile(path)
    },
    async readFileBytes(path) {
      const { readFile } = await import('@tauri-apps/plugin-fs')
      return readFile(path)
    },
    async writeTextFile(path, contents) {
      const { writeTextFile } = await import('@tauri-apps/plugin-fs')
      await writeTextFile(path, contents)
    },
    async rename(from, to) {
      const { rename } = await import('@tauri-apps/plugin-fs')
      await rename(from, to)
    },
    async remove(path, options) {
      const { remove } = await import('@tauri-apps/plugin-fs')
      await remove(path, { recursive: options?.recursive ?? false })
    },
    async stat(path) {
      const { stat } = await import('@tauri-apps/plugin-fs')
      const info = await stat(path)
      return {
        isDirectory: info.isDirectory,
        isFile: info.isFile,
        mtimeMs: info.mtime ? new Date(info.mtime).getTime() : 0,
        size: typeof info.size === 'number' ? info.size : 0,
      }
    },
    async copyFile(from, to) {
      const { copyFile } = await import('@tauri-apps/plugin-fs')
      await copyFile(from, to)
    },
  }
}

/** 原子写文本文件：先写同目录临时文件，再 rename 覆盖（避免崩溃留下半截 md） */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const { fs } = getStorage()
  const tempPath = `${path}.tmp-${Math.random().toString(36).slice(2, 10)}`
  await fs.writeTextFile(tempPath, contents)
  try {
    await fs.rename(tempPath, path)
  } catch (error) {
    // rename 失败时清理临时文件，再原样抛出（调用方决定是否回滚）
    try {
      await fs.remove(tempPath)
    } catch {
      /* 清理失败不影响主错误 */
    }
    throw error
  }
}

/** 兜底：把「旧库「zhijian.db」」备份到应用数据目录，返回备份绝对路径 */
export async function backupFile(sourcePath: string, suffix: string): Promise<string> {
  const { fs, appDataDir } = getStorage()
  const target = joinPath(appDataDir, `${basenameForBackup(sourcePath)}.bak-${suffix}`)
  await fs.copyFile(sourcePath, target)
  return target
}

function basenameForBackup(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index < 0 ? path : path.slice(index + 1)
}

/** 便捷：迁移日志追加（失败不抛，避免日志问题影响数据迁移） */
export async function appendVaultLog(message: string): Promise<void> {
  const { fs } = getStorage()
  const line = `[${new Date().toISOString()}] ${message}\n`
  const logPath = metaPath('migration.log')
  try {
    const previous = (await fs.exists(logPath)) ? await fs.readTextFile(logPath) : ''
    await fs.writeTextFile(logPath, previous + line)
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/** 自检/单测用：当前注入的 Database（避免循环依赖，只在需要时调用方传入） */
export type DbLike = Database
