/**
 * 应用级偏好（非业务数据）的持久化边界。
 * 归属：系统集成（t6 建立 / t13 接线 / t17 扩展，见 docs/ARCHITECTURE.md §4.6 / §4.13 / §5）。
 *
 * 契约（docs/ARCHITECTURE.md §4.6）：主题 id / 明暗模式 / 关闭到托盘偏好 / 窗口尺寸
 * 一律存 **localStorage**（key 前缀 `zhijian.`），**禁止落 SQLite**。
 * 主题自身已由 `themeStore` 用 `zj:theme` 承担，本文件承担设置面板其余偏好：
 *   - `zhijian.closeToTray`     关闭按钮是否隐藏到托盘（后台常驻）
 *   - `zhijian.tileSnap`        桌面磁贴是否吸附成组（t52）
 *   - `zhijian.startupViewMode` 启动时主界面的显示模式：编辑 / 分栏 / 预览（t54）
 *   - `zhijian.tileOpacity`     磁贴不透明度 0.3~1（t54）
 *   - `zhijian.tileEditable`    是否允许在磁贴里编辑内容（t54）
 *   - `zhijian.pinnedTilesHidable` 已固定的磁贴是否允许被「全部显隐」隐藏（t54）
 *   - `zhijian.defaultSort`     笔记列表默认排序
 *   - `zhijian.contentFontSize` 正文/预览字号档位（t17）
 *   - `zhijian.shortcuts`       自定义全局快捷键（t17，JSON）
 *   - `zhijian.lastIndexRebuildAt` 最近一次手动重建索引的时间（t17，诊断用）
 *   - `zhijian.windowBounds`    窗口尺寸（留待集成层写入，本文件只提供读写 API）
 *
 * 所有读写都做容错：隐私模式 / 存储被禁用 / 坏 JSON 一律回落默认值，绝不抛错导致白屏。
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { Note } from '@/types'

/** 列表默认排序：复用契约 §4.3 的 `NotesListFilter.sortBy` 取值域 */
export type NoteSortBy = 'order' | 'updatedAt' | 'createdAt' | 'title'

/** 正文字号档位（小/中/大/特大）；`medium` 是设计系统默认（text-editor = 15px） */
export type ContentFontSize = 'small' | 'medium' | 'large' | 'xlarge'

export interface WindowBounds {
  width: number
  height: number
  x?: number
  y?: number
}

export interface AppPreferences {
  /** 关闭按钮是否「隐藏到托盘」；false = 真正退出（托盘不可用时自动退化为 false） */
  closeToTray: boolean
  /**
   * 用户「希望」开机自动启动（t38）。
   *
   * ⚠️ **这不是事实来源**：是否真的开机自启以**系统状态**为准
   * （`autostart.isEnabled()` → 注册表 Run 项）。用户可能在系统设置里手动关掉，
   * 那时本偏好会与之不一致 —— UI 必须展示**系统状态**，本字段只用于：
   *  ① 记住用户意图（插件不可用时也能显示"上次想要的状态"）；
   *  ② 与系统状态对账后给出"期望 vs 实际"的提示。
   */
  autostart: boolean
  /** 笔记列表默认排序 */
  defaultSort: NoteSortBy
  /** 正文/预览字号档位 */
  contentFontSize: ContentFontSize
  /**
   * 桌面磁贴是否**吸附成组**（t52）。
   *
   * 权威源约定与 `closeToTray` 完全一致：**持久化 = 前端 localStorage**（本字段），
   * **行为 = Rust**（`tiles::tile_snap_enabled()`，启动时与开关变更时由前端下发）。
   * 关闭后：拖动磁贴不再自动贴合，也不会被同组磁贴带着走；
   * **已有的组号保留** —— 关一次开关不该毁掉用户已经摆好的布局。
   */
  tileSnap: boolean
  /**
   * 启动时主界面的显示模式（t54）。
   *
   * 只决定**打开软件时**的初始模式：用户在标题栏切换后按当下的选择走、**不写回**本偏好，
   * 这样「我特意设的启动模式」不会被一次临时切换改掉。
   */
  startupViewMode: StartupViewMode
  /** 磁贴不透明度（t54）：0.3~1，`1` = 完全不透明。只作用于磁贴窗口，主窗口不受影响。 */
  tileOpacity: number
  /** 是否允许在磁贴里编辑（t54）：`false` 时磁贴内的编辑器与标题只读（防误改）。 */
  tileEditable: boolean
  /**
   * 已固定的磁贴是否允许被「显示/隐藏全部磁贴」隐藏（t54）。
   *
   * 默认 `false` = 沿用 t46 的用户要求「固定的磁贴永远留在桌面上」；
   * 用户显式打开后，固定磁贴才参与全部显隐。
   */
  pinnedTilesHidable: boolean
}

