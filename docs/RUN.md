# 纸笺 · 运行与验证手册（RUN）

> 适用版本：v0.1.0 · 最后一次完整验证：t7 集成联调（见 §6 证据）
> 相关文档：[`ARCHITECTURE.md`](ARCHITECTURE.md)（接口契约，唯一权威）· [`DESIGN.md`](DESIGN.md)（视觉规范）·
> [`INTEGRATION-STATUS.md`](INTEGRATION-STATUS.md)（集成期诊断快照）

---

## 1. 环境要求

| 项 | 要求 | 本机实测 |
| --- | --- | --- |
| Node.js | ≥ 20 | v24.19.0 |
| pnpm | ≥ 10 | 11.21.0 |
| Rust | ≥ 1.77.2 | 1.98.1 |
| 平台 | Windows 需 VS C++ 生成工具 + WebView2 | Windows |

> **pnpm 11 注意**：原生构建脚本的放行写在 `pnpm-workspace.yaml` 的 `allowBuilds`
> （`package.json` 的 `pnpm` 字段在 pnpm 11 起**不再被读取**）。已配好，克隆后直接 `pnpm install`。

---

## 2. 命令速查

### 2.1 日常开发

| 命令 | 用途 | 备注 |
| --- | --- | --- |
| `pnpm install` | 安装前端依赖 | 首次约 1–3 分钟（受网络影响） |
| **`pnpm tauri:dev`** | **启动桌面应用（唯一能做真实验收的方式）** | 首次需编译 Rust，约 1–3 分钟；会开真实窗口 |
| `pnpm dev` | 仅启动浏览器版前端（调样式用） | **没有 SQLite / 托盘 / 全局快捷键**，界面会显示「浏览器预览模式」 |

### 2.2 全部质量门（验收命令）

| 命令 | 检查内容 | 期望 |
| --- | --- | --- |
| `pnpm typecheck` | TypeScript（`tsc -b` app + node） | exit 0 |
| `pnpm vite:build` | 前端生产构建 | exit 0，产出 `dist/` |
| `pnpm check:rust` | `cargo check`（Rust 后端 + 权限标识符校验） | exit 0，**0 warning** |
| `pnpm check:db` | 数据层自检：真实 SQLite 跑 2 份迁移 + 全流程仓储用例 | exit 0，**63/63** |
| `pnpm check:fs` | **文件存储自检**（t15）：md 真相源 / 索引重建 / 旧库迁移，真实临时目录 + 真实 SQLite | exit 0，**37/37** |
| `pnpm check:guards` | **防污染护栏自检**（t28）：证明护栏本身有效（相对路径写入被拦且 CWD 无残留、越界拒绝、不误伤正常路径） | exit 0，**7/7** |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | Rust 单元测试（含 `tiles::tests::*` 7 条） | exit 0，**26 passed** |
| `pnpm check:contract` | **前后端契约表机器对账 + 前置修复防回归**（架构师）：`EVENTS`↔`events.rs`、`SHORTCUT_ACTION_IDS`↔`SUPPORTED_ACTION_IDS`、`COMMANDS`↔`generate_handler!` **全部双向** + `cmd_` 命名纪律 + **Bug 1/Bug 2/错误边界/窗口路由**四条防回归断言 | exit 0，**12/12**（设置面板覆盖度已转绿） |
| `pnpm check:tile` | **磁贴静默失效探针**（单条）：`TILE_RUST_COMMANDS` ↔ `generate_handler!` ↔ `COMMANDS` **三表一致** + `tiles.json` 最小授权 | exit 0，**7/7** |
| `pnpm verify:acl` | ACL 权限标识符核对（解析 `acl-manifests.json`，不靠 grep） | exit 0，56 项 |
| `pnpm verify:migrations` | 迁移不可变性（`1_init.sql` checksum）+ 双源一致性 + FTS5/中文检索 | exit 0，46 项 |
| `pnpm verify:stores` | 四个 store 真实性 + 静默失效（无人消费 API）核对 | exit 0，19 项 |
| `pnpm verify:data` | **真实数据迁移逐条核对**（只读）：旧库 `notes` ↔ vault md 的 id/标题/正文/标签/时间/排序/目录 + 目录与标签映射 + 备份完整性 | exit 0 ⇒ **7/7 逐字节相同**（**依赖本机真实数据**，换机器会因找不到 vault 而非 0；故**不放进 `check:all`**） |
| `pnpm verify:round2` / `pnpm verify:md-truth` | t21 第二轮独立验证的脚本：Bug1/Bug2 断言 + md 真相源（污染索引 → 重建 → 回真相） | exit 0，**37/37** / **27/27** |
| **`pnpm probe:tile-maximize`** | **运行时探针（需真实桌面应用）**：写入污染几何 → 启动自愈 → **真实双击磁贴头** → 断言 `IsZoomed=False`、几何未被改写 | exit 0；约 40–70s。**刻意不进 `check:all`**（要启动应用 + Windows UIA/Win32） |
| **`pnpm probe:tile-content`** | **运行时探针（需真实桌面应用）**：读出磁贴窗口内**实际渲染的标题与正文**，断言「无错误文案 + 标题与正文 == md 真相」 | exit 0；约 40–70s。**刻意不进 `check:all`**。**t33 的用户缺陷（磁贴一打开全是 ACL 报错）就靠它闭环**：把 fs 权限去掉即转红 |
| **`pnpm probe:index-refresh`** | **运行时探针（需真实桌面应用）**：UIA 真实点击「设置 → 重建索引」，断言**侧栏徽标刷到新数字** + 重建文案给出「索引笔记 前 → 后」 | exit 0；约 40–70s。**刻意不进 `check:all`**；收尾会核对用户 md 的 sha256 未变 |
| **`pnpm probe:quick-note`**（t44） | **运行时探针（需真实桌面应用）**：真启动 → 用 CDP 触发 `cmd_open_quick_note` → 断言窗口内**渲染的是捕捉框而非主界面**、**无任何 ACL/DB 错误文案** → 真敲字 → **组合期按 Enter 不落库**（输入法守卫）→ 正常 Enter 后 **vault 里出现新 md 且正文/标题正确** → 窗口自动关闭 → 收尾删除该 md 与索引行、核对 md 数量复原 | exit 0，**17/17**；约 60–90s。**刻意不进 `check:all`**（要启动真实应用）。**它是唯一发现「`cmd_open_quick_note` 写成同步命令 ⇒ 死锁」的手段**（编译/typecheck/cargo test/全部静态门当时都是绿的） |
| **`pnpm probe:tile-sync`**（t44） | **运行时探针（需真实桌面应用）**：用 CDP **同时驱动磁贴与主窗口两个真实 WebView** —— 造一条探针笔记 → `set_focus` 到"正在输入"的那一侧（守卫的前提）→ **逐字符真按键**（`Insert.insertText` 不触发 CodeMirror 的 onChange，会得到假结论）→ 断言 **① 主窗口输入实时出现在磁贴 ② 磁贴输入实时出现在主窗口 ③ 两边收敛到同一份内容**，并核对改动**确实落到了 md 真相源** | exit 0，**21/21**；约 90–120s。**刻意不进 `check:all`**。这是用户「磁贴与笔记不实时同步」这条报障的**唯一闭环证据**（静态门只能证明"广播/订阅接上了"） |
| **`pnpm probe:tile-persistence`**（t45） | **运行时探针（需真实桌面应用，含一次真实重启）**：造探针笔记 → 钉住（未固定）→ **点磁贴的 × 关闭** → 断言主窗口按钮自动恢复 → 再钉住并**点图钉固定** → 停应用、注入一条"指向不存在笔记"的脏条目 → **真实重启** → 断言 **① 固定的自动出现 ② 未固定的不再出现 ③ 脏条目不留空白磁贴且固定标记被取消**；收尾逐字节还原用户的 `tiles.json` | exit 0，**18/18**；约 150–200s。**刻意不进 `check:all`**。三个用户报障 + "固定磁贴"这条新需求全靠它闭环（其中**两个真 bug 是它抓出来的**：同步命令死锁那类之外，还有"清理竞态误删正常磁贴"） |
| **`pnpm probe:t46`**（t46） | **运行时探针（需真实桌面应用，含一次真实重启）**：从**用户真实的持久化设置**里取"已启用且有键位"的动作 → 断言启动后 Rust 侧**全部已注册** → 人为 `unregister` 一条作前后对照 → **重启** → 断言它又被注册回来（报障「重启后快捷键失效」的闭环）；另外断言"点设置出现的是**右侧一栏**（主界面仍在、且不是浮层）"与"快速笔记填的**标题**真的写进了 md 的 title" | exit 0，**16/16**；约 150–200s。**刻意不进 `check:all`**；**不写任何用户设置**（只读 + unregister 对照），收尾核对 localStorage 与 vault md 数量原样 |
| **`pnpm probe:tile-snap`**（t47） | **运行时探针（需真实桌面应用）**：预置两枚"固定且同组（group=7）"的磁贴 → 启动 → 断言 **① `cmd_list_tiles` 如实报出组号 ② 两枚磁贴标题栏都出现「取消吸附」按钮** → 真点其中一枚的按钮 → 断言 **③ 解组落盘（tiles.json 里 group=0） ④ 孤儿组被清理（同伴的组号也清 0） ⑤ 两枚的按钮都消失（UI 与 Rust 一致）**；收尾逐字节还原 `tiles.json` | exit 0，**15/15**；约 120–180s。**刻意不进 `check:all`**。<br>⚠️ **它不验证"拖动跟随/松手吸附"** —— 那两条需要真实拖动窗口，本轮两次自动化尝试都失败（`set_position` 被 ACL 拒；`mouse_event` 模拟拖动无效），而**算法本身由 `cargo test` 的 11 条单测覆盖**；手感需人工确认（见 §6.5 步骤 13） |
| `pnpm check:quicknote`（t44） | **快速笔记自检**：URL 协议（`?quick=` 的命中/回落规则）、**按键真值表**（Enter/Shift+Enter/组合期/Esc）、Rust 窗口形态（无边框置顶不可最大化、**尺寸显著小于主窗口**）、**绝不重建已存在窗口**、以及接线（主入口路由、快捷键动作、托盘入口、命令登记、capability 传递依赖、关闭语义）与**「同步命令/事件处理器创建窗口会死锁」这条框架硬约束** | exit 0，**26/26**（在 `check:all` 里） |
| `node src/features/settings/__checks__/run-all.mjs`（= `pnpm check:settings`） | **设置与系统集成自检（单条入口）**：设置面板各偏好「改了真的生效」+ 契约断言（§4.13 / §4.8.1）+ 上面的磁贴探针 | exit 0，两套全绿（设置 **59/59**、探针 **7/7**） |
| `pnpm check:editor` | **编辑器自检**（t24）：命令 / Live Preview 纯函数断言 + **静默 catch 审计**（白名单外 0 处） | exit 0，**96/96** |
| `pnpm check:tiles` | **磁贴前端自检**（t24 + t22 收紧）：UI 契约 + 与 Rust 的跨界联动断言（命令注册、label 前缀、窗口尺寸、真实用到的权限，以及 **t22-F1 的两层护栏：`maximizable(false)` + 几何闸门**；deny 只算纵深） | exit 0，**55/55** |
| `node src/features/editor/__checks__/probe-shiki.mjs` | Shiki 细粒度加载探针（18 语言） | exit 0 |

