/**
 * src/features/titlebar —— 无边框窗口自定义标题栏（归属：t5）。
 *
 * 交付：
 *   - `Titlebar`（`TitlebarProps`，docs/ARCHITECTURE.md §4.4 冻结）
 *   - `useTitlebarState()`（maximized / minimize / toggleMaximize / close=隐藏到托盘）
 *   - `windowActions.ts`（窗口动作桥：minimize / toggleMaximize / hide / isMaximized / resize 订阅）
 *   - `AppTitlebar`（骨架期名字的兼容别名，转发到 Titlebar）
 */

export { Titlebar } from './Titlebar'
export { AppTitlebar } from './AppTitlebar'
export { useTitlebarState } from './useTitlebarState'
export type { TitlebarState } from './useTitlebarState'
export {
  hideMainWindow,
  isMainWindowMaximized,
  minimizeMainWindow,
  onMainWindowResized,
  toggleMaximizeMainWindow,
} from './windowActions'

/** 类型转发：调用方只需要 `@/features/titlebar` 一个入口 */
export type { TitlebarProps } from '@/types'
