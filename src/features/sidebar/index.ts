/**
 * src/features/sidebar —— 侧边栏（归属：t5 建立，t18 调整，见 docs/ARCHITECTURE.md §5）。
 *
 * 交付：
 *   - `Sidebar.tsx`        导出 `Sidebar`（props = 冻结的 `SidebarProps` + 可选扩展）
 *   - `SearchBox.tsx`      搜索输入（150ms 防抖 → searchStore.search；空串清空结果）
 *   - `FolderTree.tsx`     文件夹树（展开/折叠、右键新建子文件夹/重命名/删除、行内编辑）
 *   - `TagList.tsx`        标签列表（颜色点 + 计数 + 左键筛选 + 右键重命名/改颜色/删除）
 *   - `TagColorDialog.tsx` 标签颜色选择（原生取色器 + 当前主题色板，源码零色值）
 *   - `tag-colors.ts`      运行时读取主题 token 作为色板
 *   - `search-store.ts`    真实 searchStore 接线（`useSearchStore` 的 getState + subscribe）
 *   - `search-results.ts`  `SearchHit[]` → `NoteListProps` 的 `notes` + `snippets`（高亮链路）
 *   - `rows.tsx` / `util.ts` / `ConfirmDialog.tsx`  共享视觉件与工具
 *
 * ⚠️ t18：`inboxCount` 已随「收件箱」入口一并删除（用户反馈该入口无用），
 * 替代导出是 `folderSubtreeNoteCount`（删除文件夹时如实提示影响范围）。
 */

export { Sidebar } from './Sidebar'
export type { SidebarComponentProps, SidebarExtraProps } from './Sidebar'

export { SearchBox, SEARCH_DEBOUNCE_MS } from './SearchBox'
export type { SearchBoxProps } from './SearchBox'

export { FolderTree } from './FolderTree'
export type { FolderCreateTarget, FolderTreeProps } from './FolderTree'

export { TagList } from './TagList'
export type { TagColorHandler, TagListProps, TagRenameHandler } from './TagList'

export { TagColorDialog } from './TagColorDialog'
export type { TagColorDialogProps } from './TagColorDialog'

export { isUsableColor, normalizeHexColor, themeTagSwatches } from './tag-colors'
export type { TagSwatch } from './tag-colors'

export { searchStoreApi, useSearchStoreSlice } from './search-store'
export type { SearchStoreSlice, SearchStoreStatus } from './search-store'

export { searchHitsToNoteList } from './search-results'
export type { NoteListSearchSlice } from './search-results'

export {
  collectFolderIds,
  fire,
  flattenFolders,
  folderAncestorIds,
  folderSubtreeNoteCount,
} from './util'

/** 类型转发：调用方只需要 `@/features/sidebar` 一个入口 */
export type { SidebarProps } from '@/types'

/** 目录锚点（骨架期占位导出，保留以免破坏既有 import） */
export const SIDEBAR_FEATURE = 'src/features/sidebar' as const