/** 启动显示模式的取值域（t54，与 EditorPane 的 `EditorMode` 同构） */
export type StartupViewMode = 'edit' | 'preview' | 'split'

export const PREFERENCE_KEYS = {
  closeToTray: 'zhijian.closeToTray',
  tileSnap: 'zhijian.tileSnap',
  startupViewMode: 'zhijian.startupViewMode',
  tileOpacity: 'zhijian.tileOpacity',
  tileEditable: 'zhijian.tileEditable',
  pinnedTilesHidable: 'zhijian.pinnedTilesHidable',
  autostart: 'zhijian.autostart',
  defaultSort: 'zhijian.defaultSort',
  contentFontSize: 'zhijian.contentFontSize',
  shortcuts: 'zhijian.shortcuts',
  lastIndexRebuildAt: 'zhijian.lastIndexRebuildAt',
  windowBounds: 'zhijian.windowBounds',
} as const

export const APP_PREFERENCE_DEFAULTS: AppPreferences = {
  closeToTray: true,
  // 默认吸附：这是磁贴一直以来的行为，改成默认关闭会让老用户以为功能坏了
  tileSnap: true,
  // 默认分栏：与本次改动之前的观感一致（升级后界面不会突然变样）
  startupViewMode: 'split',
  // 默认完全不透明
  tileOpacity: 1,
  // 默认可编辑（磁贴本来就是用来随手改的）
  tileEditable: true,
  // 默认 false = 沿用 t46 的语义「固定的磁贴不参与全部显隐」
  pinnedTilesHidable: false,
  autostart: false,
  defaultSort: 'order',
  contentFontSize: 'medium',
}

const SORT_BY_VALUES: readonly NoteSortBy[] = ['order', 'updatedAt', 'createdAt', 'title']

/** 启动显示模式的展示选项（t54，设置面板用；与 `StartupViewMode` 取值域一一对应） */
export const STARTUP_VIEW_MODE_OPTIONS: readonly {
  value: StartupViewMode
  label: string
  hint: string
}[] = [
  { value: 'edit', label: '编辑', hint: '启动时只显示编辑器' },
  { value: 'split', label: '分栏', hint: '启动时编辑 + 预览并排（默认）' },
  { value: 'preview', label: '预览', hint: '启动时只显示渲染后的预览' },
]

/** 设置面板展示用的排序选项（中文标签与 repo 的 sortBy 取值一一对应） */
export const SORT_BY_OPTIONS: readonly { value: NoteSortBy; label: string }[] = [
  { value: 'order', label: '自定义（拖拽顺序）' },
  { value: 'updatedAt', label: '最近修改' },
  { value: 'createdAt', label: '创建时间' },
  { value: 'title', label: '标题' },
]

export function isNoteSortBy(value: unknown): value is NoteSortBy {
  return typeof value === 'string' && (SORT_BY_VALUES as readonly string[]).includes(value)
}

export const CONTENT_FONT_SIZE_VALUES: readonly ContentFontSize[] = [
  'small',
  'medium',
  'large',
  'xlarge',
]

export function isContentFontSize(value: unknown): value is ContentFontSize {
  return typeof value === 'string' && (CONTENT_FONT_SIZE_VALUES as readonly string[]).includes(value)
}

/* ------------------------------ 读写原语 ------------------------------ */

const canUseStorage = (): boolean =>
  typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'

function readRaw(key: string): string | null {
  if (!canUseStorage()) return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeRaw(key: string, value: string): void {
  if (!canUseStorage()) return
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* 存储不可用时静默降级：本次会话内偏好仍然生效（内存态） */
  }
}

function readBool(key: string, fallback: boolean): boolean {
  const raw = readRaw(key)
  if (raw === null) return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  return fallback
}

