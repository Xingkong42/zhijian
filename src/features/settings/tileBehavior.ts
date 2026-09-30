/**
 * 「已固定的磁贴是否允许被『全部显隐』隐藏」偏好的**唯一接线处**（t54）。
 * 归属：系统集成（`src/features/settings/**`）。
 *
 * ## 权威源约定（与 tileSnap / closeToTray 完全一致）
 * | 关注点 | 权威源 |
 * | --- | --- |
 * | **持久化** | 前端 `localStorage['zhijian.pinnedTilesHidable']`（`src/lib/appPreferences.ts`） |
 * | **行为** | Rust `tiles::tile_hide_pinned()`（进程内 `AtomicBool`，不落盘） |
 *
 * ⚠️ 为什么这个开关必须下发 Rust（而不是前端自己决定）：
 * 「显示/隐藏全部磁贴」是由**全局快捷键与托盘菜单直接调用 Rust** 的
 * `set_all_visible_impl()` 完成的，压根不经过前端 ⇒ "固定磁贴要不要跟着动"这个判断
 * 只能由 Rust 拿到值。前端只负责把用户的选择送过去。
 *
 * ## 默认值 `false` 的由来（不要随手改成 true）
 * t46 时用户明确要求：「希望固定的磁贴永远留在桌面上（快捷键只影响临时磁贴）」。
 * 所以默认行为是**跳过**固定磁贴；打开本开关是用户显式的例外选择。
 *
 * 本文件不含 JSX，刻意用 `.ts`，便于 Node 自检直接 import。
 */

import { readPinnedTilesHidable } from '@/lib/appPreferences'
import { isTauri, readTileHidePinnedFromRust, setTileHidePinned } from '@/lib/tauri'

/* ------------------------------ 文案 ------------------------------ */

export const PINNED_TILES_HIDABLE_LABEL = '允许隐藏已固定的磁贴'

export const PINNED_TILES_HIDABLE_HINT =
  '关闭时（默认）：固定的磁贴永远留在桌面上，「显示/隐藏全部磁贴」只影响临时磁贴。开启后：固定磁贴也会跟着一起显示/隐藏 —— 想一键清空桌面时用得上。'

/* --------------------------- 偏好下发 --------------------------- */

type SetPreference = (enabled: boolean) => Promise<boolean>

export interface PinnedTilesHidableSyncResult {
  /** 是否真的下发了（非 Tauri 环境为 false） */
  synced: boolean
  /** 下发的值；未下发时为 null */
  value: boolean | null
}

/**
 * 把开关下发给 Rust（**启动时与变更时都走这一个函数**，保证两条路径一致）。
 *
 * - 非 Tauri（浏览器预览）：静默跳过；
 * - Tauri 环境：`invoke` 失败也**不抛**，只返回 `synced: false`
 *   —— 下发失败不该让设置面板或启动流程崩掉（行为退回 Rust 默认值 `false`）。
 */
export async function syncPinnedTilesHidablePreference(
  enabled: boolean = readPinnedTilesHidable(),
  send?: SetPreference,
): Promise<PinnedTilesHidableSyncResult> {
  if (!isTauri && !send) return { synced: false, value: null }
  try {
    const dispatch: SetPreference = send ?? setTileHidePinned
    await dispatch(enabled)
    return { synced: true, value: enabled }
  } catch (error) {
    console.warn('[纸笺] 下发「固定磁贴可被隐藏」偏好失败（行为退回 Rust 默认值 false）：', error)
    return { synced: false, value: null }
  }
}

/**
 * 读取 Rust 侧当前值（诊断：设置面板据此提示"偏好未生效"）。
 * 非 Tauri 或调用失败返回 `null`（= 无法对账，**不是**不一致）。
 */
export async function readRustPinnedTilesHidable(
  read?: () => Promise<boolean | null>,
): Promise<boolean | null> {
  try {
    const query = read ?? readTileHidePinnedFromRust
    return await query()
  } catch {
    return null
  }
}

/** 前端持久化值与 Rust 行为值是否漂移（Rust 为 null 时视为无法判断 → false） */
export function isPinnedTilesHidableDrifted(rustValue: boolean | null, stored: boolean): boolean {
  return rustValue !== null && rustValue !== stored
}
