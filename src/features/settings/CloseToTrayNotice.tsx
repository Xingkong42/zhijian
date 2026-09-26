/**
 * CloseToTrayNotice —— 「关闭到托盘」的启动同步 + 隐藏反馈（§4.13 / 任务 t13）。
 *
 * 集成层只需在 `ToastProvider` **内部**挂一次：
 * ```tsx
 * <ToastProvider>
 *   <App />
 *   <CloseToTrayNotice />
 * </ToastProvider>
 * ```
 *
 * 它承担两件必须发生的事（缺一件都会让开关失效）：
 *  1. **启动时把持久化偏好下发给 Rust** —— Rust 读不到 localStorage；
 *     不下发则重启后回落到 Rust 默认 `true`，用户关掉的开关被悄悄忘记；
 *  2. **订阅 `WINDOW_HIDDEN`** —— 首次因关闭按钮隐藏时提示「已最小化到系统托盘」，
 *     告知如何找回窗口与如何真正退出，避免用户以为应用关不掉。
 *
 * 注意：本组件必须挂在 `ToastProvider` 内（要用 `useToast()`）；
 * 挂在 Provider 之外会被 `useToast()` 主动报错，这是设计系统刻意的约束。
 * 也请挂在**长期存在**的根节点上（不要挂在条件渲染的分支里）：
 * 订阅一旦因卸载而丢失，隐藏反馈就会静默失效。
 */

import { useEffect } from 'react'
import { useToast } from '@/components/ui'
import {
  openCloseToTrayNotice,
  shouldShowCloseToTrayNotice,
  syncCloseToTrayPreference,
} from './closeToTray'

export interface CloseToTrayNoticeProps {
  /**
   * 是否启用「首次关闭隐藏」提示，默认 `true`（§4.13 规则 4 硬要求）。
   * 置 `false` 可只保留「启动同步」而关闭提示 —— QA 隔离验证隐藏行为时用得上。
   */
  noticeEnabled?: boolean
}

export function CloseToTrayNotice({ noticeEnabled = true }: CloseToTrayNoticeProps) {
  const { toast } = useToast()

  // ① 启动同步：把 localStorage 里的持久化偏好下发给 Rust（非 Tauri 环境静默跳过）
  useEffect(() => {
    void syncCloseToTrayPreference()
  }, [])

  // ② 隐藏反馈：订阅 WINDOW_HIDDEN，仅「首次因关闭按钮隐藏」时提示一次
  useEffect(() => {
    if (!noticeEnabled) return
    let dispose: (() => void) | null = null
    let cancelled = false

    void (async () => {
      const unsubscribe = await openCloseToTrayNotice({
        // 判定显式传入：`openCloseToTrayNotice` 不再自带默认值，
        // 避免「默认值藏在两个地方」——这里是唯一决策点。
        shouldNotify: (payload) => shouldShowCloseToTrayNotice(payload),
        notify: ({ title, description, variant }) => {
          toast({ title, description, variant })
        },
      })
      // 异步订阅期间组件可能已卸载：立刻退订，避免监听器泄漏
      if (cancelled) {
        unsubscribe()
        return
      }
      dispose = unsubscribe
    })()

    return () => {
      cancelled = true
      dispose?.()
      dispose = null
    }
  }, [noticeEnabled, toast])

  return null
}

export default CloseToTrayNotice
