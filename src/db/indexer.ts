/**
 * indexer —— 把 vault 里的 md 文件投影成 SQLite 索引。
 * ==================================================================
 * 「索引可纯由文件重建」的定义（docs/ARCHITECTURE.md §4.12）：
 *   `applyIndexDdl()` + `syncIndex({ full: true })` 之后，notes / folders / tags /
 *   note_tags / FTS 全部内容都能从 md 文件 + `.paper/*.json` 推导出来，
 *   不依赖任何只存在于数据库里的状态。
 *
 * 派生规则：
 *   - `notes.id/title/content/tags/pinned/order/created_at/updated_at` ← front-matter + 正文；
 *   - `notes.folder_id` ← 文件所在目录（vault 根 = 收件箱 = null）；
 *   - `notes.deleted_at` ← 是否位于 `.trash/`（精确值取 `.paper/trash.json`）；
 *   - `notes.rel_path/file_mtime/file_size` ← 文件定位与增量同步依据；
 *   - `folders.*` ← 目录树 + `.paper/folders.json`（id/createdAt 稳定）；
 *     `sort_order` = 同层目录名升序下标（目录没有元数据文件，故派生）；
 *   - `tags.*` ← 所有笔记 front-matter 的标签名 ∪ `.paper/tags.json` 的声明标签。
 */

import { newId } from '@/lib/utils'
import { dbExecute, dbSelect } from './connection'
import { DbError } from './errors'
import { notifyIndexMutated } from './events'
import { getStorage } from './storage'
import { relDirOf, basenameOf, toRelPosix } from './paths'
import {
  DEFAULT_TAG_COLOR,
  INDEX_DDL_STATEMENTS,
  INDEX_SQL,
  SQL,
  parseTagsJson,
  type NoteFileRow,
} from './schema'
import {
  ensureFolderMetas,
  ensureTagMetas,
  absolutePathOf,
  listFolderRels,
  loadNote,
  readFoldersMeta,
  readTagsMeta,
  scanVault,
  writeFoldersMeta,
  writeNoteId,
  type LoadedNote,
  type VaultNoteFile,
} from './vault'

/** 写入索引的一条笔记 */
export interface IndexNoteInput {
  id: string
  title: string
  content: string
  tags: string[]
  pinned: boolean
  order: number
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  folderId: string | null
  relPath: string
  mtimeMs: number
  size: number
}

/** 索引同步结果 */
export interface IndexSyncResult {
  full: boolean
  total: number
  added: number
  updated: number
  removed: number
  repaired: number
  folders: number
  tags: number
}

/* ============================ 结构：探测与重建 ============================ */

/** 索引结构是否为「文件感知」形态（notes 有 rel_path/file_mtime/file_size，folders 有 path） */
export async function isIndexShapeReady(): Promise<boolean> {
  const required: Array<[string, string]> = [
    ['notes', 'rel_path'],
    ['notes', 'file_mtime'],
    ['notes', 'file_size'],
    ['folders', 'path'],
  ]
  const tables = new Set<string>()
  const columns = new Map<string, Set<string>>()
  for (const [table, column] of required) {
    if (!tables.has(table)) {
      const found = await dbSelect<{ name: string }>('检查索引结构失败', INDEX_SQL.tableExists, [table])
      if (found.length === 0) return false
      tables.add(table)
      const cols = await dbSelect<{ name: string }>('检查索引结构失败', INDEX_SQL.tableColumns, [table])
      columns.set(table, new Set(cols.map((row) => String(row.name))))
    }
    if (!columns.get(table)?.has(column)) return false
  }
  return true
}

/** 逐条执行索引层 DDL（含 DROP，幂等） */
export async function applyIndexDdl(): Promise<void> {
  for (const statement of INDEX_DDL_STATEMENTS) {
    try {
      await dbExecute('重建索引结构失败', statement)
    } catch (error) {
      throw new DbError(`重建索引结构失败（语句：${statement.slice(0, 80)}）`, error)
    }
  }
}

/* ============================== 索引行写入 ============================== */

