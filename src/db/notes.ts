/**
 * notesRepo —— 便笺数据访问（FROZEN 签名，实现归属：db 成员）。
 * ==================================================================
 * t15 起：**md 文件是唯一真相源**，SQLite 只是可随时重建的索引。
 * 因此每个写方法都是「先落盘（原子写 + 必要时改名/移动文件）→ 再刷新索引行」：
 *   - `create`      → 新建 md（front-matter 写全元数据）
 *   - `update`      → 改写 md；标题变化 → 文件改名；文件夹变化 → 文件移动；
 *                     `deletedAt` 变化 → 进出 `.trash/`
 *   - `remove`      → 移入 `.trash/`（保留文件，登记 `.paper/trash.json`）
 *   - `restore`     → 从 `.trash/` 移回原文件夹
 *   - `hardDelete`  → 真正删除文件
 *   - `move`        → 目标文件夹内整数重排（front-matter 的 order）；跨文件夹时移动文件；
 *                     只刷新被移动笔记的 `updated`，邻居仅改 `order`（不污染"最近更新"）
 * 读路径（get/listAll/listByFolder/listByTag/counts）走索引，索引由 `syncIndex()`
 * 保证与文件一致（启动增量、外部编辑可见、重建后等价）。
 */

import type { MoveTarget, Note, NoteCounts, NoteCreateInput, NoteUpdatePatch } from '@/types'
import { newId, now } from '@/lib/utils'
import { dbSelect } from './connection'
import { DbError } from './errors'
import { foldTitle, normalizeTags } from './frontmatter'
import { removeIndexNote, writeIndexNote } from './indexer'
import { toRelPosix } from './paths'
import { INDEX_SQL, SQL, buildNotesListQuery, mapNoteRow, type NoteFileRow, type NoteRow } from './schema'
import { getStorage, vaultPath } from './storage'
import {
  deleteFile,
  hardDeleteTrashed,
  loadNote,
  moveToTrash,
  restoreFromTrash,
  saveNote,
} from './vault'

export interface NotesListFilter {
  /** 目标文件夹；null = 收件箱（folderId IS NULL）；undefined = 不限 */
  folderId?: string | null
  /** 按标签名过滤 */
  tagName?: string
  /** 是否包含软删除的笔记，默认 false */
  includeDeleted?: boolean
  /** 仅软删除的笔记（回收站视图） */
  onlyDeleted?: boolean
  /** 排序字段，默认 'order' */
  sortBy?: 'order' | 'updatedAt' | 'createdAt' | 'title'
  /** 排序方向，默认 'asc'（sortBy='updatedAt' 时默认 'desc'） */
  direction?: 'asc' | 'desc'
}

export interface NotesRepo {
  /** 新建笔记；返回落库后的完整 Note（id/createdAt 由本层生成） */
  create(input?: NoteCreateInput): Promise<Note>
  /** 局部更新；自动刷新 updatedAt；返回更新后的 Note */
  update(id: string, patch: NoteUpdatePatch): Promise<Note>
  /** 软删除（写 deletedAt）；返回被删除的 id */
  remove(id: string): Promise<string>
  /** 从回收站恢复（deletedAt = null） */
  restore(id: string): Promise<Note>
  /** 物理删除（不可恢复） */
  hardDelete(id: string): Promise<string>
  /** 读取单条；不存在或已软删除返回 null */
  get(id: string): Promise<Note | null>
  /** 全部笔记（默认不含软删除） */
  listAll(filter?: NotesListFilter): Promise<Note[]>
  /** 某文件夹下的笔记（folderId=null 表示收件箱） */
  listByFolder(folderId: string | null): Promise<Note[]>
  /** 某标签下的笔记 */
  listByTag(tagName: string): Promise<Note[]>
  /** 拖拽排序 / 跨文件夹移动 */
  move(id: string, target: MoveTarget): Promise<Note>
  /**
   * 按给定顺序**整体重排**（可跨文件夹）—— t42，追加方法，未改既有签名。
   *
   * 语义：
   *  - 为 `orderedIds` 中每篇笔记按**数组下标**写入 `order`（0,1,2…，唯一且严格递增），
   *    重写 md front-matter 并同步索引；
   *  - **绝不刷新 `updatedAt`**：重排不是内容变更，否则会污染「最近更新」视图
   *    （t11/t15 立下的红线；这也是本方法必须由 db 层提供的原因 ——
   *    `update(id, { order })` 会无条件写 `updated_at`）；
   *  - `pinned` 分区**完全由调用方给的顺序决定**（调用方给的就是"用户看到的顺序"），
   *    db 侧不做任何再排序，因此不产生坐标系歧义；
   *  - **边界（选择"跳过"而非报错）**：不存在的 id / 空串 / 重复 id 一律跳过，
   *    未出现在数组里的笔记保持原 `order` 不变。理由：拖拽是高频交互，
   *    一次过期 id（例如另一窗口刚删掉的笔记）不应该让整次重排失败，
   *    与 `listAll()` 等只读路径"尽力而为"的取向一致；
   *  - **不重命名、不移动文件**（`keepName`）：只改 front-matter 里的 `order`；
   *  - 返回按 `orderedIds` 顺序排列的成功重排结果（被跳过的 id 不出现在返回值里）。
   */
  reorder(orderedIds: readonly string[]): Promise<Note[]>
  /** 侧边栏计数：全部 / 回收站 / 各文件夹 / 各标签 */
  counts(): Promise<NoteCounts>
  /** 覆盖式写入某条笔记的标签集合 */
  setTags(id: string, tags: string[]): Promise<Note>
}

