# src/features/editor —— Markdown 实时编辑与预览（任务 t4 + t16 + t23 交付）

> 归属：编辑器成员 · 契约来源：`docs/ARCHITECTURE.md` §4.4（`EditorPaneProps`）/ §5、`docs/DESIGN.md`
> 只用 `src/components/ui/**` 的现成组件与 token 语义类；颜色**全部**来自 `--zj-*` 变量。
>
> t16 追加：**Live Preview（所见即所得）** + **一行图标格式化工具栏**（详见 §2、§3）。
> t23 追加：**工具条标签入口 + 通用 `TagPicker` 面板**（详见 §4.1；组件在 `components/ui/tag-picker.tsx`）。

## 1. 文件清单

| 文件 | 职责 |
| --- | --- |
| `EditorPane.tsx` | 三态面板（编辑 / 分栏 / 预览）、细工具条（标题、**标签入口**、字数、保存状态、视图切换、保存、导出）、**格式化工具栏装配**、可拖拽分隔条、防抖自动保存编排 |
| `MarkdownToolbar.tsx` | 🆕 **格式化工具栏**：一行图标按钮（加粗/斜体/删除线/行内代码/H1-H4/无序·有序·任务列表/引用/代码块/链接/表格/水平线/撤销/重做），激活态用 `aria-pressed` 反映光标格式 |
| `markdownCommands.ts` | 🆕 **纯函数命令层**（`EditorState → TransactionSpec`）：包裹/取消包裹、行前缀切换、表格骨架、列表编号、链接、代码块。只依赖 `@codemirror/state`，可在 Node 里直接断言 |
| `markdownToolbarState.ts` | 🆕 工具栏激活态（语法树 + 行首正则，只读）+ 视图级执行入口 `runMarkdownCommand/runUndo/runRedo` |
| `livePreview.ts` | 🆕 **Live Preview**：ViewPlugin + Decoration，非光标行隐藏标记并就地渲染；IME 组合期不重建、不隐藏 |
| `CodeMirrorEditor.tsx` | CodeMirror 6 封装：markdown（GFM base）、**Live Preview 扩展**、CSS 变量主题、行号可选、`Mod-B/I/K`、Tab 缩进、`Mod-S`、外部内容同步、`onViewReady/onViewUpdate` |
| `markdownHighlight.ts` | 自定义 markdown 语法着色插件（语法树节点名 → `zj-md-*` 类名），替代需要硬编码色值的 `HighlightStyle` |
| `editorTheme.ts` | CodeMirror 主题 + `zj-md-*`（源码着色）与 `zj-lp-*`（Live Preview 渲染）样式，取值全部 `var(--zj-*)` |
| `MarkdownPreview.tsx` | react-markdown + remark-gfm 预览：标题 / 列表 / 表格 / 任务列表 / 引用 / 链接 / 图片 / 删除线 / 行内代码 / 代码块 |
| `CodeBlock.tsx` | 代码块：Shiki 高亮 + 语言角标 + 复制按钮（未就绪时先渲染纯文本，不跳动不白屏） |
| `preview.css` | Shiki `--shiki-light/--shiki-dark` 与 `<html class="dark">` 的接线（唯一样式文件，仅用于第三方 HTML） |
| `shikiHighlighter.ts` | Shiki 细粒度加载器：core / JS 引擎 / 2 主题 / 18 语言全部动态 import + 语言与 HTML 缓存 |
| `EditorEmpty.tsx` | 未选中笔记时的空状态（lucide 图标 + 文案 + 可选按钮，无图片资源） |
| `useAutoSave.ts` | 防抖自动保存（默认 500ms，契约区间 400–600ms）+ 换笔记冲刷保护 |
| `index.ts` | 统一出口 |
| `__checks__/` | 自检页 + 纯函数断言脚本 + Shiki 探针（**不参与生产构建**） |

## 2. Live Preview（所见即所得，t16）

**原理：只用 Decoration 改「显示」，绝不动文档。** 文档内容、自动保存、撤销栈、
Markdown 解析全部保持原样 —— 关掉 Live Preview 就是一份普通 Markdown 源码。

