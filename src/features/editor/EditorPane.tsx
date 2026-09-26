/**
 * EditorPane —— 编辑器面板（编辑 / 分栏 / 预览 三态 + 细工具条 + 防抖自动保存）。
 * 归属：编辑器成员（任务 t4）。导出名与 props 由 docs/ARCHITECTURE.md §4.4 冻结。
 *
 * 结构：
 *   ┌ 细工具条：标题输入 · 字数 · 保存状态 · 视图切换 · 保存 · 导出 ┐
 *   ├ 编辑区（CodeMirrorEditor） ─ 可拖拽分隔条 ─ 预览区（MarkdownPreview） ┤
 *
 * 关键约束：
 *  1. **不串写**：正文以 `draft` 承载，换笔记时按 note.id 重置；CodeMirrorEditor
 *     额外用 `key={note.id}` 强制重建；未落库内容由 useAutoSave 用「切换前捕获的
 *     回调」冲刷回旧笔记（详见 useAutoSave.ts 的说明）。
 *  2. **自动保存**：内容/标题变化 500ms 防抖后经 `onContentChange` / `onTitleChange`
 *     交给上层落库；Ctrl/Cmd+S / 工具条保存按钮立即冲刷后再调用 `onSave`。
 *  3. **零硬编码样式**：只用 token 派生类与设计刻度，颜色随主题变量自动切换。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import {
  Check,
  CircleAlert,
  CircleDashed,
  Columns2,
  Eye,
  FileCode2,
  FileDown,
  FileText,
  Pencil,
  Pin,
  PinOff,
  Save,
  Tag as TagIcon,
  Type,
} from 'lucide-react'
import {
  Badge,
  Button,
  DropdownMenu,
  IconButton,
  Input,
  TagPickerDialog,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui'
import type { MenuItemDef } from '@/components/ui'
import type { EditorPaneProps, Note, Tag } from '@/types'
import { tagsRepo } from '@/db/tags'
import { useNotesStore } from '@/store/notes'
import { cn, formatTime } from '@/lib/utils'
import { CodeMirrorEditor } from './CodeMirrorEditor'
import type { CodeMirrorEditorHandle } from './CodeMirrorEditor'
import { EditorEmpty } from './EditorEmpty'
import { MarkdownPreview } from './MarkdownPreview'
import { MarkdownToolbar } from './MarkdownToolbar'
import { DEFAULT_AUTO_SAVE_DELAY_MS, useAutoSave } from './useAutoSave'
import type { AutoSavePayload } from './useAutoSave'
import { shouldAdoptExternalDraft } from './draftSync'
import {
  EMPTY_TOOLBAR_STATE,
  computeToolbarState,
  runMarkdownCommand,
  runRedo,
  runUndo,
  toolbarSignature,
} from './markdownToolbarState'
import type { MarkdownToolbarState } from './markdownToolbarState'
import type { MarkdownCommandId } from './markdownCommands'
import type { EditorView } from '@codemirror/view'

/** 三态视图（与 EditorPaneProps['mode'] 同义，命名便于内部阅读） */
export type EditorMode = EditorPaneProps['mode']

/**
 * 编辑器面板的完整 props：契约里的 EditorPaneProps + 一组**可选**扩展。
 * 只传 EditorPaneProps 的集成方无需改动即可使用（可选扩展都有默认值）。
 */