/** 取「目录 → folder id」映射 */
async function folderIdMap(): Promise<Map<string, string>> {
  const rows = await dbSelect<{ id: string; path: string | null }>('读取文件夹索引失败', INDEX_SQL.selectFolderPaths)
  const map = new Map<string, string>()
  for (const row of rows) {
    if (row.path) map.set(toRelPosix(row.path), String(row.id))
  }
  return map
}

/** 目录相对路径 → folder id（收件箱为 null）；未知目录返回 null */
export async function folderIdForRel(folderRel: string | null): Promise<string | null> {
  if (!folderRel) return null
  const map = await folderIdMap()
  return map.get(toRelPosix(folderRel)) ?? null
}

/** folder id → 目录相对路径（不存在返回 null） */
export async function folderRelById(folderId: string): Promise<string | null> {
  const rows = await dbSelect<{ id: string; path: string | null }>(
    '读取文件夹失败',
    `${INDEX_SQL.selectFolderPaths} WHERE id = $1`,
    [folderId],
  )
  const path = rows[0]?.path
  return path ? toRelPosix(String(path)) : null
}

/** 写标签行（name → id），必要时从 `.paper/tags.json` 取色与创建时间 */
export async function upsertTagRows(names: Iterable<string>): Promise<Map<string, string>> {
  const desired = new Set<string>()
  for (const name of names) {
    const trimmed = String(name ?? '').trim()
    if (trimmed) desired.add(trimmed)
  }
  const meta = await ensureTagMetas([...desired])
  const existing = await dbSelect<{ id: string; name: string }>('读取标签索引失败', INDEX_SQL.selectTagNames)
  const byName = new Map(existing.map((row) => [String(row.name), String(row.id)]))
  const byId = new Map(existing.map((row) => [String(row.id), String(row.name)]))
  const result = new Map<string, string>()
  for (const name of desired) {
    const info = meta[name]
    const id = byName.get(name)
    if (id) {
      await dbExecute('更新标签索引失败', INDEX_SQL.updateTagById, [name, info?.color ?? DEFAULT_TAG_COLOR, info?.createdAt ?? 0, id])
      result.set(name, id)
      continue
    }
    const tagId = info?.id ?? newId()
    if (byId.has(tagId)) {
      // 同一 id 换了名字（标签改名）：更新而不是插入，避免主键冲突
      await dbExecute('更新标签索引失败', INDEX_SQL.updateTagById, [name, info?.color ?? DEFAULT_TAG_COLOR, info?.createdAt ?? 0, tagId])
      byId.delete(tagId)
      byName.set(name, tagId)
      result.set(name, tagId)
      continue
    }
    await dbExecute('写入标签索引失败', INDEX_SQL.insertTag, [tagId, name, info?.color ?? DEFAULT_TAG_COLOR, info?.createdAt ?? 0])
    byName.set(name, tagId)
    result.set(name, tagId)
  }
  notifyIndexMutated()
  return result
}

/** 同步 note_tags 关系（覆盖式，幂等） */
export async function syncNoteTagLinks(noteId: string, tags: string[]): Promise<void> {
  await dbExecute('清理笔记标签关系失败', INDEX_SQL.deleteNoteTagLinks, [noteId])
  if (tags.length === 0) return
  const ids = await upsertTagRows(tags)
  for (const name of tags) {
    const tagId = ids.get(name)
    if (tagId) await dbExecute('建立笔记标签关系失败', INDEX_SQL.linkNoteTag, [noteId, tagId])
  }
}

/**
 * 写入 / 更新一条笔记的索引行（三种情形都覆盖）：
 *  1. `rel_path` 已有行且 id 相同 → 直接 UPDATE；
 *  2. `rel_path` 已有行但 id 不同（外部改了 front-matter 的 id）→ UPDATE 该行（含 id）；
 *  3. 无该 rel_path 行但有同 id 行（文件被改名/移动）→ UPDATE 该行并改写 rel_path；
 *  4. 都没有 → INSERT。
 * 注意 `notes_fts*` 的 AFTER UPDATE 触发器只在 title/content 变化时触发，
 * 因此 id 变化走的是「按 rel_path 覆盖整行」的语句（先 DELETE 再 INSERT 会丢 FTS 行）。
 */
