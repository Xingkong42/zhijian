/**
 * 自定义全局快捷键（§4.13 家族；任务 t17）。
 * 归属：系统集成（`src/features/settings/**`）。
 *
 * ## 数据流与权威源
 * | 关注点 | 权威源 |
 * | --- | --- |
 * | **持久化**（跨重启记住键位） | 前端 `localStorage['zhijian.shortcuts']`（JSON） |
 * | **注册**（键位是否真的全局生效） | Rust（`cmd_sync_global_shortcuts`，进程内） |
 *
 * Rust 读不到 localStorage，因此与「关闭到托盘」同一套路：
 * **应用启动时**同步一次 + **改键位时**立即同步。前端另做两件 Rust 做不了的事：
 *  1. **录入期校验**（空组合 / 非法组合 / 应用内重复）—— 不把坏数据发给 Rust；
 *  2. **冲突预检**（`plugin-global-shortcut` 的 `isRegistered`）—— 已在别处注册的键直接拒绝。
 *
 * ## 「实际生效」而非「用户填的值」
 * 设置页展示的键位来自**回传的生效结果** `bindings`（Rust 逐个注册成功后的映射），
 * 而不是用户输入。若某条被系统/其它程序占用，会显示为「未生效」并给出原因，
 * 避免出现「改了没反应」的假开关。
 *
 * ## 关于磁贴的两个动作（t19 落地 / t20 接线）
 * 磁贴已实现（`src-tauri/src/tiles.rs` + `src/features/tiles/**`），因此：
 *  - 磁贴动作有两个：`toggleTiles`（显隐全部）与 `pinNote`（钉住当前笔记）；
 *  - `toggleTiles` 是正式动作名（§4.14.6），`pinNote` 把**当前笔记**钉成磁贴。
 * 三者**默认都不占用全局键位**（`defaultEnabled: false`），由用户显式开启。
 * Rust 侧 `SUPPORTED_ACTION_IDS` 共 6 个 id，与此处的清单**双向一致**
 * （由 `pnpm check:contract` 机器化核对）。
 */

// ⚠️ 别名导入：本文件自己也有一个 `SHORTCUT_ACTION_IDS`（由 `SHORTCUT_ACTIONS` 推导，
//    保持既有导出名不变以免破坏调用方）。类型必须来自 **tauri.ts 那一份**（唯一真相源）。
import {
  EVENTS,
  SHORTCUT_ACTION_IDS as TAURI_ACTION_IDS,
  isTauri,
} from '@/lib/tauri'
import { readShortcutsRaw, writeShortcutsRaw } from '@/lib/appPreferences'

/* --------------------------- 定义与默认值 --------------------------- */

/**
 * 动作 id 联合类型。
 *
 * ⚠️ **必须从 `@/lib/tauri` 的 `SHORTCUT_ACTION_IDS` 推导，不许在这里手抄一份字面量联合**。
 * 历史上这里确实手抄过一份 5 项的字面量联合，而 `check:contract` 只核对
 * 「tauri.ts ↔ Rust」两张表 —— 于是**第三份副本**（本文件这一份）漂移时没有任何门会红。
 * t44 新增 `quickNote` 时正是被它拦下（TS2322）：这不是运气，只要两边同时改到就会静默不一致，
 * 而现在推导自同一常量 ⇒ 新增动作只需改 tauri.ts 与 Rust 两处。
 */
export type ShortcutActionId = (typeof TAURI_ACTION_IDS)[number]

export interface ShortcutActionDefinition {
  id: ShortcutActionId
  label: string
  /** 说明该键位做什么（设置面板副标题） */
  description: string
  /** 默认键位；`null` = 默认不绑定 */
  defaultAccelerator: string | null
  /** 是否允许用户清空（设为「不绑定」） */
  clearable: boolean
  /** 默认是否启用 */
  defaultEnabled: boolean
}

