/**
 * 数据位置 / 备份 / 索引管理（任务 t17 的「数据」与「索引」两区），
 * 以及 **t41 新增的「导入笔记（md）」与「更换数据目录」两个入口的编排**。
 * 归属：系统集成（`src/features/settings/**`）。
 *
 * ## 与存储层的关系
 *  - t17 时 vault 根是 `resolveStorage()` 里的常量且带缓存（没有换根入口），故当时
 *    「更换目录」只提示不支持；
 *  - **t37 起数据层补齐了能力**：`relocateVault()`（先复制 → 校验 → 再切换，失败不动原数据）
 *    与 `importMarkdownPaths()`（导入 md）；本模块**只调用**它们，不自己实现搬迁/导入。
 *  - 两个入口都必须经系统对话框选路径：`plugin-dialog` 会把选中路径动态加入 fs 作用域
 *    （`allow_directory(path, options.recursive)`），因此 `documentDir()` 之外的目录也能读写。
 *    ⚠️ 目录选择**必须 `recursive: true`**，否则只授权顶层、子目录里的 md 读不到。
 */

import { isTauri } from '@/lib/tauri'
import { readLastIndexRebuildAt, writeLastIndexRebuildAt } from '@/lib/appPreferences'
import { joinPath, timestampSlug } from '@/db/paths'
import { scanVault } from '@/db/vault'
import { rebuildIndex, type IndexSyncResult } from '@/db/indexer'
import { resolveStorage, VAULT_DIR_NAME } from '@/db/storage'
import { notesRepo } from '@/db/notes'
import { importMarkdownPaths } from '@/db/import'
import { relocateVault } from '@/db/relocate'

/* --------------------------- 数据位置 --------------------------- */

export interface VaultLocation {
  /** vault 根绝对路径（`<文档>/纸笺`） */
  vaultRoot: string
  /** 应用数据目录（旧库备份 / 索引库落点） */
  appDataDir: string
  /** 索引库（SQLite）绝对路径 */
  indexDbPath: string
  /** 是否处于「md 文件为真相源」模式（t15 之上恒为 true；保留字段便于诊断） */
  fileBacked: boolean
}

/** 浏览器预览态下无文件系统，返回可读说明而不是抛错 */
export const VAULT_UNAVAILABLE_HINT =
  '当前不在桌面端运行（pnpm dev 预览模式），无法读取数据目录；请用 pnpm tauri:dev 启动。'

/**
 * 读取当前数据位置。**必须在 `initDb()` 之后调用**（否则 storage 尚未解析）。
 * 任何失败都抛可读中文错误，由 UI 展示。
 */
export async function readVaultLocation(): Promise<VaultLocation> {
  if (!isTauri) throw new Error(VAULT_UNAVAILABLE_HINT)
  const config = await resolveStorage()
  return {
    vaultRoot: config.vaultRoot,
    appDataDir: config.appDataDir,
    indexDbPath: config.legacyDbPath,
    fileBacked: true,
  }
}

/** 读不到时返回 null（UI 展示提示而不是崩） */
export async function tryReadVaultLocation(): Promise<VaultLocation | null> {
  try {
    return await readVaultLocation()
  } catch {
    return null
  }
}

/**
 * 在文件管理器中打开数据目录（`plugin-opener` 的 `revealItemInDir`）。
 *
 * **为什么用 `revealItemInDir` 而不是 `openPath`**（architect 读插件源码后的结论）：
 *  - `reveal_item_in_dir` **不做 scope 校验**，且 `opener:default` 已含该权限 ⇒ 零权限改动；
 *  - `open_path` 会走 `is_path_allowed` 的 scope 校验，而 capabilities 里没有任何 scope 条目
 *    ⇒ 直接调用会被拒。
 * 附带好处：资源管理器会**高亮**该文件夹，正是「数据放在哪」最直观的表达。
 *
 * 返回 `false` 表示环境不支持（浏览器预览）。
 */
export async function openVaultInFileManager(path: string): Promise<boolean> {
  if (!isTauri) return false
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener')
  await revealItemInDir(path)
  return true
}

