/**
 * Toast / Toaster —— 轻量通知（保存失败、导出成功、快捷键注册失败…）。
 * 归属：设计系统（任务 t2）。
 *
 * 用法（在 App 根节点包一层即可）：
 *   <ToastProvider> … </ToastProvider>
 *   const { toast } = useToast()
 *   toast({ title: '已导出', description: 'notes.md', variant: 'success' })
 *
 * 不依赖任何状态库：Provider 内部用 useState 维护队列，纯 React 上下文。
 * 视觉只有透明度淡入，不做位移/缩放（docs/DESIGN.md §1.5）。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { Check, CircleAlert, Info, TriangleAlert, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn, newId } from '@/lib/utils'
import { ICON_SIZE, ICON_STROKE } from './internal'
import { IconButton } from './button'

export type ToastVariant = 'info' | 'success' | 'warning' | 'error'

export interface ToastOptions {
  title: string
  description?: string
  variant?: ToastVariant
  /** 自动消失时间（ms）；0 表示不自动消失 */
  duration?: number
}

export interface ToastRecord extends ToastOptions {
  id: string
}

export interface ToastApi {
  toast: (options: ToastOptions) => string
  dismiss: (id: string) => void
  clear: () => void
}

const ToastContext = createContext<ToastApi | null>(null)

const VARIANT_ICON: Record<ToastVariant, LucideIcon> = {
  info: Info,
  success: Check,
  warning: TriangleAlert,
  error: CircleAlert,
}

export interface ToastProviderProps {
  children: ReactNode
  /** 默认自动消失时间（ms） */
  duration?: number
  /** 同时最多显示几条（超出丢弃最旧的） */
  max?: number
  viewportClassName?: string
}

export function ToastProvider({
  children,
  duration = 3200,
  max = 4,
  viewportClassName,
}: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const timersRef = useRef(new Map<string, number>())

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timersRef.current.delete(id)
    }
    setToasts((list) => list.filter((item) => item.id !== id))
  }, [])

  const clear = useCallback(() => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer))
    timersRef.current.clear()
    setToasts([])
  }, [])

  const toast = useCallback(
    (options: ToastOptions) => {
      const id = newId()
      const record: ToastRecord = { variant: 'info', duration, ...options, id }
      setToasts((list) => [...list, record].slice(-Math.max(1, max)))
      if ((record.duration ?? 0) > 0) {
        timersRef.current.set(
          id,
          window.setTimeout(() => dismiss(id), record.duration),
        )
      }
      return id
    },
    [dismiss, duration, max],
  )

  // 卸载时清理所有定时器，避免内存泄漏 / 卸载后 setState
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
      timers.clear()
    }
  }, [])

  const api = useMemo<ToastApi>(() => ({ toast, dismiss, clear }), [toast, dismiss, clear])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismiss} className={viewportClassName} />
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast 必须在 <ToastProvider> 内使用')
  return context
}

export interface ToasterProps {
  toasts: readonly ToastRecord[]
  onDismiss: (id: string) => void
  className?: string
}

/** 通知视口（固定在右下角；Provider 内部已挂载，一般无需手写） */
export function Toaster({ toasts, onDismiss, className }: ToasterProps) {
  return (
    <div
      role="region"
      aria-live="polite"
      aria-label="通知"
      className={cn(
        'pointer-events-none fixed bottom-4 right-4 z-[70] flex w-80 flex-col gap-2',
        className,
      )}
    >
      {toasts.map((item) => (
        <Toast key={item.id} toast={item} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

export interface ToastProps extends ComponentProps<'div'> {
  toast: ToastRecord
  onDismiss: (id: string) => void
}

export function Toast({ toast, onDismiss, className, ...props }: ToastProps) {
  const variant: ToastVariant = toast.variant ?? 'info'
  const Icon = VARIANT_ICON[variant]
  return (
    <div
      role="status"
      data-variant={variant}
      className={cn(
        'pointer-events-auto flex items-start gap-2 rounded-zj border border-border bg-surface',
        'px-3 py-2 text-text shadow-zj zj-fade-in',
        className,
      )}
      {...props}
    >
      {/* mt-0.5（2px）= 光学对齐：把 15px 图标对齐到 13px 首行文字的视觉中线，
          不参与布局节奏（父级 items-start）。备案：docs/DESIGN.md §7「光学对齐豁免」。 */}
      <Icon
        size={ICON_SIZE}
        strokeWidth={ICON_STROKE}
        className="mt-0.5 shrink-0 text-accent"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-ui font-medium">{toast.title}</p>
        {toast.description ? (
          <p className="mt-1 break-words text-meta text-muted">{toast.description}</p>
        ) : null}
      </div>
      <IconButton
        icon={X}
        label="关闭提示"
        size="icon-sm"
        onClick={() => onDismiss(toast.id)}
        className="-mr-1 -mt-1"
      />
    </div>
  )
}
