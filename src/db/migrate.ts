/**
 * migrate —— 旧 SQLite 库 → md 文件的一次性无损迁移。
 * ==================================================================
 * 用户已有真实数据（7 条笔记 / 2 个文件夹 / 1 个标签），因此本模块的
 * 最高优先级是「不丢数据、可回滚、幂等」：
 *
 *  1. **前置检查**：已有 `migrated.json` / vault 里已有笔记文件 / 旧库没有笔记
 *     → 直接跳过（`skipped`），绝不重复写、绝不覆盖已有文件；
 *  2. **先备份**：把旧库文件整体 `copyFile` 到 `<应用数据>/zhijian.db.bak-<时间戳>`；
 *     备份失败 **立即中止**（宁可不动，也不冒险）；
 *  3. **先在暂存区生成全部文件**（`.paper/migrate-staging-<时间戳>/`，镜像最终布局），
 *     然后**逐条回读校验**（id / 标题 / 正文 / 标签一致 + 文件数一致）；
 *     暂存阶段任何失败 → 删掉暂存区、抛可读 Error，vault 完全没被碰过；
 *  4. **提交**：逐文件 `rename` 进最终位置（rename 是原子操作，不会出现半截文件）；
 *     目标已存在则跳过（可重入）；
 *  5. 写入 `.paper/tags.json` / `folders.json` / `trash.json`（保留旧库的
 *     标签色与 id、文件夹 id、软删除时间与原始文件夹），最后写 `migrated.json`
 *     与 `migration.log`。只有走到这里才算成功。
 *
 * 因此迁移的语义是「**每个文件要么完整落地、要么完全不动**」，最坏情况是
 * 中途崩溃 → 下次启动续跑（已落地的文件被跳过），不会出现残缺笔记。
 */

import { now } from '@/lib/utils'
import { dbSelect } from './connection'
import { allocateStem, parseFrontMatter, serializeFrontMatter } from './frontmatter'
import { isHiddenName, joinPath, timestampSlug, toRelPosix } from './paths'
import { META_DIR_NAME, getStorage, metaPath, vaultPath, writeFileAtomic } from './storage'
import {
  ensureVault,
  readMigrationMeta,
  readTagsMeta,
  writeFoldersMeta,
  writeMetaJson,
  writeTagsMeta,
  writeTrashMeta,
  type FolderMeta,
  type TagMeta,
  type TrashMeta,
} from './vault'

/* ============================== 旧库快照 ============================== */

export interface LegacyNoteRow {
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

export interface LegacyFolderRow {
  id: string
  name: string
  parent_id: string | null
  sort_order: number
  created_at: number
}

export interface LegacyTagRow {
  id: string
  name: string
  color: string
  created_at: number
}

export interface LegacySnapshot {
  notes: LegacyNoteRow[]
  folders: LegacyFolderRow[]
  tags: LegacyTagRow[]
  noteTags: Array<{ note_id: string; tag_id: string }>
}

export interface LegacyReader {
  /** 旧库文件绝对路径（备份源） */
  dbPath: string
  read(): Promise<LegacySnapshot>
}

/** 默认读取器：直接读当前 SQLite 连接里的旧表（应用里就是那个库） */
export function createSqlLegacyReader(dbPath: string): LegacyReader {
  return {
    dbPath,
    async read(): Promise<LegacySnapshot> {
      const [notes, folders, tags, noteTags] = await Promise.all([
        dbSelect<LegacyNoteRow>('读取旧笔记失败', 'SELECT * FROM notes'),
        dbSelect<LegacyFolderRow>('读取旧文件夹失败', 'SELECT * FROM folders'),
        dbSelect<LegacyTagRow>('读取旧标签失败', 'SELECT * FROM tags'),
        dbSelect<{ note_id: string; tag_id: string }>('读取旧标签关系失败', 'SELECT note_id, tag_id FROM note_tags'),
      ])
      return { notes, folders, tags, noteTags }
    },
  }
}

export interface MigrationResult {
  status: 'migrated' | 'skipped'
  /** skipped 时的原因码 */
  reason?: 'already-migrated' | 'vault-not-empty' | 'legacy-empty'
  notes: number
  folders: number
  tags: number
  /** 旧库备份文件绝对路径（未迁移或库文件不存在时为 null） */
  backupPath: string | null
  stagedFiles: number
  /** 提交阶段因目标已存在而跳过的文件数（重入场景） */
  skippedExisting: number
}

/** vault 里是否已有笔记文件（不含 .paper / .trash 内的文件） */
async function vaultHasNotes(): Promise<boolean> {
  const { fs, vaultRoot } = getStorage()
  try {
    for (const entry of await fs.readDir(vaultRoot)) {
      if (entry.isFile && entry.name.toLowerCase().endsWith('.md') && !isHiddenName(entry.name)) return true
      if (entry.isDirectory && !isHiddenName(entry.name)) {
        const children = await fs.readDir(vaultPath(entry.name))
        if (children.some((child) => child.isFile && child.name.toLowerCase().endsWith('.md'))) return true
      }
    }
  } catch {
    return false
  }
  return false
}

/** 旧库文件夹 id → 目录相对路径（父链递归；缺父节点时挂到根） */
function buildFolderPaths(folders: LegacyFolderRow[]): Map<string, string> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const cache = new Map<string, string>()
  const resolve = (id: string, guard: Set<string>): string => {
    const cached = cache.get(id)
    if (cached !== undefined) return cached
    if (guard.has(id)) return '' // 环保护
    guard.add(id)
    const folder = byId.get(id)
    if (!folder) return ''
    const parentPath = folder.parent_id ? resolve(folder.parent_id, guard) : ''
    const path = toRelPosix(parentPath ? joinPath(parentPath, folder.name) : folder.name)
    cache.set(id, path)
    return path
  }
  for (const folder of folders) resolve(folder.id, new Set())
  return cache
}

