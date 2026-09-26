/**
 * front-matter 规范实现（纯函数，无 IO）——「md 文件是唯一真相源」的序列化层。
 *
 * 文件格式：
 * ```
 * ---
 * id: 8f1c…            # 稳定标识（缺失时由导入方补写）
 * title: 我的笔记       # 人类可读标题；与文件名同源
 * tags:                # 标签名列表（块列表；空数组写作 tags: []）
 *   - 工作
 * pinned: false
 * created: 1700000000000   # 毫秒时间戳
 * updated: 1700000000000
 * order: 0
 * ---
 *
 * 正文（原文，可含任意内容，包括以 `---` 开头的行）
 * ```
 * 边界情况（见 docs/ARCHITECTURE.md §4.12）：
 *  - **正文含 `---`**：front-matter 在「首个位于行首的 `---`」处闭合，正文里的
 *    `---` 原样保留，不会被当成结束标记。
 *  - **正文含 `:`**：只有 front-matter 区内的 `首个冒号` 才用作键值分隔；
 *    正文完全不解析。
 *  - **标题含换行**：写入时折叠为单空格（`foldTitle`），因为文件名与单行标量
 *    都无法承载换行；解析侧因此永远不会把多行标题还原（有损但可预期）。
 *  - **值需要引号**：含 `: `、以特殊字符开头、等于 true/false/null、看起来是数字、
 *    或含首尾空白/引号时，用双引号包裹并转义 `\` 与 `"`。
 */

/** front-matter 中允许的元数据（未出现的键由调用方补默认值） */
export interface FrontMatter {
  id?: string
  title?: string
  tags: string[]
  pinned?: boolean
  created?: number
  updated?: number
  order?: number
}

/** 需要写盘的完整元数据 */
export interface FrontMatterData {
  id: string
  title: string
  tags: string[]
  pinned: boolean
  created: number
  updated: number
  order: number
}

export const FRONT_MATTER_FENCE = '---'

