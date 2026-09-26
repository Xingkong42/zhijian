/**
 * SearchBox —— 侧栏顶部搜索框（R4 全文搜索的输入入口）。
 * 归属：src/features/sidebar/**（t5）。
 *
 * 接线（无 mock、无静默降级）：
 *   `SearchBox` 的 `search` 是**必传 prop**，值来自 `useSearchStoreSlice()`
 *   （见 ./search-store.ts，直接订阅 `src/store/search.ts` 的 `useSearchStore`）。
 *   `Sidebar` 始终传真实值：`props.search ?? useSearchStoreSlice().state`。
 *   `search === null` 表示真实 store 尚未就绪（骨架占位期），此时输入框 `disabled`
 *   并显示可见提示「搜索服务未就绪」——绝不出现「能打字但没有查询」的静默失效。
 *
 * 数据流：输入 → 150ms 防抖 → `searchStore.search(q)` → `searchRepo.search(q)`（db 层 FTS5）。
 * 空串：`search('')` 清空结果（契约），「清除」按钮走 `clear()`（清 query + results）。
 *
 * 命中片段：`SearchHit.snippet` 已由 db 层 `buildSnippet()` 做 HTML 转义并插入 `<mark>`，
 * 渲染方在 notes-list/NoteCard 用 `dangerouslySetInnerHTML` 直接输出，**不得二次转义**。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import { Search, TriangleAlert, X } from 'lucide-react'
import type { SearchState } from '@/store/search'
import { Input } from '@/components/ui'
import { matchesShortcut } from '@/lib/hotkeys'
import { cn } from '@/lib/utils'

/** 本地输入防抖（ms）：与 store 契约的 150ms 对齐（store 内部还有一层竞态丢弃） */
export const SEARCH_DEBOUNCE_MS = 150

export interface SearchBoxProps {
  /**
   * searchStore 状态切片（`useSearchStoreSlice().state`）；**必传**。
   * `null` = 真实 store 尚未就绪（骨架占位期）→ 输入框禁用 + 可见提示。
   */
  search: SearchState | null
  /** Ctrl+K 聚焦搜索框，默认开启 */
  focusShortcut?: boolean
  className?: string
  /** 无障碍：搜索框作为独立 region 时的标注 */
  'aria-label'?: string
}

export function SearchBox({
  search,
  focusShortcut = true,
  className,
  'aria-label': ariaLabel = '搜索笔记',
}: SearchBoxProps) {
  const ready = search !== null
  const storeQuery = search?.query ?? ''
  const [text, setText] = useState(storeQuery)
  const inputRef = useRef<HTMLInputElement>(null)
  const timerRef = useRef<number | null>(null)
  const warningId = 'zj-search-warning'

  // store 侧 query 变化（清空 / 快捷键 / 其它组件写入）时同步输入框
  useEffect(() => {
    setText(storeQuery)
  }, [storeQuery])

  const cancelPending = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => cancelPending, [cancelPending])

  const commit = useCallback(
    (value: string) => {
      const run = search?.search
      if (!run) return
      // store 内部把失败写进自己的 error 字段，这里只兜住 rejection
      void Promise.resolve(run(value)).catch(() => undefined)
    },
    [search],
  )

  const schedule = useCallback(
    (value: string) => {
      cancelPending()
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        commit(value)
      }, SEARCH_DEBOUNCE_MS)
    },
    [cancelPending, commit],
  )

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value
    setText(value)
    schedule(value)
  }

  const clear = useCallback(() => {
    cancelPending()
    setText('')
    if (search?.clear) {
      search.clear()
      return
    }
    commit('')
  }, [cancelPending, commit, search])

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (text.length > 0) clear()
      else inputRef.current?.blur()
    }
  }

  // Ctrl+K 聚焦（LOCAL_SHORTCUTS.search 的唯一事实来源在 src/lib/hotkeys.ts）
  useEffect(() => {
    if (!focusShortcut) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!matchesShortcut(event, 'search')) return
      event.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [focusShortcut])

  const active = storeQuery.trim().length > 0
  const hitCount = search?.results.length ?? 0

  return (
    <div className={cn('flex flex-col gap-1', className)} role="search" aria-label={ariaLabel}>
      <div className="relative">
        {/* 装饰位按 DESIGN §7.1 推荐模式：图标 left-3(12px) + 15px，输入框 pl-8(32px)（间隙 5px） */}
        <Search
          size={15}
          strokeWidth={1.75}
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
        />
        <Input
          ref={inputRef}
          inputSize="sm"
          value={text}
          onChange={onInputChange}
          onKeyDown={onInputKeyDown}
          placeholder={ready ? '搜索笔记…' : '搜索不可用'}
          aria-label={ariaLabel}
          aria-busy={search?.searching ?? false}
          aria-describedby={ready ? undefined : warningId}
          disabled={!ready}
          className="pl-8 pr-8"
        />
        {text.length > 0 ? (
          <button
            type="button"
            onClick={clear}
            aria-label="清除搜索"
            title="清除搜索"
            className={cn(
              'absolute right-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center',
              'rounded-zj-sm text-muted transition-colors duration-150 ease-out',
              'hover:bg-hover hover:text-text zj-focus-ring',
            )}
          >
            <X size={13} strokeWidth={1.75} aria-hidden />
          </button>
        ) : null}
      </div>

      {search ? (
        <p
          role="status"
          aria-live="polite"
          className={cn(
            'flex items-center gap-1 px-1 text-2xs',
            active ? 'text-text' : 'text-muted',
          )}
        >
          {search.searching ? '搜索中…' : active ? `${hitCount} 条命中` : '在标题与正文中搜索'}
        </p>
      ) : (
        <p
          id={warningId}
          role="status"
          className="flex items-center gap-1 px-1 text-2xs text-accent"
        >
          <TriangleAlert size={12} strokeWidth={1.75} aria-hidden />
          搜索服务未就绪（searchStore 尚未实现）
        </p>
      )}

      {search?.error ? (
        <p className="px-1 text-2xs text-accent" role="alert">
          {search.error}
        </p>
      ) : null}
    </div>
  )
}