export async function writeIndexNote(input: IndexNoteInput): Promise<void> {
  const tagsJson = JSON.stringify(input.tags)
  const pinned = input.pinned ? 1 : 0
  const deletedAt = input.deletedAt === null ? null : Math.trunc(input.deletedAt)
  const mtime = Math.trunc(input.mtimeMs)
  const size = Math.trunc(input.size)

  const byRel = await dbSelect<{ id: string }>('读取笔记索引失败', INDEX_SQL.selectNoteIdByRelPath, [input.relPath])
  if (byRel.length > 0) {
    if (String(byRel[0].id) === input.id) {
      await dbExecute('更新笔记索引失败', INDEX_SQL.updateNoteById, [
        input.title, input.content, input.folderId, tagsJson, pinned, input.order,
        input.createdAt, input.updatedAt, deletedAt, input.relPath, mtime, size, input.id,
      ])
    } else {
      await dbExecute('更新笔记索引失败', INDEX_SQL.updateNoteByRelPath, [
        input.id, input.title, input.content, input.folderId, tagsJson, pinned, input.order,
        input.createdAt, input.updatedAt, deletedAt, mtime, size, input.relPath,
      ])
    }
  } else {
    const byId = await dbSelect<{ id: string }>('读取笔记索引失败', SQL.selectNoteByIdAny, [input.id])
    if (byId.length > 0) {
      await dbExecute('更新笔记索引失败', INDEX_SQL.updateNoteById, [
        input.title, input.content, input.folderId, tagsJson, pinned, input.order,
        input.createdAt, input.updatedAt, deletedAt, input.relPath, mtime, size, input.id,
      ])
    } else {
      await dbExecute('写入笔记索引失败', INDEX_SQL.insertNote, [
        input.id, input.title, input.content, input.folderId, tagsJson, pinned, input.order,
        input.createdAt, input.updatedAt, deletedAt, input.relPath, mtime, size,
      ])
    }
  }
  await syncNoteTagLinks(input.id, input.tags)
  notifyIndexMutated()
}

/** 删除一条笔记的索引行（FTS 行由触发器清理，note_tags 由 FK 级联） */
export async function removeIndexNote(id: string): Promise<void> {
  await dbExecute('删除笔记索引失败', INDEX_SQL.deleteNoteById, [id])
  notifyIndexMutated()
}

/** 刷新某条笔记的文件定位元信息（外部编辑后免重新解析） */
export async function touchIndexFileMeta(id: string, mtimeMs: number, size: number): Promise<void> {
  await dbExecute('刷新笔记文件元信息失败', INDEX_SQL.touchNoteFileMeta, [Math.trunc(mtimeMs), Math.trunc(size), id])
}

/* ============================== 目录索引 ============================== */

/** 中文拼音排序比较器（码点排序会把「学习」排在「工作」前面，与用户直觉不符） */
const zhCompare = new Intl.Collator('zh-CN').compare

/**
 * 按目录树重建 folders 行：
 *  - 父目录先于子目录写入（外键约束）；
 *  - `sort_order` = 同层目录名升序下标（派生值，保证可重建）；
 *  - 已消失的目录行最后删除（此时其下笔记的 folder_id 已被置空或改指）。
 */
