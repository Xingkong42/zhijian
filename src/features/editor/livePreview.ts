/**
 * Live Preview（Markdown 所见即所得，就地渲染）。
 * 归属：编辑器成员（任务 t16）。
 *
 * 原理：ViewPlugin + Decoration —— **只改显示，绝不改文档**。
 *  - 非光标行：隐藏 Markdown 标记符（`**` / `#` / `>` / `- ` …）并给内容套上渲染样式；
 *    列表圆点、序号、任务框、水平线用 Widget 渲染；
 *  - 光标（或选区）所在行：完全不加装饰 → 立即恢复源码，便于精确编辑；
 *  - 代码块（FencedCode / CodeBlock）与 GFM 表格：整段跳过，保留原样；
 *  - **IME 组合期间不重建、不隐藏标记**（见 `livePreview()` 里的说明），
 *    并且组合所在行本来就是「光标行 = 不加装饰」，因此候选框与光标不会被打断。
 *
 * 纯函数部分（`buildLivePreviewDecorations`）只依赖 EditorState + Decoration，
 * 可以在 Node 里直接断言 —— 见 `__checks__/run-checks.mjs`。
 */

import { syntaxTree } from '@codemirror/language'
import type { EditorState, Extension, Range } from '@codemirror/state'
import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view'
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view'

/* ------------------------------ Widgets ------------------------------ */

/** 无序列表圆点 */
class BulletWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'zj-lp-bullet'
    span.textContent = '•'
    span.setAttribute('aria-hidden', 'true')
    return span
  }
  ignoreEvent(): boolean {
    return true
  }
}

/** 有序列表序号（保留原文数字与分隔符：`1.` / `1)`） */
class OrderedWidget extends WidgetType {
  readonly text: string
  constructor(text: string) {
    super()
    this.text = text
  }
  eq(other: OrderedWidget): boolean {
    return other.text === this.text
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'zj-lp-number'
    span.textContent = this.text
    span.setAttribute('aria-hidden', 'true')
    return span
  }
  ignoreEvent(): boolean {
    return true
  }
}

/** 任务列表复选框（只读视觉：勾选状态来自文档 `- [x]`） */
class TaskWidget extends WidgetType {
  readonly checked: boolean
  constructor(checked: boolean) {
    super()
    this.checked = checked
  }
  eq(other: TaskWidget): boolean {
    return other.checked === this.checked
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'zj-lp-checkbox'
    span.dataset['checked'] = this.checked ? 'true' : 'false'
    // 勾选记号用文字字形，不引入图片资源，也不写字面色值（颜色全部来自 token）
    span.textContent = this.checked ? '✓' : ''
    span.setAttribute('aria-hidden', 'true')
    return span
  }
  ignoreEvent(): boolean {
    return true
  }
}

/** 水平线 */
class RuleWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'zj-lp-hr'
    span.setAttribute('aria-hidden', 'true')
    return span
  }
  ignoreEvent(): boolean {
    return true
  }
}

const BULLET = new BulletWidget()
const RULE = new RuleWidget()

/* ------------------------------ 行解析 ------------------------------ */

interface HideRange {
  from: number
  to: number
}
interface WidgetRange extends HideRange {
  widget: WidgetType
}
interface MarkRange extends HideRange {
  className: string
}

export interface LineRender {
  /** 行级样式类（如 zj-lp-h1 / zj-lp-quote） */
  lineClass: string | null
  /** 与行首的偏移区间 */
  hide: HideRange[]
  widgets: WidgetRange[]
  marks: MarkRange[]
}

/** 行首块级标记 */
const HEADING = /^(#{1,6})[ \t]+/
const QUOTE = /^((?:>[ \t]?)+)/
const TASK = /^([ \t]*[-*+][ \t]+\[)([ xX])(\][ \t]+)/
const BULLET_LINE = /^([ \t]*)([-*+])([ \t]+)/
const ORDERED_LINE = /^([ \t]*)(\d{1,9})([.)])([ \t]+)/
const RULE_LINE = /^[ \t]{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/

/**
 * 行内语法（单个正则，按优先级排列：代码 → 加粗 → 删除线 → 斜体 → 链接）。
 * 用捕获组的下标定位，不使用 `d` 标志（避免打包目标不支持）。
 */
const INLINE =
  /(`+)([^`\n]+?)\1|(\*\*|__)([\s\S]*?\S)\3|(~~)([\s\S]*?\S)\5|(\*|_)([^*_\n]+?)\7|(\[)([^\]\n]*)(\]\()([^)\s]*)(\))/g

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch)
}

