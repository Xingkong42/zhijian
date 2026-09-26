/**
 * 「关闭窗口时隐藏到系统托盘」偏好的**唯一接线处**（§4.13 / 任务 t13）。
 * 归属：系统集成 / 任务 t13（`src/features/settings/**`）。
 *
 * ## 权威源约定（§4.13）
 * | 关注点 | 权威源 |
 * | --- | --- |
 * | **持久化**（跨重启记住） | 前端 `localStorage['zhijian.closeToTray']`（`src/lib/appPreferences.ts`） |
 * | **行为**（关闭按钮到底隐藏还是退出） | Rust `window::close_to_tray_preference()`（进程内 `AtomicBool`，不落盘） |
 *
 * Rust 读不到 WebView 的 localStorage，所以**前端必须主动下发**：
 *  1. **应用启动时**同步一次（否则重启后 Rust 回落到默认 `true`，用户关掉的开关被悄悄忘记）；
 *  2. **开关变更时**立即下发。
 * 两侧因此永不产生「双份真相」：Rust 只是前端值的行为副本，启动即被覆盖。
 *
 * ## 隐藏反馈（§4.13 规则 4）
 * 只隐藏而无反馈，用户会以为应用关不掉。本模块提供：
 *  - 文案生成 `closeToTrayNoticeText()`（必须同时说明**怎么找回**与**怎么真退出**）；
 *  - 判定 `shouldShowCloseToTrayNotice()` —— **只在 `reason === 'close' && firstCloseHide`** 时提示一次，
 *    避免用户用 Alt+Shift+Z 快速切换或托盘菜单隐藏时被反复打扰；
 *  - 订阅 `openCloseToTrayNotice()`（React 绑定见同目录 `CloseToTrayNotice.tsx`）。
 *
 * 本文件不含 JSX，刻意用 `.ts`，便于 Node 自检直接 import（`__checks__/run-checks.mjs`）。
 */

import type { WindowHiddenPayload } from '@/lib/tauri'
import { isTauri, onWindowHidden, readCloseToTrayFromRust, setCloseToTray } from '@/lib/tauri'
import { readCloseToTray, type AppPreferences } from '@/lib/appPreferences'
import type { Unsubscribe } from '@/types'

/* ------------------------------ 文案 ------------------------------ */

export const CLOSE_TO_TRAY_NOTICE_TITLE = '已最小化到系统托盘'

/**
 * 提示正文：必须同时告知「怎么找回窗口」与「怎么真正退出」，
 * 这是防住「用户以为应用关不掉」的关键（§4.13 规则 4）。
 */
export function closeToTrayNoticeText(): string {
  return '纸笺仍在后台常驻：单击托盘图标（或按 Alt+Shift+Z）可重新显示；要真正退出，请用托盘菜单的「退出纸笺」。可在设置 → 行为里关闭此行为。'
}

/* --------------------------- 提示判定 --------------------------- */

export interface CloseToTrayNoticeOptions {
  /**
   * 是否启用「首次关闭隐藏」提示。
   *
   * 默认 `true`（§4.13 规则 4 硬要求）；留出该开关是为了让 QA 能在
   * `pnpm tauri:dev` 里**关闭提示、单独隔离验证隐藏行为本身**。
   */
  autoShow?: boolean
  /**
   * 覆盖 `firstCloseHide` 判定 —— **仅供自动化验证使用**，生产不要传。
   *
   * 原因：`FIRST_HIDE_NOTIFIED` 是 Rust 侧的进程级一次性标记（`swap(true)`），
   * 触发后无法复位，所以「同一进程内再触发一次提示」在真实环境里做不到；
   * 验证时用该字段走同一条判定代码路径。
   */
  forceFirstCloseHide?: boolean
}

/**
 * 是否应当弹出「已最小化到系统托盘」提示。
 *
 * 判定条件（三者同时满足）：
 *  1. 提示功能启用（默认启用）；
 *  2. `reason === 'close'` —— 用户点了窗口关闭按钮，**这是唯一需要提示的场景**
 *     （`'tray'` / `'toggle'` 是用户主动隐藏，提示反而啰嗦）；
 *  3. `firstCloseHide === true` —— 只提示首次，避免每次关闭都打扰。
 *
 * 防御：payload 缺失或 `reason` 非法（Rust 与前端契约漂移）时**不提示**，
 * 绝不因为多弹一个 Toast 而打扰用户。
 */
export function shouldShowCloseToTrayNotice(
  payload: Pick<WindowHiddenPayload, 'reason' | 'firstCloseHide'> | null | undefined,
  options: CloseToTrayNoticeOptions = {},
): boolean {
  const { autoShow = true, forceFirstCloseHide } = options
  if (!autoShow) return false
  if (!payload) return false
  if (payload.reason !== 'close') return false
  const firstCloseHide = forceFirstCloseHide ?? payload.firstCloseHide === true
  return firstCloseHide === true
}

/* --------------------------- 偏好下发 --------------------------- */

type SetPreference = (enabled: boolean) => Promise<boolean>

export interface PreferenceSyncResult {
  /** 是否真的下发了（非 Tauri 环境为 false） */
  synced: boolean
  /** 下发的值；未下发时为 null */
  value: boolean | null
}

