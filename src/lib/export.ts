/**
 * 导出笔记：Markdown / HTML / 纯文本 / JSON。
 * 归属：架构师（冻结签名）→ 任务 t5（外壳 UI 成员）补齐「落盘 + 通知」实现。
 *
 * 契约（docs/ARCHITECTURE.md §4.6 / §4.7，签名逐字保留，只做「加函数」式扩展）：
 *  - `serialize(note, format)` / `exportFileName(note, format)` / `toMarkdown` / `toHtml` / `toPlainText`
 *    五个签名**不得改动**；本文件另外提供 `ExportTarget = ExportFormat | 'json'` 与对应新函数，
 *    既有调用方（EditorPaneProps.onExport 的 'markdown'|'html'|'txt'）零影响。
 *  - `toMarkdown` 必须带 YAML front-matter；`toHtml` 必须是独立可打开的完整 HTML；
 *  - 文件名非法字符统一替换，长度受限；
 *  - **零硬编码色值**：HTML 导出里的颜色全部在导出瞬间从当前主题的 `--zj-*` 变量读取，
 *    因此导出件跟随用户当前主题（淡黄 / 米白 / 灰蓝 / 墨绿 / 暗夜 × 明暗），源码里没有任何颜色字面量。
 *
 * 落盘策略（为什么这样写）：
 *  - `@tauri-apps/plugin-dialog` 的 `save()` 会把用户选中的路径**动态加入 fs 作用域**
 *    （见 tauri-plugin-dialog 的 commands.rs::save → `fs_scope.allow_file(path)`），
 *    因此 `writeTextFile(绝对路径)` 不需要在 capabilities 里放宽静态目录白名单 —— 已实测确认。
 *  - 非 Tauri（`pnpm dev` 纯浏览器预览）没有文件系统，退化为浏览器下载，方便调样式时验证导出内容。
 */

import type { Note, ThemeId, ThemeMode, ThemeToken, ThemeTokens } from '@/types'
import { APP_META, isTauri } from '@/lib/tauri'

/* ============================== 格式定义 ============================== */

/** 契约冻结的三种格式 */
export type ExportFormat = 'markdown' | 'html' | 'txt'

/** 扩展目标：在冻结的三种格式之外补上「带元数据的 JSON」 */
export type ExportTarget = ExportFormat | 'json'

/** 导出格式展示信息（菜单 / 下拉列表用，避免各处散写文案与扩展名） */
export interface ExportFormatInfo {
  target: ExportTarget
  label: string
  extension: string
  /** 保存对话框里的筛选器名 */
  filterName: string
  description: string
}

export const EXPORT_FORMATS: readonly ExportFormatInfo[] = [
  {
    target: 'markdown',
    label: 'Markdown',
    extension: 'md',
    filterName: 'Markdown',
    description: '带 YAML front-matter 的 .md',
  },
  {
    target: 'html',
    label: 'HTML',
    extension: 'html',
    filterName: 'HTML',
    description: '内联淡雅样式的独立网页',
  },
  {
    target: 'txt',
    label: '纯文本',
    extension: 'txt',
    filterName: '文本文件',
    description: '纯文本，无标记',
  },
  {
    target: 'json',
    label: 'JSON',
    extension: 'json',
    filterName: 'JSON',
    description: '含元数据的结构化备份',
  },
] as const

/** 取某个导出目标的信息；未知目标回落到 Markdown */
export function exportFormatInfo(target: ExportTarget): ExportFormatInfo {
  return EXPORT_FORMATS.find((item) => item.target === target) ?? EXPORT_FORMATS[0]
}

/* ============================== 序列化 ============================== */

/** 把笔记序列化为指定格式的文本内容（FROZEN 签名） */
export function serialize(note: Note, format: ExportFormat): string {
  switch (format) {
    case 'markdown':
      return toMarkdown(note)
    case 'html':
      return toHtml(note)
    case 'txt':
      return toPlainText(note)
    default: {
      const _exhaustive: never = format
      return String(_exhaustive)
    }
  }
}

/** 把笔记序列化为任意导出目标（含 json）的文本内容 */
export function serializeTarget(note: Note, target: ExportTarget): string {
  if (target === 'json') return toJson(note)
  return serialize(note, target)
}

