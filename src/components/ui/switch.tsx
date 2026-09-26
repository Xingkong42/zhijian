/**
 * Switch —— 开关（设置面板：关闭即隐藏到托盘、预览跟随滚动等）。
 * 轨道颜色随状态变化，滑块用 flex 对齐而不是位移动画（docs/DESIGN.md §1.5 禁止位移式动画）。
 */

import type { ComponentProps } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import { useControllableState } from './internal'

export const switchVariants = cva(
  [
    'relative inline-flex shrink-0 items-center rounded-full p-0.5',
    /* p-0.5（2px）是控件内部几何（滑块与轨道的间隙），不是布局间距刻度 */
    'transition-colors duration-150 ease-out',
    'zj-focus-ring',
    'disabled:pointer-events-none disabled:opacity-45',
  ].join(' '),
  {
    variants: {
      size: {
        sm: 'h-4 w-7',
        md: 'h-5 w-9',
      },
      state: {
        off: 'justify-start bg-border hover:bg-selection',
        on: 'justify-end bg-accent hover:bg-accent/85',
      },
    },
    defaultVariants: { size: 'md', state: 'off' },
  },
)

export const switchThumbVariants = cva('rounded-full bg-surface shadow-zj', {
  variants: {
    size: {
      sm: 'h-3 w-3',
      md: 'h-4 w-4',
    },
  },
  defaultVariants: { size: 'md' },
})

export interface SwitchProps
  extends Omit<ComponentProps<'button'>, 'onChange' | 'children' | 'value' | 'defaultValue'>,
    VariantProps<typeof switchVariants> {
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  /** 无障碍名称（控件本身不渲染文字，文字由外层 label 提供） */
  label?: string
}

export function Switch({
  className,
  size = 'md',
  checked,
  defaultChecked = false,
  onCheckedChange,
  label,
  type = 'button',
  disabled,
  onClick,
  ...props
}: SwitchProps) {
  const [isChecked, setChecked] = useControllableState<boolean>({
    value: checked,
    defaultValue: defaultChecked,
    onChange: onCheckedChange,
  })

  return (
    <button
      type={type}
      role="switch"
      aria-checked={isChecked}
      aria-label={label}
      data-state={isChecked ? 'checked' : 'unchecked'}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        setChecked(!isChecked)
      }}
      className={cn(switchVariants({ size, state: isChecked ? 'on' : 'off' }), className)}
      {...props}
    >
      <span className={cn(switchThumbVariants({ size }))} aria-hidden />
    </button>
  )
}
