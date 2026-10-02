# 纸笺 — 架构与接口契约（ARCHITECTURE）

> 版本：v1.0（冻结） · 冻结人：架构师 · 冻结时机：t1 骨架任务
> 本文档是**唯一权威**的接口契约来源。任何成员在写代码前必须先读本文件；
> 如需变更契约，先在 `.agent-teams` 中申请，由架构师同意后同步修改
> 本文档 + `src/types/index.ts` + `src/db/schema.ts`，再通知全体成员。

---

## 0. 技术栈与版本基线

| 层 | 技术 | 实际锁定版本（`pnpm install` 后） |
| --- | --- | --- |
| 壳 | Tauri 2 (`tauri` crate `2`) | Rust 1.98.1 工具链 |
| 前端 | React 19 + TypeScript 5.9 | react 19.3.0 / typescript 5.9.3 |
| 构建 | Vite 7 + `@vitejs/plugin-react` | vite 7.3.6 |
| 样式 | Tailwind CSS 4 (`@tailwindcss/vite`) | tailwindcss 4.3.3 |
| 状态 | Zustand 5 | zustand 5.0.15 |
| 编辑器 | CodeMirror 6 | view 6.43.13 / state 6.7.6 / lang-markdown 6.5.2 |
| 渲染 | react-markdown 10 + remark-gfm 4 | 10.1.0 / 4.0.1 |
| 高亮 | Shiki 3 | shiki 3.23.0 |
| 图标 | lucide-react | 0.544.0 |
| 拖拽 | @dnd-kit core/sortable/modifiers | 6.3.1 / 10.0.0 / 9.0.0 |
| 存储 | SQLite via `tauri-plugin-sql` (sqlite) | plugin-sql Rust `2` / JS 2.4.1 |

---

## 1. 用户需求 → 模块归属对照

| # | 用户需求 | 实现位置（归属） | 依赖契约 |
| --- | --- | --- | --- |
| R1 | 笔记增删改查 | `src/db/notes.ts` + `src/store/notes.ts` | §4.2 §4.3 |
| R2 | Markdown 实时编辑与预览 | `src/features/editor/**` | §4.4 §5 |
| R3 | SQLite 本地存储 | `src/db/**` + `src-tauri/migrations/**` | §4.3 §7 |
| R4 | 全文搜索 | `src/db/search.ts` + `src/store/search.ts` + `src/features/sidebar/SearchBox.tsx` | §4.2 §4.3 |
| R5 | 无边框窗口 + 自定义标题栏 | `src-tauri/tauri.conf.json`（`decorations:false`）+ `src/features/titlebar/**` | §4.4 §6 |
| R6 | 笔记文件夹 | `src/db/folders.ts` + `src/features/sidebar/FolderTree.tsx` | §4.1 §4.3 |
| R7 | 笔记标签 | `src/db/tags.ts` + `src/features/sidebar/TagList.tsx` | §4.1 §4.3 |
| R8 | 拖拽排序 | `src/features/notes-list/**`（@dnd-kit）+ `notesRepo.move` | §4.3 §4.4 |
| R9 | 导出笔记 | `src/lib/export.ts`（签名已冻结）+ `src/features/editor/**` | §4.6 |
| R10 | `alt+N` 全局快捷键新建 | `src-tauri/src/shortcuts.rs` + `src/lib/hotkeys.ts` | §4.5 §9 |
| R11 | 系统托盘后台常驻 | `src-tauri/src/tray.rs` + `src-tauri/src/window.rs` | §4.5 §9 |
| R12 | 自定义主题（默认淡黄） | `src/styles/theme.css` + `src/db/schema.ts` 的 `THEMES` + `src/store/theme.ts` + `src/features/settings/**` | §4.5 |

---

## 2. 分层与依赖方向（硬性规则）

```
                    ┌──────────────────────────────┐
                    │  src/features/**  (UI 业务)   │
                    └───────────────┬──────────────┘
                                    │ 只能向下依赖
                    ┌───────────────▼──────────────┐
                    │  src/components/ui/** (纯展示)│
                    └───────────────┬──────────────┘
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
┌───────────────┐          ┌────────────────┐          ┌───────────────┐
│ src/store/**  │ ───────► │   src/db/**    │          │  src/lib/**   │
│  (Zustand)    │          │ (SQLite 访问)  │          │ (工具/桥接)   │
└───────────────┘          └───────┬────────┘          └───────┬───────┘
                                   │                           │
                    ┌──────────────▼───────────────────────────▼──────┐
                    │  src/types/index.ts（契约类型）+ src/styles/**   │
                    └─────────────────────────────────────────────────┘
```

1. **禁止反向依赖**：`db` 不得 import `store`；`store` 不得 import `features`；`components/ui` 不得 import `store`/`db`。
2. **唯一通道**：业务数据只能经 `src/db/**` 落 SQLite；UI 不直接写 SQL，也不直接调用 `Database.load`。
3. **id 生成**：全项目只用 `newId()`（`src/lib/utils.ts`，内部 `crypto.randomUUID()`），禁止自造 id。
4. **错误约定**：db 层失败一律 `throw new Error('中文可读描述：…')`；store 捕获后写入自身 `error` 字段，组件只读 `error` 展示。
5. **事件名**：Rust ↔ TS 的 event 名以 `src-tauri/src/events.rs` 为准，TS 侧镜像常量在 `src/lib/tauri.ts`。

### 运行命令

| 命令 | 用途 |
| --- | --- |
| `pnpm install` | 安装前端依赖（需要 `pnpm.onlyBuiltDependencies` 放行 esbuild/oxide） |
| `pnpm typecheck` | `tsc -b tsconfig.app.json tsconfig.node.json` |
| `pnpm vite:build` | 只跑 Vite 产物构建（Tauri 的 `beforeBuildCommand`） |
| `pnpm build` | `typecheck` + `vite build` |
| `pnpm check:rust` | `cargo check --manifest-path src-tauri/Cargo.toml` |
| `pnpm check:db` | 数据层自检：真实 SQLite 跑两份迁移 + `node:sqlite` 适配器跑全流程 repo 用例 |
| `pnpm tauri:dev` | 桌面开发（唯一能跑 SQLite / 托盘 / 全局快捷键的方式） |

---

## 3. 目录结构（冻结）

```
纸笺/
├─ index.html  vite.config.ts  tsconfig.json  tsconfig.app.json  tsconfig.node.json
├─ package.json  .npmrc  pnpm-workspace.yaml  .gitignore  README.md
├─ public/                      # 静态资源（boot-fallback.html）
├─ docs/                        # 架构与设计文档
└─ src/
   ├─ main.tsx  App.tsx  index.css  vite-env.d.ts
   ├─ types/index.ts            # ★ 全部契约类型（唯一事实来源）
   ├─ styles/theme.css          # ★ 主题 token（--zj-*）
   ├─ lib/{utils,export,hotkeys,tauri}.ts
   ├─ db/{index,schema,notes,folders,tags,search,errors}.ts
   ├─ store/{notes,ui,theme,search}.ts
   ├─ components/ui/            # shadcn/ui 风格纯展示组件
   └─ features/{titlebar,sidebar,notes-list,editor,settings}/
└─ src-tauri/
   ├─ Cargo.toml  build.rs  tauri.conf.json
   ├─ capabilities/default.json
   ├─ icons/                    # 由 `pnpm tauri icon src-tauri/icons/app-icon.svg` 生成
   ├─ migrations/               # ★ 版本化 SQL（1_init.sql …）
   └─ src/{lib,main,events,tray,shortcuts,window}.rs
```

---

## 4. 冻结契约（每条代码块即签字）

### 4.1 领域模型 `src/types/index.ts`

```ts
/** 所有 id 一律 crypto.randomUUID()；所有时间为毫秒时间戳 number */
export interface Note {
  id: string
  title: string
  content: string
  folderId: string | null   // null = 收件箱
  tags: string[]            // 标签名列表
  pinned: boolean
  order: number
  createdAt: number
  updatedAt: number
  deletedAt: number | null  // 软删除；null = 正常
}

export interface Folder {
  id: string
  name: string
  parentId: string | null
  order: number
  createdAt: number
}

export interface Tag {
  id: string
  name: string
  color: string   // '#C9A227'
  createdAt: number
}

export interface SearchHit {
  note: Note
  snippet: string  // 命中片段，命中词用 <mark> 包裹
  rank: number     // FTS5 bm25，越小越相关
}

/** 附：写入参数与辅助类型（不得重命名） */
export type NoteCreateInput = {
  title?: string; content?: string; folderId?: string | null
  tags?: string[]; pinned?: boolean; order?: number
}
export type NoteUpdatePatch = Partial<
  Pick<Note, 'title' | 'content' | 'folderId' | 'tags' | 'pinned' | 'order' | 'deletedAt'>
>
export type FolderCreateInput = { name: string; parentId?: string | null; order?: number }
export type TagCreateInput = { name: string; color?: string }
export type MoveTarget = { folderId?: string | null; targetIndex: number }
export interface NoteCounts {
  all: number
  trash: number
  byFolder: Record<string, number>
  byTag: Record<string, number>
}
export interface FolderTreeNode extends Folder { children: FolderTreeNode[] }
```

**id 生成契约**：`import { newId } from '@/lib/utils'` → 内部 `crypto.randomUUID()`。任何模块不得自行生成 id。

### 4.2 Zustand store 接口签字

```ts
// src/store/notes.ts
export interface NotesState {
  notes: Note[]
  selectedId: string | null
  loading: boolean
  error: string | null
  init: () => Promise<void>
  create: (folderId?: string | null) => Promise<Note>
  select: (id: string | null) => void
  update: (id: string, patch: NoteUpdatePatch) => Promise<void>
  remove: (id: string) => Promise<void>          // 软删除
  restore: (id: string) => Promise<void>
  move: (id: string, targetIndex: number, folderId?: string | null) => Promise<void>
  listByFolder: (folderId: string | null) => Promise<void>
  /** 入参接受标签名或 Tag.id（内部做 id→名 解析，见 §4.12） */
  listByTag: (tagName: string) => Promise<void>
  clearError: () => void
}

// src/store/search.ts
export interface SearchState {
  query: string
  results: SearchHit[]
  searching: boolean
  error: string | null
  search: (q: string) => Promise<void>
  clear: () => void
}

// src/store/theme.ts
export interface ThemeState {
  themeId: ThemeId        // 'paper-yellow' | 'rice-white' | 'slate-blue' | 'ink-green' | 'midnight'
  mode: 'light' | 'dark'
  themeList: readonly ThemeDefinition[]
  setTheme: (id: ThemeId) => void
  setMode: (mode: ThemeMode) => void
  toggleMode: () => void
  apply: () => void
}

// src/store/ui.ts
export interface UiState {
  sidebarCollapsed: boolean
  view: 'all' | 'folder' | 'tag' | 'trash' | 'settings'
  activeFolderId: string | null
  activeTagId: string | null
  settingsOpen: boolean
  toggleSidebar: () => void
  setView: (view: UiView, id?: string | null) => void
  openSettings: () => void
  closeSettings: () => void
}
```

**消费方式（FROZEN）**：每个文件默认导出 `useXxxStore`（Zustand `create`），
子组件按 selector 订阅，例如 `const notes = useNotesStore((s) => s.notes)`。
`init()` 只在 `src/main.tsx` 调用一次；`themeStore.apply()` 在 `setTheme/setMode` 内部调用。

**⚠️ 实现追加成员声明（非冻结契约 —— QA 请勿误报为缺陷）**

各 store 允许为实现契约语义而**追加**字段/入口，只要**不修改、不删除**上述冻结成员：

| store | 追加成员（实现追加，非 §4.2 契约） | 追加原因 |
| --- | --- | --- |
| `notes.ts` | `activeView: Exclude<UiView,'settings'>`、`activeFolderId: string \| null`、`activeTagId: string \| null`（**存标签名**，见 §4.12）、`knownTagNames: ReadonlySet<string>`、`refresh(): Promise<void>`；模块级 `listTrash()` / `listAll()` / `initNotes()` / `createNoteFromInput()` / `selectCurrentNote()` | 记录**当前展示集合**；否则 `move()` / `create()` / `restore()` 会把用户的「文件夹 / 标签」视图**悄悄换成「全部」**（由只读复核发现并已修复）。`knownTagNames` 服务于 §4.12 的 id→名 解析。回收站视图语义不在 §4.2 内，故以独立函数提供而非 store 方法 |
| `theme.ts` | `THEME_DEFAULTS`、localStorage 恢复辅助 | 主题持久化与首帧应用 |

**判定标准**：§4.2 的成员必须**逐字存在且签名一致**（QA 按此核对）；
额外成员属实现细节，**不构成契约偏离**。若要**删除或改变**冻结成员签名，仍须先向架构师申请。

### 4.3 db 层导出函数签名（全部 `Promise`，失败抛可读 `Error`）

```ts
// src/db/index.ts
export function initDb(): Promise<Database>          // 应用启动必须先 await
export function getDb(): Database                     // 未初始化时抛错
export function isDbReady(): boolean
export function closeDb(): Promise<void>
export const DB_URL = 'sqlite:zhijian.db'

// src/db/notes.ts
export interface NotesRepo {
  create(input?: NoteCreateInput): Promise<Note>
  update(id: string, patch: NoteUpdatePatch): Promise<Note>
  remove(id: string): Promise<string>               // 软删除，写 deletedAt
  restore(id: string): Promise<Note>
  hardDelete(id: string): Promise<string>
  get(id: string): Promise<Note | null>
  listAll(filter?: NotesListFilter): Promise<Note[]>
  listByFolder(folderId: string | null): Promise<Note[]>
  listByTag(tagName: string): Promise<Note[]>
  move(id: string, target: MoveTarget): Promise<Note>
  counts(): Promise<NoteCounts>
  setTags(id: string, tags: string[]): Promise<Note>
}
export const notesRepo: NotesRepo

// src/db/folders.ts
export interface FoldersRepo {
  create(input: FolderCreateInput): Promise<Folder>
  rename(id: string, name: string): Promise<Folder>
  remove(id: string): Promise<string>
  list(): Promise<Folder[]>
  tree(): Promise<FolderTreeNode[]>
}
export const foldersRepo: FoldersRepo

// src/db/tags.ts
export interface TagsRepo {
  create(input: TagCreateInput): Promise<Tag>
  rename(id: string, name: string): Promise<Tag>
  remove(id: string): Promise<string>
  list(): Promise<Tag[]>
  setNoteTags(noteId: string, names: string[]): Promise<string[]>
  noteIdsByTag(tagId: string): Promise<string[]>
  /* ---- t15 追加（加法式，未改动上面 6 个冻结成员） ---- */
  /** 只改 `.paper/tags.json` 的 color + 同步索引；**不重写 md、不刷新任何笔记的 `updatedAt`**。
   *  非法格式抛可读 `DbError`。 */
  updateColor(id: string, color: string): Promise<Tag>
}
export const tagsRepo: TagsRepo

// src/db/tags.ts —— 追加的工具函数（非契约方法，供共享复用）
export function normalizeTagNames(names: readonly string[]): string[]
export function normalizeTagColor(color: string | null | undefined): string
// 注意：DEFAULT_TAG_COLOR 定义并导出在 src/db/schema.ts（不是 tags.ts）

// src/db/search.ts
export interface SearchRepo { search(query: string, limit?: number): Promise<SearchHit[]> }
export const searchRepo: SearchRepo
export const DEFAULT_SEARCH_LIMIT = 50
```