export interface EditorPaneComponentProps extends EditorPaneProps {
  /** 行号显示（默认关闭 —— docs/DESIGN.md §5） */
  showLineNumbers?: boolean
  /** 自动保存防抖延时（默认 500ms，契约区间 400–600ms） */
  autoSaveDelayMs?: number
  /** 空状态里的「新建笔记」动作；不传则不渲染该按钮 */
  onCreateNote?: () => void
  /** 选中笔记后是否自动聚焦编辑器（默认 true） */
  autoFocusEditor?: boolean
  /**
   * 上报内部保存态（可选）。用于让**标题栏**的「已保存/未保存」反映真实状态，
   * 而不是写死为已保存（QA 报告 D5）。
   */
  onSaveStateChange?: (state: EditorSaveState) => void
  /**
   * 当前笔记的标签（可选）。缺省取 `note.tags`——因此标签入口开箱即用，
   * 集成层想接管展示时再传。
   */
  noteTags?: string[]
  /**
   * 标签变更回调（可选）：入参是**新的完整名称数组**。
   * 缺省时回退到 `useNotesStore.getState().update(note.id, { tags: next })`
   * （只调用既有 store 接口，不修改 store/db 源码）。
   */
  onEditTags?: (next: string[]) => void | Promise<void>
  /**
   * 标签库（可选）：TagPicker 里可勾选的标签（名称 + 颜色）。
   * 缺省时首次打开面板会只读调用 `tagsRepo.list()` 拉一次；失败则只展示笔记已有标签。
   */
  allTags?: readonly Tag[]
  /** 工具条标签按钮上最多直接展示几个标签（默认 2，其余折叠成 +k） */
  maxVisibleTags?: number
  /**
   * t20 总装：把这条笔记钉成 / 取消桌面磁贴（可选）。
   * **不传则不渲染该按钮** —— 与 `onCreateNote` / `onRenameTag` 同一约定：
   * 宁可不显示，也不给一个"点了没反应"的假入口。
   *
   * 入参是**本组件正在显示的笔记 id**（由这里传出，而不是让上层现读 `selectedId`）：
   * 避免「显示的笔记」与「被钉住的笔记」因状态时序不同而错位。
   * 窗口的创建/位置/生命周期归 Rust（`docs/ARCHITECTURE.md §4.14`），
   * 本组件只负责把用户意图交给上层。
   */
  onToggleTile?: (noteId: string) => void | Promise<void>
  /** 当前显示的笔记是否已钉成磁贴（决定按钮图标与提示文案）；缺省 false */
  tilePinned?: boolean
  /**
   * t44：**远端改写令牌** —— 每当「别的窗口（桌面磁贴）改的正是当前这篇」时自增。
   *
   * 为什么需要额外的入参，而不是让 `note` 自己变就够了：
   * `shouldAdoptExternalDraft` 里的 `locallyEdited` 是**单调**的（本篇打开后被本地编辑过就
   * 永不回落），它原本用来挡住"本窗口自己保存回包的乱序回声"。可它同时也会把**真正来自其它
   * 窗口的改动**一并挡掉 —— 用户实测的现象就是「在磁贴里打的字，主窗口这篇永远看不到」。
   * 令牌把"这次变化已被广播证明是别人写的"这一信息送进来，据此清掉本地编辑历史。
   *
   * 约定（调用方必须遵守）：**只在本窗口没有焦点时**自增 —— 焦点是独占资源，
   * 本窗口没有焦点 ⇒ 用户不可能正在这里打字 ⇒ 清历史不会打断任何输入。
   */
  remoteAdoptToken?: number
}

/** 标题栏消费的保存态 */
export interface EditorSaveState {
  /** true = 无未落库改动 */
  saved: boolean
  /** 与编辑器工具条徽标一致的可读文案（'已保存' / '未保存' / '保存中…' / '保存失败'） */
  label: string
}

interface Draft {
  id: string | null
  title: string
  content: string
}

export interface ContentStats {
  /** 中日韩字符按字计数 + 拉丁词按词计数 */
  words: number
  chars: number
  lines: number
}

/** 字数统计（中文按字、英文按词） */
export function contentStats(text: string): ContentStats {
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)?.length ?? 0
  const latin = text.match(/[A-Za-z0-9_][A-Za-z0-9_'’-]*/g)?.length ?? 0
  return {
    words: cjk + latin,
    chars: text.length,
    lines: text.length === 0 ? 0 : text.split('\n').length,
  }
}

function toDraft(note: Note | null): Draft {
  return { id: note?.id ?? null, title: note?.title ?? '', content: note?.content ?? '' }
}

/* --------------------------- 分栏比例拖拽 --------------------------- */

const SPLIT_MIN = 0.2
const SPLIT_MAX = 0.8
const SPLIT_STEP = 0.04

function clampRatio(value: number): number {
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value))
}

