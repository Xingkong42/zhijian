# 集成阶段状态快照（架构师）

> 本文件记录**集成期间的一次性诊断快照**，不是长期契约。
> 长期契约见 `docs/ARCHITECTURE.md`（唯一权威），设计规范见 `docs/DESIGN.md`。
>
> 快照时间：2026/09/25 22:0x（t1 完成后，集成准备期）
> 触发原因：t1 交付后各 feature 并行落地，出现跨模块编译/接线故障，需要留证并给 QA 提供基线。

---

## 1. 五道门的实测结果

| 门 | 命令 | 结果 |
| --- | --- | --- |
| 数据层自检 | `pnpm check:db` | ✅ **54/54 通过**（v1+v2 迁移、中文双路径检索、`$N` 占位符契约） |
| 类型检查 | `pnpm typecheck`（`tsc -b`） | ⚠️ **活跃编辑中频繁变红**（见 §3，非缺陷） |
| 前端构建 | `pnpm vite:build` | ✅ exit 0（最大 chunk ≈ 267 kB / gzip 84 kB） |
| Rust 检查 | `cargo check --manifest-path src-tauri/Cargo.toml` | ✅ exit 0，**0 warning** |
| Rust 测试 | `cargo test --manifest-path src-tauri/Cargo.toml --lib` | ✅ **8 passed** |

---

## 2. 集成期内发现并修复的 3 个真实故障

### 2.1 Rust 编译失败（exit 101）→ 已修
- **现象**：`error[E0277]: the trait bound i64: Pixel is not satisfied`
- **位置**：`src-tauri/src/window.rs::center_window`
- **根因**：`tauri::PhysicalPosition::new()` 的 `Pixel` trait 只实现到
  `i8/i16/i32/u8/u16/u32/f32/f64`，代码传了 `i64`（为规避小屏负值溢出而用的 i64 中间量）。
- **处置**：在夹紧到 0 之后显式窄化为 `i32`；t6 随后自行修正为
  `x.max(0).min(i32::MAX as i64) as i32`，架构师确认无需再改。

### 2.2 三个 `init` 入口未接线 → 已修
- **现象**：`cargo check` 报 6 个 `dead_code` warning
  （`tray::init`、`window::init`、`window::center_window`、`window::is_explicit_quit`、
  `shortcuts::init`、`shortcuts::is_registered`）。
- **根因**：t6 新增了统一入口 `init(...)`，但 `src-tauri/src/lib.rs::setup` 仍在调用旧 API
  （`tray::setup` + 内联 `shortcuts::log_contract()` / `shortcuts::register_all()`）。
- **处置**：`lib.rs::setup` 改为按 **托盘 → 窗口 → 快捷键** 顺序调用
  `tray::init` / `window::init` / `shortcuts::init`（三者语义均为「失败只告警，不阻断启动」）；
  另两个只服务测试/未来公开 API 的函数加了带原因的
  `#[cfg_attr(not(test), allow(dead_code))]` / `#[allow(dead_code)]`。
- **结果**：`cargo check` 0 warning，`cargo test --lib` 8 passed。

### 2.3 【影响全队】store 占位 stub 导致 `typecheck` 红 → 架构师临时接管
- **现象**：`src/lib/hotkeys.ts(137,23): error TS2339: Property 'getState' does not exist on type '() => never'`
- **根因**：`src/store/notes.ts` 与 `src/store/search.ts` 仍是 t1 骨架占位
  （`export function useNotesStore(): never`），而 `ui.ts` / `theme.ts` 已是真实 zustand store；
  集成成员写的 `hotkeys.ts` 正确使用 `useNotesStore.getState().create()`。
- **处置**：架构师将 `src/store/notes.ts` 实现为真实 zustand store
  （`create<NotesState>()`，字段与方法签名与 §4.2 冻结契约逐字一致；
  全部经 `notesRepo` 落库；错误收敛到 `error` 字段；
  另导出 `selectCurrentNote` / `initNotes` / `createNoteFromInput` / `default`）。
  **`src/store/search.ts` 未改动，仍是 stub。**
- **归属变更**：`src/store/notes.ts`、`src/store/search.ts` 现标为
  「架构师临时接管（原 owner 可覆盖）」，见 ARCHITECTURE §5。
- **回归红线**：`useNotesStore` 必须是真实 zustand store（`getState()` 可用），
  不得退回 `(): never` 占位 —— 否则 `hotkeys.ts` 会再次编译失败。