| 元素 | 非光标行显示 | 光标/选区所在行 |
| --- | --- | --- |
| `**粗**` / `*斜*` / `~~删~~` / `` `代码` `` | 加粗 / 斜体 / 删除线 / 行内代码样式，标记符隐藏 | 原样源码 |
| `# 标题`（1–6 级） | 隐藏 `#`，行内字号 18/15/14/13px（与预览面板一致） | 原样源码 |
| `> 引用` | 隐藏 `>`，左侧 2px accent 边线 + 弱化斜体 | 原样源码 |
| `- 项` / `1. 项` | 隐藏标记，渲染 `•` / 保留原序号（`1.` / `1)`） | 原样源码 |
| `- [ ]` / `- [x]` | 隐藏标记，渲染只读复选框（勾选态来自文档） | 原样源码 |
| `---` | 整行替换为一条水平线 | 原样源码 |
| `[文字](url)` | 只保留 `文字`（accent + 下划线），`url` 弱化为小号 muted 文本 | 原样源码 |
| 代码块（``` 围栏 / 缩进） | **整段保留原样**（不做块级渲染） | 同左 |
| GFM 表格 | **整段保留原样** | 同左 |

「光标行显示源码」由 `state.selection` 决定（多选区时命中任一选区即算光标行），
因此点进去就能精确编辑标记符，离开即恢复渲染 —— 这就是「所见即所得 + 可精细编辑」的折中。

### 2.1 中文输入法（IME）组合期间的行为 —— 硬保证

`livePreview()` 的 `update()` 里有两条规则：

1. **组合中（`view.compositionStarted === true`）绝不重建装饰**，只把已有装饰随文档变化
   平移（`decorations.map(update.changes)`）——避免 CM 在候选窗打开时重排内容 DOM；
2. 组合结束（`compositionend`，含 Esc 取消组合这种无文档变化的情况）后延迟一拍重建一次，
   恢复到完整渲染。

同时，**组合所在行必然就是光标行，本来就不加任何装饰**，所以组合中的拼音永远不会被
「隐藏标记」的装饰切割。实测（自检页 `window.__zjHarness.simulateComposition('拼')`）：

| 观测量 | 实测值 | 含义 |
| --- | --- | --- |
| `view.compositionStarted`（组合中 / 后） | `true` / `false` | 组合状态被正确识别 |
| 组合期间 Live Preview 重建次数 | **0** | 组合中不重建（只做 map 平移） |
| compositionend 后重建次数 | **1** | 延迟刷新生效，渲染恢复 |
| 组合行 DOM 文本 | `拼拼正文里有**加粗**、*斜体*…`（6 个 `*` 原样可见，`zj-lp-*` 类为 0） | 组合行不被隐藏任何标记 |
| 其他标题行的 `zj-lp-h1` 类 | 组合中/后都保持 | 其余行渲染稳定，没有被清空 |

## 3. 格式化工具栏（t16）

一行图标按钮（`role="toolbar"`，lucide-react 图标 + Tooltip），编辑 / 分栏模式可见：

```
加粗 斜体 删除线 行内代码 │ H1 H2 H3 H4 │ 无序 有序 任务 引用 │ 代码块 链接 表格 分隔线 │ 撤销 重做
```

- **有选区** → 包裹；**无选区** → 包裹光标所在词，否则插入占位文本并**选中占位**
  （加粗→`粗体`、行内代码→`代码`、表格→`列 1`、代码块→`代码`、链接→选中 `url`）；
- **行级命令为前缀切换**：整段已带该前缀 → 移除；否则统一加上（h2 会替换已有的 h1 前缀）；
  有序列表按行自动编号 `1. 2. 3.`；
- **激活态**：`aria-pressed` + `bg-selection` 高亮（token 派生，无硬编码色值）。
  行内格式用语法树判断（光标在 `StrongEmphasis` 里 → 加粗高亮），行级格式用行首正则；
- 撤销/重做在历史栈为空时禁用（`undoDepth/redoDepth`）。

按钮与快捷键（`Ctrl+B/I/K`、`Ctrl+Shift+X`）**共用同一批纯函数命令**，行为不会漂移。

## 4. 集成方式（t10 请照抄这一段）

```tsx
import { EditorPane } from '@/features/editor'

<EditorPane
  note={note}                     // 当前笔记；null → 空状态
  mode={editorMode}               // 'edit' | 'preview' | 'split'
  dirty={dirty}                   // 上层是否还有未落库改动
  onModeChange={setEditorMode}
  onTitleChange={(title) => notesStore.update(note.id, { title })}
  onContentChange={(content) => notesStore.update(note.id, { content })}
  onSave={() => notesStore.update(note.id, { content: draftContent })}
  onExport={(format) => exportNote(note, format)}   // 建议实现：serialize + 保存对话框
