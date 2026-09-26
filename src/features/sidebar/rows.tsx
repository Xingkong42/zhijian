/**
 * 侧栏行 / 分组标题的共享视觉件（Sidebar / FolderTree / TagList 复用，避免三处各写一遍类名）。
 * 归属：src/features/sidebar/**（t5）。
 *
 * 视觉规范（docs/DESIGN.md §5）：选中 `--zj-selection`、悬停 `--zj-hover`、
 * 行高 32px（导航行）/ 28px（树行）、无边框无阴影、圆角 6px。
 * 颜色只经 token 语义类；缩进用 12px 步进（间距刻度内）。
 */

import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ChevronRight } from 'lucide-react'
import { Badge, ICON_SIZE, ICON_STROKE } from '@/components/ui'
import { cn } from '@/lib/utils'

/** 导航行的类名（Sidebar / FolderTree / TagList 统一） */
export function navRowClass(active: boolean, extra?: string): string {
  return cn(
    'flex w-full select-none items-center gap-2 rounded-zj-sm pr-2 text-ui',
    'transition-colors duration-150 ease-out zj-focus-ring',
    active ? 'bg-selection text-text' : 'text-muted hover:bg-hover hover:text-text',
    extra,
  )
}

/** 树形缩进：每层 12px，基础 8px（4/8/12/16/24/32 刻度内） */
export function indentStyle(depth: number): { paddingLeft: number } {
  return { paddingLeft: 8 + depth * 12 }
}

export interface NavRowProps {
  icon?: LucideIcon
  /** 行首自定义内容（如文件夹展开箭头），会占据图标之前的位置 */
  leading?: ReactNode
  label: ReactNode
  /** 计数徽标；不传则不渲染 */
  count?: number
  active?: boolean
  onClick?: () => void
  /** 行尾自定义内容（覆盖默认计数徽标） */
  trailing?: ReactNode
  /** 树深度（缩进层数） */
  depth?: number
  /** 附加类名 */
  className?: string
  /** 行高：导航 32px / 树行 28px */
  dense?: boolean
  /** 无障碍名称（标签被截断时可补充说明） */
  title?: string
  /**
   * t44：禁用该行（进行中的长操作 —— 例如正在导入笔记 —— 期间不允许再次触发）。
   * 刻意用原生 `disabled` 而不是只改样式：只改样式的话键盘仍能激活，
   * 于是"看起来不能点"却真的又发起了一次导入。
   */
  disabled?: boolean
}

export function NavRow({
  icon: Icon,
  leading,
  label,
  count,
  active = false,
  onClick,
  trailing,
  depth = 0,
  className,
  dense = false,
  title,
  disabled = false,
}: NavRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      aria-current={active ? 'true' : undefined}
      style={indentStyle(depth)}
      className={navRowClass(
        active,
        cn(
          dense ? 'h-7' : 'h-8',
          disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted',
          className,
        ),
      )}
    >
      {leading}
      {Icon ? (
        <Icon
          size={ICON_SIZE}
          strokeWidth={ICON_STROKE}
          aria-hidden
          className={cn('shrink-0', active ? 'text-accent' : 'text-muted')}
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {trailing ?? (count === undefined ? null : <Badge size="count">{count}</Badge>)}
    </button>
  )
}

export interface TreeRowProps {
  depth: number
  icon: LucideIcon
  label: ReactNode
  count?: number
  active?: boolean
  hasChildren?: boolean
  expanded?: boolean
  onSelect: () => void
  onToggle?: () => void
  /** 行尾附加内容（覆盖默认计数徽标） */
  trailing?: ReactNode
}

/**
 * 树行视觉件（文件夹树）。
 * 结构与 a11y：外层由调用方提供 `role="treeitem"`（含 aria-expanded / aria-selected），
 * 本组件只渲染「展开箭头按钮 + 名称按钮」两个并列的可点区域 —— 避免按钮嵌套按钮的非法结构。
 */
export function TreeRow({
  depth,
  icon: Icon,
  label,
  count,
  active = false,
  hasChildren = false,
  expanded = false,
  onSelect,
  onToggle,
  trailing,
}: TreeRowProps) {
  return (
    <div
      style={indentStyle(depth)}
      className={cn(
        'flex h-7 w-full items-center gap-1 rounded-zj-sm pr-2',
        'transition-colors duration-150 ease-out',
        active ? 'bg-selection text-text' : 'text-muted hover:bg-hover hover:text-text',
      )}
    >
      {hasChildren ? (
        <button
          type="button"
          aria-label={expanded ? '折叠子文件夹' : '展开子文件夹'}
          onClick={onToggle}
          className={cn(
            'grid h-5 w-5 shrink-0 place-items-center rounded-zj-sm',
            'transition-colors duration-150 ease-out hover:bg-hover hover:text-text zj-focus-ring',
          )}
        >
          <ChevronRight
            size={13}
            strokeWidth={ICON_STROKE}
            aria-hidden
            className={cn('transition-transform duration-150 ease-out', expanded && 'rotate-90')}
          />
        </button>
      ) : (
        <span className="grid h-5 w-5 shrink-0 place-items-center" aria-hidden />
      )}

      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-zj-sm text-left zj-focus-ring"
      >
        <Icon
          size={ICON_SIZE}
          strokeWidth={ICON_STROKE}
          aria-hidden
          className={cn('shrink-0', active ? 'text-accent' : 'text-muted')}
        />
        <span className="min-w-0 flex-1 truncate text-ui">{label}</span>
        {trailing ?? (count === undefined ? null : <Badge size="count">{count}</Badge>)}
      </button>
    </div>
  )
}

export interface SidebarGroupProps {
  label: string
  /** 分组右侧的操作按钮（新建文件夹 / 新建标签） */
  action?: ReactNode
}

/** 分组标题（12px muted，右侧可放一个图标按钮） */
export function SidebarGroup({ label, action }: SidebarGroupProps) {
  return (
    <div className="flex items-center gap-1 px-2 pb-1 pt-3">
      <span className="min-w-0 flex-1 truncate text-2xs font-medium tracking-wide text-muted">
        {label}
      </span>
      {action}
    </div>
  )
}
