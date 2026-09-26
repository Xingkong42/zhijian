/**
 * tagsRepo —— 标签数据访问（FROZEN 签名，实现归属：db 成员）。
 * ==================================================================
 * t15 起：标签来自 **笔记 front-matter 的 `tags`**（唯一真相源），
 * `.paper/tags.json` 只保存「声明过的标签」的 id / 颜色 / 创建时间，
 * 于是「某个标签只要还有笔记在用就仍然存在」，而索引可纯由文件重建：
 *   - `list()`      → 索引里的标签行（= 使用中的 ∪ 声明的）
 *   - `create`      → 写 `.paper/tags.json`（未被任何笔记使用也仍然存在）
 *   - `rename`      → 改 tags.json 键 + 重写所有相关笔记的 front-matter
 *   - `remove`      → 从 tags.json 删除 + 从所有笔记 front-matter 剔除
 *   - `setNoteTags` → 覆盖式重写该笔记的 front-matter 标签（幂等）
 *   - `updateColor` → 只改 tags.json 的颜色 + 同步索引（**不重写任何 md、不动笔记 updatedAt**）
 *
 * 本文件还导出 `normalizeTagNames()` / `normalizeTagColor()`（内部共享工具，非契约方法）。
 */

import type { Tag, TagCreateInput } from '@/types'
import { now } from '@/lib/utils'
import { dbExecute, dbSelect } from './connection'
import { DbError } from './errors'
import { normalizeTags } from './frontmatter'
import { folderRelById, upsertTagRows, writeIndexNote } from './indexer'
import { toRelPosix } from './paths'
import { DEFAULT_TAG_COLOR, SQL, mapNoteRow, mapTagRow, type NoteFileRow, type TagRow } from './schema'
import { getStorage, vaultPath } from './storage'
import { ensureTagMeta, readTagsMeta, saveNote, writeTagsMeta } from './vault'

export interface TagsRepo {
  /** 新建标签；name 唯一，重复时抛可读 Error（CONSTRAINT） */
  create(input: TagCreateInput): Promise<Tag>
  rename(id: string, name: string): Promise<Tag>
  remove(id: string): Promise<string>
  list(): Promise<Tag[]>
  /**
   * 覆盖式设置某条笔记的标签：
   *  - 不存在的标签名自动创建（用默认色）
   *  - 同步更新 notes.tags 的 JSON 字符串与 note_tags 关系表
   *  - 返回该笔记最终的标签名列表
   */
  setNoteTags(noteId: string, names: string[]): Promise<string[]>
  /** 便捷查询：某标签下的笔记 id 列表 */
  noteIdsByTag(tagId: string): Promise<string[]>
  /**
   * 修改标签颜色（t18 侧栏「改颜色」用；**追加方法，未改动既有签名**）：
   *  - 只写 `.paper/tags.json` 的颜色字段 + 同步索引行 `tags.color`；
   *  - **不重写任何 md 文件、不刷新任何笔记的 updatedAt**（改颜色不属笔记内容变更，
   *    不应影响「最近更新」排序）；
   *  - `color` 只接受 `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`（大小写不限，
   *    与 `src/components/ui/tag-picker.tsx::tagColorOf` 同一口径），统一规范成大写；
   *    短写逐位展开（`#abc` → `#AABBCC`，`#abcd` → `#AABBCCDD`）；
   *    **空值与其它任何非法值一律抛可读 `DbError`**（不静默回落，避免 UI 传值 bug 被掩盖）；
   *  - **幂等**：颜色未变化时直接返回当前 `Tag`，不写文件也不更新索引；
   *  - 返回更新后的 `Tag`（颜色为规范化后的值）。
   */
  updateColor(id: string, color: string): Promise<Tag>
}

/** 标签名规范化（导出供其它模块复用） */
export function normalizeTagNames(names: readonly string[]): string[] {
  return normalizeTags(names)
}

/**
 * 标签颜色规范化（校验口径与 `src/components/ui/tag-picker.tsx::tagColorOf` 完全一致：
 * **只接受 3 / 4 / 6 / 8 位十六进制**）：
 *  - `#rgb` / `#rgba` → 逐位展开为 `#rrggbb` / `#rrggbbaa`；统一大写；
 *  - 空值、缺 `#`、非十六进制、位数不合法 → 抛可读 `DbError`。
 */
