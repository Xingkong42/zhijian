/**
 * EditorEmpty —— 未选中笔记时的空状态占位。
 * 归属：编辑器成员（任务 t4）。
 *
 * docs/DESIGN.md §5：居中、space-8 留白、标题 + muted 说明 + 一个次要按钮；
 * 图标用 lucide-react（不引入任何图片资源）。
 */

import { NotebookPen } from 'lucide-react'
import { Button, EmptyState } from '@/components/ui'
import { cn } from '@/lib/utils'

export interface EditorEmptyProps {
  /** 可选：新建笔记动作；不传则不显示按钮（纯占位） */
  onCreate?: () => void
  className?: string
}

export function EditorEmpty({ onCreate, className }: EditorEmptyProps) {
  return (
    <EmptyState
      icon={NotebookPen}
      title="未选择笔记"
      description="从左栏挑一篇继续写，或者新建一篇 —— 淡黄的纸已经铺好了。"
      action={
        onCreate ? (
          <Button variant="outline" size="md" onClick={onCreate}>
            新建笔记
          </Button>
        ) : undefined
      }
      className={cn('h-full justify-center bg-bg', className)}
    />
  )
}
