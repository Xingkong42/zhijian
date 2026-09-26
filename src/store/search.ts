/**
 * searchStore —— 全文搜索状态（FROZEN 接口，实现归属：数据层 / 任务 t10）。
 *
 * 契约（docs/ARCHITECTURE.md §4.2 / §4.3 / §4.6）：
 *  - 字段与方法签名不得改：query / results / searching / error / search / clear。
 *  - `search(q)` 内部走 `searchRepo.search(q, limit)`（FTS5+trigram 优先、LIKE 兜底），
 *    结果是 SQLite 的真实命中，不做任何本地假数据。
 *  - 搜索 query / 结果只存在内存，**禁止落库**（§4.6）。
 *  - 失败收敛到 `error` 字段（中文可读），**不向组件抛错**。
 *
 * ## 竞态防护（搜索框最经典的 bug）
 * 快速输入时会有多个请求同时在飞，先发的旧请求可能后返回并覆盖新结果。本实现用
 * **单调整数请求序号 + 生效判定**，语义等价于 Abort：
 *   1. `search()` / `clear()` 入口都执行 `++requestSeq`（模块级序号，只增不减）；
 *   2. 每个 await 之后都判 `if (seq !== requestSeq) return` —— 只要期间又发生过一次
 *      `search()` 或 `clear()`，本次结果就**直接丢弃、不写回 store**；
 *   3. 因此「后发请求的结果必定覆盖先发请求」，迟到结果也永远不会把 `searching`
 *      改回 false 或覆盖 `results`。
 *  说明：tauri-plugin-sql 没有取消通道，无法中断已在执行的 SQL，故这里选择
 *  「丢弃迟到结果」而非真正 abort —— 对 UI 效果等价，且不会留下状态竞态。
 *
 * ## 防抖
 * store 侧 150ms（{@link SEARCH_DEBOUNCE_MS}），叠加 SearchBox 本地 120ms。
 * 防抖等待期间 `searching === true`；被新输入取代的旧等待会**立即 resolve**（不留悬空
 * Promise），随后在序号判定处退出 —— 保证 `search()` 返回的 Promise 一定 settle，
 * 调用方（`void Promise.resolve(run(value)).catch(...)`）不会积累未决 Promise。
 *
 * 消费方式：`const results = useSearchStore((s) => s.results)`
 */

import { create } from 'zustand'
import type { Note, SearchHit } from '@/types'
import { DEFAULT_SEARCH_LIMIT, searchRepo } from '@/db/search'
import { errorMessage } from '@/lib/utils'

export interface SearchState {
  query: string
  results: SearchHit[]
  /** 是否正在查询（UI 展示 pending 态） */
  searching: boolean
  /** 最近一次失败原因 */
  error: string | null

  /** 执行搜索；q 为空则清空结果 */
  search: (q: string) => Promise<void>
  /** 清空 query 与 results */
  clear: () => void
}

/** store 侧输入防抖窗口（ms）；SearchBox 另有 120ms 本地防抖 */
export const SEARCH_DEBOUNCE_MS = 150

/* ------------- 竞态 / 防抖的模块级状态（避免污染冻结字段） ------------- */

/** 单调整数请求序号：只有等于当前值的请求才允许写回结果 */
let requestSeq = 0

/** 正在等待的防抖窗口：计时器 + 其 Promise 的 settle 函数 */
let pendingDebounce: { timer: ReturnType<typeof setTimeout>; settle: () => void } | null = null

/** 立即结束等待中的防抖窗口（被新输入取代时调用；旧 Promise 随之 resolve 并按序号退出） */
function settlePendingDebounce(): void {
  if (!pendingDebounce) return
  const { timer, settle } = pendingDebounce
  pendingDebounce = null
  clearTimeout(timer)
  settle()
}

/** 等待防抖窗口；窗口自然结束时清空 pendingDebounce */
function waitDebounceWindow(): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      pendingDebounce = null
      resolve()
    }, SEARCH_DEBOUNCE_MS)
    pendingDebounce = { timer, settle: resolve }
  })
}

/* ================================ store ================================ */

export const useSearchStore = create<SearchState>()((set) => ({
  query: '',
  results: [],
  searching: false,
  error: null,

  search: async (q: string) => {
    // query 保留原始输入：SearchBox 用它回填输入框，trim 掉会让尾部空格在输入时消失
    const raw = typeof q === 'string' ? q : ''
    const keyword = raw.trim()
    const seq = ++requestSeq

    // 作废上一次等待中的防抖；被取代的调用会在序号判定处退出
    settlePendingDebounce()
    set({ query: raw, error: null })

    if (!keyword) {
      // 空串 / 纯空白：清空结果且**不发起任何查询**
      set({ results: [], searching: false })
      return
    }

    set({ searching: true })
    await waitDebounceWindow()
    if (seq !== requestSeq) return // 期间有更新的输入 → 丢弃本次

    try {
      const results = await searchRepo.search(keyword, DEFAULT_SEARCH_LIMIT)
      if (seq !== requestSeq) return // 迟到的旧结果绝不写回
      set({ results, searching: false, error: null })
    } catch (error) {
      if (seq !== requestSeq) return
      // 错误收敛到 error，不向组件抛出（契约 §2.4）
      set({ results: [], searching: false, error: errorMessage(error) })
    }
  },

  clear: () => {
    // 递增序号 → 任何在飞的请求都会被判为过期；同时结束等待中的防抖
    requestSeq += 1
    settlePendingDebounce()
    set({ query: '', results: [], searching: false, error: null })
  },
}))

/* ============================ 便捷 selector ============================ */

/** 命中片段映射：直接喂给 `NoteListProps.snippets`（noteId → 已转义含 <mark> 的片段） */
export const selectSnippets = (state: SearchState): Record<string, string> => {
  const snippets: Record<string, string> = {}
  for (const hit of state.results) snippets[hit.note.id] = hit.snippet
  return snippets
}

/** 命中的笔记列表：直接喂给 `NoteListProps.notes`（已按相关性排序） */
export const selectResultNotes = (state: SearchState): Note[] => state.results.map((hit) => hit.note)

/** 命中笔记 id → 相关度（诊断用；两条检索路径的 rank 只在同路径内可比） */
export const selectRanks = (state: SearchState): Record<string, number> => {
  const ranks: Record<string, number> = {}
  for (const hit of state.results) ranks[hit.note.id] = hit.rank
  return ranks
}

/** 重置为初始状态（测试 / 退出登录用；不落库） */
export function resetSearch(): void {
  requestSeq += 1
  settlePendingDebounce()
  useSearchStore.setState({ query: '', results: [], searching: false, error: null })
}

export default useSearchStore
