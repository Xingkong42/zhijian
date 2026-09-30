/**
 * Tauri 运行时探测与窗口/壳层薄封装。
 * 归属：架构师（冻结签名，可被任何模块 import）。
 *
 * 约定：所有对 @tauri-apps/api 的直接调用都收敛在本文件，
 * 便于在纯浏览器（pnpm dev）下安全降级，不要让组件直接 import 窗口 API。
 */

/** 是否运行在 Tauri webview 中（纯浏览器 dev 时为 false） */
export const isTauri: boolean =
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

/** 应用元信息（与 src-tauri/tauri.conf.json 保持一致） */
export const APP_META = {
  productName: '纸笺',
  identifier: 'com.zhijian.app',
  version: '0.2.2',
  /** SQLite 迁移表名与库文件名（与 tauri.conf.json 的 plugins.sql 对应） */
  dbUrl: 'sqlite:zhijian.db',
  migrationTable: '_zj_migrations',
} as const

/**
 * Rust → 前端事件名（镜像 src-tauri/src/events.rs 的 constants）。
 * 新增事件必须两边同时登记；业务代码里禁止散写字符串字面量。
 */
export const EVENTS = {
  windowShown: 'zhijian://window-shown',
  windowHidden: 'zhijian://window-hidden',
  newNoteRequested: 'zhijian://new-note-requested',
  openSettingsRequested: 'zhijian://open-settings-requested',
  appQuitRequested: 'zhijian://app-quit-requested',
  /** t17：全局快捷键触发「显示/隐藏窗口」—— 显隐由 Rust 完成，本事件仅供前端反馈 */
  toggleWindowRequested: 'zhijian://toggle-window-requested',
  /** t19：磁贴可见性被快捷键切换 —— 负载 `{ visible: boolean }`，显隐由 Rust 完成 */
  tilesVisibilityChanged: 'zhijian://tiles-visibility-changed',
  /** t19：请求把「当前笔记」钉成磁贴 —— 负载 `{ noteId: string }`，**noteId 需前端回填** */
  pinCurrentNoteRequested: 'zhijian://pin-current-note-requested',
  /**
   * t44：某窗口改动了笔记内容 —— 负载 `{ noteId: string, source: string }`。
   *
   * 磁贴与主窗口是两个独立 WebView、各持独立 store 实例，一边写入另一边不会自动知道。
   * 写入方广播本事件、其它窗口据此重读该条（见 `onNoteChanged`）。
   */
  noteChanged: 'zhijian://note-changed',
  /**
   * t45：**磁贴集合变了**（某枚磁贴窗口被销毁）。空负载。
   *
   * 触发场景：用户点磁贴自己的 ×、或从别处程序性关闭。Rust 是"当前有哪些磁贴"的权威，
   * 主窗口收到本事件后重新对账（`cmd_list_tiles`）—— 否则那条笔记的按钮会一直停在
   * 「取消桌面磁贴」，而实际上磁贴早就不在了。
   */
  tilesChanged: 'zhijian://tiles-changed',
} as const

export type AppEventName = (typeof EVENTS)[keyof typeof EVENTS]

/* ------------------- t17：全局快捷键同步（IPC 契约） ------------------- */

/**
 * 可绑定的动作 id（镜像 src-tauri/src/shortcuts.rs 的 `SUPPORTED_ACTION_IDS`）。
 *
 * ⚠️ 两边**必须逐字同步**：Rust 的 `cmd_sync_global_shortcuts` 会拒绝不在
 * `SUPPORTED_ACTION_IDS` 里的 id，前端多写一个 ⇒ 静默注册失败。
 * 本常量是**动作 id 的唯一真相源**：设置面板的 `ShortcutActionId` 由它推导
 * （`src/features/settings/shortcuts.ts`），因此新增动作只需改这里与 Rust 两处。
 */
export const SHORTCUT_ACTION_IDS = [
  'newNote',
  'toggleWindow',
  'openSettings',
  'toggleTiles',
  'pinNote',
  'quickNote',
] as const

export type ShortcutActionId = (typeof SHORTCUT_ACTION_IDS)[number]

export interface ShortcutBinding {
  id: ShortcutActionId
  /** 可读键位如 `Alt+N`；**空串表示显式解绑该动作** */
  accelerator: string
}

