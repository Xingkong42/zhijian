/**
 * 导入笔记（t37 · 需求 A）—— 把用户挑的 `.md`（文件或整个文件夹）纳入当前 vault。
 * ==================================================================
 * 支持的形态：**通用 Markdown**
 *  - 有 front-matter：保留 `title/tags/pinned/created/updated`；`id` 冲突则重新分配；
 *    `order` 不沿用（跨 vault 无意义）→ 统一重排到目标集合最前（与"新建笔记排最前"一致）；
 *  - 无 front-matter：标题取正文首个 `#` 标题，否则取文件名（去扩展名）；正文**逐字保持**，
 *    随后补一份规范 front-matter；
 *  - 目录导入：递归收集 `.md`（跳过 `.obsidian/.git/.trash` 等隐藏目录与非 md 文件），
 *    `preserveStructure: true`（默认）时**保留子目录结构**（子目录 → vault 文件夹）。
 *
 * 明确边界（全部有断言，绝不静默产生 0 字节垃圾文件）：
 *  | 情况 | 行为 |
 *  | --- | --- |
 *  | 空文件 / 只有空白 / front-matter 后无正文 | **跳过**，原因「空文件（…）」 |
 *  | 超大文件（默认 > 5 MiB） | **跳过**，原因「文件过大（x MB > 上限 y MB）」 |
 *  | 非 UTF-8（GBK 等） | **跳过**，原因「疑似非 UTF-8 编码（严格解码失败…）」 |
 *  | 含 BOM | **剥离 BOM** 后正常导入 |
 *  | 文件名冲突 | **绝不覆盖**：vault 自动加 `-2`/`-3`，结果里 `renamed: true` |
 *  | 单个文件失败 | 只影响该文件：计入 `failed` + 可读原因，其余继续 |
 *  | 源不存在 / 目录里没有 md / 非 md 文件 | 计入 `failed` 或 `skipped` 并给出原因 |
 *
 * 导入完成后 `syncIndex()`，结果整理成一句可读 `summary`（供 Toast）。
 *
 * ⚠️ 当前**仅支持 md 形态**。Obsidian 的 md 基本可直接导入（内链/附件需另行处理）；
 * 印象笔记（.enex）、Notion（zip/CSV）等专有格式需要各自的转换器 —— 需要时再排任务。
 */

import { newId, now } from '@/lib/utils'
import { dbSelect } from './connection'
import { DbError } from './errors'
import { foldTitle, normalizeTags, parseFrontMatter, sanitizeStem } from './frontmatter'
import { stemOf } from './paths'
import { syncIndex } from './indexer'
import { isHiddenName, joinPath, toRelPosix } from './paths'
import { getStorage, vaultPath } from './storage'
import { ensureFolderMeta, readFoldersMeta, saveNote } from './vault'

/** 默认单文件上限：5 MiB（超过一律跳过并说明，避免把日志/数据文件当笔记吃进来） */
export const DEFAULT_IMPORT_MAX_BYTES = 5 * 1024 * 1024

export interface ImportOptions {
  /** 目标文件夹 id；null/缺省 = 收件箱 */
  folderId?: string | null
  /** 追加到每条导入笔记的标签（与 front-matter 里的标签合并去重） */
  extraTags?: string[]
  /** 单文件大小上限（字节），默认 {@link DEFAULT_IMPORT_MAX_BYTES} */
  maxBytes?: number
  /** 目录导入时是否保留子目录结构（默认 true） */
  preserveStructure?: boolean
  /** 导入完成后是否同步索引（默认 true；批量调用方可设 false 最后统一同步） */
  sync?: boolean
}

export interface ImportFileResult {
  /** 源绝对路径 */
  source: string
  status: 'imported' | 'skipped' | 'failed'
  /** 可读原因（skipped / failed 时必有） */
  reason?: string
  noteId?: string
  /** 落盘后的 vault 相对路径 */
  relPath?: string
  title?: string
  bytes?: number
  /** 因重名被自动改过名（期望名 ≠ 实际落地名） */
  renamed?: boolean
}

