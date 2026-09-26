/**
 * vault —— 「md 文件为真相源」的文件布局引擎。
 * ==================================================================
 * 负责：目录/文件布局、front-matter 读写、原子写入、标题重命名、
 * `.trash/` 软删除、`.paper/` 元数据（标签 / 文件夹 / 回收站 / 迁移记录）。
 * **不碰 SQLite**：索引由 `indexer.ts` 负责，两者通过 {@link LoadedNote} 交接。
 *
 * 关键不变量：
 *  - 所有落盘都是「先写临时文件 → rename」，任何时刻磁盘上的 md 都是完整的；
 *  - 标题变化 → 文件另存到新名字后再删旧文件（先写后删，绝不先删）；
 *  - 文件名冲突自动加 `-2`/`-3`；无标题用「无标题-<短id>」；
 *  - 元数据都是 vault 内的普通文件，因此「索引可纯由文件重建」。
 */

import { newId, now } from '@/lib/utils'
import {
  allocateStem,
  foldTitle,
  normalizeTags,
  parseFrontMatter,
  serializeFrontMatter,
  shortIdSuffix,
  type FrontMatterData,
} from './frontmatter'
import {
  basenameOf,
  isHiddenName,
  joinPath,
  relNameOf,
  relDirOf,
  stemOf,
  toRelPosix,
} from './paths'
import { DEFAULT_TAG_COLOR } from './schema'
import { appendVaultLog, getStorage, metaPath, vaultJoin, vaultPath, writeFileAtomic } from './storage'

/** 软删除目录（vault 根下，相对路径） */
export const TRASH_DIR = '.trash'

/* ============================== 类型 ============================== */

/** 扫描到的 md 文件 */
export interface VaultNoteFile {
  /** 库内相对路径（POSIX） */
  relPath: string
  /** 所属文件夹相对路径；null = 收件箱（vault 根）；.trash 内一律 null */
  folderRel: string | null
  /** 是否位于 .trash（软删除） */
  deleted: boolean
  mtimeMs: number
  size: number
}

/** 从文件读出的笔记（含文件定位信息） */
export interface LoadedNote {
  id: string
  title: string
  content: string
  tags: string[]
  pinned: boolean
  order: number
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  folderRel: string | null
  relPath: string
  mtimeMs: number
  size: number
  /** 文件缺 `id` 时由调用方补写 front-matter */
  needsIdWrite: boolean
  /** 文件完全没有 front-matter（外部手写 md） */
  hadFrontMatter: boolean
}

/** 写入笔记的入参 */
export interface SaveNoteInput {
  id: string
  title: string
  content: string
  tags: string[]
  pinned: boolean
  order: number
  createdAt: number
  updatedAt: number
  /** 目标文件夹相对路径（null = 收件箱） */
  folderRel: string | null
  /** 目标是否在回收站 */
  deleted: boolean
  /**
   * 强制保留当前文件名（不按标题重算）：
   * 回收站内的文件必须保名，因为 `.paper/trash.json` 以文件名为键登记
   * 「原始文件夹 + 删除时间」。目标目录里若已存在同名文件，仍会自动加后缀。
   */
  keepName?: boolean
}

export interface FolderMeta {
  id: string
  createdAt: number
}

export interface TagMeta {
  id: string
  color: string
  createdAt: number
  /**
   * 是否为「显式声明的标签」（`tagsRepo.create` 或旧库迁移而来）。
   * 使用中的标签即使没有声明也存在；一旦最后一个使用者消失，
   * 未声明的标签就会从索引里消失（元数据仍留在 tags.json 里保留 id/颜色）。
   */
  declared?: boolean
}

export interface TrashMeta {
  id: string
  /** 删除前所在文件夹（null = 收件箱） */
  originalFolderRel: string | null
  deletedAt: number
}

export interface MigrationMeta {
  source: string
  backupPath: string | null
  completedAt: number
  counts: { notes: number; folders: number; tags: number }
}

