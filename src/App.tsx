/**
 * 纸笺 —— 应用根组件（t7 集成装配）。
 *
 * 职责（只做编排，不实现业务）：
 *   1. 启动流程：initDb → 主题 → 元数据（文件夹/标签/计数）→ 笔记 → 事件与快捷键
 *   2. 三栏布局：Titlebar + Sidebar + NoteList + EditorPane，设置面板与 Toast
 *   3. 把各 feature 的 props 契约接上真实 store / 仓储
 *
 * 红线（t7 契约）：
 *   - **自动保存必须写入「本次渲染的那篇笔记」**：`onTitleChange` / `onContentChange` 用闭包捕获的
 *     `note.id`，绝不在回调里现读 `selectedId`（否则「A 里打字 → 未到防抖就切 B」会把 A 的正文写进 B）。
 *     写法依据：`src/features/editor/README.md §2`。
 *   - 搜索结果必须真实喂入 `notes` + `snippets`（snippet 已在 db 层转义并含 `<mark>`，
 *     由 NoteCard 单次 `dangerouslySetInnerHTML` 渲染，**禁止二次转义**）。
 *   - 视图切换要走 store 的集合入口：`listByFolder` / `listByTag` / `listTrash` / `refresh`，
 *     否则标签视图与回收站是死码。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Titlebar, useTitlebarState } from '@/features/titlebar'
import { Sidebar, searchHitsToNoteList, useSearchStoreSlice } from '@/features/sidebar'
import { ConfirmDialog, NoteList } from '@/features/notes-list'
import { EditorPane } from '@/features/editor'
import type { EditorSaveState } from '@/features/editor'
import {
  SettingsPanel,
  CloseToTrayNotice,
  importNotesFromDialog,
  syncShortcutBindingsOnStartup,
} from '@/features/settings'
import {
  closeTileForNote,
  listTileNoteIds,
  listTiles,
  setTilePinned,
  toggleTileForNote,
} from '@/features/tiles'
import { ToastProvider, useToast } from '@/components/ui'
import { initDb, onIndexMutated } from '@/db'
import { foldersRepo } from '@/db/folders'
import { notesRepo } from '@/db/notes'
import { tagsRepo } from '@/db/tags'
import { readDefaultSort } from '@/lib/appPreferences'
import { exportNote } from '@/lib/export'
import { bindGlobalHotkeys, bindShortcuts } from '@/lib/hotkeys'
import { isTauri, onNoteChanged, onTilesChanged } from '@/lib/tauri'
import { errorMessage } from '@/lib/utils'
import { listAll, listTrash, useNotesStore } from '@/store/notes'
import { useThemeStore } from '@/store/theme'
import { useUiStore } from '@/store/ui'
import type { FolderTreeNode, NoteCounts, Tag, UiView } from '@/types'

/** 空计数（元数据尚未加载时使用，避免 undefined 抖进侧栏） */
const EMPTY_COUNTS: NoteCounts = { all: 0, trash: 0, byFolder: {}, byTag: {} }

/**
 * 「退出前给前端一次收尾机会」的自定义事件名。
 * 由 `lib/hotkeys.ts` 在收到 Rust `appQuitRequested` 后派发，本组件唯一消费。
 * 放在此处是为了避免 `emit 但无人听`（QA 报告 D1b）。
 */
const QUIT_REQUESTED_EVENT = 'zhijian:quit-requested'

/**
 * 标题栏标题的语义归一化（t14）。
 *
 * `TitlebarProps.title` 只有一个 string，而标题栏（`Titlebar.tsx:33`）的分支是
 * `title.trim().length > 0 ? title : '未选择笔记'` —— 于是「未选中笔记」与
 * 「选中了空标题笔记」会落进同一分支。这里在 App 侧把两者分开：
 *
 * | 状态 | 传入值 | 标题栏渲染 |
 * | --- | --- | --- |
 * | 未选中任何笔记 | `''` | 「未选择笔记」 |
 * | 选中了空标题笔记 | `'无标题'` | 「无标题」 |
 * | 选中有标题笔记 | `note.title` | 原文 |
 *
 * **零契约变更**：`TitlebarProps`、Titlebar 组件内部均未改动，只改传值。
 * 与笔记列表卡片使用的「无标题」文案保持一致。
 */
export function normalizeTitlebarTitle(note: { title: string } | null): string {
  if (!note) return ''
  return note.title.trim() || '无标题'
}

/** 当前笔记标题：优先取列表里的最新对象 */
function useCurrentNote() {
  const notes = useNotesStore((s) => s.notes)
  const selectedId = useNotesStore((s) => s.selectedId)
  return useMemo(
    () => notes.find((note) => note.id === selectedId) ?? null,
    [notes, selectedId],
  )
}

/**
 * 文件夹 / 标签 / 计数三者总是一起变化（增删文件夹与标签、增删笔记都会影响计数），
 * 因此统一用一个 reload 拉取，避免三处各自失效。
 *
 * **t35：为什么改成"订阅索引变更"而不是在每个写入口手动 reload**
 *   侧栏徽标（计数）来自索引投影，缓存在本 hook 的 state 里。此前约定"谁写库谁记得
 *   调 reloadMeta()"，结果出了两次事故：t20/F2（重建索引后不刷新）与 t35（**打标签后**
 *   不刷新 —— 编辑器/列表走 `notesStore.update(id, { tags })`，绕过了 App 的手动 reload）。
 *   现在改为订阅 db 层的索引变更信号：**任何**写入（笔记/标签/文件夹/重建/外部同步）
 *   都会触发一次刷新，派生视图不需要再逐处记得。
 *   信号只在**写索引**时发出（`counts()` 等只读操作不发出），因此不会自激循环。
 */