function useSplitRatio(initial = 0.5) {
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const [ratio, setRatio] = useState(initial)

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = true
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* 合成事件 / 指针已释放：不影响拖拽状态机 */
    }
  }, [])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    setRatio(clampRatio((event.clientX - rect.left) / rect.width))
  }, [])

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = false
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      /* 同上 */
    }
  }, [])

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setRatio((value) => clampRatio(value - SPLIT_STEP))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setRatio((value) => clampRatio(value + SPLIT_STEP))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setRatio(SPLIT_MIN)
    } else if (event.key === 'End') {
      event.preventDefault()
      setRatio(SPLIT_MAX)
    }
  }, [])

  return { containerRef, ratio, onPointerDown, onPointerMove, onPointerUp, onKeyDown }
}

/* ------------------------------- 组件 ------------------------------- */

export function EditorPane({
  note,
  mode,
  dirty,
  onModeChange,
  onTitleChange,
  onContentChange,
  onSave,
  onExport,
  showLineNumbers = false,
  autoSaveDelayMs = DEFAULT_AUTO_SAVE_DELAY_MS,
  onCreateNote,
  autoFocusEditor = true,
  onSaveStateChange,
  noteTags,
  onEditTags,
  allTags,
  maxVisibleTags = 2,
  onToggleTile,
  tilePinned = false,
  remoteAdoptToken,
}: EditorPaneComponentProps) {
  const noteId = note?.id ?? null

  const [draft, setDraft] = useState<Draft>(() => toDraft(note))
  /** 已经交给上层的草稿（用于区分「上层回写」与「外部改动」） */
  const lastSentRef = useRef<Draft>(toDraft(note))
  /**
   * t32：本笔记自打开以来是否发生过**本地编辑**（单调，不回落；换笔记时重置）。
   * 它是「外部改写要不要覆盖草稿」的判据之一，与保存回包的到达顺序无关 ——
   * 这正是 t16 那条启发式判据「有概率」翻车的根因，时序表见 draftSync.ts。
   */
  const locallyEditedRef = useRef(false)

  /* 换笔记：渲染期同步重置草稿（React 官方「props 变化时调整 state」模式）。
     旧笔记未落库的内容由 useAutoSave 的 scope 切换冲刷负责，不会丢也不会串。 */
  if (note && note.id !== draft.id) {
    const next = toDraft(note)
    setDraft(next)
    lastSentRef.current = next
    locallyEditedRef.current = false
  }

  /**
   * t44：收到「已证明来自其它窗口」的改写 ⇒ 清掉本地编辑历史，让下面的采纳判据放行。
   *
   * 语义澄清（否则很容易被误读成"为了通过而放宽判据"）：
   *  - `locallyEdited` 的职责是**区分"本窗口自己的保存回包"与"外部改写"**，挡住前者；
   *  - 而本令牌的来源是跨窗口广播，且 `lib/tauri.ts::onNoteChanged` 已在**源头**
   *    过滤掉 `source === 本窗口 label` 的回声 ⇒ 这次变化**不可能**是本窗口写的；
   *  - 因此"本地编辑过"不再是拒绝它的理由。
   *
   * 依然不会弄丢输入，因为采纳判据里的另外两道闸门原样保留：
   *  ① `busy`（有未落库或正在落库的改动）⇒ 一律不采纳；
   *  ② 调用方只在**本窗口没有焦点**时自增令牌 ⇒ 用户不可能正在这篇编辑器里打字
   *     （焦点独占：用户在磁贴里打字时，主窗口必然没有焦点）。
   * 另外 `CodeMirrorEditor` 自己还有"有焦点不整篇替换"的守卫（第 4 道），三重冗余。
   *
   * 与「换笔记」同一写法：渲染期同步调整（React 官方 props 变化模式），
   * 这样本次渲染下面的采纳判据就能立刻看到清零后的值，不需要额外一轮 effect。
   */
  const remoteAdoptRef = useRef(remoteAdoptToken)
  if (remoteAdoptToken !== remoteAdoptRef.current) {
    remoteAdoptRef.current = remoteAdoptToken
    locallyEditedRef.current = false
  }

  const { status, error, lastSavedAt, hasPending, schedule, flush } = useAutoSave({
    scopeKey: noteId,
    delayMs: autoSaveDelayMs,
    /**
     * 这个回调是**每次渲染重新创建**的：它闭包捕获了本次渲染的 note 与
     * onContentChange / onTitleChange。useAutoSave 在换笔记时用「上一次渲染的
     * 实例」冲刷未落库内容，因此 payload 永远写回它自己的笔记（不串写）。
     */
    onFlush: (payload: AutoSavePayload) => {
      if (payload.content !== undefined) onContentChange(payload.content)
      if (payload.title !== undefined) onTitleChange(payload.title)
      if (lastSentRef.current.id === noteId) {
        lastSentRef.current = {
          id: noteId,
          title: payload.title ?? lastSentRef.current.title,
          content: payload.content ?? lastSentRef.current.content,
        }
      }
    },
  })

  const editorRef = useRef<CodeMirrorEditorHandle>(null)
  const scheduleRef = useRef(schedule)
  const flushRef = useRef(flush)
  scheduleRef.current = schedule
  flushRef.current = flush

  /* t32：外部改写采纳判据（放在 useAutoSave 之后，因为它需要 hasPending/status）。
     取向（captain 定）：**宁可收紧，也不允许输入被打断** —— 输入被回退/光标被重置是严重缺陷，
     而"外部改了 md 后当前笔记不自动刷新"可以由切换笔记 / 重启自愈（t15 的 md 真相源）。
     判据只依赖单调事实（是否本地编辑过 / 是否有在飞保存），因此不再"有概率"。 */
  const busySaving = hasPending || status === 'saving'
  if (note && note.id === draft.id) {
    const adoptContent = shouldAdoptExternalDraft({
      incoming: note.content,
      draft: draft.content,
      locallyEdited: locallyEditedRef.current,
      busy: busySaving,
    })
    const adoptTitle = shouldAdoptExternalDraft({
      incoming: note.title,
      draft: draft.title,
      locallyEdited: locallyEditedRef.current,
      busy: busySaving,
    })
    if (adoptContent || adoptTitle) {
      const next: Draft = {
        id: draft.id,
        title: adoptTitle ? note.title : draft.title,
        content: adoptContent ? note.content : draft.content,
      }
      setDraft(next)
      lastSentRef.current = next
    }
  }

  /* ---------------- 格式化工具栏（t16） ----------------
     工具栏需要 EditorView 才能派发命令，而激活态要随光标移动刷新。
     为免每次按键都重渲染，这里用「激活态签名」做廉价比较，只有真的变了才 setState。 */
  const editorViewRef = useRef<EditorView | null>(null)
  const toolbarSignatureRef = useRef('')
  const [toolbarState, setToolbarState] = useState<MarkdownToolbarState>(EMPTY_TOOLBAR_STATE)
  const [editorReady, setEditorReady] = useState(false)

  const handleViewReady = useCallback((view: EditorView | null) => {
    editorViewRef.current = view
    setEditorReady(view !== null)
    if (!view) {
      toolbarSignatureRef.current = ''
      setToolbarState(EMPTY_TOOLBAR_STATE)
      return
    }
    toolbarSignatureRef.current = toolbarSignature(view.state)
    setToolbarState(computeToolbarState(view.state))
  }, [])

  const handleViewUpdate = useCallback((view: EditorView) => {
    const signature = toolbarSignature(view.state)
    if (signature === toolbarSignatureRef.current) return
    toolbarSignatureRef.current = signature
    setToolbarState(computeToolbarState(view.state))
  }, [])

  const handleToolbarCommand = useCallback(
    (id: MarkdownCommandId) => {
      const view = editorViewRef.current
      if (!view) return
      runMarkdownCommand(view, id)
      // 命令会改变文档 → 交给既有自动保存链路；这里只同步一下激活态
      handleViewUpdate(view)
    },
    [handleViewUpdate],
  )

  const handleUndo = useCallback(() => {
    const view = editorViewRef.current
    if (!view) return
    runUndo(view)
    handleViewUpdate(view)
  }, [handleViewUpdate])

  const handleRedo = useCallback(() => {
    const view = editorViewRef.current
    if (!view) return
    runRedo(view)
    handleViewUpdate(view)
  }, [handleViewUpdate])

  /* ---------------- 标签入口（t23） ----------------
     展示：优先 props.noteTags，缺省直接用冻结契约里的 note.tags（因此开箱即用）。
     落库：优先 props.onEditTags；缺省回退到既有 store 接口
           useNotesStore.getState().update(note.id, { tags })（只读调用，不改 store/db 源码）。 */
  const tags = noteTags ?? note?.tags ?? []
  const [tagPickerOpen, setTagPickerOpen] = useState(false)
  const [tagCatalog, setTagCatalog] = useState<readonly Tag[]>(allTags ?? [])
  const [tagSaving, setTagSaving] = useState(false)
  const [tagError, setTagError] = useState<string | null>(null)

  /* 标签库来源：props.allTags 优先；没有就在**首次打开面板时**拉一次（本地 SQLite，很便宜）。
     浏览器 dev（无 Tauri/DB）会失败 → 静默降级为「只展示笔记已有标签 + 可以新建」。 */
  useEffect(() => {
    if (allTags) {
      setTagCatalog(allTags)
      return
    }
    if (!tagPickerOpen) return
    let cancelled = false
    void tagsRepo
      .list()
      .then((list) => {
        if (!cancelled) setTagCatalog(list)
      })
      .catch((error: unknown) => {
        // 不静默：标签库拉不到时面板仍可用（会展示笔记已有标签 + 允许新建），
        // 但「为什么看不到已有标签」必须留下线索（多是数据库未就绪 / 权限缺失）。
        if (cancelled) return
        setTagCatalog([])
        console.warn('[纸笺] 标签库读取失败，面板仅展示本笔记已有标签：', error)
      })
    return () => {
      cancelled = true
    }
  }, [allTags, tagPickerOpen, noteId])

  const handleTagsChange = useCallback(
    async (next: string[]) => {
      if (!note) return
      setTagError(null)
      setTagSaving(true)
      try {
        if (onEditTags) {
          await onEditTags(next)
        } else {
          await useNotesStore.getState().update(note.id, { tags: next })
        }
        // 新建的标签名立刻并入本地标签库，面板里马上能再次勾选
        setTagCatalog((previous) => {
          const known = new Set(previous.map((tag) => tag.name))
          const added = next.filter((name) => !known.has(name))
          if (added.length === 0) return previous
          return [...previous, ...added.map((name) => ({ id: name, name, color: '', createdAt: Date.now() }))]
        })
      } catch (writeError) {
        setTagError(writeError instanceof Error ? writeError.message : String(writeError))
      } finally {
        setTagSaving(false)
      }
    },
    [note, onEditTags],
  )

  const visibleTags = tags.slice(0, Math.max(0, maxVisibleTags))
  const hiddenTagCount = Math.max(0, tags.length - visibleTags.length)

  const stats = useMemo(() => contentStats(draft.content), [draft.content])

  const handleContentChange = useCallback((text: string) => {
    locallyEditedRef.current = true
    setDraft((previous) => (previous.content === text ? previous : { ...previous, content: text }))
    scheduleRef.current({ content: text })
  }, [])

  const handleTitleChange = useCallback((value: string) => {
    locallyEditedRef.current = true
    setDraft((previous) => (previous.title === value ? previous : { ...previous, title: value }))
    scheduleRef.current({ title: value })
  }, [])

  const handleSaveNow = useCallback(() => {
    flushRef.current()
    void onSave()
  }, [onSave])

  const exportItems = useMemo<MenuItemDef[]>(
    () => [
      {
        id: 'markdown',
        label: '导出为 Markdown',
        icon: FileCode2,
        onSelect: () => void onExport('markdown'),
      },
      { id: 'html', label: '导出为 HTML', icon: FileText, onSelect: () => void onExport('html') },
      { id: 'txt', label: '导出为纯文本', icon: Type, onSelect: () => void onExport('txt') },
    ],
    [onExport],
  )

  const split = useSplitRatio()
  const showEditor = mode === 'edit' || mode === 'split'
  const showPreview = mode === 'preview' || mode === 'split'

  const saving = status === 'saving'
  const saveLabel = error ? '保存失败' : saving ? '保存中…' : hasPending || dirty ? '未保存' : '已保存'

  /** 把内部保存态上报给上层（可选）—— 让标题栏的「已保存/未保存」反映真实状态，
      而不是写死为「已保存」（QA 报告 D5：那会让「未保存」分支永不可达）。
      ⚠️ 本 Hook 必须位于下方 `if (!note) return` 之前：否则 note 从「有」变「无」
      （选中笔记后点空白文件夹 / 空标签 / 回收站）时 Hook 数量减少，React 会抛
      "Rendered fewer hooks than expected" 并卸载整棵树 —— 表现为整个界面白屏。 */
  useEffect(() => {
    onSaveStateChange?.({
      saved: !error && !saving && !hasPending && !dirty,
      label: saveLabel,
    })
  }, [onSaveStateChange, error, saving, hasPending, dirty, saveLabel])

  if (!note) {
    return (
      <section
        data-zj-editor-pane="empty"
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg"
      >
        <EditorEmpty onCreate={onCreateNote} />
      </section>
    )
  }

  const SaveIcon = error ? CircleAlert : saving || hasPending || dirty ? CircleDashed : Check
  const saveHint = error
    ? `保存失败：${error}`
    : lastSavedAt
      ? `最近保存：${formatTime(lastSavedAt)}`
      : '改动会在停止输入后自动保存（Ctrl/Cmd+S 立即保存）'

  return (
    <section
      data-zj-editor-pane={mode}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg"
    >
      {/* ---------------- 细工具条 ----------------
          t34：窄宽度下**不换行**（nowrap + shrink-0），空间不足时按 DESIGN「留白多于装饰」
          **渐进隐藏次要信息**，而不是让文字折行。

          判据用**容器查询**（`@container` + `@max-[…]`）：编辑区宽度 = 窗口 − 侧栏 − 列表，
          最小窗宽 880px 时只剩约 368px；媒体查询反映的是窗口宽度，在这里是错的判据。

          阈值按实测冻结项宽度推出（368px 容器下：标题输入 10 · 标签按钮 98 · 保存态 69 ·
          视图切换 217 · 立即保存 28 · 导出 61 · 间距 5×8 · 内边距 24 ≈ 547px）：
            ≥41rem(656px) 全部可见 → 否则隐藏「N 字」
            ≥36rem(576px) → 否则隐藏标签按钮文字与保存态文字（只留图标，title/aria-label 保留语义）
            ≥32rem(512px) → 否则隐藏视图切换的文字（只留图标，触发器带 aria-label）
            ≥26rem(416px) → 否则隐藏「钉到桌面」按钮（可选入口）
            ≥22rem(352px) → 否则隐藏「导出」文字（只留图标，按钮带 aria-label）
          368px 下合计约 349px ≤ 368px ⇒ 不换行、不溢出。 */}
      <div className="@container flex h-11 shrink-0 items-center gap-2 overflow-x-hidden border-b border-border bg-surface px-3">
        <Input
          bare
          inputSize="lg"
          value={draft.title}
          onChange={(event) => handleTitleChange(event.target.value)}
          onBlur={() => flushRef.current()}
          placeholder="无标题"
          aria-label="笔记标题"
          data-zj-title-input=""
          className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-1 text-title font-medium text-text"
        />

        {/* 标签入口（t23）：显示当前笔记标签（最多 N 个 + 「+k」），点击打开 TagPicker */}
        <Button
          variant="ghost"
          size="sm"
          icon={TagIcon}
          aria-haspopup="dialog"
          aria-expanded={tagPickerOpen}
          aria-label={tags.length > 0 ? `编辑标签（已选 ${tags.length} 个）` : '添加标签'}
          title={tags.length > 0 ? `标签：${tags.join('、')}` : '添加标签'}
          data-zj-tag-button=""
          data-zj-tag-count={tags.length}
          onClick={() => setTagPickerOpen(true)}
          className="min-w-0 max-w-64 shrink gap-1 overflow-hidden @max-[19rem]:hidden"
        >
          {tags.length === 0 ? (
            <span className="text-muted @max-[36rem]:hidden">标签</span>
          ) : (
            <span className="flex min-w-0 items-center gap-1 @max-[36rem]:hidden">
              {visibleTags.map((name) => (
                <Badge key={name} variant="muted" size="sm" className="max-w-20 truncate">
                  {name}
                </Badge>
              ))}
              {hiddenTagCount > 0 ? (
                <Badge variant="muted" size="sm" data-zj-tag-overflow="">
                  +{hiddenTagCount}
                </Badge>
              ) : null}
            </span>
          )}
        </Button>

        {/* 字数（t34）：不换行（shrink-0 + nowrap），工具条太窄时**隐藏**这个次要信息；
            绝不折行 —— DESIGN「极简、留白多于装饰」。 */}
        <Badge
          variant="muted"
          size="md"
          title={`${stats.lines} 行 · ${stats.chars} 字符`}
          data-zj-word-count=""
          className="shrink-0 whitespace-nowrap @max-[41rem]:hidden"
        >
          {stats.words} 字
        </Badge>

        <Badge
          variant={error ? 'outline' : 'muted'}
          size="md"
          title={saveHint}
          data-zj-save-status={error ? 'error' : saving ? 'saving' : 'saved'}
          className="shrink-0 gap-1 whitespace-nowrap"
        >
          <SaveIcon size={11} strokeWidth={1.75} aria-hidden />
          {/* 窄宽度只留图标（badge 的 title 仍给出完整语义），绝不折行 */}
          <span className="@max-[36rem]:hidden">{saveLabel}</span>
        </Badge>

        <Tabs
          variant="pill"
          value={mode}
          onValueChange={(value) => onModeChange(value as EditorMode)}
          className="w-fit shrink-0"
        >
          <TabsList aria-label="视图切换">
            {/* t34：窄宽度只留图标；文字用 span 包裹以便隐藏，aria-label 保证无障碍名称不丢 */}
            <TabsTrigger
              value="edit"
              aria-label="编辑"
              icon={<Pencil size={13} strokeWidth={1.75} aria-hidden />}
            >
              <span className="@max-[32rem]:hidden">编辑</span>
            </TabsTrigger>
            <TabsTrigger
              value="split"
              aria-label="分栏"
              icon={<Columns2 size={13} strokeWidth={1.75} aria-hidden />}
            >
              <span className="@max-[32rem]:hidden">分栏</span>
            </TabsTrigger>
            <TabsTrigger
              value="preview"
              aria-label="预览"
              icon={<Eye size={13} strokeWidth={1.75} aria-hidden />}
            >
              <span className="@max-[32rem]:hidden">预览</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <IconButton
          icon={Save}
          label="立即保存 (Ctrl+S)"
          tooltip
          variant="ghost"
          onClick={handleSaveNow}
        />

        {/* t20：钉住/取消桌面磁贴。未传 onToggleTile 时整块不渲染（可选入口约定）。
            磁贴窗口本身的创建与位置持久化由 Rust 负责，这里只是用户意图的入口。 */}
        {onToggleTile ? (
          <IconButton
            icon={tilePinned ? PinOff : Pin}
            label={tilePinned ? '取消桌面磁贴' : '钉到桌面（磁贴）'}
            tooltip
            variant="ghost"
            aria-pressed={tilePinned}
            data-zj-tile-toggle
            /* t34：非核心入口，工具条不够宽时让位给标签/保存/视图/导出 */
            className="@max-[26rem]:hidden"
            onClick={() => void onToggleTile(note.id)}
          />
        ) : null}

        <DropdownMenu
          align="end"
          items={exportItems}
          trigger={
            /* t34：极窄时只留图标（aria-label 保留无障碍名称） */
            <Button variant="outline" size="sm" icon={FileDown} aria-label="导出">
              <span className="@max-[22rem]:hidden">导出</span>
            </Button>
          }
        />
      </div>

      {/* ---------------- 格式化工具栏（编辑/分栏可见） ---------------- */}
      {showEditor ? (
        <MarkdownToolbar
          state={toolbarState}
          disabled={!editorReady}
          onCommand={handleToolbarCommand}
          onUndo={handleUndo}
          onRedo={handleRedo}
        />
      ) : null}

      {/* ---------------- 编辑 / 预览 ---------------- */}
      <div ref={split.containerRef} className="flex min-h-0 flex-1">
        {showEditor ? (
          <div
            className="flex min-h-0 min-w-0 flex-col"
            style={showPreview ? { width: `${split.ratio * 100}%` } : { flex: '1 1 auto' }}
          >
            <CodeMirrorEditor
              key={note.id}
              ref={editorRef}
              noteId={note.id}
              value={draft.content}
              onChange={handleContentChange}
              onSaveRequest={handleSaveNow}
              showLineNumbers={showLineNumbers}
              autoFocus={autoFocusEditor}
              onViewReady={handleViewReady}
              onViewUpdate={handleViewUpdate}
              placeholder="开始写点什么… 支持 Markdown（表格 / 任务列表 / 代码块）"
            />
          </div>
        ) : null}

        {mode === 'split' ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整分栏比例"
            aria-valuemin={Math.round(SPLIT_MIN * 100)}
            aria-valuemax={Math.round(SPLIT_MAX * 100)}
            aria-valuenow={Math.round(split.ratio * 100)}
            tabIndex={0}
            data-zj-splitter=""
            onPointerDown={split.onPointerDown}
            onPointerMove={split.onPointerMove}
            onPointerUp={split.onPointerUp}
            onPointerCancel={split.onPointerUp}
            onKeyDown={split.onKeyDown}
            className="group flex w-3 shrink-0 cursor-col-resize items-stretch justify-center zj-focus-ring"
          >
            <span className="w-px bg-border transition-colors duration-150 ease-out group-hover:bg-accent" />
          </div>
        ) : null}

        {showPreview ? (
          <MarkdownPreview
            content={draft.content}
            className={cn('min-w-0 flex-1', showEditor ? 'border-l border-border' : null)}
          />
        ) : null}
      </div>

      {/* ---------------- 标签面板（t23） ----------------
          TagPickerDialog 是 components/ui 的通用纯展示件：它只回调新的完整名称数组，
          落库由 handleTagsChange 负责（props.onEditTags 优先，否则走 notesStore.update）。 */}
      <TagPickerDialog
        open={tagPickerOpen}
        onOpenChange={setTagPickerOpen}
        value={tags}
        tags={tagCatalog}
        context={draft.title || note.title || '未命名笔记'}
        emptyHint="输入名字回车即可新建标签"
        onChange={handleTagsChange}
      />
      <span className="sr-only" aria-live="polite" data-zj-tag-status={tagError ? 'error' : tagSaving ? 'saving' : 'idle'}>
        {tagError ? `标签保存失败：${tagError}` : tagSaving ? '标签保存中' : '标签已更新'}
      </span>
    </section>
  )
}