export async function upsertFolderRows(folderRels: string[], meta?: Record<string, { id: string; createdAt: number }>): Promise<number> {
  const rels = [...new Set(folderRels.map((rel) => toRelPosix(rel)))].sort((a, b) => zhCompare(a, b))
  const metas = meta ?? (await ensureFolderMetas(rels))
  const ordered = [...rels].sort((a, b) => a.split('/').length - b.split('/').length || zhCompare(a, b))

  const groups = new Map<string, string[]>()
  for (const rel of rels) {
    const parent = relDirOf(rel) || ''
    const list = groups.get(parent) ?? []
    list.push(rel)
    groups.set(parent, list)
  }
  for (const list of groups.values()) list.sort((a, b) => zhCompare(basenameOf(a), basenameOf(b)))

  const existing = await dbSelect<{ id: string; path: string | null }>('读取文件夹索引失败', INDEX_SQL.selectFolderPaths)
  const byPath = new Map(existing.filter((row) => row.path).map((row) => [toRelPosix(String(row.path)), String(row.id)]))
  const byId = new Map(existing.map((row) => [String(row.id), row.path ? toRelPosix(String(row.path)) : null]))

  for (const rel of ordered) {
    const info = metas[rel] ?? (await ensureFolderMetas([rel]))[rel]
    const parentRel = relDirOf(rel)
    const parentId = parentRel ? (byPath.get(parentRel) ?? null) : null
    const siblings = groups.get(parentRel) ?? [rel]
    const order = Math.max(0, siblings.indexOf(rel))
    const id = info?.id ?? newId()
    const createdAt = info?.createdAt ?? 0
    if (byPath.has(rel)) {
      await dbExecute('更新文件夹索引失败', INDEX_SQL.updateFolder, [
        basenameOf(rel), parentId, order, createdAt, rel, byPath.get(rel) as string,
      ])
      continue
    }
    if (byId.has(id)) {
      // 同一 id 换了路径（目录改名 / 父目录改名 / 手工移动）：更新而不是插入，避免主键冲突
      await dbExecute('更新文件夹索引失败', INDEX_SQL.updateFolder, [basenameOf(rel), parentId, order, createdAt, rel, id])
      byPath.set(rel, id)
      continue
    }
    await dbExecute('写入文件夹索引失败', INDEX_SQL.insertFolder, [id, basenameOf(rel), parentId, order, createdAt, rel])
    byPath.set(rel, id)
    byId.set(id, rel)
  }

  // 删除已消失目录（重新读取，避免误删刚刚改名的行）
  const valid = new Set(rels)
  const currentFolders = await dbSelect<{ id: string; path: string | null }>('读取文件夹索引失败', INDEX_SQL.selectFolderPaths)
  for (const row of currentFolders) {
    const path = row.path ? toRelPosix(String(row.path)) : null
    if (path && !valid.has(path)) {
      await dbExecute('删除文件夹索引失败', INDEX_SQL.deleteFolderById, [String(row.id)])
    }
  }
  notifyIndexMutated()
  return rels.length
}

/** 删除目录索引行（含后代） */
export async function removeIndexFolderSubtree(folderRel: string): Promise<void> {
  const prefix = toRelPosix(folderRel)
  const rows = await dbSelect<{ id: string; path: string | null }>('读取文件夹索引失败', INDEX_SQL.selectFolderPaths)
  for (const row of rows) {
    const path = row.path ? toRelPosix(String(row.path)) : null
    if (!path) continue
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      await dbExecute('删除文件夹索引失败', INDEX_SQL.deleteFolderById, [String(row.id)])
    }
  }
  notifyIndexMutated()
}

/** 显式整表重建：丢弃索引结构 → 从文件重新投影 */
export async function rebuildIndex(): Promise<IndexSyncResult> {
  await applyIndexDdl()
  const result = await syncIndexInternal(true)
  await pruneFolderMeta()
  notifyIndexMutated()
  return result
}

/** 增量同步；结构不对时自动退化为整表重建 */
export async function syncIndex(options: { full?: boolean } = {}): Promise<IndexSyncResult> {
  if (options.full) return rebuildIndex()
  if (!(await isIndexShapeReady())) return rebuildIndex()
  return syncIndexInternal(false)
}