> ⚠️ **自检项数是会变的**：`check:db` / `check:fs` / 设置自检的用例数由各 owner 持续追加
> （t15→t26 期间 `check:db` 从 54 涨到 63、`check:fs` 从 33 涨到 37、Rust 单测从 12 涨到 26）。
> 上表是**最近一次实测**的数字；**验收只看 exit code 是否为 0**，项数只作参考，不要把它当硬性常量断言。
>
> 🧪 **`check:contract` 的检查本身经过变异测试（t19）**：它在临时镜像根
> （`ZJ_CONTRACT_ROOT=<tmp>`，**不改真实仓库**）下被验证过**确实会转红** ——
> 事件名少一个字母、TS 多写一个动作 id、命令名回退成历史错误值 `tile_toggle`、
> Rust 注册了 TS 未登记的命令，四种变异**全部被抓到**，还原后回到 exit 0。
> **为什么值得记一笔**：一个"永远不会失败的检查"与"没有检查"等价 —— 这正是本轮反复出现的主题。
>
> 📋 **t20 / 最终验收必须逐个跑的入口**（一共 **15** 条，全部只看 exit code；**新增检查也必须在这里有入口**）：
> `typecheck` · `vite:build` · `check:rust` · `check:db` · `check:fs` · `check:guards` ·
> `check:contract` · `check:tile` · `check:settings` · `check:editor` · `check:tiles` ·
> `check:quicknote`（t44 新增）· `cargo test --lib`。
> 另有**三条必须单独跑的运行时探针**（不进 `check:all`，见上表）：
> `probe:quick-note` · `probe:tile-sync`（t44 新增）· 以及 t33/t22 的 `probe:tile-content` / `probe:tile-maximize` / `probe:index-refresh`。
> **纪律（本轮教训）**：分散成"手敲完整路径"的检查最终会被跳过，而**被跳过的检查与没有检查等价** ——
> 所以任何新增自检都必须在 `package.json` 里有名字（t19 补齐了 `check:contract` / `check:tiles` / `check:editor`）。
>
> 🔍 **静默失效探针（t20）为什么必须静态可复现**：本轮出现一类缺陷 —— **界面完全正常、
> 不报错、不白屏，但底层根本没走到**。它的危险形态可以精确描述为：
> **危险的不是「没有权限」，而是「权限齐全但通道走错」** —— 权限缺失时降级路径通常也会失败，
> 于是错误**可见**（落到 `{ok:false, reason:'unavailable'}`）；而权限齐全但命令名写错时，
> 降级路径会**成功**，`ok:true` 带着 `via:'webview'` 返回，与正常路径**完全无法区分**。
>
> 判定式：`silentDegrade = result.ok === true && result.via !== 'rust'`。
> **任何"必须启动桌面应用才能跑"的检查最终都会被跳过，而"被跳过的检查"与"没有检查"等价**
> —— 所以该探针做成纯静态（解析源码 + ACL manifest 做一致性断言），`node` 一行即可。
> 详见 `src/features/settings/__checks__/tile-integration-probe.mjs` 头部注释。
>
> 📌 该探针的一条**实测依据已更正**：`core:window:default` 共 28 项中 **27 项只读、
> 1 项是写操作 `allow-internal-toggle-maximize`**（曾误述为「28 项全是只读」）。
> 结论方向不变——`close` / `show` / `set-focus` / `start-dragging` 等写操作均**不在** default 内、
> 必须逐条显式授权；但探针已改为**从 ACL manifest 计算**这些数字，而不是在文案里下断言。

### 2.3 打包

| 命令 | 产物 |
| --- | --- |
| `pnpm tauri:build` | Windows 安装包（MSI + NSIS），位于 `src-tauri/target/release/bundle/` |

---

## 3. 目录结构

```
纸笺/
├─ docs/                  ARCHITECTURE.md（契约）· DESIGN.md（视觉）· RUN.md（本文件）· INTEGRATION-STATUS.md
├─ public/                静态资源
├─ src/
│  ├─ main.tsx            入口：initTheme() + 挂载 <App />
│  ├─ App.tsx             ★ 总装：三栏布局 + 启动流程 + 全部跨模块接线
│  ├─ index.css           Tailwind 入口 + @theme 语义色映射
│  ├─ types/index.ts      ★ 全部领域模型与组件 props 契约（唯一事实来源）
│  ├─ styles/theme.css    ★ 5 套主题 × 明暗 × 12 个 --zj-* token
│  ├─ lib/                utils · export（导出笔记）· hotkeys · tauri（IPC/事件）· appPreferences
│  ├─ db/                 SQLite：index（initDb）· schema · notes/folders/tags/search 仓储 · __checks__
│  ├─ store/              Zustand：notes（我）· ui · theme · search
│  ├─ components/ui/      shadcn 风格基础组件（Button/Dialog/Toast/…）
│  └─ features/           titlebar · sidebar · notes-list · editor · settings
└─ src-tauri/
   ├─ tauri.conf.json     窗口（decorations:false, 1100×720）· SQL 预加载
   ├─ capabilities/       插件权限（sql/global-shortcut/dialog/fs/opener）
   ├─ migrations/         1_init.sql（Rust 已登记，**永久冻结**）· 2_fts_trigram.sql（仅前端执行）
   └─ src/                lib · main · events · window · tray · shortcuts
```

### 数据位置（t20 核对：**md 是真相源，SQLite 只是可重建的索引**）

| 内容 | 路径（本机实测） | 说明 |
| --- | --- | --- |
| **笔记正文（真相源）** | `<文档目录>\纸笺\**\*.md` | 每篇一个 md，带 front-matter（id/title/tags/pinned/created/updated/order）。**7 篇** |
| 目录 / 标签 / 回收站元数据 | `<文档目录>\纸笺\.paper\{folders,tags,trash}.json` | 保存**稳定 id**（目录/标签改名后上层持有的 id 不失效）；`trash.json` 记录软删除 |
| 迁移标记与备份记录 | `<文档目录>\纸笺\.paper\{migrated.json,migration.log}` | `migrated.json` 含 `counts{notes:7,folders:2,tags:1}` 与旧库备份路径 |
| **SQLite（可重建索引）** | `%APPDATA%\com.zhijian.app\zhijian.db`（+ `-wal` / `-shm`） | 表：`notes` / `folders` / `tags` / `note_tags` / `notes_fts` / `notes_fts_trigram`；**删掉它不会丢笔记**（下次启动按 md 重建） |
| 旧库备份（迁移时自动生成） | `%APPDATA%\com.zhijian.app\zhijian.db.bak-<yyyyMMdd>-<HHmmss>-<mmm>` | 本机：`zhijian.db.bak-20260926-005136-529`（159744 B，可打开、`notes=7`） |
| 磁贴几何 | `%APPDATA%\com.zhijian.app\tiles.json` | **只在有磁贴时才创建**（本机无磁贴 ⇒ 文件不存在，已实测） |
| 主题 / 偏好 | WebView 的 localStorage | 键：`zj:theme`、`zhijian.closeToTray`、`zhijian.defaultSort`、`zhijian.shortcuts`、`zhijian.contentFontSize` |

> ⚠️ **vault 根不是写死的**：它是 `documentDir()/纸笺` —— 即**系统「文档」文件夹** + `纸笺`。
> 上表的 `<文档目录>` 就是这个前缀；设置面板的「数据位置」显示的是本机的真实路径。
> 换机器/改「文档」位置后路径会随之变化，**不要照抄上面的绝对路径**。

