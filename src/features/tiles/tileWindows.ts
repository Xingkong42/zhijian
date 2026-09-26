/**
 * 主窗口侧的磁贴薄封装（「把某条笔记钉成桌面磁贴」）。
 * 归属：编辑器成员（任务 t24）；Rust 侧窗口创建/位置/生命周期归 t19（system）。
 *
 * 设计原则：
 *  1. **所有 Tauri API 都动态 import**（`@tauri-apps/api/*`），浏览器 dev 下永不加载，
 *     也不会因为缺权限在启动时就炸；
 *  2. **优先走 Rust 命令**（t19 的计划路径），命令不存在时自动退化为前端 `WebviewWindow` API；
 *     两条路都不可用时返回可读原因，而不是抛异常；
 *  3. 浏览器 dev 下用**新标签页**打开同一个 `?tile=` URL —— 磁贴 UI 因此可以纯浏览器验证，
 *     这也是我自检页的用法。
 *
 * ⚠️ 未完成的对接点（已同步给 t19 / t20）：
 *  a) Rust 命令名：见 `TILE_RUST_COMMANDS`，t19 定名后**只需改这一处常量**；
 *  b) 权限：`src-tauri/capabilities/default.json` 目前是 `"windows": ["main"]`，
 *     磁贴窗口（label `tile-*`）拿不到任何权限 —— 它既读不了 SQLite 也关不掉自己。
 *     需要新增一份 capability（见 features/tiles/README.md 的 JSON 片段），
 *     这属于 `src-tauri/**`，不在我的写入范围。
 */

import { isTauri } from '@/lib/tauri'
import {
  TILE_WINDOW_TITLE,
  tileWindowLabel,
  tileWindowUrl,
} from './tileUrl'

/**
 * Rust 侧命令名（**必须与 `src-tauri/src/lib.rs` 的 `generate_handler!` 逐字一致**）。
 *
 * ⚠️ 真实踩坑记录（system 复核发现）：这里一度写成 `tile_toggle`，而 Rust 注册的是
 * `tiles::cmd_toggle_tile` ⇒ `invoke` 报 not found，被下面的 catch 吞掉后静默退化成
 * 前端 `WebviewWindow` 建窗 —— 功能「看起来正常」，但 Rust 侧的几何持久化 /
 * 可见性事件 / 开机恢复磁贴**全都不执行**。现在自检脚本有一条跨界断言：
 * 直接读 `src-tauri/src/lib.rs` 与 `tiles.rs`，核对这几个名字确实被注册。
 *
 * 入参：`{ noteId }`（Rust 侧 `note_id: String`，Tauri 自动做 camelCase 映射）；
 * 返回：`Result<bool, String>` —— true = 调用后处于打开态。
 */
export const TILE_RUST_COMMANDS = {
  toggle: 'cmd_toggle_tile',
  list: 'cmd_list_tiles',
  setVisible: 'cmd_set_tiles_visible',
  /** t45：固定 / 取消固定（固定的磁贴下次启动自动出现） */
  setPinned: 'cmd_set_tile_pinned',
  /** t47：取消吸附（把磁贴从吸附组里移出来） */
  ungroup: 'cmd_ungroup_tile',
} as const

/**
 * 前端退化建窗时的窗口参数 —— **刻意与 Rust 常量保持一致**（`src-tauri/src/tiles.rs`：
 * `TILE_DEFAULT_WIDTH/HEIGHT = 280/240`、`TILE_MIN_WIDTH/HEIGHT = 160/120`），
 * 避免两条创建路径产出不同尺寸。自检脚本会拿 Rust 源码里的值逐项核对。
 */
export const TILE_FALLBACK_WINDOW = {
  width: 280,
  height: 240,
  minWidth: 160,
  minHeight: 120,
} as const

export type TileToggleAction = 'opened' | 'closed'

export type TileToggleResult =
  | {
      ok: true
      action: TileToggleAction
      /** 目标窗口 label（`tile-<noteId>`） */
      label: string
      /** true = 浏览器 dev 下用新标签页代替原生窗口（仅便于验证 UI） */
      devTab?: boolean
      /** 实际走的通道，便于诊断 */
      via: 'rust' | 'webview' | 'browser'
    }
  | {
      ok: false
      reason: 'browser-blocked' | 'unavailable' | 'error'
      message: string
      label: string
    }

function currentTileUrl(noteId: string): string {
  if (typeof window === 'undefined') return `?tile=${encodeURIComponent(noteId)}`
  return tileWindowUrl(noteId, window.location.origin, window.location.pathname)
}

/** `cmd_list_tiles` 的返回项（Rust 侧 `TileInfo` 是 camelCase 序列化） */
interface RustTileInfo {
  noteId?: string
  note_id?: string
  visible?: boolean
  /** t45：固定状态（旧命令版本可能没有该字段 ⇒ 按未固定处理） */
  pinned?: boolean
  /** t47：吸附组号（0 = 未成组） */
  group?: number
}

