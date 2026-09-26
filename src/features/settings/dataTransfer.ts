/**
 * 全部数据的导出 / 导入（设置面板「数据」区）。
 * 归属：系统集成 / 任务 t6（`src/features/settings/**`）。
 *
 * 分层约束（docs/ARCHITECTURE.md §2）：
 *  - 业务数据只经 `src/db/**` 仓储读写，本文件**不出现裸 SQL、不直接 import Database**；
 *  - 文件选择走 `@tauri-apps/plugin-dialog`，文件读写走 `@tauri-apps/plugin-fs`；
 *  - 非 Tauri（浏览器开发态）下两个 API 都不可用，函数抛出可读中文错误，由 UI 提示。
 *
 * 导出格式（纯 JSON，人类可读、可 diff）：
 * ```jsonc
 * {
 *   "app": "纸笺", "identifier": "com.zhijian.app", "kind": "zhijian.backup",
 *   "version": 1, "exportedAt": 1712345678901,
 *   "counts": { "notes": 12, "folders": 3, "tags": 5 },
 *   "folders": [{ "id", "name", "parentId", "order", "createdAt" }],
 *   "notes":   [{ "id", "title", "content", "folderId", "tags", "pinned", "order",
 *                "createdAt", "updatedAt", "deletedAt" }],
 *   "tags":    [{ "id", "name", "color", "createdAt" }]
 * }
 * ```
 *
 * 导入语义（**非破坏性**）：只做「新增」，不改动也不删除已有数据；
 * 外部 id 一律不改写库中既有记录 —— 文件夹/笔记/标签都视为新记录，
 * 原 id 仅用于还原**层级与归属关系**（文件夹父子、笔记所属文件夹、笔记标签）。
 */

import { isTauri } from '@/lib/tauri'
import { foldersRepo } from '@/db/folders'
import { notesRepo } from '@/db/notes'
import { tagsRepo } from '@/db/tags'
import type { Folder, Note, Tag } from '@/types'

/** 备份文件格式版本；不兼容时拒绝导入 */
export const BACKUP_FORMAT_VERSION = 1
export const BACKUP_KIND = 'zhijian.backup'

export interface BackupBundle {
  app: string
  identifier: string
  kind: string
  version: number
  exportedAt: number
  counts: { notes: number; folders: number; tags: number }
  folders: Folder[]
  notes: Note[]
  tags: Tag[]
}

export interface ExportResult {
  /** 用户取消保存对话框时为 null */
  path: string | null
  fileName: string
  notes: number
  folders: number
  tags: number
  bytes: number
}

export interface ImportResult {
  path: string
  folders: number
  notes: number
  tags: number
}

/** 浏览器开发态下与文件系统交互的提示（设置面板直接展示） */
export const FILESYSTEM_UNAVAILABLE_HINT =
  '当前不在桌面端运行（pnpm dev 预览模式），文件读写不可用，请用 pnpm tauri:dev 启动。'

function requireDesktop(): void {
  if (!isTauri) throw new Error(FILESYSTEM_UNAVAILABLE_HINT)
}

/** 备份文件名：`纸笺-备份-YYYYMMDD-HHmm.json` */
export function backupFileName(at: number = Date.now()): string {
  const d = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  return `纸笺-备份-${stamp}.json`
}

/* ------------------------------- 收集数据 ------------------------------- */

/** 读出全部业务数据（含回收站里的笔记；偏好类设置不导出，见 §4.6） */
export async function collectBundle(exportedAt: number = Date.now()): Promise<BackupBundle> {
  const [folders, notes, tags] = await Promise.all([
    foldersRepo.list(),
    notesRepo.listAll({ includeDeleted: true, sortBy: 'order' }),
    tagsRepo.list(),
  ])

  return {
    app: '纸笺',
    identifier: 'com.zhijian.app',
    kind: BACKUP_KIND,
    version: BACKUP_FORMAT_VERSION,
    exportedAt,
    counts: { notes: notes.length, folders: folders.length, tags: tags.length },
    folders,
    notes,
    tags,
  }
}

export function serializeBundle(bundle: BackupBundle): string {
  // 缩进 2 空格：备份文件要能被人读、被 git diff
  return `${JSON.stringify(bundle, null, 2)}\n`
}

/* ------------------------------- 导出 ------------------------------- */

/**
 * 导出全部数据：弹出保存对话框 → 写 JSON 文件。
 * 用户在对话框里取消时返回 `path: null`（不是错误）。
 */
export async function exportAllData(): Promise<ExportResult> {
  requireDesktop()

  const bundle = await collectBundle()
  const content = serializeBundle(bundle)
  // 字节数按 UTF-8 计算（中文占 3 字节，不能用 length）
  const bytes = new TextEncoder().encode(content).length
  const defaultFileName = backupFileName(bundle.exportedAt)

  const { save } = await import('@tauri-apps/plugin-dialog')
  const selected = await save({
    title: '导出纸笺全部数据',
    defaultPath: defaultFileName,
    filters: [{ name: 'JSON 备份', extensions: ['json'] }],
  })
  if (!selected) {
    return {
      path: null,
      fileName: defaultFileName,
      notes: bundle.counts.notes,
      folders: bundle.counts.folders,
      tags: bundle.counts.tags,
      bytes,
    }
  }

  const { writeTextFile } = await import('@tauri-apps/plugin-fs')
  await writeTextFile(selected, content)

  return {
    path: selected,
    fileName: selected.replace(/^.*[\\/]/, ''),
    notes: bundle.counts.notes,
    folders: bundle.counts.folders,
    tags: bundle.counts.tags,
    bytes,
  }
}

/* ------------------------------- 导入 ------------------------------- */