#### 如何备份

1. **设置 → 数据位置 → 「备份数据」**：选一个**父目录**，递归复制 vault（含 `.paper`）。
   自检覆盖：md 数一致、源目录不动、拒绝写进自身、拒绝非空目标、逐文件错误收集（部分失败会如实报告）。
2. 手动备份等价于**复制整个 vault 目录**（md + `.paper`）。
3. 旧库备份：迁移时自动生成（见上表）；**不要删**，它是迁移前的原始快照。
4. 索引与偏好不属于备份对象：索引可重建；偏好（localStorage）如需要请单独记下。

#### 如何从 md 恢复（数据只依赖 md，不依赖数据库）

| 场景 | 做法 |
| --- | --- |
| 数据库损坏 / 想重建索引 | 关掉应用 → 删除 `%APPDATA%\com.zhijian.app\zhijian.db`（含 `-wal`/`-shm`）→ 重新启动，应用会按 md **重建索引**（自检已验证：索引表 DROP 后可完整恢复） |
| 只重建、不想删库 | **设置 → 数据位置 → 「重建索引」**（调 `rebuildIndex()`，并回写「最后重建时间」） |
| 外部改了 md（用别的编辑器） | 直接改，重新启动或重建索引即可看到（自检覆盖「外部编辑五情形」） |
| 从 zip 恢复 | 解压回 `<文档>\纸笺`（保留 `.paper/`，否则目录/标签的 id 会重新生成、标签颜色丢失），再重建索引 |
| 彻底从旧库重来 | 用 `zhijian.db.bak-<时间戳>` 覆盖回 `zhijian.db`，**并删除 vault 里的 `.paper/migrated.json`**（否则迁移会判定"已迁移"而跳过） |

> **红线**：不要手改 `src-tauri/migrations/1_init.sql`（sqlx 记了它的 checksum，改一个字符数据库就打不开，见 L7）。
> **迁移不会丢笔记**：迁移是「先备份 → 暂存区生成 + 逐条回读校验 → 原子 rename 提交」，三类失败都不产生残缺数据。

---

## 4. 启动流程（App.tsx 的顺序与理由）

1. `initTheme()`（`main.tsx`，挂载前）—— 把 localStorage 里的主题偏好写进 `<html>`，避免首帧闪烁
2. `await initDb()` —— 打开 SQLite 并执行迁移（幂等；`_sqlx_migrations` 与 `_zj_migrations` 两个迁移器，见 ARCHITECTURE §7）
3. 加载元数据：`foldersRepo.tree()` + `tagsRepo.list()` + `notesRepo.counts()`
4. `notesStore.init()` —— 首屏笔记列表（全部，不含回收站）
5. `bindGlobalHotkeys()` 订阅 Rust 热键事件（`new-note-requested` / `open-settings-requested` / `app-quit-requested`）
   —— **热键事件只在这一处订阅**（t9 修复 D1：曾在 App 重复订阅，导致一次 Alt+N 建两条笔记）；
   另绑定应用内快捷键（`Ctrl+E` / `Ctrl+\` / `Ctrl+Delete`）。`app-quit-requested` 由 hotkeys 转派
   `zhijian:quit-requested` 给 App 做收尾提示。
6. `<CloseToTrayNotice />` —— 下发「关闭到托盘」偏好给 Rust + 订阅 `window_hidden` 给用户反馈

---

## 5. 已知限制与未完成项（**如实记录**）

| # | 项 | 说明 |
| --- | --- | --- |
| L1 | 前端产物主 chunk 约 **1.09 MB（gzip ≈ 359 kB）** | React 19 + CodeMirror 6 + react-markdown + 应用代码。Shiki 已细粒度拆分（core 96 kB、18 种语言各 2.6–181 kB **按需加载**）。**桌面应用从本地加载，可接受**；若将来做 Web 版需要再拆包 |
| L2 | 构建时有 chunk > 500 kB 的提示 | Vite 的常规告警，非错误；见 L1 |
| L3 | 浏览器预览（`pnpm dev`）**没有数据库** | 这是设计使然（`isTauri=false`）。界面会明确提示「浏览器预览模式」，不会假装保存成功 |
| L4 | 「关闭到托盘」的真机窗口显隐**未做端到端验证** | 前端侧已用真实 `@tauri-apps/api` 在伪造 `__TAURI_INTERNALS__` 下验证（system 的 26/26 自检）；**真机托盘点击、系统托盘图标折叠场景需要人工在 `pnpm tauri:dev` 里复核** |
| L5 | 拖拽排序在**标签视图**下是 best-effort | `move()` 的 `targetIndex` 是「目标文件夹规范序」下标；标签视图的集合与规范序非 1:1。已按此关闭标签视图的拖拽（`reorderable=false`） |
| L6 | 导出/导入的**动态 fs 作用域**未由 QA 独立复核 | ~~依赖 `plugin-dialog` 把用户选中路径动态加入 fs 作用域~~ **已由 QA 实测攻破（t8）**：导出到 `D:\qa-dynamic-scope\`（静态白名单之外）**成功落盘 114 字节**。导入（读）路径共用同一机制但未单独实测（见 QA-REPORT §6） |
| L7 | `1_init.sql` **永久冻结** | 它已登记进 `lib.rs::MIGRATION_SOURCES`，sqlx 记录了文件 checksum —— **改一个字符都会导致下次启动报 checksum mismatch、数据库打不开**。要改 schema 只能新增前端侧的 `3_*.sql` |
| L8 | `localStorage` 键前缀不统一 | 主题用 `zj:theme`，其余偏好用 `zhijian.`。两者都在用，**改名会丢用户偏好**，故保持现状并记录（ARCHITECTURE §4.6） |
| L9 | 无自动化端到端（E2E）测试 | 未引入 Playwright/WebDriver。当前验证靠：类型检查、单测、数据层/设置面板自检脚本、以及人工在浏览器与真机的复核 |
| L10 | **本环境无法可靠注入合成键盘输入**（⇒ D1 的端到端实测缺样本，**待人工补测**） | `AppActivate('纸笺')` 返回 False；改用 `AttachThreadInput + SetForegroundWindow + SetActiveWindow + SetFocus` 后窗口**确为前台**（`IsFg=True`、`class=Tauri Window`），但 `SendKeys('%n')` 与 `keybd_event` **均未被送达**（重置库后连发 6 次仅 1 次送达，那次结果为 1 次按键 → 1 条笔记）。**影响**：依赖「真实按键」的验证（如 Alt+N 连按计数）需人工或在有交互桌面的会话补做。**复现步骤见 `docs/QA-REPORT.md` §5.1**（连按 3 次 Alt+N → 期望恰好 3 条笔记）。**不依赖**合成键击的验证（`Ctrl+\` 等 window 级 keydown、一切代码/数据层断言）不受影响 |
| L11 | ~~标题栏在**空标题**笔记上显示「未选择笔记」~~ **已于 t14 修复** | 改为在 App 侧归一化传入值：有选中笔记传 `note.title.trim() \|\| '无标题'`（恒非空），未选中传 `''` ⇒ 两种状态渲染不同文案，**零契约变更**（`TitlebarProps` 未改，Titlebar 组件未改）。见 QA-REPORT §8.11 |
| L12 | 「笔记列表默认排序」改动需重新挂载列表才生效 | `NoteList` 以 `useState(defaultSortMode)` 作**初始**值，符合「默认排序」语义而非强制排序；切换视图即可生效（见 QA-REPORT §8.9 U4） |
| L13 | ~~点**空白文件夹 / 空白标签 / 回收站**会白屏（整棵树被卸载）~~ **第二轮已修** | 根因：`EditorPane` 的 `useEffect` 在 `if (!note) return` **之后** ⇒ `note` 由有变无时 Hook 数量减少 ⇒ React 抛 `Rendered fewer hooks than expected` 并卸载整棵树。**根因是「状态转换型」缺陷，首屏与构建门都抓不到**。详见 QA-REPORT §9.2 |
| L14 | ~~中文输入法（IME）打字时拼音与汉字同时入文、回车后光标跳回首行~~ **第二轮已修** | 根因：编辑器「外部内容同步」把异步落库回来的**自己的内容**误判为外部改写并再次 dispatch，打断 composition 并重置光标。已加三道守卫（`view.composing` / `lastEmittedRef` / 仅真外部改写才回写且保持光标）。详见 QA-REPORT §9.1 |
| ⚠️ L15 | **构建门无法发现「加载期型 / 状态转换型」缺陷（方法论，务必遵守）** | `typecheck` / `vite:build` / `check:db` / `check:fs` 全绿**不代表可用**：L13（Hook 数量跨状态变化）、L14（IME 时序）、§7.1 案例① （模块求值顺序）**在这四道门全绿的情况下依然会让应用白屏或不可用**。⇒ **验收必须包含真机 `pnpm tauri:dev` + 真实交互**：点空白文件夹/标签/回收站、用中文输入法打字+回车、切视图。**仅跑构建门会重复漏掉同类缺陷**（第一、二轮已各漏一次） |
| ✅ L16 | **「浏览器 dev 下 `initDb()` / `Database.load` 会永久挂起、永不 reject」—— 该说法已被实测否定** | 实测（`pnpm dev` + 真实 Chromium，Vite 7.3.6 / `@tauri-apps/plugin-sql@2.4.1`）：<br>① `initDb()` **立即 reject**，原因为可读中文：`数据库不可用：当前不在 Tauri 运行环境（请使用 pnpm tauri:dev 启动）`（守卫在 `src/db/index.ts:117`，先判 `isTauri` 再 `Database.load`）；<br>② 绕过守卫直接 `Database.load('sqlite:zhijian.db')` 也**立即 reject**：`Cannot read properties of undefined (reading 'invoke')`（读 `window.__TAURI_INTERNALS__.invoke` 时抛 TypeError）；<br>③ 应用本身**没有**卡在 `booting`：界面正常渲染并显示「浏览器预览模式：没有 SQLite…」（`#root` 有 2 个子节点、控制台无报错）。<br>⇒ **结论**：两种路径都是**「快速失败 + 可读原因」**，不存在静默挂起。**排除该原因**后，若将来真的看到永久「启动中」，应去查启动流程本身（`App.tsx` 的 `bootState` 是否被某处 `await` 住），而**不是**去查 `initDb` 的挂起。<br>**方法论（同类陷阱第三次）**：这是被要求写入文档的「已知项」，但要求本身基于**代码变更前**的观察 —— 与 §7.1 的 ① 我踩过的坑完全同类（**先确认代码自对方观察之后是否已被修改，再决定是记录还是复现**）。**凡要写进文档的"事实"，先跑一次最小复现。** |

