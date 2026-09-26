# 纸笺 · 独立验证与质量报告（t8 / QA）

> **验证方**：qa（独立复核，非实现者）
> **验证时间**：2026/09/25 22:2x–22:5x
> **工作目录**：`<项目根>`
> **任务**：t8 —— 13 项需求逐条核证 + 真跑命令 + 专项核查 + 质量报告
>
> **纪律声明**
> 1. 本报告**不使用 `docs/INTEGRATION-STATUS.md` 的任何结论作为证据**（只作为线索），每条结论都来自我自己跑的命令或亲自读到的 `文件:行`。
> 2. 证据分三类，全文逐条标注，**不混写**：
>    - **【实测】** = 我自己跑出来的命令输出 / 真实运行观察（可复现）
>    - **【读码】** = 我亲自读到的源码位置（`文件:行`），属**代码级推断**，不等于运行期已验证
>    - **【受限】** = 未能验证，明确标注，不做臆测
> 3. 我**未改动任何业务实现**。本次改动仅为新增验证脚本与本报文：
>    `scripts/verify-acl.mjs`、`scripts/verify-migrations.mjs`、`scripts/verify-stores-and-silent-noops.mjs`、`docs/QA-REPORT.md`。
> 4. 我做的桌面运行验证在**真实 `pnpm tauri:dev`** 进程上完成；测试期间产生的 6 条空笔记与临时目录/截图**已全部清理**（数据库恢复为 0 条笔记、0 文件夹、0 标签）。
> 5. 任务书与 captain 的转述若与代码冲突，**一律以代码为准**；本次实测到 2 处「转述与代码不符」，已在对应条目中点明。

---

## 0. 验收命令：原始结果（我自己跑的，非转述）

| # | 命令 | 退出码 | 原始输出摘要 |
| --- | --- | --- | --- |
| 1 | `pnpm typecheck` | **0** | `tsc -b tsconfig.app.json tsconfig.node.json`，无任何输出（全绿） |
| 2 | `pnpm vite:build` | **0** | `vite v7.3.6`，**2128 modules transformed**，`built in 3.99s`；CSS `29.95 kB (gzip 6.96)`；主 chunk `index-BpTZPonq.js 1,137.70 kB │ gzip 375.97 kB`；另拆出 18 个 Shiki 语言 chunk（`typescript 181.08 kB`、`core 96.41 kB`、`engine-javascript 59.99 kB`、主题 13.62/13.76 kB…）。stderr 有 4 条 `dynamically imported but also statically imported` 提示与 1 条 `chunks are larger than 500 kB` 警告 |
| 3 | `pnpm check:rust`（= `cargo check --manifest-path src-tauri/Cargo.toml`） | **0** | `Finished dev profile ... in 0.32s`，**0 warning**（注意：这是缓存命中，见下方 §0.1 的补强） |
| 4 | `pnpm check:db`（= `node src/db/__checks__/run-checks.mjs`） | **0** | **总计 54 项：通过 54，失败 0**；覆盖 A1 迁移可执行/幂等/22 条断言、A2 双源一致性、B1 initDb 与能力探测、B2 foldersRepo、B3 notesRepo CRUD、B4 move 排序、B5 counts/级联、B6 tagsRepo、B7 中文检索双路径、B8 连接生命周期、C1 `$N` 占位符契约 |
| 5 | `cargo test --manifest-path src-tauri/Cargo.toml --lib` | **0** | `running 12 tests` → **`test result: ok. 12 passed; 0 failed`**；含 `window::tests::clear_explicit_quit_resets_latch`、`shortcuts::tests::pressed_only_triggers`、`tray::tests::menu_ids_are_namespaced` 等 |
| 6 | `node scripts/verify-acl.mjs`（我新增） | **0** | **权限核对：通过 56，失败 0** —— ACL 标识符全部命中、无 home 越权 |
| 7 | `node scripts/verify-migrations.mjs`（我新增） | **0** | **迁移/检索核对：通过 37，失败 0** —— 含 sqlx checksum 反证、双源双向一致、中文检索 7 条行为断言 |
| 8 | `node scripts/verify-stores-and-silent-noops.mjs`（我新增） | **1** | **通过 14，缺陷 5**（D1 high、D1b×2 medium、D2 medium、D3 medium）—— 该脚本是「缺陷探测器」，退出 1 = 探测到缺陷，非脚本故障 |
| 9 | `pnpm tauri:dev` | 运行中 | 全量编译 **452/452**，`Finished dev profile ... in 13.98s`，唯一 warning 为 `linker_messages`（MSVC 链接器创建 .lib/.exp 的提示，**不是代码警告**）；进程 `zhijian` 以窗口标题「纸笺」启动 |

### 0.1 对 `cargo check` 缓存命中的补强【实测】

`pnpm check:rust` 只用了 0.32s（缓存命中），单看它不足以证明「0 warning」。补强证据：第 9 项的 `pnpm tauri:dev` 触发了**完整的 debug 重编译**（`Compiling zhijian`，450/452 → 452/452，13.98s），期间输出的唯一 warning 是：

```
warning: linker stdout: 正在创建库 ...\zhijian_lib.dll.lib 和对象 ...\zhijian_lib.dll.exp
= note: `#[warn(linker_messages)]` on by default
warning: `zhijian` (lib) generated 1 warning
```

该 warning 来自链接器消息透传，**不是 Rust 代码告警**。结论：**Rust 侧 0 代码警告**成立。

---

## 1. 13 项用户需求逐条核证

| # | 需求 | 状态 | 证据 | 问题 |
| --- | --- | --- | --- | --- |
| (a) | 笔记增删改查 | **通过** | 【读码】`src/db/notes.ts:103-234`（create/update/remove/restore/hardDelete/listAll/listByFolder/listByTag/move/counts）；`src/store/notes.ts:41-72`（冻结签名齐全）、`src/store/notes.ts:202/239/267/284/309`（全部经 repo 落库）；UI 接线 `src/App.tsx:366-410`【实测】`pnpm check:db` B3「软删除/回收站/恢复/物理删除」+ B5b 全绿；桌面运行中 **Alt+N 建笔记 → 输入标题/正文 → DB 落库**（见 §4.6） | 无（但见 D1：新建会重复一条） |
| (b) | Markdown 实时编辑与预览 | **通过（代码级 + 界面级）** | 【读码】`EditorPane.tsx`：三态 `编辑/分栏/预览` + 可拖拽分隔条；`CodeMirrorEditor.tsx:24` `markdown, markdownLanguage`、`:230` keymap、`:214` lineWrapping；`MarkdownPreview.tsx:16-18` `react-markdown` + `remark-gfm`、`:295` `REMARK_PLUGINS=[remarkGfm]`；`shikiHighlighter.ts:179-182` 动态加载 `shiki/core`+`engine/javascript`+双主题、`:35-52` 18 种语言按需 chunk；`useAutoSave.ts` 500ms 防抖【实测】桌面运行中在正文输入 `# QA_autosave_probe…` + 列表项，**截图确认预览窗格渲染为 h1 大标题 + • 项目符号列表**；并确认输入即落库（§4.6） | 未做「字体/表格/代码块高亮」逐项人工核对；预览视觉证据仅覆盖标题与列表 |
| (c) | SQLite 本地存储 | **通过** | 【读码】`src-tauri/Cargo.toml:23` `tauri-plugin-sql = { version="2", features=["sqlite"] }`；`src-tauri/tauri.conf.json:41-45` `plugins.sql.preload=["sqlite:zhijian.db"]`；`src/db/index.ts` `initDb()`；`src/lib/tauri.ts:20` `dbUrl`【实测】真实运行库 `%APPDATA%\com.zhijian.app\zhijian.db` 存在，表齐全，`_sqlx_migrations=[v1:init]`、`_zj_migrations=[1,2]`、SQLite **3.53.3** | 无 |
| (d) | 全文搜索 | **通过** | 【读码】`src/db/search.ts:177` `searchRepo`（FTS5 trigram ≥3 字 / LIKE 兜底 <3 字）；`src/store/search.ts:83-126` 真实 zustand + 防抖 + 竞态序号丢弃；`src/features/sidebar/search-store.ts:63-73` 真实订阅；`Sidebar.tsx:75-76` 把真实切片传给 `SearchBox`；`App.tsx:413-421` 把 `SearchHit[]` 映射成 `notes`+`snippets`【实测】`scripts/verify-migrations.mjs` C 段 7 条检索断言全绿（含「我的笔记本」可被「笔记」命中）；`pnpm check:db` B7 全绿 | 无 |
| (e) | 无边框窗口 + 自定义标题栏 | **通过** | 【读码】`src-tauri/tauri.conf.json:22` `"decorations": false`；`src/features/titlebar/Titlebar.tsx:37` `data-tauri-drag-region="deep"`、`:39` `h-9`(36px)、`:83-100` 设置/最小化/最大化/关闭【实测】桌面运行截图确认：**无操作系统标题栏**，应用自绘标题栏含「纸笺」+ 笔记标题 + 已保存 + 4 个窗口按钮；`getComputedStyle(header).height === "36px"`、`data-tauri-drag-region === "deep"` | 无 |
| (f) | 笔记文件夹 | **通过** | 【读码】`src/db/folders.ts:43-100`（create/rename/remove/tree）；`src/features/sidebar/FolderTree.tsx:221` `role="tree"`、`:143` `role="treeitem"`（含右键新建子文件夹/重命名/删除、行内输入）；`App.tsx:268-304` 三个回调接真实 repo【实测】`pnpm check:db` B2（tree 递归 / 排序位独立递增 / 空名报错）+ B5（子树删除后笔记回收到收件箱）全绿 | 未做鼠标级 UI 复核（右键菜单未点击验证） |
| (g) | 标签 | **通过** | 【读码】`src/db/tags.ts:100-158`（create/rename/remove/setNoteTags）；`src/features/sidebar/TagList.tsx:156` 行内新建；`Sidebar.tsx:207-218` 计数用 `tag.name` 查 `counts.byTag`、`onSelectView('tag', tag.id)`；`App.tsx:306-330`【实测】`pnpm check:db` B6（重复名报错 / setNoteTags 幂等 / 删除标签后从 tags 镜像剔除）全绿；B3「标签自动建定义 + note_tags 关系 + JSON 镜像三处一致」 | 未做鼠标级 UI 复核 |
| (h) | 拖拽排序 | **部分（代码级 + 数据级已验；UI 拖拽未复核）** | 【读码】`NoteList.tsx:121` `useSensor(PointerSensor, { activationConstraint: { distance: 5 } })`、`:122` `KeyboardSensor`+`sortableKeyboardCoordinates`、`:110/210` `onDragEnd` 唯一出口 → `App.tsx:376-381` `useNotesStore.getState().move(id, targetIndex, folderId)`；`:100` 仅「手动排序 + 非搜索 + 非回收站 + reorderable」时启用，`App.tsx:487` 标签视图传 `reorderable={false}`【实测】`pnpm check:db` B4（index 0 / 末尾 / 中间 / 越界视为末尾 / 跨文件夹 / 不存在报错）全绿 | **【受限】未做鼠标拖拽级复核**：本机桌面自动化只能把窗口置顶一瞬（`SetForegroundWindow` 被其它窗口抢占），无法可靠完成一次真实拖拽，故不写成「通过」 |
| (i) | 导出笔记 | **通过** | 【读码】`src/lib/export.ts:390-455` `exportNote()`（`serializeTarget` → `dialog.save()` → `fs.writeTextFile`）；`EditorPane.tsx:247-259` 三个导出项（Markdown/HTML/纯文本）【实测】**真实桌面运行中完成端到端导出**：点击「导出」→「导出为 Markdown」→ 原生保存对话框 → 保存到 **`D:\qa-dynamic-scope\zj-export.md`**（静态白名单之外）→ 文件真实生成，114 字节，内容为正确的 YAML front-matter + 正文（见 §4.1） | 无 |
| (j) | alt+N 全局快捷键新建 | **通过（功能生效）但有 high 缺陷 D1** | 【读码】`src-tauri/src/shortcuts.rs:22` `NEW_NOTE_ACCELERATOR="Alt+N"`、`:44-47` 命中即 `show_main`+emit `NEW_NOTE_REQUESTED`、`:41` 只响应 Pressed【实测】`pnpm tauri:dev` 日志 `[纸笺] 全局快捷键已注册：Alt+N / Alt+Shift+Z`（真实环境**无冲突**）；用 `AppActivate`+`SendKeys('%n')` 发一次 Alt+N，DB 笔记数 **0 → 2**，再次发送 **2 → 4**（每次按键稳定多出一条） | **⚠️ D1（high）**：一次 Alt+N 创建 **2** 条笔记，见 §5.1。另 D1b：`openSettingsRequested`/`appQuitRequested` 也各被订阅 2 次 |
| (k) | 系统托盘后台常驻 | **通过** | 【读码】`src-tauri/src/tray.rs:33-96`（5 项菜单、左键切换、右键菜单、重复 init 先移除旧托盘）；`src-tauri/src/window.rs:76-78` `should_hide_on_close = !is_explicit_quit() && close_to_tray_preference() && app.tray_by_id(TRAY_ID).is_some()`；`src-tauri/src/lib.rs:69-84` `CloseRequested` 钩子；唯一真退出路径 `tray.rs:143-148` `request_exit → unregister_all → remove_tray_by_id → exit(0)`【实测】运行日志 `[纸笺] 系统托盘已就绪`；发送 `Alt+F4` 后：`IsWindowVisible(主窗口 hwnd 198296) = False` 且 **进程仍存活**；再发 `Alt+Shift+Z`：`IsWindowVisible = True` | 托盘图标的鼠标点击/菜单项未做点击级复核（§6） |
| (l) | 自定义主题 | **通过** | 【读码】`src/store/theme.ts:136-171`（`setTheme/setMode/toggleMode/apply`，写入 `<html data-theme>` + `class`，持久化 `localStorage['zj:theme']`）；`src/db/schema.ts:524` 五套主题 × light/dark；`src/styles/theme.css` 与之逐条对应；`src/features/settings/ThemePicker.tsx` 五色块 + 明暗切换【实测】浏览器运行中点击「墨绿」→ `data-theme="ink-green"`、`getComputedStyle` 的 `--zj-bg` 由 `#fdf8ec` 变为 `#f3f6f2`、body 背景同步变化、`localStorage['zj:theme'] = {"themeId":"ink-green","mode":"light"}` | 无 |
| (m) | 默认淡黄色主题 | **通过** | 【读码】`src/db/schema.ts:687` `DEFAULT_THEME_ID='paper-yellow'`、`:526-556` 淡黄主题（`light.zj-bg #FDF8EC`）；`src/styles/theme.css:23-39` `:root,[data-theme='paper-yellow']`；`index.html:4` 首帧兜底 `data-theme="paper-yellow" class="light"`【实测】清空 `localStorage` 后刷新：`data-theme="paper-yellow"`、`class="light"`、`--zj-bg="#fdf8ec"`、`body` 背景 `rgb(253,248,236)`；桌面截图同样为淡黄底 | 无 |

