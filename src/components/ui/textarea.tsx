/**
 * Textarea —— 多行文本输入（摘要、备注、重命名确认等）。
 * 默认不可手动拉伸（resize-none），需要自适应高度时用 rows 控制。
 */

import type { ComponentProps } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

export const textareaVariants = cva(
  [
    'w-full resize-none rounded-zj-sm border border-border bg-surface px-3 py-2',
    'text-ui text-text placeholder:text-muted',
    'transition-colors duration-150 ease-out',
    'zj-focus-ring',
    'hover:border-accent/50',
    'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted',
    'read-only:bg-surface-2',
    'aria-invalid:border-accent',
  ].join(' '),
  {
    variants: {
      textareaSize: {
        sm: 'min-h-8 text-meta',
        md: 'min-h-16',
        lg: 'min-h-24 text-body',
      },
      /** 无边框样式：用于「整块都是输入区」的场景（t44 快速笔记窗口，语义同 Input 的 bare） */
      bare: {
        true: 'rounded-none border-transparent bg-transparent hover:border-transparent',
        false: '',
      },
    },
    defaultVariants: { textareaSize: 'md', bare: false },
  },
)

export interface TextareaProps
  extends ComponentProps<'textarea'>,
    VariantProps<typeof textareaVariants> {}

export function Textarea({ className, textareaSize, bare, rows = 3, ...props }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      className={cn(textareaVariants({ textareaSize, bare }), className)}
      {...props}
    />
  )
}
