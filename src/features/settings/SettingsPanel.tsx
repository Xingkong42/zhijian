/**
 * SettingsPanel —— 设置面板（归属：系统集成 / 任务 t6，契约 props 见 docs/ARCHITECTURE.md §4.4）。
 *
 * 分区：
 *  1. 外观    —— 五套主题色卡（ThemePicker）+ 明暗模式（ModeToggle）
 *  2. 行为    —— 笔记列表默认排序、关闭窗口到托盘（后台常驻说明）
 *  3. 快捷键  —— Alt+N 全局新建的说明与注册冲突提示
 *  4. 数据    —— 数据库文件位置、导出 / 导入全部数据（plugin-dialog + plugin-fs）
 *  5. 关于    —— 版本与全套技术栈
 *
 * 两种使用方式，契约字段完全一致：
 *  - **自连（推荐）**：直接把本组件放在 `<App>` 任意位置，它会读取
 *    `uiStore.settingsOpen` 并自带 Dialog 外壳；
 *  - **受控**：把 `SettingsPanelProps` 全部传进来，并传 `standalone`，
 *    由调用方（例如 `Titlebar` 里包一层 `<Dialog>`）负责外壳。
 *
 * 红线：不写任何 16 进制色值（唯一例外是主题色卡预览，值来自 THEMES）；
 * 颜色/圆角/阴影只用语义 token 类；类名一律经 `cn()` 合并。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Check,
  CircleAlert,
  Download,
  FolderOpen,
  FolderOutput,
  Info,
  Keyboard,
  Loader,
  Palette,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  Upload,
  X,
} from 'lucide-react'
import type { SettingsPanelProps, ThemeDefinition, ThemeId, ThemeMode } from '@/types'
import { cn } from '@/lib/utils'
import { APP_META, getAppDataDir, isTauri } from '@/lib/tauri'
import { GLOBAL_SHORTCUTS, checkGlobalShortcut, type ShortcutRegistrationState } from '@/lib/hotkeys'
import {
  CONTENT_FONT_SIZE_OPTIONS,
  SORT_BY_OPTIONS,
  effectiveContentFontSizePx,
  readStartMinimized,
  useAppPreferences,
  type ContentFontSize,
  type NoteSortBy,
} from '@/lib/appPreferences'
import { useThemeStore } from '@/store/theme'
import { useUiStore } from '@/store/ui'
import {
  SHORTCUT_ACTIONS,
  findConflict,
  readShortcutBindings,
  shortcutDefinition,
  syncGlobalShortcuts,
  validateAccelerator,
  writeShortcutBindings,
  type ShortcutBinding,
  type ShortcutBindings,
  type ShortcutSyncResult,
} from './shortcuts'
import { ShortcutRecorder } from './ShortcutRecorder'
import {
  RELOCATE_CONFIRM_TITLE,
  VAULT_UNAVAILABLE_HINT,
  backupVaultInto,
  openVaultInFileManager,
  pickBackupDirectory,
  readIndexStatus,
  rebuildVaultIndex,
  relocateConfirmMessage,
  relocateSupport,
  relocateVaultFromDialog,
  tryReadVaultLocation,
  type IndexStatus,
  type VaultLocation,
} from './vaultData'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  IconButton,
  ScrollArea,
  Separator,
  Switch,
  Tooltip,
} from '@/components/ui'
import {
  FILESYSTEM_UNAVAILABLE_HINT,
  exportAllData,
  formatBytes,
  importAllData,
} from './dataTransfer'
import {
  isPreferenceDrifted,
  readRustPreference,
  syncCloseToTrayPreference,
} from './closeToTray'
import {
  AUTOSTART_UNAVAILABLE_HINT,
  applyAutostart,
  markStartMinimizedTouched,
  readSystemAutostart,
} from './autostart'
import { ModeToggle } from './ModeToggle'
import { ThemePicker } from './ThemePicker'

/** 数据库文件名（与 Rust 侧 DB_URL / tauri.conf.json 的 plugins.sql.preload 一致） */
const DB_FILE_NAME = 'zhijian.db'

/**
 * 面板内容滚动区高度上限。
 *
 * - **Dialog 模式**（自连）：`max-h-96` —— 保持极简，不撑满整屏；
 * - **设置栏模式**（`standalone`，t48 起）：**撑满栏高**（`h-full`）。
 *   用户报的「设置栏的高度和这个界面对齐」就是这里：栏模式下还套着 `max-h-96`，
 *   面板只有 384px 高、下方留一大块空，跟左边的界面明显不齐。
 *   两种模式的容器高度约束不同，所以上限必须由模式决定，不能写死一个。
 */
const SCROLL_MAX_HEIGHT_DIALOG = 'max-h-96'
const SCROLL_MAX_HEIGHT_COLUMN = 'h-full min-h-0'

/**
 * 「关闭窗口时隐藏到托盘」开关是否可交互。
 *
 * **t13 起为 `true`（真实生效）**：t12 已在 Rust 侧落地
 * `cmd_set_close_to_tray` / `cmd_close_to_tray_enabled`（见 §4.13），
 * 前端在「开关变更时」（本文件）与「应用启动时」（`CloseToTrayNotice`）各下发一次，
 * 因此该开关现在能真正改变关闭按钮的行为。
 *
 * 权威源约定：**持久化 = 前端 localStorage**（唯一落盘），
 * **行为 = Rust 侧**（进程内 AtomicBool，启动时被前端值覆盖）——不会出现双份真相。
 *
 * 保留该常量而不是删掉：将来若再次出现「接口未就绪」，置 `false`
 * 即回到已演练过的降级形态（禁用 + 说明条），无需再改其它行。
 */
const CLOSE_TO_TRAY_TOGGLE_ENABLED = true

/**
 * 「启动后最小化到托盘」开关是否可交互（t17）。
 *
 * `true`：按 architect 定稿的**零 Rust 改动**路径实现 —— 偏好在 localStorage（前端唯一可读），
 * 由前端在**初始化完成后**调 `getCurrentWindow().hide()`（`core:window:allow-hide` 已在 capabilities 中）。
 * 之所以不是「Rust 启动时就不显示」：`window::init()` 必然早于 WebView 加载，
 * 那个时间窗不存在；而且让 Rust 读偏好就得落一份 Rust 侧偏好文件，正是 §4.13 否决过的双真相源。
 *
 * 代价（已如实写进 UI 文案）：窗口会**短暂闪现**约 1 秒（WebView 启动耗时），随后收起。
 */
const START_MINIMIZED_SUPPORTED = true

const START_MINIMIZED_UNAVAILABLE_REASON = ''