/* ============================ 内部工具 ============================ */

async function selectNoteRows(sql: string, values: unknown[] = []): Promise<NoteRow[]> {
  return dbSelect<NoteRow>('读取笔记失败', sql, values)
}

/** 读取索引行（含文件定位列）；`includeDeleted=false` 时软删除视为不存在 */
async function mustGetFileRow(id: string, includeDeleted = false): Promise<NoteFileRow> {
  const rows = await dbSelect<NoteFileRow>(
    '读取笔记失败',
    includeDeleted ? SQL.selectNoteByIdAny : SQL.selectNoteById,
    [id],
  )
  if (rows.length === 0) {
    throw new DbError(includeDeleted ? `笔记不存在：${id}` : `笔记不存在或已删除：${id}`, new Error('NOT_FOUND'))
  }
  if (!rows[0].rel_path) {
    throw new DbError(`笔记缺少文件定位（索引可能已过期，请在设置中重建索引）：${id}`, new Error('UNKNOWN'))
  }
  return rows[0]
}

/** 文件夹 id → 库内相对路径；不存在则抛可读错误 */
async function requireFolderRel(folderId: string): Promise<string> {
  const rows = await dbSelect<{ id: string; path: string | null }>(
    '读取文件夹失败',
    `${INDEX_SQL.selectFolderPaths} WHERE id = $1`,
    [folderId],
  )
  const path = rows[0]?.path
  if (!path) throw new DbError(`目标文件夹不存在：${folderId}`, new Error('NOT_FOUND'))
  return toRelPosix(String(path))
}

/** 文件夹 id → 相对路径或 null（缺失时 null，避免打断批量写入） */
async function folderRelOrNull(folderId: string): Promise<string | null> {
  try {
    return await requireFolderRel(folderId)
  } catch {
    return null
  }
}

/** 新建笔记的排序位：当前最小值 - 1（越小越靠前 → 新笔记出现在列表最前） */
async function nextNoteOrder(folderId: string | null): Promise<number> {
  const rows =
    folderId === null
      ? await dbSelect<{ min_order: number }>('读取笔记排序位失败', SQL.minOrderInbox)
      : await dbSelect<{ min_order: number }>('读取笔记排序位失败', SQL.minOrderInFolder, [folderId])
  return Number(rows[0]?.min_order ?? 0) - 1
}

/** 写文件后取最新 mtime/size（供索引增量判断） */
async function statOfRel(relPath: string): Promise<{ mtimeMs: number; size: number }> {
  try {
    const info = await getStorage().fs.stat(vaultPath(relPath))
    return { mtimeMs: info.mtimeMs, size: info.size }
  } catch {
    return { mtimeMs: 0, size: 0 }
  }
}

/** 写盘入参（saveNote 的形状） */
function noteFileInput(
  note: Note,
  folderRel: string | null,
  deleted: boolean,
  keepName?: boolean,
): Parameters<typeof saveNote>[0] {
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    tags: note.tags,
    pinned: note.pinned,
    order: note.order,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    folderRel,
    deleted,
    keepName,
  }
}

/* ================================ repo ================================ */