function useMeta() {
  const [folders, setFolders] = useState<FolderTreeNode[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [counts, setCounts] = useState<NoteCounts>(EMPTY_COUNTS)

  const reload = useCallback(async () => {
    try {
      await initDb()
      const [tree, tagList, nextCounts] = await Promise.all([
        foldersRepo.tree(),
        tagsRepo.list(),
        notesRepo.counts(),
      ])
      setFolders(tree)
      setTags(tagList)
      setCounts(nextCounts)
    } catch (error) {
      // 元数据失败不阻断笔记列表；错误统一由 notesStore.error / toast 通道暴露
      console.warn('[纸笺] 加载文件夹/标签/计数失败：', errorMessage(error))
    }
  }, [])

  // t35：索引一变就刷新（同一批写入在 db 层已合并为一次通知）
  useEffect(() => onIndexMutated(() => void reload()), [reload])

  return { folders, tags, counts, reload }
}

export default function App() {
  return (
    <ToastProvider>
      {/* §4.13：必须在 ToastProvider 内长期挂载一次。
          它负责「启动时把偏好下发给 Rust」+「隐藏到托盘时给用户可见反馈」，
          漏挂会导致重启后开关被悄悄忘记、且隐藏时用户得不到任何提示。 */}
      <CloseToTrayNotice />
      <AppShell />
    </ToastProvider>
  )
}

function AppShell() {
  const toast = useToast()

  /* ---------------------------- store 订阅 ---------------------------- */
  const notes = useNotesStore((s) => s.notes)
  const selectedId = useNotesStore((s) => s.selectedId)
  const loading = useNotesStore((s) => s.loading)
  const notesError = useNotesStore((s) => s.error)
  const clearNotesError = useNotesStore((s) => s.clearError)

  const appliedNote = useCurrentNote()

  const view = useUiStore((s) => s.view)
  const activeFolderId = useUiStore((s) => s.activeFolderId)
  const activeTagId = useUiStore((s) => s.activeTagId)
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const setView = useUiStore((s) => s.setView)
  const openSettings = useUiStore((s) => s.openSettings)

  const { state: searchState } = useSearchStoreSlice()

  const meta = useMeta()
  const titlebar = useTitlebarState()

  const [editorMode, setEditorMode] = useState<'edit' | 'preview' | 'split'>('split')
  const [bootState, setBootState] = useState<'booting' | 'ready' | 'preview' | 'failed'>('booting')
  const [bootError, setBootError] = useState<string | null>(null)
  /** D2：Ctrl+Delete 的待确认目标（删除是不可逆的用户动作，必须二次确认） */
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  /** t46：清空回收站的二次确认（永久删除，不可恢复 ⇒ 必须确认） */
  const [confirmEmptyTrash, setConfirmEmptyTrash] = useState(false)
  /** D5：标题栏的保存态由编辑器的真实状态驱动（不再写死「已保存」） */
  const [saveState, setSaveState] = useState<EditorSaveState>({ saved: true, label: '已保存' })
  /** D3：设置面板的「默认排序」真实消费（只作为 NoteList 的初始排序模式） */
  const [defaultSortMode] = useState(() => readDefaultSort())
  /**
   * t20：已钉成桌面磁贴的笔记 id 集合。
   *
   * **权威状态在 Rust**（`cmd_list_tiles`；含「全部隐藏」后仍在册的窗口），
   * 前端只在切换后重新对账，不自行推断 —— 与 §4.14.4「几何只归 Rust」同一原则：
   * 前端存一份自己的磁贴表就会成为第二个真相源。
   * 浏览器 dev / 命令不可用时 `listTileNoteIds()` 返回 `null` ⇒ 空集合（不假装钉住）。
   */
  const [tileNoteIds, setTileNoteIds] = useState<readonly string[]>([])

  /**
   * t44：远端改写令牌 —— 每当「别的窗口（桌面磁贴）改的正是当前选中的这篇」时自增。
   *
   * 透传给 `EditorPane`，用于放行"已证明来自其它窗口"的采纳
   * （`locallyEdited` 那道单调闸门原本会把真外部改动一并挡住，
   * 详见 `EditorPaneComponentProps.remoteAdoptToken` 的完整说明）。
   */
  const [remoteAdoptToken, setRemoteAdoptToken] = useState(0)

  /**
   * t44：正在导入 md 的来源（侧栏两个入口的禁用态与文案）。
   * `importingRef` 与它配对：state 负责**显示**，ref 负责**防重入**
   * （同一 tick 内 state 还没重新渲染，只看 state 挡不住第二次点击）。
   */
  const [importing, setImporting] = useState<'files' | 'folder' | null>(null)
  const importingRef = useRef<'files' | 'folder' | null>(null)

  const reloadMetaRef = useRef(meta.reload)
  reloadMetaRef.current = meta.reload
  /** 启动流程里要用 toast，但它每次渲染都是新对象 ⇒ 用 ref 取最新（同 reloadMetaRef 的做法） */
  const toastRef = useRef(toast)
  toastRef.current = toast

  /* ------------------------------ 启动流程 ------------------------------ */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // 1) 数据库（幂等；t3 内部 memoize）
        await initDb()
        if (cancelled) return
        // 2) 元数据 + 3) 笔记首屏
        await reloadMetaRef.current()
        await useNotesStore.getState().init()
        if (cancelled) return
        setBootState('ready')
        // 4) t46：把**用户自定义的全局快捷键绑定**下发给 Rust —— 启动时补一次。
        //
        // 为什么必须有（用户报障 ①：「关闭程序后再开启，关于磁贴的快捷键失效」）：
        // `cmd_sync_global_shortcuts` 原先**只在设置面板里**被调用，而 Rust 启动只注册
        // `default_bindings()`（newNote / toggleWindow）
        // ⇒ 用户在设置里绑定的 `toggleTiles` / `pinNote` / `openSettings` 重启后全部失效，
        // 必须再打开一次设置面板才会恢复 —— 而那正是"重启后快捷键失效"的全部原因。
        // 与 §4.13「关闭到托盘偏好启动时同步」同一模式：**localStorage 是权威，启动即下发**。
        //
        // 放在 `setBootState('ready')` 之后：不阻塞界面出现（它只是补注册键位）。
        await syncShortcutBindingsOnStartup((failure) => {
          if (cancelled) return
          console.warn('[纸笺] 启动下发全局快捷键未完全生效：', failure)
          toastRef.current.toast({
            title: '快捷键未完全生效',
            description: failure,
            variant: 'warning',
          })
        })
      } catch (error) {
        if (cancelled) return
        // 浏览器预览模式（pnpm dev）没有 SQLite，这不是故障：明确区分，避免误报启动失败
        setBootState(isTauri ? 'failed' : 'preview')
        setBootError(errorMessage(error))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /* --------------------- 主题初始化（否则已存偏好不生效） --------------------- */
  useEffect(() => {
    // 模块导入时 store/theme.ts 已应用过一次；这里在挂载后再确保一次，覆盖首帧竞态
    useThemeStore.getState().apply()
  }, [])

  /* --------- Rust → 前端：仅消费「退出前的收尾机会」（D1b 修复） ---------
     ⚠️ 不要在这里重复订阅 newNoteRequested / openSettingsRequested：
     这两者已由 `bindGlobalHotkeys()`（lib/hotkeys.ts）订阅；订阅两次会让
     **一次 Alt+N 建出两条笔记**（QA 报告 D1，high）。
     现在职责单一：热键类事件 → hotkeys.ts；本组件只接「前端自定义的收尾事件」。 */
  useEffect(() => {
    const onQuit = () => {
      toast.toast({ title: '正在退出纸笺', variant: 'info', duration: 1500 })
    }
    // `zhijian:quit-requested` 由 hotkeys.ts 在收到 Rust `appQuitRequested` 后派发，
    // 链路唯一（Rust → hotkeys → 本组件），不存在重复监听。
    window.addEventListener(QUIT_REQUESTED_EVENT, onQuit)
    return () => window.removeEventListener(QUIT_REQUESTED_EVENT, onQuit)
  }, [toast])

  /* --------------------- 应用内快捷键（D2：真实绑定） ---------------------
     `LOCAL_SHORTCUTS.togglePreview / toggleSidebar / deleteNote` 原先只被声明、
     从未绑定（设置面板却向用户宣称可用）。这里把它们真正接上。
     注：`search`(Ctrl+K) 由 SearchBox 自己监听、`save`(Ctrl+S) 由编辑器 keymap 处理，
     故不在此重复绑定，避免又造出第二处「同一动作双订阅」。 */
  useEffect(() => {
    const unbind = bindShortcuts({
      togglePreview: () =>
        setEditorMode((mode) => (mode === 'preview' ? 'edit' : 'preview')),
      toggleSidebar: () => useUiStore.getState().toggleSidebar(),
      deleteNote: () => {
        // 只在「非回收站」视图下有意义；回收站里应当是「恢复」
        if (useUiStore.getState().view === 'trash') return
        const id = useNotesStore.getState().selectedId
        if (!id) return
        setPendingDeleteId(id)
      },
    })
    return unbind
  }, [])

  /* ------------------------- 前端快捷键兜底（窗口聚焦时） ------------------------- */
  useEffect(() => {
    const unbind = bindGlobalHotkeys({
      newNote: () => createNote(),
      openSettings: () => openSettings(),
      // t20：磁贴快捷键（两个动作都由 Rust 侧发起，见 §4.14.6）
      //  · pinNote            → Rust 显示主窗口 + emit 事件；**由这里回填 selectedId**
      //  · tilesVisibilityChanged → 显隐已由 Rust 完成，这里只重新对账前端开关态
      pinCurrentNote: () => handlePinCurrentNote(),
      tilesVisibilityChanged: () => {
        void refreshTileState()
      },
      onError: (message) => toast.toast({ title: '快捷键执行失败', description: message, variant: 'error' }),
    })
    return unbind
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSettings, toast])

  /* --------------------------- 错误提示（notes） --------------------------- */
  useEffect(() => {
    if (!notesError) return
    toast.toast({ title: '操作失败', description: notesError, variant: 'error' })
    clearNotesError()
  }, [notesError, clearNotesError, toast])

  /* ------------ t44：其它窗口改动了笔记 ⇒ 本窗口跟上（接收侧） ------------
     背景（用户实测）：主窗口与磁贴是**两个独立 WebView、各持一份 store 实例**，
     一边写库另一边不会知道 ⇒「在笔记里新输入的文字不反馈到磁贴，反之亦然，
     必须关掉磁贴再打开才刷新」。写入侧统一在 `store/notes.ts` 里广播
     （`zhijian://note-changed`），这里负责接收。

     三条设计要点：
      1. **本窗口有焦点就整体不动**：焦点是独占资源，本窗口有焦点说明用户正在这里打字，
         此刻刷新列表 / 替换正文都可能打断输入；而对面窗口那时没有焦点、它自己会刷新 ——
         两侧由同一条件决定，因此不需要协商、也不需要"谁赢"的规则。
         附带好处：窗口最小化或隐藏到托盘时 `document.hasFocus()` 为 false ⇒ 照样刷新，
         用户再把窗口叫出来时看到的已经是最新内容。
      2. 刷新走既有的 `notesStore.refresh()` + 元数据 `reload()`（标签/计数也可能被磁贴改过），
         **不新增第二条取数路径**（§2：视图层不自行读库）。
      3. 只有"改的正是当前选中的这篇"才自增 `remoteAdoptToken`；改的是别的笔记时
         仅刷新列表，绝不去动正在编辑的这篇草稿。

     为什么不用 Rust 侧转发：跨窗口同步在 Rust 里做就得把内容也搬过去
     （等于造出第二份内容副本）；只广播 id、由接收方重读，md 真相源始终唯一。 */
  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | null = null
    void onNoteChanged((payload) => {
      if (cancelled) return
      if (typeof document !== 'undefined' && document.hasFocus()) return
      void useNotesStore.getState().refresh()
      void reloadMetaRef.current()
      if (payload.noteId === useNotesStore.getState().selectedId) {
        setRemoteAdoptToken((token) => token + 1)
      }
    }).then((off) => {
      // 订阅是异步建立的：组件可能在这之前就卸载了，此时必须立刻退订（否则会叠加订阅）
      if (cancelled) off()
      else unsubscribe = off
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  /* ------------------------------ 动作编排 ------------------------------ */

  /** 新建笔记：跟随当前视图的所属文件夹，收尾刷新计数 */
  const createNote = useCallback(async (): Promise<void> => {
    if (!isTauri) {
      // 浏览器预览没有数据库：给一次说明，而不是让 store 抛「数据库不可用」
      toast.toast({
        title: '浏览器预览模式',
        description: '没有 SQLite，无法新建笔记。请用 pnpm tauri:dev 启动桌面应用。',
        variant: 'warning',
      })
      return
    }
    const currentView = useUiStore.getState().view
    const folderId =
      currentView === 'folder' ? useUiStore.getState().activeFolderId : null
    try {
      await useNotesStore.getState().create(folderId)
      await reloadMetaRef.current()
    } catch (error) {
      toast.toast({ title: '新建笔记失败', description: errorMessage(error), variant: 'error' })
    }
  }, [toast])

  /** 视图切换：把 uiStore 的选择翻译成 notesStore 的集合入口（E1/E2/E3） */
  const handleSelectView = useCallback(
    (next: UiView, id?: string | null) => {
      setView(next, id)
      // 非 Tauri（浏览器预览）或启动失败时没有数据库：只切视图，不发起查询，
      // 否则每次点导航都会弹出「数据库不可用」的 Toast —— 而界面已有明确提示，属噪音。
      if (!isTauri || bootState === 'failed') return
      switch (next) {
        case 'folder':
          // 收件箱 = folderId null
          void useNotesStore.getState().listByFolder(id ?? null)
          break
        case 'tag':
          // id 可能是 Tag.id；listByTag 入口做 id→名 容错解析（ARCHITECTURE §4.12 方案 A）
          if (id) void useNotesStore.getState().listByTag(id)
          break
        case 'trash':
          // E2：回收站是独立入口（视图语义不在 §4.2 冻结签名内）
          void listTrash()
          break
        case 'settings':
          openSettings()
          break
        case 'all':
        default:
          // E3：「全部」= 不带过滤的全部笔记（注意不是 listByFolder(null)，那是收件箱）
          void listAll()
          break
      }
    },
    [setView, openSettings, bootState],
  )

  const handleCreateFolder = useCallback(
    async (name: string, parentId?: string | null) => {
      try {
        await foldersRepo.create({ name, parentId: parentId ?? null })
        await reloadMetaRef.current()
      } catch (error) {
        toast.toast({ title: '新建文件夹失败', description: errorMessage(error), variant: 'error' })
      }
    },
    [toast],
  )

  const handleRenameFolder = useCallback(
    async (id: string, name: string) => {
      try {
        await foldersRepo.rename(id, name)
        await reloadMetaRef.current()
      } catch (error) {
        toast.toast({ title: '重命名失败', description: errorMessage(error), variant: 'error' })
      }
    },
    [toast],
  )

  const handleRemoveFolder = useCallback(
    async (id: string) => {
      try {
        await foldersRepo.remove(id)
        await reloadMetaRef.current()
        // 当前正在看的文件夹被删掉时回到「全部」
        if (useUiStore.getState().activeFolderId === id) handleSelectView('all')
      } catch (error) {
        toast.toast({ title: '删除文件夹失败', description: errorMessage(error), variant: 'error' })
      }
    },
    [toast, handleSelectView],
  )

  const handleCreateTag = useCallback(
    async (name: string, color?: string) => {
      try {
        await tagsRepo.create(color ? { name, color } : { name })
        await reloadMetaRef.current()
      } catch (error) {
        toast.toast({ title: '新建标签失败', description: errorMessage(error), variant: 'error' })
      }
    },
    [toast],
  )

  const handleRemoveTag = useCallback(
    async (id: string) => {
      try {
        await tagsRepo.remove(id)
        await reloadMetaRef.current()
        // 当前正在看的标签被删掉时回到「全部」
        if (useUiStore.getState().activeTagId === id) handleSelectView('all')
      } catch (error) {
        toast.toast({ title: '删除标签失败', description: errorMessage(error), variant: 'error' })
      }
    },
    [toast, handleSelectView],
  )

  /* --------------- t20 总装：标签重命名 / 改颜色（t18 备好的可选 props） ---------------
     t18 把侧栏的标签操作做成**可选 props**，并在未传时**不渲染对应菜单项**
     （宁可不显示，也不给"点了没反应"的假入口）。这里把它们接上，
     否则「重命名」「改颜色」两个菜单项永远不会出现。
     `tagsRepo.updateColor` 只改 `.paper/tags.json` 的 color + 同步索引
     （不重写 md、不刷新笔记 updatedAt，ARCHITECTURE §4.3/§4.12）。 */
  const handleRenameTag = useCallback(
    async (id: string, name: string) => {
      try {
        await tagsRepo.rename(id, name)
        await reloadMetaRef.current()
      } catch (error) {
        toast.toast({ title: '重命名标签失败', description: errorMessage(error), variant: 'error' })
      }
    },
    [toast],
  )

  const handleUpdateTagColor = useCallback(
    async (id: string, color: string) => {
      try {
        await tagsRepo.updateColor(id, color)
        await reloadMetaRef.current()
      } catch (error) {
        toast.toast({ title: '修改标签颜色失败', description: errorMessage(error), variant: 'error' })
      }
    },
    [toast],
  )

  /* --------------------------- 编辑器自动保存 --------------------------- */
  // ⚠️ 红线：闭包捕获「本次渲染的 note.id」，绝不在回调里现读 selectedId
  const handleTitleChange = useCallback(
    (title: string) => {
      if (!appliedNote) return
      void useNotesStore.getState().update(appliedNote.id, { title })
    },
    [appliedNote],
  )

  const handleContentChange = useCallback(
    (content: string) => {
      if (!appliedNote) return
      void useNotesStore.getState().update(appliedNote.id, { content })
    },
    [appliedNote],
  )

  const handleEditorSave = useCallback(async () => {
    if (!appliedNote) return
    await useNotesStore.getState().refresh()
  }, [appliedNote])

  /**
   * D5：编辑器的保存态 → 标题栏。
   * 必须用 `useCallback` 保持引用稳定 —— 编辑器内部以它为 effect 依赖，
   * 每次渲染新建函数会导致该 effect 反复触发。
   */
  const handleSaveStateChange = useCallback((next: EditorSaveState) => {
    setSaveState(next)
  }, [])

  const handleExport = useCallback(
    async (format: 'markdown' | 'html' | 'txt') => {
      const note = useNotesStore
        .getState()
        .notes.find((item) => item.id === useNotesStore.getState().selectedId)
      await exportNote(note ?? null, format, { notify: toast.toast })
    },
    [toast],
  )

  /* ---------------- t20：桌面磁贴（钉住 / 取消 + 状态对账） ----------------
     数据通道见 `docs/ARCHITECTURE.md §4.14`：窗口的创建/位置/生命周期归 Rust（t19），
     这里只负责「用户入口 → `cmd_toggle_tile`」，并在每次操作后**向 Rust 重新对账**。 */
  const refreshTileState = useCallback(async () => {
    const ids = await listTileNoteIds()
    setTileNoteIds(ids ?? [])
  }, [])

  /**
   * t45：让这些笔记**彻底退出磁贴**（取消固定 → 关窗 → 重新对账）。
   *
   * 顺序不能反：先关窗后取消固定的话，中间那一刻若恰好退出应用，
   * `tiles.json` 里留着 `pinned: true` ⇒ 下次启动它又会出现（用户报障 ②的形态）。
   */
  const retireTiles = useCallback(
    async (noteIds: readonly string[]) => {
      if (noteIds.length === 0) return
      const tiles = await listTiles()
      if (!tiles) return
      const targets = new Set(noteIds)
      for (const tile of tiles) {
        if (!targets.has(tile.noteId)) continue
        if (tile.pinned) await setTilePinned(tile.noteId, false)
        /*
         * ⚠️ t48：这里必须用 `closeTileForNote`（**确保关闭**），不能再用 toggle。
         *
         * toggle 的语义是"没开就打开" ⇒ 若某个窗口刚被上一轮对账关掉、而这次对账
         * 拿到的列表略旧（`Destroyed` 与 `webview_windows()` 移除之间有极短竞态），
         * 就会**把它重新打开**（关了又开、开了又关），消息来回增殖 ——
         * 与用户报的 `STATUS_HEAP_CORRUPTION` 崩溃高度相关。
         * `closeTileForNote` 已改成"先判是否开着，没开则 no-op"。
         */
        await closeTileForNote(tile.noteId)
      }
      await refreshTileState()
    },
    [refreshTileState],
  )

  /**
   * t45：清掉「指向已不可读笔记」的磁贴。
   *
   * 用户报障 ③：每次启动桌面中间都会冒出一个空白磁贴，上面写着「这条笔记不在了」。
   * 根因：`tiles.json` 是 Rust 的（它只知道几何），而"这条笔记现在还读不读得到"是
   * **数据层的事实**。用户把笔记删进回收站之后，那条磁贴记录仍在，启动时照旧恢复。
   *
   * 判据刻意与磁贴自己的读取路径**完全一致**（都是 `notesRepo.get(id)`）：
   * 「清理判据说能读到」与「磁贴真能读到」因此不可能各说各话。
   * 注意**不能**用 `listAll({ includeDeleted: true })` 判存在性 —— 回收站里的笔记
   * 在索引里是存在的，但磁贴读不到它（`get` 视软删除为不存在），那正是本 bug 的情形。
   *
   * ⚠️ 两条**真机探针抓出来的**安全护栏（第一版没有，后果很严重）：
   *  1. **先确保数据库就绪**：本函数在挂载后立刻被调用，而启动流程（initDb → 各仓储）
   *     是异步的 ⇒ 会在库还没就绪时查库、`notesRepo.get` 抛错。`initDb()` 幂等且已 memoize，
   *     这里直接 await 一次最省事。
   *  2. **查询抛错 ≠ 笔记不存在**：第一版把异常也当成"不可读" ⇒ 竞态下会把**用户正常的
   *     磁贴（包括已固定的）**一并清掉（连固定状态都会被取消）。现在异常一律**跳过该条**
   *     并留日志：宁可留一个脏磁贴，也绝不能误删正常的。
   */
  const pruneStaleTiles = useCallback(async () => {
    if (!isTauri) return
    try {
      await initDb()
    } catch (error) {
      console.warn('[纸笺] 数据库未就绪，跳过磁贴清理（避免误删正常磁贴）：', errorMessage(error))
      return
    }
    const tiles = await listTiles()
    if (!tiles || tiles.length === 0) return
    const stale: string[] = []
    for (const tile of tiles) {
      try {
        if ((await notesRepo.get(tile.noteId)) !== null) continue
      } catch (error) {
        // 「查不了」与「不存在」是两件事：这里必须保守跳过（fail-safe）
        console.warn(
          '[纸笺] 检查磁贴对应笔记失败，已跳过（保留该磁贴）：',
          tile.noteId,
          errorMessage(error),
        )
        continue
      }
      stale.push(tile.noteId)
    }
    if (stale.length > 0) {
      console.info('[纸笺] 清理指向已不可读笔记的磁贴：', stale.join(', '))
      await retireTiles(stale)
    }
  }, [retireTiles])

  useEffect(() => {
    // 首次挂载对账一次：应用重启后 Rust 会按 `tiles.json` 恢复**被固定**的磁贴，
    // 前端必须把自己的开关态与之一致（否则界面显示"未钉住"但窗口其实在）。
    // 先清脏条目再取状态：清理本身也会改动磁贴集合（t45）。
    void (async () => {
      await pruneStaleTiles()
      await refreshTileState()
    })()
  }, [pruneStaleTiles, refreshTileState])

  useEffect(() => {
    // t45：磁贴被**别处**关掉（用户点磁贴自己的 ×）⇒ 立刻重新对账。
    // 用户报障 ①：没有这条订阅时，主窗口那条笔记的按钮会一直停在「取消桌面磁贴」，
    // 而实际上磁贴早就不在了（Rust 是权威，前端只能靠事件知道它变了）。
    let cancelled = false
    let unsubscribe: (() => void) | null = null
    void onTilesChanged(() => {
      if (cancelled) return
      void refreshTileState()
      // Destroyed 事件与「窗口从 webview_windows() 里消失」之间有极短竞态，
      // 补一次延迟对账（幂等）——否则可能读到"其实已经没了"的旧列表，按钮又停在错状态。
      window.setTimeout(() => {
        if (!cancelled) void refreshTileState()
      }, 150)
    }).then((off) => {
      if (cancelled) off()
      else unsubscribe = off
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [refreshTileState])

  /** 按 noteId 切换磁贴；失败时给出可读原因（浏览器 dev 下会退化为新标签页预览） */
  const toggleTileById = useCallback(
    async (noteId: string) => {
      const result = await toggleTileForNote(noteId)
      if (!result.ok) {
        toast.toast({ title: '磁贴打不开', description: result.message, variant: 'error' })
      }
      await refreshTileState()
    },
    [refreshTileState, toast],
  )

  /**
   * 磁贴按钮的入口：入参是**按钮所在的那条笔记**（由 EditorPane 传回），
   * 不在这里现读 selectedId —— 避免「显示的笔记」与「被钉住的笔记」因时序不同而错位。
   */
  const handleToggleTile = useCallback(
    async (noteId: string) => {
      await toggleTileById(noteId)
    },
    [toggleTileById],
  )

  /**
   * 外部数据变化后的统一刷新（导入备份 / 重建索引都用它）。
   * 两件事缺一不可：① `notesStore.refresh()` 让**列表**回到当前集合；
   * ② `reloadMeta()` 让**侧栏计数徽标 / 目录树 / 标签**回到真实数字。
   * （t21 的 F2：只刷新其一 ⇒ 面板显示 7、侧栏仍显示 10。）
   */
  const handleExternalDataChanged = useCallback(() => {
    void useNotesStore
      .getState()
      .refresh()
      .then(() => reloadMetaRef.current())
  }, [])

  /**
   * t44：导入 md 笔记 —— 入口在侧栏「全部笔记」下方（用户要求从设置面板挪过来）。
   *
   * 数据层**一行没动**：仍是 t41 已验证的 `importNotesFromDialog(source)`
   * （文件多选 / 目录递归选择的对话框参数、非破坏性去重、逐条问题汇总都在那里）。
   * 这里只负责三件事：防重入、把结果如实报给用户（成功/部分完成/失败三档）、
   * 以及导入后走 `handleExternalDataChanged()` 刷新列表与侧栏计数
   * （不刷新的话用户会看到"导入了但列表里没有" —— t21 的 F2 就是这类假成功）。
   */
  const handleImportNotes = useCallback(
    async (source: 'files' | 'folder') => {
      // 按钮已 disabled，这里再兜一层：两个入口在同一 tick 被激活时不会发起两轮导入
      if (importingRef.current !== null) return
      if (!isTauri) {
        toast.toast({
          title: '浏览器预览模式',
          description: '导入需要读写本机文件，请用 pnpm tauri:dev 启动桌面应用。',
          variant: 'warning',
        })
        return
      }
      importingRef.current = source
      setImporting(source)
      try {
        const outcome = await importNotesFromDialog(source)
        // 用户主动取消不是失败，也不该弹提示（与设置面板时期的既有行为一致）
        if (outcome.status === 'cancelled') return
        const detail =
          outcome.problems.length > 0 ? `｜详情：${outcome.problems.slice(0, 2).join('；')}` : ''
        toast.toast({
          title:
            outcome.status === 'failed'
              ? '导入笔记失败'
              : outcome.failed > 0 || outcome.skipped > 0
                ? '导入笔记部分完成'
                : '导入笔记完成',
          description: `${outcome.summary}${detail}`,
          variant:
            outcome.status === 'failed' ? 'error' : outcome.failed > 0 ? 'warning' : 'success',
        })
        if (outcome.imported > 0) handleExternalDataChanged()
      } catch (error) {
        toast.toast({
          title: '导入笔记失败',
          description: errorMessage(error),
          variant: 'error',
        })
      } finally {
        importingRef.current = null
        setImporting(null)
      }
    },
    [handleExternalDataChanged, toast],
  )

  /**
   * 快捷键动作 `pinNote` 的入口（Rust emit `PIN_CURRENT_NOTE_REQUESTED`）。
   * 这条链路必须现读 `selectedId`：Rust 只表达"用户按了键"，**选中项是纯前端状态**。
   * 未选中任何笔记时给出提示，而不是静默什么都不发生。
   */
  const handlePinCurrentNote = useCallback(async () => {
    const id = useNotesStore.getState().selectedId
    if (!id) {
      toast.toast({
        title: '先打开一篇笔记',
        description: '「钉住当前笔记」需要先选中一条笔记。',
        variant: 'info',
      })
      return
    }
    await toggleTileById(id)
  }, [toggleTileById, toast])

  /* --------------------------- 列表动作 --------------------------- */
  const handleSelectNote = useCallback((id: string) => {
    useNotesStore.getState().select(id)
  }, [])

  const handleTogglePin = useCallback(async (id: string) => {
    const note = useNotesStore.getState().notes.find((item) => item.id === id)
    if (!note) return
    await useNotesStore.getState().update(id, { pinned: !note.pinned })
  }, [])

  const handleReorder = useCallback(async (id: string, targetIndex: number) => {
    const state = useNotesStore.getState()
    // 标签/回收站视图的集合与规范序不是 1:1，move 只传 folderId 给 db 做重排
    const folderId = state.activeView === 'folder' ? state.activeFolderId : undefined
    await state.move(id, targetIndex, folderId)
  }, [])

  const handleMoveToFolder = useCallback(async (id: string, folderId: string | null) => {
    await useNotesStore.getState().update(id, { folderId })
    await reloadMetaRef.current()
  }, [])

  const handleRemoveNote = useCallback(
    async (id: string) => {
      await useNotesStore.getState().remove(id)
      await reloadMetaRef.current()
      // t45：笔记一进回收站，它的磁贴就读不到内容了（`notesRepo.get` 视软删除为不存在）
      // ⇒ 顺手让它彻底退出磁贴（取消固定 + 关窗）。不做的话，用户下次启动会看到一个
      // 写着「这条笔记不在了」的空白磁贴（用户报障 ③ 的根源）。
      await retireTiles([id])
    },
    [retireTiles],
  )

  const handleRestoreNote = useCallback(async (id: string) => {
    await useNotesStore.getState().restore(id)
    await reloadMetaRef.current()
  }, [])

  /**
   * t46：清空回收站 —— **永久删除**回收站里的全部笔记。
   *
   * 逐条走数据层的 `notesRepo.hardDelete`（它负责删 md 文件 + 索引行 + 标签关联），
   * 而不是自己删文件：md 是真相源，绕过它就会出现"文件没了、索引还在"的半死状态。
   * 收尾三件事缺一不可：① 刷新列表与元数据（否则回收站里还显示着已删的条目）；
   * ② 让这些笔记的磁贴退场（否则桌面上会留下指向已删笔记的空白磁贴，正是 t45 那个报障）；
   * ③ 如实报告删了几条（成功/失败都要说）。
   */
  const handleEmptyTrash = useCallback(async () => {
    try {
      const trash = await notesRepo.listAll({ onlyDeleted: true })
      if (trash.length === 0) return
      for (const note of trash) await notesRepo.hardDelete(note.id)
      await useNotesStore.getState().refresh()
      await reloadMetaRef.current()
      await retireTiles(trash.map((note) => note.id))
      toast.toast({ title: `已清空回收站（${trash.length} 条）`, variant: 'success' })
    } catch (error) {
      toast.toast({ title: '清空回收站失败', description: errorMessage(error), variant: 'error' })
    }
  }, [retireTiles, toast])

  const handleHardDeleteNote = useCallback(
    async (id: string) => {
      try {
        await notesRepo.hardDelete(id)
        // hardDelete 不在 notesStore 冻结签名内：直接重取当前集合
        await useNotesStore.getState().refresh()
        await reloadMetaRef.current()
        // t45：彻底删除同样要让它的磁贴退出（同上）
        await retireTiles([id])
      } catch (error) {
        toast.toast({ title: '彻底删除失败', description: errorMessage(error), variant: 'error' })
      }
    },
    [retireTiles, toast],
  )

  /* --------------------------- 搜索链路（R4） --------------------------- */
  const query = searchState?.query ?? ''
  const searchSlice = useMemo(
    () => searchHitsToNoteList(searchState?.results ?? []),
    [searchState?.results],
  )

  /** 搜索态优先；否则用 store 的当前集合 */
  const listNotes = query.trim().length > 0 && searchState ? searchSlice.notes : notes
  const listSnippets = query.trim().length > 0 && searchState ? searchSlice.snippets : {}
  const listLoading = loading || (searchState?.searching ?? false)

  /* --------------------------- 视图与空状态 --------------------------- */
  /**
   * t46：设置不再是"单独一页"，而是**最右侧的一栏**（用户要求：
   * 「点击设置后让它出现在这个界面的最右侧，让它作为整个界面的一栏」）。
   *
   * 改动只有一行（`editorVisible` → `settingsVisible`）+ 渲染位置：
   * 主界面（侧栏 / 列表 / 编辑器）在打开设置时**保持原样**，
   * 设置栏叠加在右侧，关掉即消失 —— 用户"边看笔记边改设置"不需要来回切页。
   */
  const settingsVisible = view === 'settings'
  /** t20：当前显示的笔记是否已钉成磁贴（用于编辑器里按钮的「钉住/取消」文案与图标） */
  const tilePinned = appliedNote ? tileNoteIds.includes(appliedNote.id) : false

  const emptyHint = useMemo(() => {
    if (bootState === 'booting') return '正在打开你的便笺…'
    if (bootState === 'preview')
      return '浏览器预览模式：没有 SQLite，无法读写笔记。请用 pnpm tauri:dev 启动桌面应用。'
    if (bootState === 'failed') return `启动失败：${bootError ?? '未知原因'}`
    if (query.trim().length > 0) return '没有匹配的笔记，换个关键词试试。'
    if (view === 'trash') return '回收站是空的。删除的笔记会先放在这里。'
    if (view === 'tag') return '这个标签下还没有笔记。'
    return '还没有笔记。写下第一张纸笺吧。'
  }, [bootState, bootError, query, view])

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <Titlebar
        // 空标题语义归一化（t14）：区分「未选中笔记」与「选中了空标题笔记」。
        // 依据 Titlebar.tsx:33 的 `title.trim().length > 0` 分支；零契约变更，只改传值。
        title={normalizeTitlebarTitle(appliedNote)}
        // D5：反映编辑器真实保存态（原先写死 true，导致「未保存」分支永不可达）
        saved={saveState.saved}
        maximized={titlebar.maximized}
        onMinimize={() => void titlebar.minimize()}
        onToggleMaximize={() => void titlebar.toggleMaximize()}
        onClose={() => void titlebar.close()}
        onOpenSettings={openSettings}
      />

      <div className="flex min-h-0 flex-1">
        <Sidebar
          folders={meta.folders}
          tags={meta.tags}
          counts={meta.counts}
          view={view}
          activeFolderId={activeFolderId}
          activeTagId={activeTagId}
          collapsed={sidebarCollapsed}
          onToggleCollapse={toggleSidebar}
          onSelectView={handleSelectView}
          onCreateFolder={handleCreateFolder}
          onRenameFolder={handleRenameFolder}
          onRemoveFolder={handleRemoveFolder}
          onCreateTag={handleCreateTag}
          onRemoveTag={handleRemoveTag}
          // t20：t18 备好的两个可选 props —— 不接则「重命名 / 改颜色」菜单项不渲染
          onRenameTag={handleRenameTag}
          onUpdateTagColor={handleUpdateTagColor}
          // t44：导入 md 的入口（用户要求从设置面板挪到「全部笔记」下方）
          onImportNotes={handleImportNotes}
          importing={importing}
        />

        {/* t46：主界面在打开设置时**保持原样**（设置改为右侧一栏，见文件末） */}
        <>
            <NoteList
              notes={listNotes}
              selectedId={selectedId}
              loading={listLoading}
              query={query}
              snippets={listSnippets}
              onSelect={handleSelectNote}
              onCreate={createNote}
              onTogglePin={handleTogglePin}
              onReorder={handleReorder}
              onMoveToFolder={handleMoveToFolder}
              onRemove={handleRemoveNote}
              onRestore={handleRestoreNote}
              onHardDelete={handleHardDeleteNote}
              // t46：清空回收站（永久删除）—— 入口由 NoteList 在回收站视图自行显示
              onEmptyTrash={() => setConfirmEmptyTrash(true)}
              folders={meta.folders}
              // 标签视图的集合与手动排序语义不同，关闭拖拽（t11/data 的实证结论）
              reorderable={view === 'all' || view === 'folder'}
              searching={searchState?.searching ?? false}
              // D3：把设置里持久化的「默认排序」真正消费掉（否则是假开关）
              defaultSortMode={defaultSortMode}
            />

            <main className="flex min-w-0 flex-1 flex-col">
              {bootState === 'ready' ? (
                <EditorPane
                  note={appliedNote}
                  // 自动保存由编辑器内部状态机驱动（含 500ms 防抖与换笔记冲刷），故 dirty 恒为 false
                  dirty={false}
                  mode={editorMode}
                  onModeChange={setEditorMode}
                  onTitleChange={handleTitleChange}
                  onContentChange={handleContentChange}
                  onSave={handleEditorSave}
                  onExport={handleExport}
                  onCreateNote={() => void createNote()}
                  // D5：把编辑器的真实保存态上报给标题栏
                  onSaveStateChange={handleSaveStateChange}
                  // t20：桌面磁贴入口（t19 的 Rust 实现 + t24 的磁贴视图）
                  onToggleTile={handleToggleTile}
                  tilePinned={tilePinned}
                  // t44：别的窗口改的就是这一篇时自增，用于放行采纳（见 EditorPane 的同名入参）
                  remoteAdoptToken={remoteAdoptToken}
                />
              ) : (
                // 启动中 / 浏览器预览 / 启动失败：编辑器不可用时给出明确说明。
                // 注意：'ready' 但没有笔记时**不在这里**渲染空状态 —— 那种情况交给
                // EditorPane 自己的空状态，避免出现两处重复的「还没有笔记」。
                <section className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                  <h1 className="text-lg font-medium">纸笺</h1>
                  <p className="max-w-md text-sm text-muted">{emptyHint}</p>
                  {bootState !== 'booting' ? (
                    <button
                      type="button"
                      onClick={() => void createNote()}
                      className="zj-focus-ring rounded-zj border border-border bg-surface px-3 py-2 text-sm text-text hover:bg-hover"
                    >
                      新建第一篇笔记
                    </button>
                  ) : null}
                </section>
              )}
            </main>
        </>

        {/* t46：设置 = 最右侧一栏（用户要求）。
            用 `standalone`（面板只出本体，不带 Dialog 外壳），并用 className 抹掉
            它的圆角/边框/阴影 —— 那些是"浮层卡片"的样式，放进栏里会显得是贴上去的一块。
            栏自己负责滚动（设置项很长），主界面完全不参与。 */}
        {settingsVisible ? (
          <aside
            data-zj="settings-column"
            aria-label="设置栏"
            className="flex w-[360px] shrink-0 flex-col overflow-hidden border-l border-border bg-surface-2"
          >
            <SettingsPanel
              standalone
              onNotify={toast.toast}
              // t20/t22：外部数据变化（导入 / 重建索引）后统一刷新「列表 + 元数据」。
              // 为什么两处都要：`onDataImported` 只覆盖导入；**重建索引**同样会按磁盘 md
              // 增删索引行 —— 不重载元数据，侧栏计数徽标就会一直停在旧数字（t21 的 F2：
              // 设置面板已显示 7、侧栏仍显示 10，切视图后列表自愈而徽标不变）。
              onDataImported={handleExternalDataChanged}
              onIndexRebuilt={handleExternalDataChanged}
              className="h-full min-h-0 flex-1 rounded-none border-0 bg-transparent shadow-none"
            />
          </aside>
        ) : null}
      </div>

      {/* D2：Ctrl+Delete 的二次确认 —— 删除是用户动作且快捷键易误触，不能直接删 */}
      <ConfirmDialog
        open={pendingDeleteId !== null}
        title="移到回收站？"
        description="这条笔记会被移到回收站，之后可以恢复。"
        confirmLabel="移到回收站"
        onOpenChange={(next) => {
          if (!next) setPendingDeleteId(null)
        }}
        onConfirm={async () => {
          const id = pendingDeleteId
          setPendingDeleteId(null)
          if (id) await handleRemoveNote(id)
        }}
      />

      {/* t46：清空回收站的二次确认 —— 永久删除不可恢复，必须让用户看清数量后再点 */}
      <ConfirmDialog
        open={confirmEmptyTrash}
        title="清空回收站？"
        description={`将永久删除回收站里的 ${meta.counts.trash} 条笔记，**无法恢复**（笔记的 md 文件会一并删除）。`}
        confirmLabel="永久删除"
        onOpenChange={(next) => {
          if (!next) setConfirmEmptyTrash(false)
        }}
        onConfirm={async () => {
          setConfirmEmptyTrash(false)
          await handleEmptyTrash()
        }}
      />
    </div>
  )
}
