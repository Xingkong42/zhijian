/**
 * 标题栏窗口动作桥（本 feature 唯一的窗口 API 出口）。
 *
 * 为什么不是全部直接调 `@tauri-apps/api/window`：
 *  - 最小化 / 最大化 / 读最大化态 / 监听 resize 已有共享封装 `src/lib/tauri.ts`
 *    （架构约定：窗口 API 尽量收敛在 lib），此处直接复用，避免两份实现漂移；
 *  - **关闭** 按钮的语义是「隐藏到托盘」：`getCurrentWindow().hide()`。
 *    lib 的 `closeWindow()` 走 `window.close()`，最终去向由 Rust 侧 `window_event`
 *    的 `CloseRequested` 拦截（`window::should_hide_on_close()`）决定；
 *    system 成员约定的前端语义是显式 hide()，因此这里补一个 hide 桥保持一致。
 *    对应权限 `core:window:allow-hide` 已在 capabilities/default.json 中放行。
 *  - 非 Tauri（`pnpm dev` 浏览器预览）一律安全空操作。
 *
 * 不额外提供「双击拖拽区切换最大化」：Tauri 2.11 的注入脚本
 * （tauri-2.11.6/src/window/scripts/drag.js）在 `data-tauri-drag-region` 上
 * 对 mousedown detail===2 直接 invoke `internal_toggle_maximize`，
 * 再加一层 JS 双击处理会与它互相抵消（连切两次 = 无变化）。
 */

import {
  isTauri,
  isWindowMaximized,
  minimizeWindow,
  onWindowResized,
  toggleMaximizeWindow,
} from '@/lib/tauri'

/** 当前主窗口（非 Tauri 环境返回 null） */
type CurrentWindow = import('@tauri-apps/api/window').Window

async function currentWindow(): Promise<CurrentWindow | null> {
  if (!isTauri) return null
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

/** 最小化主窗口 */
export function minimizeMainWindow(): Promise<void> {
  return minimizeWindow()
}

/** 最大化 / 还原主窗口 */
export function toggleMaximizeMainWindow(): Promise<void> {
  return toggleMaximizeWindow()
}

/** 主窗口当前是否最大化 */
export function isMainWindowMaximized(): Promise<boolean> {
  return isWindowMaximized()
}

/** 监听主窗口尺寸变化并回报最大化状态（返回取消订阅函数） */
export function onMainWindowResized(handler: (maximized: boolean) => void): Promise<() => void> {
  return onWindowResized(handler)
}

/**
 * 隐藏主窗口到托盘（关闭按钮语义）。
 * 与 Rust 侧 `window::hide_main` 的效果一致；托盘不可用时 Rust 会退化为真正关闭。
 */
export async function hideMainWindow(): Promise<void> {
  const win = await currentWindow()
  if (!win) return
  await win.hide()
}
