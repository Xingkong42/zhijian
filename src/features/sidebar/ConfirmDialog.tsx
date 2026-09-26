/**
 * ConfirmDialog —— 侧栏内联的二次确认（删除文件夹 / 删除标签）。
 * 归属：src/features/sidebar/**（t5）。
 *
 * 为什么不放到 src/components/ui：那是设计系统成员（t4）的独占目录；
 * 这里用现成 Dialog 原语组合出业务语义，删除类操作必须可撤销/可取消。
 * 同理 notes-list 目录内自带一份（features 之间禁止互相 import，见 src/features/README.md）。
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui'

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
  confirmLabel = '删除',
  onOpenChange,
  onConfirm,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
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
