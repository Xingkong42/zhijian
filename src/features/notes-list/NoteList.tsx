/**
 * NoteList —— 笔记卡片列表（R1 增删改查入口 + R8 拖拽排序 + 搜索结果高亮载体 + t18 标签体验）。
 * 归属：src/features/notes-list/**。Props 契约：`NoteListProps`（src/types/index.ts，FROZEN）
 * + 文件末尾列出的**可选**扩展 props（附加式，不改变冻结契约）。
 *
 * 交付能力：
 *  - 卡片：标题 / 两行摘要（搜索时换成含 `<mark>` 的命中片段）/ 相对更新时间 / 标签 / 置顶标记；
 *  - 操作：新建、置顶、打标签、删除、恢复、彻底删除、移动到文件夹；
 *  - 选中高亮：`aria-current` + `bg-selection`；
 *  - 排序：手动排序（默认，与 db 规范序一致）/ 最近更新 / 创建时间 / 标题；
 *  - 拖拽：@dnd-kit/sortable，`PointerSensor` + `activationConstraint.distance = 5` 防误触，
 *    另有 `KeyboardSensor` 支持键盘拖拽；`onDragEnd` 只做一件事：把落点换算成 targetIndex
 *    后调用 **`onReorder(id, targetIndex)`**，**不在本地重排**、不伪造顺序；
 *  - 作用域文案 / 空状态（t18）：从 `uiStore`/`notesStore` 读当前视图，标签视图的空状态
 *    会**明确告诉用户去哪加标签**（用户反馈「我没发现标签的用处」的直接修复点之一）。
 *
 * 拖拽生效范围（data 的语义边界）：`move` 的 targetIndex 是「目标文件夹规范序」下标，
 * 因此只在「手动排序 + 非搜索视图 + 非回收站 + reorderable !== false」时开启拖拽；
 * 标签视图的集合与规范序不是 1:1，由集成层传 `reorderable={false}`。
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { Announcements, DragEndEvent, ScreenReaderInstructions } from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { ArrowUpDown, Check, FileText, Plus, SearchX, Tags, Trash2 } from 'lucide-react'
import type { FolderTreeNode, NoteListProps, Tag, UiView } from '@/types'
import { Button, DropdownMenu, EmptyState, IconButton } from '@/components/ui'
import type { MenuItemDef } from '@/components/ui'
import { cn, truncate } from '@/lib/utils'
import { NoteCard } from './NoteCard'
import { NOTE_SORT_MODES, resolveReorder, sortNotes } from './ordering'
import type { NoteSortMode } from './ordering'
import { useListScope } from './scope'
import { focusAllNotes } from './tag-actions'
import { fire } from './util'

export interface NoteListExtraProps {
  /** 可选：文件夹树（提供后卡片右键「移动到…」可用） */
  folders?: FolderTreeNode[]
  /** 可选：是否允许拖拽排序（默认 true）；标签视图建议传 false */
  reorderable?: boolean
  /** 可选：初始排序方式（默认 'order' 手动排序） */
  defaultSortMode?: NoteSortMode
  /** 可选：搜索进行中（与 loading 区分，仅影响表头文案） */
  searching?: boolean
  /** 可选：标签目录（卡片标签颜色 + 点击筛选的 id 解析 + 「标签…」面板的候选） */
  tags?: readonly Tag[]
  /** 可选：覆盖式写入标签；缺省由 NoteCard 走 store（`queueNoteTags`） */
  onSetTags?: (id: string, names: string[]) => void | Promise<void>
  /** 可选：点击标签 → 切视图；缺省由 NoteCard 走 store 的 `focusTag` */
  onSelectTag?: (tagName: string, tagId: string) => void | Promise<void>
  /** 可选：强制指定作用域（隔离渲染/测试用）；缺省读 uiStore/notesStore */
  scope?: UiView
  /**
   * t46：清空回收站（永久删除回收站里的全部笔记）。
   * **只在回收站视图渲染**（`scope.view === 'trash'`），未接线或回收站为空时整块不出现 ——
   * 沿用本组件的既有约定：宁可不显示，也不给一个点了没反应的假入口。
   */
  onEmptyTrash?: () => void | Promise<void>
}

/** 完整 props = 冻结的 NoteListProps + 可选扩展 */
export type NoteListComponentProps = NoteListProps & NoteListExtraProps

const SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable: '按空格拾起笔记，上下方向键移动到目标位置，空格放下，Esc 取消。',
}

