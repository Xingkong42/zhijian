/**
 * TagColorDialog —— 标签颜色选择（t18）。
 * 归属：src/features/sidebar/**。
 *
 * 颜色从哪来（docs/DESIGN.md §6：源码零色值）：
 *   1) 浏览器原生取色器 `input[type=color]`，初值是该标签**当前**的颜色（来自 md front-matter
 *      的领域值，不是源码常量）；
 *   2) 快捷色板来自**当前主题**的 `--zj-*` token，运行时读取（切主题自动跟随）。
 * 本文件因此没有任何颜色字面量；保存时把用户选中的值交回上层落库。
 */

import { useEffect, useState } from 'react'
import { Palette } from 'lucide-react'
import type { Tag } from '@/types'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui'
import { cn } from '@/lib/utils'
import { isUsableColor, normalizeHexColor, themeTagSwatches } from './tag-colors'

export interface TagColorDialogProps {
  /** 目标标签；null = 关闭 */
  tag: Tag | null
  onOpenChange: (open: boolean) => void
  onSubmit: (color: string) => void | Promise<void>
}

export function TagColorDialog({ tag, onOpenChange, onSubmit }: TagColorDialogProps) {
  const swatches = themeTagSwatches()
  const fallback = swatches[0]?.value ?? ''
  const [draft, setDraft] = useState('')

  // 打开（或换标签）时用该标签当前颜色初始化；解析失败则退回主题色板第一项
  useEffect(() => {
    if (!tag) return
    setDraft(normalizeHexColor(tag.color) ?? fallback)
    // 只在「换标签」时重置，避免用户正在选色时被 props 回流覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag?.id])

  const pickable = isUsableColor(draft)

  return (
    <Dialog open={tag !== null} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>标签颜色</DialogTitle>
          <DialogDescription>
            给「{tag?.name ?? ''}」挑一个颜色；颜色只影响显示，不影响标签本身。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="h-6 w-6 shrink-0 rounded-full border border-border"
            style={pickable ? { backgroundColor: draft } : undefined}
          />
          {pickable ? (
            <input
              type="color"
              value={draft}
              aria-label="自定义颜色"
              onChange={(event) => setDraft(event.target.value)}
              className={cn(
                'h-8 w-14 cursor-pointer rounded-zj-sm border border-border bg-surface p-1',
                'zj-focus-ring',
              )}
            />
          ) : (
            <span className="text-meta text-muted">
              当前颜色值无法解析，请从下面的主题色板里选一个。
            </span>
          )}
          <span className="font-mono text-meta text-muted">{pickable ? draft : '—'}</span>
        </div>

        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-1 text-2xs text-muted">
            <Palette size={12} strokeWidth={1.75} aria-hidden />
            跟随当前主题
          </span>
          <div className="flex items-center gap-2">
            {swatches.map((swatch) => (
              <button
                key={swatch.token}
                type="button"
                title={swatch.label}
                aria-label={swatch.label}
                aria-pressed={swatch.value.toLowerCase() === draft.toLowerCase()}
                onClick={() => setDraft(swatch.value)}
                style={{ backgroundColor: swatch.value }}
                className={cn(
                  'h-6 w-6 rounded-full border border-border transition-colors duration-150 ease-out',
                  'hover:border-accent zj-focus-ring',
                  swatch.value.toLowerCase() === draft.toLowerCase() && 'ring-2 ring-accent',
                )}
              />
            ))}
          </div>
        </div>

        <DialogFooter>
          <DialogClose />
          <Button
            variant="default"
            disabled={!pickable}
            onClick={() => {
              if (!pickable) return
              const value = draft
              onOpenChange(false)
              void Promise.resolve(onSubmit(value)).catch(() => undefined)
            }}
          >
            保存颜色
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