/>
```

> Live Preview 与格式化工具栏**无需任何集成改动**：`CodeMirrorEditor` 内置 Live Preview 扩展，
> `EditorPane` 自己渲染工具栏。

### ⚠️ 硬性要求：`onContentChange` / `onTitleChange` 必须写入**本次渲染的 note**

```tsx
// ✅ 正确：回调闭包捕获本次渲染的 note（t10 推荐写法）
onContentChange={(content) => notesStore.update(note.id, { content })}

// ❌ 危险：回调里现读 store（切换笔记后会把上一篇的正文写进新笔记）
onContentChange={(content) =>
  notesStore.update(useNotesStore.getState().selectedId!, { content })}
```

原因：编辑器在**切换笔记时**会把上一篇未落库的内容冲刷出去（否则丢字）。冲刷使用的是
「产生内容那次渲染」的回调实例，它的闭包指向**旧笔记**；只有当回调自己再去现读
`selectedId`/store 时，才会读到已经变成新笔记的 id，从而串写。

**实测证据**（自检页 `window.__zjHarness`，三种上层写法各跑一次「A 里打字 → 防抖未到就切到 B」）：

| 上层写法 | A 接到内容 | B 被误写 |
| --- | --- | --- |
| 闭包捕获本次 note（推荐） | ✅ | ❌ 否 |
| `useCallback([selectedId])` 生成的回调（本次渲染的 id） | ✅ | ❌ 否 |
| 回调里现读 `selectedId` / store | ✅（旧回调已发出） | ⚠️ **是** |

### 4.1 标签入口（t23）—— 从点击按钮到落库的完整链路

工具条上新增「标签」按钮：显示当前笔记标签（最多 `maxVisibleTags` 个 + 「+k」），点击打开
`TagPickerDialog`（来自 `src/components/ui/tag-picker.tsx`，与 Dialog/DropdownMenu 同级的通用纯展示件）。

```
① 点击工具条「标签」按钮         EditorPane（data-zj-tag-button，aria-haspopup=dialog）
② TagPickerDialog 打开           搜索过滤 / 勾选 / 取消 / 回车新建 / 移除（Backspace）
③ 每次操作 → onChange(next)      TagPicker 只产出「新的完整名称数组」，自身不落库
                                 （本地 draft 先给即时反馈，宿主 value 回写后自动同步）
④ EditorPane.handleTagsChange    props.onEditTags 优先；**缺省回退**到
                                 useNotesStore.getState().update(note.id, { tags: next })
⑤ store.update → notesRepo.update  db 层 normalizeTags + 写 front-matter/索引（既有实现，未改一行）
⑥ store 就地替换 notes[]         → 工具条徽标、侧栏标签计数、卡片标签即时刷新
```

集成层若想接管，只需多传几个**可选** props（都不传也能用）：

```tsx
<EditorPane
  /* …原有 props… */
  noteTags={note.tags}                                  // 展示来源；缺省自动取 note.tags
  allTags={tags}                                        // 标签库（Tag[]）；缺省首次打开只读调 tagsRepo.list()
  onEditTags={(next) => notesStore.update(note.id, { tags: next })}  // 落库；缺省走同样的 store 回退
  maxVisibleTags={2}                                    // 工具条最多直显几个标签