/** 标题折叠：换行/制表符 → 空格，折叠连续空白，去首尾 */
export function foldTitle(title: string): string {
  return String(title ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** YAML 单行标量是否需要引号 */
function needsQuotes(value: string): boolean {
  if (value.length === 0) return true
  if (/^[\s]|[\s]$/.test(value)) return true
  if (/[:#]\s|^[!&*?|>%@`"'[\]{},-]/.test(value)) return true
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(value)) return true
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(value)) return true
  return false
}

/** 标量序列化（必要时加双引号并转义） */
export function encodeScalar(value: string): string {
  if (!needsQuotes(value)) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** 标量解析：去引号 + 反转义 */
export function decodeScalar(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/** 标签名规范化（与 tagsRepo 一致：去空白、丢空串、按首现去重） */
export function normalizeTags(tags: readonly string[] | undefined): string[] {
  const result: string[] = []
  for (const raw of tags ?? []) {
    const name = String(raw ?? '').trim()
    if (!name || result.includes(name)) continue
    result.push(name)
  }
  return result
}

/**
 * 解析 md 文本：返回元数据与正文。
 * 无 front-matter 时 `hasFrontMatter=false`、`body` 为全文（外部手写的 md）。
 */
export function parseFrontMatter(text: string): {
  data: FrontMatter
  body: string
  hasFrontMatter: boolean
} {
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  const lines = source.split(/\r?\n/)
  if (lines.length === 0 || lines[0].trim() !== FRONT_MATTER_FENCE) {
    return { data: { tags: [] }, body: source, hasFrontMatter: false }
  }

  let endIndex = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === FRONT_MATTER_FENCE) {
      endIndex = i
      break
    }
  }
  if (endIndex < 0) {
    // 只有开头一个 --- ：视为普通正文，不做半解析，避免吞掉用户内容
    return { data: { tags: [] }, body: source, hasFrontMatter: false }
  }

  const data: FrontMatter = { tags: [] }
  let pendingListKey: string | null = null
  for (let i = 1; i < endIndex; i += 1) {
    const line = lines[i]
    const listMatch = /^\s*-\s*(.*)$/.exec(line)
    if (listMatch && pendingListKey === 'tags') {
      const name = decodeScalar(listMatch[1]).trim()
      if (name) data.tags.push(name)
      continue
    }
    if (!line.trim() || line.trim().startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator < 0) continue
    const key = line.slice(0, separator).trim()
    const rawValue = line.slice(separator + 1).trim()
    pendingListKey = null
    if (!rawValue) {
      if (key === 'tags') pendingListKey = 'tags'
      continue
    }
    if (key === 'tags') {
      if (rawValue === '[]') continue
      if (rawValue.startsWith('[')) {
        for (const part of rawValue.replace(/^\[|\]$/g, '').split(',')) {
          const name = decodeScalar(part).trim()
          if (name) data.tags.push(name)
        }
        continue
      }
      data.tags.push(decodeScalar(rawValue))
      continue
    }
    const value = decodeScalar(rawValue)
    switch (key) {
      case 'id':
        data.id = value
        break
      case 'title':
        data.title = value
        break
      case 'pinned':
        data.pinned = /^(true|yes|1)$/i.test(value)
        break
      case 'created':
        if (Number.isFinite(Number(value))) data.created = Number(value)
        break
      case 'updated':
        if (Number.isFinite(Number(value))) data.updated = Number(value)
        break
      case 'order':
        if (Number.isFinite(Number(value))) data.order = Number(value)
        break
      default:
        break
    }
  }

  // 正文 = 关闭标记之后的全部内容（去掉紧随其后的一个空行）
  const bodyLines = lines.slice(endIndex + 1)
  if (bodyLines.length > 0 && bodyLines[0].trim() === '') bodyLines.shift()
  data.tags = normalizeTags(data.tags)
  return { data, body: bodyLines.join('\n'), hasFrontMatter: true }
}

/** 序列化：front-matter + 正文 */
export function serializeFrontMatter(data: FrontMatterData, body: string): string {
  const title = foldTitle(data.title)
  const tags = normalizeTags(data.tags)
  const lines: string[] = [FRONT_MATTER_FENCE]
  lines.push(`id: ${encodeScalar(data.id)}`)
  lines.push(`title: ${encodeScalar(title)}`)
  if (tags.length === 0) {
    lines.push('tags: []')
  } else {
    lines.push('tags:')
    for (const tag of tags) lines.push(`  - ${encodeScalar(tag)}`)
  }
  lines.push(`pinned: ${data.pinned ? 'true' : 'false'}`)
  lines.push(`created: ${Math.trunc(data.created)}`)
  lines.push(`updated: ${Math.trunc(data.updated)}`)
  lines.push(`order: ${Math.trunc(data.order)}`)
  lines.push(FRONT_MATTER_FENCE)
  lines.push('')
  const content = String(body ?? '').replace(/\r\n/g, '\n')
  lines.push(content)
  return lines.join('\n')
}

/* ============================ 文件名规则 ============================ */

/** Windows/POSIX 非法字符与不可见控制字符 */
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g

/** 保留设备名（Windows） */
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

/** 无标题时的兜底名 */
export const UNTITLED_NAME = '无标题'

/** 文件名主体长度上限（不含 .md 扩展名），留出 `-2`/`-99` 后缀与扩展名空间 */
export const MAX_STEM_LENGTH = 80

/**
 * 标题 → 文件名主体（不含扩展名）：
 *  - 折叠换行、去非法字符 `\/:*?"<>|` 与控制字符；
 *  - 去首尾空白与点（Windows 不允许以点结尾）；
 *  - 截断到 {@link MAX_STEM_LENGTH}；避开 Windows 保留设备名；
 *  - 结果为空时返回空串（由调用方决定是否用「无标题」）。
 */
export function sanitizeStem(title: string): string {
  let stem = foldTitle(title)
    .replace(ILLEGAL_FILENAME_CHARS, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
  if (stem.length > MAX_STEM_LENGTH) stem = stem.slice(0, MAX_STEM_LENGTH).trim().replace(/[.\s]+$/, '')
  if (RESERVED_NAMES.has(stem.toUpperCase())) stem = `_${stem}`
  return stem
}

/** id 的短后缀（用于无标题文件唯一化） */
export function shortIdSuffix(id: string): string {
  return String(id ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 6) || 'x'
}

/**
 * 在一个目录内分配不冲突的文件名主体：
 *  - `title` 为空 → `无标题-<短id>`；
 *  - 冲突 → 追加 `-2` / `-3` …（上限 999 后回落到短 id）。
 * `taken` 是小写主体集合（调用方提供，避免大小写不敏感文件系统冲突）。
 */
export function allocateStem(title: string, id: string, taken: Iterable<string>): string {
  const used = new Set<string>()
  for (const item of taken) used.add(String(item).toLowerCase())
  const base = sanitizeStem(title) || `${UNTITLED_NAME}-${shortIdSuffix(id)}`
  if (!used.has(base.toLowerCase())) return base
  for (let index = 2; index <= 999; index += 1) {
    const candidate = `${base}-${index}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  return `${base}-${shortIdSuffix(id)}`
}