export interface ShortcutSyncReport {
  /** 实际生效的绑定（以真实生效值回传，供设置页如实展示） */
  applied: Array<{ id: string; accelerator: string }>
  /** 注册失败/输入非法的绑定（含中文原因） */
  failed: Array<{ id: string; accelerator: string; reason: string }>
}

/**
 * `WINDOW_HIDDEN` 的事件负载（对应 src-tauri/src/window.rs 的 WindowHiddenPayload）。
 *
 * §4.13 规则 4 要求隐藏动作必须有可见反馈；前端据此给出一次
 * 「已最小化到系统托盘」提示，避免用户以为应用关不掉。
 */
export type HideReason = 'close' | 'tray' | 'toggle'

export interface WindowHiddenPayload {
  reason: HideReason
  /** 是否为「用户第一次通过关闭按钮隐藏」—— 建议只在这种情况下提示一次 */
  firstCloseHide: boolean
}

/* --------------------------- IPC 命令类型 --------------------------- */

/** `invoke('app_version')` 的返回结构，对应 src-tauri/src/window.rs 的 AppVersion */
export interface AppVersionInfo {
  name: string
  version: string
  tauri: string
}

/** 前端可调用的 Rust 命令名（与 generate_handler! 注册的一致） */
export const COMMANDS = {
  windowShow: 'window_show',
  windowHide: 'window_hide',
  windowToggle: 'window_toggle',
  appVersion: 'app_version',
  /** §4.13：下发「关闭窗口时隐藏到托盘」偏好（参数 `{ enabled: boolean }`） */
  setCloseToTray: 'cmd_set_close_to_tray',
  /** §4.13：读取当前偏好（诊断 / 状态对账） */
  closeToTrayEnabled: 'cmd_close_to_tray_enabled',
  /** t17：原子重建全局快捷键绑定（参数 `{ bindings: ShortcutBinding[] }`） */
  syncGlobalShortcuts: 'cmd_sync_global_shortcuts',
  /* ---- t52：磁贴吸附开关 ---- */
  /** 下发「磁贴吸附」开关（参数 `{ enabled: boolean }`，返回生效后的 `boolean`） */
  setTileSnap: 'cmd_set_tile_snap',
  /** 读取当前「磁贴吸附」开关（诊断 / 启动对账用） */
  tileSnapEnabled: 'cmd_tile_snap_enabled',
  /* ---- t54：固定磁贴是否可被「全部显隐」隐藏 ---- */
  /** 下发该开关（参数 `{ enabled: boolean }`，返回生效后的 `boolean`） */
  setTileHidePinned: 'cmd_set_tile_hide_pinned',
  /** 读取该开关（诊断 / 启动对账用） */
  tileHidePinned: 'cmd_tile_hide_pinned',
  /* ---- t19 桌面便签磁贴 ---- */
  /** 钉住/取消磁贴（参数 `{ noteId: string }`，返回**新状态** `boolean`：true = 已钉住） */
  toggleTile: 'cmd_toggle_tile',
  /** 列出当前全部磁贴（无参，返回 `TileInfo[]`） */
  listTiles: 'cmd_list_tiles',
  /** 显示/隐藏全部磁贴（参数 `{ visible: boolean }`，返回切换后的可见状态） */
  setTilesVisible: 'cmd_set_tiles_visible',
  /* ---- t44 快速笔记 ---- */
  /**
   * 打开（或复用）快速笔记捕捉窗（无参，返回 `boolean`：true = 已打开）。
   *
   * 目前 Rust 侧的两条触发路径（托盘菜单 / 全局快捷键）**都直接调用** Rust 函数，
   * 不经过本命令；它留给将来的前端入口（例如侧栏/标题栏按钮）。
   * 之所以现在就把契约登记上：`check:contract` 对 `COMMANDS` 与 `generate_handler!`
   * 做双向核对，登记与实现**必须同时存在**，否则一边多一边少会立刻转红。
   */
  openQuickNote: 'cmd_open_quick_note',
  /* ---- t45 固定磁贴 ---- */
  /**
   * 固定 / 取消固定某枚磁贴（参数 `{ noteId: string, pinned: boolean }`，返回设置后的 `boolean`）。
   * 固定 = 下次启动自动出现；未固定 = 本次会话的临时磁贴。
   */
  setTilePinned: 'cmd_set_tile_pinned',
  /* ---- t47 吸附成组 ---- */
  /**
   * 取消吸附（参数 `{ noteId: string }`，返回 `boolean`：true = 之前在组里）。
   * 拖动时自动吸附成组；这个命令给用户一个**显式**的分开手段（用户选了"两者都要"）。
   */
  ungroupTile: 'cmd_ungroup_tile',
} as const