/**
 * 「更换数据目录」是否可用。
 *
 * t17 时为 `false`（当时存储层没有换根入口，所以只提示不支持，不做假按钮）。
 * **t41 起为 `true`**：t37 的数据层已提供 `relocateVault()` —— 先复制、逐项校验
 * （文件数 + 抽样 sha256）、成功后才切换、失败保持原目录不变、旧目录保留。
 * 入口带二次确认（操作前告知旧目录位置）与进行中状态（防重复点击）。
 */
const RELOCATE_SUPPORTED = true

const TECHNOLOGIES: readonly string[] = [
  'Tauri 2',
  'React 19',
  'TypeScript 5.9',
  'Vite 7',
  'Tailwind CSS 4',
  'shadcn/ui 风格组件',
  'Zustand 5',
  'CodeMirror 6',
  'react-markdown + remark-gfm',
  'Shiki 3',
  'SQLite（tauri-plugin-sql）',
  'Lucide React',
]

/**
 * 契约 props 的**兼容扩展**：
 *  - 把 `SettingsPanelProps` 的必需字段放宽为可选（`Partial`），让组件在
 *    「不传任何 props」时也能自连到 `themeStore` / `appPreferences`；
 *    **字段名与含义与契约完全一致**，集成层照旧可以逐个传全部字段；
 *  - `open` 可选：不传时读 `uiStore.settingsOpen`；
 *  - `standalone`：调用方自己提供 Dialog 外壳时置 true，组件只渲染面板本体。
 */
export interface SettingsPanelExtendedProps extends Partial<SettingsPanelProps> {
  standalone?: boolean
  className?: string
  /** 默认排序变化时的额外回调（外层持久化 / 重排列表用） */
  onDefaultSortChange?: (sortBy: NoteSortBy) => void
  /** 「启动时最小化」变化时的额外回调（外层若实现该能力可据此下发） */
  onToggleStartMinimized?: (value: boolean) => void
  /** 导入完成后的额外回调（外层刷新列表用） */
  onDataImported?: () => void
  /**
   * t22 修复 F2：**索引重建成功后的额外回调**（外层刷新元数据 / 列表用）。
   *
   * 为什么必须有：重建索引会按磁盘 md 增删索引行，但侧栏计数徽标来自外层的元数据，
   * 不重载就一直是旧数字（QA 实测：设置面板显示「笔记 7」而侧栏仍显示 10，
   * 切视图后列表自愈为 7 条、**徽标仍是 10**）。
   */
  onIndexRebuilt?: () => void
  /** 轻量提示通道（集成层通常传 `useToast().toast`） */
  onNotify?: PanelNotify
  /**
   * Rust 侧当前的行为值（可选，诊断用）。
   *
   * 不传时组件会在打开时自行 `invoke('cmd_close_to_tray_enabled')` 读一次，
   * 与 localStorage 值对账；不一致时显示一行提示（§4.13 的漂移告警）。
   * 传 `null` 表示「已知无法对账」（例如浏览器预览），此时不显示告警。
   */
  rustCloseToTray?: boolean | null
  /**
   * 「启动时最小化到托盘」开关是否可交互（t17）。
   *
   * 由集成层依据 Rust 是否提供该能力决定：`false` 时开关**禁用并说明**，
   * 绝不留「改了没反应」的假开关（与 t6 的 `CLOSE_TO_TRAY_TOGGLE_ENABLED` 同一套路）。
   */
  startMinimizedSupported?: boolean
  /**
   * 「更换数据目录」是否被支持（t17）。t15 的 vault 根是常量且无换根入口，
   * 因此默认 `false`：按钮禁用 + 给出建议，而不是做一个点了没反应的入口。
   */
  relocateSupported?: boolean
}

/* ------------------------------ 小工具 ------------------------------ */

/**
 * 标题槽：在 Dialog 外壳里用 `DialogTitle` / `DialogDescription`（自动带
 * aria-labelledby / aria-describedby）；在 standalone 面板里退化为普通
 * `<h2>` / `<p>`（不能调用 Dialog 的子组件 —— 它们要求 Dialog 上下文）。
 */
const TitleSlotContext = createContext(false)

function PanelTitle({ children }: { children: ReactNode }) {
  const inDialog = useContext(TitleSlotContext)
  if (inDialog) return <DialogTitle className="text-title font-medium text-text">{children}</DialogTitle>
  return <h2 className="text-title font-medium text-text">{children}</h2>
}

function PanelDescription({ children }: { children: ReactNode }) {
  const inDialog = useContext(TitleSlotContext)
  if (inDialog) return <DialogDescription className="text-ui text-muted">{children}</DialogDescription>
  return <p className="text-ui text-muted">{children}</p>
}

/**
 * 页脚槽：`DialogFooter` / `DialogClose` 都要求 Dialog 上下文，
 * standalone 面板里退化为普通容器 + 描边按钮（外观一致）。
 */
function PanelFooter() {
  const inDialog = useContext(TitleSlotContext)
  if (inDialog) {
    return (
      <DialogFooter>
        <DialogClose />
      </DialogFooter>
    )
  }
  // t48：设置栏（standalone）里不再需要这行说明；关闭入口在面板右上角已有
  return null
}

function SectionTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <h3 className="flex items-center gap-2 text-meta font-medium text-muted">
      <span aria-hidden className="text-muted">
        {icon}
      </span>
      {children}
    </h3>
  )
}

function InfoRow({
  label,
  children,
  mono = false,
}: {
  label: string
  children: ReactNode
  mono?: boolean
}) {
  return (
    <div className="rounded-zj border border-border bg-surface-2 px-3 py-2">
      <p className="text-meta text-muted">{label}</p>
      <p className={cn('break-all text-ui text-text', mono && 'zj-selectable font-mono text-2xs')}>
        {children}
      </p>
    </div>
  )
}

