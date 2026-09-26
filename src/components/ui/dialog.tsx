/**
 * Dialog —— 居中卡片式对话框（手写实现，不依赖 Radix / shadcn CLI）。
 * 归属：设计系统（任务 t2）。
 *
 * 用法：
 *   <Dialog open={open} onOpenChange={setOpen}>
 *     <DialogContent size="md">
 *       <DialogHeader>
 *         <DialogTitle>重命名</DialogTitle>
 *         <DialogDescription>输入新的名称，回车确认。</DialogDescription>
 *       </DialogHeader>
 *       <Input data-autofocus />
 *       <DialogFooter>
 *         <DialogClose />
 *         <Button variant="default">确定</Button>
 *       </DialogFooter>
 *     </DialogContent>
 *   </Dialog>
 *
 * 行为：Esc / 点击遮罩关闭（可关）、Tab 焦点锁在卡片内、关闭后焦点归还、
 * role=dialog + aria-modal + aria-labelledby/describedby 全套。
 */

import { createContext, useCallback, useContext, useId, useRef } from 'react'
import type { ComponentProps, ReactNode, RefObject } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useControllableState, useDismiss, useFocusTrap } from './internal'
import { Portal } from './portal'
import { IconButton } from './button'

interface DialogContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  contentRef: RefObject<HTMLDivElement | null>
  titleId: string
  descriptionId: string
  dismissOnOverlayClick: boolean
}

const DialogContext = createContext<DialogContextValue | null>(null)

function useDialogContext(): DialogContextValue {
  const context = useContext(DialogContext)
  if (!context) throw new Error('Dialog 子组件必须放在 <Dialog> 内使用')
  return context
}

export interface DialogProps {
  /** 受控开合；不传则用 defaultOpen 走非受控 */
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactNode
  /** 点击遮罩关闭，默认 true */
  dismissOnOverlayClick?: boolean
  /** Esc 关闭，默认 true */
  dismissOnEscape?: boolean
  className?: string
}

export function Dialog({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  children,
  dismissOnOverlayClick = true,
  dismissOnEscape = true,
  className,
}: DialogProps) {
  const [open, setOpen] = useControllableState<boolean>({
    value: openProp,
    defaultValue: defaultOpen,
    onChange: onOpenChange,
  })
  const contentRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  const close = useCallback(() => setOpen(false), [setOpen])

  useDismiss({
    active: open,
    onDismiss: close,
    refs: [contentRef],
    closeOnResize: false,
    closeOnEscape: dismissOnEscape,
  })
  useFocusTrap(open, contentRef)

  return (
    <DialogContext.Provider
      value={{ open, setOpen, contentRef, titleId, descriptionId, dismissOnOverlayClick }}
    >
      <div className={cn('contents', className)}>{children}</div>
    </DialogContext.Provider>
  )
}

const dialogContentVariants = cva(
  [
    'relative z-10 flex w-full flex-col gap-3 rounded-zj border border-border bg-surface p-4',
    'text-text shadow-zj zj-fade-in outline-none',
  ].join(' '),
  {
    variants: {
      size: {
        sm: 'max-w-72',
        md: 'max-w-96',
        lg: 'max-w-120',
      },
    },
    defaultVariants: { size: 'md' },
  },
)

export interface DialogContentProps
  extends ComponentProps<'div'>,
    VariantProps<typeof dialogContentVariants> {
  /** 右上角关闭按钮，默认 true */
  showClose?: boolean
}

export function DialogContent({
  className,
  size = 'md',
  showClose = true,
  children,
  ...props
}: DialogContentProps) {
  const { open, setOpen, contentRef, titleId, descriptionId, dismissOnOverlayClick } =
    useDialogContext()

  if (!open) return null

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-8">
        <div
          aria-hidden
          data-dialog-overlay=""
          className="absolute inset-0 bg-bg/80"
          onClick={() => {
            if (dismissOnOverlayClick) setOpen(false)
          }}
        />
        <div
          ref={contentRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          tabIndex={-1}
          className={cn(dialogContentVariants({ size }), className)}
          {...props}
        >
          {children}
          {showClose ? (
            <IconButton
              icon={X}
              label="关闭"
              className="absolute right-2 top-2"
              onClick={() => setOpen(false)}
            />
          ) : null}
        </div>
      </div>
    </Portal>
  )
}

export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 pr-6', className)} {...props} />
}

export function DialogTitle({ className, ...props }: ComponentProps<'h2'>) {
  const { titleId } = useDialogContext()
  return <h2 id={titleId} className={cn('text-title font-medium text-text', className)} {...props} />
}

export function DialogDescription({ className, ...props }: ComponentProps<'p'>) {
  const { descriptionId } = useDialogContext()
  return <p id={descriptionId} className={cn('text-ui text-muted', className)} {...props} />
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex items-center justify-end gap-2 pt-1', className)}
      {...props}
    />
  )
}

export interface DialogCloseProps extends ComponentProps<'button'> {
  children?: ReactNode
}

/** 语义化关闭按钮（默认文案「取消」） */
export function DialogClose({ className, children, onClick, ...props }: DialogCloseProps) {
  const { setOpen } = useDialogContext()
  return (
    <button
      type="button"
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        setOpen(false)
      }}
      className={cn(
        'inline-flex h-8 shrink-0 select-none items-center justify-center gap-1 rounded-zj-sm border border-border',
        'bg-surface px-3 text-ui font-medium text-text',
        'transition-colors duration-150 ease-out zj-focus-ring',
        'hover:bg-hover active:bg-selection disabled:pointer-events-none disabled:opacity-45',
        className,
      )}
      {...props}
    >
      {children ?? '取消'}
    </button>
  )
}