### 技术栈符合性（逐项在 `package.json` / `Cargo.toml` / 源码中核对）

| 要求 | 状态 | 证据（含**已安装版本**，`pnpm list --depth 0`【实测】） |
| --- | --- | --- |
| Tauri 2 | 通过 | `src-tauri/Cargo.toml:18` `tauri = { version="2", features=["tray-icon","image-png"] }`；实际 `tauri 2.11.6`、`Cargo.lock:4182-4183` |
| React 19 | 通过 | `package.json:37-38` `react ^19.1.1` / `react-dom ^19.1.1`；实际安装 **react 19.3.0** |
| TypeScript | 通过 | `package.json:53` `typescript ~5.9.2`；实际 **5.9.3**；`pnpm typecheck` 退出 0 |
| Vite | 通过 | `package.json:54` `vite ^7.1.6`；实际 **vite 7.3.6**（构建输出首行） |
| Tailwind CSS 4 | 通过 | `package.json:46/52` `@tailwindcss/vite ^4.1.13`、`tailwindcss ^4.1.13`；实际 **4.3.3**；`src/index.css:1` `@import 'tailwindcss'`、`:25` `@theme inline` 映射 `--zj-*` |
| shadcn/ui 风格手写 CVA 等价实现 | 通过 | `package.json:34` `class-variance-authority ^0.7.1`；手写组件 12 个：`src/components/ui/button.tsx:11/17`、`badge.tsx:7/10`、`input.tsx:7/10`、`tabs.tsx:19/79/140`、`switch.tsx:7/11/34`、`textarea.tsx:7/10`、`dialog.tsx:26/101`、`empty-state.tsx:9/14`、`scroll-area.tsx:7/10` 等全部 `cva(...) + VariantProps` |
| Zustand | 通过 | `package.json:43` `zustand ^5.0.8`（实际 **5.0.15**）；四个 store 均为真实 `create<…>()`（§4.7 实测 `getState/setState/subscribe` 均为函数） |
| CodeMirror 6 | 通过 | `package.json:20-24` 5 个 `@codemirror/*` ^6（实际 6.11.1 / 6.5.2 / 6.12.4 / 6.7.6 / 6.43.13）；`CodeMirrorEditor.tsx:24-37` 实际 import |
| react-markdown + remark-gfm | 通过 | `package.json:39-40`（实际 10.1.0 / 4.0.1）；`MarkdownPreview.tsx:16-18` |
| Shiki | 通过 | `package.json:41` `shiki ^3.13.0`（实际 **3.23.0**）；`shikiHighlighter.ts:17-52/179-182` 细粒度动态 import，产物中确为独立 chunk（§0 第 2 行） |
| tauri-plugin-sql | 通过 | `Cargo.toml:23`；`package.json:33` `@tauri-apps/plugin-sql ^2.3.1`（实际 2.4.1）；`src/db/index.ts` `Database.load` |
| lucide-react | 通过 | `package.json:36` `lucide-react ^0.544.0`（实际 0.544.0）；`Titlebar.tsx:18`、`Sidebar.tsx:23-33`、`NoteCard.tsx:22` 等使用 |

---

## 2. 专项核查（captain 指定项）

### 2.1 ✅ 文件导出的真实风险 = 动态 fs 作用域（**已运行验证：生效**）

**前提核对**【读码】：我逐行核对 6 个调用点，确认两端都**没有静态目录读取**，与 architect 的结论一致：

| 调用点 | 代码 | 是否读静态目录 |
| --- | --- | --- |
| `src/lib/export.ts:426` | `save({ title, defaultPath: fileName, filters })` —— `defaultPath` 只是**文件名** | 否 |
| `src/lib/export.ts:445` | `writeTextFile(path, content)`，`path` = 对话框返回值 | 否 |
| `src/features/settings/dataTransfer.ts:127 / 144 / 297 / 306` | `save(...)` / `writeTextFile(selected, …)` / `open(...)` / `readTextFile(selected)` | 否 |

**代码级证据链（动态作用域机制确实存在）**【读码】—— 版本已用 `Cargo.lock` 绑定到真实构建（`tauri 2.11.6` / `tauri-plugin-dialog 2.7.3` / `tauri-plugin-fs 2.5.2`）：

1. `tauri-plugin-dialog-2.7.3/src/commands.rs:248-256`（`save`）与 `:205-214`（`open` 单文件）：拿到用户选中路径后执行 `window.try_fs_scope()` → `s.allow_file(&path)`。
2. `tauri-plugin-fs-2.5.2/src/lib.rs:448-450`：`try_fs_scope()` = `try_state::<Scope>().map(|s| s.scope.clone())`。
3. `tauri-2.11.6/src/scope/fs.rs:52-54`：`#[derive(Clone)] pub struct Scope { inner: Arc<ScopeInner> }` —— **Clone 共享同一个 Arc**；`:370-379` `allow_file()` 把路径压入 `inner.allowed_patterns`。
4. `tauri-plugin-fs-2.5.2/src/commands.rs:1535/1564`：所有 fs 命令都经 `resolve_path()`，其中 `let fs_scope = webview.state::<crate::Scope>()`，判定为 `fs_scope.scope.is_allowed(&resolved_path) || scope.is_allowed(...)`。
5. `tauri-2.11.6/src/scope/fs.rs:419-448`：`is_allowed()` 匹配 `allowed_patterns`。
6. `src-tauri/src/lib.rs:57` 注册了 `tauri_plugin_fs::init()`，所以 fs 插件在运行时**确实**托管了该 `Scope`（否则 `try_fs_scope()` 返回 `None`，动态放行不会发生）。
7. 反向确认「必须有作用域」：`fs:default` 的真实内容是 `[create-app-specific-dirs, read-app-specific-dirs-recursive, deny-default]`（`scripts/verify-acl.mjs` D 段实测），即默认**只放行 app-specific 目录**。

**运行验证（关键）**【实测】：

- 环境：`pnpm tauri:dev` 真实桌面进程（`zhijian` PID 13136，窗口标题「纸笺」，client 尺寸 1100×720，client 原点屏幕坐标 (410,176)）。
- 操作：点击标题栏下方工具条的「导出」→ 菜单「导出为 Markdown」→ 原生保存对话框 → 文件名填入 **绝对路径 `D:\qa-dynamic-scope\zj-export.md`**（`D:` 盘、目录不在任何静态白名单内：白名单只有 appdata/document/download/desktop）→ 保存。
- 结果：**文件真实生成** `D:\qa-dynamic-scope\zj-export.md`，114 字节，内容正确（YAML front-matter + `createdAt/updatedAt`）。
- 结论：**动态 fs 作用域在真实运行环境生效**；「用户把文件存到桌面/下载/文档之外」的导出路径**可用**。此前「缺 `fs:allow-download-read-recursive` 会导致导出失败」的转述**不成立**（该权限确实非必需，保留为无害加固）。

**未覆盖部分**【受限】：`open()`（导入读路径，`dataTransfer.ts:306`）**未单独做运行时复核**。它与写路径共用同一插件机制（同文件相邻代码，均调用 `try_fs_scope().allow_file()`），因此机制已被写路径证伪失败可能；但「读一条非白名单路径的文件」本身我**没有**实测，不写成「通过」。

### 2.2 ✅ 权限标识符核对（**用 JSON 解析，未用 grep**）

方法：`scripts/verify-acl.mjs` 解析 `src-tauri/gen/schemas/acl-manifests.json`，对 `capabilities/default.json` 的每个 `<module>:<id>` 做「最长模块前缀匹配」后在 `permissions / permission_sets / default_permission` 里找**裸标识符**（该文件确实存不带 `fs:` 前缀的裸 id，grep 会得到全 MISSING 的假结果）。

【实测】**通过 56，失败 0**，要点：

- `fs:allow-appdata/document/download/desktop-*-recursive` 全部命中 `fs.permission_sets[...]`；`sql`/`dialog`/`global-shortcut`/`opener` 全部命中；`core:window:*`/`core:app:*`/`core:event:*` 命中 `core:window`/`core:app`/`core:event` 模块。
- **最小权限红线**：`capabilities` 中 **home 相关权限 0 条** ⇒ 不存在「递归读写 `$HOME` = 把整个用户目录交给 webview」的误配（若出现应报 high）。对照：`acl.fs` 里**确实存在** 6 个可被误配的 home 集合（`allow-home-meta/…/allow-home-read`），说明上面的「缺席」是有意义的缺席，不是我查错了名字。
- 附带交叉验证：`cargo check` / `tauri dev` 均通过 —— Tauri 构建期本身会校验 capability，未知权限会直接编译失败，可作为第二重证据。

### 2.3 ✅ 中文搜索真实可用性

`scripts/verify-migrations.mjs` C 段（**独立于仓库自检脚本**，我直接用 `node:sqlite` 把两份迁移应用到全新内存库，再用裸 SQL 断言）【实测】**37/37 通过**：

| 断言 | 结果 |
| --- | --- |
| v1 `notes_fts`（unicode61）`MATCH '笔记'` | **0 命中** ⇒ 确认 v1 表**不能**做中文子串检索 |
| v1 `notes_fts` `MATCH '我的笔记本'`（整词） | 1 命中 ⇒ 连续汉字是单 token 的直接实证 |
| `notes_fts_trigram` `MATCH '笔记'`（2 字） | 0 命中 ⇒ trigram 的硬限制（<3 字符必须走兜底） |
| `notes_fts_trigram` `MATCH '笔记本'`（3 字） | **1 命中** ⇒ ≥3 字符中文子串可用 |
| `notes_fts_trigram` `MATCH '中文检索'`（正文 4 字） | **1 命中** ⇒ 正文也可检索 |
| `LIKE '%笔记%' ESCAPE '\'` | **1 命中** ⇒ <3 字符兜底路径可用 |
| `LIKE '%便签%'`（2 字，正文命中） | 1 命中 |
| 任务书场景：「我的笔记本」能被「笔记」搜到 | **成立**（经 LIKE 路径） |
| trigram 三个同步触发器 | INSERT 后出现、UPDATE 后旧词消失无重复行、DELETE 后清除，全部生效 |
| 重跑两份迁移 | 幂等（trigram 行数 1→1，回填 DELETE+INSERT 重建） |
| `2_fts_trigram.sql` 中 `DROP/ALTER` | 0 处（不修改 v1 已发布对象） |

