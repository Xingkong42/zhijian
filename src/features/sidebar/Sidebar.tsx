/**
 * Sidebar —— 侧栏（R6 文件夹 / R7 标签 / R4 搜索 / 回收站与设置入口）。
 * 归属：src/features/sidebar/**（t5 建立；t18 按用户反馈调整）。
 * Props 契约：`SidebarProps`（src/types/index.ts，FROZEN）+ 下面列出的**可选**扩展 props。
 *
 * 结构（docs/DESIGN.md §5：宽 224px / 折叠 48px、`bg-surface-2`、右侧 1px 边框）：
 *   ┌ 搜索框（SearchBox，真实接 searchStore）
 *   ├ 全部笔记 / 回收站（带计数徽标）
 *   ├ 导入 md 文件… / 导入文件夹…（t44：用户要求从设置面板挪到这里）
 *   ├ 文件夹（FolderTree：可展开、右键新建子文件夹/重命名/删除）
 *   ├ 标签（TagList：颜色点 + 计数、左键筛选、右键重命名/改颜色/删除）
 *   └ 设置入口 + 折叠按钮
 *
 * ⚠️ t18 变更：「收件箱」入口已按用户反馈**移除**（`folderId = null` 的笔记仍在
 * 「全部笔记」里可见，且「新建笔记」在非文件夹视图下默认就落在未归类状态）。
 * 原先的 `inboxCount()` 随之成为死码，已从 `./util.ts` 删除。
 *
 * 关于搜索接线（**无静默降级**）：
 *   `useSearchStoreSlice()` 直接订阅 `src/store/search.ts` 的 `useSearchStore`（真实 store，非 mock）。
 *   `SidebarProps` 之外新增的 `search?` 只是「隔离渲染/单测时注入切片」的覆盖入口，
 *   默认路径**永远是真实 store**；真实 store 未就绪时 SearchBox 会显示可见警告并禁用输入，
 *   不会出现「能打字但查不到」的静默失效。
 *
 * 标签管理接线（t18）：
 *   左键 = 筛选（走已存在的 `onSelectView('tag', tag.id)`）；右键三项 =
 *   重命名 / 改颜色 / 删除，分别走 `onRenameTag` / `onUpdateTagColor` / `onRemoveTag`。
 *   前两个是**新增的可选 props**（`SidebarProps` 没有它们），未接线时对应菜单项不渲染
 *   （宁可不显示，也不给一个点了没反应的假入口）。
 */

import { useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Files,
  FolderInput,
  FolderPlus,
  Hash,
  Loader,
  Search,
  Settings,
  Trash2,
  Upload,
} from 'lucide-react'
import type { SidebarProps } from '@/types'
import type { SearchState } from '@/store/search'
import { IconButton, ScrollArea, Separator } from '@/components/ui'
import { cn } from '@/lib/utils'
import { FolderTree } from './FolderTree'
import type { FolderCreateTarget } from './FolderTree'
import { SearchBox } from './SearchBox'
import { useSearchStoreSlice } from './search-store'
import { NavRow, SidebarGroup } from './rows'
import { TagList } from './TagList'
import type { TagColorHandler, TagRenameHandler } from './TagList'

export interface SidebarExtraProps {
  /**
   * 可选覆盖：直接注入 searchStore 切片（仅隔离渲染 / 单测用）。
   * 不传 = 走真实 store 接线；显式传 `null` = 声明「store 未就绪」，UI 显示可见警告。
   */
  search?: SearchState | null
  /**
   * 可选：重命名标签。未提供时 TagList 的「重命名」菜单项不渲染。
   * 集成层接线（App.tsx）：`(id, name) => tagsRepo.rename(id, name).then(reloadMeta)`
   */
  onRenameTag?: TagRenameHandler
  /**
   * 可选：修改标签颜色。未提供时「改颜色」菜单项不渲染。
   * 需要 db 侧新增 `tagsRepo.updateColor(id, color)`（当前 TagsRepo 无此方法，已同步 data）。
   */
  onUpdateTagColor?: TagColorHandler
  /**
   * t44：导入 md 笔记（用户要求把入口从设置面板挪到「全部笔记」下方）。
   *
   * `source` 语义与数据层 `importNotesFromDialog(source)` 一致：
   *  - `'files'`  = 多选若干 .md 文件；
   *  - `'folder'` = 选一个目录批量导入（保留子目录结构）。
   * 未提供时**不渲染**这两个入口（沿用本组件的既有约定：宁可不显示，
   * 也不给一个"点了没反应"的假入口 —— 浏览器预览下 App 就不会传它）。
   */
  onImportNotes?: (source: 'files' | 'folder') => void | Promise<void>
  /**
   * t44：正在导入的来源；不传/传 null 表示空闲。
   * 用于把入口置灰 + 换文案，避免用户连点两次发起两轮导入。
   */
  importing?: 'files' | 'folder' | null
}

/** 完整 props = 冻结的 SidebarProps + 可选扩展 */
export type SidebarComponentProps = SidebarProps & SidebarExtraProps

