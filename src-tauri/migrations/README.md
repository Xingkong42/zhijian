# 迁移目录（FROZEN 目录结构，归属：架构师 / 骨架）

Rust 侧 `tauri_plugin_sql` 在启动时按版本号顺序执行本目录下的 SQL 文件。

## 约定

- 文件名：`<version>_<snake_case_描述>.sql`，例如 `1_init.sql`。
- **版本号必须唯一且严格递增**；已发布的迁移文件禁止修改，只能新增更大的版本号。
- 每个文件内含多条语句，用 `;` 分隔（插件按 `;` 切分后逐条执行）。
- 所有建表语句必须幂等（`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`）。
- 时间戳统一 `INTEGER`（毫秒），id 统一 `TEXT`（`crypto.randomUUID()` 生成）。
- 索引与触发器与建表语句放在同一个迁移文件内。

## 与前端契约的关系

`src/db/schema.ts` 的 `SCHEMA_STATEMENTS` / `SCHEMA_MIGRATIONS` 是**同一份 DDL 的 TypeScript 副本**，
用于在非 Rust 路径（例如测试、将来切到纯前端迁移）下自举。两者必须保持一致：
修改 SQL 时同步更新 `src/db/schema.ts`，反之亦然。文件归属见 `docs/ARCHITECTURE.md`。

## 迁移清单

| 版本 | 文件 | 内容 | 执行方 |
| --- | --- | --- | --- |
| 1 | `1_init.sql` | folders / tags / notes / note_tags / notes_fts(FTS5 unicode61) + 索引 + 触发器 + app_settings | Rust `include_str!` + 前端 `initDb()`（幂等，两边都跑） |
| 2 | `2_fts_trigram.sql` | `notes_fts_trigram`（FTS5 **trigram**，中文子串检索）+ 三个同步触发器 + 回填 | **仅前端 `initDb()`**（特性门控，见下） |

### v2 为什么不由 Rust 侧执行

`trigram` tokenizer 需要 SQLite ≥ 3.34.0（本项目 bundled 为 3.46.0，实际可用），
但 sqlx 的 migrator 在 `Database.load()` 阶段一次性执行全部已登记迁移，
**没有"探测失败就跳过"的余地**：一旦运行环境的 SQLite 不支持 trigram，
整个数据库都会打不开。

因此 `2_fts_trigram.sql` 被登记为 `src/db/schema.ts` 里 `optional: true` 的迁移，
由前端 `initDb()`（契约 §4.2：启动必须先 await）先探测再执行：
探测/执行失败只降级为 `LIKE '%q%'` 检索，不阻断启动，且下次启动会自动重试。
详见 `2_fts_trigram.sql` 头注释与 `src/db/search.ts`（两条检索路径都在代码里）。

> 若要改为 Rust 侧执行，必须先在 Rust 里加同样的能力探测（`ENABLE_FTS5` +
> `sqlite_version() >= 3.34.0`）再登记，否则会把启动绑死在特定 SQLite 版本上。

## 数据层自检

```bash
pnpm check:db                                  # 56 项：迁移/结构/仓储/检索/占位符契约
node src/db/__checks__/fs-store-checks.mjs     # 33 项：md 真相源/索引重建/旧库无损迁移
```

会用真实 SQLite 引擎执行本目录两份迁移 + `src/db/__checks__/migration.check.sql`
（22 条结构/行为断言），再把 `@tauri-apps/plugin-sql` 换成 `node:sqlite` 适配器、
把文件系统换成 Node 实现（真实临时目录），对 `src/db/**` 的仓储跑全流程用例。

## t15 之后：SQLite 只是「可重建的索引」

md 文件（`<文档>/纸笺/**.md`）是唯一真相源；索引结构由
`src/db/schema.ts::INDEX_DDL_STATEMENTS` 定义，`rebuildIndex()` 直接 DROP + CREATE。
**索引层刻意不进本目录**（不新增版本化迁移文件）：索引可丢弃，DROP+CREATE 比 ALTER 安全，
也不会与 sqlx 的 checksum 冻结机制冲突（见 docs/ARCHITECTURE.md §4.12 与 §7）。
本目录的 `1_init.sql` / `2_fts_trigram.sql` 仍然保留：首次安装与 Rust 侧按它们建表。