/**
 * 解析一行 Markdown，返回「要隐藏的标记 / 要替换的 widget / 要套样式的文本」。
 * 纯函数：不接触 DOM，便于单测。
 */
export function parseLineRender(text: string): LineRender {
  const render: LineRender = { lineClass: null, hide: [], widgets: [], marks: [] }
  if (text.length === 0) return render

  // 1) 水平线：整行替换为一条线
  if (RULE_LINE.test(text)) {
    render.widgets.push({ from: 0, to: text.length, widget: RULE })
    render.lineClass = 'zj-lp-hr-line'
    return render
  }

  let contentStart = 0

  // 2) 任务列表优先于普通无序列表
  const task = TASK.exec(text)
  if (task) {
    const checked = task[2] !== ' '
    render.widgets.push({ from: 0, to: task[0].length, widget: new TaskWidget(checked) })
    render.lineClass = 'zj-lp-task'
    contentStart = task[0].length
  } else {
    const bullet = BULLET_LINE.exec(text)
    const ordered = ORDERED_LINE.exec(text)
    if (bullet) {
      render.widgets.push({ from: 0, to: bullet[0].length, widget: BULLET })
      render.lineClass = 'zj-lp-list'
      contentStart = bullet[0].length
    } else if (ordered) {
      render.widgets.push({
        from: 0,
        to: ordered[0].length,
        widget: new OrderedWidget(`${ordered[2]}${ordered[3]}`),
      })
      render.lineClass = 'zj-lp-list'
      contentStart = ordered[0].length
    } else {
      const heading = HEADING.exec(text)
      const quote = QUOTE.exec(text)
      if (heading) {
        render.hide.push({ from: 0, to: heading[0].length })
        render.lineClass = `zj-lp-h${Math.min(heading[1].length, 6)}`
        contentStart = heading[0].length
      } else if (quote) {
        render.hide.push({ from: 0, to: quote[0].length })
        render.lineClass = 'zj-lp-quote'
        contentStart = quote[0].length
      }
    }
  }

  // 3) 行内样式（只解析正文区，避开行首标记）
  const body = text.slice(contentStart)
  INLINE.lastIndex = 0
  for (const match of body.matchAll(INLINE)) {
    const index = match.index ?? 0
    const start = contentStart + index
    const end = start + match[0].length

    if (match[1] !== undefined) {
      // 行内代码：隐藏两侧反引号
      const ticks = match[1].length
      render.hide.push({ from: start, to: start + ticks }, { from: end - ticks, to: end })
      render.marks.push({ from: start + ticks, to: end - ticks, className: 'zj-lp-code' })
      continue
    }
    if (match[3] !== undefined) {
      const mark = match[3].length
      render.hide.push({ from: start, to: start + mark }, { from: end - mark, to: end })
      render.marks.push({ from: start + mark, to: end - mark, className: 'zj-lp-strong' })
      continue
    }
    if (match[5] !== undefined) {
      render.hide.push({ from: start, to: start + 2 }, { from: end - 2, to: end })
      render.marks.push({ from: start + 2, to: end - 2, className: 'zj-lp-strike' })
      continue
    }
    if (match[7] !== undefined) {
      // 斜体：`_` 出现在单词内部时（snake_case）不当作斜体
      if (match[7] === '_' && isWordChar(text[start - 1])) continue
      render.hide.push({ from: start, to: start + 1 }, { from: end - 1, to: end })
      render.marks.push({ from: start + 1, to: end - 1, className: 'zj-lp-em' })
      continue
    }
    if (match[9] !== undefined) {
      // 链接：只显示「文字」，url 弱化显示（accent + 弱化小字）
      const labelFrom = start + 1
      const labelTo = labelFrom + (match[10] ?? '').length
      const urlFrom = labelTo + 2
      const urlTo = urlFrom + (match[12] ?? '').length
      render.hide.push({ from: start, to: labelFrom }, { from: labelTo, to: urlFrom }, { from: urlTo, to: end })
      render.marks.push({ from: labelFrom, to: labelTo, className: 'zj-lp-link' })
      if (urlTo > urlFrom) render.marks.push({ from: urlFrom, to: urlTo, className: 'zj-lp-url' })
      continue
    }
  }

  return render
}

