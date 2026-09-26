/**
 * Separator —— 1px 分隔线（层级靠边框，不靠色块，见 docs/DESIGN.md §1）。
 */

import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export interface SeparatorProps extends ComponentProps<'div'> {
  orientation?: 'horizontal' | 'vertical'
}

export function Separator({
  className,
  orientation = 'horizontal',
  ...props
}: SeparatorProps) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  )
}
