/**
 * Markdown 编辑命令（**纯函数**：输入 EditorState，输出 TransactionSpec）。
 * 归属：编辑器成员（任务 t16）。
 *
 * 为什么单独成文件：
 *  1. 工具栏按钮、快捷键（Ctrl+B/I/K…）共用同一批命令，避免两处逻辑漂移；
 *  2. 命令只依赖 `@codemirror/state`（无 DOM、无 @codemirror/view），
 *     因此可以在 Node 里用 `state.update(spec)` 做纯函数级断言
 *     —— 见同目录 `__checks__/run-checks.mjs`（20+ 项）；
 *  3. 所有命令都是「改变文档」，与 Live Preview 的「只改显示」严格分开。
 *
 * 约定：
 *  - 有选区 → 包裹（再次执行 → 取消包裹）；无选区 → 包裹光标所在词，否则插入占位文本并选中它；
 *  - 行级命令（标题 / 列表 / 任务 / 引用）为**前缀切换**：整段都已带该前缀则移除，否则统一加上；
 *  - 返回的 TransactionSpec 不含 effects，调用方（view.dispatch）负责滚动与聚焦。
 */

import { EditorSelection } from '@codemirror/state'
import type { ChangeSpec, EditorState, TransactionSpec } from '@codemirror/state'

export type MarkdownCommandId =
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'inlineCode'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'quote'
  | 'codeBlock'
  | 'link'
  | 'table'
  | 'horizontalRule'

/* ------------------------------ 小工具 ------------------------------ */

const WORD_CHAR = /[\p{L}\p{N}_]/u

/** 取 pos 处的「词」（中英文都算），没有词时返回空区间 */
function wordAt(state: EditorState, pos: number): { from: number; to: number } {
  const line = state.doc.lineAt(pos)
  let from = pos
  let to = pos
  while (from > line.from && WORD_CHAR.test(state.sliceDoc(from - 1, from))) from--
  while (to < line.to && WORD_CHAR.test(state.sliceDoc(to, to + 1))) to++
  return { from, to }
}

/** 行级前缀定义（都锚定在行首） */
const LINE_PREFIX = {
  heading: /^(#{1,6})[ \t]+/,
  quote: /^>[ \t]?/,
  task: /^[-*+][ \t]+\[[ xX]\][ \t]+/,
  bullet: /^[-*+][ \t]+/,
  ordered: /^\d{1,9}[.)][ \t]+/,
} as const

/** 去掉行首已有的任意列表/引用/标题前缀，返回净文本起点的相对下标 */
function stripBlockPrefix(text: string): number {
  let index = 0
  let guard = 0
  for (;;) {
    if (guard++ > 8) break
    const rest = text.slice(index)
    const matched =
      LINE_PREFIX.task.exec(rest) ??
      LINE_PREFIX.bullet.exec(rest) ??
      LINE_PREFIX.ordered.exec(rest) ??
      LINE_PREFIX.quote.exec(rest) ??
      LINE_PREFIX.heading.exec(rest)
    if (!matched || matched[0].length === 0) break
    index += matched[0].length
  }
  return index
}

/** 选区覆盖的行区间（只处理主选区，多选区场景对行级命令无实际意义） */
function selectedLineRange(state: EditorState): { fromLine: number; toLine: number; head: number } {
  const range = state.selection.main
  return {
    fromLine: state.doc.lineAt(range.from).number,
    toLine: state.doc.lineAt(range.to).number,
    head: range.head,
  }
}

type PrefixKind = 'h1' | 'h2' | 'h3' | 'h4' | 'bullet' | 'ordered' | 'task' | 'quote'

/** 生成某一行的目标前缀；null 表示「移除前缀」 */
function targetPrefix(kind: PrefixKind, index: number, remove: boolean): string {
  if (remove) return ''
  switch (kind) {
    case 'h1':
      return '# '
    case 'h2':
      return '## '
    case 'h3':
      return '### '
    case 'h4':
      return '#### '
    case 'bullet':
      return '- '
    case 'ordered':
      return `${index + 1}. `
    case 'task':
      return '- [ ] '
    case 'quote':
      return '> '
  }
}

/** 某一行当前是否已经属于该前缀类型 */
function hasPrefix(kind: PrefixKind, text: string): boolean {
  switch (kind) {
    case 'h1':
      return /^#[ \t]+/.test(text)
    case 'h2':
      return /^##[^#]/.test(text) || /^##[ \t]+/.test(text)
    case 'h3':
      return /^###[^#]/.test(text) || /^###[ \t]+/.test(text)
    case 'h4':
      return /^####[^#]/.test(text) || /^####[ \t]+/.test(text)
    case 'bullet':
      return LINE_PREFIX.bullet.test(text) && !LINE_PREFIX.task.test(text)
    case 'ordered':
      return LINE_PREFIX.ordered.test(text)
    case 'task':
      return LINE_PREFIX.task.test(text)
    case 'quote':
      return LINE_PREFIX.quote.test(text)
  }
}

