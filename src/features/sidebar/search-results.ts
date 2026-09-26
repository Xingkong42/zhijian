/**
 * 搜索结果 → 笔记列表 props 的适配器（把 R4 的高亮链路在代码里接死）。
 * 归属：src/features/sidebar/**（t5）。
 *
 * 为什么需要它：`NoteListProps.snippets`（`Record<noteId, string>`）是**冻结契约**，
 * 但 `searchStore.results` 是 `SearchHit[]`（含 note + snippet + rank）——
 * 两者之间的转换必须有人做，否则「搜索有结果但列表没有高亮片段」会在构建全绿的情况下静默失效。
 *
 * 集成层（t7）用法（3 行）：
 * ```tsx
 * const { state } = useSearchStoreSlice()
 * const results = searchHitsToNoteList(state?.results ?? [])
 * <NoteList query={state?.query ?? ''} notes={results.notes} snippets={results.snippets} … />
 * ```
 *
 * `snippet` 已由 db 层 `buildSnippet()` 完成 HTML 转义并插入 `<mark>`，
 * 渲染方（notes-list/NoteCard）直接 `dangerouslySetInnerHTML` 输出，**不要二次转义**。
 */

import type { Note, SearchHit } from '@/types'

export interface NoteListSearchSlice {
  /** 命中笔记（按 searchStore 的 rank 顺序，越小越相关） */
  notes: Note[]
  /** noteId → 命中片段（含 `<mark>` 标记，已转义） */
  snippets: Record<string, string>
}

export function searchHitsToNoteList(hits: readonly SearchHit[]): NoteListSearchSlice {
  const notes: Note[] = []
  const snippets: Record<string, string> = {}
  const seen = new Set<string>()

  for (const hit of hits) {
    const id = hit.note.id
    if (seen.has(id)) continue
    seen.add(id)
    notes.push(hit.note)
    if (hit.snippet.length > 0) snippets[id] = hit.snippet
  }

  return { notes, snippets }
}
