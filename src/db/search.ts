/**
 * searchRepo —— 中文全文搜索（FROZEN 签名，实现归属：db 成员）。
 * ==================================================================
 * 契约：
 *  - query 为空或全空白时返回 []（不抛错）。
 *  - snippet 中用 `<mark>…</mark>` 包裹命中词；rank 越小越相关。
 *  - 已软删除的笔记不出现在结果中。
 *
 * ## 中文检索方案（两条路径都在代码里实现，按可用性选择）
 *
 * **路径 A（首选）：FTS5 + trigram tokenizer**（`notes_fts_trigram`，SQLite ≥ 3.34.0）
 *  - v1 的 `notes_fts` 用 unicode61 分词：连续汉字被当成**一个 token**，
 *    所以「我的笔记本」用 MATCH '"笔记"' 查不到（自检 check_13 有实测证据）。
 *  - trigram 把文本切成 3 字符滑窗，天然支持**中文子串**，返回真实 `bm25()` 排序。
 *  - trigram 的硬限制：**查询短于 3 个字符时无法匹配**（实测返回空集而非报错），
 *    因此 1–2 字查询（「笔记」「检索」）必须走路径 B。
 *
 * **路径 B（兜底）：`LIKE '%q%'`**
 *  - 以下三种情况自动落到这里：查询 < 3 字符；trigram 不可用
 *    （SQLite < 3.34 或未编译 FTS5，见 src/db/index.ts 的能力探测）；
 *    路径 A 抛错（用户输入的特殊字符等）。
 *  - 另外，**路径 A 返回 0 条命中也用路径 B 复核**：属于纯增量兜底
 *    （trigram 的子串语义与 LIKE 一致，正常情况下结果相同），避免因分词细节漏检。
 *  - LIKE 没有 bm25，用"伪 rank"：标题命中 → 命中位置（0 起）；正文命中 →
 *    1000 + 命中位置。只用在同一路径内部排序，两条路径的 rank **不跨路径比较**。
 *
 * ## snippet 约定（实现里唯一，两条路径共用）
 *  - 由本文件的 `buildSnippet()` 生成（不用 FTS5 的 snippet()），保证两条路径输出一致。
 *  - 文本先做 HTML 转义（`&` `<` `>`），再插入 `<mark>`，因此可安全地用
 *    `dangerouslySetInnerHTML` 渲染；空白折叠为单空格；超窗用 `…` 标记。
 *  - 头部注释即为"契约说明"；`SearchHit.snippet`（src/types/index.ts）已声明
 *    "命中上下文片段，已用 <mark> 包裹关键词"，此处实现与之一致。
 */

import type { SearchHit } from '@/types'
import { dbSelect, isFtsTrigramAvailable } from './index'
import { SEARCH_MARK_CLOSE, SEARCH_MARK_OPEN, SNIPPET_AFTER, SNIPPET_BEFORE, SQL, mapNoteRow, type NoteRow } from './schema'

export const DEFAULT_SEARCH_LIMIT = 50

/** limit 上限，防止一次性把整库读进内存 */
const MAX_SEARCH_LIMIT = 200

/** trigram tokenizer 能匹配的最短查询长度（3 字符滑窗） */
const TRIGRAM_MIN_QUERY_LENGTH = 3

/** LIKE 路径多取候选条数（后续按伪 rank 重排，再截断到 limit） */
const LIKE_OVERSCAN = 4
const MAX_LIKE_CANDIDATES = 400

export interface SearchRepo {
  search(query: string, limit?: number): Promise<SearchHit[]>
}

/* ============================ snippet 生成 ============================ */

/** HTML 转义（snippet 只允许出现 <mark> 标签，其余文本必须转义） */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 正则字面量化（用户输入直接进 RegExp 前必须转义） */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 在窗口内用 <mark> 包裹全部命中（大小写不敏感，索引基于原文，避免 toLowerCase 长度漂移） */
function highlight(text: string, query: string): string {
  const pattern = new RegExp(escapeRegExp(query), 'gi')
  let output = ''
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match[0].length === 0) break
    output += escapeHtml(text.slice(cursor, match.index))
    output += `${SEARCH_MARK_OPEN}${escapeHtml(match[0])}${SEARCH_MARK_CLOSE}`
    cursor = match.index + match[0].length
    pattern.lastIndex = cursor
  }
  output += escapeHtml(text.slice(cursor))
  return output
}

