/**
 * SQLite schema、SQL 常量与领域行映射（FROZEN 结构 + db 层实现补充）。
 * ------------------------------------------------------------------
 * 本文件是**唯一**存放 DDL 与静态 SQL 的位置：
 *  - `SCHEMA_STATEMENTS` / `FTS_TRIGRAM_STATEMENTS`：与 `src-tauri/migrations/*.sql`
 *    逐条对应（两侧必须一致，`src/db/__checks__/run-checks.mjs` 会做一致性自检）。
 *  - `SQL`：repo 层使用的全部静态 SQL 常量（占位符规则见下）。
 *  - `buildXxx()`：需要动态拼接的 SQL 构造器（纯函数，无 Tauri 依赖，故可被自检脚本复用）。
 *  - 行映射：snake_case 列 → 领域模型的唯一转换点。
 *
 * ## 占位符契约（$N）
 * tauri-plugin-sql 把 `values` 数组**按下标**绑定到语句参数，而 SQLite 对
 * `$N` 这类"命名参数"的编号是按**首次出现顺序**分配的（见 sqlite3.c
 * `sqlite3ExprAssignVarNumber`：命名参数 `x = ++pParse->nVar`）。
 * 因此本文件所有 SQL 都遵守唯一规则：
 *   **`$N` 必须按首次出现顺序严格递增（$1, $2, $3 … 且每个编号都出现）**，
 *   `values` 数组即按该顺序给出。
 * 自检脚本会逐条校验（`scanParamNumbers`），动态构造器也按"追加即编号"实现，
 * 保证文本顺序 == 编号顺序。
 *
 * ## 中文全文检索（选定方案，详见 src/db/search.ts 与 2_fts_trigram.sql）
 *  - 首选：`notes_fts_trigram`（FTS5 + trigram tokenizer，SQLite ≥ 3.34.0）→
 *    支持中文子串、返回真实 bm25 排序。
 *  - 兜底：`LIKE '%q%'`（含查询 < 3 字符、trigram 不可用、FTS 报错时）→
 *    伪 rank 排序。两条路径共用同一 snippet 生成器（命中词 `<mark>` 包裹）。
 *  - v1 的 `notes_fts`（unicode61）保留但**不用于中文检索**：unicode61 会把
 *    连续汉字当成一个 token，「我的笔记本」查不到「笔记」。
 *
 * 约定：
 *  - FTS5 外部内容表 notes_fts / notes_fts_trigram 跟随 notes 表，用触发器同步。
 *  - notes.tags 以 JSON 数组字符串存储（供 UI 直读）；tags 关系同时写入
 *    note_tags 便于索引，两者由 `replaceNoteTags()` 一并维护。
 *  - 所有时间戳为 INTEGER（毫秒）；所有绑定到数值列的值都经 `CAST($n AS INTEGER)`，
 *    因为 tauri-plugin-sql 把 JS number 绑成 f64，不 CAST 会落成 REAL 存储类。
 */

import type { Folder, Note, Tag, ThemeDefinition, ThemeId } from '@/types'

/* ============================== 迁移 ============================== */

/** 迁移表名（与 src-tauri/src/lib.rs 的 MIGRATION_TABLE 保持一致） */
export const MIGRATION_TABLE = '_zj_migrations'

/** 当前 schema 版本号；新增迁移必须 +1 并追加到 SCHEMA_MIGRATIONS */
export const SCHEMA_VERSION = 2

/** 建表与索引语句（v1，按顺序执行，幂等） */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS folders (
     id          TEXT PRIMARY KEY,
     name        TEXT NOT NULL,
     parent_id   TEXT REFERENCES folders(id) ON DELETE CASCADE,
     sort_order  INTEGER NOT NULL DEFAULT 0,
     created_at  INTEGER NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id, sort_order)`,

  `CREATE TABLE IF NOT EXISTS tags (
     id          TEXT PRIMARY KEY,
     name        TEXT NOT NULL UNIQUE,
     color       TEXT NOT NULL DEFAULT '#C9A227',
     created_at  INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS notes (
     id          TEXT PRIMARY KEY,
     title       TEXT NOT NULL DEFAULT '',
     content     TEXT NOT NULL DEFAULT '',
     folder_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
     tags        TEXT NOT NULL DEFAULT '[]',
     pinned      INTEGER NOT NULL DEFAULT 0,
     sort_order  INTEGER NOT NULL DEFAULT 0,
     created_at  INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL,
     deleted_at  INTEGER
   )`,

  `CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id, pinned DESC, sort_order ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_deleted ON notes(deleted_at)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS note_tags (
     note_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
     tag_id   TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
     PRIMARY KEY (note_id, tag_id)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id)`,

  /* -------- 全文搜索（FTS5，unicode61 只保证"整段连续汉字"命中；中文子串见 v2） -------- */
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
     title,
     content,
     note_id UNINDEXED,
     tokenize = 'unicode61 remove_diacritics 2'
   )`,

  `CREATE TRIGGER IF NOT EXISTS trg_notes_ai AFTER INSERT ON notes BEGIN
     INSERT INTO notes_fts(title, content, note_id) VALUES (new.title, new.content, new.id);
   END`,

  `CREATE TRIGGER IF NOT EXISTS trg_notes_au AFTER UPDATE OF title, content ON notes BEGIN
     DELETE FROM notes_fts WHERE note_id = old.id;
     INSERT INTO notes_fts(title, content, note_id) VALUES (new.title, new.content, new.id);
   END`,

  `CREATE TRIGGER IF NOT EXISTS trg_notes_ad AFTER DELETE ON notes BEGIN
     DELETE FROM notes_fts WHERE note_id = old.id;
   END`,

  `CREATE TABLE IF NOT EXISTS app_settings (
     key    TEXT PRIMARY KEY,
     value  TEXT NOT NULL
   )`,
] as const