export const SHORTCUT_ACTIONS: readonly ShortcutActionDefinition[] = [
  {
    id: 'newNote',
    label: '新建笔记',
    description: '任何界面下按下即唤起窗口并新建一条笔记',
    defaultAccelerator: 'Alt+N',
    clearable: false,
    defaultEnabled: true,
  },
  {
    id: 'toggleWindow',
    label: '显示/隐藏窗口',
    description: '切换主窗口显隐（后台常驻时的快速唤起）',
    defaultAccelerator: 'Alt+Shift+Z',
    clearable: false,
    defaultEnabled: true,
  },
  {
    id: 'openSettings',
    label: '打开设置',
    description: '唤起窗口并直接打开本设置面板（默认不占用全局键位，需要时自行录入）',
    defaultAccelerator: 'Alt+,',
    clearable: true,
    // §4.8.1（FROZEN）：**默认只注册前两个动作**。
    // `Alt+,` 是常见应用会占用的组合，默认抢一个全局键位既可能冲突、也超出
    // 「后台常驻」的必要范围 —— 交由用户显式开启（开关式 entry 的语义即「绑定 + 启用」）。
    defaultEnabled: false,
  },
  {
    id: 'toggleTiles',
    label: '显示/隐藏全部磁贴',
    description:
      '一次性显示或隐藏桌面上的**临时**磁贴（显隐由 Rust 完成，无需主窗口在场）；已固定的磁贴不受影响，永远留在桌面上',
    defaultAccelerator: null,
    clearable: true,
    // §4.14.6：`toggleTiles` / `pinNote` **默认都不占用全局键位**，由用户显式开启
    defaultEnabled: false,
  },
  {
    id: 'pinNote',
    label: '钉住当前笔记为磁贴',
    description: '把当前选中的笔记钉成桌面磁贴（再按一次取消）；未选中笔记时给出提示',
    defaultAccelerator: null,
    clearable: true,
    defaultEnabled: false,
  },
  {
    id: 'quickNote',
    label: '快速笔记',
    description: '弹出一个小捕捉框，写一句按 Enter 即成一条笔记（**不打开主界面**）',
    // t44：给一个可用的建议键位，但**默认不启用** —— §4.8.1 冻结了
    // 「默认只注册前两个动作」（避免默认抢占其它程序的全局键位）。
    // 用户想用「立马打开」，在设置里开一下即可（或直接用托盘菜单的「快速笔记…」）。
    defaultAccelerator: 'Alt+Shift+N',
    clearable: true,
    defaultEnabled: false,
  },
]

export const SHORTCUT_ACTION_IDS: readonly ShortcutActionId[] = SHORTCUT_ACTIONS.map((a) => a.id)

export function shortcutDefinition(id: ShortcutActionId): ShortcutActionDefinition {
  const found = SHORTCUT_ACTIONS.find((action) => action.id === id)
  if (!found) throw new Error(`未知的快捷键动作：${id}`)
  return found
}

export interface ShortcutBinding {
  id: ShortcutActionId
  /** 用户可读的键位串，如 `Alt+N`；`null` = 已清空（不绑定） */
  accelerator: string | null
  /** 仅不绑定时为 false */
  enabled: boolean
}

export type ShortcutBindings = Record<ShortcutActionId, ShortcutBinding>

export const DEFAULT_SHORTCUT_BINDINGS: ShortcutBindings = SHORTCUT_ACTIONS.reduce(
  (acc, action) => {
    acc[action.id] = {
      id: action.id,
      accelerator: action.defaultAccelerator,
      enabled: action.defaultEnabled,
    }
    return acc
  },
  {} as ShortcutBindings,
)

/* --------------------------- 键位解析与校验 --------------------------- */

/** 允许的无修饰键（功能键与少数符号键可单键触发；字母/数字单键会抢占正常输入，禁止） */
const ALLOWED_BARE_KEYS = new Set([
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
  'pause',
  'scrolllock',
  'printscreen',
])

const MODIFIER_KEYS = new Set(['control', 'meta', 'alt', 'shift', 'altgraph', 'os'])

/** DOM `KeyboardEvent.key` → 展示用键名 */
const KEY_DISPLAY: Record<string, string> = {
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  escape: 'Esc',
  esc: 'Esc',
  enter: 'Enter',
  return: 'Enter',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  tab: 'Tab',
  space: 'Space',
  ',': ',',
  '.': '.',
  '/': '/',
  ';': ';',
  "'": "'",
  '-': '-',
  '=': '=',
  '[': '[',
  ']': ']',
  '\\': '\\',
  '`': '`',
}

