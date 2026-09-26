/**
 * EmptyState —— 空状态（列表为空、搜索无结果、回收站为空）。
 * 归属：设计系统（任务 t2）。
 * docs/DESIGN.md §5：居中、space-8 留白、text-2xl 标题 + text-sm muted 说明 + 一个次要按钮。
 * （窄面板用 size="compact" 降一档字号）
 */

import type { ComponentProps, ReactNode } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ICON_STROKE } from './internal'

export const emptyStateVariants = cva('flex flex-col items-center justify-center text-center', {
  variants: {
    size: {
      default: 'gap-3 p-8',
      compact: 'gap-2 p-6',
    },
  },
  defaultVariants: { size: 'default' },
})

export interface EmptyStateProps
  extends Omit<ComponentProps<'div'>, 'title'>,
    VariantProps<typeof emptyStateVariants> {
  icon?: LucideIcon
  title: ReactNode
  description?: ReactNode
  /** 次要操作（一般给一个 Button variant="outline"） */
  action?: ReactNode
}

export function EmptyState({
  className,
  size = 'default',
  icon: Icon,
  title,
  description,
  action,
  ...props
}: EmptyStateProps) {
  const compact = size === 'compact'
  return (
    <div
      data-empty-state=""
      className={cn(emptyStateVariants({ size }), className)}
      {...props}
    >
      {Icon ? (
        <Icon
          size={compact ? 20 : 24}
          strokeWidth={ICON_STROKE}
          className="text-muted"
          aria-hidden
        />
      ) : null}
      <p
        className={cn(
          'font-medium text-text',
          compact ? 'text-title' : 'text-display',
        )}
      >
        {title}
      </p>
      {description ? (
        <p className={cn('text-muted', compact ? 'text-meta' : 'text-ui', 'max-w-sm')}>
          {description}
        </p>
      ) : null}
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  )
}
