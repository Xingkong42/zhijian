/**
 * Tooltip —— 悬停 / 聚焦提示（图标按钮的可读性依赖它）。
 * 归属：设计系统（任务 t2）。
 *
 * 用法：<Tooltip content="新建笔记 (Alt+N)"><IconButton icon={Plus} label="新建" /></Tooltip>
 * 用 inline-flex 包裹层做定位锚点；提示本身 pointer-events:none，不会抢鼠标。
 * 无位移动画，只有 140ms 透明度淡入（docs/DESIGN.md §1.5）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useAnchoredPosition } from './internal'
import type { FloatingAlign, FloatingSide } from './internal'
import { Portal } from './portal'

export interface TooltipProps {
  content: ReactNode
  children: ReactNode
  side?: FloatingSide
  align?: FloatingAlign
  /** 悬停多久后出现（ms），默认 300；键盘聚焦立即出现 */
  delay?: number
  disabled?: boolean
  className?: string
}

export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  delay = 300,
  disabled = false,
  className,
}: TooltipProps) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<number | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => clearTimer, [clearTimer])

  const show = useCallback(
    (immediate: boolean) => {
      if (disabled) return
      clearTimer()
      if (immediate) {
        setOpen(true)
        return
      }
      timerRef.current = window.setTimeout(() => setOpen(true), delay)
    },
    [clearTimer, delay, disabled],
  )

  const hide = useCallback(() => {
    clearTimer()
    setOpen(false)
  }, [clearTimer])

  const point = useAnchoredPosition({ open, anchorRef, surfaceRef, side, align, offset: 4 })

  return (
    <span
      ref={anchorRef}
      className={cn('inline-flex', className)}
      onPointerEnter={() => show(false)}
      onPointerLeave={hide}
      onFocusCapture={() => show(true)}
      onBlurCapture={hide}
      onPointerDown={hide}
    >
      {children}
      {open ? (
        <Portal>
          <div
            ref={surfaceRef}
            role="tooltip"
            style={{
              left: point?.x ?? -9999,
              top: point?.y ?? -9999,
              visibility: point ? 'visible' : 'hidden',
            }}
            className={cn(
              'pointer-events-none fixed z-[60] max-w-64 rounded-zj-sm border border-border bg-surface',
              'px-2 py-1 text-meta text-text shadow-zj zj-fade-in',
            )}
          >
            {content}
          </div>
        </Portal>
      ) : null}
    </span>
  )
}
