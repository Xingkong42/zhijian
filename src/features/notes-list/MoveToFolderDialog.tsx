/**
 * MoveToFolderDialog —— 「移动到…」文件夹选择器（笔记卡片右键菜单触发）。
 * 归属：src/features/notes-list/**（t5）。
 *
 * 用对话框而不是菜单：`MenuItemDef` 没有子菜单语义，用扁平列表 + 缩进能表达任意深度的文件夹树，
 * 且键盘/焦点行为直接复用设计系统的 Dialog（Tab 锁焦、Esc 关闭、焦点归还）。
 * 当前所在文件夹用对勾标记（aria-current），点击即移动并关闭。
 */

import { Check, Folder, Inbox } from 'lucide-react'
import type { FolderTreeNode, Note } from '@/types'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ScrollArea,
  ICON_STROKE,
} from '@/components/ui'
import { cn, truncate } from '@/lib/utils'
import { fire, flattenFolders } from './util'

export interface MoveToFolderDialogProps {
  /** 要移动的笔记；null = 关闭 */
  note: Note | null
  folders: FolderTreeNode[]
  onOpenChange: (open: boolean) => void
  onMove: (id: string, folderId: string | null) => void | Promise<void>
}

export function MoveToFolderDialog({
  note,
  folders,
  onOpenChange,
  onMove,
}: MoveToFolderDialogProps) {
  const rows = flattenFolders(folders)
  const current = note?.folderId ?? null

  const pick = (folderId: string | null) => {
    if (!note) return
    const id = note.id
    onOpenChange(false)
    fire(onMove(id, folderId))
  }

  return (
    <Dialog open={note !== null} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>移动到…</DialogTitle>
          <DialogDescription>
            {note ? `把「${truncate(note.title.trim() || '无标题', 20)}」移动到：` : ''}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-64 rounded-zj-sm border border-border p-1">
          <FolderOption
            depth={0}
            label="收件箱（未归类）"
            icon="inbox"
            active={current === null}
            onPick={() => pick(null)}
          />
          {rows.map(({ folder, depth }) => (
            <FolderOption
              key={folder.id}
              depth={depth + 1}
              label={folder.name}
              icon="folder"
              active={current === folder.id}
              onPick={() => pick(folder.id)}
            />
          ))}
          {rows.length === 0 ? (
            <p className="px-2 py-1 text-2xs text-muted">还没有文件夹，可先移动到收件箱。</p>
          ) : null}
        </ScrollArea>

        <DialogFooter>
          <DialogClose />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface FolderOptionProps {
  depth: number
  label: string
  icon: 'folder' | 'inbox'
  active: boolean
  onPick: () => void
}

function FolderOption({ depth, label, icon, active, onPick }: FolderOptionProps) {
  const Icon = icon === 'inbox' ? Inbox : Folder
  return (
    <button
      type="button"
      onClick={onPick}
      aria-current={active ? 'true' : undefined}
      style={{ paddingLeft: 8 + depth * 12 }}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-zj-sm pr-2 text-left text-ui',
        'transition-colors duration-150 ease-out zj-focus-ring',
        active ? 'bg-selection text-text' : 'text-muted hover:bg-hover hover:text-text',
      )}
    >
      <Icon
        size={15}
        strokeWidth={ICON_STROKE}
        aria-hidden
        className={cn('shrink-0', active ? 'text-accent' : 'text-muted')}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {active ? <Check size={14} strokeWidth={ICON_STROKE} aria-hidden className="text-accent" /> : null}
      {active ? <span className="sr-only">当前所在位置</span> : null}
    </button>
  )
}