/** 原生 select（设置面板只有这一处下拉，不值得引入弹层组件） */
function SortSelect({
  value,
  onChange,
}: {
  value: NoteSortBy
  onChange: (value: NoteSortBy) => void
}) {
  return (
    <select
      aria-label="笔记列表默认排序"
      value={value}
      onChange={(event) => onChange(event.target.value as NoteSortBy)}
      className={cn(
        'h-8 w-full rounded-zj-sm border border-border bg-surface px-2 text-ui text-text',
        'transition-colors duration-150 ease-out zj-focus-ring',
        'hover:border-accent/50',
      )}
    >
      {SORT_BY_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

/** 面板对外通知（由集成层接 `useToast()` 或任意提示组件） */
export interface PanelNotice {
  title: string
  description?: string
  variant?: 'info' | 'success' | 'warning' | 'error'
}

export type PanelNotify = (notice: PanelNotice) => void

/* ------------------------------ 面板本体 ------------------------------ */

export function SettingsPanel(props: SettingsPanelExtendedProps = {}) {
  const {
    open: openProp,
    standalone = false,
    className,
    onDataImported,
    onIndexRebuilt,
    onDefaultSortChange,
    onToggleStartMinimized,
    onToggleCloseToTray,
    onSetTheme,
    onSetMode,
    onToggleMode,
    onClose,
    closeToTray: closeToTrayProp,
    shortcut: shortcutProp,
    dbPath: dbPathProp,
    themeId: themeIdProp,
    mode: modeProp,
    themeList: themeListProp,
  } = props

  /* ---------------------- store 回落（自连用法） ---------------------- */
  const storeThemeId = useThemeStore((state) => state.themeId)
  const storeMode = useThemeStore((state) => state.mode)
  const storeThemeList = useThemeStore((state) => state.themeList)
  const storeSetTheme = useThemeStore((state) => state.setTheme)
  const storeSetMode = useThemeStore((state) => state.setMode)
  const storeToggleMode = useThemeStore((state) => state.toggleMode)
  const settingsOpen = useUiStore((state) => state.settingsOpen)
  const storeCloseSettings = useUiStore((state) => state.closeSettings)

  const preferences = useAppPreferences()

  const themeId: ThemeId = themeIdProp ?? storeThemeId
  const mode: ThemeMode = modeProp ?? storeMode
  const themeList: readonly ThemeDefinition[] = themeListProp ?? storeThemeList
  const closeToTray = closeToTrayProp ?? preferences.closeToTray
  const newNoteShortcut = shortcutProp ?? GLOBAL_SHORTCUTS.newNote
  const open = standalone ? true : (openProp ?? settingsOpen)
  /** t17：能力开关可被集成层覆盖（后端就绪后无需改组件，只传 prop） */
  const startMinimizedSupported = props.startMinimizedSupported ?? START_MINIMIZED_SUPPORTED
  const relocateEnabled = props.relocateSupported ?? RELOCATE_SUPPORTED
  const relocateHint = relocateSupport()
  const handleSetTheme = useCallback(
    (id: ThemeId) => (onSetTheme ? onSetTheme(id) : storeSetTheme(id)),
    [onSetTheme, storeSetTheme],
  )
  const handleSetMode = useCallback(
    (next: ThemeMode) => (onSetMode ? onSetMode(next) : storeSetMode(next)),
    [onSetMode, storeSetMode],
  )
  const handleToggleMode = useCallback(
    () => (onToggleMode ? onToggleMode() : storeToggleMode()),
    [onToggleMode, storeToggleMode],
  )
  const handleClose = useCallback(() => {
    onClose?.()
    if (!onClose) storeCloseSettings()
  }, [onClose, storeCloseSettings])

  const notify = props.onNotify

  /* ---------------------------- 运行时信息 ---------------------------- */
  const [dbPath, setDbPath] = useState<string>(dbPathProp ?? '')
  const [dbPathError, setDbPathError] = useState<string | null>(null)
  const [shortcutState, setShortcutState] = useState<ShortcutRegistrationState | 'checking'>(
    'checking',
  )
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [confirmImport, setConfirmImport] = useState(false)
  /** t41：换目录的二次确认（操作前先告知「旧数据会保留在哪」） */
  const [confirmRelocate, setConfirmRelocate] = useState(false)
  const [summary, setSummary] = useState<string | null>(null)
  /** Rust 侧当前行为值（null = 无法对账，例如浏览器预览） */
  const [rustValue, setRustValue] = useState<boolean | null>(
    props.rustCloseToTray === undefined ? null : props.rustCloseToTray,
  )

  /* ------------------- t17：快捷键 / 数据位置 / 索引 ------------------- */
  /** 自定义快捷键绑定（持久化在 localStorage，改键位时下发 Rust） */
  const [bindings, setBindings] = useState<ShortcutBindings>(() => readShortcutBindings())
  /** 最近一次同步结果：`applied` 是「实际生效」，`failed` 是冲突/拒绝 */
  const [shortcutSync, setShortcutSync] = useState<ShortcutSyncResult | null>(null)
  /** 数据位置（null = 读不到，展示提示） */
  const [vault, setVault] = useState<VaultLocation | null>(null)
  const [vaultError, setVaultError] = useState<string | null>(null)
  /** 索引状态 */
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null)
  const [indexBusy, setIndexBusy] = useState(false)
  const [dataBusy, setDataBusy] = useState<'backup' | 'relocate' | null>(null)
  const [lastRebuildNote, setLastRebuildNote] = useState<string | null>(null)

  // 数据文件位置：优先 props.dbPath，其次 appDataDir()/zhijian.db
  useEffect(() => {
    if (dbPathProp) {
      setDbPath(dbPathProp)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const dir = await getAppDataDir()
        if (cancelled) return
        if (!dir) {
          setDbPath('浏览器预览模式：SQLite 数据库不可用（桌面端为应用数据目录/zhijian.db）')
          return
        }
        const separator = dir.endsWith('/') || dir.endsWith('\\') ? '' : '\\'
        setDbPath(`${dir}${separator}${DB_FILE_NAME}`)
      } catch (error) {
        if (cancelled) return
        setDbPathError(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dbPathProp])

  // 全局快捷键注册状态（冲突提示的数据源）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const state = await checkGlobalShortcut(newNoteShortcut)
      if (!cancelled) setShortcutState(state)
    })()
    return () => {
      cancelled = true
    }
  }, [newNoteShortcut])

  // 「关闭到托盘」对账（§4.13）：读 Rust 行为值，与 localStorage 值比对。
  // props 显式给了就只跟随 props（受控用法 / 测试）。
  // 依赖里的 `closeToTray` 很关键：开关变化后重新对账，否则漂移提示会滞后半拍。
  useEffect(() => {
    if (props.rustCloseToTray !== undefined) {
      setRustValue(props.rustCloseToTray)
      return
    }
    let cancelled = false
    void (async () => {
      const value = await readRustPreference()
      if (!cancelled) setRustValue(value)
    })()
    return () => {
      cancelled = true
    }
  }, [props.rustCloseToTray, closeToTray])

  // 「启动后最小化」：本组件常驻在应用根节点，因此它的**首次挂载**就是
  // 「应用初始化基本完成」的时机（面板本身在 Provider 树内、不参与条件渲染）。
  // 只跑一次，且用户在设置页时绝不隐藏（否则会把自己藏起来，用户以为崩了）。
  const startMinimizedHandled = useRef(false)
  useEffect(() => {
    if (startMinimizedHandled.current) return
    startMinimizedHandled.current = true
    if (!isTauri || !startMinimizedSupported) return
    if (!readStartMinimized()) return
    if (useUiStore.getState().settingsOpen) return
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        await getCurrentWindow().hide()
      } catch (error) {
        console.warn('[纸笺] 启动后最小化失败（窗口保持显示）：', error)
      }
    })()
  }, [startMinimizedSupported])

  /** 开关变更时把偏好下发 + 立即执行一次（开启后立刻收起窗口，不必等下次启动） */
  const handleStartMinimizedChange = useCallback(
    (value: boolean) => {
      preferences.setStartMinimized(value)
      // t38：用户**亲自**设过 ⇒ 记标记，此后「开机自启」的组合行为不再自动改写它
      markStartMinimizedTouched()
      onToggleStartMinimized?.(value)
      if (!value || !isTauri) return
      void (async () => {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window')
          await getCurrentWindow().hide()
        } catch (error) {
          notify?.({
            title: '最小化到托盘失败',
            description: error instanceof Error ? error.message : String(error),
            variant: 'warning',
          })
        }
      })()
    },
    [preferences, onToggleStartMinimized, notify],
  )

  /** 是否出现「后端行为值 ≠ 本机偏好」的漂移（仅诊断展示，不自动改写后端） */
  const closeToTrayDrifted =
    CLOSE_TO_TRAY_TOGGLE_ENABLED && isPreferenceDrifted(rustValue, closeToTray)

  /* ------------------- t17：快捷键同步 / 数据位置 / 索引 ------------------- */

  // 打开面板即把已持久化的快捷键下发给 Rust 一次（启动同步由 HotkeysBridge 负责），
  // 并把「实际生效」结果拿回来展示 —— 设置页展示的是 effective 而非用户输入值。
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      const result = await syncGlobalShortcuts(bindings)
      if (!cancelled) setShortcutSync(result)
    })()
    return () => {
      cancelled = true
    }
    // 刻意只在「打开」时跑一次：改键位时由 handleShortcutChange 主动同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 数据位置 + 索引状态（打开时读一次；重建/备份后主动刷新）
  const refreshDataInfo = useCallback(async () => {
    if (!isTauri) {
      setVaultError(VAULT_UNAVAILABLE_HINT)
      setIndexStatus(null)
      return
    }
    const location = await tryReadVaultLocation()
    if (!location) {
      setVaultError('读取数据目录失败：数据库可能尚未初始化完成，请稍后重试')
      setIndexStatus(null)
      return
    }
    setVault(location)
    setVaultError(null)
    try {
      setIndexStatus(await readIndexStatus())
    } catch (error) {
      setIndexStatus(null)
      setVaultError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void refreshDataInfo()
  }, [open, refreshDataInfo])

  /**
   * 改键位：**先校验 + 冲突检测，通过后才落盘并立即重新注册**。
   *
   * - 非法键位 / 应用内重复 → 直接拒绝并提示，**不写 localStorage、不下发**（否则会留下重复绑定）；
   * - 后端拒绝（被其它程序占用）→ 回滚到改动前的绑定并提示原因；
   * - 后端接受 → 以 `applied` 作为「实际生效」展示。
   */
  const handleShortcutChange = useCallback(
    async (id: ShortcutBinding['id'], accelerator: string | null) => {
      const definition = shortcutDefinition(id)
      const previous = bindings
      const validation = validateAccelerator(accelerator, definition)
      if (!validation.ok) {
        notify?.({ title: '快捷键未生效', description: validation.reason, variant: 'warning' })
        return
      }
      const conflict = findConflict(bindings, id, accelerator)
      if (conflict) {
        notify?.({
          title: '快捷键未生效',
          description: `该组合已被「${conflict.withLabel}」占用，请换一个。`,
          variant: 'warning',
        })
        return
      }

      const next: ShortcutBindings = {
        ...bindings,
        [id]: { id, accelerator: validation.formatted ?? null, enabled: accelerator !== null },
      }
      setBindings(next)
      writeShortcutBindings(next)
      const result = await syncGlobalShortcuts(next)
      setShortcutSync(result)
      const failure = result.failed.find((item) => item.id === id)
      if (failure) {
        setBindings(previous)
        writeShortcutBindings(previous)
        notify?.({
          title: '快捷键未生效',
          description: `${failure.accelerator}：${failure.reason}（已保留原来的键位）`,
          variant: 'warning',
        })
        return
      }
      if (accelerator) {
        notify?.({
          title: `「${definition.label}」已改为 ${validation.formatted}`,
          description: '新的键位已立即生效，无需重启。',
          variant: 'success',
        })
      }
    },
    [bindings, notify],
  )

  /** 手动重建索引 */
  const handleRebuildIndex = useCallback(async () => {
    setIndexBusy(true)
    setLastRebuildNote(null)
    // 记下**重建前**的索引笔记数：重建是 DROP + CREATE + 从 md 全量重投影，
    // 所以 `result.added/updated/removed` 是"相对空索引"的文件级口径，
    // 直接展示成「移除 0」会与索引行数实际减少矛盾（t21 报的 F3）。
    const notesBefore = indexStatus?.noteCount
    try {
      const outcome = await rebuildVaultIndex()
      setIndexStatus(outcome.status)
      const notesAfter = outcome.status.noteCount
      const delta =
        notesBefore === undefined
          ? ''
          : `，索引笔记 ${notesBefore} → ${notesAfter}`
      const message = `索引已重建：按磁盘文件全量重建 ${outcome.result.total} 个${delta}`
      setLastRebuildNote(message)
      notify?.({ title: '索引已重建', description: message, variant: 'success' })
      // F2：重建会改变索引内容 ⇒ 让外层重载元数据（侧栏徽标）与列表
      onIndexRebuilt?.()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLastRebuildNote(`重建失败：${message}`)
      notify?.({ title: '重建索引失败', description: message, variant: 'error' })
    } finally {
      setIndexBusy(false)
    }
  }, [notify, indexStatus, onIndexRebuilt])

  /** 在文件管理器中打开数据目录 */
  const handleRevealVault = useCallback(async () => {
    if (!vault) return
    try {
      const opened = await openVaultInFileManager(vault.vaultRoot)
      if (!opened) setLastRebuildNote(VAULT_UNAVAILABLE_HINT)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      notify?.({ title: '打开数据目录失败', description: message, variant: 'error' })
    }
  }, [vault, notify])

  /**
   * t41：更换数据目录 —— **二次确认（含旧目录位置）→ 复制 → 校验 → 切换**。
   * 数据层保证「任何一步失败都保持原目录不变」；成功后旧目录原地保留，
   * 这里再 `refreshDataInfo()` 让面板上的「数据目录」立即显示新位置。
   */
  const handleRelocateVault = useCallback(async () => {
    if (dataBusy !== null) return
    setConfirmRelocate(false)
    setDataBusy('relocate')
    setLastRebuildNote(null)
    try {
      const outcome = await relocateVaultFromDialog({ currentRoot: vault?.vaultRoot })
      if (outcome.status === 'cancelled') {
        setLastRebuildNote('已取消更换数据目录。')
        return
      }
      const detail = outcome.status === 'relocated' ? '' : `（原目录未改动，数据仍在 ${outcome.oldDataKeptAt}）`
      const message = `${outcome.summary}${detail}`
      setLastRebuildNote(message)
      notify?.({
        title: outcome.status === 'relocated' ? '数据目录已更换' : '更换数据目录失败',
        description: message,
        variant: outcome.status === 'relocated' ? 'success' : 'error',
      })
      if (outcome.status === 'relocated') {
        // 立即反映新目录（数据目录行 + 索引状态），并让外层刷新列表/徽标
        await refreshDataInfo()
        onIndexRebuilt?.()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLastRebuildNote(`更换数据目录失败：${message}`)
      notify?.({ title: '更换数据目录失败', description: message, variant: 'error' })
    } finally {
      setDataBusy(null)
    }
  }, [dataBusy, vault, notify, refreshDataInfo, onIndexRebuilt])

  /** 备份数据目录（选父目录 → 自动在其中新建备份文件夹） */
  const handleBackupVault = useCallback(async () => {
    if (!vault) return
    setDataBusy('backup')
    setLastRebuildNote(null)
    try {
      const parent = await pickBackupDirectory(vault.appDataDir)
      if (!parent) {
        setLastRebuildNote('已取消备份。')
        return
      }
      const outcome = await backupVaultInto(vault.vaultRoot, parent)
      const partial = outcome.failures.length > 0
      const detail = partial
        ? `（${outcome.failures.length} 项失败，例如 ${outcome.failures[0].path}：${outcome.failures[0].reason}）`
        : ''
      const message = `${partial ? '部分完成' : '备份完成'}：${outcome.copiedFiles} 个文件 / ${outcome.copiedDirs} 个文件夹 → ${outcome.targetDir}${detail}`
      setLastRebuildNote(message)
      notify?.({
        title: partial ? '备份部分完成' : '备份完成',
        description: message,
        variant: partial ? 'warning' : 'success',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLastRebuildNote(`备份失败：${message}`)
      notify?.({ title: '备份失败', description: message, variant: 'error' })
    } finally {
      setDataBusy(null)
    }
  }, [vault, notify])

  /* ---------------------------- t38：开机自启 ---------------------------- */
  /**
   * **系统实际状态**（`null` = 读不到 → 显示可读原因，**绝不当作「未启用」**）。
   * UI 展示的是它，而不是 localStorage 里的偏好 —— 用户可能在系统设置里手动关掉自启。
   */
  const [autostartSystem, setAutostartSystem] = useState<boolean | null>(null)
  const [autostartUnavailable, setAutostartUnavailable] = useState<string | null>(null)
  const [autostartBusy, setAutostartBusy] = useState(false)

  // 打开面板时读一次系统状态（并在每次切换后回读，见 handleAutostartChange）
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      const state = await readSystemAutostart()
      if (cancelled) return
      if (state.kind === 'known') {
        setAutostartSystem(state.enabled)
        setAutostartUnavailable(null)
      } else {
        setAutostartSystem(null)
        setAutostartUnavailable(state.reason)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  /** 切换开机自启：落库意图 → 调系统 API → **回读校验** → 组合行为 */
  const handleAutostartChange = useCallback(
    async (enabled: boolean) => {
      setAutostartBusy(true)
      try {
        const result = await applyAutostart(enabled)
        // 以回读值为准展示（不在失败时假装成功）
        setAutostartSystem(result.after)
        if (!result.ok) {
          setAutostartUnavailable(result.message)
          notify?.({
            title: '开机自启未生效',
            description: result.message ?? '未知原因',
            variant: 'warning',
          })
          return
        }
        setAutostartUnavailable(null)
        notify?.({
          title: enabled ? '已开启开机自启' : '已关闭开机自启',
          description: result.autoEnabledStartMinimized
            ? '已同时设为「开机启动时最小化到托盘」，避免开机时弹出窗口打扰。'
            : '已回读系统状态确认生效。',
          variant: 'success',
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setAutostartUnavailable(message)
        notify?.({ title: '开机自启操作失败', description: message, variant: 'error' })
      } finally {
        setAutostartBusy(false)
      }
    },
    [notify],
  )

  /** 是否出现「本机意图 ≠ 系统实际状态」的漂移（仅诊断展示） */
  const autostartDriftedValue =
    autostartSystem !== null && autostartSystem !== preferences.autostart

  /** 快捷键「实际生效」查询：某 key 是否出现在 applied 里，以及失败原因 */
  const shortcutEffectFor = useCallback(
    (id: ShortcutBinding['id']): { applied: boolean; reason: string | null } => {
      if (!shortcutSync) return { applied: false, reason: null }
      const failed = shortcutSync.failed.find((item) => item.id === id)
      if (failed) return { applied: false, reason: failed.reason }
      return { applied: Boolean(shortcutSync.applied[id]), reason: null }
    },
    [shortcutSync],
  )

  const currentFontPx = effectiveContentFontSizePx()

  /* ---------------------------- 数据操作 ---------------------------- */
  const handleExport = useCallback(async () => {
    setBusy('export')
    setSummary(null)
    try {
      const result = await exportAllData()
      if (!result.path) {
        // 用户在保存对话框里取消：不算失败
        setSummary('已取消导出（未选择保存位置）。')
        return
      }
      const message = `已导出 ${result.notes} 条笔记 / ${result.folders} 个文件夹 / ${result.tags} 个标签（${formatBytes(result.bytes)}）→ ${result.fileName}`
      setSummary(message)
      notify?.({ title: '导出成功', description: result.fileName, variant: 'success' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSummary(`导出失败：${message}`)
      notify?.({ title: '导出失败', description: message, variant: 'error' })
    } finally {
      setBusy(null)
    }
  }, [notify])

  const handleImport = useCallback(async () => {
    setConfirmImport(false)
    setBusy('import')
    setSummary(null)
    try {
      const result = await importAllData()
      if (!result) {
        setSummary('已取消导入（未选择备份文件）。')
        return
      }
      const message = `导入完成：新增 ${result.notes} 条笔记 / ${result.folders} 个文件夹 / ${result.tags} 个新标签（原有数据未被修改或删除）`
      setSummary(message)
      notify?.({ title: '导入完成', description: message, variant: 'success' })
      onDataImported?.()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSummary(`导入失败：${message}`)
      notify?.({ title: '导入失败', description: message, variant: 'error' })
    } finally {
      setBusy(null)
    }
  }, [notify, onDataImported])

  /* ---------------------------- 快捷键文案 ---------------------------- */
  const shortcutHint = useMemo(() => {
    switch (shortcutState) {
      case 'registered':
        return { tone: 'ok' as const, text: '已注册：窗口未聚焦时也能新建笔记。' }
      case 'conflict':
        return {
          tone: 'warning' as const,
          text: '注册未生效（可能被其它程序占用）：请关闭占用该组合的程序，或使用窗口聚焦时的备用按键。',
        }
      case 'unsupported':
      default:
        return {
          tone: 'info' as const,
          text: '浏览器预览模式没有系统级快捷键；窗口聚焦时 Alt+N 仍然可用（桌面端为全局生效）。',
        }
    }
  }, [shortcutState])

  /** 字体档位选项当前是否选中（用于 data-active 高亮，避免运行时拼类名） */
  const isFontSizeActive = (value: ContentFontSize) => preferences.contentFontSize === value

  /* ------------------------------ 渲染 ------------------------------ */
  const body = (
    <>
      <div className="flex items-start gap-2 pr-6">
        <span aria-hidden className="mt-0.5 text-muted">
          <Settings size={15} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <PanelTitle>设置</PanelTitle>
          <PanelDescription>外观、行为、快捷键与数据都在这里；所有偏好只保存在本机。</PanelDescription>
        </div>
      </div>

      <Separator />

      <ScrollArea className={cn(standalone ? SCROLL_MAX_HEIGHT_COLUMN : SCROLL_MAX_HEIGHT_DIALOG, '-mr-1 pr-1')}>
        <div className="flex flex-col gap-6 pb-1">
          {/* ---------------- 外观 ---------------- */}
          <section className="flex flex-col gap-3">
            <SectionTitle icon={<Palette size={15} strokeWidth={1.75} />}>外观</SectionTitle>
            <ThemePicker
              themeList={themeList}
              themeId={themeId}
              mode={mode}
              onSelect={handleSetTheme}
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-ui text-muted">明暗模式</span>
              <ModeToggle mode={mode} onSetMode={handleSetMode} onToggle={handleToggleMode} />
            </div>

            {/* t17：正文字号档位 —— 只改一个 CSS 变量（--zj-font-content），编辑器与预览同时生效 */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ui text-muted">正文字号</span>
                <span className="font-mono text-2xs text-muted" data-zj="font-size-effective">
                  实际 {currentFontPx}px
                </span>
              </div>
              <div
                role="group"
                aria-label="正文字号"
                className="flex w-fit items-center gap-1 rounded-zj bg-surface-2 p-1"
              >
                {CONTENT_FONT_SIZE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={isFontSizeActive(option.value)}
                    data-active={isFontSizeActive(option.value)}
                    title={`${option.label}：${option.px}px`}
                    onClick={() => preferences.setContentFontSize(option.value)}
                    className={cn(
                      'inline-flex h-7 select-none items-center gap-1 rounded-zj-sm px-3 text-ui font-medium',
                      'transition-colors duration-150 ease-out zj-focus-ring',
                      'data-[active=true]:bg-selection data-[active=true]:text-text',
                      'text-muted hover:bg-hover hover:text-text',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

          </section>

          <Separator />

          {/* ---------------- 行为 ---------------- */}
          <section className="flex flex-col gap-3">
            <SectionTitle icon={<SlidersHorizontal size={15} strokeWidth={1.75} />}>
              行为
            </SectionTitle>
            <div className="flex flex-col gap-2">
              <span className="text-ui text-muted">笔记列表默认排序</span>
              <SortSelect
                value={preferences.defaultSort}
                onChange={(value) => {
                  preferences.setDefaultSort(value)
                  onDefaultSortChange?.(value)
                }}
              />
            </div>

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-ui text-text">关闭窗口时隐藏到系统托盘</p>
              </div>
              <Switch
                checked={closeToTray}
                disabled={!CLOSE_TO_TRAY_TOGGLE_ENABLED}
                label="关闭窗口时隐藏到系统托盘"
                onCheckedChange={(value) => {
                  // 两条路都要走：localStorage（持久化权威）+ Rust（行为权威）
                  preferences.setCloseToTray(value)
                  void syncCloseToTrayPreference(value)
                  onToggleCloseToTray?.(value)
                }}
              />
            </div>
            {!CLOSE_TO_TRAY_TOGGLE_ENABLED ? (
              <p
                data-zj="close-to-tray-pending"
                className="rounded-zj border border-border bg-surface-2 px-3 py-2 text-meta text-muted"
              >
                ⏳ 该开关暂未生效（灰色不可操作）：后端「关闭到托盘」偏好接口尚未落地，
                当前行为固定为「托盘存在时关闭 = 隐藏到托盘」。接口就绪后本开关会自动启用
                —— 具体见 docs/ARCHITECTURE.md §4.13 与任务 t12/t13。
              </p>
            ) : null}
            {closeToTrayDrifted ? (
              <p
                data-zj="close-to-tray-drift"
                className="rounded-zj border border-accent bg-selection px-3 py-2 text-meta text-text"
              >
                ⚠️ 检测到后端行为值与本机偏好不一致（后端 {String(rustValue)}，本机{' '}
                {String(closeToTray)}）：请重新切换一次本开关以重新下发。
              </p>
            ) : null}

            {/* t17：启动时最小化到托盘（后端未提供该能力时禁用 + 说明，不留假开关） */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-ui text-text">启动后最小化到系统托盘</p>
                <p className="text-meta text-muted">
                  开启后启动纸笺会立即把窗口收进托盘（仅在托盘常驻）；用托盘图标或全局快捷键唤起。
                  这同时决定<strong className="font-medium text-text">开机自启</strong>
                  时的行为（两者共用同一项，避免出现互相矛盾的重复开关）。
                  窗口在 WebView 加载完成前会有约 1 秒的短暂显示，这是「不把偏好落到后端」的代价（§4.13）。
                </p>
              </div>
              <Switch
                checked={preferences.startMinimized}
                disabled={!startMinimizedSupported}
                label="启动后最小化到系统托盘"
                onCheckedChange={handleStartMinimizedChange}
              />
            </div>
            {!startMinimizedSupported ? (
              <p
                data-zj="start-minimized-pending"
                className="rounded-zj border border-border bg-surface-2 px-3 py-2 text-meta text-muted"
              >
                {START_MINIMIZED_UNAVAILABLE_REASON}
              </p>
            ) : null}

            {/* ---------------- t38：开机自动启动 ---------------- */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-ui text-text">开机自动启动</p>
                <p className="text-meta text-muted">
                  登录 Windows 后自动启动纸笺并常驻托盘。
                  {autostartSystem === false && preferences.autostart ? '（本机偏好为开启，但系统实际状态是关闭）' : ''}
                </p>
              </div>
              <Switch
                checked={autostartSystem === true}
                disabled={autostartBusy}
                label="开机自动启动"
                onCheckedChange={(value) => void handleAutostartChange(value)}
              />
            </div>

            {/* 真实状态：来自系统（注册表 Run 项），而不是本地偏好 */}
            <p
              data-zj="autostart-state"
              data-autostart-actual={autostartSystem === null ? 'unknown' : String(autostartSystem)}
              className="flex items-center gap-2 text-meta text-muted"
            >
              {autostartBusy ? (
                <>
                  <Loader size={15} strokeWidth={1.75} aria-hidden />
                  正在写入系统设置并回读…
                </>
              ) : autostartSystem === null ? (
                <>
                  <CircleAlert size={15} strokeWidth={1.75} aria-hidden className="text-accent" />
                  无法读取系统状态：{autostartUnavailable ?? AUTOSTART_UNAVAILABLE_HINT}
                </>
              ) : autostartSystem ? (
                <>
                  <Check size={15} strokeWidth={1.75} aria-hidden />
                  系统实际状态：已启用（登录后自动启动）
                </>
              ) : (
                <>
                  <Info size={15} strokeWidth={1.75} aria-hidden />
                  系统实际状态：未启用
                </>
              )}
            </p>

            {autostartDriftedValue ? (
              <p
                data-zj="autostart-drift"
                className="rounded-zj border border-accent bg-selection px-3 py-2 text-meta text-text"
              >
                ⚠️ 本机偏好（{preferences.autostart ? '开启' : '关闭'}）与系统实际状态（
                {autostartSystem ? '已启用' : '未启用'}）不一致 —— 可能是你在系统设置里手动改过。
                以系统状态为准；切换一次本开关即可对齐。
              </p>
            ) : null}

            {autostartSystem === null ? (
              <p className="text-meta text-muted">
                开关为灰色不可操作：读不到系统状态时<strong className="font-medium text-text">不猜</strong>
                （不把「读不到」当「未启用」）。可能原因：浏览器预览模式，或后端尚未注册 autostart 插件/权限。
              </p>
            ) : null}
          </section>

          <Separator />

          {/* ---------------- 快捷键 ---------------- */}
          <section className="flex flex-col gap-3">
            <SectionTitle icon={<Keyboard size={15} strokeWidth={1.75} />}>快捷键</SectionTitle>

            {/* 全局快捷键：可录入 + 冲突检测 + 展示「实际生效」 */}
            <div className="flex flex-col gap-3" data-zj="shortcut-editor">
              {SHORTCUT_ACTIONS.map((action) => {
                const binding = bindings[action.id]
                const effect = shortcutEffectFor(action.id)
                const conflict = findConflict(bindings, action.id, binding.accelerator)
                return (
                  <div key={action.id} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-ui text-text">{action.label}</span>
                    </div>
                    <ShortcutRecorder
                      label={action.label}
                      actionId={action.id}
                      accelerator={binding.accelerator}
                      enabled={binding.enabled}
                      clearable={action.clearable}
                      disabled={!isTauri}
                      conflictLabel={conflict?.withLabel ?? null}
                      systemConflictReason={
                        binding.enabled && binding.accelerator && !effect.applied
                          ? (effect.reason ?? null)
                          : null
                      }
                      unavailableReason={
                        shortcutSync?.unavailableReason ??
                        (!isTauri ? '浏览器预览模式：全局快捷键不可用' : null)
                      }
                      onChange={(value) => void handleShortcutChange(action.id, value)}
                    />
                  </div>
                )
              })}
            </div>

            <div
              data-zj="shortcut-status"
              className={cn(
                'flex items-start gap-2 rounded-zj border px-3 py-2 text-meta',
                shortcutHint.tone === 'warning'
                  ? 'border-accent bg-selection text-text'
                  : 'border-border bg-surface-2 text-muted',
              )}
            >
              <span aria-hidden className="mt-0.5 shrink-0">
                {shortcutHint.tone === 'ok' ? (
                  <Check size={15} strokeWidth={1.75} />
                ) : shortcutHint.tone === 'warning' ? (
                  <CircleAlert size={15} strokeWidth={1.75} />
                ) : (
                  <Info size={15} strokeWidth={1.75} />
                )}
              </span>
              <p className="min-w-0 flex-1">{shortcutHint.text}</p>
            </div>
          </section>

          <Separator />

          {/* ---------------- 数据 ---------------- */}
          <section className="flex flex-col gap-3">
            <SectionTitle icon={<FolderOpen size={15} strokeWidth={1.75} />}>数据</SectionTitle>

            {/* t17：md 文件为真相源 → 目录位置与索引是两件事，分别展示 */}
            <InfoRow label="数据目录（笔记 md 文件，真相源）" mono>
              {vault
                ? vault.vaultRoot
                : vaultError
                  ? `读取失败：${vaultError}`
                  : '读取中…'}
            </InfoRow>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                icon={FolderOpen}
                disabled={!vault || !isTauri}
                onClick={() => void handleRevealVault()}
              >
                在文件管理器中打开
              </Button>
              <Button
                variant="secondary"
                icon={dataBusy === 'backup' ? Loader : Download}
                disabled={dataBusy !== null || !vault || !isTauri}
                onClick={() => void handleBackupVault()}
              >
                {dataBusy === 'backup' ? '备份中…' : '备份数据目录…'}
              </Button>
              {/* t44：导入 md 笔记的两个入口已按用户要求**移到侧栏「全部笔记」下方**
                  （`src/features/sidebar/Sidebar.tsx` 的 `onImportNotes`）。
                  数据层不变（`vaultData.importNotesFromDialog`），只是入口搬家：
                  「导入」属于日常操作，不该藏在设置里。 */}
              <Tooltip content={relocateEnabled ? '先复制校验，成功后才切换；旧目录会保留' : relocateHint.reason}>
                <Button
                  variant="secondary"
                  data-zj="relocate-entry"
                  icon={dataBusy === 'relocate' ? Loader : FolderOutput}
                  disabled={!relocateEnabled || dataBusy !== null || !isTauri}
                  onClick={() => setConfirmRelocate(true)}
                >
                  {dataBusy === 'relocate' ? '正在搬迁…' : '更换数据目录…'}
                </Button>
              </Tooltip>
            </div>
            {/* t41：进行中的可见反馈（搬迁可能很慢；按钮同时被 disabled，防重复点击）
                t44：导入的进度反馈已随入口一起搬到侧栏（那边用行内文案 + Toast）。 */}
            {dataBusy === 'relocate' ? (
              <p data-zj="vault-op-progress" className="flex items-center gap-2 text-meta text-muted">
                <Loader size={15} strokeWidth={1.75} aria-hidden />
                正在复制并校验数据，请勿关闭窗口…（校验通过后才会切换，失败会保持原目录不变）
              </p>
            ) : null}
            {/* t41：换目录的二次确认 —— 操作前就告知「旧数据会保留在哪」 */}
            {confirmRelocate && relocateEnabled ? (
              <div
                role="alertdialog"
                aria-label={RELOCATE_CONFIRM_TITLE}
                data-zj="relocate-confirm"
                className="flex flex-col gap-2 rounded-zj border border-accent bg-selection p-3"
              >
                <p className="text-ui font-medium text-text">{RELOCATE_CONFIRM_TITLE}</p>
                <p className="whitespace-pre-line text-meta text-text">
                  {relocateConfirmMessage(vault?.vaultRoot ?? '（读取中…）', '你稍后在对话框里选择的新目录')}
                </p>
                <div className="flex justify-end gap-2">
                  <Button variant="subtle" size="sm" onClick={() => setConfirmRelocate(false)}>
                    取消
                  </Button>
                  <Button variant="default" size="sm" onClick={() => void handleRelocateVault()}>
                    选择新目录并搬迁
                  </Button>
                </div>
              </div>
            ) : null}
            {relocateEnabled ? (
              <p
                data-zj="relocate-supported"
                className="rounded-zj border border-border bg-surface-2 px-3 py-2 text-meta text-muted"
              >
                ⓘ {relocateHint.reason}
              </p>
            ) : null}
            {!relocateEnabled ? (
              <p
                data-zj="relocate-unsupported"
                className="rounded-zj border border-border bg-surface-2 px-3 py-2 text-meta text-muted"
              >
                ⓘ 暂不支持在应用内更换数据目录：{relocateHint.reason}
              </p>
            ) : null}

            {lastRebuildNote ? (
              <p
                data-zj="data-note"
                className="rounded-zj border border-border bg-surface-2 px-3 py-2 text-meta text-text"
              >
                {lastRebuildNote}
              </p>
            ) : null}

            {/* 索引状态（SQLite 可重建索引） */}
            <div className="rounded-zj border border-border bg-surface-2 px-3 py-2">
              <p className="text-meta text-muted">索引状态</p>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-2xs text-text">
                <span data-zj="index-files">文件 {indexStatus ? indexStatus.fileCount : '—'}</span>
                <span data-zj="index-notes">笔记 {indexStatus ? indexStatus.noteCount : '—'}</span>
                <span>文件夹 {indexStatus ? indexStatus.folderCount : '—'}</span>
                <span>标签 {indexStatus ? indexStatus.tagCount : '—'}</span>
                <span data-zj="index-last">
                  最后重建：
                  {indexStatus?.lastRebuildAt
                    ? new Date(indexStatus.lastRebuildAt).toLocaleString()
                    : '尚未手动重建'}
                </span>
              </div>
              {indexStatus && !indexStatus.inSync ? (
                <p className="mt-1 text-meta text-text">
                  ⚠️ 文件数与索引笔记数不一致（{indexStatus.fileCount} / {indexStatus.noteCount}）：
                  点「重建索引」可与磁盘对齐。
                </p>
              ) : null}
              <div className="mt-2">
                <Button
                  variant="secondary"
                  icon={indexBusy ? Loader : RefreshCw}
                  disabled={indexBusy || !isTauri}
                  onClick={() => void handleRebuildIndex()}
                >
                  {indexBusy ? '重建中…' : '重建索引'}
                </Button>
              </div>
            </div>

            <InfoRow label="索引数据库位置（可删除，能从 md 重建）" mono>
              {vault ? vault.indexDbPath : dbPathError ? `读取失败：${dbPathError}` : dbPath || '读取中…'}
            </InfoRow>

            <div className="flex flex-wrap gap-2">
              <Tooltip content="导出为可读 JSON（含回收站内容）">
                <Button
                  variant="secondary"
                  icon={busy === 'export' ? Loader : Download}
                  disabled={busy !== null || !isTauri}
                  onClick={() => void handleExport()}
                >
                  {busy === 'export' ? '导出中…' : '导出全部数据'}
                </Button>
              </Tooltip>
              <Tooltip content="只新增，不覆盖已有数据">
                <Button
                  variant="secondary"
                  icon={busy === 'import' ? Loader : Upload}
                  disabled={busy !== null || !isTauri}
                  onClick={() => setConfirmImport(true)}
                >
                  {busy === 'import' ? '导入中…' : '导入备份…'}
                </Button>
              </Tooltip>
            </div>

            {!isTauri ? <p className="text-meta text-muted">{FILESYSTEM_UNAVAILABLE_HINT}</p> : null}

            {busy === 'import' ? (
              <p className="flex items-center gap-2 text-meta text-muted">
                <Loader size={15} strokeWidth={1.75} aria-hidden /> 正在逐条写入数据库，请勿关闭窗口…
              </p>
            ) : null}

            {summary ? (
              <p
                data-zj="data-summary"
                className="rounded-zj border border-border bg-surface-2 px-3 py-2 text-meta text-text"
              >
                {summary}
              </p>
            ) : null}

            {confirmImport ? (
              <div
                role="alertdialog"
                aria-label="确认导入备份"
                className="flex flex-col gap-2 rounded-zj border border-accent bg-selection p-3"
              >
                <p className="text-ui text-text">导入只会新增数据，不会修改或删除已有笔记。</p>
                <div className="flex justify-end gap-2">
                  <Button variant="subtle" size="sm" onClick={() => setConfirmImport(false)}>
                    取消
                  </Button>
                  <Button variant="default" size="sm" onClick={() => void handleImport()}>
                    选择备份文件并导入
                  </Button>
                </div>
              </div>
            ) : null}
          </section>

          <Separator />

          {/* ---------------- 关于 ---------------- */}
          <section className="flex flex-col gap-3">
            <SectionTitle icon={<Info size={15} strokeWidth={1.75} />}>关于</SectionTitle>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-ui font-medium text-text">{APP_META.productName}</span>
              <span className="font-mono text-meta text-muted">v{APP_META.version}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {TECHNOLOGIES.map((tech) => (
                <span
                  key={tech}
                  className="rounded-zj-sm border border-border px-2 py-0.5 text-2xs text-muted"
                >
                  {tech}
                </span>
              ))}
            </div>
            <p className="break-all font-mono text-2xs text-muted">{APP_META.identifier}</p>
          </section>
        </div>
      </ScrollArea>

      <PanelFooter />
    </>
  )

  // 受控 + standalone：调用方自己提供 Dialog 外壳，这里只出面板本体
  if (standalone) {
    return (
      <aside
        aria-label="设置面板"
        data-zj="settings-panel"
        className={cn(
          'relative flex flex-col gap-3 rounded-zj border border-border bg-surface p-4 text-text shadow-zj',
          className,
        )}
      >
        <IconButton
          icon={X}
          label="关闭设置"
          className="absolute right-2 top-2"
          onClick={handleClose}
        />
        {body}
      </aside>
    )
  }

  // 自连：自带 Dialog 外壳 + Esc / 遮罩关闭 / 焦点陷阱（由 Dialog 组件提供）
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : handleClose())}>
      <TitleSlotContext.Provider value>
        <DialogContent
          size="lg"
          showClose={false}
          className={className}
          data-zj="settings-panel"
          aria-label="设置"
        >
          <IconButton
            icon={X}
            label="关闭设置"
            className="absolute right-2 top-2"
            onClick={handleClose}
          />
          {body}
        </DialogContent>
      </TitleSlotContext.Provider>
    </Dialog>
  )
}

export default SettingsPanel