/* --------------------------- 窗口控制 --------------------------- */

export async function minimizeWindow(): Promise<void> {
  if (!isTauri) return
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  await getCurrentWindow().minimize()
}

export async function toggleMaximizeWindow(): Promise<void> {
  if (!isTauri) return
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  await getCurrentWindow().toggleMaximize()
}

/** 关闭窗口（是否隐藏到托盘由 Rust 侧 window.rs 决定） */
export async function closeWindow(): Promise<void> {
  if (!isTauri) return
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  await getCurrentWindow().close()
}

export async function isWindowMaximized(): Promise<boolean> {
  if (!isTauri) return false
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow().isMaximized()
}

/** 订阅窗口最大化状态变化，返回取消订阅函数 */
export async function onWindowResized(handler: (maximized: boolean) => void): Promise<() => void> {
  if (!isTauri) return () => {}
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const win = getCurrentWindow()
  const unlisten = await win.onResized(async () => {
    handler(await win.isMaximized())
  })
  return unlisten
}

/* --------------------- 关闭到托盘偏好（§4.13） --------------------- */

/**
 * 把「关闭窗口时隐藏到托盘」偏好下发给 Rust。
 *
 * 调用时机（**两者都必须**，否则偏好不生效或重启后丢失）：
 *  1. 应用启动时同步一次 —— Rust 读不到 WebView 的 localStorage，
 *     所以 localStorage 里的持久化值必须由前端主动下发；
 *  2. 设置面板开关变更时立即下发。
 *
 * 非 Tauri 环境（浏览器预览）静默返回 false，不抛错。
 */
export async function setCloseToTray(enabled: boolean): Promise<boolean> {
  if (!isTauri) return false
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<boolean>(COMMANDS.setCloseToTray, { enabled })
}

/** 读取 Rust 侧当前的偏好值（诊断 / 与 localStorage 对账用） */
export async function readCloseToTrayFromRust(): Promise<boolean | null> {
  if (!isTauri) return null
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<boolean>(COMMANDS.closeToTrayEnabled)
}

/* --------------------------- t52：磁贴吸附开关 --------------------------- */

/**
 * 下发「磁贴吸附」开关给 Rust（`tiles::TILE_SNAP`）。
 *
 * 调用时机与 `setCloseToTray` 相同（**两者都必须**）：
 *  1. 应用启动时同步一次（Rust 读不到 WebView 的 localStorage）；
 *  2. 设置面板开关变更时立即下发。
 *
 * 非 Tauri 环境静默返回 false，不抛错。
 */
export async function setTileSnap(enabled: boolean): Promise<boolean> {
  if (!isTauri) return false
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<boolean>(COMMANDS.setTileSnap, { enabled })
}

/** 读取 Rust 侧当前的「磁贴吸附」值（诊断 / 与 localStorage 对账用） */
export async function readTileSnapFromRust(): Promise<boolean | null> {
  if (!isTauri) return null
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<boolean>(COMMANDS.tileSnapEnabled)
}

/* ------------------ t54：固定磁贴是否可被「全部显隐」隐藏 ------------------ */

/**
 * 下发「已固定的磁贴是否允许被全部显隐隐藏」给 Rust（`tiles::TILE_HIDE_PINNED`）。
 *
 * 调用时机与 `setTileSnap` 相同（**两者都必须**）：
 *  1. 应用启动时同步一次（Rust 读不到 WebView 的 localStorage）；
 *  2. 设置面板开关变更时立即下发。
 *
 * ⚠️ 这条必须下发 Rust：全部显隐由快捷键/托盘直接调 Rust，不经过前端。
 */
export async function setTileHidePinned(enabled: boolean): Promise<boolean> {
  if (!isTauri) return false
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<boolean>(COMMANDS.setTileHidePinned, { enabled })
}

