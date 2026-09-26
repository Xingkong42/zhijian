/**
 * Badge / Kbd —— 计数徽标与快捷键提示。
 * 胶囊形（rounded-full）只允许出现在计数徽标与滚动条上（docs/DESIGN.md §3）。
 */

import type { ComponentProps } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

export const badgeVariants = cva(
  'inline-flex select-none items-center gap-1 rounded-zj-sm border border-transparent font-medium',
  {
    variants: {
      variant: {
        /** 标签 / 元信息：浅选中底色 */
        default: 'bg-selection text-text',
        /** 更弱：次级面板底色 + muted 文字 */
        muted: 'bg-surface-2 text-muted',
        /** 纯描边 */
        outline: 'border-border text-muted',
        /** 强调（当前主题 / 选中标签） */
        accent: 'bg-accent text-accent-fg',
      },
      size: {
        sm: 'h-4 px-1 text-2xs',
        md: 'h-5 px-2 text-meta',
        /** 侧边栏计数：胶囊 + 等宽数字 */
        count: 'h-4 min-w-4 justify-center rounded-full bg-surface-2 px-1 font-mono text-2xs text-muted',
      },
    },
    defaultVariants: { variant: 'default', size: 'sm' },
  },
)

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>

export function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, size }), className)} {...props} />
}

export type KbdProps = ComponentProps<'kbd'>

/** 快捷键展示：`<Kbd>Ctrl</Kbd><Kbd>K</Kbd>` */
export function Kbd({ className, ...props }: KbdProps) {
  return (
    <kbd
      className={cn(
        'inline-flex h-4 select-none items-center rounded-zj-sm border border-border bg-surface-2 px-1',
        'font-mono text-2xs text-muted',
        className,
      )}
      {...props}
    />
  )
}