export const notesRepo: NotesRepo = {
  async create(input: NoteCreateInput = {}): Promise<Note> {
    const timestamp = now()
    const folderId = input.folderId ?? null
    const folderRel = folderId ? await requireFolderRel(folderId) : null
    const note: Note = {
      id: newId(),
      title: foldTitle(input.title ?? ''),
      content: input.content ?? '',
      folderId,
      tags: normalizeTags(input.tags ?? []),
      pinned: input.pinned === true,
      order: input.order ?? (await nextNoteOrder(folderId)),
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    }

    const relPath = await saveNote(noteFileInput(note, folderRel, false))
    await writeIndexNote({ ...toIndexInput(note, relPath, await statOfRel(relPath)) })
    return note
  },

  async update(id: string, patch: NoteUpdatePatch): Promise<Note> {
    const row = await mustGetFileRow(id, true)
    const current = mapNoteRow(row)
    const timestamp = now()

    const folderId = patch.folderId !== undefined ? (patch.folderId ?? null) : current.folderId
    const wantsDeleted = patch.deletedAt !== undefined ? patch.deletedAt !== null : current.deletedAt !== null
    const deletedAt = wantsDeleted ? (patch.deletedAt ?? current.deletedAt ?? timestamp) : null

    const next: Note = {
      id: current.id,
      title: foldTitle(patch.title ?? current.title),
      content: patch.content ?? current.content,
      folderId,
      tags: patch.tags !== undefined ? normalizeTags(patch.tags) : current.tags,
      pinned: patch.pinned ?? current.pinned,
      order: patch.order ?? current.order,
      createdAt: current.createdAt,
      updatedAt: timestamp,
      deletedAt,
    }

    let relPath = toRelPosix(String(row.rel_path))
    const wasDeleted = current.deletedAt !== null

    if (!wasDeleted && wantsDeleted) {
      // 进入回收站：先移动文件（保留原名，trash.json 以文件名为键），再写入最新内容
      relPath = await moveToTrash(relPath, {
        id: current.id,
        folderRel: current.folderId ? await folderRelOrNull(current.folderId) : null,
      })
      relPath = await saveNote(noteFileInput(next, null, true, true), relPath)
    } else if (wasDeleted && !wantsDeleted) {
      // 从回收站恢复：移回原文件夹（文件名按标题重新分配）
      const loaded = await loadNote({ relPath, folderRel: null, deleted: true, mtimeMs: 0, size: 0 })
      relPath = await restoreFromTrash(relPath, loaded)
      relPath = await saveNote(noteFileInput(next, next.folderId ? await folderRelOrNull(next.folderId) : null, false), relPath)
    } else {
      const folderRel = next.folderId ? await folderRelOrNull(next.folderId) : null
      relPath = await saveNote(noteFileInput(next, folderRel, wantsDeleted, wantsDeleted), relPath)
    }

    await writeIndexNote(toIndexInput(next, relPath, await statOfRel(relPath)))
    return next
  },

  async remove(id: string): Promise<string> {
    const row = await mustGetFileRow(id, true)
    const current = mapNoteRow(row)
    const timestamp = now()
    const next: Note = { ...current, updatedAt: timestamp, deletedAt: timestamp }
    let relPath = toRelPosix(String(row.rel_path))
    if (current.deletedAt === null) {
      relPath = await moveToTrash(relPath, {
        id: current.id,
        folderRel: current.folderId ? await folderRelOrNull(current.folderId) : null,
      })
    }
    await writeIndexNote(toIndexInput(next, relPath, await statOfRel(relPath)))
    return id
  },

  async restore(id: string): Promise<Note> {
    return notesRepo.update(id, { deletedAt: null })
  },

  async hardDelete(id: string): Promise<string> {
    const row = await mustGetFileRow(id, true)
    const relPath = toRelPosix(String(row.rel_path))
    if (mapNoteRow(row).deletedAt !== null) await hardDeleteTrashed(relPath)
    else await deleteFile(relPath)
    await removeIndexNote(id)
    return id
  },

  async get(id: string): Promise<Note | null> {
    const rows = await selectNoteRows(SQL.selectNoteById, [id])
    return rows.length > 0 ? mapNoteRow(rows[0]) : null
  },

  async listAll(filter: NotesListFilter = {}): Promise<Note[]> {
    const built = buildNotesListQuery(filter)
    const rows = await selectNoteRows(built.sql, built.values)
    return rows.map(mapNoteRow)
  },

  async listByFolder(folderId: string | null): Promise<Note[]> {
    return notesRepo.listAll({ folderId })
  },

  async listByTag(tagName: string): Promise<Note[]> {
    return notesRepo.listAll({ tagName })
  },

  async move(id: string, target: MoveTarget): Promise<Note> {
    const row = await mustGetFileRow(id)
    const current = mapNoteRow(row)
    const targetFolderId = target.folderId !== undefined ? (target.folderId ?? null) : current.folderId
    const targetFolderRel = targetFolderId ? await requireFolderRel(targetFolderId) : null

    const rawIndex = Number(target.targetIndex)
    const targetIndex = Number.isFinite(rawIndex) ? Math.max(0, Math.trunc(rawIndex)) : 0

    const scope = await dbSelect<{ id: string; sort_order: number }>(
      '读取排序列表失败',
      targetFolderId === null ? SQL.scopeInbox : SQL.scopeFolder,
      targetFolderId === null ? [] : [targetFolderId],
    )
    const previousOrder = new Map(scope.map((item) => [String(item.id), Number(item.sort_order)]))
    const others = scope.map((item) => String(item.id)).filter((noteId) => noteId !== id)
    const insertAt = Math.min(targetIndex, others.length)
    const ordered = [...others.slice(0, insertAt), id, ...others.slice(insertAt)]

    const timestamp = now()
    let relPath = toRelPosix(String(row.rel_path))
    let moved: Note = current

    for (let index = 0; index < ordered.length; index += 1) {
      const noteId = ordered[index]
      if (noteId === id) {
        moved = { ...current, folderId: targetFolderId, order: index, updatedAt: timestamp }
        relPath = await saveNote(noteFileInput(moved, targetFolderRel, false), relPath)
        await writeIndexNote(toIndexInput(moved, relPath, await statOfRel(relPath)))
        continue
      }
      if (previousOrder.get(noteId) === index) continue
      // 邻居：只改 front-matter 的 order，updated 保持不变（不污染"最近更新"排序）
      const neighborRows = await dbSelect<NoteFileRow>('读取笔记失败', SQL.selectNoteByIdAny, [noteId])
      if (neighborRows.length === 0 || !neighborRows[0].rel_path) continue
      const neighbor = mapNoteRow(neighborRows[0])
      const neighborRel = toRelPosix(String(neighborRows[0].rel_path))
      const neighborFolderRel = neighbor.folderId ? await folderRelOrNull(neighbor.folderId) : null
      const writtenRel = await saveNote(
        noteFileInput({ ...neighbor, order: index }, neighborFolderRel, false, true),
        neighborRel,
      )
      await writeIndexNote(
        toIndexInput({ ...neighbor, order: index }, writtenRel, await statOfRel(writtenRel)),
      )
    }

    return moved
  },

  /**
   * t42：整体重排（跨文件夹）——**只改 order，绝不刷新 updatedAt**。
   * 见接口处的语义说明；实现刻意与 `move` 的"重排邻居"共用同一套写入通道：
   * `saveNote(..., keepName: true)`（保留文件名与 `updated`）+ `writeIndexNote`。
   */
  async reorder(orderedIds: readonly string[]): Promise<Note[]> {
    const seen = new Set<string>()
    const reordered: Note[] = []
    let nextOrder = 0

    for (const rawId of orderedIds) {
      const id = String(rawId ?? '').trim()
      if (!id || seen.has(id)) continue // 空串 / 重复 id：跳过（见接口注释的边界说明）
      seen.add(id)

      const rows = await dbSelect<NoteFileRow>('读取笔记失败', SQL.selectNoteByIdAny, [id])
      if (rows.length === 0 || !rows[0].rel_path) continue // 不存在的 id：跳过
      const current = mapNoteRow(rows[0])
      const relPath = toRelPosix(String(rows[0].rel_path))
      const folderRel = current.folderId ? await folderRelOrNull(current.folderId) : null

      // 注意：updatedAt 沿用 current.updatedAt（**不刷新**），这正是本方法存在的意义
      const next: Note = { ...current, order: nextOrder }
      const written = await saveNote(noteFileInput(next, folderRel, current.deletedAt !== null, true), relPath)
      await writeIndexNote(toIndexInput(next, written, await statOfRel(written)))
      reordered.push(next)
      nextOrder += 1
    }

    return reordered
  },

  async counts(): Promise<NoteCounts> {
    const [allRows, trashRows, folderRows, tagRows] = await Promise.all([
      dbSelect<{ count: number }>('统计笔记失败', SQL.countAllNotes),
      dbSelect<{ count: number }>('统计回收站失败', SQL.countTrashNotes),
      dbSelect<{ folder_id: string; count: number }>('统计文件夹笔记失败', SQL.countNotesByFolder),
      dbSelect<{ name: string; count: number }>('统计标签笔记失败', SQL.countNotesByTag),
    ])

    const byFolder: Record<string, number> = {}
    for (const row of folderRows) byFolder[String(row.folder_id)] = Number(row.count)
    const byTag: Record<string, number> = {}
    for (const row of tagRows) byTag[String(row.name)] = Number(row.count)

    return {
      all: Number(allRows[0]?.count ?? 0),
      trash: Number(trashRows[0]?.count ?? 0),
      byFolder,
      byTag,
    }
  },

  async setTags(id: string, tags: string[]): Promise<Note> {
    return notesRepo.update(id, { tags })
  },
}

/** 组装索引行入参 */
function toIndexInput(note: Note, relPath: string, stat: { mtimeMs: number; size: number }) {
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    tags: note.tags,
    pinned: note.pinned,
    order: note.order,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    deletedAt: note.deletedAt,
    folderId: note.folderId,
    relPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  }
}
