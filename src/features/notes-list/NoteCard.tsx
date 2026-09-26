/**
 * NoteCard —— 单条笔记卡片（标题 / 两行摘要 / 相对时间 / 标签 / 置顶标记 / 选中高亮）。
 * 归属：src/features/notes-list/**（t5 建立；t18 增强标签）。
 *
 * 拖拽（@dnd-kit/sortable）：
 *  - `useSortable({ id, disabled })` 恒定调用（不违反 hooks 规则）；
 *  - **整卡可拖**：`onPointerDown` 挂在 `<li>` 上；PointerSensor 由 NoteList 配置
 *    `activationConstraint: { distance: 5 }`，所以普通点击/双击不会误触发拖拽；
 *  - 右侧手柄 `<button>` 承担**键盘拖拽**（Space 拾起 → 方向键 → Space 放下 / Esc 取消），
 *    只挂 `attributes` + `onKeyDown`，**不挂 pointer 监听** —— 否则 pointerdown 冒泡到 `<li>`
 *    会二次激活，产生重复拖拽；
 *  - 拖拽在「非手动排序 / 搜索视图 / 回收站 / 标签视图（由 NoteList 传 reorderable=false）」下关闭。
 *
 * 标签（t18，解决用户「我没发现标签的用处」）：
 *  - 卡片上最多显示 **3 个**标签 + 「+k」；每个标签都是**可点的按钮**，
 *    点击即切到该标签的筛选视图（`onSelectTag` 或默认走 store 的 `focusTag`）；
 *  - 「+k」本身也是按钮：点开标签面板（比只有 number 更有用）；
 *  - 右键菜单第一组多出 **「标签…」**，打开 `components/ui` 的 `TagPickerDialog`
 *    （通用面板，由 editor 的 t23 提供，本文件只消费）；
 *  - 标签颜色来自 `tags` 目录里的 `tag.color`（md front-matter 的领域值，行内 style）；
 *    目录里查不到该名字时退回 `bg-accent` 的兜底点。
 *  - ⚠️ 标签行**不能**放进卡片正文的 `<button>` 里（按钮不能嵌套按钮），
 *    因此正文按钮只包标题+摘要，标签行是它的兄弟节点；整卡仍可点击选中（外层 div 负责）。
 *
 * 命中片段：`snippet` 已由 db 层转义并插入 `<mark>`，这里用 `dangerouslySetInnerHTML` 直接渲染，
 * **不做二次转义**；`<mark>` 的配色用 token 语义类（`bg-selection` / `text-text`）就地补齐。
 *
 * ⚠️ 订正（t9）：**并不存在全局 `mark { … }` 规则**（`index.css` / `theme.css` grep `mark` = 0 命中），
 * 高亮样式**只**由下面这一处消费端 token 类提供。不要再假设有全局兜底，也不要另加一条。
 */

import { useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { FolderInput, GripVertical, Pin, PinOff, RotateCcw, Tags, Trash2 } from 'lucide-react'
import type { FolderTreeNode, Note, Tag } from '@/types'
import { ContextMenu, ICON_STROKE, IconButton, TagPickerDialog } from '@/components/ui'
import type { MenuItemDef } from '@/components/ui'
import { cn, formatTime, plainSummary } from '@/lib/utils'
import { ConfirmDialog } from './ConfirmDialog'
import { MoveToFolderDialog } from './MoveToFolderDialog'
import { useTagCatalog } from './tag-catalog'
import type { TagCatalogEntry } from './tag-catalog'
import { focusTag, queueNoteTags } from './tag-actions'
import { fire } from './util'

/** 卡片上最多直接显示几个标签（其余折叠成「+k」） */
export const MAX_VISIBLE_TAGS = 3

export interface NoteCardProps {
  note: Note
  selected: boolean
  /** 命中片段（含 `<mark>`，db 层已转义）；有值时替换摘要行 */
  snippet?: string
  /** 是否允许拖拽排序（NoteList 统一判定后下传） */
  draggable: boolean
  /** 可选：文件夹树，提供后右键「移动到…」可用 */
  folders?: FolderTreeNode[]
  /** 可选：标签目录（颜色 + id 解析）；缺省时用兜底点、点击时以名字作 id */
  tags?: readonly Tag[]
  onSelect: (id: string) => void
  onTogglePin: (id: string) => void | Promise<void>
  onMoveToFolder: (id: string, folderId: string | null) => void | Promise<void>
  onRemove: (id: string) => void | Promise<void>
  onRestore: (id: string) => void | Promise<void>
  onHardDelete: (id: string) => void | Promise<void>
  /** 可选：覆盖式写入该笔记的标签；缺省走 `queueNoteTags`（真实 store 落库） */
  onSetTags?: (id: string, names: string[]) => void | Promise<void>
  /** 可选：点击某个标签名 → 切到该标签视图；缺省走 store 的 `focusTag` */
  onSelectTag?: (tagName: string, tagId: string) => void | Promise<void>
}

export function NoteCard({
  note,
  selected,
  snippet,
  draggable,
  folders,
  tags,
  onSelect,
  onTogglePin,
  onMoveToFolder,
  onRemove,
  onRestore,
  onHardDelete,
  onSetTags,
  onSelectTag,
}: NoteCardProps) {
  const inTrash = note.deletedAt !== null
  const [moveOpen, setMoveOpen] = useState(false)
  const [tagOpen, setTagOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: note.id, disabled: !draggable })

  const style: CSSProperties = {
    transform: transform
      ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)`
      : undefined,
    transition: transition ?? undefined,
    zIndex: isDragging ? 10 : undefined,
  }

  /**
   * 标签库（t34）：**与编辑器入口同构** —— `props.tags` 优先，缺省时首次打开面板懒加载
   * `tagsRepo.list()`，并记住本会话新建的名字。详见 ./tag-catalog.ts 的模块注释。
   */
  const tagCatalog = useTagCatalog(tags)

  /** 标签名 → 目录项（拿颜色与 id） */
  const catalogOf = (name: string): TagCatalogEntry | undefined =>
    tagCatalog.tags.find((tag) => tag.name.toLowerCase() === name.toLowerCase())

  const applyTags = (names: string[]) => {
    // 新出现的名字立刻并入本地标签库（与编辑器入口一致：新建后马上能再次勾选）
    const known = new Set(tagCatalog.tags.map((tag) => tag.name.toLowerCase()))
    for (const name of names) {
      if (!known.has(name.toLowerCase())) tagCatalog.rememberNewTag(name)
    }
    if (onSetTags) {
      fire(onSetTags(note.id, names))
      return
    }
    queueNoteTags(note.id, names)
  }

  const openTagByName = (name: string) => {
    const found = catalogOf(name)
    const id = found?.id ?? name
    if (onSelectTag) {
      fire(onSelectTag(name, id))
      return
    }
    void focusTag({ id, name })
  }

  /** 打开标签面板：顺手确保标签库已加载（幂等；有 props 时不查库） */
  const openTagPicker = () => {
    tagCatalog.ensureLoaded()
    setTagOpen(true)
  }

  const menuItems: MenuItemDef[] = inTrash
    ? [
        { id: 'restore', label: '恢复', icon: RotateCcw, onSelect: () => fire(onRestore(note.id)) },
        {
          id: 'hard-delete',
          label: '彻底删除',
          icon: Trash2,
          separatorBefore: true,
          onSelect: () => setConfirmDelete(true),
        },
      ]
    : [
        {
          id: 'pin',
          label: note.pinned ? '取消置顶' : '置顶',
          icon: note.pinned ? PinOff : Pin,
          onSelect: () => fire(onTogglePin(note.id)),
        },
        {
          id: 'tags',
          label: note.tags.length > 0 ? `标签…（${note.tags.length}）` : '标签…',
          icon: Tags,
          onSelect: () => openTagPicker(),
        },
        ...(folders
          ? [
              {
                id: 'move',
                label: '移动到…',
                icon: FolderInput,
                separatorBefore: true,
                onSelect: () => setMoveOpen(true),
              } satisfies MenuItemDef,
            ]
          : []),
        {
          id: 'remove',
          label: '移到回收站',
          icon: Trash2,
          shortcut: 'Ctrl+Del',
          separatorBefore: !folders,
          onSelect: () => fire(onRemove(note.id)),
        },
      ]

  const title = note.title.trim().length > 0 ? note.title : '无标题'
  const summary = plainSummary(note.content, 160)
  const visibleTags = note.tags.slice(0, MAX_VISIBLE_TAGS)
  const hiddenTagCount = note.tags.length - visibleTags.length

  return (
    <>
      <li
        ref={setNodeRef}
        style={style}
        data-note-id={note.id}
        data-selected={selected ? 'true' : undefined}
        onPointerDown={
          draggable
            ? (event: PointerEvent<HTMLLIElement>) => listeners?.onPointerDown?.(event)
            : undefined
        }
        className={cn(
          'group relative flex list-none rounded-zj',
          'transition-colors duration-150 ease-out',
          selected ? 'bg-selection' : 'hover:bg-hover',
          isDragging && 'shadow-zj',
        )}
      >
        <ContextMenu items={menuItems}>
          {/* 正文 + 标签行（列布局；标签行必须在正文按钮之外，避免按钮嵌套） */}
          <div
            className="flex min-w-0 flex-1 flex-col"
            onClick={() => onSelect(note.id)}
          >
            <button
              type="button"
              onClick={() => onSelect(note.id)}
              aria-current={selected ? 'true' : undefined}
              title={title}
              className={cn(
                /* pr-28（112px）= 悬停操作簇的精确占位：4×24(按钮) + 3×4(间隙) + 4(right-1)，
                   属 DESIGN §7.2 R5 备案例外（固定尺寸控件占位，超出刻度上限 32px）。
                   改动操作簇按钮数量/尺寸时必须同步改这里。 */
                'flex min-w-0 flex-col gap-1 rounded-zj pb-1 pl-3 pt-2 pr-28 text-left zj-focus-ring',
                isDragging && 'opacity-60',
              )}
            >
              <span className="flex min-w-0 items-center gap-1">
                {note.pinned ? (
                  <>
                    <Pin
                      size={12}
                      strokeWidth={ICON_STROKE}
                      aria-hidden
                      className="shrink-0 text-accent"
                    />
                    <span className="sr-only">已置顶</span>
                  </>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-ui font-medium text-text">
                  {title}
                </span>
              </span>

              {snippet ? (
                <p
                  className={cn(
                    'line-clamp-2 text-meta text-muted',
                    '[&_mark]:rounded-zj-sm [&_mark]:bg-selection [&_mark]:text-text',
                  )}
                  dangerouslySetInnerHTML={{ __html: snippet }}
                />
              ) : (
                <p className="line-clamp-2 text-meta text-muted">{summary || '（空白笔记）'}</p>
              )}
            </button>

            {/* 元信息行：更新时间 + 可点击标签 + 「+k」。
                本行位于标题按钮之下（y > 操作簇底边），不会被悬停操作簇覆盖，
                因此**不需要**右侧预留（原 pr-16 是无谓收窄，t29 移除）。 */}
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pb-2 pl-3">
              <span className="shrink-0 text-2xs text-muted">{formatTime(note.updatedAt)}</span>

              {visibleTags.map((name) => {
                const color = catalogOf(name)?.color
                return (
                  <button
                    key={name}
                    type="button"
                    data-tag-name={name}
                    data-tag-color={color ?? undefined}
                    title={`筛选标签「${name}」`}
                    onClick={(event) => {
                      event.stopPropagation()
                      openTagByName(name)
                    }}
                    className={cn(
                      'flex min-w-0 max-w-24 items-center gap-1 rounded-jz-sm px-1 text-2xs text-muted',
                      'transition-colors duration-150 ease-out hover:bg-selection hover:text-text',
                      'zj-focus-ring',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        color ? 'border border-border' : 'bg-accent',
                      )}
                      style={color ? { backgroundColor: color } : undefined}
                    />
                    <span className="min-w-0 truncate">{name}</span>
                  </button>
                )
              })}

              {hiddenTagCount > 0 ? (
                <button
                  type="button"
                  title={`还有 ${hiddenTagCount} 个标签，点开查看`}
                  onClick={(event) => {
                    event.stopPropagation()
                    openTagPicker()
                  }}
                  className={cn(
                    'shrink-0 rounded-zj-sm px-1 text-2xs text-muted',
                    'transition-colors duration-150 ease-out hover:bg-selection hover:text-text',
                    'zj-focus-ring',
                  )}
                >
                  +{hiddenTagCount}
                </button>
              ) : null}
            </div>
          </div>

          {/* 悬停/键盘聚焦时出现的行内操作（绝对定位，避免与正文挤位、也避免按钮嵌套） */}
          <span
            className={cn(
              /* gap-1（4px）：操作簇内按钮间隙，落在 DESIGN §2 刻度内 */
              'absolute right-1 top-1 flex items-center gap-1 rounded-zj-sm',
              'opacity-0 transition-opacity duration-150 ease-out',
              'group-hover:opacity-100 group-focus-within:opacity-100',
            )}
          >
            {draggable ? (
              <button
                type="button"
                ref={setActivatorNodeRef}
                {...attributes}
                onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) =>
                  listeners?.onKeyDown?.(event)
                }
                title="拖拽排序（Space 拾起 / 方向键移动 / Space 放下）"
                className={cn(
                  'grid h-6 w-6 cursor-grab place-items-center rounded-jz-sm text-muted',
                  'transition-colors duration-150 ease-out hover:bg-hover hover:text-text zj-focus-ring',
                )}
              >
                <GripVertical size={13} strokeWidth={ICON_STROKE} aria-hidden />
              </button>
            ) : null}

            {inTrash ? (
              <>
                <IconButton
                  icon={RotateCcw}
                  label="恢复"
                  tooltip
                  size="icon-sm"
                  onClick={() => fire(onRestore(note.id))}
                />
                <IconButton
                  icon={Trash2}
                  label="彻底删除"
                  tooltip
                  size="icon-sm"
                  onClick={() => setConfirmDelete(true)}
                />
              </>
            ) : (
              <>
                <IconButton
                  icon={Tags}
                  label="标签…"
                  tooltip
                  size="icon-sm"
                  onClick={() => openTagPicker()}
                />
                <IconButton
                  icon={note.pinned ? PinOff : Pin}
                  label={note.pinned ? '取消置顶' : '置顶'}
                  tooltip
                  size="icon-sm"
                  aria-pressed={note.pinned}
                  onClick={() => fire(onTogglePin(note.id))}
                />
                <IconButton
                  icon={Trash2}
                  label="移到回收站"
                  tooltip
                  size="icon-sm"
                  onClick={() => fire(onRemove(note.id))}
                />
              </>
            )}
          </span>
        </ContextMenu>
      </li>

      <MoveToFolderDialog
        note={moveOpen ? note : null}
        folders={folders ?? []}
        onOpenChange={setMoveOpen}
        onMove={onMoveToFolder}
      />

      <TagPickerDialog
        open={tagOpen}
        onOpenChange={setTagOpen}
        value={note.tags}
        // t34：传入**解析后的**标签库（props ∪ 懒加载 ∪ 本地新建），与编辑器入口同一来源
        tags={tagCatalog.tags}
        context={title}
        title="标签"
        emptyHint="输入名字回车即可新建标签，勾选后立即保存到这篇笔记"
        onChange={(next) => applyTags(next)}
      />

      <ConfirmDialog
        open={confirmDelete}
        title={`彻底删除「${note.title.trim() || '无标题'}」？`}
        description="笔记及其标签关联会被永久移除，无法恢复。"
        onOpenChange={setConfirmDelete}
        onConfirm={() => fire(onHardDelete(note.id))}
      />
    </>
  )
}