`NotesListFilter`：`{ folderId?: string | null; tagName?: string; includeDeleted?: boolean; onlyDeleted?: boolean; sortBy?: 'order'|'updatedAt'|'createdAt'|'title'; direction?: 'asc'|'desc' }`。

**SQL 命名映射（FROZEN）**：`folderId→folder_id`、`order→sort_order`、`createdAt→created_at`、`updatedAt→updated_at`、`deletedAt→deleted_at`、`parentId→parent_id`。repo 层负责 camelCase ↔ snake_case 转换，组件层永远看不到 snake_case。

### 4.4 组件 props 约定

```ts
export interface TitlebarProps {
  title: string                 // 当前笔记标题
  saved: boolean                // 无未落库改动
  maximized: boolean
  onMinimize: () => void
  onToggleMaximize: () => void
  onClose: () => void
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
  query: string
  snippets: Record<string, string>       // noteId -> 命中片段（仅搜索视图）
  onSelect: (id: string) => void
  onCreate: () => void | Promise<void>
  onTogglePin: (id: string) => void | Promise<void>
  onReorder: (id: string, targetIndex: number) => void | Promise<void>
  onMoveToFolder: (id: string, folderId: string | null) => void | Promise<void>
  onRemove: (id: string) => void | Promise<void>
  onRestore: (id: string) => void | Promise<void>
  onHardDelete: (id: string) => void | Promise<void>
}
// ⚠️ 列表渲染 snippets 时：snippets[id] 是可信 HTML 片段（含 <mark>），
//    必须用 dangerouslySetInnerHTML 渲染，详见 §4.11。

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

/** 实现追加（**全部可选**）：只传 EditorPaneProps 也能正常编译与运行 */
export interface EditorPaneComponentProps extends EditorPaneProps {
  showLineNumbers?: boolean   // 默认 false（DESIGN §5：编辑器不显示行号）
  autoSaveDelayMs?: number    // 默认 500ms（契约区间 400–600ms）
  onCreateNote?: () => void   // 空状态里的「新建笔记」动作；不传则不渲染该按钮
  autoFocusEditor?: boolean   // 选中笔记后是否自动聚焦，默认 true

  /* ---- t23 追加（标签入口，全部可选；既有集成代码零改动） ---- */
  noteTags?: string[]                                   // 当前笔记标签；缺省取 note.tags
  onEditTags?: (next: string[]) => void | Promise<void>  // 缺省回退 notesStore.update(note.id, { tags })
  allTags?: readonly Tag[]                              // TagPicker 标签库；缺省首次打开时只读 tagsRepo.list()
  maxVisibleTags?: number                               // 工具条直接展示的标签数（默认 2，其余折叠为 +k）

  /* ---- t20 追加（桌面磁贴入口，全部可选；不传则该按钮/菜单项不渲染） ---- */
  onToggleTile?: (noteId: string) => void | Promise<void>  // 钉住/取消磁贴；入参是**本组件正在显示的笔记 id**
  tilePinned?: boolean                                     // 该笔记当前是否已钉成磁贴（决定图标与文案），默认 false
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
```

**编辑器着色的实现选择（记录决策，避免重复追问）**：未引入 `@lezer/highlight` ——
`HighlightStyle` 需要它的 `tags`，而该包不在依赖清单里（pnpm 严格隔离下从 `src/` 解析不到），
且该 API 要求硬编码十六进制色值，与 DESIGN「颜色只来自 token」的红线冲突。
改为**自研**：在语法树上按「节点名 → `zj-md-*` CSS 类名」打标记，样式全部用 `var(--zj-*)` 取值
⇒ 切主题零重建、零重算、零硬编码色值。实现：`src/features/editor/markdownHighlight.ts` + `editorTheme.ts`。

**已核实的订正：`<mark>` 高亮没有全局 CSS 规则。** `src/index.css` 与 `src/styles/theme.css`
中 grep `mark` = **0 命中**。真实做法是**消费端 token 类**：`src/features/notes-list/NoteCard.tsx`
用 `[&_mark]:bg-selection [&_mark]:text-text`（同样落在 `--zj-selection` 上）。
因此**不需要、也不要**再补全局 `mark` 兜底规则。

**编辑态与预览态的排版一致性（t16 订正）**：`editorTheme.ts` 的 `.zj-lp-h2` **不再固定
`fontSize: 15px`**，改为继承宿主 `text-editor`（即 `--zj-font-content`，由 t17 的运行时字号档位控制）。
这样在**非默认字号档位**下，编辑态 h2 与预览态 h2 仍像素级一致；默认档位渲染不变。
> 改动前只读文档无法发现此不一致（editor 实测 + designer 确认），故记档：
> **凡是「编辑态用 CSS 变量、预览态用固定值」的排版属性，都要走同一条 token。**

**组件文件与导出名（FROZEN）**：组件一律具名导出（不用 default），文件名即组件语义：

| 路径 | 导出 |
| --- | --- |
| `src/features/titlebar/Titlebar.tsx` | `Titlebar`（骨架期已提供 `AppTitlebar`，任务 05 迁移到 `Titlebar`） |
| `src/features/sidebar/Sidebar.tsx` | `Sidebar` |
| `src/features/notes-list/NoteList.tsx` | `NoteList` |
| `src/features/editor/EditorPane.tsx` | `EditorPane` |
| `src/features/settings/SettingsPanel.tsx` | `SettingsPanel` |

### 4.5 主题 token 表与主题清单

```ts
export type ThemeToken =
  | 'zj-bg' | 'zj-surface' | 'zj-surface-2' | 'zj-text' | 'zj-text-muted'
  | 'zj-accent' | 'zj-accent-fg' | 'zj-border' | 'zj-hover' | 'zj-selection'
  | 'zj-shadow' | 'zj-radius'

export type ThemeTokens = Record<ThemeToken, string>

export interface ThemeDefinition {
  id: ThemeId          // 'paper-yellow' | 'rice-white' | 'slate-blue' | 'ink-green' | 'midnight'
  label: string        // '淡黄（默认）' | '米白' | '灰蓝' | '墨绿' | '暗夜'
  light: ThemeTokens
  dark: ThemeTokens
}
```

- 定义位置：`src/db/schema.ts` 的 `THEMES`（**唯一值来源**），并以 `:root` + `[data-theme='<id>'].light` + `[data-theme='<id>'].dark` 三种选择器镜像到 `src/styles/theme.css`。
- 生效方式：`document.documentElement.dataset.theme = themeId` + `classList.toggle('dark', mode === 'dark')`（light 时保留显式 `light` 类）。
- 首帧兜底：`index.html` 的 `<html>` 上硬编码 `data-theme="paper-yellow" class="light"`，保证 JS 接管前不出现未着色闪烁。
- 命名空间：`--zj-*` 只用于应用主题；组件库不得引入其它颜色变量。

**淡黄（默认主题）实测值**

| token | light | dark |
| --- | --- | --- |
| `--zj-bg` | `#FDF8EC` | `#25231D` |
| `--zj-surface` | `#FFFCF3` | `#2C2A23` |
| `--zj-surface-2` | `#F7EFDD` | `#34312A` |
| `--zj-text` | `#3A3833` | `#EDE7D9` |
| `--zj-text-muted` | `#8A8578` | `#9A9384` |
| `--zj-accent` | `#C9A227` | `#D9B341` |
| `--zj-accent-fg` | `#FFFCF3` | `#25231D` |
| `--zj-border` | `#E8DFC8` | `#3E3A31` |
| `--zj-hover` | `#F3EAD5` | `#332F27` |
| `--zj-selection` | `#F0E3BC` | `#4A4128` |
| `--zj-shadow` | `0 1px 2px rgba(58,56,51,.06)` | `0 1px 2px rgba(0,0,0,.35)` |
| `--zj-radius` | `8px` | `8px` |

> 米白 / 灰蓝 / 墨绿 / 暗夜 四套的完整值见 `src/db/schema.ts` 的 `THEMES`（骨架已全量落值），
> 与 `src/styles/theme.css` 逐条对应，禁止只改一边。

### 4.6 持久化边界

| 数据 | 存放位置 | 说明 |
| --- | --- | --- |
| 笔记 / 文件夹 / 标签 / 关系 | **SQLite**（经 `src/db/**`） | 唯一业务数据落点 |
| 已应用的 SQL 迁移版本 | SQLite **两张表**：`_sqlx_migrations`（Rust/sqlx 写）+ `_zj_migrations`（前端 `initDb()` 写） | 两个独立迁移器，详见 §7 |
| 当前选中笔记、侧栏折叠、视图、弹窗开关 | **Zustand 内存**（`uiStore`） | 刷新即重置，**禁止落库** |
| 主题 id / 明暗模式 | `localStorage` **主键 `zj:theme`**（JSON `{"themeId","mode"}`） | 由 `themeStore` 读写；**兼容读取**旧键 `zhijian.theme` / `zhijian.mode`（首次读到旧键会迁移写回 `zj:theme`） |
| 关闭到托盘偏好 | `localStorage` key **`zhijian.closeToTray`** | 由 `src/lib/appPreferences.ts` 读写；**启动时下发一次给 Rust**（Rust 读不到 localStorage），见 §4.13 |
| 磁贴吸附开关 | `localStorage` key **`zhijian.tileSnap`**（默认 `true`） | t52：由 `src/lib/appPreferences.ts` 读写；**启动时下发一次给 Rust**（`tiles::TILE_SNAP`，进程内 `AtomicBool`，不落盘），见 §4.16 |
| 笔记列表默认排序 | `localStorage` key **`zhijian.defaultSort`** | 由 `src/lib/appPreferences.ts` 读写 |
| 搜索 query / 结果 | **Zustand 内存**（`searchStore`） | 派生数据，不落库 |

> ⚠️ **键前缀不统一（历史原因，已核实）**：主题用 `zj:theme`（冒号），其余偏好用 `zhijian.`（点）。
> 两者都在用且都有读取代码，**改动任一键名都会让用户已保存的偏好丢失**，因此不统一、只为它记档。
> 新增偏好请统一用 `zhijian.` 前缀（`appPreferences.ts` 的 `PREFERENCE_KEYS`）。

**硬性规则**：`src/db/**` 内禁止出现 `localStorage`；`src/store/**` 内禁止出现 `Database`/裸 SQL。

### 4.7 导出契约（`src/lib/export.ts`）

```ts
export type ExportFormat = 'markdown' | 'html' | 'txt'
export function serialize(note: Note, format: ExportFormat): string
export function exportFileName(note: Note, format: ExportFormat): string
export function toMarkdown(note: Note): string   // 含 YAML front-matter
export function toHtml(note: Note): string       // 独立可打开的完整 HTML
export function toPlainText(note: Note): string
```

### 4.8 快捷键契约

```ts
export const GLOBAL_SHORTCUTS = { newNote: 'Alt+N', toggleWindow: 'Alt+Shift+Z' } as const
export const LOCAL_SHORTCUTS = {
  search: 'Ctrl+K', save: 'Ctrl+S', togglePreview: 'Ctrl+E',
  // ⚠️ 侧栏折叠是 Ctrl+\ 而非 Ctrl+B —— 编辑器用 Mod-b 做加粗（t9 订正）
  toggleSidebar: 'Ctrl+\\', deleteNote: 'Ctrl+Delete', escape: 'Escape',
} as const
export function bindShortcuts(handlers: ShortcutHandlers): Unsubscribe
```

Rust 侧同一批字符串在 `src-tauri/src/shortcuts.rs`（`NEW_NOTE_ACCELERATOR` / `TOGGLE_WINDOW_ACCELERATOR`），
TS 侧镜像常量在 `src/lib/hotkeys.ts`，两侧必须一致。

#### 4.8.1 全局快捷键可自定义（t17 落地，FROZEN）

**动作 id（两侧镜像，不得改名）**：`newNote` / `toggleWindow` / `openSettings` / `showTile`
／**t19 增补**：`toggleTiles`（显示/隐藏全部磁贴）、`pinNote`（钉住当前笔记）。
Rust 常量 `shortcuts::ACTION_*`，TS 常量 `src/lib/tauri.ts` 的 `SHORTCUT_ACTION_IDS`。
默认只注册前两个；`openSettings` 与 `showTile` 默认**不占用**全局键位。

> **t19 修订说明（FROZEN 契约的显式增补，不是"漂移"）**：t17 时本表为 4 个动作，
> t19 为磁贴新增 2 个 ⇒ **现为 6 个**。两侧已同步（`pnpm check:contract` 双向断言守住）。
> **但设置面板 `SHORTCUT_ACTIONS` 仍是 4 项** ⇒ 这两个新动作**暂时无法在 UI 里绑定**，
> 属 t20 接线项（§4.14.6 与 `docs/RUN.md §5.3`）。**改契约必须改文档**：
> 本节若继续写"4 个动作"，下一个人很可能会**把代码改回 4 个**来"修文档"，
> 从而删掉已经工作的功能。

```ts
// IPC：原子重建绑定。返回实际生效值，供设置页如实展示
COMMANDS.syncGlobalShortcuts = 'cmd_sync_global_shortcuts'
// 入参 { bindings: Array<{ id: ShortcutActionId; accelerator: string }> }
//   · accelerator 为可读键位（如 'Alt+N'）；**空串 = 显式解绑该动作**
// 返回 { applied: Array<{id,accelerator}>, failed: Array<{id,accelerator,reason}> }
//   · **永不 reject**：输入非法或键位被占用都收集进 failed（reason 为中文）
//   · 任一输入非法 ⇒ 整体拒绝且 **不触碰** 现有绑定（避免改坏键位后连默认 Alt+N 一起丢）

// 事件：toggleWindow 被触发（显隐由 Rust 完成，此事件仅供前端反馈）
EVENTS.toggleWindowRequested = 'zhijian://toggle-window-requested'
```

> **实现要点（勿改回）**：动作注册表以 **`Shortcut` 结构体**为键（`global-hotkey` 的 `HotKey`
> 派生了 `Eq/Hash`），**不要**用 `into_string()` 字符串键 —— 插件把 Ctrl 序列化成 `control`
> 而用户输入是 `Ctrl`，字符串归一化会让自定义键位**静默不触发**。
> 回归测试：`shortcuts::tests::shortcut_canonical_key_matches_registered_one`。

### 4.9 Rust ↔ 前端事件名

