/**
 * 快捷键契约与实现（FROZEN 签名由架构师提供，事件桥由系统集成 / 任务 t6 追加）。
 *
 * 三层快捷键：
 *  1. **Rust 全局快捷键**（`src-tauri/src/shortcuts.rs`）：窗口未聚焦也生效。
 *     Alt+N → 显示并聚焦窗口 + emit `zhijian://new-note-requested`；
 *     Alt+Shift+Z → 切换窗口显隐。
 *  2. **本文件的事件桥**：`bindGlobalHotkeys()` 监听上面两个事件，分别调用
 *     `notesStore.create()` 与 `uiStore.setView('settings')`（托盘菜单也走这两个事件）。
 *  3. **应用内本地快捷键**：`bindShortcuts()`（Ctrl+K / Ctrl+S / …）。
 *
 * 浏览器开发态（`pnpm dev`，无 Tauri）没有全局快捷键，本文件提供 window keydown 回退：
 *   - Alt+N → 新建笔记；
 *   - Alt+Shift+Z → 切换「设置」面板（浏览器里没有可显隐的窗口，退化为视图切换）。
 * Tauri 运行时**不会**重复绑定，避免一次按键创建两条笔记。
 */

import type { Unsubscribe } from '@/types'
import { EVENTS, isTauri, onPinCurrentNoteRequested, onTilesVisibilityChanged } from '@/lib/tauri'

/** 全局快捷键（Rust 侧注册，窗口未聚焦也生效） */
export const GLOBAL_SHORTCUTS = {
  /** 新建笔记：Alt+N */
  newNote: 'Alt+N',
  /** 唤起/隐藏主窗口：Alt+Shift+Z */
  toggleWindow: 'Alt+Shift+Z',
} as const

/** 应用内快捷键（前端 keydown 监听） */
export const LOCAL_SHORTCUTS = {
  search: 'Ctrl+K',
  save: 'Ctrl+S',
  togglePreview: 'Ctrl+E',
  /**
   * 折叠/展开侧栏。
   *
   * ⚠️ **不要改回 `Ctrl+B`**：CodeMirror 编辑器用 `Mod-b` 做「加粗」
   * （`src/features/editor/CodeMirrorEditor.tsx:124`），编辑器内焦点时会把该组合键吃掉，
   * 于是侧栏折叠在编辑器里永远不生效（QA 报告 D2 实测复现）。
   * `Ctrl+\` 在编辑器与全局都没有占用，故选它。
   */
  toggleSidebar: 'Ctrl+\\',
  deleteNote: 'Ctrl+Delete',
  escape: 'Escape',
} as const

export type LocalShortcutId = keyof typeof LOCAL_SHORTCUTS

export type ShortcutHandler = () => void

export type ShortcutHandlers = Partial<Record<LocalShortcutId, ShortcutHandler>>

/** `bindGlobalHotkeys` 可注入的动作（默认走真实 store；测试/集成可覆盖） */
export interface GlobalHotkeyActions {
  /** 新建笔记并选中；默认 `notesStore.create()` */
  newNote?: () => void | Promise<unknown>
  /** 打开设置面板；默认 `uiStore.setView('settings')` */
  openSettings?: () => void
  /**
   * 「把当前笔记钉成磁贴」（t19/t20，快捷键动作 `pinNote`）。
   *
   * ⚠️ **必须由 App 注入**：Rust 只知道「用户按了键」，**不知道当前选中的是哪条笔记**
   * （选中项是纯前端状态）。所以 Rust 只负责「显示主窗口 + emit 事件」，
   * 由 App 用自己 store 里的 `selectedId` 回填 —— 刻意不让 Rust 缓存选中项，
   * 否则会出现第二个真相源（ARCHITECTURE §4.14.7）。
   * 未注入时只告警一次，不抛错（磁贴功能不应拖垮快捷键桥）。
   */
  pinCurrentNote?: () => void | Promise<unknown>
  /** 磁贴可见性被快捷键切换（仅用于 UI 同步开关状态；显隐本身由 Rust 完成） */
  tilesVisibilityChanged?: (visible: boolean) => void
  /** 错误回调（store 尚未实现 / 数据库未就绪时给出可读提示） */
  onError?: (message: string) => void
}

/**
 * 把快捷键字符串规范化为小写比较键，例如 'Ctrl+K' → 'ctrl+k'。
 * 'Mod' 是平台无关写法，Windows/Linux 映射为 ctrl。
 */
export function normalizeShortcut(accelerator: string): string {
  return accelerator
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/mod/g, 'ctrl')
    .split('+')
    .sort()
    .join('+')
}

