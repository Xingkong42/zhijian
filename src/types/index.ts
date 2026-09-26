/**
 * 纸笺 — 全局契约类型（FROZEN CONTRACT）
 * ------------------------------------------------------------------
 * 本文件是团队唯一的事实来源（single source of truth）。
 * 任何成员都不得修改本文件的既有字段名/类型；如需扩展，必须先在
 * .agent-teams 中申请契约变更并由架构师更新本文件与 docs/ARCHITECTURE.md。
 *
 * 约定：
 *  - 所有 id 一律使用 crypto.randomUUID() 生成（string）。
 *  - 所有时间戳为毫秒级 Unix epoch（number，Date.now()）。
 *  - 所有 db 层 / store 层函数返回 Promise；失败抛出可读 Error。
 *  - 软删除：deletedAt === null 表示未删除；trash 视图 = deletedAt !== null。
 */

/* ============================ 领域模型 ============================ */

/** 便笺 */
export interface Note {
  id: string
  title: string
  content: string
  /** 所属文件夹；null = 未归类（收件箱） */
  folderId: string | null
  /** 标签名列表（标签以 name 关联，见 tagsRepo） */
  tags: string[]
  pinned: boolean
  /** 文件夹内排序位；越小越靠前 */
  order: number
  createdAt: number
  updatedAt: number
  /** 软删除时间；null = 正常 */
  deletedAt: number | null
}

/** 文件夹（支持 parentId 组成树） */
export interface Folder {
  id: string
  name: string
  parentId: string | null
  order: number
  createdAt: number
}

/** 标签 */
export interface Tag {
  id: string
  name: string
  /** 形如 '#C9A227' 的十六进制色值 */
  color: string
  createdAt: number
}

/** 全文搜索命中项 */
export interface SearchHit {
  note: Note
  /** 命中上下文片段，已用 <mark> 包裹关键词 */
  snippet: string
  /** FTS5 bm25 排序权重，越小越相关 */
  rank: number
}

/** 各视图计数（侧边栏徽标） */
export interface NoteCounts {
  all: number
  trash: number
  byFolder: Record<string, number>
  byTag: Record<string, number>
}

/** 树的通用节点（foldersRepo.tree 返回值） */
export interface FolderTreeNode extends Folder {
  children: FolderTreeNode[]
}

/* =========================== 写入参数类型 =========================== */

export type NoteCreateInput = {
  title?: string
  content?: string
  folderId?: string | null
  tags?: string[]
  pinned?: boolean
  order?: number
}

export type NoteUpdatePatch = Partial<
  Pick<Note, 'title' | 'content' | 'folderId' | 'tags' | 'pinned' | 'order' | 'deletedAt'>
>

export type FolderCreateInput = {
  name: string
  parentId?: string | null
  order?: number
}

export type TagCreateInput = {
  name: string
  color?: string
}

/** move 的目标位置描述 */
export type MoveTarget = {
  /** 目标文件夹；undefined = 不改变所属文件夹 */
  folderId?: string | null
  /** 目标下标（0-based） */
  targetIndex: number
}

/* ============================= 视图/UI ============================= */

export type UiView = 'all' | 'folder' | 'tag' | 'trash' | 'settings'

export type ThemeId = 'paper-yellow' | 'rice-white' | 'slate-blue' | 'ink-green' | 'midnight'

export type ThemeMode = 'light' | 'dark'

/** 主题 token 名（对应 src/styles/theme.css 中的 CSS 变量，去掉 -- 前缀） */
export type ThemeToken =
  | 'zj-bg'
  | 'zj-surface'
  | 'zj-surface-2'
  | 'zj-text'
  | 'zj-text-muted'
  | 'zj-accent'
  | 'zj-accent-fg'
  | 'zj-border'
  | 'zj-hover'
  | 'zj-selection'
  | 'zj-shadow'
  | 'zj-radius'

/** 单套主题（light 或 dark）的 token → 值映射 */
export type ThemeTokens = Record<ThemeToken, string>

/** 一套完整主题（含明暗两组） */
export interface ThemeDefinition {
  id: ThemeId
  /** 展示名，如「淡黄」 */
  label: string
  light: ThemeTokens
  dark: ThemeTokens
}

/* ============================ 组件 Props ============================ */

export interface TitlebarProps {
  /** 当前笔记标题，用于标题栏副标题展示 */
  title: string
  /** 已保存（无未落库改动） */
  saved: boolean
  /** 窗口是否最大化，驱动最大化/还原图标 */
  maximized: boolean
  onMinimize: () => void
  onToggleMaximize: () => void
  onClose: () => void
  /** 打开设置面板 */
  onOpenSettings: () => void
}

export interface SidebarProps {
  folders: FolderTreeNode[]
  tags: Tag[]
  counts: NoteCounts
  view: UiView
  activeFolderId: string | null
  activeTagId: string | null
  collapsed: boolean
  onToggleCollapse: () => void
  onSelectView: (view: UiView, id?: string | null) => void
  onCreateFolder: (name: string, parentId?: string | null) => void | Promise<void>
  onRenameFolder: (id: string, name: string) => void | Promise<void>
  onRemoveFolder: (id: string) => void | Promise<void>
  onCreateTag: (name: string, color?: string) => void | Promise<void>
  onRemoveTag: (id: string) => void | Promise<void>
}

export interface NoteListProps {
  notes: Note[]
  selectedId: string | null
  loading: boolean
  /** 搜索模式：列表顶部展示 query 与命中数 */
  query: string
  /** 命中片段，key = note.id（仅搜索模式下有值） */
  snippets: Record<string, string>
  onSelect: (id: string) => void
  onCreate: () => void | Promise<void>
  onTogglePin: (id: string) => void | Promise<void>
  onReorder: (id: string, targetIndex: number) => void | Promise<void>
  onMoveToFolder: (id: string, folderId: string | null) => void | Promise<void>
  onRemove: (id: string) => void | Promise<void>
  onRestore: (id: string) => void | Promise<void>
  onHardDelete: (id: string) => void | Promise<void>
}

export interface EditorPaneProps {
  note: Note | null
  mode: 'edit' | 'preview' | 'split'
  dirty: boolean
  onModeChange: (mode: 'edit' | 'preview' | 'split') => void
  onTitleChange: (title: string) => void
  onContentChange: (content: string) => void
  onSave: () => void | Promise<void>
  onExport: (format: 'markdown' | 'html' | 'txt') => void | Promise<void>
}

export interface SettingsPanelProps {
  open: boolean
  themeId: ThemeId
  mode: ThemeMode
  themeList: ThemeDefinition[]
  closeToTray: boolean
  shortcut: string
  dbPath: string
  onSetTheme: (id: ThemeId) => void
  onSetMode: (mode: ThemeMode) => void
  onToggleMode: () => void
  onToggleCloseToTray: (value: boolean) => void
  onClose: () => void
}

/* ========================== 错误与工具类型 ========================== */

/** db 层统一抛出的错误（携带可读 message 与原始 cause） */
export interface DbErrorShape {
  code: 'DB_INIT_FAILED' | 'NOT_FOUND' | 'CONSTRAINT' | 'UNKNOWN'
  message: string
  cause?: unknown
}

export type Unsubscribe = () => void

export type MaybePromise<T> = T | Promise<T>
