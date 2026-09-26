/**
 * useAutoSave —— 防抖自动保存（默认 500ms，契约区间 400–600ms）。
 * 归属：编辑器成员（任务 t4）。
 *
 * 这个 hook 只做三件事：合并负载、防抖、把负载交给调用方落库。
 * 真正的落库（notesStore.update / props 回调）由调用方在 onFlush 里完成。
 *
 * ## 为什么需要 scopeKey（换笔记不串写的关键）
 *
 * 已知易错点：在 A 里打字后 500ms 内切到 B，防抖定时器到点时若调用「当前」的保存
 * 回调，就会把 A 的正文写进 B。这里用两条机制同时封堵：
 *
 *  1. **负载自带作用域**：`schedule()` 记录的负载带 `scopeKey`（= 笔记 id）；
 *  2. **切换时用「切换前那次渲染」捕获的回调冲刷**：
 *     React 在 scopeKey 变化时先执行上一次 effect 的 cleanup，而 cleanup 闭包里的
 *     `onFlush` 正是产生这份内容时的那个回调实例（它闭包捕获的是旧笔记），
 *     因此未落库内容会被写回**它自己的**笔记。
 *
 * 由此对集成层有一条硬性要求（见同目录 README.md）：
 * `onContentChange/onTitleChange` 必须写入「本次渲染的 note」，不要从 store 里
 * 现读 selectedId —— 否则「捕获旧回调」这层保护会失效。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '@/lib/utils'

/** 防抖自动保存延时（契约要求 400–600ms） */
export const DEFAULT_AUTO_SAVE_DELAY_MS = 500

export interface AutoSavePayload {
  content?: string
  title?: string
}

export type AutoSaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

export interface UseAutoSaveOptions {
  /** 文档作用域（笔记 id）；null 表示当前没有文档 */
  scopeKey: string | null
  /** 防抖延时，默认 DEFAULT_AUTO_SAVE_DELAY_MS */
  delayMs?: number
  /**
   * 落库回调。**必须**在调用它的那次渲染里捕获「当前文档」的保存动作，
   * 这样切换文档时的兜底冲刷才能写回正确的文档。
   */
  onFlush: (payload: AutoSavePayload, scopeKey: string) => void | Promise<void>
}

export interface AutoSaveController {
  status: AutoSaveStatus
  error: string | null
  /** 最近一次成功落库的时间戳（毫秒） */
  lastSavedAt: number | null
  /** 是否有未落库的改动（已 schedule 但还没提交） */
  hasPending: boolean
  /** 合并改动并重置防抖计时 */
  schedule: (patch: AutoSavePayload) => void
  /** 立即冲刷（Ctrl/Cmd+S、失焦、卸载前） */
  flush: () => void
  /** 丢弃未落库改动（例如内容被外部整体替换） */
  cancel: () => void
}

interface PendingSave {
  scopeKey: string | null
  payload: AutoSavePayload
}

function hasField(payload: AutoSavePayload): boolean {
  return payload.content !== undefined || payload.title !== undefined
}