### 5.0 ⚠️ 本轮用户实测暴露的缺陷「类型」（**验收时必须专门打这两类**）

这两个缺陷都不是"写错了一行"，而是**只在特定状态转换/交互时序下才存在**：

| 类型 | 实例 | 为什么首轮验收漏掉 | 现在靠什么守住 |
| --- | --- | --- | --- |
| **状态转换型** | **Bug 2**：选中一篇笔记后点**空白文件夹 / 空标签 / 回收站** ⇒ `note` 由「有」变「无」⇒ `EditorPane` 的 Hook 数量减少 ⇒ React 抛 `Rendered fewer hooks than expected` 并**卸载整棵树（白屏）** | 首屏是「有笔记 / 空库」的**单一稳定状态**，不产生跨状态 Hook 数量差 ⇒ **首屏与构建门全绿** | `check:contract` 第 5 节**静态断言**「提前 return 之后不得有 Hook」（纯静态可判）+ §6.7 的浏览器 `select(null)` 动态复核 |
| **交互时序型** | **Bug 1**：中文输入法打字时**拼音与汉字一起入文**、回车后**光标跳回首行**（异步 store 的过期 value 回声覆盖编辑器，打断 IME 组合） | 需要**真实 IME**才触发；纯键盘/程序化输入复现不到 | 三道守卫的静态断言 + 自检页 `simulateComposition` 动态复核（组合期间装饰重建 **0** 次） |
| 同族第三例 | **§7.1 案例①**：模块顶层副作用读到自己后面的 const（TDZ）⇒ 整个 ESM 图挂掉 ⇒ **纯白无提示** | `typecheck`/`build` 都看不到运行时的模块求值顺序 | `main.tsx` 的 `AppErrorBoundary`（渲染期异常有可读提示）+「`createRoot(` 只允许一次」断言 |

> ⇒ **验收必须包含真机交互**：点空白文件夹/标签/回收站、用中文输入法打字 + 回车、切视图。
> 只跑构建门会**第三次**漏掉同类缺陷（前两轮已各漏一次，见 §5 L15）。

### 5.1 应用内快捷键（t9 起）