/* ============================ 元数据文件 ============================ */

/** 读取 `.paper/<name>` 的 JSON；不存在或损坏时返回 fallback 并告警 */
export async function readMetaJson<T>(name: string, fallback: T): Promise<T> {
  const { fs } = getStorage()
  const path = metaPath(name)
  try {
    if (!(await fs.exists(path))) return fallback
    const raw = await fs.readTextFile(path)
    if (!raw.trim()) return fallback
    return JSON.parse(raw) as T
  } catch (error) {
    console.warn(`[纸笺] 读取元数据失败（${name}），已按默认值继续：`, error)
    return fallback
  }
}

/** 原子写入 `.paper/<name>` */
export async function writeMetaJson(name: string, value: unknown): Promise<void> {
  await writeFileAtomic(metaPath(name), `${JSON.stringify(value, null, 2)}\n`)
}

export const readTagsMeta = (): Promise<Record<string, TagMeta>> => readMetaJson('tags.json', {})
export const writeTagsMeta = (value: Record<string, TagMeta>): Promise<void> => writeMetaJson('tags.json', value)
export const readFoldersMeta = (): Promise<Record<string, FolderMeta>> => readMetaJson('folders.json', {})
export const writeFoldersMeta = (value: Record<string, FolderMeta>): Promise<void> => writeMetaJson('folders.json', value)
export const readTrashMeta = (): Promise<Record<string, TrashMeta>> => readMetaJson('trash.json', {})
export const writeTrashMeta = (value: Record<string, TrashMeta>): Promise<void> => writeMetaJson('trash.json', value)
export const readMigrationMeta = (): Promise<MigrationMeta | null> => readMetaJson('migrated.json', null)

/* ============================== 布局 ============================== */

/** 确保 vault 根、`.trash/`、`.paper/` 存在 */
export async function ensureVault(): Promise<void> {
  const { fs, vaultRoot } = getStorage()
  await fs.mkdir(vaultRoot, { recursive: true })
  await fs.mkdir(vaultJoin('.trash'), { recursive: true })
  await fs.mkdir(vaultJoin('.paper'), { recursive: true })
}

/** 递归扫描 vault 下的所有 md 文件（跳过 `.paper` 与隐藏条目，`.trash` 标记为已删除） */
export async function scanVault(): Promise<VaultNoteFile[]> {
  const { fs, vaultRoot } = getStorage()
  const files: VaultNoteFile[] = []

  const walk = async (dirRel: string, deleted: boolean): Promise<void> => {
    const absolute = dirRel.length === 0 ? vaultRoot : vaultPath(dirRel)
    let entries: Awaited<ReturnType<typeof fs.readDir>>
    try {
      entries = await fs.readDir(absolute)
    } catch {
      return // 目录不存在 / 不可读：视为空，避免扫描整体失败
    }
    for (const entry of entries) {
      const childRel = dirRel.length === 0 ? entry.name : `${dirRel}/${entry.name}`
      if (entry.isDirectory) {
        if (isHiddenName(entry.name)) {
          // 只进入 .trash；.paper 与其它隐藏目录跳过
          if (entry.name === '.trash' && !deleted) await walk(childRel, true)
          continue
        }
        await walk(childRel, deleted)
        continue
      }
      if (!entry.isFile) continue
      if (isHiddenName(entry.name)) continue
      if (!entry.name.toLowerCase().endsWith('.md')) continue
      let stat = { mtimeMs: 0, size: 0 }
      try {
        const info = await fs.stat(vaultPath(childRel))
        stat = { mtimeMs: info.mtimeMs, size: info.size }
      } catch {
        /* 拿不到元信息也能读内容，索引只用于增量判断 */
      }
      files.push({
        relPath: toRelPosix(childRel),
        folderRel: deleted ? null : relDirOf(childRel) || null,
        deleted,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      })
    }
  }

  await walk('', false)
  return files.sort((a, b) => a.relPath.localeCompare(b.relPath))
}