```ts
// src/lib/tauri.ts 的 EVENTS（值取自 src-tauri/src/events.rs，两侧必须一致）
// ⚠️ 这里是**全量**清单（共 8 条）：`pnpm check:contract` 会做双向比对，
//    少写一条或改错一个字母都会被它拦下（本节曾只列 5 条，属文档漂移，已补齐）
export const EVENTS = {
  windowShown: 'zhijian://window-shown',
  windowHidden: 'zhijian://window-hidden',
  newNoteRequested: 'zhijian://new-note-requested',
  openSettingsRequested: 'zhijian://open-settings-requested',
  appQuitRequested: 'zhijian://app-quit-requested',
  toggleWindowRequested: 'zhijian://toggle-window-requested', // t17（仅反馈，显隐由 Rust 做）
  tilesVisibilityChanged: 'zhijian://tiles-visibility-changed', // t19，负载 { visible }
  pinCurrentNoteRequested: 'zhijian://pin-current-note-requested', // t19，负载 { noteId: null }
} as const

// invoke 命令（**全量**取自 src/lib/tauri.ts 的 COMMANDS，与 generate_handler! 逐条对应）
// window_show() -> boolean, window_hide() -> void, window_toggle() -> void,
// app_version() -> { name, version, tauri }
// cmd_set_close_to_tray({ enabled: boolean }) -> boolean   ← §4.13
// cmd_close_to_tray_enabled() -> boolean                    ← §4.13（诊断）
// cmd_sync_global_shortcuts({ bindings }) -> ShortcutSyncReport  ← §4.8.1（t17）
// cmd_toggle_tile({ noteId }) -> boolean · cmd_list_tiles() -> TileInfo[]
// cmd_set_tiles_visible({ visible }) -> boolean            ← §4.14.3（t19）

// WINDOW_HIDDEN 的事件负载（§4.13 规则 4；Rust 侧 WindowHiddenPayload，camelCase）
export type HideReason = 'close' | 'tray' | 'toggle'
export interface WindowHiddenPayload {
  reason: HideReason            // close = 用户点关闭按钮（最需要提示）
  firstCloseHide: boolean       // 首次因关闭按钮隐藏 ⇒ 前端提示一次「已最小化到系统托盘」
}
```

**Rust 侧模块内 API（FROZEN 签名，实现完善归任务 05）**

```rust
// src-tauri/src/events.rs
pub const WINDOW_SHOWN / WINDOW_HIDDEN / NEW_NOTE_REQUESTED /
            OPEN_SETTINGS_REQUESTED / APP_QUIT_REQUESTED: &str;
pub const ALL: &[&str];
pub fn log_contract();

// src-tauri/src/window.rs
pub const MAIN_WINDOW_LABEL: &str = "main";
pub const TRAY_ID: &str = "main-tray";          // 托盘 id 的单一定义处（tray.rs 引用它）
pub fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>>;
pub fn should_hide_on_close<R: Runtime>(app: &AppHandle<R>) -> bool;
pub fn is_main_visible<R: Runtime>(app: &AppHandle<R>) -> bool;
pub fn show_main<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()>;
pub fn hide_main<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()>;
pub fn toggle_main<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()>;
pub fn toggle_visible<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()>;  // toggle_main 别名
pub fn center_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()>;   // 失败静默
pub fn request_exit();                                                       // 置位后关闭拦截失效
pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>>;

// src-tauri/src/tray.rs
pub const TRAY_ID: &str = "main-tray";
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()>;
pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>>;  // setup + 日志

// src-tauri/src/shortcuts.rs
pub const NEW_NOTE_ACCELERATOR: &str = "Alt+N";
pub const TOGGLE_WINDOW_ACCELERATOR: &str = "Alt+Shift+Z";
pub fn new_note_shortcut() -> Shortcut;
pub fn toggle_window_shortcut() -> Shortcut;
pub fn all_shortcuts() -> [Shortcut; 2];
pub fn plugin<R: Runtime>() -> tauri::Plugin<R>;
pub fn register_all<R: Runtime>(app: &AppHandle<R>) -> Vec<String>;  // 幂等；返回失败项，不抛错
pub fn unregister_all<R: Runtime>(app: &AppHandle<R>);
pub fn is_registered<R: Runtime>(app: &AppHandle<R>, accelerator: &str) -> bool;
pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>>;  // 失败只告警
```

启动序列（`lib.rs::setup`，**任一步失败只打印告警，绝不阻断启动**）：

1. `#[cfg(debug_assertions)] events::log_contract()` —— 打印事件名清单，便于与前端 `EVENTS` 对账
2. `tray::init(app)` —— 托盘就绪；失败时 `window::should_hide_on_close()` 返回 false，关闭按钮退化为真正退出
3. `window::init(app)` —— 显示主窗口并 `center_window()`（多屏/远程桌面取不到显示器信息时静默跳过）
4. `shortcuts::init(app)` —— 注册 `Alt+N` / `Alt+Shift+Z`；被占用时只告警，前端本地快捷键兜底

> 所有实现模块都额外提供 `pub fn init(...)` 作为统一入口，`lib.rs` 只做编排，不重复写日志与错误处理。

### 4.10 Tauri 窗口与权限（FROZEN）

- 窗口 label：`main`；`decorations: false`；`width 1100 / height 720 / minWidth 880 / minHeight 560`。
- identifier：`com.zhijian.app`；productName：`纸笺`。
- SQL 预加载：`"plugins": { "sql": { "preload": ["sqlite:zhijian.db"] } }` —— 与 `DB_URL` 完全一致。
- 权限集中在 `src-tauri/capabilities/default.json`：`core:default` + 窗口控制 + `sql:*` + `global-shortcut:*` + `dialog:*` + `fs:*` + `opener:*`。
- **fs 范围（最小权限，导出/导入数据用）**：`appdata`（数据库）、`document`、`download`、`desktop`，**均已读写递归**。
  刻意**不授予 `fs:allow-home-write-recursive` / `fs:allow-home-read-recursive`** —— 递归放开 `$HOME`
  等价于把整个用户目录交给 webview，超出「导出/导入笔记」所需。若将来确需，须先申请并说明理由。
- 拖动窗口：容器上加 `data-tauri-drag-region`（样式在 `src/index.css` 已就绪），交互元素自动 `no-drag`。
- `core:window:allow-set-position` **不需要**授予 JS：`center_window()` 只在 Rust 侧调用。

### 4.11 数据层追加导出与全文检索契约（FROZEN）

数据层在 §4.2/§4.3 的冻结签名之外**追加**了以下导出（**均为追加，未改动任何既有签名**）。

```ts
// src/db/index.ts
export type SqlRow = Record<string, string | number | null>
export type SearchStrategy = 'fts5-trigram' | 'like'

export interface FtsDiagnostics {
  fts5Available: boolean
  trigramSupported: boolean
  sqliteVersion: string
  strategy: SearchStrategy
  reason?: string
}

/** repo 的统一读写入口：包装 @tauri-apps/plugin-sql 并按 DbError 规范抛出可读错误 */
export function dbExecute(context: string, sql: string, values?: unknown[]): Promise<QueryResult>
export function dbSelect<T>(context: string, sql: string, values?: unknown[]): Promise<T[]>

/** 能力探测结果（initDb() 完成后才有效） */
export function isFtsTrigramAvailable(): boolean
export function getSearchStrategy(): SearchStrategy
export function getFtsDiagnostics(): FtsDiagnostics

// src/db/search.ts
/** 导出以便自检脚本单测；返回可信 HTML 片段，见下方渲染契约 */
export function buildSnippet(text: string, query: string): string
export const MAX_SEARCH_LIMIT: number
```

**检索策略（FROZEN）**

| 条件 | 路径 | rank 语义 |
| --- | --- | --- |
| 查询码点长度 ≥ 3 且 trigram 可用 | FTS5 `notes_fts_trigram`（trigram tokenizer），中文子串可命中 | 真实 bm25，越小越相关 |
| 码点长度 < 3，或 trigram 不可用，或 FTS 抛错 | `LIKE '%q%' ESCAPE '\'` | 伪 rank：标题命中位置 < `1000 + 正文命中位置`（**只在同一路径内可比**） |
| 查询为空/全空白 | 直接返回 `[]`，不抛错 | — |

> v1 的 `notes_fts`（unicode61）保留但**不用于中文**：连续汉字是单个 token，
> 「我的笔记本」检索不到「笔记」（已有实测证据）。它只作为英文/分词场景的备用索引。

**`SearchHit.snippet` 渲染契约（FROZEN，UI 成员必读）**

1. `snippet` 由 `buildSnippet()` 在 **JS 侧**生成（不使用 FTS5 的 `snippet()`），两条检索路径输出格式一致。
2. 文本先做 HTML 转义（`&` `<` `>` `"`，以及正则元字符），**之后**才插入 `<mark>` 标签 ⇒ 片段是
   **受控可信 HTML**，只可能包含 `<mark>`/`</mark>`。
3. UI 必须用 `dangerouslySetInnerHTML={{ __html: snippet }}` 渲染；**禁止**再加一层转义
   （会把 `<mark>` 显示成字面量），**禁止**把 snippet 当作纯文本插入。
4. 高亮基数样式：`mark { background: var(--zj-selection); color: inherit }`（由 UI 成员落在全局样式里）。
5. 该片段源自我方数据且已转义，不需要为它放宽 CSP。

**`NoteCounts` 语义（FROZEN）**

- `byFolder` / `byTag` 的键是**文件夹 id / 标签名**，**不含**「收件箱」。
- 收件箱（`folderId === null`）计数 = `all - Σ(Object.values(byFolder))` —— 侧栏成员按此计算，
  **不要**期望 `byFolder['null']` 之类的键存在（`null` 无法作 `Record` 键）。

### 4.12 ⚠️ 标签命名双语义陷阱（t7 接线必读，FROZEN）

**问题**：`activeTagId` 这个名字在两个 store 里指代**不同的东西**：

| 位置 | 存的是什么 | 说明 |
| --- | --- | --- |
| `UiState.activeTagId` | **`Tag.id`**（uuid） | 侧栏的导航状态 |
| `SidebarProps.onSelectView('tag', id)` 的 `id` | **`Tag.id`**（uuid） | 侧栏回调约定 |
| `NotesState.activeTagId` | **标签名**（`tag.name`） | 因为 `listByTag(tagName)` 按**名字**过滤 |

**为什么危险**：`notesRepo.listByTag()` 的 SQL 是 `WHERE tags.name = ?`。
若把侧栏的 `Tag.id`（uuid）直接塞进 `listByTag`，查询会去匹配 `tags.name = '<uuid>'`
⇒ **恒空列表、且完全静默**（不报错、不进 `error`，只是标签视图永远没有笔记）。
这类故障在集成期极难定位，因此在此显式标注。

**接线裁定（二选一，推荐 A）**：

- **A【推荐，已实现】store 入口做 id→名 容错解析。**
  `notesStore.listByTag()` **同时接受标签名与 `Tag.id`**：先按名字判定（命中缓存零额外查询），
  未命中则查一次 `tagsRepo.list()`，既按 `name` 也按 `id` 匹配，成功后把
  `NotesState.activeTagId` **归一化为标签名**。两级都命中不了时原样传下去（repo 返回空列表，
  **不制造假结果**）。
  ⇒ **接线成员可以照原样把 `tag.id` 传进 `listByTag`，不会静默失败。**
- **B（备选）统一传 `tag.name`。** 若选择 B，则 `NotesState.activeTagId` 与
  `UiState.activeTagId` 语义依旧不同，**必须在接线处显式做 `tagList.find(t => t.id === id)?.name` 映射**。

**无论选哪种，接线时必须保证**：`NotesState.activeTagId` 最终只存放**标签名**。
若将来要统一两个 store 的语义，须走契约变更流程（改动 `UiState` / `SidebarProps` 属冻结签名）。

> 相关实现与验证：`src/store/notes.ts::resolveTagName()`；t11 的验证脚本对
> 「按名调用」「按 id 调用」「无效入参」三种情况都做了断言，并额外用**突变测试**证明
> 去掉解析后「按 id 调用」确实会得空列表。

### 4.13「关闭窗口时隐藏到托盘」偏好：契约与实现（FROZEN，t12 已落地）

**背景（为什么必须认真做这个开关）**：
偏好持久化在 `localStorage` key `zhijian.closeToTray`（`src/lib/appPreferences.ts`），
而 **Rust 读不到 WebView 的 localStorage**。t12 之前的实现只按「托盘是否存在」决策，
于是：托盘存在时**关闭按钮永远无法退出应用**。若托盘图标被 Windows「隐藏的图标」
折叠、或用户根本没意识到要找托盘，用户会认为**关不掉这个应用**（只能任务管理器杀进程）。
captain 裁定：**保留该开关并让它严格生效**（不移除、不禁用）——
「能退出」是比「能常驻」更硬的约束，而用户需求又要托盘常驻，所以两者都给：
**默认常驻 + 开关可控**。

**四条硬性规则（不得简化）**

| # | 规则 | 实现位置 |
| --- | --- | --- |
| 1 | 真要隐藏时**必须 emit `WINDOW_HIDDEN`** | `window::hide_main()` 内 emit |
| 2 | 偏好为 `false` 时关闭必须**真正退出**，不得被 `CloseRequested` 拦下 | `lib.rs::on_window_event` 不拦截 |
| 3 | **托盘缺失时永不隐藏**（「用户永远能退出」的最后保障） | `should_hide_on_close()` 第 3 个条件 |
| 4 | 隐藏必须给用户**可见反馈**（只隐藏无反馈，用户依然困惑） | 事件负载带 `reason` + `firstCloseHide`，前端提示归 t13 |

**接口（FROZEN）**

```ts
// 命令名取自 src/lib/tauri.ts 的 COMMANDS（与 src-tauri/src/window.rs 的 generate_handler! 一致）
COMMANDS.setCloseToTray     = 'cmd_set_close_to_tray'      // ({ enabled: boolean }) -> boolean
COMMANDS.closeToTrayEnabled = 'cmd_close_to_tray_enabled'  // () -> boolean（诊断/对账）

// 事件负载：WINDOW_HIDDEN（Rust 侧 WindowHiddenPayload，serde camelCase）
export type HideReason = 'close' | 'tray' | 'toggle'
export interface WindowHiddenPayload {
  reason: HideReason
  firstCloseHide: boolean   // 首次因「关闭按钮」隐藏 ⇒ 前端提示一次「已最小化到系统托盘」
}
```

**前端调用约定（t13 必守，两条都做）**

1. **应用启动时同步一次**：`setCloseToTray(readCloseToTray())`
   —— Rust 读不到 localStorage，localStorage 是唯一持久化来源，必须由前端主动下发；
   否则重启后偏好回落到 Rust 默认值 `true`。
2. **开关变更时立即下发**：`writeCloseToTray(v)` **且** `setCloseToTray(v)`（两者都要）。
3. 提示：`onWindowHidden(({ reason, firstCloseHide }) => ...)`，
   **建议只在 `reason === 'close' && firstCloseHide` 时**弹一次 Toast，避免每次关闭都打扰。

**为什么不做 Rust 侧落盘（决策理由）**：前端 localStorage 已持久化该偏好且启动时会重新下发；
若 Rust 再落一份 JSON 到 app config dir，就会产生**两个可能不一致的真相源**，
需要额外的同步与冲突处理。当前方案下 Rust 只持有**进程内** `AtomicBool`（默认 `true`），
真相源唯一且启动即对齐。

**关键实现细节（避免后人踩坑）**

