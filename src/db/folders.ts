/**
 * foldersRepo —— 文件夹数据访问（FROZEN 签名，实现归属：db 成员）。
 * ==================================================================
 * t15 起：**文件夹 = vault 下的子目录**（支持嵌套），因此：
 *  - `create`  → 建目录 + 在 `.paper/folders.json` 里登记稳定 id；
 *  - `rename`  → 目录改名（id 不变 → 上层持有的 folderId 不失效）；
 *  - `remove`  → 子树内的**笔记文件先移到收件箱**（不删数据），再删除目录树；
 *  - `list/tree` → 读索引（索引可由目录树重建）。
 *
 * 排序：目录没有元数据文件，`Folder.order` 是**派生值** = 同层目录名升序下标
 * （见 docs/ARCHITECTURE.md §4.12）。`FolderCreateInput.order` 因此被接受但忽略。
 */

import type { Folder, FolderCreateInput, FolderTreeNode } from '@/types'
import { dbSelect } from './connection'
import { DbError } from './errors'
import { sanitizeStem } from './frontmatter'
import { folderRelById, syncIndex, writeIndexNote } from './indexer'
import { basenameOf, toRelPosix } from './paths'
import { SQL, mapFolderRow, type FolderRow, type NoteFileRow } from './schema'
import { getStorage, vaultPath } from './storage'
import {
  dropFolderMetas,
  ensureFolderMeta,
  remapFolderMetas,
  removeFolderDir,
  renameFolderDir,
  saveNote,
} from './vault'

export interface FoldersRepo {
  /** 新建文件夹；parentId=null 为顶层 */
  create(input: FolderCreateInput): Promise<Folder>
  rename(id: string, name: string): Promise<Folder>
  /** 删除文件夹；其下笔记的 folderId 置空（回到收件箱），子文件夹一并删除 */
  remove(id: string): Promise<string>
  /** 扁平列表（按 parent 分组顺序） */
  list(): Promise<Folder[]>
  /** 树形结构（根节点 children 递归） */
  tree(): Promise<FolderTreeNode[]>
}

async function selectFolderRows(sql: string, values: unknown[] = []): Promise<FolderRow[]> {
  return dbSelect<FolderRow>('读取文件夹失败', sql, values)
}

/** 按 id 取文件夹行；不存在抛可读 Error */
async function mustGetFolderRow(id: string): Promise<FolderRow> {
  const rows = await selectFolderRows(SQL.selectFolderById, [id])
  if (rows.length === 0) throw new DbError(`文件夹不存在：${id}`, new Error('NOT_FOUND'))
  return rows[0]
}

/** 文件 mtime/size（写索引用） */
async function statRel(relPath: string): Promise<{ mtimeMs: number; size: number }> {
  try {
    const info = await getStorage().fs.stat(vaultPath(relPath))
    return { mtimeMs: info.mtimeMs, size: info.size }
  } catch {
    return { mtimeMs: 0, size: 0 }
  }
}

