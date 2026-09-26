/**
 * ScrollArea —— 细滚动条容器（滚动条配色跟随主题 token，见 src/index.css）。
 * 只负责滚动与留白，不做阴影/圆角装饰。
 */

import type { ComponentProps } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

export const scrollAreaVariants = cva('zj-scroll min-h-0', {
  variants: {
    orientation: {
      vertical: 'overflow-x-hidden overflow-y-auto',
      horizontal: 'overflow-x-auto overflow-y-hidden',
      both: 'overflow-auto',
    },
    padding: {
      none: '',
      sm: 'p-2',
      md: 'p-3',
      lg: 'p-4',
    },
  },
  defaultVariants: { orientation: 'vertical', padding: 'none' },
})

export interface ScrollAreaProps
  extends ComponentProps<'div'>,
    VariantProps<typeof scrollAreaVariants> {}

export function ScrollArea({ className, orientation, padding, ...props }: ScrollAreaProps) {
  return <div className={cn(scrollAreaVariants({ orientation, padding }), className)} {...props} />
}