- `should_hide_on_close()` = `!is_explicit_quit() && close_to_tray_preference() && 托盘存在`。
- `hide_main(app, reason)` 现在**带第二个参数** `HideReason`；调用方：`lib.rs` 关闭拦截传 `Close`，
  `tray.rs` 菜单「隐藏到托盘」传 `Tray`，`toggle_main` 传 `Toggle`。
- `hide_main` **不再从 window 取 app handle**，改为接收 `AppHandle`，
  因此即使窗口此刻已不可见/被销毁，事件仍能正常 emit（t13 的提示不会因窗口状态丢失）。
- ⚠️ **`clear_explicit_quit()` 存在的理由**：`EXPLICIT_QUIT` 若只置位不复位就是**不可逆闩锁** ——
  用户点过一次托盘「退出」、或关过一次开关之后，即使重新打开「关闭到托盘」，
  关闭按钮也**再也不会隐藏**。关闭被放行时必须复位（见 `lib.rs` 的 else 分支）。
  已有回归测试 `window::tests::clear_explicit_quit_resets_latch` 守住这条。
- 规则 3 的托盘检查放在**条件最后**：托盘缺失时无论偏好如何都不隐藏，保证用户永远能退出。

> 历史提醒：t12 之前 `SettingsPanel.tsx` 用 `CLOSE_TO_TRAY_TOGGLE_ENABLED = false`
> 把该开关**置灰**并说明「暂未生效」（system 的临时缓解，处置正确）。
> t12 已落地接口，**t13 只需把该常量改回 `true`** 并接上上面三条调用约定即可。

---

## 5. 文件归属表（**最终版**，避免并行写冲突）

> 本表由 captain 于集成准备期裁定并冻结。`src/store/**` 的归属按 captain 裁定拆分到各 owner，
> 不再有「临时接管」表述。
>
> **t7 收尾确认**：`src/App.tsx` / `src/main.tsx` / `package.json` / `docs/**` 由架构师总装完成；
> 集成期的两处归属微调已生效 —— `src-tauri/src/window.rs` 归架构师（§4.13 决策在
> `lib.rs` + `window.rs` 内闭环），`tray.rs` / `shortcuts.rs` 仍归 system。

