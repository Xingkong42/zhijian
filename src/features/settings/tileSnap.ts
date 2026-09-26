/**
 * 「磁贴吸附」开关的**唯一接线处**（t52）。
 * 归属：系统集成（`src/features/settings/**`）。
 *
 * ## 权威源约定（与 §4.13 的 `closeToTray` 完全一致）
 * | 关注点 | 权威源 |
 * | --- | --- |
 * | **持久化**（跨重启记住） | 前端 `localStorage['zhijian.tileSnap']`（`src/lib/appPreferences.ts`） |
 * | **行为**（拖动到底吸不吸附） | Rust `tiles::tile_snap_enabled()`（进程内 `AtomicBool`，不落盘） |
 *
 * Rust 读不到 WebView 的 localStorage，所以**前端必须主动下发**：
 *  1. **应用启动时**同步一次 —— 否则重启后 Rust 回落到默认 `true`，
 *     用户关掉的开关会被悄悄忘记（表现为「我明明关了，怎么又开始吸」）；
 *  2. **开关变更时**立即下发。
 * 两侧因此永不产生「双份真相」：Rust 只是前端值的行为副本，启动即被覆盖。
 *
 * 本文件不含 JSX，刻意用 `.ts`，便于 Node 自检直接 import（`__checks__/run-checks.mjs`）。
 */

import { readTileSnap } from '@/lib/appPreferences'
import { isTauri, readTileSnapFromRust, setTileSnap } from '@/lib/tauri'

/* ------------------------------ 文案 ------------------------------ */

export const TILE_SNAP_LABEL = '磁贴吸附'

/**
 * 开关说明：必须同时讲清**开启后什么样**与**关闭后什么样**，
 * 否则用户只能靠试（关闭后「已有的组会不会散」是最容易被误解的一点）。
 */
export const TILE_SNAP_HINT =
  '开启后：把磁贴拖到另一枚旁边会自动贴合，并作为一组一起移动（磁贴标题栏的「取消吸附」按钮可把某枚移出组）。关闭后：磁贴各自独立，不再自动贴合，也不会被同组磁贴带着走；已分好的组会保留，重新开启即恢复。'

/* --------------------------- 偏好下发 --------------------------- */

type SetPreference = (enabled: boolean) => Promise<boolean>

export interface TileSnapSyncResult {
  /** 是否真的下发了（非 Tauri 环境为 false） */
  synced: boolean
  /** 下发的值；未下发时为 null */
  value: boolean | null
}

/**
 * 把吸附开关下发给 Rust（**启动时与变更时都走这一个函数**，保证两条路径行为一致）。
 *
 * - 非 Tauri（浏览器预览）：静默跳过，`synced: false`，不抛错；
 * - Tauri 环境：`invoke` 失败也**不抛**，只返回 `synced: false`
 *   —— 偏好下发失败不该让设置面板或启动流程崩掉（行为退回 Rust 默认值 `true`）。
 */
export async function syncTileSnapPreference(
  enabled: boolean = readTileSnap(),
  send?: SetPreference,
): Promise<TileSnapSyncResult> {
  if (!isTauri && !send) return { synced: false, value: null }
  try {
    const dispatch: SetPreference = send ?? setTileSnap
    await dispatch(enabled)
    return { synced: true, value: enabled }
  } catch (error) {
    console.warn('[纸笺] 下发「磁贴吸附」偏好失败（行为退回 Rust 默认值 true）：', error)
    return { synced: false, value: null }
  }
}

/**
 * 读取 Rust 侧当前值（诊断：设置面板据此提示"偏好未生效"）。
 * 非 Tauri 或调用失败返回 `null`（表示"无法对账"，**不是**"不一致"）。
 */
export async function readRustTileSnap(
  read?: () => Promise<boolean | null>,
): Promise<boolean | null> {
  try {
    const query = read ?? readTileSnapFromRust
    return await query()
  } catch {
    return null
  }
}

/** 前端持久化值与 Rust 行为值是否漂移（Rust 为 null 时视为无法判断 → false） */
export function isTileSnapDrifted(rustValue: boolean | null, stored: boolean): boolean {
  return rustValue !== null && rustValue !== stored
}