/** 列出 vault 内所有文件夹相对路径（不含 .paper/.trash），按路径排序 */
export async function listFolderRels(): Promise<string[]> {
  const { fs, vaultRoot } = getStorage()
  const result: string[] = []
  const walk = async (dirRel: string): Promise<void> => {
    const absolute = dirRel.length === 0 ? vaultRoot : vaultPath(dirRel)
    let entries: Awaited<ReturnType<typeof fs.readDir>>
    try {
      entries = await fs.readDir(absolute)
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory || isHiddenName(entry.name)) continue
      const childRel = dirRel.length === 0 ? entry.name : `${dirRel}/${entry.name}`
      result.push(toRelPosix(childRel))
      await walk(childRel)
    }
  }
  await walk('')
  return result.sort((a, b) => a.localeCompare(b))
}

/** 目录直接子项的文件名主体集合（小写，用于分配不冲突的文件名） */
export async function takenStems(dirRel: string | null, excludeRelPath?: string): Promise<Set<string>> {
  const { fs } = getStorage()
  const dirAbsolute = dirRel ? vaultPath(dirRel) : getStorage().vaultRoot
  const taken = new Set<string>()
  try {
    for (const entry of await fs.readDir(dirAbsolute)) {
      if (!entry.isFile || isHiddenName(entry.name)) continue
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name
      if (excludeRelPath && toRelPosix(rel) === toRelPosix(excludeRelPath)) continue
      taken.add(stemOf(entry.name).toLowerCase())
    }
  } catch {
    /* 目录不存在：没有占用 */
  }
  return taken
}

/** 确保目录存在 */
export async function ensureDir(dirRel: string | null): Promise<string> {
  const { fs, vaultRoot } = getStorage()
  if (!dirRel) return vaultRoot
  const absolute = vaultPath(dirRel)
  await fs.mkdir(absolute, { recursive: true })
  return absolute
}

/* ============================== 读写笔记 ============================== */

/** 读取一个 md 文件为笔记；自动补 id / 标题 / 时间戳等派生值 */
export async function loadNote(file: VaultNoteFile): Promise<LoadedNote> {
  const { fs } = getStorage()
  const absolute = vaultPath(file.relPath)
  const raw = await fs.readTextFile(absolute)
  const { data, body, hasFrontMatter } = parseFrontMatter(raw)
  let stat = { mtimeMs: file.mtimeMs, size: file.size }
  try {
    const info = await fs.stat(absolute)
    stat = { mtimeMs: info.mtimeMs, size: info.size }
  } catch {
    /* 保留扫描时的值 */
  }
  const id = typeof data.id === 'string' && data.id.trim().length > 0 ? data.id.trim() : newId()
  const deletedAt = file.deleted ? await trashDeletedAt(file.relPath) : null
  const fallbackTime = Math.trunc(stat.mtimeMs) || now()
  return {
    id,
    title: foldTitle(data.title ?? '') || titleFromContent(body) || stemOf(relNameOf(file.relPath)),
    content: body,
    tags: normalizeTags(data.tags),
    pinned: data.pinned === true,
    order: typeof data.order === 'number' ? Math.trunc(data.order) : 0,
    createdAt: typeof data.created === 'number' ? Math.trunc(data.created) : fallbackTime,
    updatedAt: typeof data.updated === 'number' ? Math.trunc(data.updated) : fallbackTime,
    deletedAt,
    folderRel: file.folderRel,
    relPath: file.relPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    needsIdWrite: !(typeof data.id === 'string' && data.id.trim().length > 0),
    hadFrontMatter: hasFrontMatter,
  }
}

/** 回收站记录里的删除时间（没有记录时用 1 表示"已删除但时间未知"） */
async function trashDeletedAt(relPath: string): Promise<number> {
  const meta = await readTrashMeta()
  const key = relNameOf(relPath)
  return meta[key]?.deletedAt ?? 1
}