/* --------------------------- 索引状态 --------------------------- */

export interface ImportNotesOutcome {
  status: 'imported' | 'cancelled' | 'failed'
  /** 可读汇总（成功 N / 跳过 M / 失败 K + 首条原因），可直接展示 */
  summary: string
  imported: number
  skipped: number
  failed: number
  /** 逐条问题（最多前 5 条），便于展示细节 */
  problems: string[]
  reason?: string
  source: 'files' | 'folder'
}

export interface RelocateOutcome {
  status: 'relocated' | 'cancelled' | 'failed'
  summary: string
  /** 旧数据仍在的位置（切换成功时用于告知用户） */
  oldDataKeptAt: string
  fromRoot: string
  toRoot: string
  reason?: string
}

/** 用户取消选择时的返回值 */
const CANCELLED = null

/**
 * 导入笔记：选文件或文件夹 → `importMarkdownPaths`。
 * 依赖可注入（自检用），默认走真实对话框与真实导入。
 */
export async function importNotesFromDialog(
  source: 'files' | 'folder',
  options: {
    folderId?: string | null
    open?: (options: Record<string, unknown>) => Promise<unknown>
    importNotes?: typeof importMarkdownPaths
  } = {},
): Promise<ImportNotesOutcome> {
  const openDialog =
    options.open ??
    (async (dialogOptions: Record<string, unknown>) => {
      const { open } = await import('@tauri-apps/plugin-dialog')
      return open(dialogOptions as Parameters<typeof open>[0])
    })

  const picked =
    source === 'files'
      ? await openDialog({ ...IMPORT_FILE_DIALOG_OPTIONS })
      : await openDialog({ ...IMPORT_FOLDER_DIALOG_OPTIONS })

  const paths = Array.isArray(picked)
    ? picked.filter((item): item is string => typeof item === 'string')
    : typeof picked === 'string'
      ? [picked]
      : []
  if (picked === CANCELLED || paths.length === 0) {
    return { status: 'cancelled', summary: '已取消导入', imported: 0, skipped: 0, failed: 0, problems: [], source }
  }

  try {
    const runImport = options.importNotes ?? importMarkdownPaths
    const result = await runImport(paths, { folderId: options.folderId ?? null })
    return {
      status: 'imported',
      summary: result.summary,
      imported: result.imported,
      skipped: result.skipped,
      failed: result.failed,
      problems: result.files
        .filter((item) => item.status !== 'imported')
        .slice(0, 5)
        .map((item) => `${item.source.split(/[\\/]/).pop() ?? item.source}：${item.reason ?? item.status}`),
      source,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      status: 'failed',
      summary: `导入失败：${reason}`,
      imported: 0,
      skipped: 0,
      failed: paths.length,
      problems: [reason],
      reason,
      source,
    }
  }
}

/**
 * 更换数据目录：选目录 → **二次确认（含旧目录位置）** → `relocateVault`。
 * 依赖可注入（自检用），默认走真实对话框 + 真实原生确认 + 真实搬迁。
 */
