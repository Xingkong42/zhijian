/**
 * 工具栏激活态（光标处是否已处于某种 Markdown 格式）。
 * 归属：编辑器成员（任务 t16）。
 *
 * 与 Live Preview 的分工：本模块只**读** EditorState（语法树 + 行首正则），
 * 不产生任何文档变更；所有「写」都走 markdownCommands.ts。
 */

import { redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { markdownCommandSpec } from './markdownCommands'
import type { MarkdownCommandId } from './markdownCommands'

/** 工具栏关心的状态（行内 + 行级 + 撤销栈） */
export interface MarkdownToolbarState {
  bold: boolean
  italic: boolean
  strikethrough: boolean
  inlineCode: boolean
  h1: boolean
  h2: boolean
  h3: boolean
  h4: boolean
  bulletList: boolean
  orderedList: boolean
  taskList: boolean
  quote: boolean
  canUndo: boolean
  canRedo: boolean
}

export const EMPTY_TOOLBAR_STATE: MarkdownToolbarState = {
  bold: false,
  italic: false,
  strikethrough: false,
  inlineCode: false,
  h1: false,
  h2: false,
  h3: false,
  h4: false,
  bulletList: false,
  orderedList: false,
  taskList: false,
  quote: false,
  canUndo: false,
  canRedo: false,
}

/** 行内标记对应的语法树节点名 */
const INLINE_NODES = {
  bold: ['StrongEmphasis'],
  italic: ['Emphasis'],
  strikethrough: ['Strikethrough'],
  inlineCode: ['InlineCode'],
} as const

/** 从某位置出发向上找，看是否落在给定的语法节点里（两侧都查，兼容光标在标记边缘） */
function insideNode(state: EditorState, names: readonly string[]): boolean {
  const tree = syntaxTree(state)
  const head = state.selection.main.head
  for (const side of [1, -1] as const) {
    let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(head, side)
    while (node) {
      if (names.includes(node.name)) return true
      node = node.parent
    }
  }
  return false
}

/** 计算工具栏激活态（纯读取，无副作用） */
export function computeToolbarState(state: EditorState): MarkdownToolbarState {
  const line = state.doc.lineAt(state.selection.main.head)
  const text = line.text

  const taskList = /^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/.test(text)
  const bulletList = !taskList && /^[ \t]*[-*+][ \t]+/.test(text)
  const orderedList = /^[ \t]*\d{1,9}[.)][ \t]+/.test(text)
  const quote = /^[ \t]*>[ \t]?/.test(text)

  return {
    bold: insideNode(state, INLINE_NODES.bold),
    italic: insideNode(state, INLINE_NODES.italic),
    strikethrough: insideNode(state, INLINE_NODES.strikethrough),
    inlineCode: insideNode(state, INLINE_NODES.inlineCode),
    h1: /^#[ \t]/.test(text),
    h2: /^##(?!#)[ \t]/.test(text),
    h3: /^###(?!#)[ \t]/.test(text),
    h4: /^####(?!#)[ \t]/.test(text),
    bulletList,
    orderedList,
    taskList,
    quote,
    canUndo: undoDepth(state) > 0,
    canRedo: redoDepth(state) > 0,
  }
}

/**
 * 激活态签名：EditorPane 用它决定「是否需要 setState」。
 * 刻意不含 undoDepth 的具体数值 —— 否则每敲一个字都会触发工具栏重渲染。
 */
export function toolbarSignature(state: EditorState): string {
  const info = computeToolbarState(state)
  const flags: (keyof MarkdownToolbarState)[] = [
    'bold',
    'italic',
    'strikethrough',
    'inlineCode',
    'h1',
    'h2',
    'h3',
    'h4',
    'bulletList',
    'orderedList',
    'taskList',
    'quote',
    'canUndo',
    'canRedo',
  ]
  return flags.map((flag) => (info[flag] ? '1' : '0')).join('')
}

/// 工具栏按钮 → 命令 id
export const TOOLBAR_INLINE_COMMANDS: MarkdownCommandId[] = [
  'bold',
  'italic',
  'strikethrough',
  'inlineCode',
]

export const TOOLBAR_BLOCK_COMMANDS: MarkdownCommandId[] = [
  'h1',
  'h2',
  'h3',
  'h4',
  'bulletList',
  'orderedList',
  'taskList',
  'quote',
  'codeBlock',
  'link',
  'table',
  'horizontalRule',
]

export const TOOLBAR_ALL_COMMANDS: MarkdownCommandId[] = [
  ...TOOLBAR_INLINE_COMMANDS,
  ...TOOLBAR_BLOCK_COMMANDS,
]

/* --------------------------- 视图级执行入口 --------------------------- */

/**
 * 把命令派发到 EditorView（视图级入口，与纯函数 `markdownCommands.applyMarkdownCommand`
 * 区分命名，避免调用方混淆）。
 * 这是「工具栏按钮 → 文档变化」的唯一出口；命令本身是纯函数。
 */
export function runMarkdownCommand(view: EditorView, id: MarkdownCommandId): boolean {
  view.dispatch(markdownCommandSpec(view.state, id))
  view.focus()
  return true
}

export function runUndo(view: EditorView): boolean {
  const handled = undo(view)
  view.focus()
  return handled
}

export function runRedo(view: EditorView): boolean {
  const handled = redo(view)
  view.focus()
  return handled
}
