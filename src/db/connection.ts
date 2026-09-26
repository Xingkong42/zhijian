/**
 * 连接注册表 + repo 层统一读写入口。
 * ==================================================================
 * 单拆一个模块是为了打破循环依赖：
 *   `index.ts`（initDb 编排）→ `indexer.ts`（索引重建/同步）→ 本模块
 * 而 repo / vault / migrate 也只需要本模块的读写入口与错误包装。
 *
 * 契约（docs/ARCHITECTURE.md §4.3）：`getDb()` / `isDbReady()` 的冻结签名在
 * `src/db/index.ts` 上原样保留，这里只是实现载体。
 */

import type Database from '@tauri-apps/plugin-sql'
import type { QueryResult } from '@tauri-apps/plugin-sql'
import { DbError } from './errors'

/** 原始 SQL 行（TEXT/INTEGER 直出，repo 层负责映射成领域模型） */
export type SqlRow = Record<string, string | number | null>

let instance: Database | null = null

/** 由 initDb()/自检注入连接实例 */
export function setDb(next: Database | null): void {
  instance = next
}

/** 获取已初始化的 Database 实例；未初始化时抛错 */
export function getDb(): Database {
  if (!instance) {
    throw new Error('数据库尚未初始化：请先在应用启动时 await initDb()')
  }
  return instance
}

/** 是否已初始化完成 */
export function isDbReady(): boolean {
  return instance !== null
}

/** 执行写语句（INSERT/UPDATE/DELETE/CREATE…），失败抛可读 `DbError` */
export async function dbExecute(context: string, sql: string, values: unknown[] = []): Promise<QueryResult> {
  try {
    return await getDb().execute(sql, values)
  } catch (error) {
    throw new DbError(context, error)
  }
}

/** 执行查询语句，失败抛可读 `DbError` */
export async function dbSelect<T>(context: string, sql: string, values: unknown[] = []): Promise<T[]> {
  try {
    return await getDb().select<T[]>(sql, values)
  } catch (error) {
    throw new DbError(context, error)
  }
}
