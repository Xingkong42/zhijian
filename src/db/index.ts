/**
 * DB 连接、初始化、全文检索能力探测（FROZEN 签名 + db 成员实现）。
 * ==================================================================
 * t15 起启动序列变成「**文件优先**」：
 *   1. `Database.load(DB_URL)`：打开 SQLite（它现在只是**索引**）；
 *   2. 版本化迁移 v1/v2（记录在 `_zj_migrations`，见 2_fts_trigram.sql 头注释）；
 *   3. `resolveStorage()`：解析「文档目录/纸笺」并确保目录存在；
 *   4. `migrateLegacyToVault()`：旧库有数据且 vault 为空 → **无损迁移成 md**
 *      （先备份旧库、暂存区生成 + 逐条校验、再原子落位；幂等、可重入）；
 *   5. `syncIndex()`：把文件投影进索引（迁移刚发生时整表重建，否则按 mtime 增量）；
 *   6. `refreshFtsState()`：刷新 trigram 可用性，供 searchRepo 选路径。
 *
 * 契约：全应用只有一个 Database 实例（`getDb()`）；`initDb()` 必须在启动时
 * await 一次；所有失败抛可读 Error（含中文上下文）。重复调用返回同一 Promise。
 */

import Database from '@tauri-apps/plugin-sql'
import { isTauri } from '@/lib/tauri'
import { getDb, isDbReady, setDb } from './connection'
import { syncIndex } from './indexer'
import { migrateLegacyToVault, type MigrationResult } from './migrate'
import {
  FTS_TRIGRAM_MIN_SQLITE_VERSION,
  MIGRATION_TABLE,
  SCHEMA_MIGRATIONS,
  SQL,
  TABLES,
  compareVersions,
  type Migration,
} from './schema'
import { getStorage, isStorageConfigured, resolveStorage } from './storage'

/** SQLite 连接串；与 src-tauri/tauri.conf.json 的 plugins.sql.preload 一致 */
export const DB_URL = 'sqlite:zhijian.db'

/* 冻结导出：实现载体在 ./connection（拆分只为打断 index ↔ indexer 的循环依赖） */
export { dbExecute, dbSelect, getDb, isDbReady } from './connection'
export type { SqlRow } from './connection'

/* 追加导出（t15）：索引重建 / 迁移 / 存储注入 */
export { rebuildIndex, syncIndex } from './indexer'
export { migrateLegacyToVault, type MigrationResult } from './migrate'
export { configureStorage, getStorage, isStorageConfigured, resetStorage, VAULT_DIR_NAME } from './storage'
/* 追加导出（t35）：索引变更信号 —— 派生视图（侧栏计数 / 标签 / 文件夹）订阅一次即可保持最新 */
export {
  INDEX_MUTATION_DEBOUNCE_MS,
  flushIndexMutatedNotifications,
  indexMutationListenerCount,
  notifyIndexMutated,
  onIndexMutated,
  resetIndexMutationListeners,
  type IndexMutationListener,
} from './events'
/* 追加导出（t37）：导入笔记 + 更换数据目录 */
export {
  DEFAULT_IMPORT_MAX_BYTES,
  formatImportResult,
  importMarkdownPaths,
  importProblems,
  type ImportFileResult,
  type ImportOptions,
  type ImportResult,
} from './import'
export {
  relocateVault,
  restoreVaultRoot,
  sha256Hex,
  vaultLocationFilePath,
  type RelocateOptions,
  type RelocateResult,
  type RelocateVerification,
} from './relocate'
export { loadVaultLocation, writeVaultLocation, VAULT_LOCATION_FILE } from './storage'

/** 全文检索策略：首选 trigram FTS5，兜底 LIKE 子串 */
export type SearchStrategy = 'fts5-trigram' | 'like'

/** 检索能力诊断快照（设置面板 / QA 可读） */
export interface FtsDiagnostics {
  strategy: SearchStrategy
  /** 运行时 SQLite 版本号，探测失败时为 null */
  sqliteVersion: string | null
  /** 编译期是否带 FTS5（ENABLE_FTS5） */
  fts5Compiled: boolean
  /** 是否已探测 */
  probed: boolean
  /** 是否已就绪（trigram 表存在且可用） */
  trigramReady: boolean
  /** 降级原因（中文可读），正常时为 null */
  reason: string | null
}