/** 启动显示模式：只读单个键（供 readPreferences 内部使用，避免递归） */
function readStartupViewModeRaw(): StartupViewMode {
  const raw = readRaw(PREFERENCE_KEYS.startupViewMode)
  return isStartupViewMode(raw) ? raw : APP_PREFERENCE_DEFAULTS.startupViewMode
}

/**
 * 磁贴不透明度：只读单个键并夹紧（同上，避免递归）。
 *
 * ⚠️ 这里踩过一个真实的坑，务必保留 `raw === null` 这一判空：
 * 键不存在时 `readRaw` 返回 `null`，而 **`Number(null) === 0` 是一个"有限数"**，
 * 于是会被 `clampTileOpacity` 夹到下限 0.3 —— 源码里明明写着默认 `1`（不透明），
 * 运行时却变成"默认 30% 透明"（升级后磁贴突然变淡）。
 * 静态门禁只看源码文本，抓不到它；是**真机 UI 验证**（滑块初始位置停在最左）才暴露的。
 */
function readTileOpacityRaw(): number {
  const raw = readRaw(PREFERENCE_KEYS.tileOpacity)
  if (raw === null || raw.trim() === '') return APP_PREFERENCE_DEFAULTS.tileOpacity
  const value = Number(raw)
  return Number.isFinite(value) ? clampTileOpacity(value) : APP_PREFERENCE_DEFAULTS.tileOpacity
}

/** 读取全部偏好（任一键非法都回落到默认值） */
export function readPreferences(): AppPreferences {
  const rawSort = readRaw(PREFERENCE_KEYS.defaultSort)
  const rawFont = readRaw(PREFERENCE_KEYS.contentFontSize)
  return {
    closeToTray: readBool(PREFERENCE_KEYS.closeToTray, APP_PREFERENCE_DEFAULTS.closeToTray),
    tileSnap: readBool(PREFERENCE_KEYS.tileSnap, APP_PREFERENCE_DEFAULTS.tileSnap),
    startupViewMode: readStartupViewModeRaw(),
    tileOpacity: readTileOpacityRaw(),
    tileEditable: readBool(PREFERENCE_KEYS.tileEditable, APP_PREFERENCE_DEFAULTS.tileEditable),
    pinnedTilesHidable: readBool(
      PREFERENCE_KEYS.pinnedTilesHidable,
      APP_PREFERENCE_DEFAULTS.pinnedTilesHidable,
    ),
    autostart: readBool(PREFERENCE_KEYS.autostart, APP_PREFERENCE_DEFAULTS.autostart),
    defaultSort: isNoteSortBy(rawSort) ? rawSort : APP_PREFERENCE_DEFAULTS.defaultSort,
    contentFontSize: isContentFontSize(rawFont) ? rawFont : APP_PREFERENCE_DEFAULTS.contentFontSize,
  }
}

export function readCloseToTray(): boolean {
  return readPreferences().closeToTray
}

/** 桌面磁贴是否吸附成组（t52；行为侧见 `features/settings/tileSnap.ts`） */
export function readTileSnap(): boolean {
  return readPreferences().tileSnap
}

/* ---------------------- t54：启动模式 / 磁贴外观与行为 ---------------------- */

/** 启动显示模式的取值域校验（t54） */
export function isStartupViewMode(value: unknown): value is StartupViewMode {
  return value === 'edit' || value === 'preview' || value === 'split'
}

/**
 * 磁贴透明度的安全区间（t54）。
 *
 * 下限 0.3 是刻意的：再低就几乎看不见，用户会以为"磁贴丢了"却找不到东西可点。
 */
export const TILE_OPACITY_MIN = 0.3
export const TILE_OPACITY_MAX = 1

export function clampTileOpacity(value: number): number {
  if (!Number.isFinite(value)) return TILE_OPACITY_MAX
  return Math.min(TILE_OPACITY_MAX, Math.max(TILE_OPACITY_MIN, value))
}

export function readStartupViewMode(): StartupViewMode {
  return readPreferences().startupViewMode
}

export function readTileOpacity(): number {
  return readPreferences().tileOpacity
}

export function readTileEditable(): boolean {
  return readPreferences().tileEditable
}

export function readPinnedTilesHidable(): boolean {
  return readPreferences().pinnedTilesHidable
}

