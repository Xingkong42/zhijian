/**
 * ConfirmDialog —— 笔记列表内的二次确认（彻底删除）。
 * 归属：src/features/notes-list/**（t5）。
 *
 * 为什么不复用 sidebar 目录下的同名组件：`src/features/README.md` 禁止跨 feature import
 * （共享要上提到 App.tsx 或 lib），这里用现成 Dialog 原语组合一个业务语义对话框。
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
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

export interface ConfirmDialogProps {
  open: boolean
  title: string
  description?: ReactNode
  confirmLabel?: string
  onOpenChange: (open: boolean) => void
  onConfirm: () => void | Promise<void>
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '彻底删除',
  onOpenChange,
  onConfirm,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description ?? '该操作不可恢复。'}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose />
          <Button
            variant="default"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void Promise.resolve(onConfirm())
                .catch(() => undefined)
                .finally(() => {
                  setBusy(false)
                  onOpenChange(false)
                })
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