export async function relocateVaultFromDialog(
  options: {
    currentRoot?: string
    open?: (options: Record<string, unknown>) => Promise<unknown>
    confirm?: (
      message: string,
      options: { title: string; kind?: 'info' | 'warning' | 'error' },
    ) => Promise<boolean>
    relocate?: typeof relocateVault
  } = {},
): Promise<RelocateOutcome> {
  const openDialog =
    options.open ??
    (async (dialogOptions: Record<string, unknown>) => {
      const { open } = await import('@tauri-apps/plugin-dialog')
      return open(dialogOptions as Parameters<typeof open>[0])
    })
  const confirmDialog =
    options.confirm ??
    (async (message: string, dialogOptions: { title: string; kind?: 'info' | 'warning' | 'error' }) => {
      const { confirm } = await import('@tauri-apps/plugin-dialog')
      return confirm(message, { ...dialogOptions, okLabel: '确认更换', cancelLabel: '取消' })
    })

  const currentRoot = options.currentRoot ?? (await tryReadVaultLocation())?.vaultRoot ?? ''
  const target = await openDialog({ ...RELOCATE_DIALOG_OPTIONS })
  if (typeof target !== 'string' || target.length === 0) {
    return {
      status: 'cancelled',
      summary: '已取消更换数据目录',
      oldDataKeptAt: currentRoot,
      fromRoot: currentRoot,
      toRoot: '',
    }
  }

  // 二次确认：操作前就把"旧数据会保留在哪"讲清楚
  const agreed = await confirmDialog(relocateConfirmMessage(currentRoot, target), {
    title: RELOCATE_CONFIRM_TITLE,
    kind: 'warning',
  })
  if (!agreed) {
    return {
      status: 'cancelled',
      summary: '已取消更换数据目录',
      oldDataKeptAt: currentRoot,
      fromRoot: currentRoot,
      toRoot: target,
    }
  }

  try {
    const runRelocate = options.relocate ?? relocateVault
    const result = await runRelocate(target)
    return {
      status: result.status === 'relocated' ? 'relocated' : 'failed',
      summary: result.summary,
      oldDataKeptAt: result.oldDataKeptAt,
      fromRoot: result.fromVault,
      toRoot: result.toVault,
      reason: result.reason,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      status: 'failed',
      summary: `更换数据目录失败：${reason}（原目录未改动，数据仍在 ${currentRoot}）`,
      oldDataKeptAt: currentRoot,
      fromRoot: currentRoot,
      toRoot: target,
      reason,
    }
  }
}

/* --------------------------- 更换目录 --------------------------- */

export interface RelocateSupport {
  supported: boolean
  /** 不支持时的说明与建议（中文，可直接展示） */
  reason: string
}

/**
 * 是否支持「更换数据目录」。
 *
 * t17 时为「不支持」（当时的存储层没有换根入口，所以不做假按钮）。
 * **t37 起改为支持**：数据层提供了 `relocateVault()`，语义是
 * 「先复制 → 逐项校验（文件数 + 抽样 sha256）→ 成功后才切换 → 重建索引」，
 * 且**任何一步失败都保持原目录不变**、切换成功后**旧目录保留不删**。
 * 为了让用户操作前就知道旧数据在哪，UI 侧还要一次二次确认（见 `relocateConfirmMessage`）。
 */
export function relocateSupport(): RelocateSupport {
  return {
    supported: true,
    reason:
      '会先把整个数据目录**复制**到新位置并逐项校验（文件数 + 抽样 sha256），' +
      '校验通过后才切换；任何一步失败都保持原目录不变。切换成功后**旧目录会原地保留**，' +
      '确认无误后可自行删除。',
  }
}

/* ============================================================================
 * t41：导入笔记（md）与「更换数据目录」的对话框编排
 * ============================================================================
 * 两个入口都必须**经系统对话框**选路径：`plugin-dialog` 的 `open()` 会把选中路径
 * 动态加入 fs 作用域（`allow_directory(path, options.recursive)`），
 * 因此 `documentDir()` 之外的任意目录也能读写，不需要放宽静态白名单。
 *
 * ⚠️ **目录选择必须带 `recursive: true`**：不传只会授权顶层目录，
 * 子目录里的 md 读不到 —— 表现为"文件夹里没有可导入的 md"或"文件清单不一致"，
 * 界面不报错但功能静默失效。下面的选项常量把这条固化下来，并由自检静态断言。
 */

/** 导入 md 文件：多选 + 仅 md 过滤 */
export const IMPORT_FILE_DIALOG_OPTIONS = {
  multiple: true,
  filters: [{ name: 'Markdown', extensions: ['md'] }],
} as const

/** 导入整个文件夹：**必须 recursive**（否则子目录里的 md 读不到） */
export const IMPORT_FOLDER_DIALOG_OPTIONS = {
  directory: true,
  recursive: true,
} as const

/** 选择新的数据目录：目录 + **必须 recursive**（要能读到里面的 md 与 .paper 元数据） */
export const RELOCATE_DIALOG_OPTIONS = {
  directory: true,
  recursive: true,
} as const

