/**
 * 列表入口的标签库（t34 修复：两个入口数据源不一致）。
 * 归属：src/features/notes-list/**。
 *
 * ## 修的是什么
 * 用户实测：点**卡片**的「标签…」显示「还没有任何标签」，而点**编辑器工具条**的标签按钮
 * 能正常列出 996/888。原因是两个入口各自接了一套数据：
 *   - 编辑器入口（`src/features/editor/EditorPane.tsx:361-385`）：`props.allTags` 优先，
 *     **缺省时首次打开面板用 `tagsRepo.list()` 拉一次**（App 并没有传 allTags）；
 *   - 列表入口（本目录）：只吃 `NoteList.tags` prop，而 `App.tsx` 当时没传 ⇒ 传进 TagPicker 的
 *     `tags` 是 undefined ⇒ 面板只剩「本笔记已有标签」⇒ 没打过标签的笔记显示「还没有任何标签」。
 *
 * ## 现在怎么统一
 * 本模块与编辑器入口**逐条同构**：`props 优先 → 缺省 lazy 调 tagsRepo.list()`，
 * 并且「新建的标签名立刻并入本地库」（两边都是这个行为）。
 * 两边都只经 `@/db/tags` 这一个来源，因此不存在第二套数据。
 *
 * 机器化防回归：`__checks__/tag-source-consistency.check.mjs` 会静态断言
 * 「EditorPane 与本模块解析标签库的优先级、来源、以及传给 TagPickerDialog 的字段完全一致」，
 * 任一侧漂移就退非零（可挂到 `pnpm check:all`）。
 *
 * ⚠️ 关于分层：`src/features/README.md` 说 feature 只依赖 store/ui/lib/types，
 * 但标签库在 store 层没有对应出口（`notesStore.knownTagNames` 是懒填充的名字集合、无颜色，
 * 在「全部笔记」视图下为空），而 t23 的编辑器入口已经直接从 `@/db/tags` 取（captain 授权）。
 * 因此这里沿用同一来源、同一优先级 —— **一致性优先于重复抽象**；
 * 若日后把标签库上提到 store（`src/store/tags.ts`），两个入口一起改即可（本文件是唯一出口）。
 */

import { useCallback, useRef, useState } from 'react'
import { tagsRepo } from '@/db/tags'
import type { Tag } from '@/types'

/** 归一化后的标签库条目（`id` 可能为 null：本会话刚新建、索引还没回读） */
export interface TagCatalogEntry {
  name: string
  /** 空串 = 未指定颜色（面板会用兜底点） */
  color: string
  id: string | null
}

export type TagCatalogSource = 'props' | 'repo' | 'empty'

export interface TagCatalog {
  /** 交给 TagPicker 的可勾选列表（props ∪ 本地新建 ∪ 懒加载结果，按名称忽略大小写去重） */
  tags: readonly TagCatalogEntry[]
  /** 实际生效的来源（诊断/断言用） */
  source: TagCatalogSource
  /** 打开面板时调一次（幂等）：没有 props 时才真正去查库 */
  ensureLoaded: () => void
  /** 新建标签后立刻并入，保证「刚建的马上能再勾选」（与编辑器入口一致） */
  rememberNewTag: (name: string) => void
  /** 拉取标签库失败的原因（面板仍可用：可选择本笔记已有标签 + 新建） */
  error: string | null
}

function toEntry(name: string, color: string | null | undefined, id: string | null): TagCatalogEntry {
  return { name, color: color ?? '', id }
}

/** 按名称（忽略大小写）合并，先出现的优先（props > 本地新建 > 懒加载） */
function mergeEntries(...groups: readonly (readonly TagCatalogEntry[])[]): TagCatalogEntry[] {
  const byKey = new Map<string, TagCatalogEntry>()
  for (const group of groups) {
    for (const entry of group) {
      const key = entry.name.trim().toLowerCase()
      if (key.length === 0 || byKey.has(key)) continue
      byKey.set(key, entry)
    }
  }
  return [...byKey.values()]
}

/**
 * 解析列表入口的标签库。
 *
 * @param propTags `NoteList.tags`（App 传 `meta.tags` 时走这条；未传时回落到 `tagsRepo.list()`）
 */
export function useTagCatalog(propTags: readonly Tag[] | undefined): TagCatalog {
  const [repoTags, setRepoTags] = useState<readonly TagCatalogEntry[]>([])
  const [localNames, setLocalNames] = useState<readonly string[]>([])
  const [error, setError] = useState<string | null>(null)
  /** 只尝试拉取一次（与 EditorPane 的 `catalogLoadedRef` 同构） */
  const loadedRef = useRef(false)

  const propEntries = (propTags ?? []).map((tag) => toEntry(tag.name, tag.color, tag.id))
  const hasProps = propEntries.length > 0

  const ensureLoaded = useCallback(() => {
    if (hasProps || loadedRef.current) return
    loadedRef.current = true
    void tagsRepo
      .list()
      .then((list) => {
        setRepoTags(list.map((tag) => toEntry(tag.name, tag.color, tag.id)))
        setError(null)
      })
      .catch((reason: unknown) => {
        // 不静默：面板仍可用（展示本笔记已有标签 + 允许新建），但必须留下线索
        const message = reason instanceof Error ? reason.message : String(reason)
        setError(message)
        console.warn('[纸笺] 列表标签入口读取标签库失败，面板仅展示本笔记已有标签：', reason)
      })
  }, [hasProps])

  const rememberNewTag = useCallback((name: string) => {
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    setLocalNames((prev) =>
      prev.some((item) => item.toLowerCase() === trimmed.toLowerCase()) ? prev : [...prev, trimmed],
    )
  }, [])

  const tags = mergeEntries(
    propEntries,
    localNames.map((name) => toEntry(name, '', null)),
    repoTags,
  )

  const source: TagCatalogSource = hasProps ? 'props' : tags.length > 0 ? 'repo' : 'empty'

  return { tags, source, ensureLoaded, rememberNewTag, error }
}