/* ------------------------------ 装饰构建 ------------------------------ */

interface Position {
  from: number
  to: number
}

/** 代码块与表格整段跳过（保留原样，不做块级渲染） */
function collectSkipRanges(state: EditorState, ranges: readonly Position[]): Position[] {
  const skip: Position[] = []
  const tree = syntaxTree(state)
  for (const range of ranges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        const name = node.name
        if (name === 'FencedCode' || name === 'CodeBlock' || name.startsWith('Table')) {
          skip.push({ from: node.from, to: node.to })
          return false
        }
        return undefined
      },
    })
  }
  return skip
}

/** 光标/选区所在行（这些行显示源码） */
function collectActiveLines(state: EditorState): Set<number> {
  const lines = new Set<number>()
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(Math.min(range.from, range.to)).number
    const last = state.doc.lineAt(Math.max(range.from, range.to)).number
    for (let number = first; number <= last; number++) lines.add(number)
  }
  lines.add(state.doc.lineAt(state.selection.main.head).number)
  return lines
}

function intersects(ranges: readonly Position[], from: number, to: number): boolean {
  return ranges.some((range) => from < range.to && to > range.from)
}

const HIDDEN = Decoration.replace({})
const markInstanceCache = new Map<string, Decoration>()
const lineClassCache = new Map<string, Decoration>()

function markFor(className: string): Decoration {
  let mark = markInstanceCache.get(className)
  if (!mark) {
    mark = Decoration.mark({ class: className })
    markInstanceCache.set(className, mark)
  }
  return mark
}

function lineClassFor(className: string): Decoration {
  let decoration = lineClassCache.get(className)
  if (!decoration) {
    decoration = Decoration.line({ class: className })
    lineClassCache.set(className, decoration)
  }
  return decoration
}

export interface LivePreviewBuildOptions {
  /**
   * false → 只套样式、**不隐藏任何标记**（IME 组合期间使用的安全路径）。
   * @default true
   */
  hideMarkers?: boolean
}

/**
 * 构建 Live Preview 装饰集（纯函数：给定 state + 视口区间即得结果）。
 *
 * 不变式（自检脚本会断言）：
 *  1. 光标/选区所在行没有任何装饰；
 *  2. 代码块与表格所在行没有任何装饰；
 *  3. `hideMarkers: false` 时结果里 **不含任何 replace 装饰**（IME 安全）；
 *  4. 装饰只描述「怎么显示」，不产生任何文档变更。
 */
export function buildLivePreviewDecorations(
  state: EditorState,
  ranges: readonly Position[],
  options: LivePreviewBuildOptions = {},
): DecorationSet {
  const hideMarkers = options.hideMarkers !== false
  const entries: Range<Decoration>[] = []

  const skipRanges = collectSkipRanges(state, ranges)
  const activeLines = collectActiveLines(state)

  for (const range of ranges) {
    const first = state.doc.lineAt(Math.max(0, Math.min(range.from, state.doc.length))).number
    const last = state.doc.lineAt(Math.max(0, Math.min(range.to, state.doc.length))).number
    for (let number = first; number <= last; number++) {
      const line = state.doc.line(number)
      if (activeLines.has(number)) continue
      if (intersects(skipRanges, line.from, line.to)) continue

      const render = parseLineRender(line.text)
      if (render.lineClass) entries.push(lineClassFor(render.lineClass).range(line.from))
      for (const mark of render.marks) {
        if (mark.to <= mark.from) continue
        entries.push(markFor(mark.className).range(line.from + mark.from, line.from + mark.to))
      }
      if (!hideMarkers) continue
      for (const hidden of render.hide) {
        if (hidden.to <= hidden.from) continue
        entries.push(HIDDEN.range(line.from + hidden.from, line.from + hidden.to))
      }
      for (const widget of render.widgets) {
        if (widget.to <= widget.from) continue
        entries.push(
          Decoration.replace({ widget: widget.widget }).range(
            line.from + widget.from,
            line.from + widget.to,
          ),
        )
      }
    }
  }

  return Decoration.set(entries, true)
}

/** 装饰统计（自检脚本用它断言「组合期间不含任何隐藏类装饰」等不变式） */
export interface DecorationStats {
  total: number
  /** 隐藏 / 替换类装饰（replace，含 widget 替换）—— IME 组合期间必须为 0 */
  replaces: number
  /** 纯样式 mark 装饰 */
  marks: number
}