export function Sidebar({
  folders,
  tags,
  counts,
  view,
  activeFolderId,
  activeTagId,
  collapsed,
  onToggleCollapse,
  onSelectView,
  onCreateFolder,
  onRenameFolder,
  onRemoveFolder,
  onCreateTag,
  onRemoveTag,
  onRenameTag,
  onUpdateTagColor,
  onImportNotes,
  importing = null,
  search: searchOverride,
}: SidebarComponentProps) {
  // 真实 store 接线（getState + subscribe，等价于 useSearchStore(selector)）
  const wired = useSearchStoreSlice()
  const search = searchOverride === undefined ? wired.state : searchOverride

  const [creatingFolder, setCreatingFolder] = useState<FolderCreateTarget | null>(null)
  const [creatingTag, setCreatingTag] = useState(false)

  const startCreateFolder = () => {
    setCreatingTag(false)
    setCreatingFolder({ parentId: null, depth: 0 })
  }

  const startCreateTag = () => {
    setCreatingFolder(null)
    setCreatingTag(true)
  }

  return (
    <aside
      aria-label="导航"
      className={cn(
        'flex shrink-0 flex-col overflow-hidden border-r border-border bg-surface-2',
        collapsed ? 'w-12' : 'w-56',
      )}
    >
      {collapsed ? (
        <div className="flex flex-1 flex-col items-center gap-1 p-2">
          <IconButton icon={Search} label="搜索（展开侧栏）" tooltip onClick={onToggleCollapse} />
          <IconButton
            icon={Files}
            label="全部笔记"
            tooltip
            variant={view === 'all' ? 'secondary' : 'ghost'}
            aria-current={view === 'all' ? 'true' : undefined}
            onClick={() => onSelectView('all')}
          />
          <IconButton
            icon={Trash2}
            label={`回收站（${counts.trash}）`}
            tooltip
            variant={view === 'trash' ? 'secondary' : 'ghost'}
            aria-current={view === 'trash' ? 'true' : undefined}
            onClick={() => onSelectView('trash')}
          />
          <Separator className="my-1 w-6" />
          <IconButton icon={ChevronRight} label="展开侧栏" tooltip onClick={onToggleCollapse} />
          <IconButton
            icon={Settings}
            label="设置"
            tooltip
            variant={view === 'settings' ? 'secondary' : 'ghost'}
            aria-current={view === 'settings' ? 'true' : undefined}
            className="mt-auto"
            onClick={() => onSelectView('settings')}
          />
        </div>
      ) : (
        <>
          <div className="p-2">
            <SearchBox search={search} />
          </div>

          <ScrollArea className="min-h-0 flex-1 px-2 pb-2">
            <NavRow
              icon={Files}
              label="全部笔记"
              count={counts.all}
              active={view === 'all'}
              onClick={() => onSelectView('all')}
            />
            <NavRow
              icon={Trash2}
              label="回收站"
              count={counts.trash}
              active={view === 'trash'}
              onClick={() => onSelectView('trash')}
            />

            {/* t44：导入 md 笔记 —— 用户要求从设置面板挪到「全部笔记」下方。
                放在主导航（全部笔记 / 回收站）之后、文件夹分组之前：既紧邻笔记列表，
                又不把「全部笔记 / 回收站」这一对拆开。
                进行中：两行都 disabled + 当前那行换文案，避免连点发起第二轮导入。 */}
            {onImportNotes ? (
              <>
                <NavRow
                  icon={importing === 'files' ? Loader : Upload}
                  label={importing === 'files' ? '正在导入…' : '导入 md 文件…'}
                  title="选择一个或多个 .md 文件导入（不覆盖已有笔记）"
                  disabled={importing !== null}
                  onClick={() => void onImportNotes('files')}
                />
                <NavRow
                  icon={importing === 'folder' ? Loader : FolderInput}
                  label={importing === 'folder' ? '正在导入…' : '导入文件夹…'}
                  title="选一个文件夹批量导入（保留子目录结构，跳过 .obsidian 等隐藏目录）"
                  disabled={importing !== null}
                  onClick={() => void onImportNotes('folder')}
                />
              </>
            ) : null}

            <Separator className="my-2" />

            <SidebarGroup
              label="文件夹"
              action={
                <IconButton
                  icon={FolderPlus}
                  label="新建文件夹"
                  tooltip
                  size="icon-sm"
                  onClick={startCreateFolder}
                />
              }
            />
            <FolderTree
              folders={folders}
              counts={counts}
              view={view}
              activeFolderId={activeFolderId}
              creating={creatingFolder}
              onCreatingChange={setCreatingFolder}
              onSelect={(folderId) => onSelectView('folder', folderId)}
              onCreateFolder={onCreateFolder}
              onRenameFolder={onRenameFolder}
              onRemoveFolder={onRemoveFolder}
            />

            <SidebarGroup
              label="标签"
              action={
                <IconButton
                  icon={Hash}
                  label="新建标签"
                  tooltip
                  size="icon-sm"
                  onClick={startCreateTag}
                />
              }
            />
            <TagList
              tags={tags}
              counts={counts}
              view={view}
              activeTagId={activeTagId}
              creating={creatingTag}
              onCreatingChange={setCreatingTag}
              /* activeTagId 语义 = Tag.id（计数用 tag.name 查 counts.byTag） */
              onSelect={(tag) => onSelectView('tag', tag.id)}
              onCreateTag={onCreateTag}
              onRemoveTag={onRemoveTag}
              onRenameTag={onRenameTag}
              onUpdateTagColor={onUpdateTagColor}
            />
          </ScrollArea>

          <footer className="flex shrink-0 items-center gap-1 border-t border-border p-2">
            <NavRow
              icon={Settings}
              label="设置"
              active={view === 'settings'}
              className="flex-1"
              onClick={() => onSelectView('settings')}
            />
            <IconButton icon={ChevronLeft} label="折叠侧栏" tooltip onClick={onToggleCollapse} />
          </footer>
        </>
      )}
    </aside>
  )
}