/**
 * 行级前缀切换：整段都已带该前缀 → 全部移除；否则全部改为该前缀。
 * 选择性与光标由 CodeMirror 自动映射（不需要显式给 selection）。
 */
function linePrefixSpec(state: EditorState, kind: PrefixKind): TransactionSpec {
  const { fromLine, toLine } = selectedLineRange(state)
  const lines: { from: number; to: number; text: string }[] = []
  for (let number = fromLine; number <= toLine; number++) {
    const line = state.doc.line(number)
    lines.push({ from: line.from, to: line.to, text: line.text })
  }

  const remove = lines.every((line) => hasPrefix(kind, line.text))
  const changes: ChangeSpec[] = []
  lines.forEach((line, index) => {
    const stripLength = stripBlockPrefix(line.text)
    const prefix = targetPrefix(kind, index, remove)
    if (stripLength === 0 && prefix.length === 0) return
    // 已经是目标前缀：不动它（避免整段「切换」时产生无意义的事务）
    if (prefix.length > 0 && stripLength === prefix.length && line.text.startsWith(prefix)) return
    changes.push({ from: line.from, to: line.from + stripLength, insert: prefix })
  })

  if (changes.length === 0) return { changes: [] }
  return { changes }
}

/* ------------------------------ 行内命令 ------------------------------ */

/**
 * 行内包裹/取消包裹。
 * 无选区时：光标在词内或紧贴词 → 包裹该词；否则插入 `marker + placeholder + marker` 并选中占位。
 */
export function inlineWrapSpec(
  state: EditorState,
  marker: string,
  placeholder: string,
): TransactionSpec {
  return state.changeByRange((range) => {
    let from = range.from
    let to = range.to
    if (from === to) {
      const word = wordAt(state, range.head)
      from = word.from
      to = word.to
    }

    const outerBefore = state.sliceDoc(Math.max(0, from - marker.length), from)
    const outerAfter = state.sliceDoc(to, Math.min(state.doc.length, to + marker.length))

    // 已经包裹 → 取消包裹
    if (outerBefore === marker && outerAfter === marker) {
      return {
        changes: [
          { from: from - marker.length, to: from },
          { from: to, to: to + marker.length },
        ],
        range: EditorSelection.range(from - marker.length, to - marker.length),
      }
    }

    // 空区间 → 插入占位并选中占位文本（用户可直接覆盖输入）
    if (from === to) {
      return {
        changes: { from, insert: `${marker}${placeholder}${marker}` },
        range: EditorSelection.range(from + marker.length, from + marker.length + placeholder.length),
      }
    }

    const selected = state.sliceDoc(from, to)
    return {
      changes: { from, to, insert: `${marker}${selected}${marker}` },
      range: EditorSelection.range(from + marker.length, to + marker.length),
    }
  })
}

/** 插入链接：`[文字](url)`，插入后选中 `url` 便于直接替换 */
export function linkSpec(state: EditorState): TransactionSpec {
  return state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to)
    const text = selected.length > 0 ? selected : '链接文字'
    const insert = `[${text}](url)`
    const urlStart = range.from + 1 + text.length + 2
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(urlStart, urlStart + 3),
    }
  })
}

/* ------------------------------ 块级命令 ------------------------------ */

/**
 * 在当前行插入块级内容：
 *  - 当前行是空行 → 直接替换该行（不额外留空行）；
 *  - 当前行有内容 → 在其后空一行插入（Markdown 块级语法需要前后空行）。
 * 返回插入起点（供调用方定位占位文本）。
 */
function blockInsertSpec(
  state: EditorState,
  blockText: string,
  placeholder?: { text: string },
): TransactionSpec {
  const range = state.selection.main
  const line = state.doc.lineAt(range.from)
  const isEmptyLine = line.text.trim().length === 0

  // 空行 → 直接替换该行；有内容的行 → 空一行后插入（Markdown 块级语法需要前后空行）
  const from = isEmptyLine ? line.from : line.to
  const to = isEmptyLine ? line.to : line.to
  const insert = isEmptyLine ? blockText : `\n\n${blockText}`

  if (!placeholder) {
    return { changes: { from, to, insert } }
  }

  const blockStart = from + (isEmptyLine ? 0 : 2)
  const offset = blockText.indexOf(placeholder.text)
  const anchor = blockStart + (offset >= 0 ? offset : 0)
  return {
    changes: { from, to, insert },
    selection: EditorSelection.range(anchor, anchor + placeholder.text.length),
  }
}

