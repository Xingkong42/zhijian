/**
 * FolderTree —— 侧栏文件夹树（R6）。
 * 归属：src/features/sidebar/**（t5）。
 *
 * 能力：
 *  - 树形展示（`FolderTreeNode`，任意层嵌套），展开/折叠状态在组件内维护，
 *    默认全部展开；新建/切换选中项时自动展开到该节点；用户折叠后不会被刷新重置。
 *  - 右键菜单：新建子文件夹 / 重命名 / 删除（删除走二次确认）。
 *  - 行内编辑：新建与重命名都用行内输入框（Enter 提交、Esc 取消、失焦提交），
 *    不用弹窗，避免打断浏览。
 *  - a11y：`role="tree"` / `role="treeitem"`（aria-expanded / aria-selected）/ `role="group"`，
 *    箭头按钮与名称按钮并列（不是按钮嵌套按钮）。
 *
 * 数据都由 props 传入（`SidebarProps` 的子集），本组件不 import 任何 store —— 与 ARCHITECTURE §4.4
 * 的「组件 props 化」一致，便于集成层（t7）统一接线。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Folder, FolderOpen, FolderPlus, Pencil, Trash2 } from 'lucide-react'
import type { FolderTreeNode, NoteCounts, UiView } from '@/types'
import { ContextMenu, Input } from '@/components/ui'
import type { MenuItemDef } from '@/components/ui'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from './ConfirmDialog'
import { TreeRow } from './rows'
import { collectFolderIds, fire, folderAncestorIds, folderSubtreeNoteCount } from './util'

export interface FolderCreateTarget {
  /** 新文件夹的父级；null = 顶层 */
  parentId: string | null
  /** 输入框所在层级（用于缩进） */
  depth: number
}

export interface FolderTreeProps {
  folders: FolderTreeNode[]
  counts: NoteCounts
  view: UiView
  activeFolderId: string | null
  /** 受控的「正在新建」目标（由 Sidebar 的分组按钮触发） */
  creating: FolderCreateTarget | null
  onCreatingChange: (target: FolderCreateTarget | null) => void
  onSelect: (folderId: string) => void
  onCreateFolder: (name: string, parentId?: string | null) => void | Promise<void>
  onRenameFolder: (id: string, name: string) => void | Promise<void>
  onRemoveFolder: (id: string) => void | Promise<void>
}

