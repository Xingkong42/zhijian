# src/features/tiles —— 桌面便签磁贴（任务 t24）

> 归属：编辑器成员 · 分工：**窗口里渲染什么**归我（t24）；**窗口的创建/位置/置顶/生命周期**归 t19（system）；
> 主入口接线归 architect（t20）。`docs/ARCHITECTURE.md` 的契约以本目录说明与 captain 的任务书为准。

## 1. URL 协议（captain t24 定死）

磁贴窗口加载**同一份前端**，只是 URL 带一个参数：

```
<origin><pathname>?tile=<noteId>      例：tauri://localhost/?tile=3f1c9a2e-…（UUID）
```

- 参数名固定 `tile`（大小写敏感）；不带该参数 = 主窗口，渲染正常的 `<App />`。
- **每个磁贴窗口只渲染一个 noteId**（一条笔记一个窗口）。
- 窗口 label 约定：`tile-<noteId>`（见 `tileWindowLabel()`；UUID 天然合法，
  非法字符会被替换成 `_`，因此 Rust 侧按 label 查找/去重也稳定）。
- 纯函数 `readTileNoteId(search)` 是唯一解析入口：允许带或不带 `?`、多个参数、URL 编码；
  **空值 / 纯空白 / 畸形百分号编码（U+FFFD）→ null**（宁可当主窗口，也不把乱码当 id）。

## 2. 接入点（留给 t20 / architect，`src/main.tsx` 我不改）

```tsx
// src/main.tsx（architect 所有）—— 唯一需要加的一段
import App from './App'
import { TileApp, readTileNoteId } from './features/tiles'

const tileNoteId = readTileNoteId(location.search)

createRoot(container).render(
  <StrictMode>
    <AppErrorBoundary>
      {tileNoteId ? <TileApp noteId={tileNoteId} /> : <App />}
    </AppErrorBoundary>
  </StrictMode>,
)
```

> 错误边界继续包在最外层即可：磁贴读不到笔记时自己会显示文案 + 关闭按钮，不会白屏。
> `initTheme()` 的调用位置不用动 —— 磁贴与主窗口共用同一份主题初始化（切主题只改 `<html>`）。

### 2.1 主窗口侧入口（「钉住这条笔记」按钮）

```tsx
import { toggleTileForNote } from '@/features/tiles'

const result = await toggleTileForNote(note.id)
if (!result.ok) toast({ title: '磁贴打不开', description: result.message, variant: 'error' })
```

- 已开 → 关闭；未开 → 打开（Rust 命令返回 `'opened' | 'closed'`，或布尔 `true`=已打开）。
- 通道优先级：**Rust 命令**（`TILE_RUST_COMMANDS.toggle` = `cmd_toggle_tile`）→ 前端
  `WebviewWindow` API → 都不可用时返回 `{ ok:false, reason:'unavailable', message }`（可读原因，不抛错）。
- 浏览器 dev（无 Tauri）→ 用**新标签页**打开同一个 `?tile=` URL，返回 `devTab: true`。
  磁贴 UI 因此可以纯浏览器验证（见 §5 的自检页）。

### 2.2 与 Rust 侧的对接现状（`src-tauri/**` 归 architect，我这边只读核对）

Rust 侧已就绪：`src-tauri/src/tiles.rs`（`cmd_toggle_tile` / `cmd_list_tiles` /
`cmd_set_tiles_visible` + 几何持久化 + 可见性事件）与 `src-tauri/capabilities/tiles.json`。
前端对应关系如下（`__checks__/run-checks.mjs` 会**直接读 Rust 源码逐条核对**，杜绝命名漂移）：

| 前端 | Rust | 说明 |
| --- | --- | --- |
| `TILE_RUST_COMMANDS.toggle = 'cmd_toggle_tile'` | `tiles::cmd_toggle_tile(note_id) -> Result<bool,String>` | 入参 `{ noteId }`（Tauri 自动 camelCase 映射）；`true` = 调用后处于打开态 |
| `TILE_RUST_COMMANDS.list = 'cmd_list_tiles'` | `tiles::cmd_list_tiles() -> Vec<TileInfo>` | `TileInfo` 是 camelCase 序列化；`isTileWindowOpen()` 优先用它（权威状态） |
| `TILE_RUST_COMMANDS.setVisible = 'cmd_set_tiles_visible'` | `tiles::cmd_set_tiles_visible(visible)` | 一次性显示/隐藏全部磁贴 |
| `TILE_LABEL_PREFIX = 'tile-'` | `TILE_LABEL_PREFIX = "tile-"` | Rust 用 `note_id_from_label()` 反解析 |
| `TILE_FALLBACK_WINDOW = 280×240 / min 160×120` | `TILE_DEFAULT_WIDTH/HEIGHT`、`TILE_MIN_*` | 前端退化建窗与 Rust 保持同尺寸 |
| `readTileNoteId(location.search)` | `tile_url()` 拼 `?tile={note_id}` | 两侧约定的唯一参数名 |

> ⚠️ **历史踩坑（已修）**：前端常量一度写成 `'tile_toggle'`，而 Rust 注册的是
> `tiles::cmd_toggle_tile` ⇒ `invoke` not found 被 catch 吞掉 → 静默退化成前端建窗，
> **功能看着正常，但 Rust 侧的几何持久化 / 可见性事件 / 开机恢复磁贴全都不执行**。
> 现在有跨界断言兜底（见 §5）。