/** 一条装饰的位置与类型（自检脚本用） */
export interface DecorationEntry {
  from: number
  to: number
  /** 隐藏/替换类（会改变 DOM 呈现的字符序列） */
  replaceLike: boolean
}

/**
 * 判断是不是「隐藏/替换」类装饰。
 * CodeMirror 的公开类型没有暴露 isReplace，但 Decoration.replace() 会构造出
 * isReplace=true 的 PointDecoration（见 @codemirror/view 的实现），据此区分。
 */
function isReplaceLike(decoration: Decoration): boolean {
  return (decoration as unknown as { isReplace?: boolean }).isReplace === true
}

export function listDecorations(set: DecorationSet, docLength: number): DecorationEntry[] {
  const entries: DecorationEntry[] = []
  set.between(0, Math.max(docLength, 1), (from, to, value) => {
    entries.push({ from, to, replaceLike: isReplaceLike(value) })
  })
  return entries
}

export function describeDecorations(set: DecorationSet, docLength: number): DecorationStats {
  const stats: DecorationStats = { total: 0, replaces: 0, marks: 0 }
  for (const entry of listDecorations(set, docLength)) {
    stats.total++
    if (entry.replaceLike) stats.replaces++
    else stats.marks++
  }
  return stats
}

/** 统计指定区间内的装饰条数（用于「光标行/代码块行必须为 0」这类断言） */
export function countDecorationsIn(set: DecorationSet, from: number, to: number): number {
  return listDecorations(set, Math.max(to, 1)).filter((entry) => entry.from >= from && entry.from <= to)
    .length
}

/* ------------------------------ 插件 ------------------------------ */

/** IME 组合中？用 compositionStarted（>= 0）而不是 composing（> 0），保险起见宁可早一点停手 */
function isComposing(view: EditorView): boolean {
  return view.compositionStarted
}

/**
 * Live Preview 重建次数（诊断用）。
 * 自检脚本用它证明「IME 组合期间**没有**重建装饰」——组合中只把已有装饰随
 * 文档变化平移（`.map(update.changes)`），组合结束才重建一次。
 */
let livePreviewBuilds = 0

export function livePreviewBuildCount(): number {
  return livePreviewBuilds
}

class LivePreviewPlugin {
  decorations: DecorationSet

  private readonly view: EditorView
  private composing: boolean
  private destroyed = false
  private readonly onCompositionEnd: () => void

  constructor(view: EditorView) {
    this.view = view
    this.composing = isComposing(view)
    this.decorations = this.build(view)
    // compositionend 不一定伴随文档变化（例如 Esc 取消组合）：兜底重算一次
    this.onCompositionEnd = () => {
      window.setTimeout(() => {
        if (this.destroyed || isComposing(this.view)) return
        this.composing = false
        this.decorations = this.build(this.view)
        this.view.dispatch({})
      }, 0)
    }
    view.contentDOM.addEventListener('compositionend', this.onCompositionEnd)
  }

  update(update: ViewUpdate) {
    if (isComposing(update.view)) {
      // ⚠️ IME 组合期间：不重建、不隐藏标记。
      // 光标行本来就是「显示源码」，因此这里只要把已有装饰随文档变化平移即可。
      this.composing = true
      if (update.docChanged) this.decorations = this.decorations.map(update.changes)
      return
    }
    if (this.composing) {
      this.composing = false
      this.decorations = this.build(update.view)
      return
    }
    if (
      update.docChanged ||
      update.viewportChanged ||
      update.selectionSet ||
      syntaxTree(update.startState) !== syntaxTree(update.state)
    ) {
      this.decorations = this.build(update.view)
    }
  }

  destroy() {
    this.destroyed = true
    this.view.contentDOM.removeEventListener('compositionend', this.onCompositionEnd)
  }

  private build(view: EditorView): DecorationSet {
    livePreviewBuilds++
    return buildLivePreviewDecorations(view.state, view.visibleRanges)
  }
}

/** Live Preview 扩展：装配进 CodeMirrorEditor 的扩展列表即可 */
export function livePreview(): Extension {
  return ViewPlugin.fromClass(LivePreviewPlugin, {
    decorations: (plugin) => plugin.decorations,
  })
}