/** 用户「希望」的开机自启（**非**系统事实来源，事实以 `isEnabled()` 为准） */
export function readAutostartPreference(): boolean {
  return readPreferences().autostart
}

export function readDefaultSort(): NoteSortBy {
  return readPreferences().defaultSort
}

export function readContentFontSize(): ContentFontSize {
  return readPreferences().contentFontSize
}

export function writeCloseToTray(value: boolean): void {
  writeRaw(PREFERENCE_KEYS.closeToTray, value ? 'true' : 'false')
}

export function writeTileSnap(value: boolean): void {
  writeRaw(PREFERENCE_KEYS.tileSnap, value ? 'true' : 'false')
}

export function writeStartupViewMode(value: StartupViewMode): void {
  writeRaw(PREFERENCE_KEYS.startupViewMode, isStartupViewMode(value) ? value : 'split')
}

export function writeTileOpacity(value: number): void {
  writeRaw(PREFERENCE_KEYS.tileOpacity, String(clampTileOpacity(value)))
}

export function writeTileEditable(value: boolean): void {
  writeRaw(PREFERENCE_KEYS.tileEditable, value ? 'true' : 'false')
}

export function writePinnedTilesHidable(value: boolean): void {
  writeRaw(PREFERENCE_KEYS.pinnedTilesHidable, value ? 'true' : 'false')
}

export function writeAutostartPreference(value: boolean): void {
  writeRaw(PREFERENCE_KEYS.autostart, value ? 'true' : 'false')
}

export function writeDefaultSort(value: NoteSortBy): void {
  writeRaw(PREFERENCE_KEYS.defaultSort, value)
}

export function writeContentFontSize(value: ContentFontSize): void {
  writeRaw(PREFERENCE_KEYS.contentFontSize, value)
}

/* ------------------- 索引诊断：最近一次手动重建时间 ------------------- */

/** 最近一次「手动重建索引」的毫秒时间戳；从未重建过返回 null */
export function readLastIndexRebuildAt(): number | null {
  const raw = readRaw(PREFERENCE_KEYS.lastIndexRebuildAt)
  if (!raw) return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

export function writeLastIndexRebuildAt(timestamp: number): void {
  writeRaw(PREFERENCE_KEYS.lastIndexRebuildAt, String(timestamp))
}

/* --------------------- 自定义快捷键（JSON，读写在 shortcuts 模块） --------------------- */

/** 原始 JSON 文本（非法值由调用方回落到默认，避免本文件依赖快捷键模块造成循环） */
export function readShortcutsRaw(): string | null {
  return readRaw(PREFERENCE_KEYS.shortcuts)
}

export function writeShortcutsRaw(value: string): void {
  writeRaw(PREFERENCE_KEYS.shortcuts, value)
}

/** 供设置面板/诊断查看当前 localStorage 里与偏好有关的全貌（只读，不产生第二份状态） */
export function readAllPreferences(): AppPreferences {
  return readPreferences()
}

export function readWindowBounds(): WindowBounds | null {
  const raw = readRaw(PREFERENCE_KEYS.windowBounds)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    const width = Number(record['width'])
    const height = Number(record['height'])
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
    const x = Number(record['x'])
    const y = Number(record['y'])
    return {
      width,
      height,
      ...(Number.isFinite(x) ? { x } : {}),
      ...(Number.isFinite(y) ? { y } : {}),
    }
  } catch {
    return null
  }
}

export function writeWindowBounds(bounds: WindowBounds): void {
  writeRaw(PREFERENCE_KEYS.windowBounds, JSON.stringify(bounds))
}

/* --------------------- 把偏好按 NotesListFilter 落地 --------------------- */

/**
 * 依据默认排序偏好返回 `NotesListFilter` 的排序字段。
 * `sortBy: 'order'` 是 repo 的默认值，保持方向 'asc'；时间类排序用 'desc' 更符合直觉。
 */
export function sortFilterFor(sortBy: NoteSortBy): {
  sortBy: NoteSortBy
  direction: 'asc' | 'desc'
} {
  return { sortBy, direction: sortBy === 'updatedAt' || sortBy === 'createdAt' ? 'desc' : 'asc' }
}