/** 从 KeyboardEvent 推导规范化比较键 */
export function shortcutFromEvent(event: KeyboardEvent): string {
  const parts: string[] = []
  if (event.ctrlKey || event.metaKey) parts.push('ctrl')
  if (event.altKey) parts.push('alt')
  if (event.shiftKey) parts.push('shift')
  const key = event.key.toLowerCase()
  if (!['control', 'meta', 'alt', 'shift'].includes(key)) parts.push(key)
  return parts.sort().join('+')
}

/**
 * 绑定应用内快捷键，返回取消订阅函数。
 * 命中时调用 event.preventDefault()，避免浏览器默认行为干扰。
 */
export function bindShortcuts(handlers: ShortcutHandlers): Unsubscribe {
  const table = new Map<string, ShortcutHandler>()
  for (const [id, handler] of Object.entries(handlers)) {
    if (!handler) continue
    const accel = LOCAL_SHORTCUTS[id as LocalShortcutId]
    table.set(normalizeShortcut(accel), handler)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const handler = table.get(shortcutFromEvent(event))
    if (!handler) return
    event.preventDefault()
    handler()
  }

  window.addEventListener('keydown', onKeyDown)
  return () => window.removeEventListener('keydown', onKeyDown)
}

/** 判断某个快捷键是否匹配当前事件（供组件内部使用） */
export function matchesShortcut(event: KeyboardEvent, id: LocalShortcutId): boolean {
  return shortcutFromEvent(event) === normalizeShortcut(LOCAL_SHORTCUTS[id])
}

/* ------------------------- Rust → 前端事件桥（t6） ------------------------- */

/** 是否命中全局 Alt+N：要求恰好 alt（不带 ctrl/meta/shift），key 为 n（大小写无关） */
export function isNewNoteEvent(event: KeyboardEvent): boolean {
  return (
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.repeat &&
    event.key.toLowerCase() === 'n'
  )
}

/** 是否命中 Alt+Shift+Z（窗口显隐） */
export function isToggleWindowEvent(event: KeyboardEvent): boolean {
  return (
    event.altKey &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.repeat &&
    event.key.toLowerCase() === 'z'
  )
}

/** 默认动作 1：新建笔记（懒加载 notesStore，避免模块加载期就依赖尚未实现的 store） */
async function defaultNewNote(): Promise<void> {
  const { useNotesStore } = await import('@/store/notes')
  await useNotesStore.getState().create()
}

/** 默认动作 2：打开设置面板 */
async function defaultOpenSettings(): Promise<void> {
  const { useUiStore } = await import('@/store/ui')
  useUiStore.getState().setView('settings')
}

function reportError(actions: GlobalHotkeyActions, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.warn('[纸笺] 快捷键动作失败：', message)
  actions.onError?.(message)
}

/**
 * 绑定「全局快捷键 / 托盘」事件与浏览器回退。
 *
 * 返回取消订阅函数；在非浏览器环境（SSR）返回空操作。
 */