/** 主键展示 → 小写比较键（用于比较与冲突检测） */
function toCompareKey(key: string): string {
  return key.toLowerCase()
}

export interface ParsedAccelerator {
  /** 规范化修饰键（顺序固定 alt / ctrl / shift / meta） */
  modifiers: string[]
  /** 规范化主键（展示形态，如 `N` / `F5` / `,`） */
  key: string
  /** 是否带至少一个修饰键（功能键允许不带） */
  hasModifier: boolean
}

/**
 * 解析键位串；非法输入返回 `null`。
 * 接受 `Alt+N`、`Ctrl+Shift+K`、`Alt+,`、`F5` 等写法（大小写与空格不敏感）。
 */
export function parseAccelerator(accelerator: string | null | undefined): ParsedAccelerator | null {
  if (typeof accelerator !== 'string') return null
  const text = accelerator.trim()
  if (!text) return null

  const parts = text
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (parts.length === 0) return null

  const modifiers = new Set<string>()
  let key: string | null = null

  for (const part of parts) {
    const lower = part.toLowerCase()
    switch (lower) {
      case 'alt':
        modifiers.add('alt')
        continue
      case 'ctrl':
      case 'control':
        modifiers.add('ctrl')
        continue
      case 'shift':
        modifiers.add('shift')
        continue
      case 'meta':
      case 'cmd':
      case 'command':
      case 'super':
        modifiers.add('meta')
        continue
      default:
        break
    }
    if (key !== null) return null // 出现第二个非修饰键 → 非法（如 Ctrl+K+J）
    key = normalizeKeyName(lower)
    if (!key) return null
  }

  if (key === null) return null // 只有修饰键 → 非法

  const ordered = ['alt', 'ctrl', 'shift', 'meta'].filter((mod) => modifiers.has(mod))
  const hasModifier = ordered.length > 0
  if (!hasModifier && !ALLOWED_BARE_KEYS.has(key.toLowerCase())) return null
  // Alt 与 Meta 之外的「Ctrl/Shift 单独 + 字母」也算合法组合，无需额外限制
  return { modifiers: ordered, key, hasModifier }
}

/** 把单个键名规范化为展示形态；无法识别返回 null */
function normalizeKeyName(lower: string): string | null {
  if (KEY_DISPLAY[lower]) return KEY_DISPLAY[lower]
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower.toUpperCase()
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase()
  if (/^[0-9]$/.test(lower)) return lower
  if (['numpad0', 'numpad1', 'numpad2', 'numpad3', 'numpad4', 'numpad5', 'numpad6', 'numpad7', 'numpad8', 'numpad9'].includes(lower)) {
    return lower.replace('numpad', 'Num')
  }
  return null
}

/** 规范化键位串（用于比较 / 去重）；非法输入返回 `null` */
export function normalizeAccelerator(accelerator: string | null | undefined): string | null {
  const parsed = parseAccelerator(accelerator)
  if (!parsed) return null
  return [...parsed.modifiers, toCompareKey(parsed.key)].join('+')
}

/** 展示用键位串（把用户输入整理成统一写法） */
export function formatAccelerator(accelerator: string): string | null {
  const parsed = parseAccelerator(accelerator)
  if (!parsed) return null
  const modifierLabels: Record<string, string> = {
    alt: 'Alt',
    ctrl: 'Ctrl',
    shift: 'Shift',
    meta: 'Meta',
  }
  return [...parsed.modifiers.map((mod) => modifierLabels[mod]), parsed.key].join('+')
}

/** 从键盘事件生成键位串；不可用（只按了修饰键 / 非法键）返回 null */
export function acceleratorFromEvent(event: {
  key: string
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  metaKey: boolean
}): string | null {
  const key = event.key
  if (!key) return null
  if (MODIFIER_KEYS.has(key.toLowerCase())) return null // 还在按修饰键，继续等待

  const parts: string[] = []
  if (event.altKey) parts.push('Alt')
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Meta')

  const lower = key.toLowerCase()
  const display = normalizeKeyName(lower)
  if (!display) return null
  parts.push(display)
  return formatAccelerator(parts.join('+'))
}