/** 生成安全的导出文件名（含扩展名）（FROZEN 签名） */
export function exportFileName(note: Note, format: ExportFormat): string {
  return exportFileNameFor(note, format)
}

/** 生成安全的导出文件名（含扩展名，支持 json） */
export function exportFileNameFor(note: Note, target: ExportTarget): string {
  return `${sanitizeFileBase(note.title)}.${exportFormatInfo(target).extension}`
}

/** Windows 保留名（大小写无关），用作文件名时前缀下划线 */
const RESERVED_BASE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i
/** 路径分隔符 + Windows 非法字符 + 控制字符 */
const ILLEGAL_FILE_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g

/**
 * 文件名净化：非法字符 → `_`，空白折叠为单个空格，去掉首尾的点与空格，限长 60。
 * 空标题回落「无标题」，保留名前缀下划线规避 Windows 保留名。
 */
export function sanitizeFileBase(name: string, fallback = '无标题'): string {
  const cleaned = name
    .replace(ILLEGAL_FILE_CHARS, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 60)
    .trim()
  const base = cleaned.length > 0 ? cleaned : fallback
  return RESERVED_BASE.test(base) ? `_${base}` : base
}

/** JSON 导出的元数据块 */
export interface NoteExportMeta {
  app: string
  version: string
  /** 导出瞬间的 ISO 时间 */
  exportedAt: string
  target: ExportTarget
  /** 导出时的界面主题（便于还原观感） */
  theme?: { id: ThemeId | null; mode: ThemeMode | null }
}

/** JSON 导出的完整结构 */
export interface NoteExportPayload {
  meta: NoteExportMeta
  note: Note
}

/** 读取当前界面主题（`<html data-theme>` / `<html class="dark">`） */
export function readActiveTheme(): { id: ThemeId | null; mode: ThemeMode | null } {
  if (typeof document === 'undefined') return { id: null, mode: null }
  const root = document.documentElement
  const id = (root.dataset.theme as ThemeId | undefined) ?? null
  const mode: ThemeMode | null = root.classList.contains('dark') ? 'dark' : 'light'
  return { id, mode }
}