/** 「更换数据目录」的二次确认标题 */
export const RELOCATE_CONFIRM_TITLE = '更换数据目录'

/**
 * 二次确认文案（纯函数，便于断言"操作前就告知旧数据位置"）。
 * 必须同时说明三件事：会怎么做（复制+校验）、失败怎么办（保持原样）、旧数据在哪（保留在原目录）。
 */
export function relocateConfirmMessage(currentRoot: string, targetRoot: string): string {
  return (
    `将把数据目录从：\n${currentRoot}\n\n` +
    `更换为：\n${targetRoot}\n\n` +
    '做法：先把现有数据**完整复制**到新目录并逐项校验（文件数 + 抽样 sha256），' +
    '校验通过后才切换；**任何一步失败都保持原目录不变**。\n' +
    `切换成功后，旧目录会**原地保留**：${currentRoot} —— 确认新目录内容无误后你可自行删除。`
  )
}

export interface IndexStatus {
  /** vault 内被管理的 md 文件数（含回收站） */
  fileCount: number
  /** 索引里的笔记数（含回收站） */
  noteCount: number
  /** 未删除的笔记数 */
  activeCount: number
  /** 回收站笔记数 */
  trashCount: number
  /** 文件夹数（索引） */
  folderCount: number
  /** 标签数（索引） */
  tagCount: number
  /** 最近一次**手动**重建索引的时间（毫秒）；从未重建返回 null */
  lastRebuildAt: number | null
  /** 文件数与笔记数是否一致（不一致说明索引待同步） */
  inSync: boolean
}

/** 读取索引状态（文件数走真实目录扫描，笔记数走索引仓储） */
export async function readIndexStatus(): Promise<IndexStatus> {
  const [files, counts] = await Promise.all([scanVault(), notesRepo.counts()])
  const tagged = await readTagCount()
  const indexNoteCount = counts.all + counts.trash
  return {
    fileCount: files.length,
    noteCount: indexNoteCount,
    activeCount: counts.all,
    trashCount: counts.trash,
    folderCount: Object.keys(counts.byFolder).length,
    tagCount: tagged,
    lastRebuildAt: readLastIndexRebuildAt(),
    inSync: files.length === indexNoteCount,
  }
}

/** 标签总数（走 tagsRepo，避免自己写 SQL） */
async function readTagCount(): Promise<number> {
  try {
    const { tagsRepo } = await import('@/db/tags')
    const tags = await tagsRepo.list()
    return tags.length
  } catch {
    return 0
  }
}

export interface RebuildOutcome {
  result: IndexSyncResult
  /** 重建完成的时刻（已写入偏好，供「最后重建时间」展示） */
  finishedAt: number
  /** 重建后的状态快照（省去 UI 再查一次） */
  status: IndexStatus
}

/**
 * 手动重建索引：调 t15 的 `rebuildIndex()`（DROP + CREATE + 从 md 全量重投影），
 * 记录完成时间，并回读一份新状态。
 */
export async function rebuildVaultIndex(): Promise<RebuildOutcome> {
  if (!isTauri) throw new Error(VAULT_UNAVAILABLE_HINT)
  const result = await rebuildIndex()
  const finishedAt = Date.now()
  writeLastIndexRebuildAt(finishedAt)
  const status = await readIndexStatus()
  return { result, finishedAt, status }
}

/* --------------------------- 备份 --------------------------- */

export interface BackupOutcome {
  targetDir: string
  copiedFiles: number
  copiedDirs: number
  elapsedMs: number
  /**
   * 复制失败的条目（部分成功时必须如实告知，不能一律报「备份完成」）。
   * architect 的明确要求：递归复制要**捕获逐文件错误**。
   */
  failures: Array<{ path: string; reason: string }>
  /** 是否完整成功（`failures` 为空） */
  complete: boolean
}

export const BACKUP_UNAVAILABLE_HINT =
  '当前不在桌面端运行（pnpm dev 预览模式），无法备份数据；请用 pnpm tauri:dev 启动。'