---

## 3. 为什么 `pnpm typecheck` 会间歇变红（不是缺陷）

`src/features/**` 与 `src/components/ui/**` 正被多人同时写入，同一编译单元的中间态必然报错。
实测同一天内的漂移：

| 时刻 | 报错位置 | 归属 | 现状 |
| --- | --- | --- | --- |
| 21:37 | `SettingsPanel.tsx` TS2740 / 4×TS6133 | t6 设置面板 | 已由 t6 自行修复 |
| 22:0x | `MarkdownPreview.tsx` TS6133 / TS2339 / TS7006 | 编辑器成员 | 活跃编辑中（中间态） |

**验收纪律（建议 QA 遵守）**：
1. 只在某 feature 被宣布「冻结」后，才用 `pnpm typecheck` 判定其成败；
2. 冻结前出现的红，不得计为某成员的失败；
3. 全量验收以「所有 feature 冻结后，架构师一次性跑五道门」的结果为准。

---

## 4. 跨模块契约补充（已并入 ARCHITECTURE，此处仅摘要）

1. **`SearchHit.snippet` 是受控可信 HTML**：由 `search.ts::buildSnippet()` 在 JS 侧生成，
   文本先 HTML 转义（`& < > "` + 正则元字符）再插 `<mark>` ⇒ 只可能含 `<mark>`。
   UI **必须** `dangerouslySetInnerHTML`；禁止二次转义（会把 `<mark>` 显示成字面量），
   禁止当纯文本插入。高亮样式：`mark { background: var(--zj-selection); color: inherit }`。
2. **检索策略**：码点长度 ≥ 3 且 trigram 可用 → FTS5 `notes_fts_trigram`（真实 bm25）；
   否则 → `LIKE '%q%' ESCAPE '\'`（伪 rank：标题命中位置 < 1000 + 正文命中位置，
   **只在同一路径内可比**）。v1 的 unicode61 `notes_fts` 保留但不用于中文
   （连续汉字是单 token，「我的笔记本」检索不到「笔记」）。
3. **`NoteCounts.byFolder` / `byTag` 的键**是文件夹 id / 标签名，**不含收件箱**；
   收件箱计数 = `all - Σ(Object.values(byFolder))`（`null` 不能作 `Record` 键）。
4. **SQLite 是双迁移器**（§7 已重写）：
   - Rust/sqlx → `_sqlx_migrations`，只执行 `lib.rs::MIGRATION_SOURCES` 登记的 **v1**；
     失败 = 整个库打不开（`pool.migrate()` 位于 `Database.load()` 路径，无跳过余地）。
   - 前端 `initDb()` → `_zj_migrations`，执行 v1 + **可选 v2**（trigram，带能力探测、
     失败降级为 `LIKE`、下次启动重试，不写版本号）。
   - ⚠️ **已登记进 Rust 的迁移文件连空白字符都不能改**（sqlx 校验 checksum，
     改动会导致下次启动 checksum mismatch、数据库打不开）。**建议列为 QA 检查项。**

---

## 5. 待 captain 决策

| # | 事项 | 状态 |
| --- | --- | --- |
| 1 | `src/store/{notes,search}.ts` 归属 | ✅ **已裁定**：`notes.ts` 归架构师（captain 裁定，data 明确不覆盖）；`search.ts` 指派给 db/search 作者，但**需一张新任务**才能落地（该成员 t3 已 completed 且 idle，按团队规则不能自行认领） |
| 2 | 不要设「冻结窗口」 | ✅ **captain 裁定**：DAG 即冻结机制 —— t7 依赖 t2/t3/t4/t5/t6 全部 completed，届时无人再写这些文件。并行期 typecheck 时红时绿为预期中间态，不作失败判定 |
| 3 | 全量验收时机 | ✅ t7 被派发（且无成员再写文件）后，由架构师一次性跑五道门出集成报告 |
| 4 | `src/store/search.ts` 的落地任务 | ✅ **已解决**：captain 确认 **t10「补齐 `src/store/search.ts` 真实实现 + 只读复核 notes store」已存在且 `in_progress`，assignee=data**。架构师**不碰该文件**（避免与正在工作的 data 并发冲突）。早期「未收到任务」的判断是基于 t10 落库前的过期快照，**已作废** |

---