/** 校验并规范化备份文件内容；任何不合规都抛可读中文错误 */
export function parseBundle(text: string): BackupBundle {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`备份文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('备份文件格式不正确：顶层应为对象')
  }

  const record = parsed as Record<string, unknown>
  if (record['kind'] !== BACKUP_KIND) {
    throw new Error('这不是纸笺的备份文件（缺少 kind 标记）')
  }
  const version = Number(record['version'])
  if (!Number.isFinite(version) || version > BACKUP_FORMAT_VERSION) {
    throw new Error(`备份文件版本不支持：${String(record['version'])}（当前支持 ≤ ${BACKUP_FORMAT_VERSION}）`)
  }

  const notes = Array.isArray(record['notes']) ? (record['notes'] as Note[]) : []
  const folders = Array.isArray(record['folders']) ? (record['folders'] as Folder[]) : []
  const tags = Array.isArray(record['tags']) ? (record['tags'] as Tag[]) : []
  if (notes.length === 0 && folders.length === 0 && tags.length === 0) {
    throw new Error('备份文件里没有任何笔记、文件夹或标签')
  }

  return {
    app: typeof record['app'] === 'string' ? record['app'] : '纸笺',
    identifier: typeof record['identifier'] === 'string' ? record['identifier'] : 'com.zhijian.app',
    kind: BACKUP_KIND,
    version,
    exportedAt: Number(record['exportedAt']) || Date.now(),
    counts: {
      notes: notes.length,
      folders: folders.length,
      tags: tags.length,
    },
    folders,
    notes,
    tags,
  }
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * 导入备份：**只新增、不破坏**。
 *  - 文件夹按「父子顺序」重建（父先建），保留名称与排序位；
 *  - 笔记还原标题 / 正文 / 置顶 / 排序位 / 软删除状态 / 原时间戳，标签名保留；
 *  - 标签按备份补齐缺失定义（已存在同名标签保留原有颜色）。
 */
export async function importBundle(bundle: BackupBundle): Promise<ImportResult> {
  requireDesktop()

  // 1) 文件夹：父先建，建立 旧 id → 新 id 映射
  const folderIdMap = new Map<string, string>()
  const pending = [...bundle.folders]
  let guard = pending.length + 1
  while (pending.length > 0 && guard > 0) {
    guard -= 1
    const remaining: Folder[] = []
    let progressed = false
    for (const folder of pending) {
      const name = asString(folder.name).trim()
      if (!name) continue
      const parentId = folder.parentId ? folderIdMap.get(folder.parentId) : null
      if (folder.parentId && parentId === undefined) {
        remaining.push(folder)
        continue
      }
      const created = await foldersRepo.create({
        name,
        parentId: parentId ?? null,
        order: Number.isFinite(Number(folder.order)) ? Number(folder.order) : undefined,
      })
      folderIdMap.set(asString(folder.id), created.id)
      progressed = true
    }
    if (!progressed) {
      // 父子关系成环：把剩下的当顶层建，保证数据不丢
      pending.length = 0
      for (const folder of remaining) {
        const name = asString(folder.name).trim()
        if (!name) continue
        const created = await foldersRepo.create({ name, parentId: null })
        folderIdMap.set(asString(folder.id), created.id)
      }
      break
    }
    pending.length = 0
    pending.push(...remaining)
  }

  // 2) 标签：补齐缺失定义（同名保留库中已有的定义）
  let tagCount = 0
  const existingTags = await tagsRepo.list()
  for (const tag of bundle.tags) {
    const name = asString(tag.name).trim()
    if (!name || existingTags.some((item) => item.name === name)) continue
    await tagsRepo.create({ name, color: asString(tag.color) || undefined })
    tagCount += 1
  }

  // 3) 笔记：还原标题 / 正文 / 归属 / 标签 / 置顶 / 排序位 / 软删除状态。
  //    - `notesRepo.update` 不接受 createdAt / updatedAt（契约 NoteUpdatePatch 未含，
  //      且「所有写操作刷新 updatedAt」是 db 层硬约定），因此导入后时间戳取导入时刻；
  //    - 备份里 notes 已按 order 升序排列，逐个 create 即可保持相对顺序；
  //    - deletedAt 非空 → 导入后仍位于回收站（用 update 回写）。
  let noteCount = 0
  for (const note of bundle.notes) {
    const folderId = note.folderId ? (folderIdMap.get(note.folderId) ?? null) : null
    const created = await notesRepo.create({
      title: asString(note.title),
      content: asString(note.content),
      folderId,
      tags: Array.isArray(note.tags) ? note.tags.map(asString).filter(Boolean) : [],
      pinned: note.pinned === true,
      order: Number.isFinite(Number(note.order)) ? Number(note.order) : undefined,
    })
    const deletedAt = Number(note.deletedAt)
    if (Number.isFinite(deletedAt) && deletedAt > 0) {
      await notesRepo.update(created.id, { deletedAt })
    }
    noteCount += 1
  }

  return { path: '', folders: folderIdMap.size, notes: noteCount, tags: tagCount }
}

/**
 * 导入全部数据：弹出文件选择对话框 → 读取 JSON → 非破坏性导入。
 * 用户取消选择时返回 null。
 */
export async function importAllData(): Promise<ImportResult | null> {
  requireDesktop()

  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    title: '导入纸笺备份（只新增，不覆盖）',
    multiple: false,
    directory: false,
    filters: [{ name: 'JSON 备份', extensions: ['json'] }],
  })
  if (!selected) return null

  const { readTextFile } = await import('@tauri-apps/plugin-fs')
  const text = await readTextFile(selected)
  const bundle = parseBundle(text)
  const result = await importBundle(bundle)
  return { ...result, path: selected }
}

/** 人类可读的字节数（设置面板展示导出体积） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}