/** 主窗口侧关心的磁贴状态（比 Rust 的完整 TileInfo 少几何，只留 UI 要用的） */
export interface TileSummary {
  noteId: string
  visible: boolean
  pinned: boolean
  /** t47：>0 = 和别的磁贴吸在一组（磁贴据此显示「取消吸附」） */
  group: number
}

/**
 * 列出当前全部磁贴（含固定状态与吸附组号）。返回 null 表示命令不可用（浏览器 dev），调用方退化。
 * 对 `noteId` / `note_id` 两种序列化都容错，免得再踩一次命名坑。
 */
export async function listTiles(): Promise<TileSummary[] | null> {
  if (!isTauri) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result: unknown = await invoke(TILE_RUST_COMMANDS.list)
    if (!Array.isArray(result)) return null
    return (result as RustTileInfo[])
      .map((item) => ({
        noteId: item.noteId ?? item.note_id ?? '',
        visible: item.visible === true,
        pinned: item.pinned === true,
        group: typeof item.group === 'number' ? item.group : 0,
      }))
      .filter((tile) => tile.noteId.length > 0)
  } catch (error) {
    warnRustUnavailable(TILE_RUST_COMMANDS.list, error)
    return null
  }
}

/**
 * t47：取消吸附（把这枚磁贴从吸附组里移出来）。返回 true = 之前在组里；null = 命令不可用。
 *
 * 为什么要有显式按钮：拖动时"拖开即分开"是隐式解组，但用户未必知道要拖多远；
 * 一个明确的按钮能保证"想分开就一定能分开"（用户 Q1 选了"两者都要"）。
 */
export async function ungroupTile(noteId: string): Promise<boolean | null> {
  if (!isTauri) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result: unknown = await invoke(TILE_RUST_COMMANDS.ungroup, { noteId })
    return result === true
  } catch (error) {
    warnRustUnavailable(TILE_RUST_COMMANDS.ungroup, error)
    return null
  }
}

/**
 * t45：固定 / 取消固定某枚磁贴。返回设置后的状态；null = 命令不可用/失败。
 * 失败**不静默**：调用方（磁贴 UI）会据此提示用户，而不是让图钉看起来点动了却没生效。
 */
export async function setTilePinned(noteId: string, pinned: boolean): Promise<boolean | null> {
  if (!isTauri) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result: unknown = await invoke(TILE_RUST_COMMANDS.setPinned, { noteId, pinned })
    return result === true
  } catch (error) {
    warnRustUnavailable(TILE_RUST_COMMANDS.setPinned, error)
    return null
  }
}

/**
 * 列出当前已钉住的笔记 id（走 Rust `cmd_list_tiles`）。
 * 返回 null 表示该命令不可用（浏览器 dev / 命令缺失），调用方可退化。
 */
export async function listTileNoteIds(): Promise<string[] | null> {
  const tiles = await listTiles()
  return tiles ? tiles.map((tile) => tile.noteId) : null
}

/**
 * 某条笔记的磁贴窗口当前是否开着。
 * 优先问 Rust（`cmd_list_tiles` 是权威状态，含「全部隐藏」后仍在册的窗口），
 * 命令不可用时退化为前端按 label 查；浏览器 dev 恒为 false。
 */
export async function isTileWindowOpen(noteId: string): Promise<boolean> {
  const id = noteId.trim()
  const ids = await listTileNoteIds()
  if (ids) return ids.includes(id)
  if (!isTauri) return false
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    return (await WebviewWindow.getByLabel(tileWindowLabel(id))) !== null
  } catch (error) {
    console.warn('[纸笺] 前端按 label 查磁贴窗口失败（多半缺 core:window 相关权限）：', error)
    return false
  }
}

/** 一次性显示/隐藏所有磁贴（走 Rust `cmd_set_tiles_visible`；返回 null = 不可用） */
export async function setAllTilesVisible(visible: boolean): Promise<boolean | null> {
  if (!isTauri) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result: unknown = await invoke(TILE_RUST_COMMANDS.setVisible, { visible })
    return result === true
  } catch (error) {
    warnRustUnavailable('cmd_set_tiles_visible', error)
    return null
  }
}

/**
 * Rust 命令不可用时的统一警告。
 *
 * 这条日志是「静默降级」的解药：曾有一次 `TILE_RUST_COMMANDS.toggle` 写错名字
 * （`tile_toggle` ≠ `cmd_toggle_tile`），invoke 报 not found 被 catch 吞掉 →
 * 前端静默退化成 `WebviewWindow` 建窗，功能「看起来正常」，
 * 但 Rust 侧的几何持久化 / 可见性事件 / 开机恢复磁贴全都不执行。
 * 现在：失败有声音、并直接点名要核对什么。
 */