export function normalizeTagColor(color: string | null | undefined): string {
  const raw = String(color ?? '').trim()
  if (!raw) {
    throw new DbError('标签颜色不能为空（应为 #rgb / #rgba / #rrggbb / #rrggbbaa）', new Error('CONSTRAINT'))
  }
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    const [r, g, b] = raw.slice(1).split('')
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase()
  }
  if (/^#[0-9a-f]{4}$/i.test(raw)) {
    const [r, g, b, a] = raw.slice(1).split('')
    return `#${r}${r}${g}${g}${b}${b}${a}${a}`.toUpperCase()
  }
  if (/^#[0-9a-f]{6}$/i.test(raw) || /^#[0-9a-f]{8}$/i.test(raw)) return raw.toUpperCase()
  throw new DbError(`标签颜色格式非法：${raw}（应为 #rgb / #rgba / #rrggbb / #rrggbbaa）`, new Error('CONSTRAINT'))
}


async function statRel(relPath: string): Promise<{ mtimeMs: number; size: number }> {
  try {
    const info = await getStorage().fs.stat(vaultPath(relPath))
    return { mtimeMs: info.mtimeMs, size: info.size }
  } catch {
    return { mtimeMs: 0, size: 0 }
  }
}

/** 找出所有可能使用某标签名的笔记行（先用 SQL 粗筛，再在 JS 里精确比对） */
async function noteRowsUsingTag(name: string): Promise<NoteFileRow[]> {
  const rows = await dbSelect<NoteFileRow>(
    '读取标签关联笔记失败',
    'SELECT * FROM notes WHERE tags LIKE $1',
    [`%${name}%`],
  )
  return rows.filter((row) => {
    const tags = mapNoteRow(row).tags
    return tags.includes(name)
  })
}

/** 重写一条笔记的 front-matter（标签变更；`touchUpdated` 决定是否刷新 updated） */
async function rewriteNoteFile(
  row: NoteFileRow,
  transform: (tags: string[]) => string[],
  options: { touchUpdated: boolean },
): Promise<{ id: string; tags: string[] }> {
  const note = mapNoteRow(row)
  if (!row.rel_path) throw new DbError(`笔记缺少文件定位：${note.id}`, new Error('UNKNOWN'))
  const relPath = toRelPosix(String(row.rel_path))
  const tags = normalizeTags(transform(note.tags))
  const folderRel = note.folderId ? await folderRelById(note.folderId) : null
  const updatedAt = options.touchUpdated ? now() : note.updatedAt
  const written = await saveNote(
    {
      id: note.id,
      title: note.title,
      content: note.content,
      tags,
      pinned: note.pinned,
      order: note.order,
      createdAt: note.createdAt,
      updatedAt,
      folderRel,
      deleted: note.deletedAt !== null,
      keepName: true,
    },
    relPath,
  )
  const stat = await statRel(written)
  await writeIndexNote({
    id: note.id,
    title: note.title,
    content: note.content,
    tags,
    pinned: note.pinned,
    order: note.order,
    createdAt: note.createdAt,
    updatedAt,
    deletedAt: note.deletedAt,
    folderId: note.folderId,
    relPath: written,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  })
  return { id: note.id, tags }
}

/** 找出标签行；不存在抛可读 Error */
async function mustGetTagRow(id: string): Promise<TagRow> {
  const rows = await dbSelect<TagRow>('读取标签失败', SQL.selectTagById, [id])
  if (rows.length === 0) throw new DbError(`标签不存在：${id}`, new Error('NOT_FOUND'))
  return rows[0]
}

/** 标签名是否已被占用（显式声明过，或已有笔记在使用） */
async function tagNameTaken(name: string): Promise<boolean> {
  const meta = await readTagsMeta()
  if (meta[name]?.declared === true) return true
  const rows = await dbSelect<{ id: string }>('读取标签失败', SQL.selectTagByName, [name])
  return rows.length > 0
}