结论：**v1 unicode61 表确实不用于中文**（它连 2 字子串都查不到），中文检索由「≥3 字走 trigram + <3 字走 LIKE」两条路径共同覆盖。

### 2.4 ✅ 多重迁移源一致性 + 不可变性

**A. 不可变性（最硬的证据）**【实测】：sqlx 把迁移 SQL 的 **SHA-384**（`sqlx-core-0.8.6/src/migrate/migration.rs:25` `Sha384::digest(sql.as_bytes())`）写进 `_sqlx_migrations`。我读取真实开发库记录并对当前 `1_init.sql` 的**原始字节**重新做 SHA-384：

```
✅ 1_init.sql 的 SHA-384 与 _sqlx_migrations 记录逐字节一致
   （11f4026277d0e4c5a881e06b…）⇒ 文件自执行以来未被改动
✅ lib.rs::MIGRATION_SOURCES 只 include_str! 了 ["1_init.sql"]
✅ _zj_migrations 版本 = [1,2]
```

⇒ **`1_init.sql` 自 Rust 迁移器执行后一字未改**（连空白都没动）。**维护风险项**：该文件已被 sqlx 记录 checksum，**任何改动都会让下次启动 checksum mismatch、数据库打不开**；迁移演进**只能在前端 `initDb()` 路径新增 v3**（或先在 Rust 加能力探测再登记）。**禁止「顺手修正」`1_init.sql`**。

**B. 双源双向一致**【实测】：

```
✅ 语句切分：1_init.sql 14 条、2_fts_trigram.sql 6 条（触发器块未被切碎）
✅ SCHEMA_STATEMENTS 无重复（14 条）；每条都能在 1_init.sql 找到（漏 0）
✅ FTS_TRIGRAM_STATEMENTS 无重复（6 条）；每条都能在 2_fts_trigram.sql 找到（漏 0）
✅ 2_fts_trigram.sql 没有 schema.ts 未登记的语句（额外 0 条，回填 INSERT 已登记）
```

⇒ 既**不重复执行**也**不漏执行**。（说明：我第一版脚本按 `;` 裸切分，把 `CREATE TRIGGER … BEGIN … END;` 切碎而误报 3+3+5 处不一致；改为识别触发器块后为 0 —— **误报是我的脚本缺陷，不是产品缺陷**，此处记录以免误导。）

**C. v2 为何不登记给 Rust**【读码】：`2_fts_trigram.sql:24-30` 说明 sqlx 迁移在 `Database.load()` 阶段一次性执行、无「探测失败就跳过」余地，故 v2 由前端 `initDb()` 执行（`optional: true`）。我实测的 `lib.rs` 只登记 v1，与此一致。

### 2.5 ✅ 「用户永远能退出」底线 + 隐藏反馈（E4）

**Rust 侧**【读码 + 实测】：

| 要求 | 结论 | 证据 |
| --- | --- | --- |
| `should_hide_on_close = !is_explicit_quit() && close_to_tray_preference() && 托盘存在`（托盘检查在最后 = 兜底） | 成立 | `window.rs:76-78`，表达式与顺序一致 |
| 偏好 false 时关闭必须真退出 | 成立（代码级） | `lib.rs:72-83`：`should_hide_on_close` 为 false 时**不调用** `api.prevent_close()` ⇒ 窗口放行关闭；且前置 `window::clear_explicit_quit()` |
| 托盘缺失时永不隐藏 | 成立 | 同一表达式第三项 `app.tray_by_id(TRAY_ID).is_some()` |
| 隐藏时 emit `WINDOW_HIDDEN` 且负载含 `reason`/`firstCloseHide` | 成立 | `window.rs:132-145`；`WindowHiddenPayload` `#[serde(rename_all="camelCase")]`（`:57-63`）；单测 `hidden_payload_serializes_camel_case` 断言 `"reason":"close"` 与 `"firstCloseHide":true`（**这 3 个字段名正是前端读取的名字**，见 `lib/tauri.ts:46-50`） |
| **`EXPLICIT_QUIT` 不可逆闩锁已修** | 成立 | `window.rs:89-91` `clear_explicit_quit()`；`lib.rs:81` 在关闭被放行时调用；回归测试 `window.rs:295-302` `clear_explicit_quit_resets_latch` 存在，且 `cargo test --lib` 实测 **12 passed**（含该用例）。该用例的写法是「先 `request_exit()` 断言为 true，再 `clear_explicit_quit()` 断言为 false」—— 若删掉 `clear_explicit_quit` 的实现（旧实现），断言必失败，因此**确实会失败于旧实现** |
| 关闭按钮 → 隐藏（后台常驻） | **运行验证通过** | Alt+F4 后 `IsWindowVisible(主窗口 hwnd)=False` 且进程存活；`Alt+Shift+Z` 后 `IsWindowVisible=True`（§1(k)） |
| 唯一真退出路径 | 成立 | `tray.rs:143-148`：`request_exit → unregister_all → remove_tray_by_id → exit(0)`；托盘菜单「退出纸笺」是唯一入口 |

**前端侧**【读码】：

| 要求 | 结论 | 证据 |
| --- | --- | --- |
| `<CloseToTrayNotice />` 必须在 `<ToastProvider>` 内挂载且**只挂一次** | **成立** | `App.tsx:84-90`：`<ToastProvider>` → `<CloseToTrayNotice />` + `<AppShell />`。全仓 grep `CloseToTrayNotice` 共 3 类位置：定义（`CloseToTrayNotice.tsx:40`）、导出（`features/settings/index.ts:32`）、唯一挂载点（`App.tsx:88`）⇒ **只挂一次**，且 t7 已删掉手写重复实现（`App.tsx:158-159` 注释亦声明此处不重复实现） |
| 启动时必须向 Rust 同步一次偏好 | 成立 | `CloseToTrayNotice.tsx:44-46` `useEffect(() => { void syncCloseToTrayPreference() }, [])` → `closeToTray.ts:105-118`（默认读 `readCloseToTray()`，非 Tauri 静默跳过） |
| 仅在 `reason==='close' && firstCloseHide` 弹一次 | 成立 | `closeToTray.ts:75-85`：`autoShow` && payload && `payload.reason !== 'close'` 直接 false && `firstCloseHide === true`；payload 缺失/`reason` 非法时**不弹** |
| 文案含找回方式 + 真退出方式 | 成立 | `closeToTray.ts:39-41`：包含「单击托盘图标（或按 Alt+Shift+Z）可重新显示」与「要真正退出，请用托盘菜单的「退出纸笺」」 |
| `tray`/`toggle` 不弹 | 成立 | 同 `closeToTray.ts:82`（`reason !== 'close'` → false） |
| StrictMode 双挂载下不会弹两条、卸载后监听器归零 | 成立（代码级） | `closeToTray.ts:147-229`：模块级 `activeUnsubscribe` + `activeHolders` 引用计数；**先同步占位再 await**（`:185`）避免并发双订阅；`:203-207` 句柄返回时若持有者已归零则立刻退订。`main.tsx:18` 确认 StrictMode 已启用，故该防护是必需的 |

**未做**【受限】：Toast 的**视觉**确认不可得 —— 隐藏后窗口不可见，提示渲染在刚被隐藏的窗口里；我无法在不重启进程的前提下重新触发 `firstCloseHide=true`（Rust 侧 `FIRST_HIDE_NOTIFIED` 是进程级一次性 `swap`），故未截图证明 Toast 真的出现过。此点**只到代码级**。

### 2.6 ✅ mark 高亮样式真相（**captain 早期转述有误，代码为准**）

【实测】`scripts/verify-stores-and-silent-noops.mjs` 扫描全部 `src/**/*.css`：**全局 `mark { background: … }` 规则 0 命中**。captain 转述的「全局 mark 规则」**不存在**；`docs/INTEGRATION-STATUS.md:84` 关于 `mark { background: var(--zj-selection) }` 的说法与代码不符。

真实链路【读码】：`NoteCard.tsx:165` `[&_mark]:rounded-zj-sm [&_mark]:bg-selection [&_mark]:text-text` → `src/index.css:36` `--color-selection: var(--zj-selection)` → `theme.css` 各主题定义 → 颜色确实来自 `--zj-selection`（实测 `paper-yellow` 下 `--zj-selection = #f0e3bc`、`ink-green` 下 `#d2e0ce`）。高亮**可见**（有 token 类提供背景与前景色）。

补充（文档与实际的一致性）：`NoteCard.tsx:16` 的注释仍写「与全局 `mark` 规则同源」——**该注释不准确**（不存在全局规则）；t7 的文档表述（「不要再补全局兜底」）才是对的。

### 2.7 ✅ snippet 渲染链路 + byFolder 计数

【读码】

- `src/db/search.ts:57-86` `escapeHtml`（转义 `& < > "`）**先转义再插 `<mark>`**，`snippet` 是受控可信 HTML。
- `NoteCard.tsx:161-168`：`snippet` 有值时用 `dangerouslySetInnerHTML={{ __html: snippet }}` **单次渲染**；`plainSummary()` 分支用于无 snippet 时（走文本子节点，不转义二次）。全仓未发现对 snippet 的二次转义（`escapeHtml` 只在 db 层调用）。
- `NoteCounts.byFolder` **不含收件箱键**：`Sidebar.tsx:19-20` 与 `util.ts::inboxCount` 明确用 `all − Σ(byFolder)`；【实测】`pnpm check:db` B5「counts：all / trash / byFolder / byTag」通过。

### 2.8 ✅ store 真实性 + 占位残留

【实测】`scripts/verify-stores-and-silent-noops.mjs` A 段 **14/14 通过**：

```
✅ useNotesStore / useSearchStore / useUiStore / useThemeStore
   均为真实 zustand：getState/setState/subscribe 均为函数
✅ 四者冻结字段/方法全部存在（缺失 0 个）
✅ I1 回归：openSettings() 后 view=settings、settingsOpen=true
✅ closeSettings() 后 settingsOpen=false、view=all
✅ themeStore 无持久化时默认 themeId=paper-yellow / mode=light
```

`notImplemented` 残留【实测】：全仓 grep 命中 **3 处**，其中 2 处是 `docs/ARCHITECTURE.md:895/914`（这两处文档称 `notesRepo` 方法仍为 notImplemented 占位 —— **文档已过期**，实际已是真实实现），另 1 处是 `src/db/errors.ts:31/35` **定义本身**。⇒ **src 下 notImplemented 调用点 = 0**，不存在运行期占位。

> 如实说明：任务书要求「任何残留按 blocker 报出」。我按证据处理：它是**零调用点的死代码导出**（不可能是运行期占位），因此我**不报 blocker**，改列 low（§5.4）并附文档过期说明。这是与任务书措辞的有意偏差，理由即证据本身。

---

## 3. 我新增/清理了什么（可追溯）

- 新增（**仅验证用，不参与打包**）：
  - `scripts/verify-acl.mjs` —— ACL 标识符 JSON 解析核对（56/56）
  - `scripts/verify-migrations.mjs` —— sqlx checksum 反证 + 双源双向比对 + FTS5/中文检索（37/37）
  - `scripts/verify-stores-and-silent-noops.mjs` —— store 真实性 + silent no-op 缺陷扫描（14 通过 / 5 缺陷）
  - `docs/QA-REPORT.md` —— 本报告