let initPromise: Promise<Database> | null = null

const fts: Omit<FtsDiagnostics, 'strategy'> = {
  sqliteVersion: null,
  fts5Compiled: false,
  probed: false,
  trigramReady: false,
  reason: null,
}

/** 中文检索是否走 FTS5 trigram（false = 走 LIKE 兜底） */
export function isFtsTrigramAvailable(): boolean {
  return fts.probed && fts.trigramReady
}

/** 当前生效的检索策略 */
export function getSearchStrategy(): SearchStrategy {
  return isFtsTrigramAvailable() ? 'fts5-trigram' : 'like'
}

/** 检索能力诊断（只读快照） */
export function getFtsDiagnostics(): FtsDiagnostics {
  return { strategy: getSearchStrategy(), ...fts }
}

/**
 * 笔记文件根目录绝对路径（设置面板展示 / 诊断用）。
 * 未初始化时返回空串（不抛错，便于 UI 在启动早期渲染）。
 */
export function getVaultRoot(): string {
  try {
    return isStorageConfigured() ? getStorage().vaultRoot : ''
  } catch {
    return ''
  }
}

/** 展示用：vault 根 + 索引库路径（设置面板「数据位置」） */
export function getStorageInfo(): { vaultRoot: string; indexDbPath: string } {
  try {
    const storage = getStorage()
    return { vaultRoot: storage.vaultRoot, indexDbPath: `sqlite:${storage.legacyDbPath}` }
  } catch {
    return { vaultRoot: '', indexDbPath: DB_URL }
  }
}

/**
 * 初始化：打开连接 → 版本化迁移 → 存储解析 → 旧库迁移 → 索引同步 → FTS 探测。
 * 重复调用返回同一个 Promise；失败后允许重试（例如首次因权限失败）。
 */
export function initDb(): Promise<Database> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    if (!isTauri) {
      throw new Error('数据库不可用：当前不在 Tauri 运行环境（请使用 pnpm tauri:dev 启动）')
    }
    let instance: Database
    try {
      instance = await Database.load(DB_URL)
    } catch (error) {
      throw new Error(`打开数据库失败（${DB_URL}）：${String(error)}`)
    }
    setDb(instance)

    try {
      // ---------- 1. 版本化迁移（v1 基础表 / v2 trigram，可选特性门控） ----------
      await instance.execute(
        `CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`,
      )
      const rows = await instance.select<{ version: number }[]>(
        `SELECT version FROM ${MIGRATION_TABLE} ORDER BY version ASC`,
      )
      const applied = new Set(rows.map((row) => Number(row.version)))
      const capability = await probeFts5Trigram(instance)

      for (const migration of SCHEMA_MIGRATIONS) {
        if (applied.has(migration.version)) continue
        if (migration.optional === true && !capability.available) {
          fts.reason = capability.reason
          continue
        }
        try {
          await applyMigration(instance, migration)
        } catch (error) {
          if (migration.optional !== true) throw error
          fts.reason = `可选迁移 v${migration.version} 执行失败，已降级：${error instanceof Error ? error.message : String(error)}`
        }
      }

      // ---------- 2. 文件存储（文档目录/纸笺）+ 旧库无损迁移 ----------
      await resolveStorage()
      const migration = await migrateLegacyToVault()
      reportMigration(migration)

      // ---------- 3. 索引：迁移刚发生→整表重建；否则按 mtime 增量 ----------
      await syncIndex({ full: migration.status === 'migrated' })

      // ---------- 4. FTS 能力状态（索引重建后重新探测） ----------
      await refreshFtsState(instance)
    } catch (error) {
      setDb(null)
      throw new Error(`数据库初始化失败：${String(error)}`)
    }

    return instance
  })()

  initPromise.catch(() => {
    initPromise = null
    setDb(null)
  })

  return initPromise
}