export const tagsRepo: TagsRepo = {
  async create(input: TagCreateInput): Promise<Tag> {
    const name = normalizeTags([input.name])[0]
    if (!name) throw new DbError('标签名不能为空', new Error('CONSTRAINT'))
    if (await tagNameTaken(name)) throw new DbError(`标签「${name}」已存在`, new Error('CONSTRAINT'))

    const color = input.color?.trim() || DEFAULT_TAG_COLOR
    const meta = await ensureTagMeta(name, color, true)
    await writeTagsMeta({ ...(await readTagsMeta()), [name]: meta })
    // 立刻进索引：保证 create 之后 list() 就能看到（即使还没有笔记使用它）
    await upsertTagRows([name])
    return { id: meta.id, name, color: meta.color, createdAt: meta.createdAt }
  },

  async rename(id: string, name: string): Promise<Tag> {
    const next = normalizeTags([name])[0]
    if (!next) throw new DbError('标签名不能为空', new Error('CONSTRAINT'))
    const row = await mustGetTagRow(id)
    const previous = String(row.name)
    if (previous === next) return mapTagRow(row)
    if (await tagNameTaken(next)) throw new DbError(`标签「${next}」已存在`, new Error('CONSTRAINT'))

    // 1) 元数据改名（保留 id / 颜色 / 创建时间）
    const meta = await readTagsMeta()
    const info = meta[previous] ?? { id, color: row.color, createdAt: Number(row.created_at ?? now()) }
    delete meta[previous]
    meta[next] = info
    await writeTagsMeta(meta)

    // 2) 所有用到旧名的笔记：重写 front-matter
    for (const noteRow of await noteRowsUsingTag(previous)) {
      await rewriteNoteFile(noteRow, (tags) => tags.map((item) => (item === previous ? next : item)), {
        touchUpdated: true,
      })
    }
    await upsertTagRows([next])
    const refreshed = await dbSelect<TagRow>('读取标签失败', SQL.selectTagById, [id])
    return refreshed.length > 0
      ? mapTagRow(refreshed[0])
      : { id, name: next, color: info.color, createdAt: info.createdAt }
  },

  async remove(id: string): Promise<string> {
    const row = await mustGetTagRow(id)
    const name = String(row.name)

    // 1) 从所有笔记的 front-matter 里剔除（笔记本身与其它标签不受影响）
    for (const noteRow of await noteRowsUsingTag(name)) {
      await rewriteNoteFile(noteRow, (tags) => tags.filter((item) => item !== name), { touchUpdated: true })
    }

    // 2) 元数据删除
    const meta = await readTagsMeta()
    if (meta[name]) {
      delete meta[name]
      await writeTagsMeta(meta)
    }

    // 3) 索引行删除（note_tags 由 FK 级联清理）
    await dbExecute('删除标签索引失败', 'DELETE FROM tags WHERE id = $1', [id])
    return id
  },

  async list(): Promise<Tag[]> {
    const rows = await dbSelect<TagRow>('读取标签失败', SQL.listTags)
    return rows.map(mapTagRow)
  },

  async setNoteTags(noteId: string, names: string[]): Promise<string[]> {
    const rows = await dbSelect<NoteFileRow>('读取笔记失败', SQL.selectNoteByIdAny, [noteId])
    if (rows.length === 0 || !rows[0].rel_path) {
      throw new DbError(`笔记不存在：${noteId}`, new Error('NOT_FOUND'))
    }
    const result = await rewriteNoteFile(rows[0], () => names, { touchUpdated: true })
    return result.tags
  },

  async noteIdsByTag(tagId: string): Promise<string[]> {
    const rows = await dbSelect<{ id: string }>('查询标签下笔记失败', SQL.selectNoteIdsByTag, [tagId])
    return rows.map((item) => String(item.id))
  },

  async updateColor(id: string, color: string): Promise<Tag> {
    const next = normalizeTagColor(color)
    const row = await mustGetTagRow(id)
    const name = String(row.name)
    const current = mapTagRow(row)

    // 幂等：颜色已经是目标值 → 不写文件、不更新索引，直接返回当前 Tag
    if (normalizeTagColor(current.color) === next) return current

    // 只改元数据 + 索引行；不写 md、不刷新笔记 updatedAt
    const meta = await readTagsMeta()
    const info = meta[name] ?? { id, color: row.color, createdAt: Number(row.created_at ?? now()) }
    meta[name] = { ...info, id: info.id ?? id, color: next }
    await writeTagsMeta(meta)
    await upsertTagRows([name])

    const refreshed = await dbSelect<TagRow>('读取标签失败', SQL.selectTagById, [id])
    if (refreshed.length > 0) return mapTagRow(refreshed[0])
    return { id, name, color: next, createdAt: Number(row.created_at ?? 0) }
  },
}