## 5b. t7 集成窗口待闭环清单：`notesStore` 三个入口的调用责任

`src/store/notes.ts` 提供三个**不在 §4.2 契约内**的集合入口（回收站/标签视图语义不属于
`NotesState` 的冻结签名，故以模块级函数或方法形式补充）。**t7 接线时必须逐条接上**，
否则对应视图点了没反应。**以下为 t7 完成后的最终状态**：

| # | 入口 | 对应 UI | 接线要求 | 状态 |
| --- | --- | --- | --- | --- |
| E1 | `useNotesStore.getState().listByTag(tagNameOrId)` | 侧栏**标签视图** | 入参**接受标签名或 `Tag.id`**（store 内部做 id→名 解析，见 ARCHITECTURE §4.12）；`activeTagId` 会被归一化为**标签名** | ✅ **t7 已接上**（`App.tsx::handleSelectView` 的 `case 'tag'`，原样传 `tag.id`） |
| E2 | `listTrash()`（模块级导出） | 侧栏**回收站视图** | 调用后 `activeView === 'trash'`、列表为已软删除笔记 | ✅ **t7 已接上**（`case 'trash'`） |
| E3 | `useNotesStore.getState().refresh()`（或模块级 `listAll()`） | **手动刷新** / 导入数据后 | `refresh()` **保持当前集合**重取；`listAll()` **切回「全部」**重取 | ✅ **t7 已接上**：`case 'all'` → `listAll()`（注意**不是** `listByFolder(null)`，那是收件箱）；设置面板 `onDataImported` → `refresh()` + 元数据重载 |
| E4 | 新增 IPC `set_close_to_tray(enabled)` + Rust 侧 `AtomicBool` 偏好 | 设置面板「关闭窗口时隐藏到托盘」开关 | 见 ARCHITECTURE **§4.13**。四条硬规则已实现 | ✅ Rust 侧 t12 完成；✅ 前端 t13 完成（`<CloseToTrayNotice />`）；✅ t7 已在 `<ToastProvider>` 内挂载一次 |
| E5 | `selectCurrentNote(state)` 返回 `null` 即「选中态悬空」 | 回归断言用 | 用作「选中项不在列表里」的断言 | ✅ t7 验证通过；并据此修掉 I2（`update()` 现会重新判定集合归属） |

---

## 5c. t12：fs 权限逐条核对（**结论与任务描述的前提不一致，已如实记录**）

t12 的任务描述断言「缺 `fs:allow-download-read-recursive` 会直接让导出/导入失败」。
我按要求**逐条核对实际调用**，结论如下（不是凭猜，是逐行读代码 + 解析 acl-manifests）：

| 调用点 | 实际代码 | 所需权限 |
| --- | --- | --- |
| `src/lib/export.ts:426` | `save({ title, defaultPath: fileName, filters })` —— **只有文件名，无目录** | `dialog:allow-save` ✅ 已有 |
| `src/lib/export.ts:445` | `writeTextFile(path, content)`，`path` = 对话框返回值 | `fs:allow-write-text-file`（含于 `fs:default`）+ **对话框动态作用域** |
| `src/features/settings/dataTransfer.ts:127` | `save({ defaultPath: defaultFileName, filters })` | `dialog:allow-save` ✅ 已有 |
| `src/features/settings/dataTransfer.ts:144` | `writeTextFile(selected, content)` | 同 export：命令权限 + 动态作用域 |
| `src/features/settings/dataTransfer.ts:297` | `open({ directory: false, filters })` | `dialog:allow-open` ✅ 已有 |
| `src/features/settings/dataTransfer.ts:306` | `readTextFile(selected)` | `fs:allow-read-text-file`（含于 `fs:default`）+ 动态作用域 |

**结论**：

1. **两个文件都没有读取 `$DOWNLOAD` 等静态目录** —— 全是「对话框选中路径 → 直接读写该绝对路径」。
   `plugin-dialog` 的 `save()`/`open()` 会把用户选中路径**动态加入 fs 作用域**
   （`src/lib/export.ts:15-17` 的注释亦记录了 shell 已实测确认这一点）。
   因此 `fs:allow-download-read-recursive` **对这两个调用点并不是必需的**。
2. `fs:default` = `create-app-specific-dirs, read-app-specific-dirs-recursive, deny-default`
   ⇒ 默认**拒绝**所有路径，仅对 app-specific 目录放行；这正是「必须有作用域」的证明，
   而对话框提供了该作用域。
