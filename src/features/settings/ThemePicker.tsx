/**
 * ThemePicker —— 五套主题的色卡预览（设置面板「外观」区）。
 * 归属：系统集成 / 任务 t6（`src/features/settings/**`）。
 *
 * 契约与红线：
 *  - 主题清单与色值**只来自** `themeList`（= `src/db/schema.ts` 的 THEMES），
 *    本文件不写任何 16 进制色值，也不 import 任何其它 feature；
 *  - 色卡内的颜色只能来自主题定义本身（`--zj-*` 的权威值），因此用内联 style 注入：
 *    这是设计规范允许的例外位置 —— 预览要展示**尚未激活**主题的配色，
 *    CSS 变量此时还是当前主题的值，无法表达；
 *  - 卡片本身的外观（边框/底色/文字/圆角/焦点环）一律用语义 token 类。
 *
 * 交互：原生 `<input type="radio">` + `<label>`，点击整卡即选中，
 * Tab 进入后可用 ←→ 切换（浏览器原生 radio group 行为），无自定义键盘逻辑。
 */

import type { ChangeEvent } from 'react'
import { Check } from 'lucide-react'
import type { ThemeDefinition, ThemeId, ThemeMode } from '@/types'
import { cn } from '@/lib/utils'

export interface ThemePickerProps {
  /** 主题清单（来自 `themeStore.themeList`） */
  themeList: readonly ThemeDefinition[]
  /** 当前生效的主题 id */
  themeId: ThemeId
  /** 当前明暗模式：决定色卡预览 light 还是 dark 组 */
  mode: ThemeMode
  onSelect: (id: ThemeId) => void
  className?: string
}

/** 从主题名取一个汉字/字母作徽标（如「淡黄（默认）」→「淡」） */
function initial(label: string): string {
  const match = label.match(/[\u4e00-\u9fa5A-Za-z]/)
  return match ? match[0] : '主'
}

export function ThemePicker({ themeList, themeId, mode, onSelect, className }: ThemePickerProps) {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const id = event.target.value as ThemeId
    if (id !== themeId) onSelect(id)
  }

  return (
    <div role="radiogroup" aria-label="主题" className={cn('grid grid-cols-2 gap-2', className)}>
      {themeList.map((theme) => {
        const tokens = mode === 'dark' ? theme.dark : theme.light
        const selected = theme.id === themeId
        const preview = [
          tokens['zj-bg'],
          tokens['zj-surface'],
          tokens['zj-surface-2'],
          tokens['zj-accent'],
          tokens['zj-selection'],
        ]
        return (
          <label
            key={theme.id}
            className={cn(
              'relative flex cursor-pointer flex-col gap-2 rounded-zj border p-2',
              'transition-colors duration-150 ease-out',
              // 焦点环跟随内部 radio（键盘可达性）
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
              selected ? 'border-accent bg-selection' : 'border-border bg-surface hover:bg-hover',
            )}
          >
            <input
              type="radio"
              name="zj-theme"
              value={theme.id}
              checked={selected}
              onChange={handleChange}
              className="sr-only"
            />
            {/* 色卡：展示该主题在当前明暗下的真实配色（值来自 THEMES） */}
            <span
              aria-hidden
              className="flex h-9 items-stretch overflow-hidden rounded-zj-sm border"
              style={{ backgroundColor: preview[0], borderColor: tokens['zj-border'] }}
            >
              <span className="w-3" style={{ backgroundColor: preview[1] }} />
              <span className="w-3" style={{ backgroundColor: preview[2] }} />
              <span className="flex-1" />
              <span className="w-3" style={{ backgroundColor: preview[3] }} />
              <span className="w-3" style={{ backgroundColor: preview[4] }} />
            </span>

            <span className="flex items-center gap-2">
              <span
                aria-hidden
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-zj-sm text-meta font-medium"
                style={{ backgroundColor: tokens['zj-accent'], color: tokens['zj-accent-fg'] }}
              >
                {initial(theme.label)}
              </span>
              <span className="min-w-0 flex-1 truncate text-ui text-text">{theme.label}</span>
              {selected ? (
                <Check size={15} strokeWidth={1.75} aria-hidden className="shrink-0 text-accent" />
              ) : null}
            </span>
          </label>
        )
      })}
    </div>
  )
}

export default ThemePicker