/** 默认备份目录名：`纸笺-备份-YYYYMMDD-HHmmss` */
export function defaultBackupDirName(at: number = Date.now()): string {
  return `${VAULT_DIR_NAME}-备份-${timestampSlug(new Date(at))}`
}

/**
 * 备份 vault 到目标目录（递归复制，**不删不改源目录**）。
 *
 * 安全与正确性：
 *  - 拒绝把备份写进源目录内部（会自我递归）；
 *  - 目标目录必须不存在或为空（避免把两份数据混在一起）；
 *  - 逐文件复制（不用 fs 的整目录复制，便于统计与失败定位）。
 *
 * 权限说明：读源目录（`$DOCUMENT` 递归）与写目标目录由对话框动态作用域授予
 * （见 ARCHITECTURE §4.10/§5c）；因此这里**只**接受来自对话框的绝对路径。
 */
export async function backupVault(
  vaultRoot: string,
  targetDir: string,
): Promise<BackupOutcome> {
  if (!isTauri) throw new Error(BACKUP_UNAVAILABLE_HINT)
  const startedAt = Date.now()
  const sourceRel = vaultRoot.replace(/[\\/]+$/, '')
  const targetRel = targetDir.replace(/[\\/]+$/, '')
  if (targetRel === sourceRel || targetRel.startsWith(`${sourceRel}\\`) || targetRel.startsWith(`${sourceRel}/`)) {
    throw new Error('备份位置不能位于数据目录内部：请选择数据目录之外的文件夹')
  }

  const { exists, mkdir, readDir, copyFile } = await import('@tauri-apps/plugin-fs')

  if (await exists(targetRel)) {
    const entries = await readDir(targetRel)
    if (entries.length > 0) {
      throw new Error('目标文件夹不是空的：请选择一个空文件夹或新建文件夹作为备份位置')
    }
  }
  await mkdir(targetRel, { recursive: true })

  let copiedFiles = 0
  let copiedDirs = 0
  const failures: Array<{ path: string; reason: string }> = []

  const copyDir = async (fromAbs: string, toAbs: string): Promise<void> => {
    let entries
    try {
      entries = await readDir(fromAbs)
    } catch (error) {
      // 目录读不到（权限/占用）如实记录，不中断整次备份
      failures.push({ path: fromAbs, reason: error instanceof Error ? error.message : String(error) })
      return
    }
    for (const entry of entries) {
      const fromChild = joinPath(fromAbs, entry.name)
      const toChild = joinPath(toAbs, entry.name)
      try {
        if (entry.isDirectory) {
          await mkdir(toChild, { recursive: true })
          copiedDirs += 1
          await copyDir(fromChild, toChild)
          continue
        }
        if (entry.isFile) {
          await copyFile(fromChild, toChild)
          copiedFiles += 1
        }
      } catch (error) {
        // 单文件失败不放弃整次备份：记下来交给调用方如实汇报
        failures.push({
          path: fromChild,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  await copyDir(sourceRel, targetRel)
  return {
    targetDir: targetRel,
    copiedFiles,
    copiedDirs,
    elapsedMs: Date.now() - startedAt,
    failures,
    complete: failures.length === 0,
  }
}

/**
 * 备份目标选择：用「打开文件夹」对话框让用户选目录（plugin-dialog）。
 * 返回绝对路径；取消返回 null。
 */
export async function pickBackupDirectory(defaultPath: string): Promise<string | null> {
  if (!isTauri) throw new Error(BACKUP_UNAVAILABLE_HINT)
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    title: '选择备份位置（会自动在其中新建一个备份文件夹）',
    directory: true,
    multiple: false,
    defaultPath,
  })
  if (!selected) return null
  return typeof selected === 'string' ? selected : null
}

/** 在选定的父目录下生成「父/纸笺-备份-时间戳」并执行备份 */
export async function backupVaultInto(
  vaultRoot: string,
  parentDir: string,
): Promise<BackupOutcome> {
  const target = joinPath(parentDir, defaultBackupDirName())
  return backupVault(vaultRoot, target)
}