export function useAutoSave({
  scopeKey,
  delayMs = DEFAULT_AUTO_SAVE_DELAY_MS,
  onFlush,
}: UseAutoSaveOptions): AutoSaveController {
  const pendingRef = useRef<PendingSave | null>(null)
  const timerRef = useRef<number | null>(null)
  /**
   * t32：**落库串行化**。
   *
   * 用户反馈「拼音和汉字同入 / 光标跳回首行，有概率，感觉跟实时保存有关」——
   * 根因之一就是两次 `onFlush` 可以同时在飞（写盘 + 索引重建耗时不定），
   * 于是「较旧的那次写入」可能后 resolve，把上层（store）里的内容**回退**成旧值，
   * 再经 props 回写编辑器。这里从源头消除：同一时刻只允许一笔在飞，
   * 期间到达的新负载只保留**最新一次**（合并语义与防抖一致），等上一笔落定再发。
   * 这样写入顺序 = 用户输入顺序，不会再有"旧的后到"。
   */
  const inFlightRef = useRef(0)
  const queueRef = useRef<{
    scopeKey: string | null
    payload: AutoSavePayload
    flush: UseAutoSaveOptions['onFlush']
  } | null>(null)
  const commitRef = useRef<(job: {
    scopeKey: string | null
    payload: AutoSavePayload
    flush: UseAutoSaveOptions['onFlush']
  }) => void>(() => {})
  /** 最新一次渲染的 onFlush（供防抖定时器使用；同一作用域内它总是对的） */
  const latestFlushRef = useRef(onFlush)
  const [status, setStatus] = useState<AutoSaveStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [hasPending, setHasPending] = useState(false)

  useEffect(() => {
    latestFlushRef.current = onFlush
  }, [onFlush])

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  /** 队列里还有货就继续发（串行推进） */
  const drainQueue = useCallback(() => {
    const next = queueRef.current
    queueRef.current = null
    if (!next) return
    commitRef.current(next)
  }, [])

  const commit = useCallback(
    (job: {
      scopeKey: string | null
      payload: AutoSavePayload
      flush: UseAutoSaveOptions['onFlush']
    }) => {
      const { payload, scopeKey: scope, flush } = job
      if (!hasField(payload)) return

      // 已有在飞的一笔：只保留最新负载，排队等它回来（写入顺序 = 输入顺序）
      if (inFlightRef.current > 0) {
        queueRef.current = job
        setHasPending(true)
        setStatus('saving')
        return
      }

      setStatus('saving')
      setError(null)
      inFlightRef.current += 1

      const settle = (failure: unknown | null) => {
        inFlightRef.current -= 1
        if (failure === null) {
          setStatus('saved')
          setLastSavedAt(Date.now())
        } else {
          setStatus('error')
          setError(errorMessage(failure))
        }
        drainQueue()
      }

      let result: void | Promise<void>
      try {
        result = flush(payload, scope ?? '')
      } catch (syncError) {
        settle(syncError)
        return
      }
      void Promise.resolve(result).then(
        () => settle(null),
        (asyncError: unknown) => settle(asyncError),
      )
    },
    [drainQueue],
  )
  commitRef.current = commit

  /** 切换作用域：先把「上一次渲染所捕获的回调」用于冲刷旧文档，再重置展示状态 */
  useEffect(() => {
    const scopedKey = scopeKey
    const scopedFlush = onFlush

    return () => {
      clearTimer()
      const pending = pendingRef.current
      pendingRef.current = null
      if (!pending) return
      // 只冲刷属于本作用域的负载（防御性判断，正常情况下必然相等）
      if (pending.scopeKey !== scopedKey) return
      commit({ scopeKey: scopedKey, payload: pending.payload, flush: scopedFlush })
    }
    // onFlush 故意不进依赖：cleanup 必须用「旧渲染」的那个回调实例
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, clearTimer, commit])

  useEffect(() => {
    setHasPending(false)
    setError(null)
    // 上一作用域可能刚提交了内容（status='saving'），不要把它冲掉
    setStatus((previous) => (previous === 'saving' ? previous : 'idle'))
  }, [scopeKey])

  const schedule = useCallback(
    (patch: AutoSavePayload) => {
      if (!hasField(patch)) return
      const current = pendingRef.current
      const payload: AutoSavePayload =
        current && current.scopeKey === scopeKey ? { ...current.payload, ...patch } : { ...patch }
      pendingRef.current = { scopeKey, payload }
      setHasPending(true)
      setStatus('pending')
      clearTimer()
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        const pending = pendingRef.current
        pendingRef.current = null
        setHasPending(false)
        if (pending) commit({ scopeKey: pending.scopeKey, payload: pending.payload, flush: latestFlushRef.current })
      }, delayMs)
    },
    [scopeKey, delayMs, clearTimer, commit],
  )

  const flush = useCallback(() => {
    clearTimer()
    const pending = pendingRef.current
    pendingRef.current = null
    setHasPending(false)
    if (pending) commit({ scopeKey: pending.scopeKey, payload: pending.payload, flush: latestFlushRef.current })
  }, [clearTimer, commit])

  const cancel = useCallback(() => {
    clearTimer()
    pendingRef.current = null
    setHasPending(false)
    setStatus('idle')
  }, [clearTimer])

  return { status, error, lastSavedAt, hasPending, schedule, flush, cancel }
}