export function bindGlobalHotkeys(actions: GlobalHotkeyActions = {}): Unsubscribe {
  if (typeof window === 'undefined') return () => {}

  const runNewNote = () => {
    const handler = actions.newNote
    const result = handler ? handler() : defaultNewNote()
    void Promise.resolve(result).catch((error: unknown) => reportError(actions, error))
  }

  const runOpenSettings = () => {
    const handler = actions.openSettings
    if (handler) {
      handler()
      return
    }
    void defaultOpenSettings().catch((error: unknown) => reportError(actions, error))
  }

  const runPinCurrentNote = () => {
    const handler = actions.pinCurrentNote
    if (!handler) {
      // 不抛错：磁贴不可用不应影响其它快捷键。给出一次可定位的告警。
      console.warn('[纸笺] 收到「钉住当前笔记」请求，但集成层未注入 pinCurrentNote 处理器（忽略）')
      return
    }
    void Promise.resolve(handler()).catch((error: unknown) => reportError(actions, error))
  }

  const disposers: Unsubscribe[] = []
  // 异步注册（await listen）期间可能已经收到 dispose 调用，用标记兜住，避免监听器泄漏
  let disposed = false

  if (isTauri) {
    // Rust 侧（全局快捷键 / 托盘菜单）统一 emit 这些事件。
    //
    // ⚠️ 磁贴的两个事件**刻意走 `src/lib/tauri.ts` 的封装**（`onPinCurrentNoteRequested` /
    //    `onTilesVisibilityChanged`），而不是在这里裸写 `listen(EVENTS.x)` ——
    //    t31 的 D1 防复发断言要求「同一事件的 `listen()` 全仓只有 1 处」，
    //    而封装文件里那一处已占用该名额（App / hotkeys 都只调用封装，不重复 listen）。
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const registered = await Promise.all([
          // 下面三个是 t6/t17 的既有热键事件。**保持裸 `listen(EVENTS.x)` 写法不要动**：
          // t31 的静态断言正是靠扫描这种字面形态来保证「同一事件全仓只有 1 处订阅」，
          // 若把它们收敛进一个泛型 helper，该断言会静默失去对这些事件的覆盖。
          listen(EVENTS.newNoteRequested, () => runNewNote()),
          listen(EVENTS.openSettingsRequested, () => runOpenSettings()),
          listen(EVENTS.appQuitRequested, () => {
            // Rust 侧随后自行退出；这里只给前端一次收尾机会（例如 flush 未保存内容）
            window.dispatchEvent(new Event('zhijian:quit-requested'))
          }),
          // t19/t20：磁贴的两个事件**走封装**（见上方说明）—— 封装文件里已占用
          // 「该事件唯一 listen 文本点」的名额，这里不能再裸写，否则 D1 断言会判为重复订阅。
          onPinCurrentNoteRequested(() => runPinCurrentNote()),
          onTilesVisibilityChanged((payload) => actions.tilesVisibilityChanged?.(payload.visible)),
        ])
        if (disposed) {
          for (const unlisten of registered) unlisten()
          return
        }
        disposers.push(...registered)
      } catch (error) {
        reportError(actions, error)
      }
    })()
  }

  // 浏览器开发态回退：没有全局快捷键，用 window keydown 捕获 alt+N / alt+shift+Z。
  // Tauri 运行时由 Rust 全局快捷键负责（含窗口未聚焦），此处不重复绑定。
  if (!isTauri) {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isNewNoteEvent(event)) {
        event.preventDefault()
        runNewNote()
        return
      }
      if (isToggleWindowEvent(event)) {
        event.preventDefault()
        runOpenSettings()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    disposers.push(() => window.removeEventListener('keydown', onKeyDown))
  }

  return () => {
    disposed = true
    for (const dispose of disposers.splice(0)) dispose()
  }
}

/* ------------------------- 注册状态（设置面板用） ------------------------- */

export type ShortcutRegistrationState = 'registered' | 'conflict' | 'unsupported'

/**
 * 查询本应用是否成功注册了某个全局快捷键（设置面板的「冲突提示」数据源）。
 *
 * - `registered`：已注册，快捷键全局可用；
 * - `conflict`：注册未生效（被其它程序占用，或注册失败）；
 * - `unsupported`：非 Tauri 环境（浏览器开发态）。
 */
export async function checkGlobalShortcut(
  accelerator: string = GLOBAL_SHORTCUTS.newNote,
): Promise<ShortcutRegistrationState> {
  if (!isTauri) return 'unsupported'
  try {
    const { isRegistered } = await import('@tauri-apps/plugin-global-shortcut')
    return (await isRegistered(toTauriAccelerator(accelerator))) ? 'registered' : 'conflict'
  } catch {
    return 'conflict'
  }
}

/**
 * 把面向用户的写法（`Alt+N` / `Ctrl+K`）转成 Tauri 全局快捷键插件接受的加速器
 * （`alt+KeyN` / `ctrl+KeyK`）。插件内部用 DOM 风格解析，字母键需写成 `KeyX`。
 */
export function toTauriAccelerator(accelerator: string): string {
  const parts = accelerator
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)

  const keys: string[] = []
  const modifiers: string[] = []
  for (const part of parts) {
    const lower = part.toLowerCase()
    switch (lower) {
      case 'ctrl':
      case 'control':
        modifiers.push('control')
        break
      case 'alt':
        modifiers.push('alt')
        break
      case 'shift':
        modifiers.push('shift')
        break
      case 'meta':
      case 'cmd':
      case 'command':
      case 'super':
        modifiers.push('super')
        break
      default: {
        const named = NAMED_KEYS[lower]
        keys.push(named ?? (lower.length === 1 ? `Key${lower.toUpperCase()}` : part))
      }
    }
  }
  return [...modifiers, ...keys].join('+')
}

/** 非字母键的 DOM 风格键名（`Code` 枚举名） */
const NAMED_KEYS: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  comma: 'Comma',
  period: 'Period',
  slash: 'Slash',
  semicolon: 'Semicolon',
  quote: 'Quote',
  backquote: 'Backquote',
  minus: 'Minus',
  equal: 'Equal',
  bracketleft: 'BracketLeft',
  bracketright: 'BracketRight',
  backslash: 'Backslash',
}