| 快捷键 | 行为 | 备注 |
| --- | --- | --- |
| `Ctrl+K` | 聚焦搜索框 | 由 `SearchBox` 自身监听 |
| `Ctrl+S` | 立即保存 | 由编辑器 keymap 处理（**焦点需在编辑器内**） |
| `Ctrl+E` | 切换 编辑 / 预览 | t9 新增绑定 |
| `Ctrl+\` | 折叠 / 展开侧栏 | t9 新增绑定。**不是 Ctrl+B** —— 编辑器内 `Ctrl+B` 是加粗，会吃掉该键 |
| `Ctrl+Delete` | 选中笔记 → 二次确认 → 移入回收站 | t9 新增绑定；回收站视图内不动作 |
| `Alt+N` | 新建笔记（全局，窗口未聚焦也生效） | Rust 全局快捷键（t17 起可自定义，见 §5.2） |
| `Alt+Shift+Z` | 显示 / 隐藏窗口（全局） | Rust 全局快捷键（t17 起可自定义） |

### 5.2 全局快捷键可自定义（t17）

动作 id（**Rust 侧共 6 个**，`shortcuts::SUPPORTED_ACTION_IDS`）：
`newNote` / `toggleWindow` / `openSettings` / `showTile` / **`toggleTiles`(t19)** / **`pinNote`(t19)**；默认只注册前两个。
设置页展示的是**后端回传的 `applied`/`failed`**（实际生效值），不是用户输入值。
IPC 与事件契约见 ARCHITECTURE **§4.8.1**；磁贴相关的两个动作见 §4.14.6。

> ⚠️ **接口对不上 —— 已在 t20 修复（保留本条作为追溯）**：t19 契约核对时发现设置面板只有 **4** 项
> 而 Rust 接受 **6** 个 id（`toggleTiles` / `pinNote` 无 UI 入口）。**t20 已补齐**：
> `src/features/settings/shortcuts.ts` 的 `SHORTCUT_ACTIONS` 现为 6 项，
> `SHORTCUT_EVENT_BY_ACTION` 与 `dispatchShortcutEvent` 同步指向磁贴专用事件
> ⇒ `pnpm check:contract` 的「设置面板动作覆盖度」由 **告警转绿**。
> 桩件（`__checks__/stub-lib-tauri.mjs`）也补登了 2 个事件 + 3 个命令（桩件漏项会让自检"假通过"）。

### 5.3 t20 集成接线（**已全部接完**，保留清单供复核）

| 接线项 | 状态 | 落点 |
| --- | --- | --- |
| `Sidebar.onRenameTag` → `tagsRepo.rename` | ✅ 已接 | `src/App.tsx` 的 `handleRenameTag`（+ `reloadMeta`） |
| `Sidebar.onUpdateTagColor` → `tagsRepo.updateColor` | ✅ 已接 | `src/App.tsx` 的 `handleUpdateTagColor`（+ `reloadMeta`） |
| **窗口路由**：`?tile=` ⇒ `<TileApp>`，否则 `<App/>` | ✅ 已接 | `src/main.tsx`（`readTileNoteId(location.search)`） |
| 编辑器「钉住/取消磁贴」按钮 → `toggleTileForNote` | ✅ 已接 | `src/features/editor/EditorPane.tsx` 新增**可选** props `onToggleTile` / `tilePinned`（不传则不渲染）；`src/App.tsx` 的 `handleToggleTile` + `toggleTileById`（**按按钮所在笔记的 id**，不现读 `selectedId`） |
| `pinNote` 快捷键（Rust 只发时机，noteId 由前端回填） | ✅ 已接 | `src/lib/hotkeys.ts` 的 `GlobalHotkeyActions.pinCurrentNote`（经 `onPinCurrentNoteRequested` 封装订阅，**不新增裸 `listen`**，t31 的 D1 断言保持 1 处/事件）；App 注入 `handlePinCurrentNote` 现读 `selectedId` |
| 磁贴可见性事件 → 前端对账 | ✅ 已接 | `GlobalHotkeyActions.tilesVisibilityChanged` → App 的 `refreshTileState()`（权威状态来自 `cmd_list_tiles`） |
| 设置页 `toggleTiles` / `pinNote` 动作项 | ✅ 已补 | `src/features/settings/shortcuts.ts`（6 动作，默认都不占键位） |

> `tagsRepo.updateColor(id, color)` 只改 `.paper/tags.json` 的 color + 同步索引，
> **不重写 md、不刷新笔记 `updatedAt`**（§4.3/§4.12）。
> **仍需人工确认的一项**：接上后「重命名 / 改颜色」菜单项**确实出现**，且改完颜色后
> **侧栏色点与卡片标签同步变化** —— 这需要真实点击（见 §6.7 的待人工清单）。

---

## 6. 最后一次完整验证证据（t7 集成联调）

> ⚠️ **本节数字是 t7 时刻的历史快照**（第二轮 t15 存储重构后已变化）。
> **当前基线只看 §2.2 的命令表**（那里是维护中的现行数字）。
> 下表仅作"当时的验证方式"参考，**勿当当前数字引用**。

### 6.1 质量门（t7 时刻的快照）

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | ✅ exit 0 |
| `pnpm vite:build` | ✅ exit 0 |
| `pnpm check:rust` | ✅ exit 0，0 warning |
| `pnpm check:db` | ✅ 全通过（t7 时 54 项；现见 §2.2） |
| `cargo test --lib` | ✅ 全通过（t7 时 12 项；现见 §2.2） |

### 6.2 真实桌面启动（`pnpm tauri:dev`）—— 成功

Rust 编译 452/452 通过，进程 `zhijian` 以窗口标题「纸笺」启动，并在真实运行中完成建库：

| 事实 | 证据 |
| --- | --- |
| 数据库被创建 | `%APPDATA%\com.zhijian.app\zhijian.db`（98,304 B + `-wal`/`-shm`），启动后 1 秒内出现 |
| Rust 迁移器执行了 v1 | `_sqlx_migrations` = `[{version:1, description:"init", success:1}]` |
| 前端迁移器执行了 v1 + v2 | `_zj_migrations` = `[{version:1}, {version:2}]` |
| 中文全文检索（trigram）可用 | 表 `notes_fts_trigram` 存在；运行时 SQLite **3.53.3**（≥ 3.34，满足 trigram 前提） |
| 全部业务表就位 | `notes / folders / tags / note_tags / notes_fts / notes_fts_trigram / app_settings` |

> 说明：本次为**无人值守启动验证**（进程起来、建库、迁移完成、窗口存在），
> **未做人工点击级交互验收**（托盘图标点击、拖拽、导出对话框等）—— 那部分见 §5 的 L4/L6。

### 6.3 浏览器交互冒烟（`pnpm dev`）

在真实浏览器中确认：外壳三栏渲染、设置面板可开可关（标题栏与侧栏两条入口都可用）、
主题切换即时生效、Toast 视口存在、控制台 **0 报错**。
浏览器模式下界面明确显示「浏览器预览模式：没有 SQLite…」，**不伪造成功**。

### 6.4 集成期修复的三个真实缺陷（供追溯）

| # | 缺陷 | 影响 | 修法 |
| --- | --- | --- | --- |
| I1 | `uiStore.openSettings()` 只设 `settingsOpen`、不设 `view`，而 UI 以 `view === 'settings'` 判定显示面板 | **标题栏「设置」按钮点了完全没反应**（静默失效：回调执行了、store 也变了，但界面无变化） | `openSettings()` 同时设 `view: 'settings'` 与 `settingsOpen: true` |
| I2 | `notesStore.update()` 不重新判定集合归属 | 在标签/文件夹视图里把笔记移出该集合（改 `folderId`、置顶、软删）后，笔记**仍留在列表里**，直到下次刷新 | 更新后按 `noteBelongs()` 重新判定，不属于当前集合则移出列表 |
| I3 | 编辑器空状态与 App 空状态同时渲染 | 出现两处重复的「还没有笔记」文案 | App 只在「启动中 / 浏览器预览 / 启动失败」时渲染兜底空状态；「就绪但无笔记」交给 EditorPane |

---

## 6.5 桌面便签磁贴的手动验证步骤（t19）

> 契约详见 `docs/ARCHITECTURE.md §4.14`。**必须在 `pnpm tauri:dev` 里做**——
> 磁贴是纯窗口行为，浏览器预览与构建门都验证不到（参见 §5 的 L15）。

前置：先建至少一条笔记（`Alt+N`），并保持主窗口可见。

| # | 步骤 | 期望 |
| --- | --- | --- |
| 1 | **创建**：在磁贴 UI 里钉一条笔记（t24 提供的按钮 → `toggleTileForNote()` → `cmd_toggle_tile`）。<br>⚠️ 全局快捷键路径**暂不可达**（见下「已知缺口」） | 出现一个**无边框、置顶、不在任务栏**的小窗；内容就是那条笔记 |
| 1b | **⚠️ 内容正确性（t33 补上，此前一直缺）**：磁贴打开后，看它**窗口里到底显示了什么** | 显示**该笔记的标题与正文**（可编辑）；**绝不能**出现「读不到这条笔记」「数据库初始化失败」「not allowed on window …」这类文本 —— 用户 t33 报的「乱码」就是缺 fs 权限时那一屏英文 ACL 报错。<br>自动化：`pnpm probe:tile-content`（把窗口内实际渲染的文本读出来与 md 逐字比对） |
| 2 | **拖动**：按住磁贴的拖动头拖到屏幕另一处，再**从边缘调整大小** | 窗口跟随鼠标移动/缩放；**无报错**。⚠️ **拖不动 = 缺 `core:window:allow-start-dragging`**（ARCHITECTURE §4.14.8 修正记录），且**不会有任何报错** |
| 2b | **双击拖动头** | **不应**把磁贴最大化（t22 更正：**不是**靠 `deny-internal-toggle-maximize` —— 那条对注入脚本路径无效；真正靠 Rust 的 `maximizable(false)` + 几何闸门；若被最大化即该条失效）。自动化：`pnpm probe:tile-maximize` |
| 3 | 确认 `%APPDATA%\com.zhijian.app\tiles.json` 出现且含该 `noteId` 的 `x/y/width/height` | 移动/缩放停下约 **0.4 秒**后写盘（尾沿去抖） |
| 3b | **⚠️ 固定（t45）**：点磁贴标题栏的**图钉** | 图钉点亮（`data-zj-tile-pin="on"`），`tiles.json` 里该条出现 `"pinned": true`。**固定 = 下次启动自动出现**；未固定的磁贴是"本次会话的临时磁贴"，关掉就没了 |
| 4 | **恢复位置**：完全退出应用（托盘「退出纸笺」）后重新 `pnpm tauri:dev` | **只有被固定的磁贴**会回来（原位置原尺寸），控制台出现「已恢复 N 枚**固定**磁贴」。<br>⚠️ **t45 行为变化**：未固定的磁贴**不再**自动恢复 —— 旧版本是"只要 tiles.json 里有记录就恢复"，于是用户用 × 关掉的磁贴下次启动又自己冒出来（用户报障）。自动化：`pnpm probe:tile-persistence` |
| 4b | **对账（t45）**：用磁贴自己的 **×** 关掉一枚磁贴，看主窗口那条笔记的按钮 | 按钮**自动**从「取消桌面磁贴」变回「钉到桌面」（`aria-pressed` 跟着变）。Rust 会广播 `zhijian://tiles-changed`，主窗口据此重新对账 |
| 4c | **脏磁贴自愈（t45）**：把某条有磁贴的笔记删进回收站 → 完全退出 → 重新启动 | 桌面**不再**出现写着「这条笔记不在了」的空白磁贴；`tiles.json` 里那条的 `pinned` 被取消（几何缓存保留，笔记若恢复、再钉一次还能回到原位） |
| 5 | **关闭单枚**：点磁贴自身的关闭入口（或再次执行钉住/取消） | **只关这一枚**；主窗口**不受影响**、不隐藏到托盘 |
| 6 | 再钉一次刚才那条笔记 | 几何从 `tiles.json` **恢复**（回到第 2 步拖到的位置） |
| 7 | **主窗口隐藏时磁贴保留**：把主窗口关掉（按钮 → 应隐藏到托盘）或按 `Alt+Shift+Z` | 磁贴**继续显示**在桌面上 |
| 8 | **全部显隐**（`toggleTiles`，Rust 已实现）：见下方「已知缺口」——目前只能直接调 `COMMANDS.setTilesVisible` 或补上设置页入口后再按键 | 所有磁贴一起显示/隐藏；主窗口 UI 的开关状态同步 |
| 8b | **钉住当前笔记**（`pinNote`）：同上，需先补设置页入口；触发后应 `emit PIN_CURRENT_NOTE_REQUESTED` → 主窗口显示 → 由前端回填 `selectedId` → 调 `cmd_toggle_tile` | 当前选中的那条笔记被钉成磁贴 |
| 9 | **退出清理**：托盘「退出纸笺」 | 应用进程结束，**磁贴窗口全部消失**（不留孤儿窗口） |
| 10 | **⚠️ 实时双向同步（t44 修，此前是缺陷）**：磁贴与主窗口同时开着同一条笔记。先在**主窗口**里打字，等约 1 秒，再看磁贴；然后在**磁贴**里打字，等约 1 秒，再看主窗口 | 两边**都能立刻看到对方刚输入的文字**（无需关闭/重开磁贴）。<br>⚠️ 守卫：**焦点在谁那里，谁的输入优先** —— 若某个窗口没有焦点且**本地还有没落库的输入**，它会保持不动（后写者胜），不会丢字。<br>自动化：`pnpm probe:tile-sync`（真键盘、双窗口、断言双向 + 收敛 + 落库到 md） |
| 11 | **⚠️ 固定的磁贴在「全部显隐」下不动（t46）**：固定一枚磁贴，再按「显示/隐藏全部磁贴」的快捷键 | 临时磁贴一起显隐；**固定那枚始终留在桌面上**（用户要求「固定的磁贴永远留在桌面上，快捷键只影响临时磁贴」） |
| 12 | **重启后快捷键仍然生效（t46 修，此前是缺陷）**：在设置里给任意动作绑一个键位 → 退出应用 → 重新 `pnpm tauri:dev` → 直接按那个键位（**不要**先打开设置面板） | 键位**立即生效**。⚠️ 修复前必须打开一次设置面板才会恢复（因为绑定只在设置面板里被下发给 Rust）。自动化：`pnpm probe:t46`（读用户真实绑定 → 断言全部已注册 → 注销一条作对照 → 重启 → 断言又注册回来） |
| 13 | **⚠️ 吸附成组（t47，需人工确认手感）**：把两枚磁贴拖到**缝隙小于 8px** 的位置松手 | 两枚**自动贴合**（缝隙变 0）。然后把其中一枚拖走：**另一枚跟着一起移动**；拖到足够远（缝隙 > 10px）松手，两者**自动分开**。<br>自动化覆盖：吸附算法 11 条单测 + `pnpm probe:tile-snap`（组状态 →「取消吸附」按钮 → 解组落盘 → 孤儿组清理 → UI 收敛 15/15）。<br>⚠️ **手感（阈值 8px 是否合适）只能人工判断** —— 见下方「吸附成组的已知验证缺口」 |
| 13b | **显式取消吸附**：让两枚吸在一起，然后点标题栏的「取消吸附」按钮（组号 > 0 时才出现） | 该枚退出组；同伴若只剩自己，会**同时**退出（孤儿组清理）——两枚的按钮都消失 |