/**
 * 生成命中片段：以首个命中位置为中心开窗（前 {@link SNIPPET_BEFORE} / 后 {@link SNIPPET_AFTER}
 * 字符），命中词用 `<mark>` 包裹；未命中时取开头一小段。
 * 导出以便自检脚本（src/db/__checks__/run-checks.mjs）直接单测。
 */
export function buildSnippet(text: string, query: string): string {
  const source = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  const q = String(query ?? '').trim()
  if (!source) return ''
  if (!q) return escapeHtml(source.slice(0, SNIPPET_BEFORE + SNIPPET_AFTER))

  const first = new RegExp(escapeRegExp(q), 'gi').exec(source)
  const hitIndex = first ? first.index : 0
  const start = Math.max(0, hitIndex - SNIPPET_BEFORE)
  const end = Math.min(source.length, (first ? hitIndex + q.length : SNIPPET_BEFORE) + SNIPPET_AFTER)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < source.length ? '…' : ''
  return `${prefix}${highlight(source.slice(start, end), q)}${suffix}`
}

/* ============================== 查询实现 ============================== */

function clampLimit(limit: number): number {
  const value = Number(limit)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_SEARCH_LIMIT
  return Math.min(Math.trunc(value), MAX_SEARCH_LIMIT)
}

/** 代码点长度（中文、emoji 都按"字符"计数，决定能否走 trigram） */
function countCodePoints(text: string): number {
  return [...text].length
}

/** FTS5 短语查询：整体加引号，内部引号按 FTS5 规则写成 "" 防止语法注入 */
function toTrigramPhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"`
}

/** LIKE 模式：转义 \ % _ 后用 % 包裹（SQL 侧配合 ESCAPE '\'） */
function toLikePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

/** snippet 取标题还是正文：标题命中优先 */
function snippetSource(row: NoteRow, query: string): string {
  const title = String(row.title ?? '')
  if (title.toLowerCase().includes(query.toLowerCase())) return title
  return String(row.content ?? '')
}

/** LIKE 路径的伪 bm25（越小越相关；只在同路径内比较） */
function pseudoBm25(row: NoteRow, query: string): number {
  const needle = query.toLowerCase()
  const titleIndex = String(row.title ?? '').toLowerCase().indexOf(needle)
  if (titleIndex >= 0) return titleIndex
  const contentIndex = String(row.content ?? '').toLowerCase().indexOf(needle)
  return 1000 + (contentIndex < 0 ? 999 : Math.min(contentIndex, 999))
}

/** 路径 A：FTS5 + trigram（真实 bm25） */
async function searchWithTrigram(query: string, limit: number): Promise<SearchHit[]> {
  const rows = await dbSelect<NoteRow & { rank: number }>('搜索笔记失败', SQL.searchTrigram, [
    toTrigramPhrase(query),
    limit,
  ])
  return rows.map((row) => ({
    note: mapNoteRow(row),
    snippet: buildSnippet(snippetSource(row, query), query),
    rank: Number(row.rank ?? 0),
  }))
}

/** 路径 B：LIKE 子串（伪 rank） */
async function searchWithLike(query: string, limit: number): Promise<SearchHit[]> {
  const candidates = Math.min(limit * LIKE_OVERSCAN, MAX_LIKE_CANDIDATES)
  const rows = await dbSelect<NoteRow>('搜索笔记失败', SQL.searchLike, [toLikePattern(query), candidates])
  return rows
    .map((row) => ({
      note: mapNoteRow(row),
      snippet: buildSnippet(snippetSource(row, query), query),
      rank: pseudoBm25(row, query),
    }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        b.note.updatedAt - a.note.updatedAt ||
        (a.note.id < b.note.id ? -1 : a.note.id > b.note.id ? 1 : 0),
    )
    .slice(0, limit)
}

export const searchRepo: SearchRepo = {
  async search(query: string, limit: number = DEFAULT_SEARCH_LIMIT): Promise<SearchHit[]> {
    const q = String(query ?? '').trim()
    if (!q) return []
    const capped = clampLimit(limit)

    if (isFtsTrigramAvailable() && countCodePoints(q) >= TRIGRAM_MIN_QUERY_LENGTH) {
      try {
        const hits = await searchWithTrigram(q, capped)
        if (hits.length > 0) return hits
        // 0 条命中 → 用 LIKE 复核（纯兜底增量，语义一致）
      } catch (error) {
        console.warn('[纸笺] FTS5 trigram 检索失败，改用 LIKE 子串检索：', error)
      }
    }

    return searchWithLike(q, capped)
  },
}