/** trigram tokenizer 内置进 FTS5 的最低 SQLite 版本（3.34.0，2020-12-01） */
export const FTS_TRIGRAM_MIN_SQLITE_VERSION = '3.34.0'

/**
 * v2：中文友好的 trigram 全文索引（**可选 / 特性门控**迁移）。
 * 与 `src-tauri/migrations/2_fts_trigram.sql` 逐条对应。
 * 该文件刻意不注册到 Rust 的 sqlx migrator（见该文件头注释），由 initDb() 执行。
 */
export const FTS_TRIGRAM_STATEMENTS: readonly string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts_trigram USING fts5(
     title,
     content,
     note_id UNINDEXED,
     tokenize = 'trigram'
   )`,

  `CREATE TRIGGER IF NOT EXISTS trg_notes_tri_ai AFTER INSERT ON notes BEGIN
     INSERT INTO notes_fts_trigram(title, content, note_id) VALUES (new.title, new.content, new.id);
   END`,

  `CREATE TRIGGER IF NOT EXISTS trg_notes_tri_au AFTER UPDATE OF title, content ON notes BEGIN
     DELETE FROM notes_fts_trigram WHERE note_id = old.id;
     INSERT INTO notes_fts_trigram(title, content, note_id) VALUES (new.title, new.content, new.id);
   END`,

  `CREATE TRIGGER IF NOT EXISTS trg_notes_tri_ad AFTER DELETE ON notes BEGIN
     DELETE FROM notes_fts_trigram WHERE note_id = old.id;
   END`,

  `DELETE FROM notes_fts_trigram`,
  `INSERT INTO notes_fts_trigram(title, content, note_id) SELECT title, content, id FROM notes`,
] as const

/** 迁移定义。后续每个迁移：{ version: n+1, statements: [...] } 追加到数组末尾 */
export interface Migration {
  version: number
  statements: readonly string[]
  /**
   * true = 特性门控（可选）迁移：依赖运行时可特性。
   * `initDb()` 先做能力探测，探测失败或语句执行失败时**跳过且不写版本号**，
   * 不视为致命错误（下次启动会重试，可自愈）。
   */
  optional?: boolean
}

export const SCHEMA_MIGRATIONS: readonly Migration[] = [
  { version: 1, statements: SCHEMA_STATEMENTS },
  { version: 2, statements: FTS_TRIGRAM_STATEMENTS, optional: true },
]

/* ======================== 表名 / 常量 / 默认值 ======================== */

/** 全部表名（禁止在 repo 里散写字符串字面量） */
export const TABLES = {
  notes: 'notes',
  folders: 'folders',
  tags: 'tags',
  noteTags: 'note_tags',
  /** 设置表（键值对；契约 §4.6 的主题等偏好在 localStorage，本表留给后端侧偏好） */
  settings: 'app_settings',
  ftsBase: 'notes_fts',
  ftsTrigram: 'notes_fts_trigram',
} as const

/** 标签默认色（与建表 DEFAULT '#C9A227' 一致） */
export const DEFAULT_TAG_COLOR = '#C9A227'

/** 命中片段的高亮标记（契约 §4.1 SearchHit.snippet：命中词用 <mark> 包裹） */
export const SEARCH_MARK_OPEN = '<mark>'
export const SEARCH_MARK_CLOSE = '</mark>'

/** 命中片段上下文窗口（命中位置前后保留的字符数） */
export const SNIPPET_BEFORE = 30
export const SNIPPET_AFTER = 60

/* ============================ 静态 SQL ============================ */
/* 命名约定：动词在前，表名在后；所有列名 snake_case。                     */

export const SQL = {
  /* ------------------------------ notes ------------------------------ */
  /** 读取未软删除的笔记 */
  selectNoteById: `SELECT * FROM notes WHERE id = $1 AND deleted_at IS NULL`,
  /** 读取笔记（含软删除；restore / hardDelete / 回收站操作前校验用） */
  selectNoteByIdAny: `SELECT * FROM notes WHERE id = $1`,
  /** 新增笔记；deleted_at 恒为 NULL */
  insertNote: `INSERT INTO notes (id, title, content, folder_id, tags, pinned, sort_order, created_at, updated_at, deleted_at)
    VALUES ($1, $2, $3, $4, $5, CAST($6 AS INTEGER), CAST($7 AS INTEGER), CAST($8 AS INTEGER), CAST($9 AS INTEGER), NULL)`,
  /** 刷新 updated_at（空 patch 的 update 路径） */
  touchNote: `UPDATE notes SET updated_at = CAST($1 AS INTEGER) WHERE id = $2`,
  /** 软删除：deleted_at 与 updated_at 同时写入 */
  softDeleteNote: `UPDATE notes SET deleted_at = CAST($1 AS INTEGER), updated_at = CAST($1 AS INTEGER) WHERE id = $2`,
  /** 从回收站恢复 */
  restoreNote: `UPDATE notes SET deleted_at = NULL, updated_at = CAST($1 AS INTEGER) WHERE id = $2`,
  /** 物理删除（FTS 由触发器清理，note_tags 由 FK 级联 + 调用方显式清理） */
  hardDeleteNote: `DELETE FROM notes WHERE id = $1`,
  /** 显式清理标签关系（不依赖 PRAGMA foreign_keys 是否打开） */
  deleteNoteTagLinks: `DELETE FROM note_tags WHERE note_id = $1`,
  /** 写入 tags JSON 镜像 + 刷新 updated_at */
  setNoteTagsJson: `UPDATE notes SET tags = $1, updated_at = CAST($2 AS INTEGER) WHERE id = $3`,
  /** 新建笔记取"收件箱"最小排序位（新笔记排在最前） */
  minOrderInbox: `SELECT COALESCE(MIN(sort_order), 0) AS min_order FROM notes WHERE folder_id IS NULL AND deleted_at IS NULL`,
  minOrderInFolder: `SELECT COALESCE(MIN(sort_order), 0) AS min_order FROM notes WHERE folder_id = $1 AND deleted_at IS NULL`,
  /** 文件夹内的规范顺序（置顶优先 → sort_order → created_at → id 兜底，保证确定性） */
  scopeInbox: `SELECT id, sort_order FROM notes WHERE folder_id IS NULL AND deleted_at IS NULL
    ORDER BY pinned DESC, sort_order ASC, created_at ASC, id ASC`,
  scopeFolder: `SELECT id, sort_order FROM notes WHERE folder_id = $1 AND deleted_at IS NULL
    ORDER BY pinned DESC, sort_order ASC, created_at ASC, id ASC`,
  /** 只改排序位（重排邻居用；不刷新 updated_at，避免拖拽污染"最近更新"视图） */
  setNoteOrder: `UPDATE notes SET sort_order = CAST($1 AS INTEGER) WHERE id = $2`,
  /** 移动：改 folder_id + sort_order + updated_at */
  moveNote: `UPDATE notes SET folder_id = $1, sort_order = CAST($2 AS INTEGER), updated_at = CAST($3 AS INTEGER) WHERE id = $4`,
  /** 把某文件夹下的笔记挪回收件箱（folderId 置 NULL），并刷新 updated_at */
  clearNotesFolderInFolder: `UPDATE notes SET folder_id = NULL, updated_at = CAST($1 AS INTEGER) WHERE folder_id = $2`,
  /** 侧边栏计数 */
  countAllNotes: `SELECT COUNT(*) AS count FROM notes WHERE deleted_at IS NULL`,
  countTrashNotes: `SELECT COUNT(*) AS count FROM notes WHERE deleted_at IS NOT NULL`,
  countNotesByFolder: `SELECT folder_id AS folder_id, COUNT(*) AS count FROM notes
    WHERE deleted_at IS NULL AND folder_id IS NOT NULL GROUP BY folder_id`,
  countNotesByTag: `SELECT t.name AS name, COUNT(*) AS count FROM note_tags nt
    JOIN tags t ON t.id = nt.tag_id
    JOIN notes n ON n.id = nt.note_id
    WHERE n.deleted_at IS NULL GROUP BY t.name`,

  /* ----------------------------- folders ----------------------------- */
  insertFolder: `INSERT INTO folders (id, name, parent_id, sort_order, created_at)
    VALUES ($1, $2, $3, CAST($4 AS INTEGER), CAST($5 AS INTEGER))`,
  selectFolderById: `SELECT * FROM folders WHERE id = $1`,
  renameFolder: `UPDATE folders SET name = $1 WHERE id = $2`,
  /** 扁平列表：顶层优先、同层按 sort_order */
  listFolders: `SELECT * FROM folders
    ORDER BY (parent_id IS NOT NULL) ASC, parent_id ASC, sort_order ASC, created_at ASC, id ASC`,
  /** 新建文件夹取同层下一个排序位 */
  maxFolderOrderTop: `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM folders WHERE parent_id IS NULL`,
  maxFolderOrderChild: `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM folders WHERE parent_id = $1`,
  /** 子树上所有文件夹 id（含自身；递归 CTE，读多写零，删除时逐个执行避免边读边删） */
  folderSubtree: `WITH RECURSIVE subtree(id) AS (
      SELECT id FROM folders WHERE id = $1
      UNION ALL
      SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
    ) SELECT id FROM subtree`,
  deleteFolder: `DELETE FROM folders WHERE id = $1`,

  /* ------------------------------ tags ------------------------------ */
  insertTag: `INSERT INTO tags (id, name, color, created_at) VALUES ($1, $2, $3, CAST($4 AS INTEGER))`,
  /** 幂等创建（setNoteTags 自动补标签时用，重复名不报错） */
  insertTagIgnore: `INSERT OR IGNORE INTO tags (id, name, color, created_at) VALUES ($1, $2, $3, CAST($4 AS INTEGER))`,
  selectTagById: `SELECT * FROM tags WHERE id = $1`,
  selectTagByName: `SELECT * FROM tags WHERE name = $1`,
  renameTag: `UPDATE tags SET name = $1 WHERE id = $2`,
  deleteTag: `DELETE FROM tags WHERE id = $1`,
  listTags: `SELECT * FROM tags ORDER BY name ASC`,
  /** 某标签关联的笔记 id（排除软删除） */
  selectNoteIdsByTag: `SELECT n.id AS id FROM note_tags nt JOIN notes n ON n.id = nt.note_id
    WHERE nt.tag_id = $1 AND n.deleted_at IS NULL ORDER BY n.updated_at DESC, n.id ASC`,
  /** 某标签名关联的笔记 id（供 listByTag 之外的便捷查询） */
  selectNoteIdsByTagName: `SELECT n.id AS id FROM note_tags nt
    JOIN tags t ON t.id = nt.tag_id
    JOIN notes n ON n.id = nt.note_id
    WHERE t.name = $1 AND n.deleted_at IS NULL ORDER BY n.updated_at DESC, n.id ASC`,
  /** 受影响笔记 id（删标签时用于回写 tags JSON） */
  selectNoteIdsByTagRaw: `SELECT note_id AS id FROM note_tags WHERE tag_id = $1`,
  linkNoteTag: `INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES ($1, $2)`,
  unlinkAllNoteTags: `DELETE FROM note_tags WHERE note_id = $1`,
  deleteNoteTagLinksByTag: `DELETE FROM note_tags WHERE tag_id = $1`,

  /* ----------------------------- search ----------------------------- */
  /**
   * 首选：FTS5 + trigram（中文子串友好）。$1 = 已加引号转义的短语，$2 = limit。
   * 只 JOIN 未软删除的笔记；bm25 越小越相关。
   */
  searchTrigram: `SELECT n.*, bm25(notes_fts_trigram) AS rank
    FROM notes_fts_trigram JOIN notes n ON n.id = notes_fts_trigram.note_id
    WHERE notes_fts_trigram MATCH $1 AND n.deleted_at IS NULL
    ORDER BY rank ASC, n.updated_at DESC, n.id ASC
    LIMIT CAST($2 AS INTEGER)`,
  /** 兜底：LIKE 子串（$1 = 已转义 pattern，$2 = limit）。ESCAPE '\' 让 % 与 _ 字面化 */
  searchLike: `SELECT n.* FROM notes n
    WHERE n.deleted_at IS NULL AND (n.title LIKE $1 ESCAPE '\\' OR n.content LIKE $1 ESCAPE '\\')
    ORDER BY n.updated_at DESC, n.created_at DESC, n.id ASC
    LIMIT CAST($2 AS INTEGER)`,

  /* -------------------------- 能力探测 / 自检 -------------------------- */
  compileOptionFts5: `SELECT compile_options AS name FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'`,
  sqliteVersion: `SELECT sqlite_version() AS version`,
  tableExists: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = $1`,
} as const

/* ====================== 动态 SQL 构造器（纯函数） ====================== */

/** 构造器产物：SQL 文本 + 与 $N 首现顺序一一对应的绑定值 */
export interface BuiltQuery {
  sql: string
  values: unknown[]
}

/** 与 notes.ts 的 NotesListFilter 结构一致（此处独立声明以免 schema → notes 循环依赖） */
export interface NotesListQueryFilter {
  folderId?: string | null
  tagName?: string
  includeDeleted?: boolean
  onlyDeleted?: boolean
  sortBy?: 'order' | 'updatedAt' | 'createdAt' | 'title'
  direction?: 'asc' | 'desc'
}

/**
 * notesRepo.listAll 的查询构造器。
 * 排序规则（契约 §4.3）：
 *  - `sortBy` 缺省：回收站视图（onlyDeleted）按 deleted_at DESC，其余按 `pinned DESC, sort_order ASC`；
 *  - `direction` 缺省 asc，仅 `sortBy='updatedAt'` 时缺省 desc；
 *  - 末尾一律追加 `id ASC`，保证同序数据的分页/拖拽结果稳定。
 */
export function buildNotesListQuery(filter: NotesListQueryFilter = {}): BuiltQuery {
  const values: unknown[] = []
  const bind = (value: unknown): string => {
    values.push(value)
    return `$${values.length}`
  }

  const where: string[] = []
  if ('folderId' in filter) {
    where.push(filter.folderId === null || filter.folderId === undefined ? 'folder_id IS NULL' : `folder_id = ${bind(filter.folderId)}`)
  }
  if (filter.tagName) {
    where.push(
      `id IN (SELECT nt.note_id FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE t.name = ${bind(filter.tagName)})`,
    )
  }
  const onlyDeleted = filter.onlyDeleted === true
  if (onlyDeleted) where.push('deleted_at IS NOT NULL')
  else if (filter.includeDeleted !== true) where.push('deleted_at IS NULL')

  const direction = filter.direction ?? (filter.sortBy === 'updatedAt' ? 'desc' : 'asc')
  const dir = direction === 'desc' ? 'DESC' : 'ASC'
  let orderBy: string
  switch (filter.sortBy) {
    case 'updatedAt':
      orderBy = `updated_at ${dir}`
      break
    case 'createdAt':
      orderBy = `created_at ${dir}`
      break
    case 'title':
      orderBy = `title COLLATE NOCASE ${dir}`
      break
    case 'order':
      orderBy = `pinned DESC, sort_order ${dir}`
      break
    default:
      orderBy = onlyDeleted ? 'deleted_at DESC' : 'pinned DESC, sort_order ASC'
  }

  const sql = `SELECT * FROM notes${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderBy}, id ASC`
  return { sql, values }
}

/** NoteUpdatePatch 中直接映射到列的子集（tags 不在此处，需同步 note_tags） */
export interface NoteColumnPatch {
  title?: string
  content?: string
  folderId?: string | null
  pinned?: boolean
  order?: number
  deletedAt?: number | null
}

/**
 * notesRepo.update 的 UPDATE 构造器：SET 子句按 patch 实际出现的键拼接，
 * 末尾总是追加 `updated_at = now`（契约：所有写操作刷新 updatedAt）。
 */
export function buildNoteUpdateQuery(id: string, patch: NoteColumnPatch, now: number): BuiltQuery {
  const values: unknown[] = []
  const bind = (value: unknown): string => {
    values.push(value)
    return `$${values.length}`
  }

  const sets: string[] = []
  if (patch.title !== undefined) sets.push(`title = ${bind(patch.title)}`)
  if (patch.content !== undefined) sets.push(`content = ${bind(patch.content)}`)
  // folderId / deletedAt 用 `!== undefined` 判定：显式传 null 才会写入 NULL
  // （避免 `{ folderId: undefined }` 这类"未提供"的值把文件夹清空）
  if (patch.folderId !== undefined) sets.push(`folder_id = ${bind(patch.folderId)}`)
  if (patch.pinned !== undefined) sets.push(`pinned = CAST(${bind(patch.pinned ? 1 : 0)} AS INTEGER)`)
  if (patch.order !== undefined) sets.push(`sort_order = CAST(${bind(patch.order)} AS INTEGER)`)
  if (patch.deletedAt !== undefined) sets.push(`deleted_at = CAST(${bind(patch.deletedAt)} AS INTEGER)`)
  sets.push(`updated_at = CAST(${bind(now)} AS INTEGER)`)

  // WHERE 在 SET 之后绑定，保证 $N 首现顺序 == 文本顺序
  const where = `id = ${bind(id)}`
  return { sql: `UPDATE notes SET ${sets.join(', ')} WHERE ${where}`, values }
}

/* ====================== 行映射（snake_case → 模型） ====================== */

export interface NoteRow {
  id: string
  title: string
  content: string
  folder_id: string | null
  tags: string
  pinned: number
  sort_order: number
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export interface FolderRow {
  id: string
  name: string
  parent_id: string | null
  sort_order: number
  created_at: number
  /** 索引层追加（t15 起）：文件夹对应的库内相对路径；旧库可能没有该列 */
  path?: string | null
}

export interface TagRow {
  id: string
  name: string
  color: string
  created_at: number
}

/** 解析 notes.tags 的 JSON 镜像；损坏数据回退为空数组，不让脏数据炸掉列表 */
export function parseTagsJson(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

export function mapNoteRow(row: NoteRow): Note {
  return {
    id: String(row.id),
    title: row.title ?? '',
    content: row.content ?? '',
    folderId: row.folder_id ?? null,
    tags: parseTagsJson(row.tags),
    pinned: Number(row.pinned) !== 0,
    order: Number(row.sort_order ?? 0),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at),
  }
}

export function mapFolderRow(row: FolderRow): Folder {
  return {
    id: String(row.id),
    name: row.name,
    parentId: row.parent_id ?? null,
    order: Number(row.sort_order ?? 0),
    createdAt: Number(row.created_at ?? 0),
  }
}

export function mapTagRow(row: TagRow): Tag {
  return {
    id: String(row.id),
    name: row.name,
    color: row.color,
    createdAt: Number(row.created_at ?? 0),
  }
}

/* ======================= 自检辅助（供 __checks__ 复用） ======================= */

/**
 * 扫描 SQL 中 `$N` 占位符，返回**按首次出现顺序**的编号列表。
 * 自检脚本用它断言 fn 每个语句的编号都是 [1,2,…,n]（见文件头"占位符契约"）。
 */
export function scanParamNumbers(sql: string): number[] {
  const seen: number[] = []
  const pattern = /\$(\d+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(sql)) !== null) {
    const index = Number(match[1])
    if (!seen.includes(index)) seen.push(index)
  }
  return seen
}

/** 比较 `a.b.c` 形式的版本号：a>b → 1，相等 → 0，a<b → -1 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(pa.length, pb.length)
  for (let i = 0; i < length; i += 1) {
    const left = pa[i] ?? 0
    const right = pb[i] ?? 0
    if (left > right) return 1
    if (left < right) return -1
  }
  return 0
}

/* ---------------------------- 主题定义表 ---------------------------- */

/**
 * 五套主题 × light/dark 恰好落在 --zj-* token 上。
 * 与 src/styles/theme.css 中的 [data-theme="..."] 规则一一对应，禁止只改一边。
 */
export const THEMES: readonly ThemeDefinition[] = [
  {
    id: 'paper-yellow',
    label: '淡黄（默认）',
    light: {
      'zj-bg': '#FDF8EC',
      'zj-surface': '#FFFCF3',
      'zj-surface-2': '#F7EFDD',
      'zj-text': '#3A3833',
      'zj-text-muted': '#8A8578',
      'zj-accent': '#C9A227',
      'zj-accent-fg': '#FFFCF3',
      'zj-border': '#E8DFC8',
      'zj-hover': '#F3EAD5',
      'zj-selection': '#F0E3BC',
      'zj-shadow': '0 1px 2px rgba(58, 56, 51, 0.06)',
      'zj-radius': '8px',
    },
    dark: {
      'zj-bg': '#25231D',
      'zj-surface': '#2C2A23',
      'zj-surface-2': '#34312A',
      'zj-text': '#EDE7D9',
      'zj-text-muted': '#9A9384',
      'zj-accent': '#D9B341',
      'zj-accent-fg': '#25231D',
      'zj-border': '#3E3A31',
      'zj-hover': '#332F27',
      'zj-selection': '#4A4128',
      'zj-shadow': '0 1px 2px rgba(0, 0, 0, 0.35)',
      'zj-radius': '8px',
    },
  },
  {
    id: 'rice-white',
    label: '米白',
    light: {
      'zj-bg': '#FAF9F6',
      'zj-surface': '#FFFFFF',
      'zj-surface-2': '#F2F1EC',
      'zj-text': '#33322E',
      'zj-text-muted': '#83817A',
      'zj-accent': '#A8894A',
      'zj-accent-fg': '#FFFFFF',
      'zj-border': '#E6E4DC',
      'zj-hover': '#F1F0EA',
      'zj-selection': '#EDE6D4',
      'zj-shadow': '0 1px 2px rgba(51, 50, 46, 0.05)',
      'zj-radius': '8px',
    },
    dark: {
      'zj-bg': '#1F1F1D',
      'zj-surface': '#272725',
      'zj-surface-2': '#302F2C',
      'zj-text': '#E9E7E1',
      'zj-text-muted': '#96938B',
      'zj-accent': '#C2A159',
      'zj-accent-fg': '#1F1F1D',
      'zj-border': '#393834',
      'zj-hover': '#2E2D2A',
      'zj-selection': '#45402F',
      'zj-shadow': '0 1px 2px rgba(0, 0, 0, 0.32)',
      'zj-radius': '8px',
    },
  },
  {
    id: 'slate-blue',
    label: '灰蓝',
    light: {
      'zj-bg': '#F4F6F8',
      'zj-surface': '#FCFDFE',
      'zj-surface-2': '#E9EEF3',
      'zj-text': '#2F3640',
      'zj-text-muted': '#7A8595',
      'zj-accent': '#5B7C99',
      'zj-accent-fg': '#FCFDFE',
      'zj-border': '#DCE3EA',
      'zj-hover': '#E8EDF2',
      'zj-selection': '#D5E1EC',
      'zj-shadow': '0 1px 2px rgba(47, 54, 64, 0.06)',
      'zj-radius': '8px',
    },
    dark: {
      'zj-bg': '#1C2127',
      'zj-surface': '#232931',
      'zj-surface-2': '#2C333C',
      'zj-text': '#E2E7EE',
      'zj-text-muted': '#8B96A5',
      'zj-accent': '#7FA0BE',
      'zj-accent-fg': '#1C2127',
      'zj-border': '#343C46',
      'zj-hover': '#2A313A',
      'zj-selection': '#33445A',
      'zj-shadow': '0 1px 2px rgba(0, 0, 0, 0.34)',
      'zj-radius': '8px',
    },
  },
  {
    id: 'ink-green',
    label: '墨绿',
    light: {
      'zj-bg': '#F3F6F2',
      'zj-surface': '#FBFDFA',
      'zj-surface-2': '#E7EEE5',
      'zj-text': '#2C3530',
      'zj-text-muted': '#76857C',
      'zj-accent': '#4F6B58',
      'zj-accent-fg': '#FBFDFA',
      'zj-border': '#D9E3D6',
      'zj-hover': '#E6EDE3',
      'zj-selection': '#D2E0CE',
      'zj-shadow': '0 1px 2px rgba(44, 53, 48, 0.06)',
      'zj-radius': '8px',
    },
    dark: {
      'zj-bg': '#1B211D',
      'zj-surface': '#222924',
      'zj-surface-2': '#2A332C',
      'zj-text': '#E3EAE4',
      'zj-text-muted': '#8A9A8E',
      'zj-accent': '#7BA184',
      'zj-accent-fg': '#1B211D',
      'zj-border': '#333D35',
      'zj-hover': '#28302A',
      'zj-selection': '#31453A',
      'zj-shadow': '0 1px 2px rgba(0, 0, 0, 0.34)',
      'zj-radius': '8px',
    },
  },
  {
    id: 'midnight',
    label: '暗夜',
    light: {
      'zj-bg': '#F6F5F3',
      'zj-surface': '#FFFFFF',
      'zj-surface-2': '#EDEBE7',
      'zj-text': '#2B2A28',
      'zj-text-muted': '#7D7B76',
      'zj-accent': '#8A6A3B',
      'zj-accent-fg': '#FFFFFF',
      'zj-border': '#E2DFDA',
      'zj-hover': '#ECEAE6',
      'zj-selection': '#E6DCC9',
      'zj-shadow': '0 1px 2px rgba(43, 42, 40, 0.06)',
      'zj-radius': '8px',
    },
    dark: {
      'zj-bg': '#16161A',
      'zj-surface': '#1D1D22',
      'zj-surface-2': '#26262C',
      'zj-text': '#E6E5E8',
      'zj-text-muted': '#8E8D94',
      'zj-accent': '#C0A05E',
      'zj-accent-fg': '#16161A',
      'zj-border': '#2F2F36',
      'zj-hover': '#242429',
      'zj-selection': '#3B3526',
      'zj-shadow': '0 1px 2px rgba(0, 0, 0, 0.45)',
      'zj-radius': '8px',
    },
  },
] as const

export const DEFAULT_THEME_ID: ThemeId = 'paper-yellow'

/** 取主题定义；未知 id 回落到默认主题 */
export function getTheme(id: ThemeId): ThemeDefinition {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0]
}

/* ============================================================================
 * 索引层（t15 起：SQLite 降级为「可随时重建的索引」，唯一真相源是 md 文件）
 * ============================================================================
 * 与 v1/v2 版本化迁移的关系：
 *  - v1/v2（SCHEMA_STATEMENTS / FTS_TRIGRAM_STATEMENTS）仍然保留：它们记录在
 *    `_zj_migrations` / Rust 的 `_sqlx_migrations` 里，首次安装与 Rust 侧仍按它们建表；
 *  - 索引层 DDL（INDEX_DDL_STATEMENTS）与 v1 同构，但**多了文件定位列**
 *    （notes.rel_path / file_mtime / file_size，folders.path）。
 *    索引是**可丢弃**的，所以 `rebuildIndex()` 直接 DROP + CREATE，不走 ALTER，
 *    也就不需要新的版本化迁移文件（避免 sqlx checksum 与半成品表问题）；
 *  - 因此本项目只有 TS 侧会在运行时重建索引，Rust 侧不感知这些列。
 */

/** 索引表（DROP 顺序：子表 / 虚拟表在前） */
export const INDEX_TABLES: readonly string[] = [
  'notes_fts_trigram',
  'notes_fts',
  'note_tags',
  'notes',
  'tags',
  'folders',
] as const

/** 索引层 DDL：DROP（幂等）+ CREATE（与 v1 同构 + 文件定位列 + FTS + 触发器） */
export const INDEX_DDL_STATEMENTS: readonly string[] = [
  /* -------- 1. 丢弃旧索引（触发器随表一起消失，这里显式点名以便阅读） -------- */
  `DROP TRIGGER IF EXISTS trg_notes_ai`,
  `DROP TRIGGER IF EXISTS trg_notes_au`,
  `DROP TRIGGER IF EXISTS trg_notes_ad`,
  `DROP TRIGGER IF EXISTS trg_notes_tri_ai`,
  `DROP TRIGGER IF EXISTS trg_notes_tri_au`,
  `DROP TRIGGER IF EXISTS trg_notes_tri_ad`,
  `DROP TABLE IF EXISTS notes_fts_trigram`,
  `DROP TABLE IF EXISTS notes_fts`,
  `DROP TABLE IF EXISTS note_tags`,
  `DROP TABLE IF EXISTS notes`,
  `DROP TABLE IF EXISTS tags`,
  `DROP TABLE IF EXISTS folders`,

  /* ------------------------------ 2. 建表 ------------------------------ */
  `CREATE TABLE IF NOT EXISTS folders (
     id          TEXT PRIMARY KEY,
     name        TEXT NOT NULL,
     parent_id   TEXT REFERENCES folders(id) ON DELETE CASCADE,
     sort_order  INTEGER NOT NULL DEFAULT 0,
     created_at  INTEGER NOT NULL,
     path        TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_path ON folders(path)`,
  `CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id, sort_order)`,

  `CREATE TABLE IF NOT EXISTS tags (
     id          TEXT PRIMARY KEY,
     name        TEXT NOT NULL UNIQUE,
     color       TEXT NOT NULL DEFAULT '#C9A227',
     created_at  INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS notes (
     id          TEXT PRIMARY KEY,
     title       TEXT NOT NULL DEFAULT '',
     content     TEXT NOT NULL DEFAULT '',
     folder_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
     tags        TEXT NOT NULL DEFAULT '[]',
     pinned      INTEGER NOT NULL DEFAULT 0,
     sort_order  INTEGER NOT NULL DEFAULT 0,
     created_at  INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL,
     deleted_at  INTEGER,
     rel_path    TEXT,
     file_mtime  INTEGER,
     file_size   INTEGER
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_rel_path ON notes(rel_path)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id, pinned DESC, sort_order ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_deleted ON notes(deleted_at)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS note_tags (
     note_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
     tag_id   TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
     PRIMARY KEY (note_id, tag_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id)`,

  /* ------------------------------ 3. FTS5 ------------------------------ */
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
     title,
     content,
     note_id UNINDEXED,
     tokenize = 'unicode61 remove_diacritics 2'
   )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts_trigram USING fts5(
     title,
     content,
     note_id UNINDEXED,
     tokenize = 'trigram'
   )`,

  /* --------------------------- 4. 同步触发器 --------------------------- */
  /* 与 1_init.sql / 2_fts_trigram.sql 里的六个触发器逐条一致：
     两张 FTS 表各自 AFTER INSERT / AFTER UPDATE OF title,content / AFTER DELETE。 */
  `CREATE TRIGGER IF NOT EXISTS trg_notes_ai AFTER INSERT ON notes BEGIN
     INSERT INTO notes_fts(title, content, note_id) VALUES (new.title, new.content, new.id);
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_notes_au AFTER UPDATE OF title, content ON notes BEGIN
     DELETE FROM notes_fts WHERE note_id = old.id;
     INSERT INTO notes_fts(title, content, note_id) VALUES (new.title, new.content, new.id);
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_notes_ad AFTER DELETE ON notes BEGIN
     DELETE FROM notes_fts WHERE note_id = old.id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_notes_tri_ai AFTER INSERT ON notes BEGIN
     INSERT INTO notes_fts_trigram(title, content, note_id) VALUES (new.title, new.content, new.id);
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_notes_tri_au AFTER UPDATE OF title, content ON notes BEGIN
     DELETE FROM notes_fts_trigram WHERE note_id = old.id;
     INSERT INTO notes_fts_trigram(title, content, note_id) VALUES (new.title, new.content, new.id);
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_notes_tri_ad AFTER DELETE ON notes BEGIN
     DELETE FROM notes_fts_trigram WHERE note_id = old.id;
   END`,
] as const

/** 索引层运行时 SQL（占位符规则与文件头「$N 按首现顺序递增」一致） */
export const INDEX_SQL = {
  /* -------------------- 结构探测（决定要不要整表重建） -------------------- */
  tableExists: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = $1`,
  tableColumns: `SELECT name FROM pragma_table_info($1)`,

  /* ------------------------------ notes ------------------------------ */
  insertNote: `INSERT INTO notes (id, title, content, folder_id, tags, pinned, sort_order, created_at, updated_at, deleted_at, rel_path, file_mtime, file_size)
    VALUES ($1, $2, $3, $4, $5, CAST($6 AS INTEGER), CAST($7 AS INTEGER), CAST($8 AS INTEGER), CAST($9 AS INTEGER), CAST($10 AS INTEGER), $11, CAST($12 AS INTEGER), CAST($13 AS INTEGER))`,
  updateNoteById: `UPDATE notes SET title = $1, content = $2, folder_id = $3, tags = $4, pinned = CAST($5 AS INTEGER),
      sort_order = CAST($6 AS INTEGER), created_at = CAST($7 AS INTEGER), updated_at = CAST($8 AS INTEGER),
      deleted_at = CAST($9 AS INTEGER), rel_path = $10, file_mtime = CAST($11 AS INTEGER), file_size = CAST($12 AS INTEGER)
    WHERE id = $13`,
  updateNoteByRelPath: `UPDATE notes SET id = $1, title = $2, content = $3, folder_id = $4, tags = $5, pinned = CAST($6 AS INTEGER),
      sort_order = CAST($7 AS INTEGER), created_at = CAST($8 AS INTEGER), updated_at = CAST($9 AS INTEGER),
      deleted_at = CAST($10 AS INTEGER), file_mtime = CAST($11 AS INTEGER), file_size = CAST($12 AS INTEGER)
    WHERE rel_path = $13`,
  selectNoteIdByRelPath: `SELECT id FROM notes WHERE rel_path = $1`,
  selectNoteFileRows: `SELECT id, rel_path, file_mtime, file_size FROM notes`,
  selectNoteByRelPath: `SELECT * FROM notes WHERE rel_path = $1`,
  deleteNoteById: `DELETE FROM notes WHERE id = $1`,
  touchNoteFileMeta: `UPDATE notes SET file_mtime = CAST($1 AS INTEGER), file_size = CAST($2 AS INTEGER) WHERE id = $3`,

  /* ----------------------------- folders ----------------------------- */
  insertFolder: `INSERT INTO folders (id, name, parent_id, sort_order, created_at, path)
    VALUES ($1, $2, $3, CAST($4 AS INTEGER), CAST($5 AS INTEGER), $6)`,
  updateFolder: `UPDATE folders SET name = $1, parent_id = $2, sort_order = CAST($3 AS INTEGER), created_at = CAST($4 AS INTEGER), path = $5 WHERE id = $6`,
  selectFolderByPath: `SELECT * FROM folders WHERE path = $1`,
  selectFolderIdByPath: `SELECT id FROM folders WHERE path = $1`,
  deleteFolderById: `DELETE FROM folders WHERE id = $1`,
  selectFolderPaths: `SELECT id, path FROM folders`,

  /* ------------------------------ tags ------------------------------ */
  insertTag: `INSERT INTO tags (id, name, color, created_at) VALUES ($1, $2, $3, CAST($4 AS INTEGER))`,
  updateTagById: `UPDATE tags SET name = $1, color = $2, created_at = CAST($3 AS INTEGER) WHERE id = $4`,
  selectTagIdByName: `SELECT id FROM tags WHERE name = $1`,
  selectTagNames: `SELECT id, name FROM tags`,
  deleteTagById: `DELETE FROM tags WHERE id = $1`,

  /* ---------------------------- 关系 / 统计 ---------------------------- */
  deleteNoteTagLinks: `DELETE FROM note_tags WHERE note_id = $1`,
  linkNoteTag: `INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES ($1, $2)`,
  listNoteTagsByNote: `SELECT t.name AS name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = $1 ORDER BY t.name ASC`,
} as const

/** 带文件定位列的 note 行 */
export interface NoteFileRow extends NoteRow {
  rel_path: string | null
  file_mtime: number | null
  file_size: number | null
}