export interface AcceleratorValidation {
  ok: boolean
  /** 规范化键位（ok=true 时非空） */
  normalized?: string
  /** 展示用键位 */
  formatted?: string
  /** 失败原因（中文，可直接展示） */
  reason?: string
}

/** 校验单个键位串（不含跨动作重复检查） */
export function validateAccelerator(
  accelerator: string | null | undefined,
  action: ShortcutActionDefinition,
): AcceleratorValidation {
  if (accelerator === null || accelerator === undefined) {
    return action.clearable
      ? { ok: true }
      : { ok: false, reason: `「${action.label}」必须绑定一个键位（不可留空）` }
  }
  const text = accelerator.trim()
  if (!text) {
    return action.clearable
      ? { ok: true }
      : { ok: false, reason: `「${action.label}」必须绑定一个键位（不可留空）` }
  }
  const parsed = parseAccelerator(text)
  if (!parsed) {
    return {
      ok: false,
      reason: '键位无效：至少需要一个修饰键（Alt / Ctrl / Shift）加一个主键，或使用 F1–F12',
    }
  }
  const normalized = normalizeAccelerator(text)
  const formatted = formatAccelerator(text)
  if (!normalized || !formatted) {
    return { ok: false, reason: '键位无法规范化，请换一个组合' }
  }
  return { ok: true, normalized, formatted }
}

/* --------------------------- 应用内冲突检测 --------------------------- */

export interface ShortcutConflict {
  /** 与该动作冲突 */
  withId: ShortcutActionId
  withLabel: string
}

/** 检查候选键位是否与其它**已启用**动作重复（不含自身） */
export function findConflict(
  bindings: ShortcutBindings,
  id: ShortcutActionId,
  accelerator: string | null,
): ShortcutConflict | null {
  const normalized = normalizeAccelerator(accelerator)
  if (!normalized) return null
  for (const action of SHORTCUT_ACTIONS) {
    if (action.id === id) continue
    const other = bindings[action.id]
    if (!other || !other.enabled || !other.accelerator) continue
    if (normalizeAccelerator(other.accelerator) === normalized) {
      return { withId: action.id, withLabel: action.label }
    }
  }
  return null
}

/* --------------------------- 持久化 --------------------------- */

/** 从 localStorage 读取绑定；任何非法值都回落到该动作默认值 */
export function readShortcutBindings(): ShortcutBindings {
  const raw = readShortcutsRaw()
  const result: ShortcutBindings = { ...DEFAULT_SHORTCUT_BINDINGS }
  if (!raw) return result
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return result
  }
  if (!parsed || typeof parsed !== 'object') return result

  const record = parsed as Record<string, unknown>
  for (const action of SHORTCUT_ACTIONS) {
    const entry = record[action.id]
    if (!entry || typeof entry !== 'object') continue
    const value = entry as Record<string, unknown>
    const rawAccelerator = typeof value['accelerator'] === 'string' ? value['accelerator'] : null
    // 逐项校验：非法键位（手工改坏 localStorage）回落默认，避免把坏值下发给 Rust
    const check = validateAccelerator(rawAccelerator, action)
    const enabled = value['enabled'] === undefined ? action.defaultEnabled : value['enabled'] === true
    if (check.ok) {
      result[action.id] = {
        id: action.id,
        accelerator: check.formatted ?? null,
        enabled: rawAccelerator === null ? false : enabled,
      }
    }
  }
  return result
}

export function writeShortcutBindings(bindings: ShortcutBindings): void {
  writeShortcutsRaw(JSON.stringify(bindings))
}

