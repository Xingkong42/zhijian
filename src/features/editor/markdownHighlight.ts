/**
 * Markdown 语法着色（CodeMirror 6 自定义装饰插件）。
 * 归属：编辑器成员（任务 t4）。
 *
 * 为什么不用 @codemirror/language 的 HighlightStyle？
 *   1) 那套 API 需要 `@lezer/highlight` 的 `tags`，而它并不在本项目的依赖清单里
 *      （pnpm 严格隔离，从 src/ 无法解析 `@lezer/highlight`），加依赖又要动
 *      架构师的 package.json；
 *   2) 即使能拿到 tags，HighlightStyle 的色值也必须硬编码十六进制字面量，与
 *      docs/DESIGN.md「颜色只能来自 --zj-* token」直接冲突。
 * 因此这里直接在语法树上按「节点名 → CSS 类名」打标记，类名对应的样式全部写在
 * editorTheme.ts 并用 CSS 变量取值 —— 切主题零重建、零重算。
 *
 * 节点名来自 @codemirror/lang-markdown 使用的 @lezer/markdown 语法
 * （CommonMark + GFM：表格 / 任务列表 / 删除线）。
 */

import { syntaxTree } from '@codemirror/language'
import type { Extension, Range } from '@codemirror/state'
import { Decoration, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view'

/** 语法标记类名前缀（样式见 editorTheme.ts） */
export const MD_CLASS_PREFIX = 'zj-md-'

/**
 * 语法节点名 → 标记类名。
 * 返回 null 表示该节点不着色（Document / Paragraph / ListItem 等容器节点）。
 */
export function markdownClassForNode(name: string): string | null {
  switch (name) {
    /* ---- 行内 ---- */
    case 'Emphasis':
      return 'zj-md-em'
    case 'StrongEmphasis':
      return 'zj-md-strong'
    case 'Strikethrough':
      return 'zj-md-strike'
    case 'InlineCode':
      return 'zj-md-inline-code'
    case 'CodeText':
      return 'zj-md-code-text'
    case 'CodeMark':
    case 'LinkMark':
    case 'Escape':
    case 'Entity':
    case 'HardBreak':
    case 'TableDelimiter':
      return 'zj-md-punct'
    case 'CodeInfo':
      return 'zj-md-code-info'

    /* ---- 链接 / 图片 ---- */
    case 'Link':
    case 'Image':
      return 'zj-md-link'
    case 'URL':
    case 'LinkTitle':
      return 'zj-md-url'

    /* ---- 块级 ---- */
    case 'Blockquote':
      return 'zj-md-quote'
    case 'QuoteMark':
      return 'zj-md-quote-mark'
    case 'ListMark':
      return 'zj-md-list-mark'
    case 'HeaderMark':
      return 'zj-md-heading-mark'
    case 'HorizontalRule':
      return 'zj-md-rule'
    case 'FencedCode':
    case 'CodeBlock':
      return 'zj-md-fenced'

    /* ---- GFM ---- */
    case 'Task':
    case 'TaskMarker':
      return 'zj-md-task'
    default:
      break
  }

  if (name.startsWith('ATXHeading') || name.startsWith('SetextHeading')) return 'zj-md-heading'
  if (name.startsWith('TableCell')) return 'zj-md-table-cell'
  return null
}

/** 每个类名只创建一个 Decoration（Decoration.mark 不可变，可安全复用） */
const markCache = new Map<string, Decoration>()
function markFor(className: string): Decoration {
  let mark = markCache.get(className)
  if (!mark) {
    mark = Decoration.mark({ class: className })
    markCache.set(className, mark)
  }
  return mark
}

/** 只遍历视口内的语法树（与官方高亮器同策略，大文档不做全量装饰） */
function buildDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const tree = syntaxTree(view.state)
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.to <= node.from) return
        const className = markdownClassForNode(node.name)
        if (!className) return
        ranges.push(markFor(className).range(node.from, node.to))
      },
    })
  }
  return Decoration.set(ranges, true)
}

class MarkdownHighlightPlugin {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = buildDecorations(view)
  }

  update(update: ViewUpdate) {
    // 语法树是后台增量解析的：解析推进（startState 的树与当前树不同）时也要重算
    if (
      update.docChanged ||
      update.viewportChanged ||
      syntaxTree(update.startState) !== syntaxTree(update.state)
    ) {
      this.decorations = buildDecorations(update.view)
    }
  }
}

/**
 * markdown 语法着色扩展。默认不需要任何参数：
 * 所有样式来自 editorTheme.ts 中的 CSS 变量，切主题无需重建 EditorView。
 */
export function markdownHighlight(): Extension {
  return ViewPlugin.fromClass(MarkdownHighlightPlugin, {
    decorations: (plugin) => plugin.decorations,
  })
}