/>
```

标签库与落库都只**只读调用既有接口**（`tagsRepo.list()` / `useNotesStore.getState().update`），
未修改 store/db 源码。`TagPicker` 自身保持 components/ui 的分层红线：不 import store/db/features。

## 5. 自动保存

- 内容/标题变化 → 合并负载 → **500ms** 无输入后经 `onContentChange` / `onTitleChange` 交给上层落库；
- 立即落库的时机：`Ctrl/Cmd+S`、工具条保存按钮、标题输入框失焦、切换到另一篇笔记、组件卸载；
- 工具条右侧徽标显示 `未保存 / 保存中… / 已保存 / 保存失败`（失败时 tooltip 给出可读原因）；
- 换笔记时不丢字、不串写：`useAutoSave` 的 `scopeKey = note.id`，作用域切换时用**上一次渲染
  捕获的回调**冲刷旧文档；`CodeMirrorEditor` 另有 `key={note.id}` + `noteId` 依赖重建视图，
  历史与选区一并重置。

## 6. 编辑器快捷键

| 快捷键 | 行为 |
| --- | --- |
| `Ctrl/Cmd+B` / `Ctrl/Cmd+I` | 加粗 / 斜体（已包裹则取消包裹） |
| `Ctrl/Cmd+Shift+X` | 删除线 |
| `Ctrl/Cmd+K` | 插入 `[文字](url)`，插入后选中 `url` 便于直接输入 |
| `Tab` / `Shift+Tab` | 缩进 / 取消缩进（2 空格） |
| `Ctrl/Cmd+S` | 立即保存（先冲刷防抖内容，再调用 `onSave`） |
| `Enter` / `Backspace` | 列表、引用自动续写与删除标记（`@codemirror/lang-markdown` 的 `markdownKeymap`） |
| `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` | 撤销 / 重做（`historyKeymap`，工具栏按钮同一套） |

## 7. 主题与预览

- **编辑器**：`EditorView.theme` 内的取值一律 `var(--zj-*)`，明暗切换只改 `<html>`，
  不重建 `EditorView`、不触发 React 重渲染（实测：切 5 套主题 × 明暗，编辑器 DOM 与类名不变，只有计算色变化）。
- **Shiki**：一次 `codeToHtml` 用 `themes: { light, dark } + defaultColor: false` 产出
  `--shiki-light*/--shiki-dark*` 变量，`preview.css` 按 `.dark` 选择变量 → **切主题零重新高亮**
  （实测：切主题前后代码块 `outerHTML` 逐字节相同，计算色从 `#393A34` 变为 `#DBD7CAEE`）。
- 代码块底色/圆角来自 token（`bg-surface-2` + `rounded-zj` = 8px），语法色来自 Shiki 主题。
- 预览正文最大宽 760px 居中，正文 15px/1.75，与 `docs/DESIGN.md §5` 一致。

## 8. 打包策略与体积（Shiki 不全量打包）

`shiki/core`、`shiki/engine/javascript`（纯 JS 正则引擎，**不引入 onig.wasm**）、2 套主题、
18 种语法全部走动态 `import()`，各自独立成 chunk；语言/主题只在真正出现时加载，另有
`getLoadedLanguages()` 集合与 240 条 HTML LRU 缓存。

实测（`pnpm vite build --config src/features/editor/__checks__/vite.check.config.mjs`，
把自检页当入口，衡量「编辑器真正入包」时的情况）：

| chunk | 大小 |
| --- | --- |
| 主 chunk（React 19 + ReactDOM + CodeMirror 6 + react-markdown/remark-gfm + 应用代码） | 981 kB / gzip 326 kB |
| `core`（shiki 核心） | 96 kB |
| `engine-javascript`（含 oniguruma-to-es） | 60 kB |
| 2 套主题 | 13.6 / 13.8 kB |
| 18 种语法（按需，最大的 typescript 181 kB） | 2.6–181 kB 各自独立 |

> 若不做代码分割，`shiki/bundle/full` 单文件即 1.07 MB（min）且会随主 chunk 一起加载；
> 现在只有用到某语言的那一刻才拉它的 chunk。
> 另注：`pnpm vite build`（生产入口是骨架版 `App.tsx`）的产物里暂时**没有**编辑器代码 ——
> 等 t10 接入 `src/App.tsx` 后，上面这张表就是真实的入包情况。

## 9. 自检与验证（全部可复现）

```bash
# 1) 类型与构建
pnpm typecheck                 # tsc -b；或 pnpm tsc --noEmit
pnpm vite:build

# 2) 命令与 Live Preview 的纯函数断言（56 项，不需要浏览器）
node src/features/editor/__checks__/run-checks.mjs

# 3) Shiki 细粒度/双主题探针（18 种语言 + text 兜底）
node src/features/editor/__checks__/probe-shiki.mjs

# 4) 浏览器自检页（真实 UI）
pnpm dev   # 然后打开 /src/features/editor/__checks__/harness.html
#   window.__zjHarness.runSelfTest()          「A 打字 → 立刻切 B」串写自检
#   window.__zjHarness.livePreviewFacts()     逐行报告「隐藏了哪些标记 / 渲染成了什么」
#   window.__zjHarness.toolbarFacts()         工具栏按钮 + aria-pressed 激活态
#   window.__zjHarness.clickToolbar('bold')   真实 DOM 点击工具栏按钮
#   window.__zjHarness.goToLine(5)            移动光标，验证「光标行显示源码」
#   window.__zjHarness.simulateComposition('拼')  IME 组合期行为（见 §2.1）
#   window.__zjHarness.previewFacts()         表格/任务列表/代码块/语法标记的 DOM 事实

# 5) 体积报告（可选）
pnpm vite build --config src/features/editor/__checks__/vite.check.config.mjs
```