/** 把 vault 投影进索引（`full=true` 时忽略 file_mtime 全量重写） */
async function syncIndexInternal(full: boolean): Promise<IndexSyncResult> {
  const files = await scanVault()
  const folderRels = await listFolderRels()
  const folderCount = await upsertFolderRows(folderRels)
  const folderIds = await folderIdMap()

  const rows = await dbSelect<NoteFileRow>('读取笔记索引失败', INDEX_SQL.selectNoteFileRows)
  const rowByRel = new Map<string, NoteFileRow>()
  for (const row of rows) {
    if (row.rel_path) rowByRel.set(toRelPosix(row.rel_path), row)
  }

  let added = 0
  let updated = 0
  let removed = 0
  let repaired = 0

  // 1) 解析需要处理的文件（未变动的文件跳过，避免全量 IO）
  const loaded: Array<{ note: LoadedNote; file: VaultNoteFile }> = []
  for (const file of files) {
    const existing = rowByRel.get(file.relPath)
    const unchanged =
      !full &&
      existing &&
      Number(existing.file_mtime ?? -1) === Math.trunc(file.mtimeMs) &&
      Number(existing.file_size ?? -1) === Math.trunc(file.size)
    if (unchanged) continue
    const note = await loadNote(file)
    if (note.needsIdWrite) {
      // 外部手写 / 手工新建的 md 首次纳入管理：补写 front-matter（id + 推导出的标题等）
      await writeNoteId(file, note)
      const stat = await getStorage().fs.stat(absolutePathOf(file.relPath)).catch(() => null)
      if (stat) {
        file.mtimeMs = stat.mtimeMs
        file.size = stat.size
      }
    }
    loaded.push({ note, file })
  }

  // 2) id 冲突修复（崩溃残留 / 手工复制）：保留 mtime 最新者，其余换新 id 并写回文件
  const byId = new Map<string, Array<{ note: LoadedNote; file: VaultNoteFile }>>()
  for (const item of loaded) {
    const list = byId.get(item.note.id) ?? []
    list.push(item)
    byId.set(item.note.id, list)
  }
  for (const list of byId.values()) {
    if (list.length < 2) continue
    list.sort((a, b) => b.file.mtimeMs - a.file.mtimeMs || a.file.relPath.localeCompare(b.file.relPath))
    for (const loser of list.slice(1)) {
      loser.note.id = newId()
      await writeNoteId(loser.file, loser.note)
      repaired += 1
    }
  }

  // 3) 写索引行
  for (const { note, file } of loaded) {
    const folderRel = file.deleted ? null : file.folderRel
    await writeIndexNote({
      id: note.id,
      title: note.title,
      content: note.content,
      tags: note.tags,
      pinned: note.pinned,
      order: note.order,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      deletedAt: note.deletedAt,
      folderId: folderRel ? (folderIds.get(toRelPosix(folderRel)) ?? null) : null,
      relPath: file.relPath,
      mtimeMs: file.mtimeMs,
      size: file.size,
    })
    if (rowByRel.has(file.relPath)) updated += 1
    else added += 1
  }

  // 4) 删除磁盘上已不存在的笔记行（重新读取，避免误删刚刚改写 rel_path 的行）
  const liveRel = new Set(files.map((file) => file.relPath))
  const currentRows = await dbSelect<NoteFileRow>('读取笔记索引失败', INDEX_SQL.selectNoteFileRows)
  for (const row of currentRows) {
    const rel = row.rel_path ? toRelPosix(row.rel_path) : null
    if (!rel || !liveRel.has(rel)) {
      await removeIndexNote(String(row.id))
      removed += 1
    }
  }

  // 5) 标签：使用中的 ∪ 显式声明的（未声明且无人使用 → 从索引消失）
  const declaredNames = new Set(
    Object.entries(await readTagsMeta())
      .filter(([, info]) => info?.declared === true)
      .map(([name]) => name),
  )
  const used = new Set<string>()
  const noteRows = await dbSelect<{ id: string; tags: string }>('读取笔记索引失败', 'SELECT id, tags FROM notes')
  for (const row of noteRows) {
    for (const name of parseTagsJson(row.tags)) used.add(name)
  }
  const tagMap = await upsertTagRows([...used, ...declaredNames])
  const staleTags = await dbSelect<{ id: string; name: string }>('读取标签索引失败', INDEX_SQL.selectTagNames)
  for (const row of staleTags) {
    const name = String(row.name)
    if (!tagMap.has(name)) await dbExecute('清理标签索引失败', INDEX_SQL.deleteTagById, [String(row.id)])
  }

  const totals = await dbSelect<{ count: number }>('统计索引失败', SQL.countAllNotes)
  return {
    full,
    total: Number(totals[0]?.count ?? 0),
    added,
    updated,
    removed,
    repaired,
    folders: folderCount,
    tags: tagMap.size,
  }
}

/** 全量重建后把 `.paper/folders.json` 中已消失的键清理掉（目录被手工删除） */
export async function pruneFolderMeta(): Promise<number> {
  const meta = await readFoldersMeta()
  const rels = new Set(await listFolderRels())
  let pruned = 0
  for (const key of Object.keys(meta)) {
    if (!rels.has(key)) {
      delete meta[key]
      pruned += 1
    }
  }
  if (pruned > 0) await writeFoldersMeta(meta)
  return pruned
}