| 归属（角色 / 任务） | 拥有路径（**独占写权限**） |
| --- | --- |
| **架构师** | `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`.npmrc`、`.gitignore`、`index.html`、`vite.config.ts`、`tsconfig*.json`、`README.md`、`docs/**`、`public/**`、`src/main.tsx`、`src/App.tsx`、`src/index.css`、`src/vite-env.d.ts`、`src/types/index.ts`、`src/styles/theme.css`、`src/lib/{utils,export,hotkeys,tauri}.ts`、**`src/store/notes.ts`**、`src/db/{schema.ts,index.ts,errors.ts}`、`src/components/ui/index.ts`、`src-tauri/{Cargo.toml,build.rs,tauri.conf.json}`、`src-tauri/capabilities/**`、`src-tauri/icons/**`、`src-tauri/migrations/**`、`src-tauri/src/{lib.rs,main.rs,events.rs}`、**`src-tauri/src/window.rs`**（t12 起：§4.13 的关闭到托盘决策在 `lib.rs` + `window.rs` 内闭环） |
| **db 成员** | `src/db/{notes.ts,folders.ts,tags.ts,search.ts}`、`src/db/__checks__/**`（仅替换/新增实现体，**§4.3 与 §4.11 的签名不得改**）；新增迁移只能**追加** `src-tauri/migrations/2_*.sql` 并同步告知架构师（是否登记进 Rust 由架构师决定，见 §7） |
| **store 成员（search 部分）** | **`src/store/search.ts`**（captain 裁定指派；`searchRepo` 作者优先，见下方「未决事项」） |
| **t2 / designer** | `src/store/theme.ts`（已是真实 store，无需再动） |
| **t6 / system** | `src/store/ui.ts`（已是真实 store，无需再动）、`src/features/settings/**`、`src/lib/appPreferences.ts`、`src/features/titlebar/**`、`src-tauri/src/{tray.rs,shortcuts.rs}` |
| **UI 组件成员（t4）** | `src/components/ui/**`（`index.ts` 保留，其余文件自建） |
| **侧栏成员（t5）** | `src/features/sidebar/**` |
| **列表成员** | `src/features/notes-list/**` |
| **编辑器成员** | `src/features/editor/**` |
| **集成成员（t7）** | `src/features/**/index.ts` 汇总文件、`src/App.tsx` 的最终接线（架构师在 t7 窗口内协同） |

### 未决事项（captain 待裁定，不影响并行开发）

- `src/store/search.ts` 仍为 t1 骨架占位（`useSearchStore(): never`）。captain 已裁定指派给 db/search 作者，
  但该成员在 t3 已 completed、处于 idle，按团队规则不能自行认领他人任务 —— **需要一张新任务**才能落地。
- 影响面（已评估为「可编译但功能缺失」）：`src/features/sidebar/SearchBox.tsx` 只 `import type`，
  把 `search` 当**可选 prop**，不传时退化为纯输入框 ⇒ **搜索功能点了没反应，但不报错、不阻塞构建**。
  `NoteListProps.snippets` 也因此暂时无人喂数据 ⇒ 需求 R4（全文搜索）**尚未闭环**。
- 数据层（`searchRepo` / `buildSnippet` / 双路径检索）已 54 项自检全绿，只差 store 这一层接线。

**冲突处理**：任何需要修改他人拥有文件的改动，必须先在 `.agent-teams` 中向架构师申请，
由架构师修改或明确授权；**禁止**在自己的任务里顺手改他人文件。
在 t4/t5/t6 活跃写入期间，**集成类修正一律留到 t7 集成窗口统一处理** —— 并行期不要试图
「顺手修好」别人的编译错误，否则会与对方的中间态并发写冲突，制造更难查的故障。

---

## 6. 依赖说明与替代记录

### 6.1 依赖清单核对（需求 → 实际包名）

| 需求写法 | 实际安装 | 说明 |
| --- | --- | --- |
| `@tauri-apps/api` | `@tauri-apps/api` 2.11.1 | ✅ |
| `@tauri-apps/cli` (dev) | `@tauri-apps/cli` 2.11.5 | ✅ |
| `zustand` | `zustand` 5.0.15 | ✅ |
| `@codemirror/state\|view\|commands\|language\|lang-markdown` | 同名前缀 `@codemirror/*` | ✅ 五个都在，包名与需求一致 |
| `react-markdown` + `remark-gfm` | 10.1.0 / 4.0.1 | ✅ |
| `shiki` | 3.23.0 | ✅（4.x 已发布，本项目锁 3.x 以匹配 API 稳定性） |
| `lucide-react` | 0.544.0 | ✅ |
| `@tauri-apps/plugin-sql\|plugin-global-shortcut\|plugin-dialog\|plugin-fs\|plugin-opener` | 2.4.1 / 2.3.2 / 2.7.3 / 2.5.2 / 2.5.5 | ✅ 五个都在 |
| `tailwindcss@4` + `@tailwindcss/vite` | 4.3.3 | ✅ 注意 Tailwind 4 无 `tailwind.config.js`，配置写在 CSS（`@theme`）里 |
| `clsx` / `tailwind-merge` / `class-variance-authority` | 2.1.1 / 3.7.0 / 0.7.1 | ✅ |
| `@dnd-kit/core\|sortable\|modifiers` | 6.3.1 / 10.0.0 / 9.0.0 | ✅ |
| `shadcn/ui` | **不通过 npm 安装** | 替代方案：Tailwind 4 + CVA + `cn()` 手写同等组件，放 `src/components/ui/`（Tailwind 4 与 shadcn CLI 的 `components.json` 兼容但当前无网络化 CLI 依赖） |

**需要的额外依赖（原始需求未列，但必需）**：`@types/node`（dev，供 `vite.config.ts` 使用 `node:path`）。
**未安装**：`shadcn` CLI（非运行时依赖，按需临时 `pnpm dlx shadcn@latest` 即可）。

### 6.2 pnpm 构建脚本放行

pnpm 11 默认拦截依赖的安装脚本，esbuild / @tailwindcss/oxide / lightningcss 的原生二进制因此无法下载。
已在 **`pnpm-workspace.yaml`**（pnpm 11 起该设置的新归所，`package.json` 的 `pnpm` 字段已被忽略）声明：

```yaml
allowBuilds:
  esbuild: true
  '@tailwindcss/oxide': true
  lightningcss: true
```

`.npmrc` 额外设置了 `store-dir=F:/.pnpm-store`（跨盘硬链接失败时回退拷贝）与 `strict-peer-dependencies=false`。
**新成员首次克隆后只需 `pnpm install`，不需要再 `pnpm approve-builds`。**

### 6.3 已知环境风险

- `tauri-plugin-sql` 的 SQLite 驱动为 Rust 编译产物，首次 `cargo check` 需要 5–15 分钟且依赖网络拉取 crates.io。
- `capabilities/default.json` 中的 `sql:default` 等权限标识由 `tauri-build` 在编译期校验；
  若某条权限名在当前插件版本中不存在，`cargo check` 会给出 `unknown permission` 报错并列出候选项 ——
  按提示改为等价权限即可（**不要删除整个插件权限组**）。
- 托盘初始化失败不阻断启动：`lib.rs` 打印告警并继续；此时关闭按钮会真正退出（`window::should_hide_on_close`）。

---

## 7. SQLite 迁移约定

> **重要（2026-09 实测订正）**：本项目存在**两个互相独立的迁移器**，各自记版本，不要混为一谈。

| 迁移器 | 触发时机 | 版本表 | 执行内容 | 失败行为 |
| --- | --- | --- | --- | --- |
| **Rust / sqlx** | `tauri-plugin-sql` 的 `Database.load()`（前端首次连接即触发） | `_sqlx_migrations`（sqlx 自建，含 `checksum`/`success`） | 仅 `lib.rs::MIGRATION_SOURCES` 登记的文件（当前**只有 v1**） | **整库打不开**（`pool.migrate()` 出错即连接失败） |
| **前端 `initDb()`** | 应用启动 `main.tsx` 的 `await initDb()` | `_zj_migrations`（前端自建 `version/applied_at`） | `src/db/schema.ts::SCHEMA_MIGRATIONS`（v1 + 可选 v2） | 抛可读 `Error`，由 `main.tsx` 捕获后展示 |

### 规则

1. 迁移文件：`src-tauri/migrations/<version>_<snake_name>.sql`，版本号唯一、严格递增。
2. **Rust 侧登记**：在 `src-tauri/src/lib.rs` 的 `MIGRATION_SOURCES` 里加 `(version, name, include_str!(...))`。
   登记前必须自行保证该迁移在任何运行环境都不会失败（sqlx 没有「失败就跳过」的余地）。
3. **前端侧登记**：在 `src/db/schema.ts` 的 `SCHEMA_MIGRATIONS` 里追加 `{ version, statements, optional? }`。
   `optional: true` 的迁移由 `initDb()` 先探测能力再执行；探测或执行失败**不写版本号**（下次启动自动重试），
   并只降级相关功能，不阻断启动。
4. **`1_init.sql` 被两侧同时执行**（Rust v1 + 前端 v1）。它必须保持**完全幂等**
   （`CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS`、`INSERT OR REPLACE`）。前端追加 v2 之类的新表时，
   只要新对象不在 v1 的 SQL 文本里，sqlx 的校验不受影响。
5. ⚠️ **已登记进 Rust 的迁移文件永久冻结 —— 连空白字符都不能改。** sqlx 会记录文件内容的
   `checksum`，一旦已应用的迁移文件被改动，下次启动 `pool.migrate()` 直接报 checksum mismatch，
   **整个数据库无法打开**（用户数据不丢，但应用起不来，需手工删 `_sqlx_migrations` 对应行）。
   要改 v1 的 schema，只能新增 `2_*.sql`（前端侧）或新的 Rust 侧迁移。
6. 时间戳统一 `INTEGER`（毫秒），id 统一 `TEXT`（`crypto.randomUUID()`）。
7. 校验命令：`pnpm check:db`（即 `node src/db/__checks__/run-checks.mjs`）。

### 为什么可选迁移只走前端

`2_fts_trigram.sql` 使用 FTS5 `trigram` tokenizer（中文子串检索用），需要 SQLite ≥ 3.34.0
（本项目 bundled 为 3.46.0，实际可用）。但 sqlx 的 migrator 在 `Database.load()` 阶段
**一次性执行全部已登记迁移且无法按环境跳过**，一旦某个运行环境的 SQLite 不支持 trigram，
整个库都打不开。因此该迁移**不登记进 Rust**，改由前端 `initDb()` 探测
（`ENABLE_FTS5` + `sqlite_version() >= 3.34.0`）后再执行，失败只把检索降级为 `LIKE '%q%'`。

> 若将来要把它移回 Rust：必须先在 Rust 里做同样的能力探测（例如先 `SELECT sqlite_version()`
> 判断，再决定是否 `add_migrations`），否则会把启动绑死在特定 SQLite 版本上。

---

## 8. 验收基线（t1 交付证据）

| 命令 | 期望 | 实测 |
| --- | --- | --- |
| `pnpm install` | 退出码 0，`pnpm-lock.yaml` 生成 | ✅ exit 0（`allowBuilds` 已放行 esbuild） |
| `pnpm typecheck`（`tsc -b`） | 退出码 0，无 TS 错误 | ✅ exit 0 |
| `pnpm vite:build` | 生成 `dist/`，含 `index.html` 与 `assets/*.js\|css` | ✅ exit 0，`dist/index.html` + 5 个 chunk |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 退出码 0（首次 5–15 分钟） | ✅ exit 0，1m47s，0 warning |
| `cargo test --lib` | 单元测试通过 | ✅ 8 passed（事件名 scheme、快捷键契约与清单、托盘 id 对齐、窗口 label 对齐 tauri.conf、显式退出标志） |
| `pnpm check:db` | 数据层自检（迁移 + 全流程 repo 用例） | ✅ 54 项全通过（含 v2 trigram 迁移、中文双路径检索、`$N` 占位符契约） |
| 浏览器渲染冒烟 | 主题 token 生效、语义类正确解析 | ✅ `--zj-bg=#FDF8EC`、标题栏 36px、侧栏 `rgb(247,239,221)`；切 `midnight+dark` 得 `#16161A` |

### 契约覆盖矩阵（第 4 条逐项）

| 契约条目 | 覆盖位置 | 状态 |
| --- | --- | --- |
| §4.1 领域模型 `Note`/`Folder`/`Tag`/`SearchHit` + 写入参数类型 | `src/types/index.ts`（14 个 interface/type） | ✅ 全字段签字 |
| §4.1 id = `crypto.randomUUID()` | `src/lib/utils.ts::newId()` | ✅ 唯一入口 |
| §4.2 `notesStore`（notes/selectedId/loading/error/init/create/select/update/remove/restore/move/listByFolder/listByTag） | `src/store/notes.ts::NotesState` | ✅ 签名冻结，实现待任务 03 |
| §4.2 `searchStore`（query/results/searching/search/clear） | `src/store/search.ts::SearchState` | ✅ 同上 |
| §4.2 `themeStore`（themeId/mode/setTheme/setMode/toggleMode） | `src/store/theme.ts::ThemeState` | ✅ 同上 |
| §4.2 `uiStore`（sidebarCollapsed/view/activeFolderId/activeTagId/settingsOpen/toggleSidebar/setView） | `src/store/ui.ts::UiState` | ✅ 同上 |
| §4.3 `initDb()` | `src/db/index.ts`（含迁移执行逻辑） | ✅ 已实现 |
| §4.3 `notesRepo` 12 个方法 | `src/db/notes.ts::NotesRepo` | ✅ **已全部实现**（t3；`check:db` 全通过，现行项数见 `docs/RUN.md §2.2`） |
| §4.3 `foldersRepo` 5 个方法（create/rename/remove/list/tree） | `src/db/folders.ts::FoldersRepo` | ✅ **已全部实现** |
| §4.3 `tagsRepo` 6 个方法（含 setNoteTags / t15 追加的 updateColor） | `src/db/tags.ts::TagsRepo` | ✅ **已全部实现** |
| §4.3 `searchRepo.search(query,limit)` | `src/db/search.ts::SearchRepo` | ✅ **已全部实现**（trigram + LIKE 双路径） |
| §4.3 全部 Promise、失败抛可读 Error | 各 repo 返回类型 + `src/db/errors.ts` | ✅ |
| §4.4 五个组件 Props | `src/types/index.ts`：`TitlebarProps`/`SidebarProps`/`NoteListProps`/`EditorPaneProps`/`SettingsPanelProps` | ✅ 字段写全 |
| §4.5 12 个 `--zj-*` token | `src/db/schema.ts::ThemeToken` + `src/styles/theme.css` | ✅ |
| §4.5 5 套主题 × light/dark | `src/db/schema.ts::THEMES`（5×2×12 值已全量落值） | ✅ |
| §4.5 淡黄色值 `#FDF8EC/…/C9A227` | `THEMES[0]` + `:root` 规则 | ✅ |
| §4.6 持久化边界 | 本文档 §4.6 + 「禁止 `localStorage` in db / 禁止 `Database` in store」 | ✅ 规则冻结 |
| §4.6/§5 文件归属表 | 本文档 §5（10 个归属单元，覆盖全部路径） | ✅ |
| §4.7 导出契约 | `src/lib/export.ts`（已实现 front-matter/HTML/txt） | ✅ |
| §4.8 快捷键契约 | `src/lib/hotkeys.ts` + `src-tauri/src/shortcuts.rs` | ✅ 两侧一致，有单测 |
| §4.9 事件名与 IPC 命令 | `src-tauri/src/events.rs` + `src/lib/tauri.ts::EVENTS/COMMANDS` | ✅ 五条一一对应 |
| §4.10 窗口与权限 | `tauri.conf.json`（decorations:false, 1100×720, min 880×560）+ `capabilities/default.json` | ✅ cargo check 通过权限校验 |
| §4.11 数据层追加导出与检索契约（`dbExecute`/`dbSelect`/`isFtsTrigramAvailable`/`getSearchStrategy`/`getFtsDiagnostics`/`buildSnippet`；snippet 渲染契约；`NoteCounts` 语义） | `src/db/index.ts`、`src/db/search.ts`（数据层实现）+ 本节文档 | ✅ 追加式导出，未改动 §4.2/§4.3 冻结签名；`pnpm check:db` 54/54 |
| §7 双迁移器机制（`_sqlx_migrations` vs `_zj_migrations`、可选迁移、checksum 冻结） | 本节 §7 + `src/db/schema.ts::Migration.optional` + `src-tauri/src/lib.rs::MIGRATION_SOURCES` | ✅ 已按 sqlx/plugin 源码订正 |

> ~~说明：`src/db/notes|folders|tags|search.ts` 与 `src/store/*.ts` 在骨架期为
> **签名占位**（方法体调用 `notImplemented()` 显式抛错），实现由任务 02/03 的成员替换方法体。~~
>
> **⚠️ 已过期（t9 订正）**：骨架期的 `notImplemented()` 占位**已全部替换为实现**；
> 当前 `notImplemented()` 在 `src/**` 下**零调用点**（仅 `src/db/errors.ts` 保留函数定义，属死代码）。
> `src/store/{notes,ui,theme,search}.ts` 均为真实 zustand store。
> 该结论由 QA 的 `scripts/verify-stores-and-silent-noops.mjs` 自动核对。

---

## 4.12 存储布局：md 文件为真相源 + SQLite 可重建索引（t15 冻结）

> 变更动机（用户需求）：笔记**默认以 .md 格式**存放在「系统文档\纸笺」下，用户可以用
> VS Code 等任意编辑器直接读写。因此 **md 文件是唯一真相源**，SQLite 降级为
> 「**可随时重建的索引 / 搜索缓存**」——删掉数据库不会丢任何笔记。

### 4.12.1 根目录解析（禁止硬编码路径）

```ts
const documents = await documentDir()          // @tauri-apps/api/path
const vaultRoot = joinPath(documents, '纸笺')  // 中文系统显示为「文档」，实际是 C:\Users\<用户>\Documents
await mkdir(vaultRoot, { recursive: true })    // 不存在则创建
```

- 解析实现：`src/db/storage.ts::resolveStorage()`；应用数据目录取 `appDataDir()`（旧库备份落点）。
- **t37 追加：解析顺序（完全向后兼容）** ——
  ① 已被 `configureStorage()` 注入（自检）⇒ 用它；
  ② 读 `<appDataDir>/vault-location.json`（常量 `VAULT_LOCATION_FILE`）：内有绝对路径且目标可用 ⇒ **用它作 vault 根**；
  ③ 都没有 ⇒ 回落默认 `<documentDir>/纸笺`。
  位置文件损坏 / 目标被删或无权限 ⇒ 打 warn 并**回落默认目录，绝不让应用打不开**。
  **为什么放 appDataDir 而不是 localStorage**：§4.6 禁止 `src/db/**` 触 localStorage；
  且它**不在 vault 内**，故"更换数据目录"搬迁时不会被一起搬走/搬错。
  相关导出：`loadVaultLocation(fs, appDataDir)` / `writeVaultLocation(root)` / `vaultLocationFilePath()`。
- 自检/测试通过 `configureStorage({ fs, vaultRoot, appDataDir, legacyDbPath })` 注入
  **真实临时目录 + Node FsPort**，于是同一套 db 代码可以在纯 Node 下跑全流程。
- 文件系统访问统一走 {@link FsPort}（9 个能力：exists/mkdir/readDir/readTextFile/writeTextFile/
  rename/remove/stat/copyFile；t37 追加**可选** `readFileBytes?` 用于严格 UTF-8 校验与 sha256，
  实现不了的环境自动降级为"仅比字节数"并如实标注）：生产用 `@tauri-apps/plugin-fs`，自检用 `node:fs/promises`。

### 4.12.2 目录布局

```
<文档>/纸笺/                     ← vault 根（根目录即「收件箱」）
  ├─ 静夜思.md                   ← 一条笔记 = 一个 .md 文件
  ├─ 诗词/                        ← 文件夹 = 子目录（可嵌套）
  │   ├─ 水调歌头.md
  │   └─ 唐诗/
  ├─ .trash/                      ← 软删除（文件保留，不删内容）
  └─ .paper/                      ← 元数据（普通文件，保证「可重建」）
      ├─ tags.json                ← 标签 id / 颜色 / 创建时间 / 是否显式声明
      ├─ folders.json             ← 目录 → 稳定 folder id / 创建时间
      ├─ trash.json               ← 回收站文件 → 原始文件夹 + 删除时间
      ├─ migrated.json            ← 迁移记录（幂等依据）
      └─ migration.log            ← 迁移日志
```

> **标签颜色的真相源是 `.paper/tags.json`**（t26 登记）：
> `tagsRepo.updateColor(id, color)` 只改写这里的 `color` 并同步索引，
> **不重写任何 md、不刷新任何笔记的 `updatedAt`**（改颜色不是"编辑笔记"）。
> **索引（SQLite）里的 `color` 仅是缓存** —— 索引可随时丢弃重建，重建后颜色仍以 `tags.json` 为准。
> 非法颜色格式由 `normalizeTagColor()` 兜底/拒绝，抛可读 `DbError`。

### 4.12.3 文件名规则（`src/db/frontmatter.ts`）

| 输入 | 规则 |
| --- | --- |
| 标题 | 换行/制表符折叠为空格；去掉 `\ / : * ? " < > \|` 与控制字符；去掉首尾空白与点 |
| 长度 | 主体截断到 **80** 字符（不含 `.md`） |
| 保留名 | Windows 设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）前加 `_` |
| 空标题 | `无标题-<短id>.md`（短 id = 去非字母数字后前 6 位，保证唯一） |
| 重名 | 追加 `-2`/`-3`…（大小写不敏感比较；超 999 回落短 id） |
| 改名 | 标题变化 → 写新文件 → 再删旧文件（**先写后删**，任何时刻不丢内容） |

### 4.12.4 front-matter 规范

```markdown
---
id: 2f1c…                 # 稳定标识（缺失时由导入方补写，见 4.12.6）
title: 静夜思·李白         # 人类可读标题（与文件名同源）
tags:                     # 标签名列表；空数组写作 tags: []
  - 唐诗
pinned: false
created: 1700000001000    # 毫秒时间戳（INTEGER）
updated: 1700000002000
order: 0                  # 文件夹内排序位（越小越靠前）
---

正文 = front-matter 之后的 Markdown 原文（逐字保留，含空行）
```

序列化规则：值含 `: `、以特殊字符开头、等于 `true/false/null`、看起来像数字、
或含首尾空白/引号时用**双引号**包裹并转义 `\` 与 `"`（`encodeScalar`）。

### 4.12.5 边界情况（逐条有自检）

| 情况 | 行为 |
| --- | --- |
| **正文含 `---`** | front-matter 在「首个位于行首的 `---`」处闭合；正文里的 `---` 原样保留（`parseFrontMatter` 只在结尾标记后取正文） |
| **正文含 `:`** | 只有 front-matter 区内「首个冒号」用作键值分隔；正文完全不解析 |
| **标题含换行** | 写入时折叠为单空格（`foldTitle`）；文件名与 YAML 单行标量都无法承载换行，因此**不会还原**（有损但可预期，且自检覆盖） |
| 标题含 `"` / `:` | 双引号包裹 + 转义，解析后逐字还原 |
| 文件**没有** front-matter | 视为外部手写笔记：标题取正文首行（去 `#` 前缀），首次纳入时**补写 front-matter**（含新 id） |
| 只有开头一个 `---` | 不当作 front-matter（避免吞掉正文），整体按正文处理 |
| front-matter 有未知键 | 忽略（向前兼容）；`tags` 同时支持块列表与 `[a, b]` 行内写法 |
| 垃圾数据 | `notes.tags` JSON 损坏 → 回退空数组（索引侧）；元数据 JSON 损坏 → 回退默认值 + 告警，不阻塞启动 |

### 4.12.6 索引规则（`src/db/indexer.ts`）

「**索引可纯由文件重建**」的定义：`rebuildIndex()`（= 丢弃索引表 + 按文件重新投影）之后，
`notes` / `folders` / `tags` / `note_tags` / 两张 FTS 表的全部内容都能由
**md 文件 + `.paper/*.json`** 推导出来，不依赖任何只存在于数据库里的状态。

| 索引列 | 派生自 |
| --- | --- |
| `notes.id/title/content/tags/pinned/sort_order/created_at/updated_at` | front-matter + 正文 |
| `notes.folder_id` | 文件所在目录（vault 根 = 收件箱 = `NULL`） |
| `notes.deleted_at` | 是否在 `.trash/`（精确时间取 `.paper/trash.json`，缺失记 `1`） |
| `notes.rel_path / file_mtime / file_size` | 文件定位与**增量同步**依据 |
| `folders.id / created_at` | `.paper/folders.json`（稳定 id：目录改名不换 id） |
| `folders.path / parent_id` | 目录树 |
| `folders.sort_order` | **派生值** = 同层目录名升序下标（目录没有元数据文件） |
| `tags.*` | 笔记 front-matter 里用到的标签 **∪** `.paper/tags.json` 中 `declared: true` 的标签 |
| `note_tags` | 由 `notes.tags` 覆盖式重建 |

- **增量同步**：启动时按 `rel_path` 匹配 + `file_mtime`/`file_size` 比对，未变动的文件不读盘；
  文件新增/改名/删除都能收敛（改名时按 id 匹配改 `rel_path`，不留重复行）。
- **外部编辑可见**：改 md → 下次启动或 `rebuildIndex()` 后即可见（自检覆盖"改标题/正文/新增/删除/改名"五种）。
- **id 冲突修复**：同一 id 出现在两个文件（崩溃残留/手工复制）→ 保留 mtime 最新者，
  另一个**补写新 id**（不删用户文件）。
- 索引结构自带文件定位列（`INDEX_DDL_STATEMENTS`），**不走 Rust 的版本化迁移链**：
  索引是可丢弃的，`rebuildIndex()` 直接 DROP + CREATE，因此不需要新迁移文件、
  也不会与 sqlx 的 checksum 冻结机制冲突（见 §7）。

### 4.12.7 删除语义

| 操作 | 文件 | 元数据 | 索引 |
| --- | --- | --- | --- |
| 软删除 `remove` / `update({deletedAt})` | 移到 `.trash/`（保留原名） | `trash.json` 记原始文件夹 + 删除时间 | `deleted_at` 置值，`rel_path` 指向 `.trash/…` |
| 恢复 `restore` | 移回原文件夹（名字按标题重算，冲突自动加后缀） | 清除该条 `trash.json` 记录 | `deleted_at = NULL` |
| 彻底删除 `hardDelete` | 真正删除文件 | 清理 `trash.json` | 删除行（FTS 行由触发器清理） |

### 4.12.8 旧库迁移（无损 / 可回滚 / 幂等）

`src/db/migrate.ts::migrateLegacyToVault()`，四步：

1. **前置检查**（任一命中即跳过，绝不重复写、绝不覆盖）：
   已有 `.paper/migrated.json` → `already-migrated`；vault 里已有笔记 md → `vault-not-empty`；
   旧库没有笔记与文件夹 → `legacy-empty`。
2. **先备份**：`copyFile(旧库 → <应用数据>/zhijian.db.bak-<时间戳>)`；**备份失败立即中止**
   （错误信息明说"未对现有数据做任何改动"）。
3. **暂存区生成 + 逐条校验**：全部文件先写进 `.paper/migrate-staging-<时间戳>/`（镜像最终布局），
   再逐条回读校验 `id / 标题 / 正文 / 标签` 与"文件数 == 旧库笔记数"；此阶段任何失败 →
   删除暂存区、抛可读错误，**vault 完全没被碰过**。
4. **原子提交**：逐文件 `rename` 进最终位置（目标已存在则跳过 → 可重入），
   然后写 `tags.json`（保留旧标签 id/颜色并标记 `declared: true`）、`folders.json`（保留旧 folder id）、
   `trash.json`，最后写 `migrated.json` + `migration.log`。

语义：**每个文件要么完整落地、要么完全不动**；中途崩溃时下次启动续跑（已落地文件被跳过），
不会出现残缺笔记。**幂等**：第二次调用返回 `skipped(already-migrated)` 且文件集合逐字节不变。

### 4.12.9 相对原契约的取舍（已文档化，避免下游误解）

| # | 取舍 | 原因 |
| --- | --- | --- |
| 1 | `Folder.order` 是**派生值**（同层目录名升序）；`FolderCreateInput.order` 被接受但忽略 | 目录没有元数据文件，派生才能保证"索引可重建" |
| 2 | `Note.deletedAt` 的精确值来自 `.paper/trash.json`（文件里不写删除时间） | front-matter 规范只描述"活着的笔记"；手工放进 `.trash/` 的文件恢复时间为 `1` |
| 3 | 新增 `.paper/` 元数据目录与 4 个 JSON 文件 | 标签颜色/文件夹 id/删除时间/迁移记录需要持久化，且必须是 vault 内文件才能"可重建" |
| 4 | 未声明的标签在**最后一个使用者消失后**会从索引消失（元数据仍保留 id/颜色） | 「标签来自 front-matter；只要还有笔记在用就存在」；`tagsRepo.create` 的标签标记 `declared` 后长期存在 |
| 5 | `foldersRepo.remove` 先**把子树内笔记移回收件箱**再删目录 | 「不因删目录丢笔记」优先于目录清理 |
| 6 | `move` 会重写**邻居笔记的 front-matter `order`**（但不改它们的 `updated`） | 排序位必须落盘才能在重建索引后保持；`updated` 不变则"最近更新"视图不被拖拽污染 |
| 7 | 索引层 DDL（`INDEX_DDL_STATEMENTS`）只在 TS 侧使用，不进 `src-tauri/migrations/**` | 索引可丢弃 → DROP+CREATE 比 ALTER/新迁移文件更安全（且不与 sqlx checksum 冲突） |

> #### ✅ captain 裁定（已生效，请勿重复质疑）
>
> captain 已**逐条审阅上表 7 条设计取舍，结论：全部接受，无需改契约**。
>
> 因此：**`src/types/index.ts` 与 §4.3 的冻结签名不为这 7 条做任何变更**。
> 任何成员若认为其中某条需要调整，**不要**直接改契约或实现 —— 应先向 captain 提出并附**新证据**
> （例如新发现的正确性/数据风险），由 captain 重新裁定。
> 记此条的目的：**避免后续成员把已裁定过的事项再翻一遍**。

### 4.12.10 上层兼容承诺

- `notesRepo` / `foldersRepo` / `tagsRepo` / `searchRepo` 的**方法名与参数语义全部不变**
  （§4.3 冻结签名逐字保留），store / UI 无需改动；
- `src/db/index.ts` 仅**追加**导出：`rebuildIndex()`、`syncIndex({full?})`、`migrateLegacyToVault()`、
  `configureStorage()`、`getStorage()`、`getVaultRoot()`、`getStorageInfo()`；
- `getVaultRoot()` / `getStorageInfo()` 供设置面板展示「数据位置」与接「重建索引」按钮。

### 4.12.11 自检（两条命令，全部真实文件系统 + 真实 SQLite）

| 命令 | 覆盖 |
| --- | --- |
| `pnpm check:db`（`src/db/__checks__/run-checks.mjs`） | 63 项：迁移文件解析/幂等、双源一致性、initDb、四个仓储全流程、拖拽排序、中文检索两条路径、占位符契约、索引层 DDL |
| `pnpm check:fs`（`src/db/__checks__/fs-store-checks.mjs`） | 37 项：往返一致（含 `---`/`:`/换行标题）、文件名规则、改名不丢内容、回收站往返、索引重建逐条一致、外部编辑可见、目录语义、标签派生、**旧库迁移逐条核对 + 备份 + 幂等 + 失败安全** |
| `pnpm check:guards`（`guard-checks.mjs`，t28） | 7 项：**防污染护栏自身的回归测试** —— 唯一临时根、`FsPort` 越界拦截、janitor 既删陈旧又不误删在用 |
| `pnpm check:tile`（`tile-integration-probe.mjs`，t20/captain） | 7 项：**磁贴静默失效探针** —— 三张命令表逐字一致 + `tiles.json` 最小授权（详见 §4.14.9） |
| `pnpm check:contract`（`src/lib/__checks__/contract-checks.mjs`，架构师） | 7 项 + 1 告警：**前后端契约表机器对账** —— `EVENTS`↔`events.rs`（含 `ALL` 自洽）、`SHORTCUT_ACTION_IDS`↔`SUPPORTED_ACTION_IDS`、`COMMANDS`↔`generate_handler!`（**全部双向**）+ `cmd_` 命名纪律；设置面板动作覆盖度只告警 |
| `pnpm check:settings`（`settings/__checks__/run-all.mjs`） | 单条入口：设置与系统集成自检 **59/59** + 上面的磁贴探针 **7/7**，一次跑完、只看 exit code |
| `pnpm check:editor` / `pnpm check:tiles`（t24） | 编辑器 **96/96**（含静默 catch 审计）、磁贴前端 **54/54**（含与 Rust 的跨界联动断言） |
| `cargo test --lib` | Rust 单测 **26 passed**（含 `tiles::tests::*` 7 条：label 往返、非磁贴 label 拒绝、默认层叠、几何 JSON 往返、损坏/缺失回落、几何路径必须绝对） |
| `guard-checks` 内的三条**防回归断言**（t28） | ① 临时根已清理；② `FsPort` 零越界（拒绝相对路径 / 路径逃逸）；③ **仓库根未新增文件** |

> **护栏的由来**：曾观察到并行期仓库根出现一个 **0 字节的 `x`** 文件。
> data 的取证证明 **`new DatabaseSync('x')`（相对路径）会静默在当前工作目录生成一个恰好 0 字节、名为 `x` 的文件** —— 与现场指纹一致。
> ⇒ **「路径基准一丢就静默写进 CWD」是全仓性风险**。生产侧已在 `configureStorage` / `vaultPath` / `vaultJoin` / `resolveStorage` 接入 `assertAbsolutePath`；
> **任何新增的路径拼接都必须同样先断言绝对路径**（t19 的磁贴几何落盘 `app_data_dir()/tiles.json` 已按此加了 `absolute_geometry_path` 守卫，见 §4.14.4）。

> ⚠️ 上表项数是**会变的**（各 owner 持续追加断言）；**验收只看 exit code 是否为 0**，
> 现行项数见 `docs/RUN.md §2.2`。

> **`check:contract` 的两条设计纪律（t19 立）**：
> ① **双向断言**：只做"TS 里的项都在 Rust 里"是**单向包含**，只能发现一半漂移
> （Rust 注册了但前端没登记同样会让功能静默不可达）—— 两侧都必须互相包含。
> ② **检查必须能被证明会失败**：该脚本支持 `ZJ_CONTRACT_ROOT=<临时镜像根>` 覆盖仓库根，
> 因此可以在**不碰真实仓库**的前提下做变异测试。t19 实测的四种变异**全部被抓到**：
> 事件名 typo（Rust 侧少一个 `n`）、TS 多写一个动作 id、命令名回退成历史错误值 `tile_toggle`、
> Rust 注册了 TS 未登记的命令；还原后回到 exit 0。

---

## 4.14 桌面便签磁贴（t19 冻结）

把一条笔记钉成**独立的无边框置顶小窗**。Rust 侧实现见 `src-tauri/src/tiles.rs`；
磁贴里渲染什么由前端负责（`src/features/tiles/TileApp.tsx`，t24 提供）。

### 4.14.1 URL 协议（FROZEN）

磁贴窗口加载**与主窗口同一份前端**，URL 形如：

| 环境 | URL |
| --- | --- |
| 开发（`pnpm tauri:dev`） | `http://localhost:1420/?tile=<noteId>` |
| 生产（打包后） | `tauri://localhost/?tile=<noteId>` |

前端用 `readTileNoteId(location.search)` 解析出 `noteId` 并只渲染那条笔记。

> **实现要点（勿改）**：Rust 侧**显式拼绝对 URL** 后走 `WebviewUrl::External`，
> **不要**改成 `WebviewUrl::App("index.html?tile=…")` —— 后者要把"路径 + 查询串"交给内部拼接，
> 查询串是否保留依赖实现细节；显式拼串才能保证 `?tile=` 一定到达前端。

### 4.14.2 窗口 label 约定（FROZEN）

label = `tile-<noteId>`（前缀常量 `tiles::TILE_LABEL_PREFIX`）。
**"哪些窗口是磁贴"的唯一判据就是 label 前缀** —— 刻意不维护额外的活动窗口注册表，
避免出现"注册表与实际窗口不一致"的第二真相源。

### 4.14.3 IPC 命令（FROZEN）

```ts
// 命令名取自 src/lib/tauri.ts 的 COMMANDS（前端禁止硬编码字符串）
COMMANDS.toggleTile      = 'cmd_toggle_tile'        // ({ noteId: string }) -> boolean（新状态：true=已钉住）
COMMANDS.listTiles       = 'cmd_list_tiles'         // () -> TileInfo[]
COMMANDS.setTilesVisible = 'cmd_set_tiles_visible'  // ({ visible: boolean }) -> boolean

export interface TileInfo {
  noteId: string
  x: number; y: number            // 逻辑坐标（物理坐标 / scale_factor）
  width: number; height: number
  visible: boolean
}
```

统一 `cmd_` 前缀（沿用 t12 约定）。**校验**：`noteId` 为空串时 `cmd_toggle_tile` 返回可读错误。

`src/lib/tauri.ts` 同时提供薄封装（**所有 `@tauri-apps/api` 调用都必须收敛在这一个文件**，见其文件头约定）：

```ts
toggleTile(noteId: string): Promise<boolean | null>   // null = 非 Tauri 环境（浏览器 dev）
listTiles(): Promise<TileInfo[] | null>
setTilesVisible(visible: boolean): Promise<boolean | null>
onTilesVisibilityChanged(handler) / onPinCurrentNoteRequested(handler): Promise<() => void>
```

> **登记纪律**：这三条命令曾漏登记进 `COMMANDS`，而 `src/features/tiles/tileWindows.ts` 用字面量调用 —— 
> **命令名漂移因此没有任何机器化拦截**。现已补全，并由 §4.14.9 的探针把三张表绑定在一起。
> 新增任何磁贴命令时，**必须同时改**：`tiles.rs` 的 `#[tauri::command]`、`lib.rs` 的 `generate_handler!`、
> `src/lib/tauri.ts` 的 `COMMANDS`。

### 4.14.4 几何持久化（Rust 唯一权威）

| 项 | 值 |
| --- | --- |
| 位置 | `app_data_dir()/tiles.json`（与索引库同目录） |
| 结构 | `{ "version": 1, "tiles": { "<noteId>": { x, y, width, height } } }` |
| 坐标 | **逻辑坐标**（`outer_position / scale_factor`）——物理坐标跨 DPI 显示器会失真 |
| 写入时机 | 监听磁贴的 `Moved` / `Resized`；**尾沿去抖 400ms** 后落盘（拖动时高频事件不逐次写盘） |
| 容错 | 文件缺失/损坏 ⇒ 回落到空表 + 默认层叠位置，**绝不让启动失败** |

> ⚠️ **不要让前端参与几何持久化**：位置/尺寸是纯窗口层面的事实，Rust 是唯一权威
> （移动/缩放事件也只有 Rust 收得到）。前端存一份就会造成双真相源 —— 与 §4.13 对
> 「关闭到托盘」偏好的取舍同一原则。

> **前置条件（t19 复核新增）**：这条链要能跑起来，磁贴必须**真的能被拖动** ——
> 拖动走 `data-tauri-drag-region` → `plugin:window|start_dragging`，**需要
> `core:window:allow-start-dragging`**（见 §4.14.8 的修正记录）。
> 逻辑链：缺该权限 ⇒ 拖不动 ⇒ 没有 `Moved` 事件 ⇒ 下文持久化与「重启恢复位置」**全程不被触发**，
> 而表面现象只是「拖着没反应」，任何日志都不会提示权限问题。
> 落盘路径同样接 `absolute_geometry_path` 守卫（相对基准即拒绝，见 §4.12.11 的 CWD 事故机制）。

### 4.14.5 关闭 / 退出语义（FROZEN）

| 场景 | 行为 |
| --- | --- |
| 关闭单枚磁贴 | **只关那个窗口**（`CloseRequested` 对 `tile-*` **不拦截**）；几何保留在 `tiles.json`，再次钉住即恢复 |
| 主窗口隐藏到托盘 | **磁贴保留**（`window::hide_main` 只操作 label=`main`） |
| 应用真退出（托盘「退出纸笺」） | `tiles::cleanup_all()`：**先把几何落盘，再关闭全部磁贴**，不留孤儿窗口 |
| 启动 | `tiles::init()`：读 `tiles.json` → 逐条**恢复**上次钉住的磁贴（几何来自同一份文件） |

### 4.14.6 全局快捷键（走 t17 的 `cmd_sync_global_shortcuts`）

| action id | 语义 | 实现位置 |
| --- | --- | --- |
| `toggleTiles` | 显示/隐藏**全部**磁贴（Rust 直接对所有磁贴窗口生效） | `shortcuts::dispatch_action` → `tiles::set_all_visible_emit` |
| `pinNote` | 把「当前笔记」钉成磁贴 | Rust **不知道当前笔记是哪个** ⇒ 唤起主窗口并 emit `PIN_CURRENT_NOTE_REQUESTED`，由前端回填 `noteId` 后调 `cmd_toggle_tile` |
| `showTile` | 保留 id；当前语义等同 `toggleTiles` | 同上 |

两者**默认都不占用全局键位**（由用户在设置里显式开启）。

> ✅ **t20 已接线（保留原文追溯）**：设置面板 `SHORTCUT_ACTIONS` 已补到 **6** 项
> （`showTile` 标为旧动作名，语义等同 `toggleTiles`），`SHORTCUT_EVENT_BY_ACTION` /
> `dispatchShortcutEvent` 一并指向磁贴专用事件；App 层也接了 `pinCurrentNote` 处理器
> （经 `src/lib/hotkeys.ts` 的 `GlobalHotkeyActions`，用 `selectedId` 回填后调 `toggleTile`）。
> `pnpm check:contract` 的「设置面板动作覆盖度」因此由告警转绿。
>
> **订阅纪律（勿改回）**：磁贴两个事件的订阅走 `src/lib/tauri.ts` 的**封装**
> （`onPinCurrentNoteRequested` / `onTilesVisibilityChanged`），**不要在 hotkeys/App 里裸写
> `listen(EVENTS.x)`** —— t31 的 D1 静态断言要求「同一事件的 `listen()` 全仓只有 1 处」
> （封装文件里那一处占用名额），裸写会被判为重复订阅（那正是「一次按键触发两次动作」的形态）。
>
> <details><summary>原缺口记录（t19 核对时）</summary>
>
> Rust 的 `SUPPORTED_ACTION_IDS` 有 6 个 id，但设置面板的 `SHORTCUT_ACTIONS` 只有 **4** 项
> ⇒ `toggleTiles` / `pinNote` **在 UI 里没有入口、用户无法绑定**，这两个快捷键路径当时不可达。
> **Rust 侧不算缺口**：`cmd_sync_global_shortcuts` 只处理传进来的绑定，缺项＝该动作保持未绑定
> （不报错、不顶掉其它绑定）；`SHORTCUT_ACTION_IDS`（`src/lib/tauri.ts`）已按 6 个同步登记。
> </details>

### 4.14.7 事件（按动作区分，不做 `{id}` 泛化）

```ts
EVENTS.tilesVisibilityChanged  = 'zhijian://tiles-visibility-changed'   // 负载 { visible: boolean }
EVENTS.pinCurrentNoteRequested = 'zhijian://pin-current-note-requested' // 负载 { noteId: null }（前端回填 selectedId）
```

> 两条事件都已同时登记进 `src-tauri/src/events.rs` 的 `ALL` 与 `src/lib/tauri.ts` 的 `EVENTS`
> （Rust 侧单测断言 `ALL.len() == 8` 且无重复）。
> ⚠️ `PIN_CURRENT_NOTE_REQUESTED` 的负载**不是** `{}`：`Option<String>` 未加
> `skip_serializing_if`，serde 恒输出 `{"noteId":null}`；TS 侧 `PinCurrentNotePayload`
> 声明为 `{ noteId: string | null }`，两种读法都容错（`shortcuts.rs` 的注释已同步更正）。

### 4.14.8 权限（刻意极小，且按「真实调用」逐条授权）

磁贴窗口**不复用**主窗口的 `default` 能力。独立能力文件
`src-tauri/capabilities/tiles.json`，`windows: ["tile-*"]`（Tauri 支持 glob，故一条覆盖全部磁贴）：

| 权限 | 为什么必须 |
| --- | --- |
| `core:default` | 基础运行时（事件、窗口只读查询等） |
| `core:window:allow-close` | 磁贴右上角 × 走 `getCurrentWindow().close()`；`core:window:default` **不含** `allow-close` |
| `core:window:allow-show` / `allow-hide` / `allow-set-focus` / `allow-is-visible` | `toggleTiles` / `showTile` 的全员显隐与焦点；`allow-is-visible` 是前端判断当前状态所必需的**读** |
| `core:window:allow-start-dragging` | **拖动头必需**（见下，本轮复核修正） |
| `core:window:deny-internal-toggle-maximize` | **防御纵深**（**不充分** —— t21 实证双击仍会最大化，见下 §修正记录 ③）；真正的护栏是 Rust 侧 `maximizable(false)` + 几何闸门 |
| `sql:allow-load` / `allow-select` / `allow-execute` | 磁贴**可编辑且自动保存**（`initDb()` + `notesRepo.get/update`），按真实调用最小化 —— **不给** `sql:default` 全量、更不是「完全不给」 |
| **刻意不给** `fs` / `dialog` / `opener` / `global-shortcut` | 磁贴不做导出、不做文件对话框、不注册全局键位 |

> #### 修正记录（t19 复核，两条结论被**主源码**推翻）
>
> **① `data-tauri-drag-region` 不是「免权限的原生区」**（原文称「无需 JS 权限」是错的）。
> 证据：`tauri-2.11.6/src/window/scripts/drag.js:104` 在 `mousedown` 命中拖拽区时执行
> `window.__TAURI_INTERNALS__.invoke('plugin:window|start_dragging')` —— 走 IPC、受 ACL 管；
> `gen/schemas/acl-manifests.json` 里 `core:window` 确有 `allow-start-dragging`
> （`commands.allow: ["start_dragging"]`），且**不在** `core:window:default` 里；
> 旁证：主窗口 `capabilities/default.json` 正是为此单独授权了它。
> ⇒ 磁贴无边框、无系统标题栏，**拖动头是唯一移动方式**；缺这条权限的现象是「拖着没反应」且**无任何报错**。
> 这条同时是**几何链的前置条件**（拖不动 ⇒ 没有 `Moved` 事件 ⇒ §4.14.4 的持久化与恢复全程不会被触发）。
>
> **② `core:window:default` 的 28 项并非「全是只读」**：第 28 项
> `allow-internal-toggle-maximize` 是写操作，而 `drag.js:103` 双击拖拽区正是 invoke 它
> ⇒ 只给 `core:default` 时，**双击磁贴头会把便签最大化**（`always_on_top` 小窗语义被破坏，
> 且最大化后的尺寸会被 §4.14.4 持久化）。
> 用 `deny-internal-toggle-maximize` 否决：`tauri-2.11.6/src/ipc/authority.rs:334` 先查
> `denied_commands`，其自带单测 `denied_command_takes_precendence`（同文件 :1007）断言
> 「同时出现在 allow 与 deny ⇒ `resolve_access` 返回 `None`（拒绝）」。
>
> **为什么必须靠主源码而不是靠推断**：这两点都是「不报错、不白屏、看起来正常」的静默失效
> （缺 `start-dragging` 只是拖不动；多给 `internal-toggle-maximize` 只是双击行为不对），
> 靠跑一遍应用看现象**发现不了**；而 `cargo check` 也不会报——两种写法都能编过。

> #### 修正记录 ③（t22，**运行时推翻静态结论**）：`deny-internal-toggle-maximize` **不构成护栏**
>
> **事实链**：t21 在真机上测出 —— 双击磁贴头**仍然铺满屏**（`IsZoomed=True`），
> 并把 Windows 最大化矩形 `{x:-8,y:-8,width:1936,height:1048}` 写进了 `tiles.json`；
> 此后该笔记每次钉住/重启都**以全屏打开**（"恢复位置"照搬脏值）。
> 而这条 deny **一直在位**、`check:tiles` 的静态断言**也一直通过**。
>
> **为什么它会失效（结论与边界，别再混）**：
> - 框架层其实是"deny 优先"的：`RuntimeAuthority::resolve_access`（`tauri-2.11.6/src/ipc/authority.rs:446-452`）
>   **先查 `denied_commands`，命中即返回 `None`**。所以 deny 对**显式 JS API 调用**
>   （如 `getCurrentWindow().toggleMaximize()`）那条路**仍然有效**。
> - 但 `drag.js` 是**框架注入的脚本**，它调的 `plugin:window|internal_toggle_maximize`
>   这条路径**实测不受 capability deny 约束**。
>   ⚠️ **t19 时我引用的"tauri 自带单测证明 deny 优先"（authority.rs:1007）只覆盖显式 API 调用路径，
>   不覆盖注入调用** —— 这是我当时的过度推广，已在此更正。
>
> **真正的护栏（Rust 侧两层，已落地并有运行时证据）**：
> 1. **框架自己的闸门**：`internal_toggle_maximize` 的实现是
>    `if is_resizable() { if is_maximized() { unmaximize() } else if is_maximizable() { maximize() } }`
>    （`tauri-2.11.6/src/window/plugin.rs:225-231`）⇒ 磁贴创建时 `.maximizable(false)`，
>    它**什么都不做**。
> 2. **几何合理性闸门**：`tiles::sanitize_geometry()` 拒绝"铺满屏"的矩形（宽高同时 ≥ 显示器 90%），
>    事件层「最大化状态 → 立即 `unmaximize()` 且**绝不落盘**」，启动时脏值自愈并回写。
>
> **运行时闭环（可复跑，别再只看 capability 声明）**：`pnpm probe:tile-maximize`
> —— 先写入污染几何 → 启动 → 断言窗口以小窗打开（脏值被自愈）→ **真实双击磁贴头** →
> 断言 `IsZoomed=False`、几何未被改写。以及 `pnpm probe:index-refresh`（F2/F3 的闭环）。
> **静态断言也已同步收紧**：`check:tiles` 现在要求"框架闸门 + 几何闸门"两层都在，
> 并明说 deny 只是纵深 —— 且该断言经过**变异测试**（把 `.maximizable(false)` 改掉必须转红）。

### 4.14.9 自检（`pnpm check:tile`，静态 + 只读）

`src/features/settings/__checks__/tile-integration-probe.mjs`，7 项，无需 Tauri、无需浏览器，**exit code 可判**：

| 组 | 断言的到底是什么 |
| --- | --- |
| A1–A3 | `src/features/tiles/tileWindows.ts` 的 `TILE_RUST_COMMANDS` ↔ `src-tauri/src/lib.rs` 的 `generate_handler!` ↔ `src/lib/tauri.ts` 的 `COMMANDS` **三表逐字一致** |
| B1–B4 | `tiles.json` 覆盖 `tile-*`；按源码里**真实调用**最小授权；不得超授（`sql:default` / `fs:` / `dialog:` / `global-shortcut:` / `opener:` 全量）；`TileApp.tsx` 直连 SQLite 就必须有 `sql:*` |

> **探针存在的原因（captain 要求记录的结论）**：
> **危险的不是「没有权限」，而是「权限齐全但通道走错」。**
> 权限缺失时降级路径通常也会失败，于是错误**可见**（落到 `{ok:false, reason:'unavailable'}` 并给出可读原因）；
> 而权限齐全但命令名写错时，降级路径会**成功** —— `ok:true` 带着 `via:'webview'` 返回，
> 与正常路径**完全无法区分**，失败被优雅掩盖（t19 期间真实发生过：`tile_toggle` vs `cmd_toggle_tile`）。
> 判定式：`result.ok === true && result.via !== 'rust'` ⇒ 静默失效。
>
> **已知的待收敛点（留给 t20，勿在 t19 改 editor 的文件）**：命令名目前有**两张表**
> （`src/lib/tauri.ts` 的 `COMMANDS` 与 `src/features/tiles/tileWindows.ts` 的 `TILE_RUST_COMMANDS`）。
> 探针已把「两表 + `generate_handler!` 三者一致」机器化，短期内不会漂移；
> 但根治办法是让 `tileWindows.ts` 直接 `import { COMMANDS }`，收敛成单表。

---

## 4.15 开机自启（t38 需求 / t40 落地冻结）

### 4.15.1 落地三件套

| 层 | 内容 |
| --- | --- |
| 前端 | 依赖 `@tauri-apps/plugin-autostart`（**2.5.1**）；前端直接用其导出的 `enable()` / `disable()` / `isEnabled()` —— 它们走插件自带命名空间 `plugin:autostart|*`，**不需要自定义 IPC 命令**，故 `COMMANDS` 无需新增条目（也不得硬编码该命名空间字符串） |
| Rust | `src-tauri/Cargo.toml`：`tauri-plugin-autostart = "2"`；`src-tauri/src/lib.rs`：`.plugin(tauri_plugin_autostart::Builder::new().arg(AUTOSTART_MINIMIZED_ARG).build())` |
| 权限 | `capabilities/default.json` 三条：`autostart:allow-enable` / `allow-disable` / `allow-is-enabled`（= `autostart:default` 的展开）。**核对方法**：JSON 解析 `src-tauri/gen/schemas/acl-manifests.json`（manifest 里存的是**裸标识符** `allow-enable` 等，`:default` 在 `permission_sets`/`default_permission` 里 —— **grep 会给出假的 MISSING**） |

### 4.15.2 `--minimized`：开机自启时为什么不闪窗

| 路径 | 触发 | 行为 | 是否闪窗 |
| --- | --- | --- | --- |
| **`--minimized`（Rust）** | 开机自启（插件把该参数写进自启项） | `lib.rs::started_minimized()` 命中 ⇒ **不 show 主窗口**，直接后台常驻 | **零闪窗** |

**已删除的旧路径（勿恢复）**：t17 曾有一条前端偏好 `zhijian.startMinimized`（用户手动启动时，
WebView 起来后由前端调 `getCurrentWindow().hide()`），代价是约 1 秒闪现；它还带过一条
「开启开机自启就顺手把它置 true」的组合改写。该偏好、对应设置项与组合行为已**整体删除**
（`src/lib/appPreferences.ts` / `src/features/settings/autostart.ts` / `SettingsPanel.tsx` 均无残留）。
⇒「启动后是否收进托盘」现在**只有** `--minimized` 一条路径，语义单一，不存在两个开关互相矛盾的可能。

**配套改动（勿回退）**：`src-tauri/tauri.conf.json` 主窗口 `visible: false`。
原因：Tauri 会在 `setup` **之前**按 config 把窗口显示出来，只靠"setup 里 hide"仍有约 1 秒空白闪现；
改成 `visible:false` 后**由 Rust 的 `window::init()` 显式 `show()`**，正常启动观感不变（三个运行时探针都验过主窗口正常出现）。

### 4.15.3 Windows 上启动参数**确实**会写进 Run 项（主源码核实，t40）

`Builder::arg()` 的实现在 `auto-launch-0.5.0/src/windows.rs:37-43`（`tauri-plugin-autostart` 内部即用它）：

```rust
hkcu.open_subkey_with_flags("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run", KEY_SET_VALUE)?
    .set_value::<_, _>(&self.app_name, &format!("{} {}", &self.app_path, &self.args.join(" ")))?;
```

⇒ ① **值数据 = `<exe 绝对路径> --minimized`**（参数直接拼在命令行尾，REG_SZ）⇒ 自启时 `std::env::args()` **能收到**该参数 ⇒ **零闪窗方案在 Windows 成立**（不需要退路）。
② **值名 = `app_name`**，默认取 `app.package_info().name` = **Cargo 包名 `zhijian`**（**不是** productName「纸笺」）；要中文显示名就用 `.app_name("纸笺")`。
③ `is_enabled()` **不只看 Run 项**，还查 `StartupApproved\Run`（任务管理器里的"禁用"开关）：任一侧关掉都返回 `false`；而 `disable()` 只删 Run 项 —— 所以**设置面板展示状态必须用 `isEnabled()` 读系统真值**，不得用本地偏好冒充。

手动核对 / 卸载（供交付说明直接引用）：

```
reg query  "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v zhijian
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v zhijian /f
```

> ⚠️ **仍属人工验证的边界**：以上结论覆盖到「**参数会被写进自启项、进程能收到**」（主源码 + `reg query` 可查）。
> **"重启系统后自动拉起且不弹窗"** 仍需人工做一次（本环境不能重启机器）—— 请在验收清单里如实标注，不要写成已自动验证。

## 4.16 磁贴吸附开关（t52）

用户需求原话：「增加开启/关闭磁贴吸附的功能」。

### 4.16.1 权威源（与 §4.13 的 `closeToTray` 完全同构）

| 关注点 | 权威源 |
| --- | --- |
| **持久化**（跨重启记住） | 前端 `localStorage["zhijian.tileSnap"]`（默认 `true`） |
| **行为**（拖动到底吸不吸附） | Rust `tiles::TILE_SNAP`（`static AtomicBool`，**不落盘**） |

Rust 读不到 WebView 的 localStorage ⇒ 前端必须在**应用启动时**下发一次（`App.tsx` 启动流程 → `syncTileSnapPreference()`），
并在**开关变更时**再下发一次（设置面板 → `handleTileSnapChange`）。不下发的后果是"用户关掉后又自己变回开启"
（Rust 回落默认 `true`）。

命令（FROZEN）：
- `cmd_set_tile_snap(enabled: bool) -> bool` —— **返回生效值**，前端据此对账（不返回 `()`，避免"假设成功"）；
- `cmd_tile_snap_enabled() -> bool` —— 读取当前值（启动对账 / 诊断）。

### 4.16.2 关闭后的语义（三条必须一起成立）

| 行为 | 关闭后的表现 | 代码位置 |
| --- | --- | --- |
| 吸附 | 拖动不再自动贴合到邻居边上 | `apply_snap_after_move_inner` 首部 gate |
| 整组跟随 | 拖一枚**不会**带着同组其它磁贴走 | `propagate_group_move` 首部 gate |
| 已有组号 | **原样保留**（重新开启即恢复） | 不触碰 `TileGeometry.group` |

第三条是刻意的：这是**开关**而不是**清空** —— 关一次开关不该毁掉用户已经摆好的布局。
显式解组（磁贴标题栏的「取消吸附」/ `cmd_ungroup_tile`）**不受开关影响**：关掉的是"自动吸附"，不是用户的显式操作。

### 4.16.3 为什么两条 gate 都要有（只加一条就是半开状态）

- 只 gate 吸附判定：磁贴不再贴合，但**已在组里的**仍会整组跟随 ⇒ 用户会认为"开关没用"；
- 只 gate 传播：拖动不再带同伴，但松手仍会自动吸附成组 ⇒ 用户会认为"关不掉"。

### 4.16.4 门禁与验证（含变异测试）

- 静态门禁 `pnpm check:tiles`：① 两条 gate 都存在（按函数体配对提取，不靠"接下来 N 字符"）；
  ② 开关可读写、默认 `true`、命令返回生效值；③ 两个命令都已在 `lib.rs` 注册。
- 静态门禁 `pnpm check:settings`：① 偏好键/默认值/读写函数齐全；② 面板两条路都走（落库 + 下发）；
  ③ App 启动流程真的调用下发（**先对该段去注释再匹配** —— 变异测试抓到过"注释掉也能通过"的假绿）。
- 真机 `pnpm probe:tile-snap`：I1–I5（默认开启 → 关闭回读 `false` → 独立读取一致 → 关闭状态下显式解组仍可调用 → 恢复开启）。
- ⚠️ **仍未自动验证**：「关闭后拖动是否真的不吸附」需要一次真实拖动事件 —— 与 `docs/RUN.md` 记录的吸附缺口同源。
- 六条静态断言全部做过**变异测试**：改默认值 / 摘掉一条 gate / 取消命令注册 / 面板不下发 / 启动不下发 / 删偏好键 ⇒ 各自对号变红。

## 4.17 单实例锁（t53）

用户报障原话：「程序最小化到托盘后，再点桌面快捷图标，又会打开一个新的程序，系统托盘会有两个实例」。

**根因**：`lib.rs` 的装配行注释里写着"单实例 + 对话框 + 文件系统 + 打开外部链接"，
但**从未注册**任何单实例插件 —— 注释描述了意图，代码里没有实现。
这类"注释与实现不符"的缺陷不报错、不白屏、构建全绿，只有拿注释去核对代码才会发现。

### 4.17.1 两个实例具体坏在哪（为什么必须锁）

| 后果 | 说明 |
| --- | --- |
| 两个托盘图标 | 每个进程各自 `tray::init`，用户分不清哪个"真的"，退出时容易只退掉一个 |
| 全局快捷键必然失败 | `Alt+N` / `Alt+Shift+Z` 是系统级独占资源，后启动的实例注册必然失败并打印告警 |
| 同时读写同一份数据 | 两个进程共用同一个 SQLite 与 `tiles.json`，几何与索引写入会互相覆盖 |

### 4.17.2 实现（FROZEN）

```rust
// ⚠️ 必须是第一个注册的插件（插件官方要求），否则锁不生效
.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
    // 走到这里 = 已有实例在运行；本进程随即退出，所以这里负责"唤起"
    window::show_main(app)
}))
```

三条同时成立才算修好，缺一条都是半修复：

1. `Cargo.toml` 里有 `tauri-plugin-single-instance`；
2. 它在 `Builder` 链里是**第一个** `.plugin(...)`；
3. 回调里调用了 `window::show_main` —— **只加锁不唤起**，用户双击图标会变成"点了没反应"，
   比新开一个窗口的观感更糟。

唤起复用托盘那条 `window::show_main`（`show` + `unminimize` + `set_focus` + emit `WINDOW_SHOWN`），
因此「双击桌面图标」与「点托盘图标」的行为完全一致。

### 4.17.3 门禁与验证

- 静态门禁 `pnpm check:contract` 一条：依赖在 + 第一个注册 + 回调唤起；
  回调体用**花括号配平**提取（不用"接下来 N 字符"，那种锚点会随文件重排静默失配）。
- 真机验证可自动化（见 `docs/RUN.md` §6.5 步骤 14）：连续启动两次 ⇒ **进程数恒为 1**，
  且第二次启动把已有实例的窗口唤起。

## 4.18 启动显示模式与磁贴外观/行为选项（t54）

用户需求四条：① 设置里可选打开软件时的界面显示模式（编辑 / 分栏 / 预览）；
② 磁贴透明度可调；③ 是否允许编辑磁贴；④ 已固定磁贴是否允许被隐藏。

### 4.18.1 四个偏好的权威源（与 §4.13 同一套路）

| 偏好 | localStorage 键 | 默认 | 行为侧落在哪 |
| --- | --- | --- | --- |
| 启动显示模式 | `zhijian.startupViewMode` | `split` | **纯前端**：只作为 `App.tsx` 里 `editorMode` 的初始值 |
| 磁贴透明度 | `zhijian.tileOpacity` | `1` | **纯前端**：磁贴容器上的 `style.opacity` |
| 允许编辑磁贴 | `zhijian.tileEditable` | `true` | **纯前端**：磁贴内标题与正文的 `readOnly` |
| 固定磁贴可被隐藏 | `zhijian.pinnedTilesHidable` | `false` | **Rust**：`tiles::TILE_HIDE_PINNED`（启动与变更时下发） |

四个默认值一律取「与本次改动之前的观感一致」（分栏 / 不透明 / 可编辑 / 固定磁贴不参与全部显隐）
—— 老用户升级后不该突然发现界面或磁贴变了样；想要新行为就自己打开。

### 4.18.2 为什么只有第四条需要下发 Rust

「显示/隐藏全部磁贴」是由**全局快捷键与托盘菜单直接调用 Rust** 的 `set_all_visible_impl()`
完成的 —— 它压根不经过前端。所以"固定磁贴要不要跟着动"这个判断只能由 Rust 拿到值，
必须由前端下发（`features/settings/tileBehavior.ts`，启动 + 变更两条路）。
其余三条的消费点全在前端（主窗口与磁贴窗口自己读 localStorage 即可），不需要 IPC。

### 4.18.3 跨窗口同步：磁贴怎么知道设置变了

磁贴是**独立 WebView**（各自一份 JS 上下文），但它与主窗口**同源**、共享同一份 localStorage；
而 `useAppPreferences` 内部订阅了 `storage` 事件 ⇒ 主窗口一改设置，磁贴自动跟着变，
**不需要任何额外的跨窗口消息**。这也是为什么这四个偏好没有进 `EVENTS` 契约。

### 4.18.4 透明度：只让**背景**透明，前景保持不透明（FROZEN）

**语义**（用户原话）：低透明度下"文字颜色不会变浅，只是背景变透明，可以透过背景看到桌面"。

所以**不能用容器 `opacity`** —— 它作用于整棵子树，文字/图标/选中高亮会一起变淡，
那是"整块贴纸调淡"，不是"玻璃背景"。
（第一版就是这么写的，用户当场指出不对；这正是"实现方式"与"用户心智模型"不一致的典型。）

正确做法：把**背景色**与 `transparent` 按比例混合，前景继续用 `--zj-text` 原色：

```css
/* 比例由 TileApp 写进行内 style：style={{ '--zj-tile-alpha': String(偏好值) }} */
.zj-tile.zj-tile {
  background-color: color-mix(in srgb, var(--zj-bg) calc(var(--zj-tile-alpha) * 100%), transparent);
}
.zj-tile.zj-tile[data-zj-tile] [data-zj-tile-header] {  /* 标题栏同样处理 */
  background-color: color-mix(in srgb, var(--zj-surface-2) calc(var(--zj-tile-alpha) * 100%), transparent);
}
```

要点（每条都踩过或量过）：

| 要点 | 说明 |
| --- | --- |
| **WebView2 的默认白底** | Windows 上 WebView2 自带一层 `DefaultBackgroundColor`（默认白色），它位于 **CSS 之下**：只设 `transparent(true)` 时，CSS 里 html/body/元素全透明之后露出的仍是那层白底、而不是桌面（Tauri 已知问题 [tauri#12450](https://github.com/tauri-apps/tauri/issues/12450)）⇒ 创建磁贴窗口时必须再写 `.background_color(Color(0, 0, 0, 0))` 把默认背景设成全透明。这一层是"看起来调了完全没效果"的最后一个原因 |
| **外层必须先透明** | `index.css` 给 `body` 设了 `background: var(--zj-bg)`（主窗口需要它），而磁贴窗口加载的是**同一份前端** ⇒ 必须在磁贴窗口里把 html/body 覆盖成透明（`html:has(.zj-tile), body:has(.zj-tile)`）。不覆盖的话内层做得再对，也只是"透出 body 的同色底"，真机表现就是**完全没效果** |
| 只处理两层 | 磁贴**自身**真正不透明的只有**根容器**与**标题栏**；CodeMirror 主题本身就是 `backgroundColor: transparent`，行内代码块那种小色块保留不透明反而更像"贴在玻璃上的标签" |
| 选择器 | 标题栏在 DOM 上是**属性** `data-zj-tile-header`，不是类 —— 第一版写成 `.zj-tile-header` 类选择器，规则**静默不匹配**（标题栏一直不透明），只有量 `getComputedStyle` 才发现 |
| 特异性 | 用 `.zj-tile.zj-tile`（0,2,0）稳定压过 Tailwind 的 `bg-bg`，不依赖两个 CSS 文件的打包顺序 |
| 降级 | 不支持 `color-mix` 的引擎会忽略这两条声明 ⇒ 回落到工具类（完全不透明），安全降级 |
| 窗口参数 | 磁贴窗口**本来就是 `transparent(true)`**（§4.14），所以不需要改创建参数 |

下限 `TILE_OPACITY_MIN = 0.3` 是刻意的：再低就几乎看不见，用户会以为"磁贴丢了"却找不到可点的东西。

**实测（浏览器量计算值，`?tile=<id>` 直接渲染磁贴组件）**：

| `--zj-tile-alpha` | 根容器背景 | 标题栏背景 | 容器 `opacity` | 文字色 |
| --- | --- | --- | --- | --- |
| `1` | `color(srgb …)`（无 alpha） | `color(srgb …)` | `1` | `rgb(58, 56, 51)` |
| `0.4` | `color(srgb … / 0.4)` | `color(srgb … / 0.4)` | `1` | **不变** |
| `0.15` | `color(srgb … / 0.15)` | `color(srgb … / 0.15)` | `1` | **不变** |

⇒ 背景随透明度变化、文字恒为原色、容器 `opacity` 恒为 1。

**但"量计算值"不足以说明有效** —— 还得做**视觉验证**：给 `html` 铺一层粉蓝斜条纹（模拟桌面壁纸）、
把 `--zj-tile-alpha` 设为 `0.25` ⇒ 条纹透过磁贴背景清晰可见，而"读不到这条笔记"等文字仍是实色、没变淡。

这一步是必做项，原因是踩过一次：只量磁贴容器的 `backgroundColor`（显示 `/ 0.25`，完全正确），
却因为 **body 那层不透明背景**，真机上根本看不到任何变化（用户反馈：「现在的磁贴透明度完全没有
任何效果了」）。教训：**量一层不够，要看整条背景链**（html → body → #root → .zj-tile → WebView2 背景），
并且最终要用眼睛确认一次。

⚠️ 最后一条"用眼睛确认"还额外教了一次：机器判定也要设计对。
我曾用"铺一个纯黑窗口"来验证透明，结果平均色始终不变，一度得出"窗口根本不透明"的错误结论 ——
真实原因是那个黑窗口是**非置顶**的普通窗口，磁贴背后其实是别的窗口（浅色文档），
所以透出来当然还是浅色。**判定用的背景必须确实位于被测窗口之下**，
否则再精确的像素统计也会给出错误答案（人眼看到叠影的那一眼，才把结论纠正过来）。

### 4.18.5 只读状态必须说出口

关掉「允许编辑磁贴」后，磁贴标题栏的文字会变成「纸笺磁贴 · 只读」。
不加这句提示的话，用户点正文改不动只会以为界面卡住了（本项目对"点了没反应"一向零容忍）。

### 4.18.6 门禁（六条，全部做过变异测试）

- `pnpm check:settings` 四条：① 四个偏好键/默认值/读写函数齐全（默认值必须"不变观感"）；
  ② 面板四项控件齐全且**该下发的下发了**；③ 启动模式真的用于初始化 `editorMode` + 启动流程真下发；
  ④ 磁贴真的用了透明度，且**标题与正文两处**都只读（只改一处就是"半只读"）。
- `pnpm check:tiles` 两条：① `TILE_HIDE_PINNED` 默认 `false` 且 gate 落在 `set_all_visible_impl`；
  ② 两个命令都已实现并在 `lib.rs` 注册。
- 变异测试：改默认值 / 只落库不下发 / 忽略启动模式 / 只设一处只读 / Rust 默认改 true / 摘掉 gate
  ⇒ 六条各自对号变红。

## 4.19 编辑器文字选区的对比度（t55）

用户反馈：「在编辑模式下，如果我用鼠标选中一段文字，被选中的文字不会反色显示，
或者它的反色与底色相同无法分辨」。

**根因不是没渲染，是对比度太低**。默认主题（paper-yellow·light）下：

| 项 | 值 | 与底色的对比度 |
| --- | --- | --- |
| 底色 `--zj-bg` | `#fdf8ec` | — |
| 选区 `--zj-selection` | `#f0e3bc` | **1.21**（几乎是同色） |
| 改用 `--zj-editor-selection`（强调色 70% + 背景 30%） | `#d9bc62` | **1.75**（清晰可辨） |
| 选中文字 `--zj-text` 在新选区上 | `#3a3833` | **6.31**（依旧清晰） |

**为什么不直接改全局 `--zj-selection`**：那个 token 同时承担侧栏选中项、标题栏 hover、
按钮激活态等"面状高亮"，必须保持淡雅；把全局调浓会连带改变这些地方的观感。
所以只给**编辑器文字选区**引入专用变量 `--zj-editor-selection`（定义在 `editorTheme.ts` 的 `&` 规则里），
用"该主题强调色 70% + 背景 30%"混合 —— 任何主题/明暗下都与底色有明确区分，且不引入新色系。

> 判定方法也值得记一笔：这次没有靠"读代码猜"，而是在**真实页面**里把四种候选色并排铺出来、
> 用同一段文字 + 同一底色截图对比（见 `browser-screenshots/` 里那次对比截图）。
> 颜色这类"能不能看清"的问题，数字（对比度）能给方向，最终还得用眼睛定案 —— 因为
> WCAG 对比度对**色相差**并不敏感，1.75 的金黄色在视觉上其实相当明显。