### 9.1 纯函数断言（`run-checks.mjs`，56 项全通过）

覆盖：内联包裹/取消包裹（含光标在词内、光标贴住已包裹词）、行级前缀切换（h1↔h2、
列表↔任务、引用开/关）、多行有序编号、表格骨架与占位选区、代码块包裹与骨架、
水平线空行规则、链接插入与 `url` 选中、列表续行（无序/有序自增/引用/任务）、
Live Preview 的四条不变式（光标行 0 装饰、非光标行有隐藏装饰、代码块与表格整段跳过、
`hideMarkers:false` 时 0 条隐藏装饰）、`parseLineRender` 的行级单元断言（含
`snake_case` 不当作斜体）。

### 9.2 浏览器实测摘要

- **Live Preview**：光标在第 5 行时，第 5 行 DOM 文本仍是 `正文里有**加粗**、*斜体*…`（源码），
  第 1 行渲染为 `纸笺 · 编辑器自检` + `zj-lp-h1`（`#` 已隐藏）；列表渲染 `•`/`1.`、
  任务项渲染复选框（`data-checked=true/false`）、`---` 渲染为水平线、表格与代码块保持原样。
- **工具栏**：18 个按钮（加粗…重做）；光标在 `# 标题` 行时 `h1` 按钮 `aria-pressed="true"`
  且背景 = `--zj-selection`（实测 `rgb(240,227,188)`，来自 token 而非硬编码）；
  点击加粗 → `**hello** world`，再点 → 取消；点击 h2 → `## 第二行` 且激活态切到 `h2`；
  空行点表格 → 插入骨架且选中 `列 1`，预览同步出现 1 个表格。
- **IME**：见 §2.1 的四项实测数据（组合中重建 0 次、组合行 0 个 `zj-lp-*`、其他行渲染稳定）。
- **既有能力未回归**：预览 GFM 表格 1 个（3 个表头单元）、任务列表 2 项（1 勾选 1 未勾选）、
  3 个代码块全部命中 `.shiki`（含未知语言 → `text` 兜底）、16 个 `--shiki-dark` token；
  编辑器 `zj-md-*` 语法标记全部命中；Tabs（`role=tab` + `aria-selected`）、导出下拉、
  空状态、分隔条拖拽 50%→72%（`role=separator` + `aria-valuenow`）、键盘 ←/→、
  `Ctrl+B/I/K`、`Tab`/`Shift+Tab`、`Ctrl+S`、换笔记不串写（`runSelfTest`）全部仍然通过；
  全流程 console 0 error / 0 warning。

## 10. 输入竞态修复（t32）——「拼音+汉字同入、光标跳回首行」的残留路径

用户第二轮反馈：「输入依然有问题，比如拼音和文字同时输入，光标跳转到开头，但**并非一直存在，只是有概率**，
感觉跟**实时保存**有关」。t16 的三道守卫之后仍有两条未覆盖的路径，**都是竞态**：

### 10.1 主路径：`EditorPane` 的「外部改写」启发式被乱序回包骗过

t16 的判据是 `note.content !== draft.content && note.content !== lastSentRef.current.content`。
`notesStore.update` 是异步（`await initDb()` + 写盘 + 索引重建，耗时不定），**两次保存在飞、旧的后 resolve**
就命中这条时序（`draftSync.ts::STALE_ECHO_RACE` 就是它的可执行文档）：

| 时刻 | 动作 | `note.content` | `draft.content` | `lastSentRef` |
| --- | --- | --- | --- | --- |
| t1 | 打 AAA → Ctrl+S（payload#1） | `基线\nAAA` | `基线\nAAA` | `基线\nAAA` |
| t2 | 打 BBB → Ctrl+S（payload#2） | `基线\nAAABBB` | `基线\nAAABBB` | `基线\nAAABBB` |
| t3 | 继续打 CCC（未保存） | `基线\nAAABBB` | `基线\nAAABBBCCC` | `基线\nAAABBB` |
| t4 | **payload#1 的回包最后到达** | `基线\nAAA` | `基线\nAAABBBCCC` | `基线\nAAABBB` |