export const TABLE_SKELETON = ['| 列 1 | 列 2 | 列 3 |', '| --- | --- | --- |', '| 内容 | 内容 | 内容 |'].join(
  '\n',
)

export const TABLE_PLACEHOLDER = '列 1'

export const CODE_BLOCK_PLACEHOLDER = '代码'

/** 行内代码块的围栏（避免在源码里出现三连反引号引起阅读歧义） */
const FENCE = '```'

/** 围栏代码块：有选区则包裹选区，无选区则插入骨架并选中内部占位 */
export function codeBlockSpec(state: EditorState): TransactionSpec {
  const range = state.selection.main
  if (range.from !== range.to) {
    const selected = state.sliceDoc(range.from, range.to)
    const insert = `${FENCE}\n${selected}\n${FENCE}`
    return {
      changes: { from: range.from, to: range.to, insert },
      selection: EditorSelection.range(range.from + FENCE.length + 1, range.from + FENCE.length + 1 + selected.length),
    }
  }
  return blockInsertSpec(state, `${FENCE}\n${CODE_BLOCK_PLACEHOLDER}\n${FENCE}`, {
    text: CODE_BLOCK_PLACEHOLDER,
  })
}

/** 表格骨架（GFM），插入后选中第一个表头单元格占位文本 */
export function tableSpec(state: EditorState): TransactionSpec {
  return blockInsertSpec(state, TABLE_SKELETON, { text: TABLE_PLACEHOLDER })
}

/** 水平线（`---`，独立成行，避免被解析成 Setext 标题） */
export function horizontalRuleSpec(state: EditorState): TransactionSpec {
  return blockInsertSpec(state, '---')
}

/* ------------------------------ 统一入口 ------------------------------ */

/** 命令 → 描述（工具栏与自检脚本共用同一份清单，避免两处漂移） */
export const MARKDOWN_COMMANDS: Record<MarkdownCommandId, { label: string; tooltip: string }> = {
  bold: { label: '加粗', tooltip: '加粗 (Ctrl+B)' },
  italic: { label: '斜体', tooltip: '斜体 (Ctrl+I)' },
  strikethrough: { label: '删除线', tooltip: '删除线 (Ctrl+Shift+X)' },
  inlineCode: { label: '行内代码', tooltip: '行内代码' },
  h1: { label: '一级标题', tooltip: '一级标题' },
  h2: { label: '二级标题', tooltip: '二级标题' },
  h3: { label: '三级标题', tooltip: '三级标题' },
  h4: { label: '四级标题', tooltip: '四级标题' },
  bulletList: { label: '无序列表', tooltip: '无序列表' },
  orderedList: { label: '有序列表', tooltip: '有序列表（自动编号）' },
  taskList: { label: '任务列表', tooltip: '任务列表 (- [ ])' },
  quote: { label: '引用', tooltip: '引用' },
  codeBlock: { label: '代码块', tooltip: '代码块' },
  link: { label: '链接', tooltip: '链接 (Ctrl+K)' },
  table: { label: '表格', tooltip: '插入表格' },
  horizontalRule: { label: '分隔线', tooltip: '水平分隔线' },
}

/** 取某个命令对应的 TransactionSpec（工具栏 / 快捷键 / 自检脚本统一走这里） */
export function markdownCommandSpec(state: EditorState, id: MarkdownCommandId): TransactionSpec {
  switch (id) {
    case 'bold':
      return inlineWrapSpec(state, '**', '粗体')
    case 'italic':
      return inlineWrapSpec(state, '*', '斜体')
    case 'strikethrough':
      return inlineWrapSpec(state, '~~', '删除线')
    case 'inlineCode':
      return inlineWrapSpec(state, '`', '代码')
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
      return linePrefixSpec(state, id)
    case 'bulletList':
      return linePrefixSpec(state, 'bullet')
    case 'orderedList':
      return linePrefixSpec(state, 'ordered')
    case 'taskList':
      return linePrefixSpec(state, 'task')
    case 'quote':
      return linePrefixSpec(state, 'quote')
    case 'codeBlock':
      return codeBlockSpec(state)
    case 'link':
      return linkSpec(state)
    case 'table':
      return tableSpec(state)
    case 'horizontalRule':
      return horizontalRuleSpec(state)
  }
}

/** 应用命令到 state（纯函数，供自检脚本与「预览态」等无 view 场景使用） */
export function applyMarkdownCommand(state: EditorState, id: MarkdownCommandId): EditorState {
  return state.update(markdownCommandSpec(state, id)).state
}