/** 读取 Rust 侧当前的「固定磁贴可被隐藏」值（诊断 / 对账用） */
export async function readTileHidePinnedFromRust(): Promise<boolean | null> {
  if (!isTauri) return null
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<boolean>(COMMANDS.tileHidePinned)
}

/**
 * 订阅 `WINDOW_HIDDEN`（窗口被隐藏到托盘），返回取消订阅函数。
 *
 * §4.13 规则 4：UI 应据此给用户**可见反馈**（例如 Toast「已最小化到系统托盘」）。
 * 建议只在 `payload.firstCloseHide === true` 时提示一次，避免每次关闭都打扰。
 */
export async function onWindowHidden(
  handler: (payload: WindowHiddenPayload) => void,
): Promise<() => void> {
  if (!isTauri) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  const unlisten = await listen<WindowHiddenPayload>(EVENTS.windowHidden, (event) => {
    handler(event.payload)
  })
  return unlisten
}

/* --------------------------- 数据目录 --------------------------- */

/** 应用数据目录绝对路径（设置面板展示用；非 Tauri 环境返回空串） */
export async function getAppDataDir(): Promise<string> {
  if (!isTauri) return ''
  const { appDataDir } = await import('@tauri-apps/api/path')
  return appDataDir()
}

/* --------------------- t19：桌面便签磁贴（IPC 封装） --------------------- */

/**
 * `cmd_list_tiles` 的返回项（镜像 src-tauri/src/tiles.rs 的 `TileInfo`，camelCase 序列化）。
 *
 * 几何单位是**逻辑坐标**（物理坐标 ÷ `scale_factor`），跨 DPI 显示器时不会漂移。
 * 权威副本在 Rust 的 `app_data_dir()/tiles.json`，前端**不得**自行持久化几何。
 */
export interface TileInfo {
  noteId: string
  x: number
  y: number
  width: number
  height: number
  visible: boolean
  /**
   * t45：是否「固定」（固定的磁贴下次启动会自动出现）。
   * 权威值在 Rust（`tiles.json`），前端不自行推断。
   */
  /**
   * t47：吸附组号（0 = 未成组）。>0 表示这枚磁贴和别的磁贴吸在一起了。
   * 前端据此决定要不要显示「取消吸附」按钮。权威值在 Rust（`tiles.json`）。
   */
  group: number
}

/** `TILES_VISIBILITY_CHANGED` 的负载 */
export interface TilesVisibilityPayload {
  visible: boolean
}

/**
 * `PIN_CURRENT_NOTE_REQUESTED` 的负载。
 *
 * Rust **不知道**「当前笔记」是哪个，因此前端必须自行回填 `selectedId`；
 * Rust 侧只发空负载触发时机，不缓存选中项（避免出现第二个真相源）。
 */
export interface PinCurrentNotePayload {
  noteId: string | null
}

/**
 * 钉住 / 取消某条笔记的桌面磁贴。
 * 返回**新状态**：true = 调用后处于已钉住（窗口已存在）。
 * 非 Tauri 环境返回 null，调用方自行降级（浏览器 dev 下用新标签页预览磁贴 UI）。
 */
export async function toggleTile(noteId: string): Promise<boolean | null> {
  if (!isTauri) return null
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<boolean>(COMMANDS.toggleTile, { noteId })
}

/** 列出当前全部磁贴（权威状态含「全部隐藏」后仍在册的窗口）；非 Tauri 环境返回 null */
export async function listTiles(): Promise<TileInfo[] | null> {
  if (!isTauri) return null
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<TileInfo[]>(COMMANDS.listTiles)
}

/**
 * t45：固定 / 取消固定某枚磁贴（固定的下次启动会自动出现）。返回设置后的状态。
 * 非 Tauri 环境返回 null（调用方自行降级）。
 */
export async function setTilePinned(noteId: string, pinned: boolean): Promise<boolean | null> {
  if (!isTauri) return null
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<boolean>(COMMANDS.setTilePinned, { noteId, pinned })
}

/**
 * t47：取消吸附（把这枚磁贴从吸附组里移出来）。返回 true = 之前在组里；null = 命令不可用。
 */
export async function ungroupTile(noteId: string): Promise<boolean | null> {
  if (!isTauri) return null
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<boolean>(COMMANDS.ungroupTile, { noteId })
}

