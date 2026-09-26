/**
 * TagList —— 侧栏标签列表（R7；t18 增强为「可用 + 可管理」）。
 * 归属：src/features/sidebar/**。
 *
 * 能力：
 *  - 每行一个颜色点（`tag.color`，来自 md front-matter 的领域值，行内 style 渲染；源码零色值）；
 *  - **左键 = 用它筛选**（`onSelect(tag)` → Sidebar 的 `onSelectView('tag', tag.id)`）；
 *  - **右键 = 管理**：重命名 / 改颜色 / 删除（后两项未接线时不渲染，避免「点了没反应」的假入口）；
 *  - 删除确认**如实说明影响范围**：标签被 N 篇笔记使用时提示「这些笔记会去掉这个标签，
 *    笔记本身不受影响」；N=0 时提示「当前没有笔记在使用」；
 *  - 计数取 `counts.byTag[tag.name]`（契约：byTag 的键是**标签名**，不是 id）；
 *  - 按名称排序（captain 转达的 §4.12 契约：标签顺序是派生值，不做拖拽排序）。
 *
 * 新存储层（t15）事实：标签的**存在性**来自笔记 front-matter —— 只要还有笔记在用就存在；
 * 未声明过的标签在最后一个使用者消失后从索引消失。删除标签 = 从所有笔记 front-matter
 * 剔除该名 + 清理元数据（由 tagsRepo.remove 完成，本组件只发起调用，不碰文件）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Check, Hash, Palette, Pencil, Tag as TagIcon, Trash2 } from 'lucide-react'
import type { NoteCounts, Tag, UiView } from '@/types'
import { ContextMenu, Input } from '@/components/ui'
import type { MenuItemDef } from '@/components/ui'
import { ConfirmDialog } from './ConfirmDialog'
import { NavRow } from './rows'
import { TagColorDialog } from './TagColorDialog'
import { fire } from './util'

/** 重命名标签的处理器（未提供 ⇒ 「重命名」菜单项不渲染） */
export type TagRenameHandler = (id: string, name: string) => void | Promise<void>
/** 修改标签颜色的处理器（未提供 ⇒ 「改颜色」菜单项不渲染） */
export type TagColorHandler = (id: string, color: string) => void | Promise<void>

export interface TagListProps {
  tags: Tag[]
  counts: NoteCounts
  view: UiView
  activeTagId: string | null
  /** 受控的「正在新建标签」状态（由 Sidebar 的分组按钮触发） */
  creating: boolean
  onCreatingChange: (creating: boolean) => void
  onSelect: (tag: Tag) => void
  onCreateTag: (name: string, color?: string) => void | Promise<void>
  onRemoveTag: (id: string) => void | Promise<void>
  /** 可选：重命名（t18 新增） */
  onRenameTag?: TagRenameHandler
  /** 可选：改颜色（t18 新增，需 db 侧 tagsRepo.updateColor） */
  onUpdateTagColor?: TagColorHandler
}

export function TagList({
  tags,
  counts,
  view,
  activeTagId,
  creating,
  onCreatingChange,
  onSelect,
  onCreateTag,
  onRemoveTag,
  onRenameTag,
  onUpdateTagColor,
}: TagListProps) {
  const [pendingRemove, setPendingRemove] = useState<Tag | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [colorTarget, setColorTarget] = useState<Tag | null>(null)

  // 按名称排序（zh-CN），与 db 的 `ORDER BY name ASC` 对齐；不改动入参
  const ordered = useMemo(
    () => [...tags].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    [tags],
  )

  const usageOf = (tag: Tag) => counts.byTag[tag.name] ?? 0

  const menuFor = (tag: Tag): MenuItemDef[] => {
    const items: MenuItemDef[] = []
    if (onRenameTag) {
      items.push({
        id: 'rename',
        label: '重命名',
        icon: Pencil,
        onSelect: () => setRenamingId(tag.id),
      })
    }
    if (onUpdateTagColor) {
      items.push({
        id: 'color',
        label: '改颜色',
        icon: Palette,
        onSelect: () => setColorTarget(tag),
      })
    }
    items.push({
      id: 'remove',
      label: '删除标签',
      icon: Trash2,
      separatorBefore: items.length > 0,
      onSelect: () => setPendingRemove(tag),
    })
    return items
  }

  const removeUsage = pendingRemove ? usageOf(pendingRemove) : 0

  return (
    <div className="flex flex-col">
      {creating ? (
        <NameInput
          placeholder="新建标签"
          onCommit={(name) => {
            onCreatingChange(false)
            fire(onCreateTag(name))
          }}
          onCancel={() => onCreatingChange(false)}
        />
      ) : null}

      {ordered.length === 0 && !creating ? (
        <p className="px-2 py-1 text-2xs text-muted">
          还没有标签。打开一篇笔记，点卡片右键的「标签…」即可新建并加上。
        </p>
      ) : null}

      {ordered.map((tag) =>
        renamingId === tag.id ? (
          <div
            key={tag.id}
            className="flex h-7 items-center gap-2 rounded-zj-sm pr-2"
            style={{ paddingLeft: 12 }}
          >
            <TagIcon size={15} strokeWidth={1.75} aria-hidden className="shrink-0 text-accent" />
            <NameInput
              defaultValue={tag.name}
              placeholder="标签名称"
              onCommit={(name) => {
                setRenamingId(null)
                if (name !== tag.name && onRenameTag) fire(onRenameTag(tag.id, name))
              }}
              onCancel={() => setRenamingId(null)}
            />
          </div>
        ) : (
          <ContextMenu key={tag.id} items={menuFor(tag)}>
            <NavRow
              dense
              active={view === 'tag' && activeTagId === tag.id}
              onClick={() => onSelect(tag)}
              label={tag.name}
              count={usageOf(tag)}
              leading={
                <span
                  aria-hidden
                  data-tag-color={tag.color}
                  className="ml-1 h-2 w-2 shrink-0 rounded-full border border-border"
                  style={{ backgroundColor: tag.color }}
                />
              }
            />
          </ContextMenu>
        ),
      )}

      <ConfirmDialog
        open={pendingRemove !== null}
        title={`删除标签「${pendingRemove?.name ?? ''}」？`}
        description={
          removeUsage > 0
            ? `该标签正被 ${removeUsage} 篇笔记使用；删除后这些笔记会去掉这个标签，笔记本身与其它标签都不受影响。`
            : '当前没有笔记在使用这个标签，删除后不会影响任何笔记。'
        }
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null)
        }}
        onConfirm={() => {
          const target = pendingRemove
          setPendingRemove(null)
          if (target) fire(onRemoveTag(target.id))
        }}
      />

      <TagColorDialog
        tag={colorTarget}
        onOpenChange={(open) => {
          if (!open) setColorTarget(null)
        }}
        onSubmit={async (color) => {
          const target = colorTarget
          setColorTarget(null)
          if (target && onUpdateTagColor) await onUpdateTagColor(target.id, color)
        }}
      />
    </div>
  )
}

interface NameInputProps {
  defaultValue?: string
  placeholder: string
  onCommit: (name: string) => void
  onCancel: () => void
}

/** 行内名称输入（新建 / 重命名共用）：Enter 提交 · Esc 取消 · 失焦提交（只结算一次） */
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
    const name = value.trim().replace(/^#+/, '')
    if (commit && name.length > 0) onCommit(name)
    else onCancel()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      finish(true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      finish(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Hash size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-accent" />
      <Input
        ref={inputRef}
        inputSize="sm"
        bare
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => finish(true)}
        className="h-6 min-w-0 flex-1"
      />
      <Check size={13} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted" />
    </div>
  )
}