> ### 已知缺口（t19 发现 → **t20 已补齐**）
> t19 时步骤 1 / 8 / 8b 的**全局快捷键路径不可达**：Rust 侧有 6 个动作（含 `toggleTiles` / `pinNote`），
> 但设置面板只有 4 项 ⇒ 用户无法给这两个动作绑定键位。
> **t20 已补齐**（`SHORTCUT_ACTIONS` 6 项 + `SHORTCUT_EVENT_BY_ACTION` 指向磁贴专用事件
> + App 层接 `pinCurrentNote`），因此现在三条路径都可用：
> ① 编辑器工具条的**钉住/取消按钮**（`onToggleTile`，不传则不渲染）；
> ② 设置里绑定 `pinNote` 后按键钉住**当前选中**笔记；
> ③ 设置里绑定 `toggleTiles` 后一键显示/隐藏**全部**磁贴。
> 仍然**只能人工确认**的是「按下真实键位后端到端生效」——见 §6.7 的待人工清单。
>
> ### t44 变更（本轮）
> - **动作清单回到 6 项**：删掉了「显示磁贴（旧动作名）`showTile`」（用户要求），
>   新增了 `quickNote`（快速笔记）。`SHORTCUT_EVENT_BY_ACTION` 的类型因此改成 `Partial` ——
>   `quickNote` **刻意没有事件**：它整条动作都在 Rust 侧完成（创建/复用捕捉窗），
>   前端没有必须参与的事。给它塞一个"永不 emit 的假事件"正是本项目定义过的静默失效形态。
> - **默认键位仍是前两个**（`Alt+N` / `Alt+Shift+Z`，§4.8.1 冻结）：`quickNote` 默认**不启用**，
>   但在设置里给了建议键位 `Alt+Shift+N`，一键即可开启；未开启时可用**托盘菜单「快速笔记…」**。

### 6.5b 快速笔记的手动验证步骤（t44）

| # | 步骤 | 期望 |
| --- | --- | --- |
| 1 | 托盘菜单（或绑定 `quickNote` 后按 `Alt+Shift+N`） | 弹出一个 **460×264 的小捕捉框**（无边框、置顶、不占任务栏），**不出现主界面** |
| 2 | 直接打字（焦点应已在输入框，无需再点一下） | 光标在框内，可正常输入中文 |
| 3 | **中文输入法选词时按 Enter** | **不该保存、不该关窗**（这是本条最关键的守卫：Enter 在组合期属于输入法） |
| 4 | 敲完一句按 `Enter` | 捕捉框**自动关闭**；主窗口列表里**立即多出这条笔记**（标题 = 首个非空行） |
| 5 | `Shift+Enter` | 在框内换行，不保存 |
| 6 | `Esc`（或右上角关闭） | 关闭且**不建笔记** |
| 7 | 再次触发快捷键（窗口已存在时） | 窗口被 `show + focus` 到前台，**不重建**（不会丢掉已敲了一半的内容） |
| 8 | 自动化 | `pnpm probe:quick-note`（真机 17/17：渲染无 ACL 报错 + 组合期 Enter 不落库 + Enter 真建 md + 自动关窗 + 收尾删净） |

### 6.5c 「导入 md」入口搬家（t44）

| # | 步骤 | 期望 |
| --- | --- | --- |
| 1 | 打开侧栏 | 「全部笔记 / 回收站」下方能看到**「导入 md 文件…」与「导入文件夹…」**两行（在「文件夹」分组之前） |
| 2 | 打开设置面板 → 数据分区 | **不再**出现这两个导入按钮（数据目录/备份/更换目录仍在） |
| 3 | 点「导入文件夹…」选一个含子目录的目录 | 保留子目录结构导入；进行中两行都置灰且当前那行文案变成「正在导入…」；结束后 Toast 报告「完成 / 部分完成 / 失败」，列表与侧栏计数**立即刷新** |

**真机验证受限时的如实标注**：本环境无可靠的前台交互/合成输入（见 §5 的 L10），
上述 1–9 中依赖真实点击与拖拽的步骤**需要人工执行**；代码级证据（label 往返、几何序列化、
损坏文件回落、默认层叠、几何路径必须绝对）已由 `cargo test --lib` 的 `tiles::tests::*` **7 条**用例覆盖。
**另有两条只能人工确认**（因为它们是"权限是否生效"，静态检查只能证明"标识符合法且已在文件里"）：
**拖动是否真的跟手**（步骤 2）、**双击是否真的不最大化**（步骤 2b）。
`pnpm check:tile` 只断言这两条权限**在文件里**，不替代真机确认。

### 吸附成组的已知验证缺口（t47，如实记录）

**已机器验证**：吸附取舍规则（阈值边界、只吸一个轴、另一轴须重叠、取最小间隙、已贴合时幂等、结果确定性）
由 `cargo test` 的 11 条单测覆盖；**组状态 → 「取消吸附」按钮 → 解组落盘 → 孤儿组清理 → UI 收敛**
由 `pnpm probe:tile-snap`（15/15）真机覆盖。

**尚未自动验证**：「拖动时整组跟随」与「松手后自动吸附」这两条**事件驱动**行为。
本轮做了两次自动化尝试，都失败并已放弃（记录在此以免下一个人重复踩）：

| 尝试 | 结果 | 为什么不用它 |
| --- | --- | --- |
| `plugin:window\|set_position` 直接设窗口位置（会触发 `Moved`，与拖动同一条代码路径） | **被 ACL 拒绝**：`window.set_position not allowed`（需 `core:window:allow-set-position`） | **产品并不需要这条权限** —— 组跟随是 Rust 侧直接调 `window.set_position()`（不受 ACL 管），前端从不调它。为了测试给生产放开一条窗口操作权限 = 拿用户的安全面换测试方便 ⇒ **不干** |
| `mouse_event` 模拟真实鼠标拖动（走 drag.js → 系统移动窗口） | **窗口纹丝不动**（多半是这个旧 API 被系统忽略；应改用 `SendInput`） | 再投入的边际收益低；而算法已有单测、组链路已有真机探针 |

⇒ **手感（8px 阈值是否合适、跟随是否跟手）需要人工拖一次确认**（步骤 13）。若手感不对，
`SNAP_THRESHOLD`（`src-tauri/src/tiles.rs`）是唯一的调参点。



### 6.6 t19（桌面便签磁贴）的验证证据与三条被推翻的说法

本轮 t19 的验收分两部分：**代码级证据（可机器复跑）** 与 **真机证据（部分仍待人工）**。

| 项 | 证据 | 结论 |
| --- | --- | --- |
| 全部门 | `pnpm check:all` → **12 道门 exit 0，总耗时约 12 秒** | 单条入口、只看 exit code |
| 磁贴能力真的被加载 | `src-tauri/gen/schemas/capabilities.json` 含 `tiles`（`windows: ["tile-*"]`、11 条权限），**由 `tauri-build` 在编译期生成并校验**（未知权限标识符会直接编译失败） | 标识符合法性由编译器背书，不靠人眼 |
| 真机启动 | `pnpm tauri:dev` 启动、进程 `zhijian` 窗口「纸笺」Responding=True、`%APPDATA%\com.zhijian.app\zhijian.db-wal` 在启动后被写入 | 应用带着**新的 capability** 正常起来 |
| 无磁贴时**不**落盘 | 上述启动后 `app_data_dir` 里**没有** `tiles.json` | 几何是惰性创建，不会在启动时凭空造文件 |
| 契约对账脚本本身有效 | 变异测试（临时镜像根，**不碰真实仓库**）：事件名少一个字母 / TS 多写动作 id / 命令名回退成 `tile_toggle` / Rust 注册了 TS 未登记的命令 —— **四种变异全部被抓到**，还原后 exit 0 | 检查被证明**会失败**，不是装饰品 |

**三条被主源码或实测推翻的说法（都曾准备写进文档，务必不要再照抄）**：

| # | 原说法 | 实测/主源码结论 |
| --- | --- | --- |
| 1 | 「`data-tauri-drag-region` 是原生拖拽区，**无需** JS 权限」 | **错**。`tauri-2.11.6/src/window/scripts/drag.js:104` 走 `plugin:window\|start_dragging` **IPC、受 ACL 管**；缺 `core:window:allow-start-dragging` ⇒ **拖不动且无报错**（磁贴无边框，拖动头是唯一移动方式） |
| 2 | 「`core:window:default` 的 28 项**全是只读**」 | **错**。第 28 项 `allow-internal-toggle-maximize` 是写操作（27 只读 + 1 写）；因此双击拖拽区会**把磁贴最大化**，已用 `deny-internal-toggle-maximize` 否决（Tauri 自带单测 `denied_command_takes_precendence` 证明 deny 优先） |
| 3 | 「浏览器 dev 下 `initDb()` / `Database.load()` **永久挂起、永不 reject**」 | **错**。实测两条路径都是**快速失败 + 可读原因**（见 §7.2 的最小复现与结果表）：`initDb()` → `数据库不可用：当前不在 Tauri 运行环境…`；裸 `Database.load()` → `Cannot read properties of undefined (reading 'invoke')` |