3. **已保留的加固项**（对上述调用点非必需，但无害且抗 UI 变化）：
   `fs:allow-appdata-read/write-recursive`、`fs:allow-document-read/write-recursive`、
   `fs:allow-download-write-recursive`、`fs:allow-desktop-read/write-recursive`，
   以及 t12 依 t6 请求补的 **`fs:allow-download-read-recursive`**。
4. **已否决**：`fs:allow-home-read/write-recursive`（`$HOME` 递归读写 = 把整个用户目录交给 webview，
   收益/风险不匹配；captain 已认可）。

**⚠️ 只能由运行时验证的部分（留给 QA，用 `pnpm tauri:dev`）**：

- 对话框选中的路径是否确实被加入 fs 作用域，从而 `writeTextFile` / `readTextFile` 成功；
- 用户把文件存到**桌面 / 下载 / 文档之外**（例如 D 盘某目录）时是否仍可写 —— 这一路径**依赖动态作用域**，
  静态目录白名单并不覆盖，因此**若动态作用域在真实环境未生效，导出会失败**。
  （`src/lib/export.ts` 注释称 shell 已实测通过，但那是 shell 的单点验证，未由 QA 独立复核。）
- 托盘存在/不存在两种情况下关闭按钮的真实行为，以及 `WINDOW_HIDDEN` 负载是否到达前端。


**补充约束（供 t7 验证）**：

- E1 的调用方**不需要**自己把 `Tag.id` 映射成名字 —— 但若侧栏选择「B 方案」自行映射，也必须传名字。
- `listByFolder(folderId)` 与 `listByTag(...)` 会把 `selectedId` 重置为该集合第一条（切换视图的正常语义）。
- `selectCurrentNote(state)` 是「当前选中笔记对象」的便捷 selector：
  **它返回 `null` 说明选中态悬空**（指向不在列表里的笔记）—— t7 可把它当断言用。


---

## 6. `src/store/notes.ts` 复核发现与处置（data 只读复核 + 架构师修复）

data 对架构师的 `notes.ts` 做了只读复核，结论：§4.2 字段与方法签名逐字一致 ✅、
`getState()` 可用 ✅、全部经 `notesRepo` 落库且不写裸 SQL ✅。并指出 3 个缺陷，处置如下：

| # | 发现 | 严重度 | 处置 |
| --- | --- | --- | --- |
| 1 | `move()` 后 `await notesRepo.listAll()` 覆盖 `notes` ⇒ 在「文件夹 / 标签」视图里拖拽会把列表**悄悄换成全部** | 中 | ✅ **已修**：store 新增集合上下文（`activeView`/`activeFolderId`/`activeTagId`，**追加字段，非 §4.2 契约字段**）；`move` 改为**就地重排**（`pinned DESC, order ASC, created_at ASC`），仅在 `moved` 已不属于当前集合时才从列表移除；不再重新查库 |
| 2 | `create()` 会把不属于当前过滤条件的新笔记插进列表 | 低 | ✅ **已修**：新增 `noteBelongs(note, view)` 判定，不属于当前集合时只 `selectedId` 指向新笔记、**不插入列表、不改变视图** |
| 3 | `search.ts` 仍是 stub ⇒ 搜索链路断裂（R4 未闭环） | 高 | ⏳ **已转交 data（t10，in_progress）**：`SearchBox.tsx` 把 `search` 当可选 prop，编译能过但**点了没反应**。t10 验收要求：真实 zustand `useSearchStore`（§4.2 签名逐字一致）+ 150ms 防抖 + 竞态丢弃 + 空串清空 + 错误收敛 + 把 `results` 映射成 NoteList 需要的 `notes` + `snippets` 透传。**架构师不修改该文件**（避免与 in_progress 的 data 并发冲突） |

**顺带修复（架构师主动）**：`restore()` 原先无条件 `listAll()`，同样会破坏视图。
现改为：回收站视图下恢复 → 从列表移除；其他视图 → 属于本集合才插到最前。
另新增两个独立入口 `listTrash()` / `listAll()`（回收站视图语义不在 §4.2 契约内，故不以 store 方法暴露）、
以及 `refresh()` 供集成层在外部改动后按**当前集合**重取。

---

## 6b. t11：`notes.ts` 第二轮复核缺陷的修复与验证（架构师）