/** 迁移结果日志（只打印，不打扰用户；具体记录在 .paper/migrated.json 与 migration.log） */
function reportMigration(migration: MigrationResult): void {
  if (migration.status === 'migrated') {
    console.info(
      `[纸笺] 已把旧数据库迁移为 md 文件：${migration.notes} 条笔记 / ${migration.folders} 个文件夹 / ${migration.tags} 个标签` +
        `（备份：${migration.backupPath ?? '未找到旧库文件'}）`,
    )
    return
  }
  if (migration.reason && migration.reason !== 'legacy-empty') {
    console.info(`[纸笺] 未执行旧库迁移：${migration.reason}`)
  }
}

/** 在单条语句粒度执行一个迁移版本；整体失败时抛出可读 Error */
export async function applyMigration(instance: Database, migration: Migration): Promise<void> {
  for (const statement of migration.statements) {
    try {
      await instance.execute(statement)
    } catch (error) {
      throw new Error(`迁移 v${migration.version} 执行失败：${String(error)}\n语句：${statement.slice(0, 120)}`)
    }
  }
  await instance.execute(
    `INSERT OR REPLACE INTO ${MIGRATION_TABLE}(version, applied_at) VALUES ($1, $2)`,
    [migration.version, Date.now()],
  )
}

/** 关闭连接（测试/退出时使用） */
export async function closeDb(): Promise<void> {
  const instance = isDbReady() ? getDb() : null
  if (!instance) return
  await instance.close()
  setDb(null)
  initPromise = null
  fts.probed = false
  fts.trigramReady = false
  fts.reason = null
}

/* ============================ 内部实现 ============================ */

interface FtsCapability {
  available: boolean
  reason: string | null
}

/**
 * 探测 FTS5 + trigram 可用性：
 *  1. 编译开关 ENABLE_FTS5（sqlx 的 bundled libsqlite3-sys 默认打开）；
 *  2. `sqlite_version() >= 3.34.0`（trigram tokenizer 内置下限）。
 * 探测本身只读；任何异常都当作"不可用"处理（不抛错）。
 */
async function probeFts5Trigram(instance: Database): Promise<FtsCapability> {
  fts.probed = true
  try {
    const versionRows = await instance.select<{ version: string }[]>(SQL.sqliteVersion)
    const version = versionRows.length > 0 ? String(versionRows[0].version) : null
    fts.sqliteVersion = version

    const fts5Rows = await instance.select<{ name: string }[]>(SQL.compileOptionFts5)
    fts.fts5Compiled = fts5Rows.length > 0
    if (!fts.fts5Compiled) {
      return { available: false, reason: '当前 SQLite 未编译 FTS5（缺少 ENABLE_FTS5），检索使用 LIKE 子串路径' }
    }
    if (!version) {
      return { available: false, reason: '无法读取 sqlite_version()，检索使用 LIKE 子串路径' }
    }
    if (compareVersions(version, FTS_TRIGRAM_MIN_SQLITE_VERSION) < 0) {
      return {
        available: false,
        reason: `SQLite ${version} < ${FTS_TRIGRAM_MIN_SQLITE_VERSION}，无 trigram tokenizer，检索使用 LIKE 子串路径`,
      }
    }
    return { available: true, reason: null }
  } catch (error) {
    return { available: false, reason: `FTS5 能力探测失败，检索使用 LIKE 子串路径：${String(error)}` }
  }
}

/** 探测 + 确认 trigram 表确实存在；结果写入模块状态，供 searchRepo 读取 */
async function refreshFtsState(instance: Database): Promise<void> {
  const previousReason = fts.reason
  const capability = await probeFts5Trigram(instance)
  if (!capability.available) {
    fts.trigramReady = false
    fts.reason = previousReason ?? capability.reason
    return
  }
  try {
    const rows = await instance.select<{ name: string }[]>(SQL.tableExists, [TABLES.ftsTrigram])
    fts.trigramReady = rows.length > 0
    fts.reason = fts.trigramReady
      ? null
      : (previousReason ?? `trigram 索引表 ${TABLES.ftsTrigram} 不存在，检索使用 LIKE 子串路径`)
  } catch (error) {
    fts.trigramReady = false
    fts.reason = `trigram 索引表检查失败，检索使用 LIKE 子串路径：${String(error)}`
  }
}