> **三条的共同教训**：它们都属于「**不报错、不白屏、构建门全绿**」的静默失效，
> 或"看起来合理"的推断。**凡要写进文档/契约的"事实"，先做一次最小复现或去读主源码** ——
> 否则文档会把错误固化成团队的集体记忆，比没有文档更糟（§7.2 末尾同一条纪律）。

**仍待人工确认（本环境无法可靠注入真实鼠标/键盘，见 L10）**：磁贴**拖动是否真的跟手**、
**双击是否真的不最大化**、托盘点击、以及 §6.5 里 1–9 的点击/拖拽步骤。
`pnpm check:tile` 只能证明这两条权限**在文件里**，**不能**替代真机确认。

---

### 6.7 t20（集成总装）的验证证据

| 项 | 证据 |
| --- | --- |
| **全部门** | `pnpm check:all` = **12 道门 exit 0**；另 `pnpm verify:acl`（56）/ `verify:migrations`（46）/ `verify:stores`（19）/ `verify:data`（**7/7 逐字节相同**）全绿 |
| **接线落地** | `src/main.tsx`（`?tile=` 路由）、`src/App.tsx`（`onRenameTag` / `onUpdateTagColor` / `handleToggleTile` / `handlePinCurrentNote` / `refreshTileState`）、`src/features/editor/EditorPane.tsx`（可选 props `onToggleTile`/`tilePinned`）、`src/lib/hotkeys.ts`（`pinCurrentNote` / `tilesVisibilityChanged`）、`src/features/settings/shortcuts.ts`（6 动作）—— 明细见 §5.3 |
| **真机启动** | `pnpm tauri:dev`：Rust 编译通过（`Finished dev profile`）→ `Running target\debug\zhijian.exe` → 窗口「纸笺」`Responding=True`；日志含**契约自检的 8 条事件**（含 t19 的 `tiles-visibility-changed` / `pin-current-note-requested`）、「系统托盘已就绪」、「全局快捷键已注册：Alt+N / Alt+Shift+Z」 |
| **真机数据层** | 启动后 `_sqlx_migrations=[v1 init success]`、`_zj_migrations=[v1,v2]`、`notes` **7 行且 `rel_path`/`file_size` 与 vault 中 md 实际大小逐一对应**（379/358/153/167/153/153/153）⇒ 索引是按 md **重建**出来的，说明前端启动序列跑到了 `ready`；FTS 与 trigram 表齐全 |
| **无磁贴不落盘** | 启动后 `%APPDATA%\com.zhijian.app\tiles.json` **不存在**（几何惰性创建，不在启动时凭空造文件） |
| **迁移逐条核对** | `pnpm verify:data`：旧库 7 条 ↔ vault 7 个 md，**id / 标题 / 正文（逐字节）/ 标签 / 置顶 / 创建与更新时间 / 排序位 / 所属目录**全部一致；`folders.json`（诗词、文学）与 `tags.json`（996）覆盖旧库；备份可打开且 `notes=7`；`migrated.json` 计数与旧库一致 |
| **Bug 1 / Bug 2 动态复核** | 见 `docs/QA-REPORT.md §9.5`：浏览器里驱动真实组件 —— `select(null)`（有→无）**不再白屏**；`simulateComposition` 组合期间装饰重建 **0** 次、光标不被重置 |
| **知识库检索双路径** | 2 字符「明月」走 LIKE 兜底命中 **2** 条；3 字符「明月几」走 trigram 命中 **2** 条；「水调歌头」命中 **1** 条 ⇒ 与 `src/db/search.ts` 的「<3 字符落 LIKE」设计一致（**曾误以为搜索坏了，实为我探针用了 trigram 表查 2 字查询**） |

#### 仍需**人工**复核（本环境无法可靠注入真实鼠标/键盘，见 L10）

1. 磁贴：创建 / **拖动**（`allow-start-dragging` 是否真的生效）/ **关闭**（`allow-close`）/ 双击是否不最大化；
2. `Alt+N` **连按 3 次 → 恰好 3 条笔记**（D1 的端到端样本；t31 已用专门断言在组件层覆盖，真机按键仍需人做）；
3. 点**空白文件夹 / 空标签 / 回收站**（真机跑一遍 Bug 2 路径；浏览器端已复核）；
4. 用**中文输入法**在编辑器打字 + 回车（真机 IME；合成事件已复核）；
5. 导出笔记（Markdown/HTML/纯文本，含文件对话框）、设置面板各项交互、托盘图标点击；
6. 侧栏标签「重命名 / 改颜色」菜单项**确实出现**且改色后色点同步（§5.3 末条）。

---

## 7. 出问题时的排查入口

| 症状 | 先看哪里 |
| --- | --- |
| 启动即失败 / 白屏 | **先按 §7.1 的流程定位，不要凭报错栈直接改代码**；再看 `App.tsx` 的 `bootState`（`failed` 会把 `bootError` 显示在空状态里） |
| 数据库打不开 / checksum mismatch | §5 的 L7；确认没人改过 `src-tauri/migrations/1_init.sql` |
| 笔记读不出来 | `pnpm check:db`（数据层自检）；`src/db/index.ts` 的 `getFtsDiagnostics()` |
| 搜索没结果 | 确认查询长度：< 3 个字符走 `LIKE` 兜底；≥ 3 走 trigram。`getSearchStrategy()` 可查当前策略 |
| 关闭按钮行为不对 | ARCHITECTURE §4.13（四条硬规则）；`window::should_hide_on_close()` |
| 主题不生效 | 确认 `main.tsx` 调用了 `initTheme()`；localStorage 键是 `zj:theme` |
| 永久停在「启动中」 | §7.2。**先排除一个已被实测否定的假设**：`initDb()` 在浏览器里并不会挂起，而是**立即 reject 并给出可读原因** |
| **磁贴拖不动** | ARCHITECTURE §4.14.8 —— `core:window:allow-start-dragging` 必须显式授权（`data-tauri-drag-region` 走 IPC、不是免权限原生区）。现象是「拖着没反应」且**无任何报错** |
| 双击磁贴头把便签**最大化了** | ⚠️ **t22 更正**：`core:window:default` 含 `allow-internal-toggle-maximize`，而 `deny-internal-toggle-maximize` **挡不住 `drag.js` 的注入调用路径**（t21 实测）。真正的护栏是 `src-tauri/src/tiles.rs` 的 `.maximizable(false)`（框架 `plugin.rs:228` 只在 `is_maximizable()` 为真时最大化）+ `sanitize_geometry()` 几何闸门；复验用 `pnpm probe:tile-maximize`。**别再加 deny 就以为修好了**（详见 ARCHITECTURE §4.14.8 修正记录 ③） |
| 重建索引后**侧栏计数没变** | t22-F2：重建成功后必须触发外层元数据重载（`SettingsPanel.onIndexRebuilt` → App 的 `handleExternalDataChanged` = `refresh()` + `reloadMeta()`）。复验用 `pnpm probe:index-refresh`（真实点击 + 徽标前后对照） |
| 磁贴重启后位置没恢复 | 先按顺序查：① 能否拖动（拖不动 ⇒ 根本没有 `Moved` 事件，几何链全程不触发）；② `%APPDATA%\com.zhijian.app\tiles.json` 是否出现/含该 `noteId`；③ 是否在「退出纸笺」里真退出（直接杀进程不会走 `cleanup_all` 落盘） |

### 7.1 白屏（`#root` 为空）的标准诊断流程

**⚠️ 先记住一个特性**：当 **ESM 模块图**加载失败（例如某文件缺一个具名导出、或语法错误）时，
`src/main.tsx` 的 `createRoot(...).render()` **根本不会执行** ⇒ 页面**纯白**、连 CSS 都不注入、
**没有 Vite overlay**（overlay 只在能被拦下的编译错误时出现）。
此时 React 的 ErrorBoundary **也不会显示**，所以"看不到任何报错"是正常的。

**标准流程（按顺序，前两步不要跳过）**：

1. **重启 dev server 并清缓存**（用于**排除**中间态，而不是用来"结案"）：
   ```bash
   # 停掉当前 dev server，然后：
   pnpm exec vite --force
   ```
   `--force` 会丢弃 Vite 的依赖预打包与旧模块图。**改了公共模块后最容易踩这个坑。**

   ⚠️ **关键判断**：重启后问题**消失** ⇒ 中间态，收工；重启后**依旧纯白** ⇒ **是真 bug，按第 2 步继续查**。
   **绝不要**因为"症状像 HMR 中间态"就停止排查（下面的案例 ① 就是被这条路漏掉过的真缺陷）。

2. **用 `import()` 探针定位真正抛错的模块**（不要相信报错栈的"位置"，模块图失败会串味）：
   在浏览器 DevTools 的控制台执行：
   ```js
   for (const p of ['/src/lib/appPreferences.ts', '/src/App.tsx']) {
     try { await import(p); console.log('OK  ', p) }
     catch (e) { console.log('FAIL', p, e.message) }
   }
   ```
   - 若某模块报 `does not provide an export named 'X'` ⇒ **去那个模块看导出名**，通常是改名/删除后
     还有别的文件在 import 旧名字（例如 t17 期间 `dispatchShortcutTrigger` 改名为 `dispatchShortcutEvent`）。
   - 若报 `Cannot access 'X' before initialization` ⇒ 才是真的 TDZ/循环依赖问题；**但先做第 1 步**，
     过期模块图也会伪造出这类错误。