t10 的只读复核又发现 4 个真实缺陷（F1/F2/F3/F5）与 1 个命名双语义陷阱（F6），t11 已全部处置：

| # | 缺陷 | 严重度 | 修法 |
| --- | --- | --- | --- |
| F1 | 六个写入口未 `await initDb()`，启动瞬间按 Alt+N 会撞「数据库尚未初始化」⇒ **该次新建直接丢失** | 中 | `create`/`update`/`remove`/`restore`/`move`/`createNoteFromInput` 各加 `await initDb()`（t3 已 memoize，成本≈0） |
| F2 | 回收站视图下 `create` 的 `noteBelongs` 恒 false ⇒ 只改 `selectedId` 不插列表 ⇒ **编辑器空白、无高亮** | 中 | 不属当前集合时把集合**切到「全部」并重取**，保证选中项一定在列表里 |
| F3 | `create`/`restore` 裸 `[note, ...notes]` 前插 ⇒ 未置顶笔记显示在置顶项**之上**（「顺序自己跳一下」） | 低 | 统一走 `reorderLocally()`（与 `move` 一致，`pinned DESC, order ASC`） |
| F5 | `createNoteFromInput()` 绕过错误收敛（不写 `error`） | 低 | 与其它方法一致地写入 `error`（仍向上抛出，保留原语义） |
| F6 | 标签**命名双语义**：`NotesState.activeTagId` 是标签名，`UiState.activeTagId` / `onSelectView` 是 `Tag.id` ⇒ 直接透传会 `tags.name = '<uuid>'` 恒空**静默失败** | 信息（t7 必踩） | `listByTag` 入口做 **id→名 容错解析**（`resolveTagName()`），并把 `activeTagId` 归一化为标签名；契约写入 ARCHITECTURE **§4.12** |

### 验证方式（不是「看着对」，是跑出来的）

用 data 的自检 loader（`node:sqlite` 顶替 plugin-sql + `@/` 别名 + Node 24 类型擦除），
让**真实的** `notesStore` + `notesRepo` + `tagsRepo` 跑在**真实内存 SQLite** 上：

- **行为断言 39 项全通过**：覆盖 F1 竞态（含 `closeDb()` 复位后再 create 仍自动 initDb）、
  F2 三种断言（集合切回 all / 笔记在列表 / `selectCurrentNote` 非 null）、
  F3 四条（新建不越过置顶 / 在列表内 / 全列表满足置顶+order 序 / restore 同理）、
  F5（成功抛出 **且** 写入 error）、F6（按名、按 id、无效入参三种入参）、
  以及 §4.2 全部冻结字段与方法的**存在性回归**。
- **突变测试 5/5 证实验证有效**：把每个缺陷**重新注入**源码副本，断言对应的检查项**确实失败**
  —— 避免「测试恒真」的假阳性。注入 F1 时真实复现了报错
  `读取笔记排序位失败：数据库尚未初始化：请先在应用启动时 await initDb()`。
- 临时验证脚本与突变副本**已全部删除**，`src/db/__checks__/` 恢复为 5 个原有文件。

> 结论：F1–F3、F5 已被行为断言 + 突变测试双向证明修复有效；F6 的双语义陷阱已写进
> ARCHITECTURE §4.12（含 A/B 两种接线方案，推荐 A 且已实现）。

### data 补充的 db 层语义（供列表成员 t5 知悉）

- `move(id, { targetIndex, folderId })` 的 `targetIndex` 是**目标文件夹规范序**
  （`pinned DESC, sort_order ASC, created_at ASC, id ASC`）中的下标。
- 在**标签视图**里拖拽时，dnd 的下标与规范序**不是 1:1** ⇒
  **只有「文件夹视图 / 全部」里的拖拽是精确的**，标签视图拖拽仅作 best-effort。

### 迁移文件完整性

- `pnpm check:db` 的自检脚本**只读**两份迁移文件到内存库执行，**从不写**任何迁移文件
  ⇒ 可放心作为 QA 的重复执行证据（幂等、无副作用）。
- 另经核实：sqlx 0.8.6 的 `SqliteConnectOptions::new()` 默认 `PRAGMA foreign_keys = ON`
  （`options/mod.rs:185`），FK 级联 / `SET NULL` 在真实运行时会生效；
  repo 仍显式清理 `note_tags` 与子树 `folderId`，属**有意冗余**（不依赖 PRAGMA），非重复劳动。

