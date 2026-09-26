/**
 * searchStore 接线（src/features/sidebar/** —— 本 feature 唯一的搜索 store 出口）。
 *
 * 契约：`src/store/search.ts` 导出 `useSearchStore`（Zustand `create<SearchState>()`）
 * 与 `SearchState`（ARCHITECTURE §4.2 FROZEN）。本模块把它接到侧栏 UI 上。
 *
 * 为什么用 `getState()` + `subscribe()` 而不是在组件里直接 `useSearchStore(selector)`：
 *  - `useSearchStore` 就是 Zustand 的 store hook 本身，`create()` 返回的函数上恒定挂载
 *    `getState / setState / subscribe / getInitialState`；`useStore(hook, selector)` 内部
 *    也就是这两件事（订阅 + 快照比较）。因此 `getState + subscribe` 是**同一个 store 实例**的
 *    等价且框架无关的订阅方式 —— 不是 mock、不是本地状态。
 *  - 历史背景：`src/store/search.ts` 在骨架期曾是**占位实现**（`useSearchStore()` 直接 throw），
 *    用 vanilla API 接线可以在真实实现落地前后**自动生效**，不需要改本文件。
 *    **现状（t9 订正）：`src/store/search.ts` 已是真实 zustand store**，
 *    因此下文的 `status` 恒为 `'ready'`；保留形状探测只是防御性代码，不再是路径依赖。
 *  - 关键：**没有静默降级**，若 store 未就绪则 `status='pending'`，SearchBox 会显示
 *    「搜索服务未就绪」的可见提示，而不是假装搜过了。
 *
 * ⚠️ 禁止把 `search` 做成「可选 prop 且父组件不传」的静默路径：
 * `Sidebar` 始终传真实值（`props.search ?? useSearchStoreSlice().state`）。
 */

import { useEffect, useState } from 'react'
import { useSearchStore } from '@/store/search'
import type { SearchState } from '@/store/search'

/** Zustand store 的框架无关 API 形状 */
interface SearchStoreVanillaApi {
  getState: () => SearchState
  subscribe: (listener: () => void) => () => void
}

/** 搜索 store 的接线状态：`ready` = 真实 store 就绪；`pending` = 仍是骨架占位 */
export type SearchStoreStatus = 'ready' | 'pending'

export interface SearchStoreSlice {
  status: SearchStoreStatus
  /** 真实 store 状态；`pending` 时为 null（UI 必须显式提示，不得当作「无结果」） */
  state: SearchState | null
}

/**
 * 取出真实 searchStore 的 vanilla API。
 * `useSearchStore` 的类型在骨架期是 `(): never`（占位），因此这里显式做一次形状探测 ——
 * 只有真的拿到 `getState + subscribe` 才算就绪。
 */
export function searchStoreApi(): SearchStoreVanillaApi | null {
  const candidate = useSearchStore as unknown as Partial<SearchStoreVanillaApi> | undefined
  if (!candidate) return null
  if (typeof candidate.getState !== 'function' || typeof candidate.subscribe !== 'function') {
    return null
  }
  return candidate as SearchStoreVanillaApi
}

function readState(): SearchState | null {
  return searchStoreApi()?.getState() ?? null
}

/**
 * 订阅真实 searchStore 的完整状态（query / results / searching / error + search / clear）。
 * 任何一处 setState 都会推新快照给组件，与 `useSearchStore()` 行为一致。
 */
export function useSearchStoreSlice(): SearchStoreSlice {
  const [state, setState] = useState<SearchState | null>(() => readState())

  useEffect(() => {
    const store = searchStoreApi()
    if (!store) return
    setState(store.getState())
    return store.subscribe(() => setState(store.getState()))
  }, [])

  return { status: state === null ? 'pending' : 'ready', state }
}