3. 确认 `#root` 的状态，判断是"没挂载"还是"挂载了但渲染空"：
   ```js
   ({ rootChildren: document.getElementById('root').children.length,
      hasHeader: !!document.querySelector('header'),
      accent: getComputedStyle(document.documentElement).getPropertyValue('--zj-accent') })
   ```
   `rootChildren === 0` 且 `accent === ''` ⇒ 属第 1/2 步的模块图问题（不是应用逻辑 bug）。

**实战案例（2026-09-26，并行期**两个**加载期故障，均表现为同一种纯白）**：

| # | 故障 | 性质 | 处置 | 状态 |
| --- | --- | --- | --- | --- |
| ① | `appPreferences.ts` 的 **ESM 初始化顺序（TDZ）**：模块顶层副作用 `applyContentFontSize()`（当时在文件靠前处）读取了定义在**其后**的 `CONTENT_FONT_VAR` ⇒ 模块求值即抛 `ReferenceError: Cannot access 'CONTENT_FONT_VAR' before initialization` | **真实缺陷**（不是中间态） | 由 system 修复：把 `const CONTENT_FONT_VAR` **上移到所有使用点之前**（现 `:267`，顶层调用现 `:343`），并在源码留注释记录教训 | ✅ 已修 |
| ② | `settings/shortcuts.ts` 的**导出改名中间态**：`dispatchShortcutTrigger` 改名为 `dispatchShortcutEvent` 的过渡瞬间，模块图报 `does not provide an export named 'dispatchShortcutTrigger'` | 中间态（HMR 产物） | `pnpm exec vite --force` 重启 dev server 后消除 | ✅ 重启即好 |

**两者的症状完全一致**：纯白、无 Vite overlay、ErrorBoundary 不显示、**报错栈指向无辜模块**。
⇒ 所以**不能**凭"症状像中间态"就断定不是真 bug —— 上面 ① 就是真 bug，`typecheck` 与 `vite:build`
**都是绿的**（编译器看不到运行时的初始化顺序）。

> ⚠️ **一条方法论教训（我实际踩过）**：验证别人的 bug 报告时，**必须先确认代码自对方观察之后是否已被修改**。
> 我曾在 ① 被修复**之后**才去测量，得到"无 TDZ"，于是错误地宣布"初诊被推翻"。
> **正确做法**：先看文件 `LastWriteTime` / 复现对方的确切版本，再下结论。

**本案例的正确用法**：①→去查真实的初始化顺序（并给顶层副作用加"依赖的 const 必须在上方"的纪律）；
②→`--force` 重启。**两者都要先按第 1、2 步定位到真正抛错的模块**，再决定是改代码还是重启。

### 7.2 永久「启动中」怎么查（含 `initDb` 行为的实测结论）

**背景**：曾有一条"待写入文档的已知项"声称 —— 浏览器 dev 下 `initDb()` / `Database.load()`
**永久挂起、永不 reject**，导致界面永久停在「启动中」且控制台无报错。
**该说法经实测否定，不要再照它排查。**

**最小复现（浏览器 DevTools 控制台里逐条粘贴，`pnpm dev` 已启动）**：

```js
// ① 应用自己的守卫路径：应当立刻 reject，且原因是可读中文
const m = await import('/src/db/index.ts')
await Promise.race([
  m.initDb().then(() => 'resolved').catch(e => 'rejected: ' + e.message),
  new Promise(r => setTimeout(() => r('STILL-PENDING'), 4000)),
])

// ② 绕过守卫、直接碰底层插件：同样立刻 reject
const mod = await import('/node_modules/.vite/deps/@tauri-apps_plugin-sql.js')
await Promise.race([
  (mod.default ?? mod.Database).load('sqlite:zhijian.db').then(() => 'resolved').catch(e => 'rejected: ' + e.message),
  new Promise(r => setTimeout(() => r('STILL-PENDING'), 4000)),
])
```

> ⚠️ 第二条的模块 URL 带 hash（`?v=...`），**实际路径要去 `/src/db/index.ts` 的浏览器源码里看**
> （Vite 会把 `@tauri-apps/plugin-sql` 重写成 `/node_modules/.vite/deps/@tauri-apps_plugin-sql.js?v=<hash>`），
> 直接写 `import('@tauri-apps/plugin-sql')` 会报 `Failed to resolve module specifier`（裸模块名不经 Vite 转换）。

**2026-09-26 实测结果（真实 Chromium，Vite 7.3.6，`@tauri-apps/plugin-sql@2.4.1`）**：

| 探测 | 结果 |
| --- | --- |
| ① `initDb()` | `rejected: 数据库不可用：当前不在 Tauri 运行环境（请使用 pnpm tauri:dev 启动）`（守卫 `src/db/index.ts:117`） |
| ② 裸 `Database.load()` | `rejected: Cannot read properties of undefined (reading 'invoke')` |
| 应用实际状态 | `#root` 有 2 个子节点；界面显示「浏览器预览模式：没有 SQLite，无法读写笔记」；控制台 **0 报错**；**没有**卡在 `booting` |

**⇒ 正确结论与后续排查顺序**：

1. `initDb` 这条路是**快速失败 + 可读原因**，**排除**它作为"永久启动中"的原因；
2. 真见到永久「启动中」时去查**启动流程本身**：`App.tsx` 里 `bootState` 是否存在**未被 resolve 的
   `await`**（例如某个只给 `isTauri === true` 才 resolve 的 Promise 忘了走 else 分支）；
3. 若怀疑"挂起"，**先按上面的两行复现**——**别把假设当事实往文档里写**。

> 这条本身是一条方法论留痕：**"要写进文档的已知项"也必须先跑一次最小复现**。
> 否则文档会把一个错误的原因固化成团队的集体记忆，下一轮所有人都会照它排查（比没有文档更糟）。

### 7.3 自检编写规范（**强制**；本轮同一模式至少出现 4 次）

> **为什么单独立一节**：这类错误的特征是 —— **检查全绿，但检查本身是假的**。
> 它比"没写检查"更危险：**它会让人以为已经设防了**。本轮我们花很大力气把缺陷做成"机器能发现的东西"，
> 如果这些机器本身不可靠，那一切都白费。
> 触发这件事的是 system 在 t38 里**第 3 次**踩到同一个坑，而另两位成员（含我）也各踩过一次 ——
> 说明这是**模式天然容易犯**，不是谁不小心。

#### 四条硬规则

| # | 规则 | 反面实例（本轮真实发生） |
| --- | --- | --- |
| 1 | **任何"关键字/符号存在性"断言，必须先剥注释再匹配**（按文件类型剥 `//`、`/* */`、`#`、`<!-- -->`） | ① 我用 `/\.maximizable\(false\)/` 扫 `tiles.rs` —— **把那一行注释掉，断言仍然通过**（关键字出现在注释里）；② system 的 `window::init` 断言命中了它**自己写的注释**；③ shell 的 `tag-source-consistency` 首版同样被注释骗绿；④ system 自述在 `listen(EVENTS.…)`、`plugin:autostart\|` 上**已各犯一次** |
| 2 | **"存在性"断言要做非空防呆**：扫到 **0 处应当失败**（防的是"断言因为找不到东西而空跑通过"） | `d1-single-subscription.mjs` 里的「扫描到 `listen(EVENTS.*)` 调用点（非空，防止断言空跑）」就是正确样板；凡是 `every()/filter()` 型断言都要问一句"**它扫到 0 个会不会静默通过**" |
| 3 | **断言要对齐真实结构**（大括号配对 / 语法树），**不要用"往后看 N 个字符"** | system 本轮用数字符的写法**两次算错 `if/else` 边界**：把 `else` 算进 `if`；漏掉 `window::init` 位于 `else if` 条件里、在大括号之外。我的做法是先**剥注释**再按行号比较（`if (!note) {` 之后不得出现 Hook） |
| 4 | **每条"防回归"断言都必须用变异测试证明它真的会红** | 本轮这条规矩救过至少三次：命令名漂移（`tile_toggle` vs `cmd_toggle_tile`）、磁贴双击最大化（`.maximizable(false)`）、**IME 守卫被重构移除**（护栏当场报红）。反之也踩过"**变异本身写错**"：我第一次把 Hook 插在提前 return **之前**（那是正确写法）却没转红，差点误判护栏失效 |

#### 操作建议（新增/修改断言时逐条过）

```text
1. 我要匹配的是"代码"还是"文本"？→ 先剥注释（含 doc 注释、行内 `// ...`）
2. 扫不到任何东西时，这条断言是红还是绿？→ 必须是红（非空防呆）
3. 我是不是在"数距离/看附近几行"？→ 改成结构判据（配对括号 / 剥注释后按行切片）
4. 把被测代码改坏一次，断言真会红吗？→ 变异测试（临时改真实文件或 `ZJ_CONTRACT_ROOT` 镜像根）
5. 断言失败信息是否**点名具体文件:行与原因**？→ 否则下一个人还得重新定位
```

> **附：一条与"假绿"配对的纪律** —— **不许给失败打绿**。
> 本轮实例：我的 `verify-data-migration.mjs` 第一版把 `-wal/-shm` 附属文件当备份去"打开"，
> 读失败时**仍然打印了 ✅**；`check:*` 这类脚本里凡出现"读取失败 → 打印成功"的组合都属同一类缺陷。
> 判据：**任何 ✅ 都必须对应一次真实的成功判据**，而不是"异常被 catch 住了"。

