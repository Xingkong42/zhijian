/**
 * MarkdownToolbar —— 一行图标按钮的 Markdown 格式化工具栏（任务 t16）。
 * 归属：编辑器成员。
 *
 *  · 点击 = 对当前选区 / 光标所在行应用 Markdown 语法（命令实现在 markdownCommands.ts，
 *    纯函数、可被 __checks__/run-checks.mjs 断言）；
 *  · aria-pressed 反映「光标处是否已处于该格式」，active 时高亮（token 类，无硬编码色值）；
 *  · 图标全部来自 lucide-react，尺寸沿用设计刻度（15px / 1.75）。
 */

import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Redo2,
  SquareCode,
  Strikethrough,
  Table2,
  Undo2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { IconButton, Separator } from '@/components/ui'
import { cn } from '@/lib/utils'
import { MARKDOWN_COMMANDS } from './markdownCommands'
import type { MarkdownCommandId } from './markdownCommands'
import type { MarkdownToolbarState } from './markdownToolbarState'

export interface MarkdownToolbarProps {
  /** 光标处激活态（由 EditorPane 依据 EditorView 计算） */
  state: MarkdownToolbarState
  /** 视图未就绪时禁用全部按钮 */
  disabled?: boolean
  onCommand: (id: MarkdownCommandId) => void
  onUndo: () => void
  onRedo: () => void
  className?: string
}

interface ToolbarButton {
  id: MarkdownCommandId
  icon: LucideIcon
  /** 激活态取自哪里；不填 = 该按钮没有「已激活」语义（代码块/链接/表格/分隔线） */
  activeKey?: keyof MarkdownToolbarState
}

const INLINE_BUTTONS: ToolbarButton[] = [
  { id: 'bold', icon: Bold, activeKey: 'bold' },
  { id: 'italic', icon: Italic, activeKey: 'italic' },
  { id: 'strikethrough', icon: Strikethrough, activeKey: 'strikethrough' },
  { id: 'inlineCode', icon: Code, activeKey: 'inlineCode' },
]

const HEADING_BUTTONS: ToolbarButton[] = [
  { id: 'h1', icon: Heading1, activeKey: 'h1' },
  { id: 'h2', icon: Heading2, activeKey: 'h2' },
  { id: 'h3', icon: Heading3, activeKey: 'h3' },
  { id: 'h4', icon: Heading4, activeKey: 'h4' },
]

const LIST_BUTTONS: ToolbarButton[] = [
  { id: 'bulletList', icon: List, activeKey: 'bulletList' },
  { id: 'orderedList', icon: ListOrdered, activeKey: 'orderedList' },
  { id: 'taskList', icon: ListTodo, activeKey: 'taskList' },
  { id: 'quote', icon: Quote, activeKey: 'quote' },
]

const BLOCK_BUTTONS: ToolbarButton[] = [
  { id: 'codeBlock', icon: SquareCode },
  { id: 'link', icon: Link },
  { id: 'table', icon: Table2 },
  { id: 'horizontalRule', icon: Minus },
]

function ToolbarGroup({
  buttons,
  state,
  disabled,
  onCommand,
}: {
  buttons: ToolbarButton[]
  state: MarkdownToolbarState
  disabled: boolean
  onCommand: (id: MarkdownCommandId) => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {buttons.map(({ id, icon, activeKey }) => {
        const active = activeKey ? state[activeKey] : undefined
        const meta = MARKDOWN_COMMANDS[id]
        return (
          <IconButton
            key={id}
            icon={icon}
            label={meta.tooltip}
            tooltip
            size="icon"
            variant="ghost"
            disabled={disabled}
            aria-pressed={active}
            data-active={active ? 'true' : undefined}
            data-zj-toolbar-command={id}
            onClick={() => onCommand(id)}
          />
        )
      })}
    </div>
  )
}

export function MarkdownToolbar({
  state,
  disabled = false,
  onCommand,
  onUndo,
  onRedo,
  className,
}: MarkdownToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Markdown 格式"
      aria-orientation="horizontal"
      data-zj-toolbar=""
      className={cn(
        'flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-surface px-3',
        className,
      )}
    >
      <ToolbarGroup buttons={INLINE_BUTTONS} state={state} disabled={disabled} onCommand={onCommand} />
      <Separator orientation="vertical" className="mx-1 h-4" />
      <ToolbarGroup
        buttons={HEADING_BUTTONS}
        state={state}
        disabled={disabled}
        onCommand={onCommand}
      />
      <Separator orientation="vertical" className="mx-1 h-4" />
      <ToolbarGroup buttons={LIST_BUTTONS} state={state} disabled={disabled} onCommand={onCommand} />
      <Separator orientation="vertical" className="mx-1 h-4" />
      <ToolbarGroup buttons={BLOCK_BUTTONS} state={state} disabled={disabled} onCommand={onCommand} />
      <Separator orientation="vertical" className="mx-1 h-4" />

      <div className="flex shrink-0 items-center gap-1">
        <IconButton
          icon={Undo2}
          label="撤销 (Ctrl+Z)"
          tooltip
          size="icon"
          variant="ghost"
          disabled={disabled || !state.canUndo}
          data-zj-toolbar-command="undo"
          onClick={onUndo}
        />
        <IconButton
          icon={Redo2}
          label="重做 (Ctrl+Shift+Z)"
          tooltip
          size="icon"
          variant="ghost"
          disabled={disabled || !state.canRedo}
          data-zj-toolbar-command="redo"
          onClick={onRedo}
        />
      </div>
    </div>
  )
}