export function FolderTree({
  folders,
  counts,
  view,
  activeFolderId,
  creating,
  onCreatingChange,
  onSelect,
  onCreateFolder,
  onRenameFolder,
  onRemoveFolder,
}: FolderTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => collectFolderIds(folders))
  const knownIdsRef = useRef<Set<string>>(new Set(collectFolderIds(folders)))
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<FolderTreeNode | null>(null)

  // 新出现的文件夹默认展开（首次渲染即全部展开）；用户此前的折叠状态保持
  useEffect(() => {
    const ids = collectFolderIds(folders)
    const fresh: string[] = []
    for (const id of ids) {
      if (!knownIdsRef.current.has(id)) {
        knownIdsRef.current.add(id)
        fresh.push(id)
      }
    }
    for (const id of [...knownIdsRef.current]) {
      if (!ids.has(id)) knownIdsRef.current.delete(id)
    }
    if (fresh.length > 0) {
      setExpanded((prev) => new Set([...prev, ...fresh]))
    }
  }, [folders])

  // 选中项变化时展开其祖先（否则选中的文件夹可能藏在一个已折叠的父级里）
  useEffect(() => {
    if (!activeFolderId) return
    const ancestors = folderAncestorIds(folders, activeFolderId)
    if (ancestors.length === 0) return
    setExpanded((prev) => {
      const next = new Set(prev)
      let changed = false
      for (const id of ancestors) {
        if (!next.has(id)) {
          next.add(id)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [activeFolderId, folders])

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const menuFor = useMemo(
    () =>
      (folder: FolderTreeNode, depth: number): MenuItemDef[] => [
        {
          id: 'create-child',
          label: '新建子文件夹',
          icon: FolderPlus,
          onSelect: () => onCreatingChange({ parentId: folder.id, depth: depth + 1 }),
        },
        { id: 'rename', label: '重命名', icon: Pencil, onSelect: () => setRenamingId(folder.id) },
        {
          id: 'remove',
          label: '删除文件夹',
          icon: Trash2,
          separatorBefore: true,
          onSelect: () => setPendingRemove(folder),
        },
      ],
    [onCreatingChange],
  )

  const renderNodes = (nodes: FolderTreeNode[], depth: number): ReactNode =>
    nodes.map((folder) => {
      const hasChildren = folder.children.length > 0
      const isExpanded = expanded.has(folder.id)
      const isActive = view === 'folder' && activeFolderId === folder.id
      const isRenaming = renamingId === folder.id

      return (
        <div
          key={folder.id}
          role="treeitem"
          aria-expanded={hasChildren ? isExpanded : undefined}
          aria-selected={isActive}
        >
          {isRenaming ? (
            <div className="flex h-7 items-center gap-1 pr-2" style={{ paddingLeft: 8 + depth * 12 }}>
              <Folder size={15} strokeWidth={1.75} aria-hidden className="ml-1 shrink-0 text-accent" />
              <NameInput
                defaultValue={folder.name}
                placeholder="文件夹名称"
                onCommit={(name) => {
                  setRenamingId(null)
                  if (name !== folder.name) fire(onRenameFolder(folder.id, name))
                }}
                onCancel={() => setRenamingId(null)}
              />
            </div>
          ) : (
            <ContextMenu items={menuFor(folder, depth)}>
              <TreeRow
                depth={depth}
                active={isActive}
                hasChildren={hasChildren}
                expanded={isExpanded}
                icon={hasChildren && isExpanded ? FolderOpen : Folder}
                label={folder.name}
                count={counts.byFolder[folder.id] ?? 0}
                onSelect={() => onSelect(folder.id)}
                onToggle={() => toggle(folder.id)}
              />
            </ContextMenu>
          )}

          {hasChildren && isExpanded ? (
            <div role="group">{renderNodes(folder.children, depth + 1)}</div>
          ) : null}

          {creating && creating.parentId === folder.id ? (
            <div
              className="flex h-7 items-center gap-1 pr-2"
              style={{ paddingLeft: 8 + (depth + 1) * 12 }}
            >
              <FolderPlus size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-accent" />
              <NameInput
                placeholder="新建子文件夹"
                onCommit={(name) => {
                  onCreatingChange(null)
                  fire(onCreateFolder(name, folder.id))
                }}
                onCancel={() => onCreatingChange(null)}
              />
            </div>
          ) : null}
        </div>
      )
    })

  return (
    <>
      {creating && creating.parentId === null ? (
        <div className="flex h-7 items-center gap-1 pr-2" style={{ paddingLeft: 8 }}>
          <FolderPlus size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-accent" />
          <NameInput
            placeholder="新建文件夹"
            onCommit={(name) => {
              onCreatingChange(null)
              fire(onCreateFolder(name, null))
            }}
            onCancel={() => onCreatingChange(null)}
          />
        </div>
      ) : null}

      {folders.length === 0 && !creating ? (
        <p className="px-2 py-1 text-2xs text-muted">还没有文件夹</p>
      ) : null}

      {/* role=tree 只包真正的 treeitem，行内输入框 / 空状态放在外层，保持树结构合法 */}
      <div role="tree" aria-label="文件夹">
        {renderNodes(folders, 0)}
      </div>

      <ConfirmDialog
        open={pendingRemove !== null}
        title={`删除文件夹「${pendingRemove?.name ?? ''}」？`}
        description={removeImpactText(pendingRemove, counts)}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null)
        }}
        onConfirm={() => {
          const target = pendingRemove
          setPendingRemove(null)
          if (target) fire(onRemoveFolder(target.id))
        }}
      />
    </>
  )
}

interface NameInputProps {
  defaultValue?: string
  placeholder: string
  onCommit: (name: string) => void
  onCancel: () => void
}

/**
 * 删除文件夹的影响说明（如实、可核对）。
 *
 * 事实依据（captain 转达 + `src/db/folders.ts::remove` 实证）：
 * `foldersRepo.remove` 会先把该目录（含子目录）下的笔记 `folder_id` 置空（移出目录），
 * 再删除目录行 —— **不会删除任何笔记**。所以文案不能写「笔记会一起被删」。
 * 注意：t18 起侧栏不再有「收件箱」入口，故这里说「不再归属任何文件夹（仍在『全部笔记』里）」，
 * 而不是「移到收件箱」——避免让用户去找一个已经不存在的入口。
 */
function removeImpactText(target: FolderTreeNode | null, counts: NoteCounts): string {
  const total = target ? folderSubtreeNoteCount(counts, target) : 0
  if (total > 0) {
    return `这个目录（含子目录）里的 ${total} 篇笔记不会被删除，只是不再归属任何文件夹，仍可在「全部笔记」中找到；目录本身会被移除。`
  }
  return '这个目录（含子目录）会被移除；里面没有笔记，不会影响任何内容。'
}

/**
 * 行内名称输入（新建 / 重命名共用）。
 * Enter 提交 · Esc 取消 · 失焦提交；`doneRef` 保证只结算一次（Enter 后紧跟 blur 不会双提交）。
 */
function NameInput({ defaultValue = '', placeholder, onCommit, onCancel }: NameInputProps) {
  const [value, setValue] = useState(defaultValue)
  const inputRef = useRef<HTMLInputElement>(null)
  const doneRef = useRef(false)

  useEffect(() => {
    const element = inputRef.current
    if (!element) return
    element.focus()
    element.select()
  }, [])

  const finish = (commit: boolean) => {
    if (doneRef.current) return
    doneRef.current = true
    const name = value.trim()
    if (commit && name.length > 0) onCommit(name)
    else onCancel()
  }

  return (
    <Input
      ref={inputRef}
      inputSize="sm"
      bare
      value={value}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          finish(true)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          finish(false)
        }
      }}
      onBlur={() => finish(true)}
      className={cn('h-6 min-w-0 flex-1')}
    />
  )
}