/**
 * t46：**启动时**把持久化的绑定下发给 Rust。
 *
 * 与 `syncGlobalShortcuts` 是同一件事（同一个命令、同一份校验），单独成函数只为表达意图 +
 * 让自检能把"启动必须下发"这条钉死。不这么做的话：Rust 启动只注册 `default_bindings()`
 * （newNote / toggleWindow），而用户自定义的 `toggleTiles` / `pinNote` / `openSettings`
 * 只在他打开过设置面板之后才存在 ⇒ **重启即失效**（用户报错原话：
 * 「关闭程序后再开启，关于磁贴的快捷键失效」）。
 *
 * `onFailure` 只在"没同步成功 / 有条目注册失败"时被调用一次，参数是可读中文说明；
 * 由调用方决定怎么呈现（App 用 Toast —— 静默失效的键位用户只会以为"坏了"）。
 */
export async function syncShortcutBindingsOnStartup(
  onFailure?: (reason: string) => void,
): Promise<ShortcutSyncResult> {
  const result = await syncGlobalShortcuts(readShortcutBindings())
  if (onFailure && !result.synced) {
    onFailure(result.unavailableReason ?? '快捷键服务不可用（旧版本或浏览器预览）')
    return result
  }
  if (onFailure && result.failed.length > 0) {
    onFailure(
      result.failed
        .map((item) => `${item.accelerator}（${item.reason}）`)
        .join('、'),
    )
  }
  return result
}

/* --------------------------- 同步（下发 Rust） --------------------------- */

export interface ShortcutSyncFailure {
  id: ShortcutActionId | string
  accelerator: string
  reason: string
}

export interface ShortcutSyncResult {
  /** 本次是否真的下发了（非 Tauri 环境为 false） */
  synced: boolean
  /** Rust 实际注册成功的键位映射（真实生效值） */
  applied: Record<string, string>
  /** 注册失败的键位与原因（被其它程序占用等） */
  failed: ShortcutSyncFailure[]
  /** Rust 不可用时的可读说明（浏览器预览 / 命令未实现） */
  unavailableReason: string | null
}

/** 浏览器回退：没有全局快捷键，退回本地 keydown 绑定的可读说明 */
export const LOCAL_FALLBACK_NOTE =
  '当前不在桌面端运行：全局快捷键不可用，已退化为窗口内按键（仅窗口聚焦时生效）。'

const EMPTY_SYNC: ShortcutSyncResult = {
  synced: false,
  applied: {},
  failed: [],
  unavailableReason: null,
}

/** 待注册的绑定（只包含 enabled 且有键位的项） */
export function activeBindings(bindings: ShortcutBindings): ShortcutBinding[] {
  return SHORTCUT_ACTIONS.map((action) => bindings[action.id])
    .filter((binding): binding is ShortcutBinding => Boolean(binding))
    .filter((binding) => binding.enabled && Boolean(binding.accelerator))
}

/**
 * 把绑定下发给 Rust（启动时一次 + 改键位时一次，两条路径共用）。
 *
 * - 非 Tauri：返回 `synced: false` + 可读说明（调用方退化为窗口内按键）；
 * - Rust 命令尚未实现（t17 依赖的 `cmd_sync_global_shortcuts`）：
 *   返回 `synced: false` + 说明，**不抛错**（设置面板据此显示「待后端就绪」而不是崩掉）。
 */
export async function syncGlobalShortcuts(
  bindings: ShortcutBindings = readShortcutBindings(),
  options: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } = {},
): Promise<ShortcutSyncResult> {
  if (!isTauri && !options.invoke) {
    return { ...EMPTY_SYNC, unavailableReason: LOCAL_FALLBACK_NOTE }
  }
  const payload = activeBindings(bindings).map((binding) => ({
    id: binding.id,
    accelerator: binding.accelerator as string,
  }))

  try {
    const call =
      options.invoke ??
      (async (cmd: string, args?: unknown) => {
        const { invoke } = await import('@tauri-apps/api/core')
        return invoke(cmd, args as Record<string, unknown>)
      })
    const raw = await call('cmd_sync_global_shortcuts', { bindings: payload })
    return parseSyncResponse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      synced: false,
      applied: {},
      failed: [],
      unavailableReason: `快捷键同步失败（后端接口未就绪或调用出错）：${message}`,
    }
  }
}