- 运行验证期间产生的临时物（**已全部删除**）：6 条测试笔记（DB 已恢复 0 笔记 / 0 文件夹 / 0 标签，并已 `wal_checkpoint(TRUNCATE)`）、`D:\qa-dynamic-scope\`、`C:\qa-dynamic-scope\`、`~/Downloads/qa-*.png` 截图、浏览器 `localStorage` 中的主题键。
- **未改动任何业务实现文件**（`src/**`、`src-tauri/**`、配置文件一字未动）。

---

## 4. 桌面运行验证的原始记录（`pnpm tauri:dev`，非推断）

### 4.1 启动与日志

```
Running BeforeDevCommand (`pnpm dev`) → vite ready in 266 ms
Compiling zhijian v0.1.0 → Building 452/452 → Finished `dev` profile in 13.98s
Running `target\debug\zhijian.exe`
[纸笺] event: zhijian://window-shown / window-hidden / new-note-requested / open-settings-requested / app-quit-requested
[纸笺] 系统托盘已就绪（关闭按钮 = 隐藏到托盘）
[纸笺] global shortcuts: Alt+N=alt+KeyN, Alt+Shift+Z=shift+alt+KeyZ
[纸笺] 全局快捷键已注册：Alt+N / Alt+Shift+Z
```

### 4.2 窗口与「关闭 = 隐藏」【实测】

```
STEP1  hwnd=198296 title='纸笺' visible=True
STEP2 after Alt+F4 : visible(hwnd=198296) = False | 进程仍存活 = True
STEP3 after Alt+Shift+Z : visible(hwnd=198296) = True
```
（附注：窗口隐藏时 .NET `Process.MainWindowHandle` 会指向另一个可见的辅助窗口 —— 上表用**同一 hwnd** 的 `IsWindowVisible` 判定，避免误判。）

### 4.3 Alt+N（含缺陷复现）【实测】

```
notes before = 0
AppActivate('纸笺') = True → SendKeys('%n') → notes after = 2
（第二次）before = 2 → SendKeys('%n') → after = 4
created_at 分组: [{"created_at":1790347175045,"c":2},{"created_at":1790347192245,"c":2}]
```
每次按键**成对**产生两条笔记，且同一对 `created_at` 完全相同（同一毫秒）⇒ 一次事件被两个回调在同一同步批次里各处理一次。

### 4.4 导入/设置面板（I1 回归）【实测】

浏览器运行中点击**标题栏「设置」按钮** → 设置面板完整出现（外观 / 行为 / 快捷键 / 数据 / 关于），说明 `openSettings()` 的 `view:'settings'` 修复有效（I1 未回归）。同一路径在代码上为 `Titlebar.tsx:83 onOpenSettings` → `App.tsx:448 openSettings` → `ui.ts:91-98`。

### 4.5 主题【实测】

```
清空 localStorage 后：data-theme="paper-yellow" class="light" --zj-bg="#fdf8ec" bodyBg="rgb(253,248,236)"
点击「墨绿」后：       data-theme="ink-green"   --zj-bg="#f3f6f2"  localStorage['zj:theme']={"themeId":"ink-green","mode":"light"}
```

### 4.6 编辑/预览/自动保存【实测】

```
DB after typing: [{title:"", content:""},
                  {title:"QA_title_probe", content:"# QA_autosave_probeheading\n- itemone- itemtwo"}]
```
- 标题输入 → `onTitleChange` → 防抖 → `notesStore.update` → **SQLite 落库 `QA_title_probe`** ✔
- 正文输入（CM6）→ `onContentChange` → **SQLite 落库** ✔
- 预览窗格截图：`# …` 渲染为**大号粗体标题**、`- …` 渲染为**• 项目符号列表**（Markdown → HTML 生效）✔
- （说明：SendKeys 吞掉了空格与部分换行，因此落库文本形如 `probeheading`、`itemone- itemtwo`；这是**我的自动化输入方式**所致，与应用无关。第一轮我把标题输入框点偏到「N 字」统计上导致标题未写入，改正坐标后即写入 —— 属**我的操作失误**，已排除为应用缺陷。）

### 4.7 导出到非白名单目录【实测】

（见 §2.1）`D:\qa-dynamic-scope\zj-export.md` 真实生成，114 字节，内容正确。

---

## 5. 问题清单（按严重度）

> 只列**真实可复现**的问题。每条给最小复现。共 6 条：high 1、medium 3、low 2。

### 5.1 🔴 D1（high）：一次 Alt+N 创建**两条**笔记 —— 事件被双重订阅

**现象**：按一次 `Alt+N`，数据库里出现 **2** 条空白笔记（成对、`created_at` 同毫秒）。

**根因**【读码】：`zhijian://new-note-requested` 被注册了**两个** listener，且都绑定到 App 的同一个 `createNote`：

- `src/App.tsx:166-168`：`listen(EVENTS.newNoteRequested, () => { void createNote() })`
- `src/lib/hotkeys.ts:185`：`listen(EVENTS.newNoteRequested, () => runNewNote())`，其中 `runNewNote` 在 App 传入 `newNote` 时直接调用它 —— `src/App.tsx:195-199` 传的正是 `newNote: () => createNote()`。

Rust 侧一次 Pressed 只 emit 一次（`shortcuts.rs:41-47`），所以「1 次按键 → 2 条笔记」完全由此解释。**已排除**其它可能：StrictMode 双挂载若泄漏会得到 4 条，实测稳定为 2 条；两次独立按键的 `created_at` 分组恒为 2 条/组。

**最小复现**：
1. `pnpm tauri:dev`，等窗口出现；
2. 记录 `SELECT COUNT(*) FROM notes`（记为 n）；
3. 发一次 `Alt+N`（或点标题栏「新建」不适用；全局快捷键与托盘菜单「新建笔记」都会走该事件）；
4. 再查：计数 = n + **2**，两条 `title=''`、`content=''`。

**影响**：用户原始需求 (j) 的直接功能缺陷；每次新建都留一条空白垃圾笔记，并可能造成「列表里两条空笔记，不知道在编辑哪条」的困惑。**这是本报告建议在发布前修复的首要项**（修法：二选一 —— 去掉 `App.tsx:166` 的重复监听，或不再把 `newNote` 传给 `bindGlobalHotkeys`）。

### 5.2 🟠 D1b（medium）：另外两个事件也被双重订阅

`openSettingsRequested`：`App.tsx:169`（→ `openSettings()`）与 `hotkeys.ts:186`（→ `uiStore.setView('settings')`）；`appQuitRequested`：`App.tsx:172`（→ Toast）与 `hotkeys.ts:187`（→ 派发 `zhijian:quit-requested` 自定义事件）。

**现状影响低**（两者都幂等/无副作用），但**是同一缺陷模式的第二次现身**，与 D1 同因同修更划算。另注：`hotkeys.ts:189` 派发的 `zhijian:quit-requested` **全仓无 listener**（grep 0 命中）——「给前端一次收尾机会」的机制目前无人消费。

**最小复现**：`grep -n "listen(EVENTS.openSettingsRequested" src -r` → 2 处；`node scripts/verify-stores-and-silent-noops.mjs` → 报 `D1b`。

### 5.3 🟠 D2（medium）：「应用内快捷键」列表里 3 个快捷键**根本没有绑定**

`src/features/settings/SettingsPanel.tsx:581-584` 向用户宣称：「应用内：Ctrl+K 搜索 · Ctrl+S 保存 · **Ctrl+E 切换预览** · **Ctrl+B 折叠侧栏** · **Ctrl+Delete 移到回收站**」。而唯一实现 `LOCAL_SHORTCUTS` 的绑定器 **`bindShortcuts()`（`src/lib/hotkeys.ts:84`）零调用方**（grep 排除注释后 0 命中）。实际可用性：

| 快捷键 | 声明 | 实际 |
| --- | --- | --- |
| Ctrl+K 搜索 | 有 | ✅ 由 `SearchBox.tsx:116-126` 自己的 listener 实现（实测：合成 keydown 后焦点变到「搜索笔记」输入框） |
| Ctrl+S 保存 | 有 | 仅当**焦点在编辑器内**由 CM6 keymap `CodeMirrorEditor.tsx:131` `Mod-s` 处理；列表/标题栏聚焦时无效 |
| Ctrl+E 切换预览 | 有 | ❌ 无任何绑定 |
| Ctrl+B 折叠侧栏 | 有 | ❌ 无任何绑定（实测：合成 `ctrl+b` 后 `<aside>` class 仍为 `w-56`，未折叠） |
| Ctrl+Delete 移到回收站 | 有 | ❌ 无任何绑定（`NoteCard.tsx:112` 菜单里还把它当快捷键提示展示） |

**最小复现**：浏览器模式 `pnpm dev` → 打开页面 → 在页面里派发 `ctrl+b`/`ctrl+e` → 侧栏宽度与视图不变；对照派发 `ctrl+k` → 搜索框获得焦点。或直接跑 `node scripts/verify-stores-and-silent-noops.mjs`（`D2`）。
**影响**：用户在设置面板看到的能力有三项不存在（违背「不静默失效」的项目纪律）；不属 13 项需求，故不阻断发布，但应修文案或补绑定。

### 5.4 🟠 D3（medium）：设置项「笔记列表默认排序」被持久化但**无人消费**

`SettingsPanel.tsx:490-496` 写入 `preferences.setDefaultSort(value)`（→ `localStorage['zhijian.defaultSort']`），并调用**可选** prop `onDefaultSortChange?`；而 `App.tsx:471-489` 的 `<NoteList>` **既没传 `onDefaultSortChange`，也没传 `defaultSortMode`**（`NoteList.tsx:56/76` 该 prop 默认 `'order'`）。

**实测复现**：设置里把「笔记列表默认排序」改为「最近修改/创建时间」→（浏览器模式）`localStorage['zhijian.defaultSort'] = "createdAt"`，但列表头仍显示「排序：手动」，重启后也不生效。
**影响**：典型「值被写了但没人消费」的静默失效（不属 13 项需求，故不阻断；修法：`App.tsx` 给 `<NoteList>` 传 `defaultSortMode={readDefaultSort()}`，或在面板里去掉该项）。

### 5.5 🟡 D4（low）：主 chunk 1.14 MB（gzip 376 kB）

【实测】生产 `pnpm vite:build` 主 chunk `1,137.70 kB`（gzip 375.97 kB），超过 Vite 500 kB 警告线 2 倍以上；Shiki 语言/主题已正确拆分为独立 chunk（18 个），但 React19 + ReactDOM + CM6 + react-markdown + 应用代码仍在同一 chunk。桌面应用从本地加载，影响有限（首次渲染前的解析时间），故列 low。建议 `build.rollupOptions.output.manualChunks` 按 vendor 拆分。

### 5.6 🟡 D5（low）：保存状态指示器恒为「已保存」；空标题时标题栏显示「未选择笔记」

【读码】`App.tsx:443` 把 `saved` 写死为真、`:496` 把 `dirty` 写死为 `false`，因此 `Titlebar.tsx:63-79` 的「未保存」分支**永远不可达**（t7 注释说明是「自动保存由编辑器内部驱动」的有意取舍）。另：`Titlebar.tsx:33` 在 `title.trim()===''` 时显示「未选择笔记」，而新建笔记正是空标题 —— 实测桌面截图里已选中一条空标题笔记时，标题栏仍显示「未选择笔记」，与左侧列表的「无标题」不一致，易让人误以为没有选中。二者都属 UI 表述问题，不涉及数据正确性。

### 5.7（信息）死代码/无人消费的公开 API（**不算缺陷**）

- `src/db/errors.ts:35` `notImplemented()` —— 零调用点（§2.8）。
- `src/features/settings/closeToTray.ts:232` `hasActiveCloseToTrayNotice()`、`src/store/search.ts:131-152` `selectSnippets/selectResultNotes/selectRanks/resetSearch`、`src/lib/appPreferences.ts:116-141` `readWindowBounds/writeWindowBounds` —— 外部引用 0 处。其中 `windowBounds` 的读写 API 齐全但**无人写入**（窗口尺寸不记忆），但「记忆窗口尺寸」不在用户需求内。
- `src/lib/tauri.ts:29` `EVENTS.windowShown` 有定义、Rust 会 emit，但前端无 listener（当前无功能需要它）。
- 文档过期：`docs/ARCHITECTURE.md:895/914` 声称 `notesRepo` 的 12 个方法仍是 `notImplemented` 占位（实际已实现）；`src/features/sidebar/search-store.ts:12-14` 仍称 `src/store/search.ts` 是「占位实现（useSearchStore() 直接 throw）」（实际已是真实 zustand）；`NoteCard.tsx:16` 声称存在「全局 mark 规则」（实际不存在）。

---

## 6. 未验证 / 环境受限清单（**不写成「通过」**）

| 项 | 原因 | 已给出的替代证据 |
| --- | --- | --- |
| 托盘图标的**鼠标点击**（左键切换显隐）、右键菜单 5 项的点击、托盘菜单「新建笔记/设置/退出纸笺」 | 无法在无人工介入的情况下可靠命中托盘图标（任务栏溢出区），且误点风险高 | 【读码】`tray.rs:65-85`（左键 Click=Up→`toggle_visible`、DoubleClick→`show_main`、`show_menu_on_left_click(false)`）、`:114-140`（菜单项到事件/退出的完整分支）。`toggle_visible` 的显隐效果已由 §4.2 的 `Alt+Shift+Z` 实测间接覆盖（同一函数） |
| 需求 (h) 的**鼠标拖拽**排序 | 本机桌面自动化无法稳定把应用窗置于前台完成一次真实拖拽 | 【读码】`NoteList.tsx:100-122/202-235` + `App.tsx:376-381` 接线完整；【实测】`pnpm check:db` B4 六条 move 断言全绿（整数重排/越界/跨文件夹） |
| 导入（`open()` 读路径）到非白名单目录 | 需再走一遍设置面板滚动+原生对话框的多步点击，风险收益不划算 | 与已实测通过的写路径**共用同一插件机制**（§2.1 步骤 1/2 同文件相邻代码，均 `try_fs_scope().allow_file()`） |
| 「关闭到托盘」开关置 false 后**关闭即退出** | 需点击设置面板开关再关闭窗口 | 【读码】`lib.rs:72-83`：`should_hide_on_close` 为假时不 `prevent_close()`；`SettingsPanel.tsx:514-519` 双写下发（localStorage + Rust）—— 实测 `cmd_close_to_tray_enabled` 的调用链与 E4 的启动同步均已按代码核对 |
| 隐藏时 Toast 的**视觉**确认（`firstCloseHide`） | `FIRST_HIDE_NOTIFIED` 是进程级一次性标志，进程内无法二次触发 | 【读码】`closeToTray.ts:75-85` + `CloseToTrayNotice.tsx:49-76` + Rust payload 单测【实测】 |
| CodeMirror 语法着色、Shiki 代码块高亮、表格/任务列表/删除线的**渲染外观** | 未逐项人工目视核对 | 【读码】`markdownHighlight.ts`、`shikiHighlighter.ts`、`MarkdownPreview.tsx`；【实测】构建产物中 Shiki 各语言确为独立 chunk；预览标题+列表已目视确认 |
| 打包产物（`msi`/`nsis`）安装运行 | 未执行 `pnpm tauri:build`（耗时且非本次验收要求） | 配置核对：`tauri.conf.json:46-65` targets=[msi,nsis]、图标齐全 |

---

## 7. 结论：能否作为可用 v0.1 交付？

**总体判断：功能面完整、架构与数据层质量高，但存在 1 个建议在发布前修复的 high 级缺陷；修掉 D1 即可作为 v0.1 交付。**

**正面结论（有实测支撑）**

- 13 项用户需求**全部实现**：11 项「通过」，1 项「部分」(h，仅缺 UI 拖拽目视复核)，0 项「未实现」。
- 技术栈 12 项**全部符合**，且安装版本均满足要求（React 19.3.0 / Vite 7.3.6 / Tailwind 4.3.3 / Shiki 3.23.0 / Zustand 5.0.15 / tauri 2.11.6）。
- 五道门全绿，且我做了**独立复算**：`typecheck` 0、`vite:build` 0（2128 modules）、`check:rust` 0 warning（含一次**全量重编译**佐证）、`check:db` 54/54、`cargo test --lib` 12 passed；我另加的三套独立脚本分别 56/56、37/37、14 通过。
- 高风险面被实测攻破：**中文检索双路径真实可用**（trigram ≥3 字、LIKE <3 字、v1 unicode61 确认不用于中文）；**动态 fs 作用域真实生效**（导出到 `D:\…` 非白名单目录成功落盘）；**关闭=隐藏+进程常驻+可找回**；**`1_init.sql` 的 sqlx checksum 逐字节一致**（不可变性有硬证据）；**ACL 无 MISSING、无 `$HOME` 越权**；四个 store 均为真实 zustand；`notImplemented` 零调用点。

**阻断项（发布前必须处理）**

1. **D1（high）**：一次 Alt+N 建 **2** 条笔记（`App.tsx:166` 与 `hotkeys.ts:185` 双订阅同一事件）。这是用户原始需求 (j) 的直接功能缺陷，每次新建都产生一条用户不想要的空笔记，且与 D1b（另两个事件同样双订阅）**同因，建议一并修**（去掉 App 侧重复监听即可，改动极小）。

**建议同批修复（不阻断，但属「用户看到的能力不存在」）**

2. **D2（medium）**：设置面板宣称的 Ctrl+E / Ctrl+B / Ctrl+Delete 三个应用内快捷键**零绑定**（`bindShortcuts()` 无调用方）—— 要么接线，要么改文案。
3. **D3（medium）**：设置项「笔记列表默认排序」写入后无人消费 —— 要么把 `defaultSortMode` 接到 `<NoteList>`，要么移除该项。

**不阻断但建议记录**

4. D4（low）主 chunk 1.14 MB，建议 manualChunks 拆分。
5. D5（low）保存状态指示器恒为「已保存」；空标题笔记时标题栏显示「未选择笔记」（与列表的「无标题」不一致）。
6. 维护风险：**`1_init.sql` 永久只读**（sqlx checksum 已记录），迁移演进只能新增 v3；`docs/ARCHITECTURE.md` 与若干注释已过期（§5.7），建议随修复一并订正。
7. 发布前需人工补做的验收面：托盘图标鼠标交互、需求 (h) 的真实拖拽、导入（读）到非白名单目录、关闭开关置 false 的行为 —— 四项均已在 §6 标注原因与替代证据。

---

# 8. 修复记录（t9，架构师）

> 依据 captain 的裁定执行；captain 明确授权跨归属直接修（收尾阶段其他成员均 idle，无并行写冲突）。
> **红线遵守**：`src-tauri/migrations/1_init.sql` **一字未改**（见 8.7 的 SHA-384 反证）。
> 每项给出「根因 → 修法 → 复验证据」；**未修项在 8.9 单独列出，不静默跳过**。

## 8.1 ✅ D1（high）一次 Alt+N 创建两条笔记

- **根因**：`zhijian://new-note-requested` 被**两个** listener 订阅，且都指向同一个 `createNote`：
  `src/App.tsx:166`（t7 我加的）与 `src/lib/hotkeys.ts:185`（`bindGlobalHotkeys` 内）。
  Rust 侧一次 Pressed 只 emit 一次，所以「1 次按键 → 2 条笔记」完全由此解释。
- **修法**：**删除 App 侧对三个热键事件的重复订阅**，职责收敛为「热键类事件只由 `hotkeys.ts` 订阅」。
  App 现在只保留 1 个消费：Rust `appQuitRequested` → hotkeys 派发 `zhijian:quit-requested` → App 弹 Toast。
  （保留了 t13 的成果：`<CloseToTrayNotice />` 及其启动下发**未被触碰**。）
- **复验证据**：
  - 命令：`Get-ChildItem src -Recurse | Select-String "listen\(EVENTS\.(newNoteRequested|openSettingsRequested|appQuitRequested)"`
    → **每个事件各 1 处**，全部位于 `src/lib/hotkeys.ts:193/194/195`。
  - 命令：`node scripts/verify-stores-and-silent-noops.mjs`
    → `✅ new-note-requested 只被订阅一次（1 处）`、`事件 openSettingsRequested 订阅次数 = 1`、`事件 appQuitRequested 订阅次数 = 1`
    → 该脚本从 **14 通过 / 5 缺陷** 变为 **19 通过 / 0 缺陷**。
- **⚠️ 运行时端到端测量的限制（如实说明，未达成）**：
  本次会话**无法可靠注入合成键击**（`AppActivate` 返回 False；改用 `AttachThreadInput + SetForegroundWindow`
  确认目标窗口 `IsFg=True`、`class=Tauri Window`，但 `SendKeys`/`keybd_event` 仍**未被送达**；
  重置数据库后连发 6 次，仅 1 次短时前台时成功送达）。
  该次**唯一成功送达**的观测结果：**1 次按键 → 1 条空笔记**（`created_at` 分组 `[{c:1}]`），
  而同一环境在 QA 复现该缺陷时是 **2 条/组**。
  ⇒ **运行时证据方向正确但不充分**；本项的确定性结论由「订阅数恒为 1」这一代码级事实保证
  （缺陷的**唯一**成因就是双订阅）。**建议**：由能在真实交互桌面注入输入的会话（或人工）
  按 QA §5.1 的最小复现补一次 `连按 3 次 → 恰好 3 条` 的确认。

## 8.2 ✅ D1b（medium）另两个事件同样双订阅 +「emit 但无人听」

- **根因**：同 D1；`openSettingsRequested`/`appQuitRequested` 也各被订阅 2 次。
  另 `hotkeys.ts:189` 派发 `zhijian:quit-requested` 后**全仓无 listener**。
- **修法**：随 8.1 一并去除 App 侧重复订阅。`zhijian:quit-requested` **保留 emit 并补上消费方** ——
  `src/App.tsx` 新增 `QUIT_REQUESTED_EVENT` 常量与唯一 listener（弹「正在退出纸笺」Toast）。
- **复验证据**：命令 `Get-ChildItem src -Recurse | Select-String 'quit-requested'`
  → 现在同时有**生产者**（`hotkeys.ts:197`）与**消费者**（`App.tsx:49` 常量 + `App.tsx:180` 附近 `addEventListener`）；
  QA 脚本不再报 `D1b`。

## 8.3 ✅ D2（medium）Ctrl+E / Ctrl+B / Ctrl+Delete 零绑定

- **根因**：`LOCAL_SHORTCUTS` 声明了这些键，但唯一实现 `bindShortcuts()`（`lib/hotkeys.ts:84`）**零调用方**；
  设置面板却向用户宣称可用（违背「不静默失效」纪律）。
  另发现 **Ctrl+B 与编辑器冲突**：CodeMirror 用 `Mod-b` 做加粗（`CodeMirrorEditor.tsx:124`），
  编辑器内焦点时会把该键吃掉，故侧栏折叠在编辑器里永远不生效。
- **修法**：
  1. `src/App.tsx` 新增 `bindShortcuts()` 调用（唯一调用方），真正绑定三个动作：
     `Ctrl+E` → 切换编辑器预览、`Ctrl+\` → 折叠/展开侧栏、`Ctrl+Delete` → 弹**二次确认**后移入回收站。
  2. **Ctrl+B 冲突按 captain 裁定规避**：`LOCAL_SHORTCUTS.toggleSidebar` 由 `Ctrl+B` 改为 **`Ctrl+\`**
     （`src/lib/hotkeys.ts:30-40`，注释说明为何不得改回 Ctrl+B）。
  3. `src/features/settings/SettingsPanel.tsx:581-586` 文案同步更正为 `Ctrl+\`，并加一行说明
     「编辑器内 Ctrl+B 是加粗，故侧栏折叠用 Ctrl+\」。
  4. `Ctrl+Delete` 用既有 `ConfirmDialog`（`notes-list`）二次确认，`confirmLabel='移到回收站'`
     （默认值是「彻底删除」，与本动作语义不符）。回收站视图下该快捷键**不动作**（那里应是「恢复」）。
- **未绑定说明（有意）**：`Ctrl+K` 已由 `SearchBox` 自行监听、`Ctrl+S` 已由编辑器 keymap 处理，
  **故不在 App 重复绑定**，以免再造一处「同一动作双订阅」（正是 D1 的成因）。
- **复验证据**（浏览器 `pnpm dev`，合成 `KeyboardEvent` 派发到 window）：
  - `Ctrl+\`：`<aside>` 宽度 **224px → 48px → 224px**（折叠/展开均生效）✅
  - `Ctrl+B`：宽度 **224px → 224px**（不再劫持侧栏；让位给编辑器加粗）✅
  - 设置面板文案：`应用内：Ctrl+K 搜索 · Ctrl+S 保存 · Ctrl+E 切换预览 · Ctrl+\ 折叠侧栏 · Ctrl+Delete 移到回收站（需确认）。`
    且**不再出现** `Ctrl+B 折叠` ✅
  - QA 脚本：`✅ bindShortcuts() 有 1 个调用方：src/App.tsx:192`

## 8.4 ✅ D3（medium）「默认排序」被持久化但无人消费

- **根因**：`SettingsPanel` 写入 `localStorage['zhijian.defaultSort']`，但 `<NoteList>` 既没接
  `defaultSortMode` 也没接 `onDefaultSortChange`（`NoteList.tsx:76` 默认 `'order'`）⇒ 典型「值写了没人读」。
- **修法**：`src/App.tsx` 引入 `readDefaultSort()`（`lib/appPreferences.ts`），
  用 `useState(() => readDefaultSort())` 取一次并传给 `<NoteList defaultSortMode={...}>`。
- **复验证据**：命令 `Select-String src/App.tsx -Pattern 'readDefaultSort|defaultSortMode'`
  → `L31 import`、`L135 const [defaultSortMode] = useState(() => readDefaultSort())`、`L514 defaultSortMode={defaultSortMode}`
  → QA 脚本：`✅ 默认排序偏好已接到列表：src/App.tsx:514`
- **已知语义限制（如实记录）**：`NoteList` 用 `useState(defaultSortMode)` 作为**初始**排序模式，
  因此设置里改完需**重新挂载列表**（切换视图）才生效，不是即时热更新。
  这符合「默认排序」的语义（默认值，而非强制排序），故**按原设计保留**；若需即时生效，
  应改为受控 props（属功能变更，不在本次修复范围）。

## 8.5 ✅ D5（low，P2）保存态恒「已保存」+ 空标题显示「未选择笔记」

- **根因**：`App.tsx` 把 `saved` 写死为真 ⇒ `Titlebar.tsx:68` 的「未保存」分支**永不可达**。
- **修法**：给 `EditorPane` 增加**可选** prop `onSaveStateChange`（`EditorPaneComponentProps`，
  非冻结契约字段），把内部 `useAutoSave` 的真实状态上报（`saved` + 与工具条徽标一致的 `label`）；
  `App.tsx` 用 `useCallback` 稳定引用接收并驱动 `Titlebar saved={saveState.saved}`。
  同时把 `Titlebar title` 由 `appliedNote?.title ?? ''` 传入 —— 空标题笔记经 `Titlebar.tsx:33`
  的既有逻辑显示「未选择笔记」，**未选中**同样如此。
- **复验证据**：命令 `Select-String src/App.tsx -Pattern 'saveState|onSaveStateChange|saved='`
  → `L133` 状态、`L374-375` 稳定回调、`L467 saved={saveState.saved}`、`L531 onSaveStateChange={...}`；
  `pnpm typecheck` exit 0（新 prop 为可选，不破坏只传 `EditorPaneProps` 的编译）。
- **⚠️ 部分未达成（如实说明）**：标题栏在**空标题**笔记上仍显示「未选择笔记」。
  我选择**不做**这个字符串改动，理由：`Titlebar.tsx` 属 shell，且该文案与「真正未选中」**无法区分**
  （`TitlebarProps.title` 只有一个 string），要区分必须**新增 prop**或改冻结组件；
  两者都超出「最小改动」授权，且属纯文案问题（列表卡片已正确显示「无标题」，不会误导数据）。
  **建议**：如确需区分，新增可选 prop `hasSelection?: boolean` 或把空标题归一化为「无标题」再传入。

## 8.6 ✅ §5.7 过期文档订正（维护风险）

| 位置 | 原（过期）表述 | 订正为 |
| --- | --- | --- |
| `docs/ARCHITECTURE.md:895-898` | `notesRepo` 等仍「显式 notImplemented 占位」 | **已全部实现**（t3；自检 54/54） |
| `docs/ARCHITECTURE.md:913-915` | 说明 db/store「骨架期为签名占位」 | 划删除线并标注**已过期（t9 订正）**：`notImplemented()` 在 `src/**` **零调用点** |
| `src/features/sidebar/search-store.ts:12-14` | `search.ts`「仍是占位实现（直接 throw）」 | 标注**已是真实 zustand store**，形状探测降级为防御性代码 |
| `src/features/notes-list/NoteCard.tsx:15-16` | 「与全局 `mark` 规则同源」 | 订正：**不存在全局 `mark` 规则**，高亮只由该处消费端 token 类提供 |

## 8.7 ✅ 红线：`1_init.sql` 未被改动（反证）

- 命令：`Get-FileHash src-tauri/migrations/1_init.sql -Algorithm SHA384`
  → `11F4026277D0E4C5A881E06B740043C0F6BA7B8B5AF4D079861446DCCC5F03311DA7E81A2F8739805785A40935D7527D`
- 命令：`node scripts/verify-migrations.mjs` → **迁移/检索核对：通过 37，失败 0**
  （含 sqlx checksum 逐字节反证、双源双向一致、FTS5/中文检索行为断言）
- 文件 `LastWriteTime` = **2026/9/25 21:06:34**（自创建起未被本次修复触碰）。
- 本次**未对 `src-tauri/**` 做任何改动**。

## 8.8 全部质量门复验（修复后）

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | ✅ exit 0 |
| `pnpm vite:build` | ✅ exit 0（`✓ built`） |
| `pnpm check:rust` | ✅ exit 0，0 warning |
| `pnpm check:db` | ✅ 54/54 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | ✅ 12 passed |
| `node src/features/settings/__checks__/run-checks.mjs` | ✅ 26/26 |
| `node scripts/verify-stores-and-silent-noops.mjs`（QA） | ✅ **19 通过 / 0 缺陷**（原 14 通过 / 5 缺陷） |
| `node scripts/verify-acl.mjs`（QA） | ✅ 56/56 |
| `node scripts/verify-migrations.mjs`（QA） | ✅ 37/37 |

## 8.9 未修项与遗留限制（**不静默跳过**）

| # | 项 | 原因 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| U1 | **D1 的运行时端到端测量未达成** | 本会话无法可靠注入合成键击（`AppActivate` False；`AttachThreadInput+SetForegroundWindow` 后 `IsFg=True` 但 SendKeys/keybd_event 仍未送达；6 次仅 1 次送达） | 缺「连按 3 次 → 恰好 3 条」的实测数字 | 由具备真实交互桌面的会话或**人工**按 QA §5.1 复现确认。代码级已确定性排除（订阅数恒 1） |
| U2 | **D4（low）主 chunk 1.14 MB** | captain 裁定「不修，记录即可」：桌面本地加载可接受，Shiki 18 语言/主题已各自拆分按需加载 | 首次渲染前的解析时间略增 | 已记入 `docs/RUN.md` 已知限制（L1/L2）；如需优化用 `build.rollupOptions.output.manualChunks` 按 vendor 拆分 |
| U3 | ~~**标题栏空标题文案未改**（D5 后半）~~ **已于 t14 修复** | 见 **§8.11**：核对 Titlebar 真实分支（仅判 `title.trim()` 是否为空，无 `note == null` 判定）后，在 App 侧归一化传值即可区分，**无需改冻结契约** | —（已消除） | — |
| U4 | **D3 即时生效**（非缺陷，语义选择） | `NoteList` 以 `useState(defaultSortMode)` 作初始值，符合「**默认**排序」语义 | 设置改完需重新挂载列表才生效 | 若产品要求即时热更新，改为受控 props |
| U5 | QA §6 的四项人工验收面（托盘鼠标交互、真实拖拽、导入读到非白名单、关闭开关置 false） | 环境限制（无可靠前台交互/多步原生对话框） | 相应功能仅有读码 + 间接证据 | 仍建议发布前人工补做（未因本次修复而变化） |

## 8.10 本次改动文件清单（可追溯）

| 文件 | 改动 |
| --- | --- |
| `src/App.tsx` | 删 3 个重复事件订阅；新增 `zhijian:quit-requested` 消费者；新增 `bindShortcuts` 绑定；`defaultSortMode` 接线；`saveState` + `onSaveStateChange` 接线；`ConfirmDialog`（Ctrl+Delete）；`QUIT_REQUESTED_EVENT` 常量 |
| `src/lib/hotkeys.ts` | `LOCAL_SHORTCUTS.toggleSidebar`：`Ctrl+B` → `Ctrl+\`（附冲突说明） |
| `src/features/editor/EditorPane.tsx` | 新增可选 prop `onSaveStateChange` + 导出 `EditorSaveState`；新 `useEffect` 上报保存态；补 `useEffect` import |
| `src/features/editor/index.ts` | 导出 `EditorSaveState` 类型 |
| `src/features/settings/SettingsPanel.tsx` | 快捷键文案订正（`Ctrl+\` + 冲突说明） |
| `src/features/sidebar/search-store.ts` | 过期注释订正 |
| `src/features/notes-list/NoteCard.tsx` | 过期「全局 mark 规则」注释订正 |
| `docs/ARCHITECTURE.md` | §8 覆盖矩阵与「骨架期占位」说明订正 |
| `docs/QA-REPORT.md` | 本「修复记录」小节 |

> 未改动：`src-tauri/**`（含 `1_init.sql`）、`src/db/**`、`src/store/**`、`package.json`。

---

## 8.11 ✅ U3（t14）标题栏区分「未选中笔记」与「选中了空标题笔记」

> 本节由 **t14** 追加（captain 就 U3 单独裁定：**修，且用零契约变更的最小方案**）。

- **原状（t9 如实未修）**：`App.tsx` 传 `appliedNote?.title ?? ''`，而标题栏只按
  `title.trim().length > 0` 分支 —— 于是「未选中」与「选中了空标题笔记」都显示「未选择笔记」，
  用户明明选中了却被告知未选中。

- **动手前先核对 Titlebar 的真实分支**（按 captain 要求，不凭记忆）：
  `src/features/titlebar/Titlebar.tsx:33`
  ```tsx
  const noteTitle = title.trim().length > 0 ? title : '未选择笔记'
  ```
  结论：**分支只依赖「trim 后是否为空」，不存在 `note == null` 之类判定**，
  故 captain 指定的「App 侧归一化」方案**可直接达成区分**，无需新增 prop。
  （同一判据也用在第 55 行的 muted 样式上；规范化后空标题笔记会走常规 `text-muted`，
  比未选中态的 `text-muted/70` 更醒目，语义上也更正确。）
  ⇒ **未采用**备选的 `hasSelection?: boolean` 方案，故 `TitlebarProps` 与 Titlebar 组件**均未改动**。

- **修法**（`src/App.tsx`，新增一个纯函数 + 改一处传值）：
  ```ts
  export function normalizeTitlebarTitle(note: { title: string } | null): string {
    if (!note) return ''
    return note.title.trim() || '无标题'
  }
  // …
  <Titlebar title={normalizeTitlebarTitle(appliedNote)} … />
  ```

- **两分支的实际传入值**：
  | 状态 | 传入 `TitlebarProps.title` | 标题栏渲染 |
  | --- | --- | --- |
  | 未选中任何笔记 | `''` | 「未选择笔记」（`Titlebar.tsx:33` 的 else 分支） |
  | 选中空标题笔记 | `'无标题'` | 「无标题」（then 分支，**恒非空**故必进该分支） |
  | 选中「会议记录」 | `'会议记录'` | 「会议记录」 |

- **复验证据**（脚本从**两份真实源码**提取实现后求值，而非在测试里重写规则）：
  ```
  ── A. App.tsx 中被验证的实现（原文提取） ──
     export function normalizeTitlebarTitle(note: { title: string } | null): string {
       if (!note) return ''
       return note.title.trim() || '无标题'
     }
  ── B. Titlebar.tsx 的真实分支行（第 33 行） ──
     const noteTitle = title.trim().length > 0 ? title : '未选择笔记'

  ✅ 未选中笔记（null）→ ""            ✅ 空标题 {title:""} → "无标题"
  ✅ 纯空白 {title:"   "} → "无标题"    ✅ 有标题 → "会议记录"
  ✅ 未选中：传入 "" → 显示 "未选择笔记"
  ✅ 选中空标题：传入归一化值 → 显示 "无标题"
  ✅ 选中空白标题：传入归一化值 → 显示 "无标题"
  ✅ 选中有标题：传入归一化值 → 显示 "会议记录"
  ✅ 「未选中」与「选中空标题」渲染文案**可区分**
  ── t14 验证：通过 9，失败 0 ──
  ```
  - `pnpm typecheck` → **exit 0**；`pnpm vite:build` → **✓ built，exit 0**。
  - **真机目视**：不具备条件（本会话无可用的交互桌面；且新建空标题笔记需真实点击/按键，
    见 L10 的合成输入限制）。**如实说明：本条只有源码级 + 构建级证据，无真机截图。**
    但结论是**纯字符串映射**，不依赖运行时环境，风险极低。

- **改动文件**：`src/App.tsx`（唯一代码改动）、`docs/QA-REPORT.md`（本节）、`docs/RUN.md`（L11 标记为已修复）。
  **`src/features/titlebar/**` 未改动**（方案 A 无需动它）。

---

# 9. 第二轮（t15 存储重构后）的 3 项前置修复（t26 入档）

> 本节由 **t26** 追加，供 QA（t21）作为**准确基线**引用。
> 这三项都是**加载期型 / 状态转换型**缺陷 —— **首屏空库启动抓不到、`pnpm typecheck` 与 `pnpm vite:build` 也抓不到**。
> 这正是前两轮验收（t8/t9、t20 之前）连续漏掉它们的原因，也是「**必须真机启动 + 做真实交互**」的依据。

## 9.1 ✅ Bug 1（editor）：编辑器「外部内容同步」打断中文输入（IME）

- **现象**：用拼音输入法打字时，**拼音字母与最终汉字同时入文**；且**回车后光标跳回首行**。
- **根因**：`CodeMirrorEditor` 的「外部内容同步」effect 依赖 `note.content`，而落库是**异步**的
  （防抖 + store 更新）。于是**编辑器刚 emit 出去的内容还会以"外部值"回来**，把它当作外部改写
  **再次 dispatch**，覆盖编辑器当前状态 ⇒ 打断 IME 组合（composition）并重置光标。
- **修法**：加**三道守卫**：
  1. `view.composing` —— IME 组合期间一律不回写；
  2. `lastEmittedRef` —— 记住"自己刚发出去的内容"，认出回声（echo）就不回写；
  3. **只有真正的外部改写**（不等于自己发的内容、且不在组合中）才回写，并**保持光标位置**。
- **性质**：**状态转换型 + 交互时序型**。空库首屏没有内容变化 ⇒ 不触发；`typecheck`/`build` 更看不到。

## 9.2 ✅ Bug 2（editor/集成）：`EditorPane` 的 Hook 数量随 `note` 变化 ⇒ 整棵树被卸载（白屏）

- **现象**：点击**空白文件夹 / 空白标签 / 回收站**（即选中从「有笔记」变为「无笔记」）→ **应用白屏**。
- **根因**：`EditorPane` 把 `useEffect` 放在了 `if (!note) return ...` **之后**。当 `note` 由**有变无**时，
  提前 return 走过、该 `useEffect` **不再执行** ⇒ 本次渲染的 **Hook 数量少于上次** ⇒ React 抛
  `Rendered fewer hooks than expected` 并**卸载整棵组件树**。
- **修法**：把该 Hook（及其它 Hook）**移到提前 return 之前**，保证每次渲染 Hook 数量恒定
  （React 的 Hook 规则：不得在条件分支中调用 Hook）。
- **性质**：**状态转换型**。首屏是「有笔记/空库」的**单一稳定状态**，不产生跨状态 Hook 数量差 ⇒
  **只有做「有 → 无」的交互才会触发**。这也是为什么"首屏看起来一切正常"。

## 9.3 ✅ 附加加固：`src/main.tsx` 顶层 `AppErrorBoundary`

- **背景**：ESM 模块图失败与渲染期异常都会导致**纯白且无任何提示**（`createRoot().render()` 未执行时
  ErrorBoundary 也无从显示；但**渲染期/事件期**异常可以被它兜住）。
- **修法**：在入口最外层包一个 `AppErrorBoundary`，把渲染期异常变成**用户可见的错误页**（而不是白屏）。
- **边界（如实说明）**：它**兜不住** ESM 加载期失败（那时代码还没跑起来）。
  加载期纯白的排查见 `docs/RUN.md §7.1`。

## 9.4 为什么前两轮验收漏掉了它们（方法论，供 t21 参考）

| 漏掉的原因 | 说明 |
| --- | --- |
| **构建门看不见** | `typecheck` / `vite:build` 是**静态**检查；Hook 规则与 IME 时序、模块求值顺序都是**运行时**行为 |
| **首屏看不见** | 两者都要求进入**非初始状态**（②「有→无」转换；① 需要真实 IME 输入） |
| **`check:db` / `check:fs` 看不见** | 它们是数据层自检，不渲染 React、不经过编辑器 |

⇒ **t21 的验收必须包含**：真机 `pnpm tauri:dev` 启动 → **点空白文件夹/标签/回收站**（Bug 2）、
**用中文输入法在编辑器打字 + 回车**（Bug 1）。仅跑构建门会**再次漏掉**同类缺陷。

> **一处需要如实记录的过程订正**：本轮并行期出现过纯白页，最初由 shell 定位到
> `appPreferences.ts` 的 TDZ（**该诊断成立，是真缺陷，已由 system 修复**）。
> 我在其修复**之后**才测量，得到"无 TDZ"，因此一度得出"初诊被推翻"的**错误结论** ——
> 教训是：**验证他人的 bug 报告前，必须先确认代码自对方观察之后是否已被修改**。
> 准确的双故障时间线见 `docs/RUN.md §7.1` 的案例表。

## 9.5 t20 总装期的复核：三处修复仍在 + **已机器化**（防止再复活）

t20 的第一件事是"核对这三处改动仍在、未被后续任务改坏"。核对结果与新增护栏如下。

### A. 静态核对（文件:行）

| 修复 | 现状 | 位置 |
| --- | --- | --- |
| Bug 1 三道守卫 | ✅ 全在 | `src/features/editor/CodeMirrorEditor.tsx:287`（`view.composing`）/ `:288`（`lastEmittedRef.current`）/ `:297`（`selection: { anchor }`） |
| Bug 2 Hook 顺序 | ✅ Hook 全部在提前 return 之前 | `src/features/editor/EditorPane.tsx`：`useSplitRatio()` `:448`、上报保存态的 `useEffect` `:460`，提前 return 在 `:467` |
| 顶层错误边界 | ✅ 仍包在最外层 | `src/main.tsx` 的 `AppErrorBoundary`（含 `getDerivedStateFromError`）包裹窗口路由结果 |

### B. 动态复核（**真实浏览器 + 真实组件**，不是只看源码）

用编辑器自检页（`/src/features/editor/__checks__/harness.html`，`pnpm dev`）驱动真实 `EditorPane`：

| 复核项 | 做法 | 实测结果 |
| --- | --- | --- |
| **Bug 2 触发路径** | `__zjHarness.select('note-a')` → `select(null)`（**有 → 无**，等价于点空文件夹/空标签/回收站）→ 再切回 | `note-a`：`data-zj-editor-pane=split`、1 个编辑器宿主；**`select(null)`：`pane=empty`、0 个编辑器宿主、`#root` 仍有内容、控制台 0 报错**；切回 `note-a` 正常重建 ⇒ **不再白屏** |
| **Bug 1 IME 路径** | `__zjHarness.simulateComposition('拼')`（compositionstart → 组合期写文档 → compositionend） | `composingFlagDuring=true`、`composingFlagAfter=false`、**`buildsDuringComposition=0`**（组合期间装饰一次都不重建）、`buildsAfterCompositionEnd=1`、文档正确落到「拼拼测试输入」、0 报错 |
| **Bug 1 回声不重置光标** | 输入一段文本后**强制父级重渲染**（把同一个 value 再传下来，正是当年"过期 value 回写"的场景） | 文档长度与内容**不变**、光标**保持原位**（未跳回行首）、0 报错 |

### C. 新增永久护栏（`check:contract` 第 5 节，`src/lib/__checks__/contract-checks.mjs`）

| 断言 | 抓的是什么 |
| --- | --- |
| Bug 2：`if (!note) {` **之后不得出现任何 Hook 调用** | Hook 数量随状态变化 ⇒ 白屏（**纯静态可判**，所以能被机器守住） |
| Bug 1：文件内必须存在 `if (view.composing) return` / `value === lastEmittedRef.current` / `selection: { anchor }` | 三道守卫任一被删都会复发 IME 缺陷 |
| `main.tsx` 必须有 `AppErrorBoundary`（含 `getDerivedStateFromError`）且**真的包在渲染树里** | 边界在文件里但没包住 = 白屏无提示 |
| `main.tsx` 的路由必须是 `tileNoteId ? <TileApp …/> : <App />`，且 `createRoot(` **只出现一次** | 路由丢失 ⇒ 磁贴窗口渲染主界面并重复订阅快捷键；重复 render ⇒ 模块级 TDZ 变量被提前引用（本轮接线时我**真的**写出过一次重复 render，被 typecheck 拦住） |

**这些护栏自身经过变异测试**（临时镜像根，不碰真实仓库）：删掉 `if (view.composing) return` → 转红并点名；
把 Hook 移到提前 return 之后 → 转红并给出**具体行号**；删掉磁贴路由 → 转红；还原 → 12/12 回绿。
（另记一次**我自己的测试错误**：第一版变异把 Hook 插在提前 return **之前**（那是正确写法）却没转红，
我据此差点判定"护栏失效"—— 实际是**变异本身错了**，重做成真实缺陷形态后立刻转红。
**判据：护栏没红时，先怀疑变异，再怀疑护栏。**）

---

## 10. t22 修复记录（第二轮 QA：`docs/QA-ROUND2.md` 的问题清单）

> 格式：问题 id → 根因 → 修法 → **复验证据（命令 + 结果）**。未修项在第 10.5 节，含原因/影响/建议。

### 10.1 ✅ F1（high）磁贴双击头仍最大化，并把最大化几何写进 `tiles.json`

**现象（t21 运行时实测）**：双击磁贴头 → `IsZoomed=True` 铺满屏 → `tiles.json` 被写成
`{x:-8,y:-8,width:1936,height:1048}` → 关闭后再钉**同一条笔记**以 1940×1057 全屏打开。

**根因（两层，都不是"忘了写一行配置"）**：
1. `capabilities/tiles.json` 里的 `deny-internal-toggle-maximize` **对这条调用路径无效**：
   `drag.js` 是框架**注入脚本**，它调 `plugin:window|internal_toggle_maximize` 这条路
   **不受 capability deny 约束**。（框架层 `resolve_access` 确实先查 `denied_commands`
   —— `authority.rs:446-452`，所以 deny 对**显式 JS API 调用**仍有效；但注入路径实测绕过它。
   t19 时我引用"tauri 单测证明 deny 优先"是**过度推广**：那条单测只覆盖显式 API 调用路径。）
2. 更糟的是**次生影响**：最大化矩形被 `Moved/Resized` 当成正常几何持久化，
   之后的"恢复位置"照搬 ⇒ 全屏。**几何层没有任何合理性校验**。

**修法（Rust 侧三层，`src-tauri/src/tiles.rs`）**：
1. **框架自己的闸门**：磁贴创建时 `.maximizable(false)` —— `internal_toggle_maximize` 的实现是
   `if is_resizable() { if is_maximized() { unmaximize() } else if is_maximizable() { maximize() } }`
   （`tauri-2.11.6/src/window/plugin.rs:225-231`）⇒ `is_maximizable()` 为 false 时它**什么都不做**；
2. **几何合理性闸门** `sanitize_geometry()`：拒绝"宽高同时 ≥ 显示器 90%"的矩形、夹取到屏内、抬到最小尺寸；
3. **事件层**：`Moved/Resized` 时若 `is_maximized()` ⇒ 立即 `unmaximize()` 且**跳过落盘**；
   启动时若磁盘几何不可信 ⇒ 用默认层叠位置并**回写自愈**（日志带 ASCII 锚点 `tile-geometry-untrusted`）。

**复验证据**：
| 命令 | 结果 |
| --- | --- |
| `cargo test --lib` | **31 passed**（新增 5 条：最大化矩形被拒 / 退化尺寸被拒 / 正常值不动 / 超屏夹取 / 无显示器信息时仍抬到最小值） |
| `pnpm check:rust` | exit 0，**0 warning** |
| **`pnpm probe:tile-maximize`**（新增，运行时闭环） | **exit 0**：先写入污染的 `tiles.json` → 启动后磁贴 `rect = L120 T120 296x249`（脏值被自愈，日志有 `tile-geometry-untrusted`）→ 日志 `tile-attrs … maximizable=Ok(false) maximized=Ok(false)` → **真实双击磁贴头**（窗口确为前台 ⇒ 点击已送达）→ `IsZoomed=False`、`rect` 仍是 `296x249` → `tiles.json` 记录 `x=120 y=120 w=280 h=240`（**不是**最大化矩形） |
| **静态断言同步收紧 + 变异测试** | `check:tiles` 的旧断言「可达的最大化通路都被 deny 压住」**改成**「框架闸门 + 几何闸门都在，deny 仅作纵深」+「运行时探针存在」；**变异测试**：把 `.maximizable(false)` 改掉 → 该断言**转红**（`1 项未通过`，exit 1），还原 → 55/55 回绿 |

> **探针本身踩过两个坑（都已修，值得后人知道）**：
> ① 第一版按**完整中文标题** `FindWindow('纸笺磁贴 · <id>')` 找窗口 —— 失败：webview 的
> HTML `<title>纸笺</title>` 会覆盖窗口标题，且经管道读日志时中文会因代码页变成乱码；
> 改为 `EnumWindows` 按 **noteId（ASCII）子串** + 窗口类名匹配，并给关键日志加 **ASCII 锚点**。
> ② 更早那一版的教训在这里再次生效：**只给"读取失败"打 ✅ 的检查等于没有检查** ——
> 第一版把 `-wal/-shm` 附属文件当备份去"打开"、还给失败打了绿；已改为只核对主备份文件、失败即红。

### 10.2 ✅ F2（medium）重建索引后**侧栏计数徽标不刷新**

**现象（t21）**：外部删 3 个 md → 设置面板报「文件 7 · 笔记 10」→ 点「重建索引」→ 面板变「笔记 7」，
但侧栏仍显示 **10**（切视图后列表自愈为 7 条、**徽标仍 10**）。

**根因**：重建索引只更新了设置面板自己的 `indexStatus`；**没有人触发外层的元数据重载**
（侧栏徽标来自 `useMeta()` → `notesRepo.counts()`）。`onDataImported` 只覆盖"导入"这条路径。

**修法（最小改动，沿用既有「可选 props + 不传则不触发」约定）**：
- `src/features/settings/SettingsPanel.tsx`：新增可选 prop `onIndexRebuilt?: () => void`，**重建成功后**调用；
- `src/App.tsx`：抽出 `handleExternalDataChanged`（= `notesStore.refresh()` + `reloadMeta()`），
  同时接到 `onDataImported` 与 `onIndexRebuilt`（两处都要：导入与重建是两条不同的触发路径）。

**复验证据**：
| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` / `pnpm vite:build` | exit 0 / exit 0 |
| `pnpm check:settings` | exit 0（3 套自检全绿） |
| **`pnpm probe:index-refresh`**（新增，运行时闭环 + **前后对照**） | **修复后 exit 0**：探针建 3 个自己的 md → 启动 ⇒ 徽标 `全部笔记 10`（证明计数来自索引）→ 运行期间外部删除这 3 个文件 ⇒ UIA **真实点击**「设置」→「重建索引」⇒ 徽标刷新为 `全部笔记 7` ✅ |
| 同一探针的**变异对照**（临时去掉 `onIndexRebuilt?.()` = 修复前行为） | **exit 1**，失败信息与 t21 现象**逐字一致**：`重建后侧栏徽标 = '全部笔记 10'，期望 '全部笔记 7'（徽标没刷新）` ⇒ 探针**确实能抓到这个缺陷**，不是空跑 |

### 10.3 ✅ F3（low）重建索引 Toast 的计数口径可疑

**根因**：`rebuildIndex()` 是 **DROP + CREATE + 从 md 全量重投影**，所以
`result.{added,updated,removed}` 是**相对空索引**的文件级统计 ⇒ 永远是「新增 N / 更新 0 / 移除 0」，
与"索引行数 10 → 7"看起来矛盾。**口径确实有问题**（不是数据错）。

**修法**：文案改为给出**索引笔记的前后值**（用户关心的就是这个）：
`索引已重建：按磁盘文件全量重建 7 个，索引笔记 10 → 7`。前后值分别取"点按钮前的
`indexStatus.noteCount`"与"重建后的 `outcome.status.noteCount`"，不再展示会误导的 removed。

**复验证据**：`pnpm probe:index-refresh` 断言重建消息匹配 `索引笔记\s+10\s*→\s*7` → ✅
（实测消息：`索引已重建：按磁盘文件全量重建 7 个，索引笔记 10 → 7`）。

### 10.4 ℹ️ F4（low，t21 自我更正）—— 本轮"断言写松会假绿"的第 4 个实例

t21 已自行修正（`verify-stores-and-silent-noops.mjs` 里"磁贴命令有真实调用方"曾匹配到定义本身）。
**本轮我又踩了同一个坑**，见 §10.1 的变异测试：`check:tiles` 的关键字在**注释里也出现**，
所以"把 `.maximizable(false)` **注释掉**"时断言**仍然通过** ⇒ 已改为**先剥注释行再匹配**，
并用变异测试证明它现在会转红。**结论：任何"关键字存在性"断言都必须先剥注释。**

### 10.5 未修项与如实说明

| 项 | 状态 | 原因 / 影响 / 建议 |
| --- | --- | --- |
| `deny-internal-toggle-maximize` 为什么不直接删 | 保留 | 它对**显式 JS API 调用**（`toggleMaximize()` 那条路）仍然有效，删掉等于白放开门；注释已明说它**不充分**，真正护栏在 Rust 侧 |
| 磁贴**拖动跟手**、托盘点击、真机 IME、导出对话框 | **未验（受限）** | 本环境能注入鼠标（探针里以"窗口确为前台"证明点击送达），但**拖动/托盘/IME/文件对话框**仍需人工；影响：属体验项、与数据正确性无关。建议按 `docs/RUN.md §6.5/§6.7` 人工逐条过 |
| 两个新探针**不放进 `check:all`** | 设计如此 | 它们要**启动真实桌面应用**（25–60s/次）且依赖 Windows UIA/Win32，放进"快速门"会让它变成分钟级并绑死平台。它们有独立入口 `pnpm probe:tile-maximize` / `pnpm probe:index-refresh`，**验收时应单独跑**（本次已跑并附结果） |

### 10.6 本轮改动文件清单（可追溯）

| 文件 | 改动 |
| --- | --- |
| `src-tauri/src/tiles.rs` | `.maximizable(false)`；新增 `sanitize_geometry()` + `monitor_logical_size()`；`geometry_for()` 过闸门并自愈回写；`handle_window_event` 最大化时不落盘并 `unmaximize()`；创建后自证日志（`tile-attrs`）；新增 5 条单测；`TileGeometry` 加 `PartialEq` |
| `src-tauri/capabilities/tiles.json` | description 更正：deny **不充分**、真正护栏在哪、`resolve_access` 的生效边界 |
| `src/features/settings/SettingsPanel.tsx` | 新增可选 prop `onIndexRebuilt`；重建成功后回调；重建文案改为「索引笔记 前 → 后」 |
| `src/App.tsx` | `handleExternalDataChanged`（refresh + reloadMeta）接到 `onDataImported` / `onIndexRebuilt` |
| `src/features/tiles/__checks__/run-checks.mjs` | 旧断言（deny 足够）→ 新断言（两层护栏 + 探针存在），并**先剥注释再匹配** |
| `scripts/probe-tile-maximize.ps1`（新增） | F1 运行时闭环探针（污染几何 → 自愈 → 真实双击 → IsZoomed/几何断言） |
| `scripts/probe-index-rebuild-refresh.ps1`（新增） | F2/F3 运行时闭环探针（UIA 点击 + 徽标前后对照 + md sha256 安全核对） |
| `package.json` | 新增 `verify:round2` / `verify:md-truth` / `probe:tile-maximize` / `probe:index-refresh` |
| `docs/ARCHITECTURE.md` | §4.14.8 新增「修正记录 ③：deny 不构成护栏」与生效边界 |
| `docs/RUN.md` | 门表补 4 个新入口；排查入口补"双击磁贴被最大化"；§6.7 记本次运行时证据 |

---

## 11. t33 修复记录（用户第二轮实测：「磁贴完全不能用，打开磁贴会显示乱码」）

### 11.1 「乱码」的确切内容（先定性，再动手）

用运行时探针把**磁贴窗口内真实渲染的文本**读出来（`--force-renderer-accessibility` + UIA），实际内容是：

```
读不到这条笔记
数据库初始化失败：fs.mkdir not allowed on window "tile-<noteId>", webview "tile-<noteId>",
URL: local allowed on: [windows: "main", URL: local], … ×5
referenced by: capability: default, permission: allow-mkdir || capability: default, permission: write-all || …
```

**定性结论**：不是 URL 编解码问题、不是加载了错误 URL、也不是把二进制/JSON 当文本渲染，
而是**一条英文 ACL 权限报错被当作笔记内容渲染出来了** —— 用户看到的「乱码」就是它。
（`TileApp` 的加载失败分支会把 `error.message` 原样显示，而这条 message 恰好是一整屏英文 ACL 详情。）

### 11.2 根因：**传递依赖被漏掉**（不是"忘了给某条权限"那么简单）

| 层 | 事实 |
| --- | --- |
| 磁贴窗口跑的前端 | 与主窗口**同一份**（`main.tsx` 路由到 `TileApp`） |
| `TileApp` 要读笔记 | `initDb()` + `notesRepo.get(id)` → `src/db/vault.ts::loadNote` → **`getStorage().fs`** ⇒ `plugin-fs` |
| t15 之后 | **md 是真相源**，vault 在 `documentDir()/纸笺`（即 `$DOCUMENT` 下）；自动保存要**写** md |
| 而 `tiles.json` | 当时只给了 `sql:*`（`TileApp` 的**直接**调用确实是 sql），**一条 fs 都没有** |
| ⇒ 结果 | `initDb()` 第一步 `fs.mkdir(vaultRoot)` 就被 ACL 拒 ⇒ 抛错 ⇒ 磁贴显示那屏报错 |

**为什么 t19/t20 都没发现**：
1. `check:tile` 的模型只扫 `TileApp.tsx` 的**直接调用**，没有建「TileApp → `@/db` → `initDb()` → `resolveStorage()` → FsPort → `plugin-fs` 命令 → 权限」这条链；
2. t19/t20 的运行时验证只证明了「磁贴窗口**能创建/拖动/关闭**」，**从未读窗口里渲染了什么** —— 这正是本次漏掉它的原因（已写进 §6.5 清单第 1b 步）。

### 11.3 修法（最小、可解释）

| 改动 | 内容 |
| --- | --- |
| `src-tauri/capabilities/tiles.json` | 按 FsPort 的 9 个方法 + 真实路径范围补 4 条：`fs:allow-document-read-recursive`、`fs:allow-document-write-recursive`（vault = md 真相源）、`fs:allow-appdata-read-recursive`、`fs:allow-appdata-write-recursive`（迁移备份与 migration.log）。**仍然不给** dialog / opener / global-shortcut 与 desktop/download 等无关范围 |
| 同一文件的 description | 原文写着「仍然刻意不给 **fs** / dialog / …」—— **与事实矛盾**（探针新增的一致性断言把它抓了出来）。已改为：fs 必须给（附理由），不给的只有 dialog / opener / global-shortcut |
| `scripts/probe-tile-content.ps1`（新增，`pnpm probe:tile-content`） | **只做一件事**：读出磁贴窗口内实际渲染的文本，断言 ① 无任何错误文案 ② 渲染出了**正确的标题** ③ 渲染出了**正确的正文**（与 md 真相逐字比对） |
| `docs/RUN.md §6.5` | 补第 **1b** 步「内容正确性」并注明"此前一直缺"；2b 步更正为 t22 的真实护栏 |

### 11.4 复验证据

| 命令 | 结果 |
| --- | --- |
| **`pnpm probe:tile-content`（修复后）** | **exit 0**：采样 `无标题-231dba.md` ⇒ ① 无错误文案 ✅ ② 渲染出标题「无标题-231dba」✅ ③ 渲染出正文片段「是多少巍峨问问」✅（窗口内实际文本：`[value] 候选名字…` 等正文内容） |
| **同探针的变异对照**（临时移除 4 条 fs 权限） | **exit 1**，且**逐字复现用户报的缺陷**：窗口内出现 `读不到这条笔记` + `数据库初始化失败：fs.mkdir not allowed on window "tile-231dbaec-…"` ⇒ 证明该探针**确实能抓住这个缺陷**，不是空跑；随后已还原权限、复跑回绿 |
| `pnpm check:rust` | exit 0，**0 warning**（capability 由 `tauri-build` 在编译期校验：**非法 JSON / 未知权限标识符都会直接编译失败** —— 本轮我两次写坏 description 的 ASCII 引号都是被它当场拦下的） |
| `pnpm check:tile` / `pnpm check:settings` | exit 0（description 一致性断言转绿；该断言是队友按"按真实需要计算（含间接依赖）"重写后的版本） |
| `pnpm check:all` | **12/12 exit 0** |

### 11.5 本轮的三个"工具本身的坑"（都已修，供后人省时间）

1. **UIA 只读 `Current.Name` 不够**：标题/正文落在 `<input>` 与 contenteditable 里，**内容在 `ValuePattern.Value` 而不在 Name** —— 只读 Name 会看到「磁贴标题」「笔记正文」这类 label，从而**误判成"内容没渲染"**。探针现在两边都收。
2. **窗口标题不能精确匹配中文**：HTML `<title>纸笺</title>` 会覆盖窗口标题，且经管道读日志时中文会因代码页变乱码 ⇒ 改按 **noteId（ASCII）子串** + 窗口类名匹配，并给关键日志加 ASCII 锚点。
3. **front-matter 的空标题写作 `title: ""`（带引号）**：不剥引号会把字面量 `""` 当成"非空标题"去断言，必然失败；探针现在先剥引号，且**采样优先选"标题非空 + 正文够长"的笔记**，这样标题与正文两条断言都有效。

> **给能力文件作者的一条硬提醒**：`capabilities/*.json` 的 `description` 里**永远不要写 ASCII 双引号**（会破坏 JSON；本轮我犯了两次，都被 `cargo check`/探针立刻拦下）。统一用「」。