/**
 * 把偏好下发给 Rust（**启动时与变更时都走这一个函数**，保证两条路径行为一致）。
 *
 * - 非 Tauri（浏览器预览）：静默跳过，`synced: false`，不抛错；
 * - Tauri 环境：`invoke` 失败也**不抛**，只返回 `synced: false`
 *   —— 偏好下发失败不该让设置面板或启动流程崩掉（行为退回 Rust 默认值 `true`）。
 */
export async function syncCloseToTrayPreference(
  enabled: boolean = readCloseToTray(),
  send?: SetPreference,
): Promise<PreferenceSyncResult> {
  if (!isTauri && !send) return { synced: false, value: null }
  try {
    const dispatch: SetPreference = send ?? setCloseToTray
    await dispatch(enabled)
    return { synced: true, value: enabled }
  } catch (error) {
    console.warn('[纸笺] 下发「关闭到托盘」偏好失败（行为退回 Rust 默认值）：', error)
    return { synced: false, value: null }
  }
}

/**
 * 读取 Rust 侧当前值（诊断用：设置面板可依据它提示"偏好未生效"）。
 * 非 Tauri 或调用失败返回 `null`（表示"无法对账"，不是"不一致"）。
 */
export async function readRustPreference(
  read?: () => Promise<boolean | null>,
): Promise<boolean | null> {
  try {
    const query = read ?? readCloseToTrayFromRust
    return await query()
  } catch {
    return null
  }
}

/** 前端持久化值与 Rust 行为值是否漂移（Rust 为 null 时视为无法判断 → false） */
export function isPreferenceDrifted(rustValue: boolean | null, stored: boolean): boolean {
  return rustValue !== null && rustValue !== stored
}

/** 只读暴露持久化偏好（不产生第二份状态） */
export function storedCloseToTray(): Pick<AppPreferences, 'closeToTray'> {
  return { closeToTray: readCloseToTray() }
}

/* --------------------------- 事件订阅 --------------------------- */

/** 当前**唯一**的 `WINDOW_HIDDEN` 订阅（`null` = 未订阅） */
let activeUnsubscribe: Unsubscribe | null = null
/** 该订阅的持有者数量（React StrictMode 会让 Effect 挂载两遍） */
let activeHolders = 0

export interface CloseToTrayNoticeHandlers {
  /** 需要提示时调用（集成层通常传 `useToast().toast`） */
  notify: (notice: { title: string; description: string; variant: 'info' }) => void
  /** 自定义提示判定（默认 `shouldShowCloseToTrayNotice`） */
  shouldNotify: (payload: WindowHiddenPayload) => boolean
}

/**
 * 订阅 `WINDOW_HIDDEN`，在「首次因关闭按钮隐藏」时给出可见反馈。
 * 返回取消订阅函数；非 Tauri 环境为空操作。
 *
 * ## 为什么要有「引用计数」（而不是每次调用都订阅）
 * React 18+ 的 StrictMode 在**开发态**把每个 Effect 走两遍「挂载→卸载→再挂载」，
 * 若每次都独立订阅，会有两个监听器同时生效 —— 用户点一次关闭看到**两条**
 * 「已最小化到系统托盘」Toast。误挂两处同理。
 * 因此这里保证**同一时刻只有一个底层监听**：第一个持有者订阅，
 * 后来的持有者只加计数；**最后一个持有者释放时**才真正退订。
 *
 * 实现要点：先**同步**占位再 `await`，否则两次并发调用会都通过判空、
 * 各自订阅一次后互相覆盖句柄（实测会产生两个监听器）。
 * 占位期间若持有者已全部释放，就不再建立底层监听。
 */
export async function openCloseToTrayNotice(
  handlers: CloseToTrayNoticeHandlers,
): Promise<Unsubscribe> {
  if (!isTauri) return () => {}

  activeHolders += 1

  if (!activeUnsubscribe) {
    const shouldNotify = handlers.shouldNotify
    const notify = handlers.notify
    // 同步占位：并发调用会在下面的 await 之前看到非 null，从而只加计数
    activeUnsubscribe = () => {}

    const subscribe = async () => {
      if (activeHolders <= 0) {
        // 订阅期间持有者已全部释放（StrictMode 的卸载分支）：不建立底层监听
        activeUnsubscribe = null
        return
      }
      try {
        const dispose = await onWindowHidden((payload) => {
          if (!shouldNotify(payload)) return
          notify({
            title: CLOSE_TO_TRAY_NOTICE_TITLE,
            description: closeToTrayNoticeText(),
            variant: 'info',
          })
        })
        // 拿到句柄时持有者可能已归零：立刻退订，不留悬挂监听（也保证下次拿到全新句柄）
        if (activeHolders <= 0) {
          activeUnsubscribe = null
          dispose()
          return
        }
        activeUnsubscribe = dispose
      } catch (error) {
        activeUnsubscribe = null
        console.warn('[纸笺] 订阅「窗口已隐藏到托盘」事件失败（将缺少隐藏提示）：', error)
      }
    }

    // 刻意不 await：让调用方立刻拿到退订函数，避免卸载时还来不及订阅
    void subscribe()
  }

  let released = false
  return () => {
    if (released) return
    released = true
    activeHolders -= 1
    if (activeHolders > 0) return
    const dispose = activeUnsubscribe
    activeUnsubscribe = null
    dispose?.()
  }
}

/** 当前是否已有 `WINDOW_HIDDEN` 订阅（诊断 / 自检用） */
export function hasActiveCloseToTrayNotice(): boolean {
  return activeUnsubscribe !== null
}