/** 解析 Rust 回传；字段缺失时保守处理（不把未确认的键位当作已生效） */
export function parseSyncResponse(raw: unknown): ShortcutSyncResult {
  if (!raw || typeof raw !== 'object') {
    return {
      synced: false,
      applied: {},
      failed: [],
      unavailableReason: '后端返回了无法识别的结果，快捷键注册状态未知',
    }
  }
  const record = raw as Record<string, unknown>
  const applied: Record<string, string> = {}
  const rawApplied = record['applied']
  if (Array.isArray(rawApplied)) {
    for (const item of rawApplied) {
      if (!item || typeof item !== 'object') continue
      const entry = item as Record<string, unknown>
      const id = typeof entry['id'] === 'string' ? entry['id'] : null
      const accelerator = typeof entry['accelerator'] === 'string' ? entry['accelerator'] : null
      if (id && accelerator) applied[id] = accelerator
    }
  } else if (rawApplied && typeof rawApplied === 'object') {
    // 兼容 Rust 直接回传 map 的形态
    for (const [id, accelerator] of Object.entries(rawApplied as Record<string, unknown>)) {
      if (typeof accelerator === 'string') applied[id] = accelerator
    }
  }

  const failed: ShortcutSyncFailure[] = []
  const rawFailed = record['failed']
  if (Array.isArray(rawFailed)) {
    for (const item of rawFailed) {
      if (!item || typeof item !== 'object') continue
      const entry = item as Record<string, unknown>
      failed.push({
        id: typeof entry['id'] === 'string' ? entry['id'] : 'unknown',
        accelerator: typeof entry['accelerator'] === 'string' ? entry['accelerator'] : '',
        reason: typeof entry['reason'] === 'string' ? entry['reason'] : '注册被系统拒绝（可能已被其它程序占用）',
      })
    }
  }
  return { synced: true, applied, failed, unavailableReason: null }
}

/* --------------------------- 事件订阅 --------------------------- */

/**
 * 订阅「快捷键被按下」事件（按 architect 定稿的**一动作一事件**形态，不引入 id 泛化事件）。
 *
 * | 动作 | Rust 触发时 emit |
 * | --- | --- |
 * | `newNote` | `zhijian://new-note-requested` |
 * | `openSettings` | `zhijian://open-settings-requested` |
 * | `toggleWindow` | `zhijian://toggle-window-requested`（**显隐已由 Rust 自己完成**，事件只供前端反馈） |
 * | `toggleTiles` | `zhijian://tiles-visibility-changed`（t19：显隐由 Rust 对全部磁贴完成，事件只供前端同步开关态） |
 * | `pinNote` | `zhijian://pin-current-note-requested`（t19：Rust **不知道当前笔记是哪个**，由前端回填 `selectedId`） |
 *
 * 为什么不用统一的 `shortcut-triggered{id}`：那会要求前端再维护一张 id→处理器映射表，
 * 而映射表与实际动作两处维护正是 bug 温床（architect 与我在这一点上达成一致）。
 */
export interface ShortcutTriggerHandlers {
  /** 新建笔记（应与 Alt+N 的既有行为一致：`notesStore.create()`） */
  newNote?: () => void | Promise<void>
  /** 打开设置面板（`uiStore.setView('settings')`） */
  openSettings?: () => void
  /** 窗口显隐已由 Rust 完成，这里只做前端反馈（可选） */
  toggleWindow?: () => void
  /** 显示/隐藏全部磁贴（t19 正式动作名） */
  toggleTiles?: () => void
  /** 钉住当前笔记为磁贴（前端需自行回填 `selectedId`，见 §4.14.7） */
  pinNote?: () => void | Promise<void>
}

