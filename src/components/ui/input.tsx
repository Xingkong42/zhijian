/**
 * Input —— 单行文本输入（搜索框、重命名、标签名…）。
 * 状态：hover 边框微亮 · focus-visible 淡雅 ring · disabled 降低不透明度 · read-only 变浅底。
 */

import type { ComponentProps } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

export const inputVariants = cva(
  [
    'w-full rounded-zj-sm border border-border bg-surface text-text',
    'placeholder:text-muted',
    'transition-colors duration-150 ease-out',
    'zj-focus-ring',
    'hover:border-accent/50',
    'disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-2 disabled:text-muted',
    'read-only:bg-surface-2',
    'aria-invalid:border-accent',
  ].join(' '),
  {
    variants: {
      inputSize: {
        sm: 'h-7 px-2 text-meta',
        md: 'h-8 px-3 text-ui',
        lg: 'h-9 px-3 text-body',
      },
      /** 无边框样式：用于面板内联编辑（仍保留 focus 反馈） */
      bare: {
        true: 'border-transparent bg-transparent hover:border-border',
        false: '',
      },
    },
    defaultVariants: { inputSize: 'md', bare: false },
  },
)

export interface InputProps extends ComponentProps<'input'>, VariantProps<typeof inputVariants> {}

export function Input({ className, inputSize, bare, type = 'text', ...props }: InputProps) {
  return (
    <input
      type={type}
      className={cn(inputVariants({ inputSize, bare }), className)}
      {...props}
    />
  )
}