export interface ImportResult {
  total: number
  imported: number
  skipped: number
  failed: number
  files: ImportFileResult[]
  /** 一句可读汇总（直接拿去 Toast） */
  summary: string
}

/** 严格 UTF-8 解码结果 */
interface DecodedText {
  ok: boolean
  text: string
  reason?: string
}

/**
 * 严格 UTF-8 解码（剥离 BOM；非法字节序列判为失败）。
 * 端口没有二进制能力时回退到 `readTextFile`（宽松解码，但仍检测 U+FFFD 并剥离 BOM）。
 */
async function decodeUtf8(absolutePath: string): Promise<DecodedText> {
  const { fs } = getStorage()
  if (fs.readFileBytes) {
    const bytes = await fs.readFileBytes(absolutePath)
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return { ok: true, text: text.replace(/^\uFEFF/, '') }
    } catch {
      return { ok: false, text: '', reason: '疑似非 UTF-8 编码（严格解码失败，请转成 UTF-8 后重试）' }
    }
  }
  const raw = await fs.readTextFile(absolutePath)
  if (raw.includes('\uFFFD')) {
    return { ok: false, text: '', reason: '疑似非 UTF-8 编码（检测到替换字符 U+FFFD）' }
  }
  return { ok: true, text: raw.replace(/^\uFEFF/, '') }
}

/** 从正文推导标题：首个 Markdown 标题行，其次首个非空行 */
/**
 * 从正文推导标题：**只认 Markdown 标题行**（`#`~`######`）。
 * 没有标题行时返回空串，由调用方回落到文件名 —— 与需求一致（"标题取首行 `#` 或文件名"）。
 */
function titleFromContent(content: string): string {
  for (const line of content.split('\n')) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) return heading[1].trim()
  }
  return ''
}

/** 目标文件夹 id → 目录相对路径（null = 收件箱） */
async function folderRelFor(folderId: string | null | undefined): Promise<string | null> {
  if (!folderId) return null
  const rows = await dbSelect<{ id: string; path: string | null }>(
    '读取文件夹失败',
    `SELECT id, path FROM folders WHERE id = $1`,
    [folderId],
  )
  const path = rows[0]?.path
  if (!path) throw new DbError(`目标文件夹不存在：${folderId}`, new Error('NOT_FOUND'))
  return toRelPosix(String(path))
}

/** 目标集合当前最小排序位 - 1（导入的笔记排最前；索引里查一次，之后在内存里递减） */
async function initialNextOrder(folderRel: string | null): Promise<number> {
  const rows = folderRel
    ? await dbSelect<{ min_order: number }>(
        '读取排序位失败',
        `SELECT COALESCE(MIN(sort_order), 0) AS min_order FROM notes
          WHERE folder_id = (SELECT id FROM folders WHERE path = $1) AND deleted_at IS NULL`,
        [folderRel],
      )
    : await dbSelect<{ min_order: number }>(
        '读取排序位失败',
        `SELECT COALESCE(MIN(sort_order), 0) AS min_order FROM notes WHERE folder_id IS NULL AND deleted_at IS NULL`,
      )
  return Number(rows[0]?.min_order ?? 0) - 1
}