/**
 * ⛔ **不要在本模块里 `listen()` 这些事件**（t31 修复 D1 回归的教训，务必保留此注释）
 *
 * 本文件曾导出一个 `openShortcutTriggers()`，对 `newNoteRequested` /
 * `openSettingsRequested` / `toggleWindowRequested` **各订阅一次**；而
 * `src/lib/hotkeys.ts` 的 `bindGlobalHotkeys()`（由 `App.tsx` 实际挂载）对
 * **同样两个事件也各订阅一次** ⇒ **同一事件两处监听** ⇒
 * **一次 Alt+N 建出两条笔记**（用户第一轮实测报告、t9 修过、t17 后静默回归）。
 *
 * 结论（t31 裁定）：
 *  - **`src/lib/hotkeys.ts` 的 `bindGlobalHotkeys()` 是同事件的唯一订阅方** ——
 *    它由 `App.tsx` 挂载、并把动作委托给 App 传入的 handler（`createNote()` /
 *    `openSettings()`），**只有它这一条通道**；
 *  - 本模块只负责**键位解析 / 校验 / 冲突检测 / 持久化 / 下发 Rust**，
 *    **不订阅事件**（事件路由统一在 hotkeys.ts）。
 *
 * 防复发断言（可执行）：
 *  - 本目录自检 `__checks__/run-checks.mjs` 的「单一订阅」一组：扫描全仓
 *    `listen(EVENTS.<name>)`，**同一事件名只允许出现 1 处**；
 *  - 并实测「派发一次事件 → 动作恰好执行一次」。
 */

/**
 * 事件名 → 动作 的**映射表**（仅供诊断/自检使用，**不用于订阅**）。
 *
 * 保留它的价值：让"哪个动作对应哪个事件"有单一出处，自检可比对它是否与
 * `src/lib/tauri.ts` 的 `EVENTS` 一致（防事件名漂移）。
 *
 * ⚠️ 类型是 `Partial<...>`（t44 起）：「不在表里」是一个**有意义的事实**，不是遗漏 ——
 * `quickNote` 的动作**完全在 Rust 侧完成**（创建/复用捕捉窗），前端没有任何必须参与的事，
 * 因此它既没有事件、也不需要 `dispatchShortcutEvent` 的分支。
 * 用 `Record`（全量）会逼着人塞一个永不 emit 的假事件进来 —— 那正是本项目定义过的
 * 「静默失效」类缺陷（登记了、却没人发/没人收）。
 */
export const SHORTCUT_EVENT_BY_ACTION: Partial<Record<ShortcutActionId, string>> = {
  newNote: EVENTS.newNoteRequested,
  toggleWindow: EVENTS.toggleWindowRequested,
  openSettings: EVENTS.openSettingsRequested,
  // t19/t20：磁贴已上线，改用专用事件（原先暂借 toggle-window-requested）
  toggleTiles: EVENTS.tilesVisibilityChanged,
  // Rust 只表达「用户按了键」，noteId 由前端回填（Rust 不知道当前选中项）
  pinNote: EVENTS.pinCurrentNoteRequested,
  // quickNote：**刻意没有条目** —— 见上方说明（动作全程在 Rust 侧完成）
}

/**
 * 纯分发逻辑（供自检直接驱动，无需 Tauri 运行时）。
 * 未知事件名返回 `false` 并走 `onUnknown`，不静默吞掉。
 */
export function dispatchShortcutEvent(
  eventName: string | undefined,
  handlers: ShortcutTriggerHandlers & { onUnknown?: (event: string) => void },
): boolean {
  switch (eventName) {
    case EVENTS.newNoteRequested:
      void Promise.resolve(handlers.newNote?.()).catch((error: unknown) => {
        console.warn('[纸笺] 快捷键「新建笔记」执行失败：', error)
      })
      return true
    case EVENTS.openSettingsRequested:
      handlers.openSettings?.()
      return true
    case EVENTS.toggleWindowRequested:
      handlers.toggleWindow?.()
      return true
    // t19/t20：磁贴两个动作各有专用事件（不再借 toggle-window-requested）
    case EVENTS.tilesVisibilityChanged:
      handlers.toggleTiles?.()
      return true
    case EVENTS.pinCurrentNoteRequested:
      void Promise.resolve(handlers.pinNote?.()).catch((error: unknown) => {
        console.warn('[纸笺] 快捷键「钉住当前笔记」执行失败：', error)
      })
      return true
    default:
      if (eventName) handlers.onUnknown?.(eventName)
      return false
  }
}