/**
 * t45：订阅「磁贴集合发生变化」（某枚磁贴被销毁）。
 * t47 起它同时用于「吸附组变化」（成组/解组）—— 磁贴据此刷新图钉与「取消吸附」按钮。
 * 返回取消订阅函数 —— 与其它订阅一样，组件卸载时必须调用。
 */
export async function onTilesChanged(handler: () => void): Promise<() => void> {
  if (!isTauri) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen(EVENTS.tilesChanged, () => {
    handler()
  })
}

/** 显示 / 隐藏全部磁贴（显隐由 Rust 对所有 `tile-*` 窗口执行）；非 Tauri 环境返回 null */
export async function setTilesVisible(visible: boolean): Promise<boolean | null> {
  if (!isTauri) return null
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<boolean>(COMMANDS.setTilesVisible, { visible })
}

/** 订阅「磁贴可见性变化」（快捷键触发时主窗口 UI 据此同步开关状态） */
export async function onTilesVisibilityChanged(
  handler: (payload: TilesVisibilityPayload) => void,
): Promise<() => void> {
  if (!isTauri) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen<TilesVisibilityPayload>(EVENTS.tilesVisibilityChanged, (event) => {
    handler(event.payload)
  })
}

/** 订阅「把当前笔记钉成磁贴」请求；回调里需由前端补上自己的 `selectedId` */
export async function onPinCurrentNoteRequested(
  handler: (payload: PinCurrentNotePayload) => void,
): Promise<() => void> {
  if (!isTauri) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen<PinCurrentNotePayload>(EVENTS.pinCurrentNoteRequested, (event) => {
    handler(event.payload)
  })
}

/* ------------------ t44：跨窗口笔记内容同步（IPC 封装） ------------------ */

/** 主窗口标签（`tauri.conf.json` 里主窗口的 `label`） */
export const MAIN_WINDOW_LABEL = 'main'

/** `NOTE_CHANGED` 的负载 */
export interface NoteChangedPayload {
  noteId: string
  /** 广播方窗口标签；接收方据此忽略自己的回声，**不可**用于任何权限判断 */
  source: string
}

/** 当前窗口标签（主窗口为 `main`，磁贴为 `tile-<noteId>`；纯浏览器下为 `browser`） */
export async function currentWindowLabel(): Promise<string> {
  if (!isTauri) return 'browser'
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow().label
}

/**
 * 广播「某条笔记内容已变更」，供其它窗口（主窗口 / 其它磁贴）重读该条。
 *
 * 设计约束（勿改）：
 *  1. 只广播 **id**，不广播内容 —— 内容是唯一真相源的衍生物，由接收方**重读**取得，
 *     避免出现第二份可失真的内容副本；重读路径自身不再广播 ⇒ 无回声循环。
 *  2. **永不抛错**：本函数挂在保存链路之后，广播失败不能连累「笔记已保存」这一事实。
 *  3. 无 Tauri 环境（`pnpm dev` 纯浏览器）静默降级为 no-op。
 */
export async function broadcastNoteChanged(noteId: string): Promise<void> {
  if (!isTauri || !noteId) return
  try {
    const [{ emit }, source] = await Promise.all([
      import('@tauri-apps/api/event'),
      currentWindowLabel(),
    ])
    await emit(EVENTS.noteChanged, { noteId, source } satisfies NoteChangedPayload)
  } catch (error) {
    console.warn('[tauri] 广播笔记变更失败（已忽略，不影响本地保存）:', error)
  }
}

/**
 * 订阅「其它窗口改动了某条笔记」；**自动过滤自己发出的回声**，回调只会收到别人的改动。
 *
 * 与 `onWindowHidden` 等订阅一样返回取消订阅函数，组件卸载时必须调用
 * （磁贴可被反复开关，漏掉会在每次重开后叠加一个订阅 ⇒ 重复重读）。
 */
export async function onNoteChanged(
  handler: (payload: NoteChangedPayload) => void,
): Promise<() => void> {
  if (!isTauri) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  const self = await currentWindowLabel()
  return listen<NoteChangedPayload>(EVENTS.noteChanged, (event) => {
    const payload = event.payload
    // 契约防御：负载来自事件总线，形状不可信，畸形负载直接丢弃而不是让接收方崩
    if (!payload || typeof payload.noteId !== 'string' || !payload.noteId) return
    if (payload.source === self) return
    handler(payload)
  })
}