/** 笔记 → 含元数据的 JSON 文本（2 空格缩进，便于人工查看与 diff） */
export function toJson(note: Note, meta?: Partial<NoteExportMeta>): string {
  const payload: NoteExportPayload = {
    meta: {
      app: APP_META.productName,
      version: APP_META.version,
      exportedAt: new Date().toISOString(),
      target: 'json',
      theme: readActiveTheme(),
      ...meta,
    },
    note,
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

/** 笔记 → 带 YAML front-matter 的 Markdown */
export function toMarkdown(note: Note): string {
  const frontMatter = [
    '---',
    `title: ${JSON.stringify(note.title)}`,
    `tags: [${note.tags.map((tag) => JSON.stringify(tag)).join(', ')}]`,
    `pinned: ${note.pinned ? 'true' : 'false'}`,
    `createdAt: ${new Date(note.createdAt).toISOString()}`,
    `updatedAt: ${new Date(note.updatedAt).toISOString()}`,
    '---',
    '',
  ].join('\n')
  return `${frontMatter}${note.content.replace(/\s+$/, '')}\n`
}

/** 笔记 → 纯文本（标题 + 空行 + 正文） */
export function toPlainText(note: Note): string {
  return `${note.title}\n\n${note.content.replace(/\s+$/, '')}\n`
}

/* ========================= 主题 token（导出件配色） ========================= */

/** 契约 §4.5 的 12 个 token（顺序即导出件里 CSS 变量的书写顺序） */
export const THEME_TOKEN_NAMES: readonly ThemeToken[] = [
  'zj-bg',
  'zj-surface',
  'zj-surface-2',
  'zj-text',
  'zj-text-muted',
  'zj-accent',
  'zj-accent-fg',
  'zj-border',
  'zj-hover',
  'zj-selection',
  'zj-shadow',
  'zj-radius',
] as const

/**
 * 从运行时 CSS 变量读取当前主题 token 值。
 * 读不到（非浏览器环境）时返回空对象 —— 绝不写死颜色，导出件退化为浏览器默认配色。
 */
export function readThemeTokens(scope?: Element): Partial<ThemeTokens> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return {}
  const element = scope ?? document.documentElement
  const styles = window.getComputedStyle(element)
  const tokens: Partial<ThemeTokens> = {}
  for (const token of THEME_TOKEN_NAMES) {
    const value = styles.getPropertyValue(`--${token}`).trim()
    if (value.length > 0) tokens[token] = value
  }
  return tokens
}

/* ============================== HTML 导出 ============================== */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 字体栈（字体不属于「颜色硬编码」禁令范围，DESIGN §3 指定中文字体优先级） */
const HTML_FONT_STACK =
  "'HarmonyOS Sans SC','PingFang SC','Microsoft YaHei',system-ui,-apple-system,sans-serif"
const HTML_MONO_STACK = "'JetBrains Mono','Cascadia Code',Consolas,monospace"

/**
 * 把运行时读到的 token 拼成 :root 变量块 + 只引用变量的规则。
 * 源码里没有任何颜色字面量：颜色全部来自 `tokens`（运行时读出的主题值）。
 */
function buildHtmlStyle(tokens: Partial<ThemeTokens>): string {
  const declarations = THEME_TOKEN_NAMES.filter((token) => tokens[token] !== undefined)
    .map((token) => `    --${token}: ${tokens[token]};`)
    .join('\n')

  return [
    declarations.length > 0 ? `  :root {\n${declarations}\n  }` : '',
    '  * { box-sizing: border-box; }',
    '  html { background: var(--zj-bg); }',
    '  body {',
    '    margin: 0; padding: 48px 24px; min-height: 100vh;',
    '    background: var(--zj-bg); color: var(--zj-text);',
    `    font: 15px/1.75 ${HTML_FONT_STACK};`,
    '    -webkit-font-smoothing: antialiased;',
    '  }',
    '  main { max-width: 760px; margin: 0 auto; }',
    '  h1 {',
    '    margin: 0 0 8px; font-size: 24px; font-weight: 600; line-height: 1.4;',
    '    color: var(--zj-text); word-break: break-word;',
    '  }',
    '  .meta {',
    '    margin: 0 0 24px; padding-bottom: 12px; border-bottom: 1px solid var(--zj-border);',
    '    font-size: 12px; line-height: 1.6; color: var(--zj-text-muted);',
    '  }',
    '  .tags { margin-top: 4px; }',
    '  .tag {',
    '    display: inline-block; margin-right: 8px; padding: 0 6px;',
    '    border: 1px solid var(--zj-border); border-radius: 6px;',
    '    color: var(--zj-text-muted);',
    '  }',
    '  pre.content {',
    '    margin: 0; padding: 16px; border: 1px solid var(--zj-border); border-radius: 8px;',
    '    background: var(--zj-surface); color: var(--zj-text);',
    `    font: 14px/1.7 ${HTML_MONO_STACK};`,
    '    white-space: pre-wrap; overflow-wrap: anywhere;',
    '  }',
    '  ::selection { background: var(--zj-selection); }',
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

/**
 * 笔记 → 独立可打开的完整 HTML（内联淡雅样式）。
 *
 * `tokens` 缺省即读取当前主题的 `--zj-*`；传入即可指定导出配色（测试 / 批处理用）。
 * 正文以 `<pre>` 忠实呈现（不重新解析 Markdown：预览渲染属于编辑器模块 src/features/editor）。
 */
export function toHtml(note: Note, tokens: Partial<ThemeTokens> = readThemeTokens()): string {
  const theme = readActiveTheme()
  const themeLabel = theme.id === null ? '' : `${theme.id} · ${theme.mode ?? 'light'}`
  const tags = note.tags.length
    ? `<p class="tags">${note.tags
        .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
        .join('')}</p>`
    : ''
  const updated = new Date(note.updatedAt).toLocaleString('zh-CN')

  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(note.title || '无标题')}</title>`,
    '<style>',
    buildHtmlStyle(tokens),
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    `<h1>${escapeHtml(note.title || '无标题')}</h1>`,
    `<p class="meta">${escapeHtml(APP_META.productName)} 导出 · 更新于 ${escapeHtml(updated)}${
      themeLabel.length > 0 ? ` · 主题 ${escapeHtml(themeLabel)}` : ''
    }</p>`,
    tags,
    `<pre class="content">${escapeHtml(note.content)}</pre>`,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

/* ============================== 落盘 ============================== */

/** 通知回调（结构化兼容 src/components/ui 的 ToastOptions，避免 lib 反向依赖组件层） */
export interface ExportNotice {
  title: string
  description?: string
  variant?: 'info' | 'success' | 'warning' | 'error'
}

export type ExportOutcome = 'saved' | 'downloaded' | 'cancelled' | 'no-note' | 'failed'

export interface ExportResult {
  ok: boolean
  outcome: ExportOutcome
  target: ExportTarget
  /** 生成的文件名（含扩展名）；未选择笔记时为 null */
  fileName: string | null
  /** 落盘绝对路径（仅 Tauri 保存成功时有值） */
  path: string | null
  /** 面向用户的中文提示（可直接进 Toast） */
  message: string
  /** 序列化后的内容（无文件系统 / 需二次加工时可用） */
  content?: string
}

export interface ExportOptions {
  /** 通知回调：一般传 `useToast().toast`，例如 `{ notify: toast }` */
  notify?: (notice: ExportNotice) => void
  /** 覆盖文件名主干（不含扩展名）；缺省用笔记标题净化后的值 */
  fileBase?: string
}

/** 未选择笔记时的友好提示文案（供调用方复用，保持全应用一致） */
export const EXPORT_NO_NOTE_MESSAGE = '请先在列表中选择一条笔记，再执行导出。'

/** 非 Tauri 环境（浏览器预览）的兜底：走浏览器下载 */
function downloadInBrowser(fileName: string, content: string): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * 导出笔记到用户选择的文件。
 *
 * - 未选择笔记：友好提示（warning Toast），返回 `outcome: 'no-note'`；
 * - Tauri：`plugin-dialog.save()` 选路径 → `plugin-fs.writeTextFile()` 落盘 → 成功 Toast；
 * - 浏览器预览：退化为浏览器下载 → 成功 Toast；
 * - 失败：error Toast + 可读 message（不抛异常，UI 不必 try/catch）。
 */
export async function exportNote(
  note: Note | null,
  target: ExportTarget,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const info = exportFormatInfo(target)
  const notify = options.notify

  if (!note) {
    notify?.({ title: '未选择笔记', description: EXPORT_NO_NOTE_MESSAGE, variant: 'warning' })
    return {
      ok: false,
      outcome: 'no-note',
      target,
      fileName: null,
      path: null,
      message: EXPORT_NO_NOTE_MESSAGE,
    }
  }

  const fileName = `${sanitizeFileBase(options.fileBase ?? note.title)}.${info.extension}`
  const content = serializeTarget(note, target)

  if (!isTauri) {
    downloadInBrowser(fileName, content)
    const message = `已在浏览器中下载 ${fileName}`
    notify?.({
      title: '导出成功',
      description: `${message}（浏览器预览模式）`,
      variant: 'success',
    })
    return { ok: true, outcome: 'downloaded', target, fileName, path: null, message, content }
  }

  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const path = await save({
      title: `导出为 ${info.label}`,
      defaultPath: fileName,
      filters: [{ name: info.filterName, extensions: [info.extension] }],
    })

    if (path === null || path.length === 0) {
      return {
        ok: false,
        outcome: 'cancelled',
        target,
        fileName,
        path: null,
        message: '已取消导出',
        content,
      }
    }

    const { writeTextFile } = await import('@tauri-apps/plugin-fs')
    await writeTextFile(path, content)

    const message = `已导出为 ${info.label}`
    notify?.({ title: '导出成功', description: path, variant: 'success' })
    return { ok: true, outcome: 'saved', target, fileName, path, message, content }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    notify?.({ title: '导出失败', description: message, variant: 'error' })
    return { ok: false, outcome: 'failed', target, fileName, path: null, message, content }
  }
}