/** 在指定父目录下分配一个不冲突的目录名 */
async function allocateDirName(parentRel: string | null, desired: string): Promise<string> {
  const { fs, vaultRoot } = getStorage()
  const absoluteParent = parentRel ? vaultPath(parentRel) : vaultRoot
  const taken = new Set<string>()
  try {
    for (const entry of await fs.readDir(absoluteParent)) {
      if (entry.isDirectory) taken.add(entry.name.toLowerCase())
    }
  } catch {
    /* 父目录不存在：视为空 */
  }
  const base = sanitizeStem(desired) || '新建文件夹'
  if (!taken.has(base.toLowerCase())) return base
  for (let index = 2; index <= 999; index += 1) {
    const candidate = `${base}-${index}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${base}-${Date.now()}`
}

/** 取目录下笔记（含子树），用于删除文件夹时把笔记移回收件箱 */
async function noteRowsInSubtree(folderRel: string): Promise<NoteFileRow[]> {
  const prefix = toRelPosix(folderRel)
  const rows = await dbSelect<NoteFileRow>('读取笔记失败', 'SELECT * FROM notes')
  return rows.filter((row) => {
    if (!row.rel_path) return false
    const rel = toRelPosix(row.rel_path)
    return rel.startsWith(`${prefix}/`)
  })
}

export const foldersRepo: FoldersRepo = {
  async create(input: FolderCreateInput): Promise<Folder> {
    const { fs } = getStorage()
    const rawName = String(input.name ?? '').trim()
    if (!rawName) throw new DbError('文件夹名不能为空', new Error('CONSTRAINT'))
    const parentId = input.parentId ?? null
    let parentRel: string | null = null
    if (parentId !== null) {
      parentRel = await folderRelById(parentId)
      if (!parentRel) throw new DbError(`上级文件夹不存在：${parentId}`, new Error('NOT_FOUND'))
    }

    const dirName = await allocateDirName(parentRel, input.name)
    const rel = parentRel ? toRelPosix(`${parentRel}/${dirName}`) : dirName
    await fs.mkdir(vaultPath(rel), { recursive: true })
    const meta = await ensureFolderMeta(rel)
    await syncIndex()

    const rows = await selectFolderRows(SQL.selectFolderById, [meta.id])
    if (rows.length > 0) return mapFolderRow(rows[0])
    return { id: meta.id, name: dirName, parentId, order: 0, createdAt: meta.createdAt }
  },

  async rename(id: string, name: string): Promise<Folder> {
    const rawName = String(name ?? '').trim()
    if (!rawName) throw new DbError('文件夹名不能为空', new Error('CONSTRAINT'))
    const row = await mustGetFolderRow(id)
    const currentRel = row.path ? toRelPosix(String(row.path)) : null
    if (!currentRel) throw new DbError(`文件夹缺少目录定位：${id}`, new Error('UNKNOWN'))

    const desired = sanitizeStem(rawName) || '新建文件夹'
    if (basenameOf(currentRel) === desired) return mapFolderRow(row)

    const parentRel = currentRel.includes('/') ? currentRel.slice(0, currentRel.lastIndexOf('/')) : null
    const dirName = await allocateDirName(parentRel, desired)
    const nextRel = parentRel ? toRelPosix(`${parentRel}/${dirName}`) : dirName

    await renameFolderDir(currentRel, nextRel)
    await remapFolderMetas(currentRel, nextRel)
    await syncIndex()

    const rows = await selectFolderRows(SQL.selectFolderById, [id])
    if (rows.length === 0) throw new DbError(`文件夹改名后未能读回：${id}`, new Error('UNKNOWN'))
    return mapFolderRow(rows[0])
  },

  async remove(id: string): Promise<string> {
    const row = await mustGetFolderRow(id)
    const rel = row.path ? toRelPosix(String(row.path)) : null
    if (!rel) throw new DbError(`文件夹缺少目录定位：${id}`, new Error('UNKNOWN'))

    // 1) 子树里的笔记先移回收件箱（数据优先：绝不因为删目录而丢笔记 / 标签）
    for (const noteRow of await noteRowsInSubtree(rel)) {
      if (!noteRow.rel_path) continue
      const relPath = toRelPosix(noteRow.rel_path)
      const tags = parseTagsJsonSafe(noteRow.tags)
      const timestamp = Date.now()
      const written = await saveNote(
        {
          id: String(noteRow.id),
          title: String(noteRow.title ?? ''),
          content: String(noteRow.content ?? ''),
          tags,
          pinned: Number(noteRow.pinned) !== 0,
          order: Number(noteRow.sort_order ?? 0),
          createdAt: Number(noteRow.created_at ?? 0),
          updatedAt: timestamp,
          folderRel: null,
          deleted: false,
        },
        relPath,
      )
      const stat = await statRel(written)
      await writeIndexNote({
        id: String(noteRow.id),
        title: String(noteRow.title ?? ''),
        content: String(noteRow.content ?? ''),
        tags,
        pinned: Number(noteRow.pinned) !== 0,
        order: Number(noteRow.sort_order ?? 0),
        createdAt: Number(noteRow.created_at ?? 0),
        updatedAt: timestamp,
        deletedAt: null,
        folderId: null,
        relPath: written,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      })
    }

    // 2) 删目录树 + 元数据 + 索引
    await removeFolderDir(rel)
    await dropFolderMetas(rel)
    await syncIndex()
    return id
  },

  async list(): Promise<Folder[]> {
    const rows = await selectFolderRows(SQL.listFolders)
    return rows.map(mapFolderRow)
  },

  async tree(): Promise<FolderTreeNode[]> {
    const folders = (await selectFolderRows(SQL.listFolders)).map(mapFolderRow)
    const byId = new Map<string, FolderTreeNode>()
    for (const folder of folders) byId.set(folder.id, { ...folder, children: [] })

    const roots: FolderTreeNode[] = []
    for (const folder of folders) {
      const node = byId.get(folder.id)
      if (!node) continue
      const parent = folder.parentId ? byId.get(folder.parentId) : undefined
      if (parent) parent.children.push(node)
      else roots.push(node)
    }

    const sortNodes = (nodes: FolderTreeNode[]): void => {
      nodes.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      for (const node of nodes) sortNodes(node.children)
    }
    sortNodes(roots)
    return roots
  },
}

/** 解析 notes.tags JSON（删除文件夹时保留标签，避免数据丢失） */
function parseTagsJsonSafe(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(String(raw))
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}
