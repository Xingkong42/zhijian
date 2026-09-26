/**
 * Button / IconButton —— 设计系统基础按钮。
 * 归属：设计系统（任务 t2）。纯展示件：不 import src/store、src/db。
 *
 * 变体只用 token 派生类（bg-accent / bg-hover / bg-selection / border-border …），
 * 无任何 #RRGGBB 字面量与 Tailwind 内置调色板。
 * hover / active / focus-visible / disabled 四态均有可见反馈。
 */

import type { ComponentProps } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ICON_SIZE, ICON_STROKE } from './internal'
import { Tooltip } from './tooltip'

export const buttonVariants = cva(
  [
    'inline-flex shrink-0 select-none items-center justify-center gap-1 whitespace-nowrap',
    'rounded-zj-sm font-medium',
    'transition-colors duration-150 ease-out',
    // 统一键盘焦点环（定义见 src/index.css 的 @utility zj-focus-ring）
    'zj-focus-ring',
    'disabled:pointer-events-none disabled:opacity-45',
    'aria-pressed:bg-selection aria-pressed:text-text',
    'data-[active=true]:bg-selection',
  ].join(' '),
  {
    variants: {
      variant: {
        /** 主操作：实心 accent（注意别放多个，保持克制） */
        default: 'bg-accent text-accent-fg hover:bg-accent/85 active:bg-accent/75',
        /** 次操作：浅底 + 描边 */
        secondary: 'border border-border bg-surface-2 text-text hover:bg-hover active:bg-selection',
        /** 描边按钮：面板上的常规操作 */
        outline: 'border border-border bg-surface text-text hover:bg-hover active:bg-selection',
        /** 幽灵按钮：列表项内的图标操作 */
        ghost: 'bg-transparent text-text hover:bg-hover active:bg-selection',
        /** 弱化按钮：空状态里的次要动作 */
        subtle: 'bg-transparent text-muted hover:bg-hover hover:text-text active:bg-selection',
        /** 链接式：仅强调色文字，最少使用 */
        link: 'bg-transparent text-accent underline-offset-2 hover:underline',
      },
      size: {
        sm: 'h-7 px-2 text-meta',
        md: 'h-8 px-3 text-ui',
        lg: 'h-9 px-4 text-body',
        'icon-sm': 'h-6 w-6 p-0',
        icon: 'h-7 w-7 p-0',
        'icon-lg': 'h-8 w-8 p-0',
      },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  },
)

export type ButtonVariantProps = VariantProps<typeof buttonVariants>

export interface ButtonProps extends ComponentProps<'button'>, ButtonVariantProps {
  /** 前置图标（lucide-react 组件） */
  icon?: LucideIcon
}

export function Button({
  className,
  variant,
  size,
  icon: Icon,
  children,
  type = 'button',
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {Icon ? <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden /> : null}
      {children}
    </button>
  )
}

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'children'>, ButtonVariantProps {
  /** 图标组件（必须来自 lucide-react） */
  icon: LucideIcon
  /** 无障碍名称；同时用作缺省 tooltip 文案 */
  label: string
  /** 悬停提示：true 用 label 作为文案，也可直接给字符串 */
  tooltip?: boolean | string
  /** 图标尺寸，默认 15px（设计刻度） */
  iconSize?: number
}

export function IconButton({
  className,
  variant = 'ghost',
  size = 'icon',
  icon: Icon,
  label,
  tooltip = false,
  iconSize = ICON_SIZE,
  type = 'button',
  disabled,
  ...props
}: IconButtonProps) {
  const button = (
    <button
      type={type}
      aria-label={label}
      title={tooltip === true ? label : undefined}
      disabled={disabled}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      <Icon size={iconSize} strokeWidth={ICON_STROKE} aria-hidden />
    </button>
  )

  if (!tooltip) return button
  return <Tooltip content={typeof tooltip === 'string' ? tooltip : label}>{button}</Tooltip>
}
