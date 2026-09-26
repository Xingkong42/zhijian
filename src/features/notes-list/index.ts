/**
 * src/features/notes-list —— 笔记列表（归属：t5 建立，t18 增强，见 docs/ARCHITECTURE.md §5）。
 *
 * 交付：
 *   - `NoteList.tsx`            导出 `NoteList`（props = 冻结 `NoteListProps` + 可选扩展）
 *   - `NoteCard.tsx`            卡片（标题/两行摘要/相对时间/标签/置顶/选中；悬停行内操作 + 右键菜单）
 *   - `MoveToFolderDialog.tsx`  「移动到…」文件夹选择器
 *   - `ConfirmDialog.tsx`       彻底删除二次确认
 *   - `ordering.ts`             排序模式 + `resolveReorder`（dnd 落点 → `notesStore.move` 的 targetIndex）
 *   - `scope.ts`                当前列表作用域（读 uiStore/notesStore，用于文案与空状态）
 *   - `tag-actions.ts`          标签动作桥：`queueNoteTags`（真实落库）/ `focusTag` / `focusAllNotes`
 *   - `util.ts`                 `fire` / `flattenFolders`
 *
 * 集成接线（App.tsx）：
 *   `<NoteList … onReorder={(id, index) => notesStore.move(id, index)} />`
 *   —— `NoteList` 不在本地重排，拖拽落点唯一出口就是这里的 `onReorder`。
 *   标签相关（t18）**不必须接线**：不传 `onSetTags`/`onSelectTag` 时，卡片会自己走
 *   store（`notesStore.update(id, { tags })` / `uiStore.setView('tag') + notesStore.listByTag`）。
 *   传 `tags={meta.tags}` 只是让颜色点更准、减少一次 resolve（强烈建议传）。
 */

export { NoteList } from './NoteList'
export type { NoteListComponentProps, NoteListExtraProps } from './NoteList'

export { NoteCard, MAX_VISIBLE_TAGS } from './NoteCard'
export type { NoteCardProps } from './NoteCard'

export { MoveToFolderDialog } from './MoveToFolderDialog'
export type { MoveToFolderDialogProps } from './MoveToFolderDialog'

export { ConfirmDialog } from './ConfirmDialog'
export type { ConfirmDialogProps } from './ConfirmDialog'

export { NOTE_SORT_MODES, resolveReorder, sortNotes } from './ordering'
export type { NoteSortMode, NoteSortModeInfo, ReorderIntent } from './ordering'

export { useListScope } from './scope'
export type { ListScope } from './scope'

/** t34：列表入口的标签库（与编辑器入口同一来源；见 ./tag-catalog.ts） */
export { useTagCatalog } from './tag-catalog'
export type { TagCatalog, TagCatalogEntry, TagCatalogSource } from './tag-catalog'

export { assignNoteTags, focusAllNotes, focusTag, queueNoteTags } from './tag-actions'

export { fire, flattenFolders } from './util'

/** 类型转发：调用方只需要 `@/features/notes-list` 一个入口 */
export type { NoteListProps } from '@/types'

/** 目录锚点（骨架期占位导出，保留以免破坏既有 import） */
export const NOTES_LIST_FEATURE = 'src/features/notes-list' as const
