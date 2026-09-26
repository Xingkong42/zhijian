/**
 * ModeToggle —— 明暗模式切换（设置面板「外观」区）。
 * 归属：系统集成 / 任务 t6（`src/features/settings/**`）。
 *
 * 两个 button（不是 Tabs）：它们是**持久偏好开关**而非视图切换，
 * 用 `aria-pressed` 表达状态，Tab / Enter / Space 天然可达。
 */

import { Moon, Sun } from 'lucide-react'
import type { ThemeMode } from '@/types'
import { cn } from '@/lib/utils'
import { ICON_SIZE, ICON_STROKE } from '@/components/ui'

export interface ModeToggleProps {
  mode: ThemeMode
  onSetMode: (mode: ThemeMode) => void
  /** 再点一次当前模式时执行的快捷切换（通常接 themeStore.toggleMode） */
  onToggle?: () => void
  /** 是否禁用（例如主题尚未加载完成） */
  disabled?: boolean
  className?: string
}

const OPTIONS: readonly { value: ThemeMode; label: string; hint: string }[] = [
  { value: 'light', label: '浅色', hint: '纸感浅底，默认' },
  { value: 'dark', label: '深色', hint: '夜间阅读' },
]

export function ModeToggle({
  mode,
  onSetMode,
  onToggle,
  disabled = false,
  className,
}: ModeToggleProps) {
  return (
    <div
      role="group"
      aria-label="明暗模式"
      className={cn('flex w-fit items-center gap-1 rounded-zj bg-surface-2 p-1', className)}
    >
      {OPTIONS.map((option) => {
        const active = option.value === mode
        const Icon = option.value === 'dark' ? Moon : Sun
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            title={option.hint}
            disabled={disabled}
            onClick={() => {
              if (active) {
                // 已选中的模式再点一次 = 快捷切换（与 toggleMode 行为一致）
                onToggle?.()
                return
              }
              onSetMode(option.value)
            }}
            className={cn(
              'inline-flex h-7 select-none items-center gap-1 rounded-zj-sm px-3 text-ui font-medium',
              'transition-colors duration-150 ease-out zj-focus-ring',
              'disabled:pointer-events-none disabled:opacity-45',
              active ? 'bg-selection text-text' : 'text-muted hover:bg-hover hover:text-text',
            )}
          >
            <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden />
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export default ModeToggle