interface StagedFile {
  stagedRel: string
  targetRel: string
  id: string
  title: string
  content: string
  tags: string[]
}

/**
 * 执行迁移。`options.reader` 覆盖旧库读取器（自检用它注入真实旧库文件）。
 */
export async function migrateLegacyToVault(
  options: { reader?: LegacyReader; force?: boolean } = {},
): Promise<MigrationResult> {
  const storage = getStorage()
  await ensureVault()

  const already = await readMigrationMeta()
  if (already && !options.force) {
    return { status: 'skipped', reason: 'already-migrated', notes: 0, folders: 0, tags: 0, backupPath: already.backupPath ?? null, stagedFiles: 0, skippedExisting: 0 }
  }
  if (!options.force && (await vaultHasNotes())) {
    return { status: 'skipped', reason: 'vault-not-empty', notes: 0, folders: 0, tags: 0, backupPath: null, stagedFiles: 0, skippedExisting: 0 }
  }

  const reader = options.reader ?? createSqlLegacyReader(storage.legacyDbPath)
  let snapshot: LegacySnapshot
  try {
    snapshot = await reader.read()
  } catch (error) {
    // 读取阶段失败：还没有写任何文件，直接给可读错误（数据完全未动）
    throw new Error(
      `迁移中止：读取旧数据库失败，未改动任何数据，可重试。原因：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (snapshot.notes.length === 0 && snapshot.folders.length === 0) {
    return { status: 'skipped', reason: 'legacy-empty', notes: 0, folders: 0, tags: 0, backupPath: null, stagedFiles: 0, skippedExisting: 0 }
  }

  // ---------- 1. 先备份旧库（失败即中止） ----------
  let backupPath: string | null = null
  if (await storage.fs.exists(reader.dbPath)) {
    try {
      backupPath = await copyToBackup(reader.dbPath)
    } catch (error) {
      throw new Error(
        `迁移中止：旧数据库备份失败，未对现有数据做任何改动。原因：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  // ---------- 2. 暂存区生成全部文件 ----------
  const stamp = timestampSlug()
  const stagingRel = toRelPosix(joinPath(META_DIR_NAME, `migrate-staging-${stamp}`))
  await storage.fs.mkdir(vaultPath(stagingRel), { recursive: true })

  const folderPaths = buildFolderPaths(snapshot.folders)
  const tagNameById = new Map(snapshot.tags.map((tag) => [tag.id, tag.name]))
  const tagNamesByNote = new Map<string, string[]>()
  for (const link of snapshot.noteTags) {
    const name = tagNameById.get(link.tag_id)
    if (!name) continue
    const list = tagNamesByNote.get(link.note_id) ?? []
    list.push(name)
    tagNamesByNote.set(link.note_id, list)
  }

  const staged: StagedFile[] = []
  const trashMeta: Record<string, TrashMeta> = {}
  const takenByDir = new Map<string, Set<string>>()

  try {
    for (const note of snapshot.notes) {
      const title = String(note.title ?? '').trim()
      const tags = mergeTags(note.tags, tagNamesByNote.get(note.id) ?? [])
      const folderRel = note.folder_id ? (folderPaths.get(note.folder_id) ?? null) : null
      const deleted = note.deleted_at !== null && note.deleted_at !== undefined
      const targetDirRel = deleted ? '.trash' : folderRel
      const taken = takenByDir.get(targetDirRel ?? '') ?? new Set<string>()
      const stem = allocateStem(title, note.id, taken)
      taken.add(stem.toLowerCase())
      takenByDir.set(targetDirRel ?? '', taken)

      const fileName = `${stem}.md`
      const targetRel = targetDirRel ? toRelPosix(joinPath(targetDirRel, fileName)) : fileName
      const stagedRel = toRelPosix(joinPath(stagingRel, targetRel))
      const content = String(note.content ?? '')
      const payload = serializeFrontMatter(
        {
          id: note.id,
          title: title || stem,
          tags,
          pinned: Number(note.pinned) !== 0,
          created: Number(note.created_at ?? now()),
          updated: Number(note.updated_at ?? note.created_at ?? now()),
          order: Number(note.sort_order ?? 0),
        },
        content,
      )

      await storage.fs.mkdir(dirOf(stagedRel), { recursive: true })
      await writeFileAtomic(vaultPath(stagedRel), payload)
      staged.push({ stagedRel, targetRel, id: note.id, title: title || stem, content, tags })

      if (deleted) {
        trashMeta[fileName] = {
          id: note.id,
          originalFolderRel: folderRel,
          deletedAt: Number(note.deleted_at ?? 0) || now(),
        }
      }
    }

    // ---------- 3. 回读校验（暂存区里逐条核对） ----------
    for (const item of staged) {
      const raw = await storage.fs.readTextFile(vaultPath(item.stagedRel))
      const parsed = parseFrontMatter(raw)
      if (parsed.data.id !== item.id) {
        throw new Error(`暂存校验失败：${item.targetRel} 的 id 不一致（${parsed.data.id} ≠ ${item.id}）`)
      }
      if (parsed.body !== item.content) {
        throw new Error(`暂存校验失败：${item.targetRel} 的正文与旧库不一致（长度 ${parsed.body.length} ≠ ${item.content.length}）`)
      }
      if ((parsed.data.title ?? '') !== item.title) {
        throw new Error(`暂存校验失败：${item.targetRel} 的标题与旧库不一致（${parsed.data.title} ≠ ${item.title}）`)
      }
      const parsedTags = [...parsed.data.tags].sort().join('\u0000')
      if (parsedTags !== [...item.tags].sort().join('\u0000')) {
        throw new Error(`暂存校验失败：${item.targetRel} 的标签与旧库不一致`)
      }
    }
    if (staged.length !== snapshot.notes.length) {
      throw new Error(`暂存校验失败：文件数 ${staged.length} ≠ 旧库笔记数 ${snapshot.notes.length}`)
    }

    // ---------- 4. 提交：逐个原子 rename 进最终位置 ----------
    let skippedExisting = 0
    for (const item of staged) {
      const targetAbs = vaultPath(item.targetRel)
      if (await storage.fs.exists(targetAbs)) {
        skippedExisting += 1
        continue
      }
      await storage.fs.mkdir(dirOf(item.targetRel), { recursive: true })
      await storage.fs.rename(vaultPath(item.stagedRel), targetAbs)
    }

    // ---------- 5. 元数据 + 迁移记录 ----------
    const tagsMeta: Record<string, TagMeta> = await readTagsMeta()
    const declarations = snapshot.tags.length > 0 ? snapshot.tags : []
    for (const tag of declarations) {
      // 旧库里的标签定义 → 显式声明（即使暂时没有笔记使用也保留）
      tagsMeta[tag.name] = { id: tag.id, color: tag.color, createdAt: Number(tag.created_at ?? now()), declared: true }
    }
    // 笔记里用到但旧库没有定义的标签（理论上不会出现）也登记，保证可查
    for (const item of staged) {
      for (const name of item.tags) {
        if (!tagsMeta[name]) tagsMeta[name] = { id: `tag-${name}`, color: '#C9A227', createdAt: now(), declared: false }
      }
    }
    await writeTagsMeta(tagsMeta)

    const foldersMeta: Record<string, FolderMeta> = {}
    for (const folder of snapshot.folders) {
      const path = folderPaths.get(folder.id)
      if (!path) continue
      foldersMeta[path] = { id: folder.id, createdAt: Number(folder.created_at ?? now()) }
    }
    await writeFoldersMeta(foldersMeta)
    await writeTrashMeta(trashMeta)

    try {
      await storage.fs.remove(vaultPath(stagingRel), { recursive: true })
    } catch {
      /* 暂存区清理失败不影响迁移结果 */
    }

    await writeMetaJson('migrated.json', {
      source: reader.dbPath,
      backupPath,
      completedAt: now(),
      counts: { notes: staged.length, folders: Object.keys(foldersMeta).length, tags: Object.keys(tagsMeta).length },
    })
    await appendLog(
      `迁移完成：notes=${staged.length} folders=${Object.keys(foldersMeta).length} tags=${Object.keys(tagsMeta).length} ` +
        `backup=${backupPath ?? '(无库文件)'} skippedExisting=${skippedExisting}`,
    )

    return {
      status: 'migrated',
      notes: staged.length,
      folders: Object.keys(foldersMeta).length,
      tags: Object.keys(tagsMeta).length,
      backupPath,
      stagedFiles: staged.length,
      skippedExisting,
    }
  } catch (error) {
    // 暂存阶段失败：清掉暂存区，vault 保持原样（已经 rename 进位的文件是完整的，下次续跑）
    try {
      await storage.fs.remove(vaultPath(stagingRel), { recursive: true })
    } catch {
      /* ignore */
    }
    await appendLog(`迁移失败：${error instanceof Error ? error.message : String(error)}`)
    throw new Error(`迁移失败（未改动既有数据，可重试）：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 合并旧库的 tags JSON 与 note_tags 关系，保证不丢标签 */
function mergeTags(tagsJson: string, fromRelation: string[]): string[] {
  const result: string[] = []
  const push = (name: string) => {
    const trimmed = String(name ?? '').trim()
    if (trimmed && !result.includes(trimmed)) result.push(trimmed)
  }
  try {
    const parsed: unknown = JSON.parse(tagsJson || '[]')
    if (Array.isArray(parsed)) for (const item of parsed) push(String(item))
  } catch {
    /* 脏 JSON 忽略 */
  }
  for (const name of fromRelation) push(name)
  return result
}

/** 备份旧库文件 */
async function copyToBackup(source: string): Promise<string> {
  const { fs, appDataDir } = getStorage()
  const fileName = source.replace(/\\/g, '/').split('/').pop() ?? 'zhijian.db'
  const target = joinPath(appDataDir, `${fileName}.bak-${timestampSlug()}`)
  await fs.copyFile(source, target)
  return target
}

/** 目录绝对路径（库内相对路径 → 绝对路径；顶层返回 vault 根） */
function dirOf(relPath: string): string {
  const rel = toRelPosix(relPath)
  const index = rel.lastIndexOf('/')
  return index < 0 ? getStorage().vaultRoot : vaultPath(rel.slice(0, index))
}

/** 迁移日志（`.paper/migration.log`） */
async function appendLog(message: string): Promise<void> {
  const { fs } = getStorage()
  const line = `[${new Date().toISOString()}] ${message}\n`
  const path = metaPath('migration.log')
  try {
    const previous = (await fs.exists(path)) ? await fs.readTextFile(path) : ''
    await fs.writeTextFile(path, previous + line)
  } catch {
    /* 日志失败不影响迁移 */
  }
}

/** vault 根下的迁移记录文件绝对路径（自检断言用） */
export function migrationMetaPath(): string {
  return metaPath('migrated.json')
}

/** 迁移暂存目录前缀（诊断用） */
export const MIGRATION_STAGING_PREFIX = `${META_DIR_NAME}/migrate-staging-`