t4 判据：`AAA !== AAABBBCCC` ✓ 且 `AAA !== AAABBB` ✓ ⇒ 误判「外部改写」⇒ `setDraft(旧值)`
⇒ 经 value prop 回写 CodeMirror ⇒ **正文回退 + 光标跳回首行**。「有概率」正是因为它取决于两次写入的**完成顺序**。

**修法**（`draftSync.ts` + `EditorPane`）：判据换成只依赖**单调事实**、
与到达顺序无关的两条 —— `locallyEdited`（本笔记打开后被本地编辑过）与 `busy`（有未落库/正在落库的改动）。
只要任一为真就**绝不采纳外部值**；只有「从未本地编辑 + 空闲」时才采纳
（保留「开着没动过的笔记能看到外部改动」的能力，且此时不可能打断输入）。

### 10.2 放大路径：`CodeMirrorEditor` 的 value 同步（三道守卫的缺口）

原实现有两个薄弱点，让上面那次误判变成用户可见的伤害：

| 缺口 | 后果 | 现在 |
| --- | --- | --- |
| 组合期只用 `view.composing` 判定 | `composing` 要等组合**首次变更之后**才为 true ⇒ compositionstart 到首次落字之间仍会整篇替换 ⇒ **拼音与汉字同入** | 改用 `view.compositionStarted`（compositionstart 起即为 true，**严格更强**） |
| 无条件整篇替换 + `anchor = min(anchor, len)` | 正文变短时光标被夹回行首 ⇒ **光标跳回首行** | **有焦点时一律不替换**（输入优先；换笔记由 noteId 重建视图负责） |

> ⚠️ 这三道守卫（`compositionStarted` / `value === lastEmittedRef.current` / 保持选区）是**最后一道闸**，
> 任何后续重构都**不得放宽**；`pnpm check:contract` 的「Bug 1 防回归」断言会把它们钉住。

### 10.3 从源头消除：落库串行化（`useAutoSave`）

即使判据已收紧，两次并发写入仍可能让 **store/DB 落到旧内容**。因此 `commit` 入口加了串行化：
`inFlightRef` 计数 > 0 时新负载只进 `queueRef`（只保留最新一次），上一笔 settle 后由 `drainQueue` 继续发。
⇒ **写入顺序 = 输入顺序**，「旧的后到」在源头上不再可能发生。`scopeKey` 与捕获的 `onFlush` 一起入队，
因此换笔记时的兜底冲刷依旧写回它自己的笔记（t16 的串写红线不受影响）。

### 10.4 怎么验证（可复现）

```bash
pnpm check:editor     # 含 t32 的 15 条断言（见下）
pnpm check:all        # 12 道闸全绿
pnpm dev              # /src/features/editor/__checks__/harness.html
#   window.__zjHarness.runStaleWriteRace()      ← 乱序回包场景（10.1 的时序）
#   window.__zjHarness.runCompositionClobber()  ← 组合中被外部回写场景（10.2）
```

- **纯函数层（确定性）**：`legacyExternalRewriteDetected`（旧判据，仅留在自检里做对照）在同一条时序下
  返回 `true`（会回写），`shouldAdoptExternalDraft` 返回 `false` —— **修复前后对比就固化在这两条断言里**。
- **源码静态层**：断言守卫形态存在（`compositionStarted`、`hasFocus`、`shouldAdoptExternalDraft`、
  `locallyEditedRef`、串行化 `inFlightRef`/`queueRef`）。
- **浏览器层**：`runStaleWriteRace()` 实测 —— t4 时 `note.content` 确实回退成 `基线\nAAA`（说明场景真的打中了），
  而**编辑器 doc 仍是 `基线\nAAABBBCCC`、选区 anchor 不变**；`runCompositionClobber()` 实测
  「`composing=false` 但 `compositionStarted=true`」时收到外部回写，doc 未被替换（`survivedComposition: true`）。
- **【受限】** 真实中文 IME 的候选窗行为无法自动化；且本轮修复期间有并行成员同时编辑 `EditorPane.tsx`
  （Vite 全量 reload 会打断长脚本），因此**修复前的浏览器复现**未能稳定抓到（多次尝试都因页面重载中断）。
  已用**确定性等价证据**替代：`STALE_ECHO_RACE` 时序表 + 旧/新判据在该时序上的真值表对照，加上修复后的浏览器实测。
  IME 的代码级推理见 §10.2 第 1 行（`composing` 与 `compositionStarted` 的窗口差异）。

