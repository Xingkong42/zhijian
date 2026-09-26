/**
 * 笔记列表的排序与拖拽下标换算（纯函数，可独立验证）。
 * 归属：src/features/notes-list/**（t5）。
 *
 * 关键语义（data 成员实测 + 代码确认）：
 *   `notesRepo.move(id, { targetIndex })` 的 `targetIndex` 是**目标文件夹规范序**下的下标：
 *   `pinned DESC, sort_order ASC, created_at ASC, id ASC`
 *   —— 见 src/db/notes.ts::move（`others = scope − id`，`insertAt = min(targetIndex, others.length)`）
 *   与 src/db/schema.ts 的 `scopeInbox/scopeFolder`。
 *
 *   本文件的 `sortNotes(notes, 'order')` **逐字段复刻**该规范序，因此：
 *   「全部笔记 / 文件夹视图」下 dnd 的显示下标与 `move` 的 targetIndex 是 1:1，
 *   拖拽落点精确；「标签视图」（集合不同）由集成层传 `reorderable={false}` 关掉拖拽，
 *   不下发猜测的 index（captain/data 的语义边界要求）。
 */

import type { Note } from '@/types'

export type NoteSortMode = 'order' | 'updatedAt' | 'createdAt' | 'title'

export interface NoteSortModeInfo {
  id: NoteSortMode
  label: string
  hint: string
}

/** 排序方式清单（表头下拉菜单用） */
export const NOTE_SORT_MODES: readonly NoteSortModeInfo[] = [
  { id: 'order', label: '手动排序', hint: '与拖拽排序一致' },
  { id: 'updatedAt', label: '最近更新', hint: '更新时间倒序' },
  { id: 'createdAt', label: '创建时间', hint: '创建时间倒序' },
  { id: 'title', label: '标题', hint: '标题升序' },
] as const

/** 置顶优先（0 = 置顶，排在前面，与 SQL 的 `pinned DESC` 一致） */
function pinnedRank(note: Note): number {
  return note.pinned ? 0 : 1
}

function titleOf(note: Note): string {
  return note.title.trim().length > 0 ? note.title : '无标题'
}

/**
 * 按指定模式排序（不修改入参）。
 * `'order'` 模式即 db 层规范序，其它模式仅影响展示（此时拖拽被禁用）。
 */
export function sortNotes(notes: readonly Note[], mode: NoteSortMode): Note[] {
  const list = [...notes]
  switch (mode) {
    case 'order':
      return list.sort(
        (a, b) =>
          pinnedRank(a) - pinnedRank(b) ||
          a.order - b.order ||
          a.createdAt - b.createdAt ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
    case 'updatedAt':
      return list.sort((a, b) => b.updatedAt - a.updatedAt || compareId(a, b))
    case 'createdAt':
      return list.sort((a, b) => b.createdAt - a.createdAt || compareId(a, b))
    case 'title':
      return list.sort(
        (a, b) => titleOf(a).localeCompare(titleOf(b), 'zh-CN') || compareId(a, b),
      )
    default: {
      const _exhaustive: never = mode
      return _exhaustive
    }
  }
}

function compareId(a: Note, b: Note): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export interface ReorderIntent {
  id: string
  targetIndex: number
}

/**
 * dnd 落点 → `notesStore.move(id, targetIndex)` 的入参。
 *
 * 同构性证明（为什么直接取「被悬停项的下标」）：
 *   - dnd-kit `arrayMove(list, from, to)`：先从数组移除 `active`，再插到下标 `to`；
 *   - `notesRepo.move`：`others = 规范序 − active`，`insertAt = min(targetIndex, others.length)`，
 *     最终顺序 = `others[0..insertAt] + [active] + others[insertAt..]`。
 *   两者在「移除自身后再插入到同一位置」这一点上完全一致，故 `targetIndex = overIndex`。
 */
export function resolveReorder(
  orderedIds: readonly string[],
  activeId: string,
  overId: string | null | undefined,
): ReorderIntent | null {
  if (!overId || overId === activeId) return null
  const from = orderedIds.indexOf(activeId)
  const to = orderedIds.indexOf(overId)
  if (from < 0 || to < 0) return null
  return { id: activeId, targetIndex: to }
}

/**
 * t36 结论（不要在这里"顺手换算"，会与 store/db 的修复互相打架）：
 *
 * dnd 落点下标是**显示列表**下标。它与下游的对应关系分两种：
 *  - 「文件夹」视图：显示列表 = 该文件夹集合 ⇒ 与 `notesRepo.move` 的**文件夹规范序下标**恒等；
 *  - 「全部笔记」视图：显示列表跨文件夹 ⇒ 文件夹子集**在数学上表达不了**全局位置
 *    （`move` 会在 `Math.min(targetIndex, others.length)` 处被夹紧，且各文件夹各自重排成
 *    `0..m-1` 的重叠值 ⇒ 整块可能移位；独自占一个文件夹的笔记 `others.length===0`
 *    导致插入位置恒为 0 ⇒ 用户看到的「拖了、松手又回原位」）。
 *
 * 因此精确修复**不能**放在这一层（曾尝试"把全局下标换算成文件夹下标"，那只改变失败形态、
 * 且会让 store 侧真正修好后的全局插入位置错位）。captain 已裁定方案 A：`store.move` 在
 * `activeView === 'all'` 时改调 db 的 `notesRepo.reorder(orderedIds)`（任务 t42，
 * 由 data 实现并改 store 那一行）。在那之前，本层继续如实传全局显示下标。
 */
