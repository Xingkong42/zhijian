/**
 * `@/lib/tauri` 的替身（仅 t6/t13 自检使用，不参与打包）。
 *
 * 为什么不复用 db 层的 stub-lib-tauri.mjs：那个只提供 `isTauri`，
 * 而 t13 的 `src/features/settings/closeToTray.ts` 需要 t12 新增的
 * `setCloseToTray` / `readCloseToTrayFromRust` / `onWindowHidden` 三个封装。
 *
 * 这里把它们做成**可观测的假实现**，让自检能断言：
 *  - 下发了什么值（`calls`）；
 *  - `onWindowHidden` 注册/退订是否成对（防监听器泄漏）；
 *  - 读取失败时的降级（`setReadImpl` 抛错 → readRustPreference 返回 null）。
 */

export const isTauri = true

/** 所有 IPC 调用记录（诊断 + 断言用） */
export const calls = []

let readImpl = async () => true
let writeImpl = async (enabled) => {
  calls.push({ op: 'setCloseToTray', enabled })
  return enabled
}

/** 订阅表：event 名 → handler 集合 */
const subscriptions = new Map()

export function setReadImpl(fn) {
  readImpl = fn
}

export function setWriteImpl(fn) {
  writeImpl = fn
}

export function listenerCount(event) {
  return subscriptions.get(event)?.size ?? 0
}

export async function setCloseToTray(enabled) {
  return writeImpl(enabled)
}

export async function readCloseToTrayFromRust() {
  return readImpl()
}

export async function onWindowHidden(handler) {
  const event = 'zhijian://window-hidden'
  const set = subscriptions.get(event) ?? new Set()
  set.add(handler)
  subscriptions.set(event, set)
  calls.push({ op: 'onWindowHidden' })
  return () => {
    set.delete(handler)
    calls.push({ op: 'offWindowHidden' })
  }
}

/** 自检用：模拟 Rust 侧 emit 一次 WINDOW_HIDDEN */
export function emitWindowHidden(payload) {
  const set = subscriptions.get('zhijian://window-hidden')
  if (!set) return 0
  for (const handler of [...set]) handler(payload)
  return set.size
}

/* ---------------- t19/t20：磁贴两个事件封装（hotkeys.ts 会 import 它们） ----------------
   为什么必须有：`bindGlobalHotkeys()` 现在通过**封装**订阅磁贴事件（而不是裸写 `listen`，
   以免破坏 D1 的「同一事件全仓只允许 1 处 listen」静态断言）。
   桩件若缺这两个导出，D1 的运行时那一段会直接以
   `does not provide an export named ...` 崩掉（实测如此）—— 属于"桩件漏项"高发区。 */

export async function onTilesVisibilityChanged(handler) {
  const event = 'zhijian://tiles-visibility-changed'
  const set = subscriptions.get(event) ?? new Set()
  set.add(handler)
  subscriptions.set(event, set)
  calls.push({ op: 'onTilesVisibilityChanged' })
  return () => {
    set.delete(handler)
    calls.push({ op: 'offTilesVisibilityChanged' })
  }
}

export async function onPinCurrentNoteRequested(handler) {
  const event = 'zhijian://pin-current-note-requested'
  const set = subscriptions.get(event) ?? new Set()
  set.add(handler)
  subscriptions.set(event, set)
  calls.push({ op: 'onPinCurrentNoteRequested' })
  return () => {
    set.delete(handler)
    calls.push({ op: 'offPinCurrentNoteRequested' })
  }
}

/** 自检用：模拟 Rust 侧 emit 一次磁贴显隐事件 */
export function emitTilesVisibilityChanged(payload) {
  const set = subscriptions.get('zhijian://tiles-visibility-changed')
  if (!set) return 0
  for (const handler of [...set]) handler(payload)
  return set.size
}

/** 自检用：模拟 Rust 侧 emit 一次「钉住当前笔记」 */
export function emitPinCurrentNoteRequested(payload = { noteId: null }) {
  const set = subscriptions.get('zhijian://pin-current-note-requested')
  if (!set) return 0
  for (const handler of [...set]) handler(payload)
  return set.size
}

/* -------- 其余 src/lib/tauri 导出：给同目录其它模块提供最小可用形态 -------- */

export const APP_META = {
  productName: '纸笺',
  identifier: 'com.zhijian.app',
  version: '0.1.0',
  dbUrl: 'sqlite:zhijian.db',
  migrationTable: '_zj_migrations',
}

export const EVENTS = {
  windowShown: 'zhijian://window-shown',
  windowHidden: 'zhijian://window-hidden',
  newNoteRequested: 'zhijian://new-note-requested',
  openSettingsRequested: 'zhijian://open-settings-requested',
  toggleWindowRequested: 'zhijian://toggle-window-requested',
  appQuitRequested: 'zhijian://app-quit-requested',
  // t19/t20 补登：磁贴两个事件。**桩件漏项会让「事件名比对」通过但语义错**：
  // 曾因这里缺 tilesVisibilityChanged / pinCurrentNoteRequested，
  // 使 `SHORTCUT_EVENT_BY_ACTION` 里对应值取到 `undefined`，
  // 于是 `dispatchShortcutEvent(undefined)` 意外命中 `case undefined` 返回 true（自检抓到）。
  tilesVisibilityChanged: 'zhijian://tiles-visibility-changed',
  pinCurrentNoteRequested: 'zhijian://pin-current-note-requested',
  /** t44：跨窗口笔记同步（桩件必须跟着真表走，否则"事件名比对"会在假表上通过） */
  noteChanged: 'zhijian://note-changed',
}

/**
 * t44：动作 id 清单。
 * ⚠️ 这里曾经是 6 项、含 `showTile`（t19 的旧动作名）。用户要求删掉设置里的
 * 「显示磁贴（旧动作名）」一项后，真表已减到 5 项 —— **桩件必须同步删**，
 * 否则自检是在一张过期的假表上做断言（"桩件漂移"比"代码漂移"更隐蔽）。
 */
export const SHORTCUT_ACTION_IDS = [
  'newNote',
  'toggleWindow',
  'openSettings',
  'toggleTiles',
  'pinNote',
  'quickNote',
]

export const COMMANDS = {
  windowShow: 'window_show',
  windowHide: 'window_hide',
  windowToggle: 'window_toggle',
  appVersion: 'app_version',
  setCloseToTray: 'cmd_set_close_to_tray',
  closeToTrayEnabled: 'cmd_close_to_tray_enabled',
  syncGlobalShortcuts: 'cmd_sync_global_shortcuts',
  // t19：磁贴三个命令（t20 补登；同样属于「桩件漏项」高发区）
  toggleTile: 'cmd_toggle_tile',
  listTiles: 'cmd_list_tiles',
  setTilesVisible: 'cmd_set_tiles_visible',
}

export async function getAppDataDir() {
  return '/tmp/zhijian-appdata'
}

export async function minimizeWindow() {}
export async function toggleMaximizeWindow() {}
export async function closeWindow() {}
export async function isWindowMaximized() {
  return false
}
export async function onWindowResized() {
  return () => {}
}