export function NoteList({
  notes,
  selectedId,
  loading,
  query,
  snippets,
  folders,
  reorderable = true,
  defaultSortMode = 'order',
  searching = false,
  tags,
  onSetTags,
  onSelectTag,
  scope: scopeOverride,
  onEmptyTrash,
  onSelect,
  onCreate,
  onTogglePin,
  onReorder,
  onMoveToFolder,
  onRemove,
  onRestore,
  onHardDelete,
}: NoteListComponentProps) {
  const [sortMode, setSortMode] = useState<NoteSortMode>(defaultSortMode)
  const scope = useListScope(scopeOverride)
  const searchMode = query.trim().length > 0
  const inTrash = useMemo(() => notes.some((note) => note.deletedAt !== null), [notes])

  // 搜索视图保持 db 返回的 rank 顺序，不被排序方式改写
  const ordered = useMemo(
    () => (searchMode ? [...notes] : sortNotes(notes, sortMode)),
    [notes, sortMode, searchMode],
  )

  const ids = useMemo(() => ordered.map((note) => note.id), [ordered])

  const dragEnabled =
    reorderable && sortMode === 'order' && !searchMode && !inTrash && ordered.length > 1

  const indexOf = (id: string | number) => ids.indexOf(String(id)) + 1

  const announcements: Announcements = useMemo(
    () => ({
      onDragStart: ({ active }) =>
        `已拾起第 ${indexOf(active.id)} 条笔记，按上下方向键移动，空格放下，Esc 取消`,
      onDragOver: ({ active, over }) =>
        over ? `第 ${indexOf(active.id)} 条将移到第 ${indexOf(over.id)} 位` : undefined,
      onDragEnd: ({ active, over }) =>
        over
          ? `已把第 ${indexOf(active.id)} 条移动到第 ${indexOf(over.id)} 位`
          : `已取消移动第 ${indexOf(active.id)} 条`,
      onDragCancel: () => '已取消排序',
    }),
    // indexOf 依赖 ids，ids 变化时需要重建公告文案
    [ids], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = (event: DragEndEvent) => {
    if (!dragEnabled) return
    // 落点下标 = **显示列表**下标。它与下游的对应关系（t36 查清，决定不改这一层）：
    //  - 「文件夹」视图：显示列表就是该文件夹的集合 ⇒ 下标天然等于 `notesRepo.move` 的
    //    文件夹规范序下标（恒等）；
    //  - 「全部笔记」视图：显示列表跨文件夹，`notesRepo.move` 的文件夹子集**表达不了**全局位置
    //    ⇒ 这一层的精确修复在 store/db（captain 裁定方案 A：`store.move` 在 activeView==='all'
    //    时改调 `notesRepo.reorder(orderedIds)`，任务 t42），因此这里**必须继续传全局显示下标**，
    //    不能自行换算成文件夹下标（那会让 reorder 的插入位置错位）。
    //    在 t42 落地前，跨文件夹拖拽仍会落不到目标位（已如实上报，不作为静默降级）。
    const intent = resolveReorder(
      ids,
      String(event.active.id),
      event.over ? String(event.over.id) : null,
    )
    if (!intent) return
    // 唯一落点：交给集成层 → notesStore.move(id, targetIndex) 持久化
    fire(onReorder(intent.id, intent.targetIndex))
  }

  const sortItems: MenuItemDef[] = NOTE_SORT_MODES.map((mode) => ({
    id: mode.id,
    label: mode.label,
    icon: mode.id === sortMode ? Check : undefined,
    shortcut: mode.hint,
    onSelect: () => setSortMode(mode.id),
  }))

  const folderName = scope.folderId ? findFolderName(folders ?? [], scope.folderId) : null

  const headerLabel = searchMode
    ? `搜索「${truncate(query.trim(), 16)}」· ${ordered.length} 条`
    : scope.view === 'tag'
      ? `标签「${truncate(scope.tagName ?? '未知', 12)}」· ${ordered.length} 条`
      : scope.view === 'trash'
        ? `回收站 · ${ordered.length} 条`
        : scope.view === 'folder'
          ? `${truncate(folderName ?? '文件夹', 12)} · ${ordered.length} 条`
          : `全部笔记 · ${ordered.length} 条`

  const emptyStateCopy = resolveEmptyState({
    searchMode,
    searching,
    inTrash,
    isTagView: scope.view === 'tag',
    tagName: scope.tagName,
    folderName,
    isFolderView: scope.view === 'folder',
  })

  return (
    <section
      aria-label="笔记列表"
      className="flex min-h-0 w-72 shrink-0 flex-col border-r border-border bg-bg"
    >
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-surface px-2">
        <span
          className="min-w-0 flex-1 truncate text-meta text-muted"
          role="status"
          aria-live="polite"
        >
          {headerLabel}
        </span>

        <DropdownMenu
          trigger={<IconButton icon={ArrowUpDown} label="排序方式" tooltip size="icon-sm" />}
          items={sortItems}
          align="end"
          disabled={searchMode}
          menuClassName="min-w-44"
        />

        {/* t46：清空回收站 —— 只在回收站视图、且确实有东西可清时出现（永久删除，走二次确认） */}
        {scope.view === 'trash' && onEmptyTrash ? (
          <Button
            variant="subtle"
            size="sm"
            icon={Trash2}
            data-zj="empty-trash"
            disabled={ordered.length === 0}
            title="永久删除回收站里的全部笔记（不可恢复）"
            onClick={() => fire(onEmptyTrash())}
          >
            清空
          </Button>
        ) : null}

        <Button
          variant="default"
          size="sm"
          icon={Plus}
          onClick={() => fire(onCreate())}
          title="新建笔记（Alt+N）"
        >
          新建
        </Button>
      </header>

      {loading ? (
        <SkeletonRows />
      ) : ordered.length === 0 ? (
        <EmptyState
          size="compact"
          className="flex-1"
          icon={emptyStateCopy.icon}
          title={emptyStateCopy.title}
          description={emptyStateCopy.description}
          action={emptyStateCopy.action}
        />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          accessibility={{
            announcements,
            screenReaderInstructions: SCREEN_READER_INSTRUCTIONS,
          }}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <ul
              role="list"
              className={cn('zj-scroll flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1')}
            >
              {ordered.map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  selected={note.id === selectedId}
                  snippet={snippets[note.id]}
                  draggable={dragEnabled}
                  folders={folders}
                  tags={tags}
                  onSelect={onSelect}
                  onTogglePin={onTogglePin}
                  onMoveToFolder={onMoveToFolder}
                  onRemove={onRemove}
                  onRestore={onRestore}
                  onHardDelete={onHardDelete}
                  onSetTags={onSetTags}
                  onSelectTag={onSelectTag}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <footer className="flex h-6 shrink-0 items-center gap-2 border-t border-border px-2 text-2xs text-muted">
        <span>
          {dragEnabled ? '可拖拽排序' : sortMode === 'order' ? '排序：手动' : '排序已切换'}
        </span>
        {searchMode ? <span>相关度优先</span> : null}
      </footer>
    </section>
  )
}

interface EmptyStateInput {
  searchMode: boolean
  searching: boolean
  inTrash: boolean
  /** 是否处于标签视图（与 tagName 分开：切过去的瞬间名字可能还没解析出来） */
  isTagView: boolean
  tagName: string | null
  folderName: string | null
  isFolderView: boolean
}

interface EmptyStateCopy {
  icon: LucideIcon
  title: string
  description: string
  action?: ReactNode
}

/** 在文件夹树里按 id 找名字（找不到返回 null） */
function findFolderName(nodes: readonly FolderTreeNode[], id: string): string | null {
  for (const node of nodes) {
    if (node.id === id) return node.name
    const found = findFolderName(node.children, id)
    if (found !== null) return found
  }
  return null
}

/**
 * 空状态文案（t18 重点：标签视图必须**教用户怎么加标签**）。
 * 「用户第一次用标签」的最短路径就写在这里：卡片上的标签按钮 / 右键「标签…」/
 * 编辑器工具条的标签按钮（由 editor 的 t23 提供）三条路都点明。
 *
 * 导出为纯函数便于单独断言（不依赖 store / DOM）。
 */
export function resolveEmptyState({
  searchMode,
  searching,
  inTrash,
  isTagView,
  tagName,
  folderName,
  isFolderView,
}: EmptyStateInput): EmptyStateCopy {
  if (searchMode) {
    return {
      icon: SearchX,
      title: '没有匹配的笔记',
      description: searching ? '正在搜索…' : '试试更短的关键词，或在侧栏清除搜索条件。',
    }
  }
  if (inTrash) {
    return {
      icon: Trash2,
      title: '回收站是空的',
      description: '删除的笔记会先放到这里，可随时恢复。',
    }
  }
  if (isTagView) {
    return {
      icon: Tags,
      title: tagName ? `标签「${tagName}」下还没有笔记` : '这个标签下还没有笔记',
      description:
        `打开任意一篇笔记，点卡片右上角的「标签…」（编辑器的标签按钮也能打开同一个面板），` +
        `勾上${tagName ? `「${tagName}」` : '它'}并回车即可。标签是写在笔记文件里的，勾上就立刻生效。`,
      action: (
        <Button variant="outline" size="sm" onClick={() => void focusAllNotes()}>
          去全部笔记里挑一篇
        </Button>
      ),
    }
  }
  if (isFolderView) {
    return {
      icon: FileText,
      title: folderName ? `「${folderName}」里还没有笔记` : '这个文件夹里还没有笔记',
      description: '可以在这里新建，或把已有笔记用右键「移动到…」挪进来。',
    }
  }
  return {
    icon: FileText,
    title: '还没有笔记',
    description: '按 Alt+N，或点右上角「新建」写下第一条。',
  }
}

/** 载入骨架（只有透明度脉动，符合 DESIGN「不做位移动画」；reduced-motion 下自动停） */
function SkeletonRows() {
  return (
    <ul role="list" aria-busy="true" className="flex flex-1 flex-col gap-1 p-1">
      <li className="sr-only" role="status">
        载入中…
      </li>
      {[0, 1, 2].map((row) => (
        <li key={row} className="flex flex-col gap-2 rounded-zj px-3 py-2" aria-hidden>
          <span className="h-3 w-2/3 animate-pulse rounded-zj-sm bg-surface-2 motion-reduce:animate-none" />
          <span className="h-3 w-full animate-pulse rounded-zj-sm bg-surface-2 motion-reduce:animate-none" />
        </li>
      ))}
    </ul>
  )
}