/** 从正文首行推导标题（外部手写且无 front-matter、文件名也无意义时） */
function titleFromContent(content: string): string {
  const line = String(content ?? '')
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  if (!line) return ''
  return line.replace(/^#{1,6}\s*/, '').slice(0, 60).trim()
}

/**
 * 写入笔记（新建 / 更新 / 改名 / 移动 / 进出回收站都走这里）。
 * 返回落盘后的相对路径。
 * 顺序保证：先写目标文件，再删旧文件 —— 中途失败最坏留下一个同名副本，
 * 由 `syncIndex()` 的 id 冲突修复逻辑收敛（见 indexer.ts）。
 */
export async function saveNote(input: SaveNoteInput, previousRelPath?: string): Promise<string> {
  const { fs } = getStorage()
  const targetDirRel = input.deleted ? TRASH_DIR : input.folderRel
  const previousDirRel = previousRelPath ? relDirOf(previousRelPath) : null

  await ensureDir(targetDirRel)

  const currentStem = previousRelPath ? stemOf(relNameOf(previousRelPath)) : ''
  const keepsName =
    input.keepName === true ||
    (previousRelPath !== undefined &&
      isSameDir(previousDirRel, targetDirRel) &&
      isSameStemForTitle(previousRelPath, input.title, input.id))
  const stem = keepsName
    ? allocateStem(currentStem, input.id, await takenStems(targetDirRel, previousRelPath))
    : allocateStem(input.title, input.id, await takenStems(targetDirRel, previousRelPath))
  const targetRel = targetDirRel ? toRelPosix(joinPath(targetDirRel, `${stem}.md`)) : `${stem}.md`

  const data: FrontMatterData = {
    id: input.id,
    title: foldTitle(input.title),
    tags: normalizeTags(input.tags),
    pinned: input.pinned,
    created: input.createdAt,
    updated: input.updatedAt,
    order: input.order,
  }
  await writeFileAtomic(vaultPath(targetRel), serializeFrontMatter(data, input.content))

  if (previousRelPath && toRelPosix(previousRelPath) !== targetRel) {
    try {
      await fs.remove(vaultPath(previousRelPath))
    } catch (error) {
      console.warn(`[纸笺] 旧文件删除失败（${previousRelPath}）：`, error)
      await appendVaultLog(`旧文件删除失败：${previousRelPath} → ${targetRel}（${String(error)}）`)
    }
  }
  void previousDirRel
  return targetRel
}
/** 两个相对目录是否相同（null 与 '' 等价） */
function isSameDir(a: string | null, b: string | null): boolean {
  return (a ?? '') === (b ?? '')
}

/** 已有文件名是否就是当前标题应有的名字（避免无谓改名） */
function isSameStemForTitle(relPath: string, title: string, id: string): boolean {
  const stem = stemOf(relNameOf(relPath))
  const desired = allocateStem(title, id, [])
  return stem.toLowerCase() === desired.toLowerCase()
}

/** 只补写 front-matter 的 id（外部 md 首次纳入管理时用） */
export async function writeNoteId(file: VaultNoteFile, note: LoadedNote): Promise<void> {
  const data: FrontMatterData = {
    id: note.id,
    title: note.title,
    tags: note.tags,
    pinned: note.pinned,
    created: note.createdAt,
    updated: note.updatedAt,
    order: note.order,
  }
  await writeFileAtomic(vaultPath(file.relPath), serializeFrontMatter(data, note.content))
}

/** 删除文件（不存在的静默通过） */
export async function deleteFile(relPath: string): Promise<void> {
  const { fs } = getStorage()
  try {
    await fs.remove(vaultPath(relPath))
  } catch {
    /* 已被手工删除 */
  }
}

/** 把某个文件移入 `.trash/` 并登记删除元数据；返回新的相对路径 */
export async function moveToTrash(relPath: string, input: { id: string; folderRel: string | null }): Promise<string> {
  const meta = await readTrashMeta()
  const stem = await allocateTrashStem(meta, input.id)
  const targetRel = toRelPosix(joinPath(TRASH_DIR, `${stem}.md`))
  await ensureDir(TRASH_DIR)
  const { fs } = getStorage()
  await fs.rename(vaultPath(relPath), vaultPath(targetRel))
  meta[`${stem}.md`] = { id: input.id, originalFolderRel: input.folderRel, deletedAt: now() }
  await writeTrashMeta(meta)
  return targetRel
}

/** 回收站内的文件名唯一化（按 trash.json 记录与磁盘实际文件双重判断） */
async function allocateTrashStem(meta: Record<string, TrashMeta>, id: string): Promise<string> {
  const taken = new Set<string>(Object.keys(meta).map((name) => stemOf(name).toLowerCase()))
  for (const stem of await takenStems(TRASH_DIR, undefined)) taken.add(stem)
  const base = `无标题-${shortIdSuffix(id)}`
  if (!taken.has(base.toLowerCase())) return base
  for (let index = 2; index <= 999; index += 1) {
    const candidate = `${base}-${index}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${base}-${shortIdSuffix(newId())}`
}

/** 从 `.trash/` 恢复：移回原文件夹（缺失/被占用时回收到收件箱）；返回新的相对路径 */
export async function restoreFromTrash(relPath: string, note: LoadedNote): Promise<string> {
  const meta = await readTrashMeta()
  const key = relNameOf(relPath)
  const record = meta[key]
  const folderRel = record?.originalFolderRel ?? null
  await ensureDir(folderRel)
  const stem = allocateStem(note.title, note.id, await takenStems(folderRel, undefined))
  const targetRel = folderRel ? toRelPosix(joinPath(folderRel, `${stem}.md`)) : `${stem}.md`
  const { fs } = getStorage()
  await fs.rename(vaultPath(relPath), vaultPath(targetRel))
  if (record) {
    delete meta[key]
    await writeTrashMeta(meta)
  }
  return targetRel
}

/** 从 `.trash/` 彻底删除（含元数据清理） */
export async function hardDeleteTrashed(relPath: string): Promise<void> {
  await deleteFile(relPath)
  const meta = await readTrashMeta()
  const key = relNameOf(relPath)
  if (meta[key]) {
    delete meta[key]
    await writeTrashMeta(meta)
  }
}

/** 目录改名（vault 内相对路径，均不含 .paper/.trash） */
export async function renameFolderDir(fromRel: string, toRel: string): Promise<void> {
  const { fs } = getStorage()
  await ensureDir(relDirOf(toRel) || null)
  await fs.rename(vaultPath(fromRel), vaultPath(toRel))
}

/** 删除目录（递归） */
export async function removeFolderDir(relRel: string): Promise<void> {
  const { fs } = getStorage()
  try {
    await fs.remove(vaultPath(relRel), { recursive: true })
  } catch {
    /* 已不存在 */
  }
}

/* ============================ 文件夹元数据 ============================ */

/** 取（必要时创建）某文件夹的稳定 id */
export async function ensureFolderMeta(folderRel: string): Promise<FolderMeta> {
  const meta = await readFoldersMeta()
  const key = toRelPosix(folderRel)
  if (meta[key]) return meta[key]
  const created: FolderMeta = { id: newId(), createdAt: now() }
  meta[key] = created
  await writeFoldersMeta(meta)
  return created
}

/** 批量确保目录元数据存在（索引重建时用），返回最新映射 */
export async function ensureFolderMetas(folderRels: string[]): Promise<Record<string, FolderMeta>> {
  const meta = await readFoldersMeta()
  let dirty = false
  const timestamp = now()
  for (const rel of folderRels) {
    const key = toRelPosix(rel)
    if (!meta[key]) {
      meta[key] = { id: newId(), createdAt: timestamp }
      dirty = true
    }
  }
  if (dirty) await writeFoldersMeta(meta)
  return meta
}

/** 删除文件夹元数据（及其所有后代） */
export async function dropFolderMetas(prefixRel: string): Promise<void> {
  const meta = await readFoldersMeta()
  const prefix = toRelPosix(prefixRel)
  let dirty = false
  for (const key of Object.keys(meta)) {
    if (key === prefix || key.startsWith(`${prefix}/`)) {
      delete meta[key]
      dirty = true
    }
  }
  if (dirty) await writeFoldersMeta(meta)
}

/** 目录改名后重映射元数据键（id 保持不变 → 上层持有的 folderId 不失效） */
export async function remapFolderMetas(fromRel: string, toRel: string): Promise<void> {
  const meta = await readFoldersMeta()
  const from = toRelPosix(fromRel)
  const to = toRelPosix(toRel)
  let dirty = false
  for (const key of Object.keys(meta)) {
    if (key === from) {
      meta[to] = meta[key]
      delete meta[key]
      dirty = true
      continue
    }
    if (key.startsWith(`${from}/`)) {
      meta[`${to}${key.slice(from.length)}`] = meta[key]
      delete meta[key]
      dirty = true
    }
  }
  if (dirty) await writeFoldersMeta(meta)
}

/** 取（必要时创建）标签元数据；`declared=true` 表示"显式声明的标签" */
export async function ensureTagMeta(name: string, color?: string, declared = false): Promise<TagMeta> {
  const meta = await readTagsMeta()
  if (meta[name]) {
    const existing = meta[name]
    if (declared && !existing.declared) {
      const upgraded: TagMeta = { ...existing, declared: true, color: color ?? existing.color }
      meta[name] = upgraded
      await writeTagsMeta(meta)
      return upgraded
    }
    return existing
  }
  const created: TagMeta = { id: newId(), color: color ?? DEFAULT_TAG_COLOR, createdAt: now(), declared }
  meta[name] = created
  await writeTagsMeta(meta)
  return created
}

/** 批量确保标签元数据存在 */
export async function ensureTagMetas(names: string[]): Promise<Record<string, TagMeta>> {
  const meta = await readTagsMeta()
  let dirty = false
  const timestamp = now()
  for (const name of names) {
    if (!meta[name]) {
      meta[name] = { id: newId(), color: DEFAULT_TAG_COLOR, createdAt: timestamp }
      dirty = true
    }
  }
  if (dirty) await writeTagsMeta(meta)
  return meta
}

/** vault 根目录的绝对路径（诊断 / 设置面板展示用） */
export function vaultRootPath(): string {
  return getStorage().vaultRoot
}

/** 供 indexer 使用：文件绝对路径 */
export function absolutePathOf(relPath: string): string {
  return vaultPath(relPath)
}

/** 供 indexer 使用：绝对路径 → 库内相对路径（仅当位于 vault 内） */
export function relPathOf(absolutePath: string): string | null {
  const { vaultRoot } = getStorage()
  const normalizedRoot = toRelPosix(vaultRoot.replace(/\\/g, '/'))
  const normalized = toRelPosix(absolutePath.replace(/\\/g, '/'))
  if (normalized === normalizedRoot) return ''
  if (!normalized.startsWith(`${normalizedRoot}/`)) return null
  return normalized.slice(normalizedRoot.length + 1)
}

/** 目录绝对路径（供 indexer / migrate 使用） */
export function directoryPathOf(dirRel: string | null): string {
  return dirRel ? vaultPath(dirRel) : getStorage().vaultRoot
}

/** 文件名（不含目录） */
export function fileNameOf(relPath: string): string {
  return relNameOf(relPath)
}

/** 绝对路径的文件名 */
export function baseNameOf(path: string): string {
  return basenameOf(path)
}