/** 在内存中对已取回的笔记做同样排序（列表组件无侵入使用） */
export function sortNotes(notes: readonly Note[], sortBy: NoteSortBy): Note[] {
  const list = [...notes]
  const compare = ((): ((a: Note, b: Note) => number) => {
    switch (sortBy) {
      case 'updatedAt':
        return (a, b) => b.updatedAt - a.updatedAt
      case 'createdAt':
        return (a, b) => b.createdAt - a.createdAt
      case 'title':
        return (a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN')
      case 'order':
      default:
        return (a, b) => a.order - b.order || a.createdAt - b.createdAt
    }
  })()
  // 置顶恒在最前（与 notesRepo 的列表约定一致）
  return list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || compare(a, b))
}

/**
 * 正文字号的 CSS 变量名 —— **必须定义在所有使用点之前**。
 *
 * ⚠️ 这里曾出现过一个白屏级缺陷（captain 复核发现）：本文件末尾的模块顶层副作用
 * `applyContentFontSize()` 会调用函数体里读取本变量的代码，而该 `const` 当时定义在
 * 副作用**之后** ⇒ 模块求值即抛 `ReferenceError: Cannot access 'CONTENT_FONT_VAR'
 * before initialization`（TDZ）⇒ **整个 ESM 图挂掉、页面纯白**，且 `typecheck` 与
 * `vite:build` 都是绿的（编译器看不到运行时的初始化顺序）。
 *
 * 因此：**新增任何在模块顶层执行的副作用时，务必确认它依赖的所有 `const` 都已在其上方定义。**
 */
export const CONTENT_FONT_VAR = '--zj-font-content'

/**
 * 字号档位 → px。`medium` 是设计系统默认值（`src/index.css` 的 `--zj-font-content: 15px`），
 * 因此默认档位**移除**行内覆盖、交还给设计系统，而不是复制一份 15px 到这里
 * （否则将来设计系统改基准值，这里会变成过期的第二真相源）。
 */
export const CONTENT_FONT_SIZE_PX: Record<ContentFontSize, number> = {
  small: 13,
  medium: 15,
  large: 17,
  xlarge: 19,
}

/**
 * 让字号档位立即生效。
 *
 * 原理（设计系统 t2 确认的机制，**已实测**）：`@theme inline` 会把主题值**内联**进工具类，
 * 因此 `:root` 上**不存在** `--text-editor`；`.text-editor` 现在解析为
 * `font-size: var(--zj-font-content, 15px)`（`src/index.css`）。
 * 所以往 `<html>` 写行内 `--zj-font-content` 会让所有 `text-editor` 元素
 * （CodeMirror 宿主 + 预览正文）立即跟随，**零组件改动、零重渲染**。
 *
 * ⚠️ 曾经写成 `--text-editor`（Tailwind 字号刻度键）——**那是无效的**：
 * inline 模式下刻度键不生成变量，覆盖它一点效果都没有（designer 用构建产物 + computed
 * font-size 实测拦下）。改回此处名字前请先看 `docs/DESIGN.md` 的排版 token 约定。
 *
 * 默认档位不写行内值（`removeProperty` 后落到 `:root` 的 15px），
 * 避免出现第二份基准值。
 */
export function applyContentFontSize(size: ContentFontSize = readContentFontSize()): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (size === 'medium') {
    root.style.removeProperty(CONTENT_FONT_VAR)
    return
  }
  const px = CONTENT_FONT_SIZE_PX[size] ?? CONTENT_FONT_SIZE_PX.medium
  root.style.setProperty(CONTENT_FONT_VAR, `${px}px`)
}

/** 当前实际生效的正文字号（px）：读行内变量，用于设置面板展示「实际生效」而不是用户填的值 */
export function effectiveContentFontSizePx(): number {
  if (typeof document === 'undefined') return CONTENT_FONT_SIZE_PX[readContentFontSize()]
  const inline = document.documentElement.style.getPropertyValue(CONTENT_FONT_VAR).trim()
  const parsed = inline ? Number.parseFloat(inline) : Number.NaN
  return Number.isFinite(parsed) ? parsed : CONTENT_FONT_SIZE_PX.medium
}

/* ------------------------------ React 订阅 ------------------------------ */