function warnRustUnavailable(command: string, error: unknown): void {
  console.warn(
    `[纸笺] Rust 命令 ${command} 调用失败，磁贴已退化为前端路径。` +
      '请核对 src-tauri/src/lib.rs 的 generate_handler! 是否注册该名字（自检有跨界断言）：',
    error,
  )
}

/** 走 Rust 命令；命令不存在 / 无权限时返回 null 让调用方退化（失败会 warn，不静默） */
async function toggleViaRust(noteId: string): Promise<TileToggleAction | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result: unknown = await invoke(TILE_RUST_COMMANDS.toggle, { noteId })
    if (result === 'closed' || result === false) return 'closed'
    return 'opened'
  } catch (error) {
    warnRustUnavailable(TILE_RUST_COMMANDS.toggle, error)
    return null
  }
}

/** 退化路径：前端直接建/关 WebviewWindow（需要 capability 允许创建窗口） */
async function toggleViaWebview(noteId: string): Promise<TileToggleAction | null> {
  const label = tileWindowLabel(noteId)
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    const existing = await WebviewWindow.getByLabel(label)
    if (existing) {
      await existing.close()
      return 'closed'
    }
    const created = new WebviewWindow(label, {
      url: currentTileUrl(noteId),
      // 标题与 Rust 侧的 `纸笺磁贴 · {note_id}` 保持一致
      title: `${TILE_WINDOW_TITLE} · ${noteId}`,
      width: TILE_FALLBACK_WINDOW.width,
      height: TILE_FALLBACK_WINDOW.height,
      minWidth: TILE_FALLBACK_WINDOW.minWidth,
      minHeight: TILE_FALLBACK_WINDOW.minHeight,
      decorations: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
    })
    // 创建是异步的：失败通过事件回来（权限缺失最常见）
    void created.once('tauri://error', (event) => {
      console.warn('[纸笺] 磁贴窗口创建失败（多半是 capability 未包含 tile-*）：', event)
    })
    return 'opened'
  } catch (error) {
    console.warn('[纸笺] 前端建窗路径不可用：', error)
    return null
  }
}

/**
 * 切换某条笔记的磁贴窗口：已开 → 关闭；未开 → 打开。
 * 主窗口侧「钉住这条笔记」按钮直接调用它即可。
 */
export async function toggleTileForNote(noteId: string): Promise<TileToggleResult> {
  const id = noteId.trim()
  const label = tileWindowLabel(id)
  if (!id) {
    return { ok: false, reason: 'error', message: 'noteId 为空，无法创建磁贴', label }
  }

  if (!isTauri) {
    // 浏览器 dev：同源新标签页打开同一 URL（磁贴 UI 可纯浏览器验证）
    if (typeof window === 'undefined') {
      return { ok: false, reason: 'browser-blocked', message: '当前环境没有 window', label }
    }
    window.open(currentTileUrl(id), label, 'noopener,width=320,height=240')
    return { ok: true, action: 'opened', label, devTab: true, via: 'browser' }
  }

  const viaRust = await toggleViaRust(id)
  if (viaRust) return { ok: true, action: viaRust, label, via: 'rust' }

  const viaWebview = await toggleViaWebview(id)
  if (viaWebview) return { ok: true, action: viaWebview, label, via: 'webview' }

  return {
    ok: false,
    reason: 'unavailable',
    message:
      '磁贴窗口暂时打不开：Rust 命令尚未注册，且前端窗口 API 未被授权。' +
      '请让 system（t19）注册命令或为 tile-* 窗口补 capability。',
    label,
  }
}

/**
 * 只关闭：磁贴开着就关掉，没开则 no-op（`closed` 表示「调用后处于关闭态」）。
 *
 * ⚠️ t45 修正的真 bug：本函数原先**无条件调用 toggle**，而 toggle 的语义是"没开就打开"
 * ⇒ 磁贴没开着时调它会**把磁贴打开**，函数却返回 `action: 'closed'`。
 * 调用方（"删掉这篇笔记时顺手关掉它的磁贴"）因此会**凭空造出一枚磁贴**。
 * 现在先问状态再决定，语义与函数名一致。
 */
export async function closeTileForNote(noteId: string): Promise<TileToggleResult> {
  const id = noteId.trim()
  const label = tileWindowLabel(id)
  if (!isTauri) return { ok: true, action: 'closed', label, via: 'browser' }
  if (!id) return { ok: false, reason: 'error', message: 'noteId 为空，无法关闭磁贴', label }

  // 没开着就什么都不做（绝不能退化成"打开它"）
  if (!(await isTileWindowOpen(id))) {
    return { ok: true, action: 'closed', label, via: 'rust' }
  }

  const viaRust = await toggleViaRust(id)
  if (viaRust) return { ok: true, action: 'closed', label, via: 'rust' }

  const viaWebview = await toggleViaWebview(id)
  if (viaWebview) return { ok: true, action: 'closed', label, via: 'webview' }

  return { ok: false, reason: 'unavailable', message: '无法关闭磁贴窗口（命令与权限都不可用）', label }
}