/** 导入单个 md 源文件；只影响该文件的结果（异常一律收敛为 failed + 可读原因） */
async function importOneFile(
  absolutePath: string,
  displayName: string,
  targetFolderRel: string | null,
  options: { extraTags: string[]; maxBytes: number; order: { value: number } },
): Promise<ImportFileResult> {
  const { fs } = getStorage()
  const source = absolutePath
  try {
    const info = await fs.stat(absolutePath)
    if (info.isDirectory) {
      return { source, status: 'failed', reason: '源路径是目录（导入文件时不应出现）' }
    }
    if (info.size > options.maxBytes) {
      const mb = (info.size / 1024 / 1024).toFixed(1)
      const limit = (options.maxBytes / 1024 / 1024).toFixed(1)
      return { source, status: 'skipped', reason: `文件过大（${mb} MB > 上限 ${limit} MB）`, bytes: info.size }
    }

    const decoded = await decodeUtf8(absolutePath)
    if (!decoded.ok) return { source, status: 'skipped', reason: decoded.reason, bytes: info.size }

    const content = decoded.text
    if (content.trim().length === 0) return { source, status: 'skipped', reason: '空文件（无正文）', bytes: info.size }

    const { data, body, hasFrontMatter } = parseFrontMatter(content)
    const noteBody = hasFrontMatter ? body : content.replace(/\r\n/g, '\n')
    if (noteBody.trim().length === 0) {
      return { source, status: 'skipped', reason: '空文件（front-matter 之后无正文）', bytes: info.size }
    }

    const fallbackTitle = titleFromContent(noteBody) || stemOf(displayName) || ''
    const title = foldTitle(String(data.title ?? '').trim() || fallbackTitle)
    const tags = normalizeTags([...(data.tags ?? []), ...options.extraTags])

    // id 冲突 → 重新分配（既不覆盖已有笔记，也不复用别人的 id）
    let id = typeof data.id === 'string' && data.id.trim() ? data.id.trim() : newId()
    if (data.id) {
      const existing = await dbSelect<{ id: string }>('读取笔记失败', 'SELECT id FROM notes WHERE id = $1', [id])
      if (existing.length > 0) id = newId()
    }

    const stamp = now()
    const createdAt = typeof data.created === 'number' ? Math.trunc(data.created) : Math.trunc(info.mtimeMs || stamp)
    const updatedAt = typeof data.updated === 'number' ? Math.trunc(data.updated) : createdAt

    const relPath = await saveNote({
      id,
      title,
      content: noteBody,
      tags,
      pinned: data.pinned === true,
      order: options.order.value,
      createdAt,
      updatedAt,
      folderRel: targetFolderRel,
      deleted: false,
    })
    options.order.value -= 1

    const actualStem = stemOf((relPath.split('/').pop() ?? '').replace(/\.md$/i, ''))
    const desiredStem = sanitizeStem(title) || '无标题'
    return {
      source,
      status: 'imported',
      noteId: id,
      relPath,
      title,
      bytes: info.size,
      renamed: actualStem !== desiredStem,
    }
  } catch (error) {
    return { source, status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

/** 递归收集目录下的 md 文件（自检/文档注明的跳过规则） */
async function collectMarkdown(
  root: string,
  options: { preserveStructure: boolean },
): Promise<{ files: Array<{ absolute: string; subdir: string | null }>; skippedDirs: string[] }> {
  const { fs } = getStorage()
  const files: Array<{ absolute: string; subdir: string | null }> = []
  const skippedDirs: string[] = []
  const walk = async (dir: string, relative: string | null): Promise<void> => {
    let entries
    try {
      entries = await fs.readDir(dir)
    } catch (error) {
      skippedDirs.push(`${relative ?? dir}（无法读取：${error instanceof Error ? error.message : String(error)}）`)
      return
    }
    for (const entry of entries) {
      const absolute = joinPath(dir, entry.name)
      if (entry.isDirectory) {
        if (isHiddenName(entry.name)) {
          skippedDirs.push(`${relative ? `${relative}/` : ''}${entry.name}`)
          continue
        }
        await walk(absolute, options.preserveStructure ? (relative ? `${relative}/${entry.name}` : entry.name) : null)
        continue
      }
      if (!entry.isFile) continue
      if (!entry.name.toLowerCase().endsWith('.md')) continue
      files.push({ absolute, subdir: relative })
    }
  }
  await walk(root, null)
  return { files, skippedDirs }
}

/**
 * 导入一批路径（文件或目录）到 vault。
 * 路径由调用方通过系统对话框选择（plugin-dialog 的 `open` 会把选中路径动态加入 fs 作用域；
 * **选目录时务必传 `recursive: true`**，否则子目录里的 md 读不到）。
 */
export async function importMarkdownPaths(paths: string[], options: ImportOptions = {}): Promise<ImportResult> {
  const { fs } = getStorage()
  const extraTags = normalizeTags(options.extraTags ?? [])
  const maxBytes = options.maxBytes ?? DEFAULT_IMPORT_MAX_BYTES
  const preserveStructure = options.preserveStructure !== false
  const baseFolderRel = await folderRelFor(options.folderId ?? null)

  const results: ImportFileResult[] = []
  const foldersBefore = Object.keys(await readFoldersMeta()).length
  /** 每个目标目录一个"下一个排序位"计数器（索引里查一次，之后内存递减，避免撞位） */
  const orderByDir = new Map<string, { value: number }>()
  const orderFor = async (dirRel: string | null): Promise<{ value: number }> => {
    const key = dirRel ?? ''
    if (!orderByDir.has(key)) orderByDir.set(key, { value: await initialNextOrder(dirRel) })
    return orderByDir.get(key) as { value: number }
  }

  for (const input of paths) {
    let info
    try {
      info = await fs.stat(input)
    } catch (error) {
      results.push({
        source: input,
        status: 'failed',
        reason: `无法访问：${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }

    if (!info.isDirectory) {
      if (!input.toLowerCase().endsWith('.md')) {
        results.push({ source: input, status: 'skipped', reason: '不是 .md 文件' })
        continue
      }
      results.push(
        await importOneFile(input, input.split(/[\\/]/).pop() ?? input, baseFolderRel, {
          extraTags,
          maxBytes,
          order: await orderFor(baseFolderRel),
        }),
      )
      continue
    }

    const { files, skippedDirs } = await collectMarkdown(input, { preserveStructure })
    if (files.length === 0) {
      results.push({
        source: input,
        status: 'skipped',
        reason:
          `目录里没有可导入的 .md 文件` +
          (skippedDirs.length > 0 ? `（已跳过：${skippedDirs.slice(0, 5).join(', ')}）` : ''),
      })
      continue
    }
    for (const file of files) {
      let targetRel = baseFolderRel
      if (preserveStructure && file.subdir) {
        targetRel = baseFolderRel ? toRelPosix(joinPath(baseFolderRel, file.subdir)) : toRelPosix(file.subdir)
        await fs.mkdir(vaultPath(targetRel), { recursive: true })
        await ensureFolderMeta(targetRel)
      }
      results.push(
        await importOneFile(file.absolute, file.absolute.split(/[\\/]/).pop() ?? file.absolute, targetRel, {
          extraTags,
          maxBytes,
          order: await orderFor(targetRel),
        }),
      )
    }
  }

  const imported = results.filter((item) => item.status === 'imported').length
  const skipped = results.filter((item) => item.status === 'skipped').length
  const failed = results.filter((item) => item.status === 'failed').length

  // 导入后同步索引（目录导入可能新建了子目录 → 这里把目录/笔记一起投影进索引）
  if (options.sync !== false && imported > 0) await syncIndex()

  const parts = [`成功 ${imported} 条`, `跳过 ${skipped} 条`, `失败 ${failed} 条`]
  const newFolders = Object.keys(await readFoldersMeta()).length - foldersBefore
  if (newFolders > 0) parts.push(`新建文件夹 ${newFolders} 个`)
  const renamedCount = results.filter((item) => item.renamed).length
  if (renamedCount > 0) parts.push(`重名自动改名 ${renamedCount} 条`)
  const firstReason = results.find((item) => item.status !== 'imported' && item.reason)?.reason
  const summary = `导入完成：${parts.join(' / ')}${firstReason ? `（例：${firstReason}）` : ''}`

  return { total: results.length, imported, skipped, failed, files: results, summary }
}

/** 导入结果的极简文本（无 Toast 的调用方也能给出可读反馈） */
export function formatImportResult(result: ImportResult): string {
  return result.summary
}

/** 单条的问题清单（供"查看详情"用） */
export function importProblems(result: ImportResult): string[] {
  return result.files
    .filter((item) => item.status !== 'imported')
    .map((item) => `${item.source}：${item.reason ?? item.status}`)
}