/**
 * 极简外部存储：偏好不属于业务数据，放 Zustand 反而增加耦合，
 * 这里用 `useSyncExternalStore` 让同页面多处读取保持一致。
 */
const listeners = new Set<() => void>()
let snapshot: AppPreferences = readPreferences()

function emit(): void {
  snapshot = readPreferences()
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

if (typeof window !== 'undefined') {
  // 多窗口 / 多标签同步；其它窗口改偏好时本窗口跟着更新
  window.addEventListener('storage', (event) => {
    if (event.key && event.key.startsWith('zhijian.')) emit()
  })
  // 模块加载即让已持久化的字号档位生效（避免二次闪现默认字号）
  applyContentFontSize()
}

/** 读取偏好并在写入后自动重渲染 */
export function useAppPreferences(): AppPreferences & {
  setCloseToTray: (value: boolean) => void
  toggleCloseToTray: () => void
  /** t52：只落库磁贴吸附偏好；**行为下发**见 `features/settings/tileSnap.ts` */
  setTileSnap: (value: boolean) => void
  /** t54：启动显示模式（只影响下次启动的初始模式） */
  setStartupViewMode: (value: StartupViewMode) => void
  /** t54：磁贴不透明度（0.3~1，自动夹紧） */
  setTileOpacity: (value: number) => void
  /** t54：是否允许编辑磁贴 */
  setTileEditable: (value: boolean) => void
  /** t54：固定磁贴是否可被隐藏（需下发 Rust，见 features/settings/tileBehavior.ts） */
  setPinnedTilesHidable: (value: boolean) => void
  setDefaultSort: (value: NoteSortBy) => void
  setContentFontSize: (value: ContentFontSize) => void
  /** 只落库「用户希望的开机自启」；**系统侧设置**请用 features/settings/autostart.ts */
  setAutostartPreference: (value: boolean) => void
} {
  const preferences = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  )

  const setCloseToTray = useCallback((value: boolean) => {
    writeCloseToTray(value)
    emit()
  }, [])

  const toggleCloseToTray = useCallback(() => {
    writeCloseToTray(!readCloseToTray())
    emit()
  }, [])

  const setTileSnap = useCallback((value: boolean) => {
    writeTileSnap(value)
    emit()
  }, [])

  const setStartupViewMode = useCallback((value: StartupViewMode) => {
    writeStartupViewMode(value)
    emit()
  }, [])

  const setTileOpacity = useCallback((value: number) => {
    writeTileOpacity(value)
    emit()
  }, [])

  const setTileEditable = useCallback((value: boolean) => {
    writeTileEditable(value)
    emit()
  }, [])

  const setPinnedTilesHidable = useCallback((value: boolean) => {
    writePinnedTilesHidable(value)
    emit()
  }, [])

  const setDefaultSort = useCallback((value: NoteSortBy) => {
    writeDefaultSort(value)
    emit()
  }, [])

  const setContentFontSize = useCallback((value: ContentFontSize) => {
    writeContentFontSize(value)
    // 立即生效：字号只改一个 CSS 变量，不等组件重渲染（见 ./contentFont.ts）
    applyContentFontSize(value)
    emit()
  }, [])

  const setAutostartPreference = useCallback((value: boolean) => {
    writeAutostartPreference(value)
    emit()
  }, [])

  return {
    ...preferences,
    setCloseToTray,
    toggleCloseToTray,
    setTileSnap,
    setStartupViewMode,
    setTileOpacity,
    setTileEditable,
    setPinnedTilesHidable,
    setDefaultSort,
    setContentFontSize,
    setAutostartPreference,
  }
}

/* ------------------------------ 正文字号 ------------------------------ */

/** 字号档位的中文标签与示例（设置面板展示用；px 与 CONTENT_FONT_SIZE_PX 同源） */
export const CONTENT_FONT_SIZE_OPTIONS: readonly {
  value: ContentFontSize
  label: string
  px: number
}[] = [
  { value: 'small', label: '小', px: CONTENT_FONT_SIZE_PX.small },
  { value: 'medium', label: '中（默认）', px: CONTENT_FONT_SIZE_PX.medium },
  { value: 'large', label: '大', px: CONTENT_FONT_SIZE_PX.large },
  { value: 'xlarge', label: '特大', px: CONTENT_FONT_SIZE_PX.xlarge },
]

