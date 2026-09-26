/**
 * 标题栏窗口状态与动作（骨架版由架构师提供，t5 按契约重构实现体，返回签名不变）。
 *
 * 契约：`useTitlebarState()` 返回 `{ maximized, minimize, toggleMaximize, close }`。
 *  - `close()` = 隐藏到托盘（hide），不是销毁窗口；
 *  - `maximized` 初值 + 每次窗口 resize 同步（避免最大化按钮图标与实际状态不一致）。
 */

import { useCallback, useEffect, useState } from 'react'
import {
  hideMainWindow,
  isMainWindowMaximized,
  minimizeMainWindow,
  onMainWindowResized,
  toggleMaximizeMainWindow,
} from './windowActions'

export interface TitlebarState {
  /** 窗口是否最大化（驱动最大化/还原图标与 aria-label） */
  maximized: boolean
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  /** 关闭按钮：隐藏到系统托盘 */
  close: () => Promise<void>
}

export function useTitlebarState(): TitlebarState {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined

    void (async () => {
      const initial = await isMainWindowMaximized()
      if (!disposed) setMaximized(initial)
      const unlisten = await onMainWindowResized((value) => {
        if (!disposed) setMaximized(value)
      })
      if (disposed) unlisten()
      else unsubscribe = unlisten
    })()

    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [])

  const minimize = useCallback(async () => {
    await minimizeMainWindow()
  }, [])

  const toggleMaximize = useCallback(async () => {
    await toggleMaximizeMainWindow()
    // 立即回读一次，不等 resize 事件（拖动到屏幕边缘等场景下事件可能延迟）
    const value = await isMainWindowMaximized()
    setMaximized(value)
  }, [])

  const close = useCallback(async () => {
    await hideMainWindow()
  }, [])

  return { maximized, minimize, toggleMaximize, close }
}
