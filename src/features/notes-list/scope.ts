/**
 * 当前列表视图的「作用域」（t18）。
 * 归属：src/features/notes-list/**。
 *
 * 为什么从 store 读而不是新增 props：
 *   `view / activeFolderId / activeTagId` 本来就在 `uiStore` / `notesStore` 里
 *   （App 的 `handleSelectView` 只负责在切换时把它们与集合查询配好对），
 *   `NoteList` 读它只是为了**文案与空状态**（例如「标签『重要』下还没有笔记」要告诉用户
 *   去哪加标签）。这样 App 不必为了文案再加 props；同时保留 `scopeOverride` 供隔离渲染/测试。
 *
 * 语义要点：`notesStore.activeTagId` 是**标签名**（id→名的解析在 `listByTag` 入口完成），
 * 而 `uiStore.activeTagId` 是 **Tag.id**（用于侧栏高亮）。两者不要混用。
 */

import { useNotesStore } from '@/store/notes'
import { useUiStore } from '@/store/ui'
import type { UiView } from '@/types'

export interface ListScope {
  view: UiView
  /** tag 视图下的标签名（显示用） */
  tagName: string | null
  /** folder 视图下的文件夹 id */
  folderId: string | null
}

/** 读取当前列表作用域（可选 override 便于隔离渲染） */
export function useListScope(scopeOverride?: UiView): ListScope {
  const storeView = useUiStore((state) => state.view)
  const storeFolderId = useUiStore((state) => state.activeFolderId)
  const storeTagName = useNotesStore((state) => state.activeTagId)

  const view = scopeOverride ?? storeView
  return {
    view,
    tagName: view === 'tag' ? storeTagName : null,
    folderId: view === 'folder' ? storeFolderId : null,
  }
}