### 2.3 两处待 architect 裁定的事项 —— **均已在 t19/t20 裁定并落地**（保留原文追溯）

> ✅ **已裁定**：
> 1. **数据通道 = 方案 A（磁贴沿用同一套数据层）**。captain 裁定「磁贴是**可编辑 + 自动保存**，
>    不是只读展示窗」，因此 `tiles.json` 按 `TileApp.tsx` / `notesRepo` 的**真实调用**最小授权：
>    `sql:allow-load` / `allow-select` / `allow-execute`（**不是** `sql:default` 全量，也不是完全不给）。
>    `tiles.json` 的 description 已同步改写，不再有"只读、刻意不给 sql"的旧表述。
> 2. **`core:window:allow-close` / `allow-show` 已显式加入** `tiles.json`。
>    另外 t19 复核时用主源码补了两条（见 ARCHITECTURE §4.14.8）：
>    `core:window:allow-start-dragging`（缺它**拖不动且无报错** —— `data-tauri-drag-region`
>    其实是走 IPC 的，不是免权限原生区）与 `core:window:deny-internal-toggle-maximize`
>    （`core:window:default` 允许双击拖拽区最大化，会把便签最大化）。

<details><summary>原文（t24 提出时的疑问）</summary>

1. **磁贴的数据通道（sql 直连 vs IPC）**：`tiles.json` 的 description 写的是「只读展示小窗、
   刻意不给 sql」，而本目录的 `TileApp` 目前是 `initDb() + notesRepo.get()` + 保存时
   `notesStore.update()` **直连 SQLite**（因为 t24 要求磁贴可编辑并自动保存）。
2. **`core:window:allow-close` / `allow-show`**：`core:default` 只含窗口**只读**操作，
   `tiles.json` 需显式加这两条，否则磁贴的「关闭磁贴」与「打开主窗口」按钮会静默失败。

</details>

## 3. 一个磁贴窗口从 URL 到渲染到保存的完整链路

```
① Rust（t19）按 label `tile-<noteId>` 创建无边框置顶窗口
      url = tileWindowUrl(noteId, origin, pathname) = `<origin><pathname>?tile=<id>`
② 前端冷启动：initTheme() → readTileNoteId(location.search) === noteId
③ main.tsx 渲染 <TileApp noteId={noteId} />（本目录）
④ TileApp 载入：initDb() → notesRepo.get(noteId)（只读接口）
      null → 「这条笔记不在了」+ 关闭按钮；抛错 → 「读不到这条笔记」+ 可读原因
⑤ 渲染：拖拽头（data-tauri-drag-region="deep"）+ 单行标题 Input
      + 正文 CodeMirrorEditor（复用主编辑器：Live Preview / 主题 / 快捷键一致）
⑥ 编辑 → useAutoSave（500ms 防抖，scopeKey = noteId）
      标题/正文变化合并成 NoteUpdatePatch
⑦ 冲刷（防抖到点 / Ctrl+S / 失焦 / 关闭窗口时卸载）→
      saveNote(noteId, patch) = useNotesStore.getState().update(id, patch)
      store 失败会写进 error 字段，这里还原成异常 ⇒ 头部徽标显示「保存失败」+ tooltip 原因
⑧ db 层 normalizeTags / 写 front-matter + 索引（既有实现，未改一行）
      → 主窗口下次 refresh / 切视图即可看到新内容
```

**串写红线**（t16 用户实测）：`onFlush` 里写死的目标是**本次渲染闭包捕获的 `noteId`**，
绝不现读 `useNotesStore` 的 `selectedId` 或遍历 `store.notes` —— 磁贴窗口有独立的 store 实例，
现读会写到 null / 别的笔记上。自检页对此有一条专门的 A→B 切换断言。

## 4. 与主编辑器的复用关系（一处显式的分层例外）

`TileApp` 直接 import 了 `@/features/editor/{CodeMirrorEditor,useAutoSave}`：
captain 在 t24 任务书里明确要求「复用已有的 CodeMirrorEditor，而不是另写一个编辑器」。
`src/features/README.md` 的「禁止跨 feature import」因此出现**唯一一处例外**，理由与代价：

- 收益：Live Preview、主题跟随、快捷键、防抖保存语义与主窗口**完全一致**（不会出现两套行为）；
- 代价：tiles 依赖 editor。若要彻底消除，需 architect 决定把
  `CodeMirrorEditor` / `useAutoSave` 提升到 `src/components/**` 或 `src/lib/**`；
  在提升之前，这里保持显式 import + 本说明，不做重复实现。

磁贴独有的样式覆盖在 `tile.css`（只在 `.zj-tile` 作用域内收紧正文内距，
`--zj-*` token 之外不写任何颜色）。

## 5. 自检

```bash
# 纯函数断言（≥8 项，含 readTileNoteId 正常/缺失/多参数/非法编码 + label/url 构造 + 文案常量）
node src/features/tiles/__checks__/run-checks.mjs

# 浏览器端到端（URL → 渲染 → 编辑 → 防抖保存；含 A→B 串写红线与失效笔记态）
pnpm dev
#   主界面：/src/features/tiles/__checks__/harness.html
#   磁贴形态：同地址 + ?tile=note-a（自检页会打印 readTileNoteId 的结果）
```
