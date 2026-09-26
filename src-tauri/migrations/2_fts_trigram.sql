-- 纸笺 schema v2 —— 中文友好的 trigram 全文索引（**特性门控 / 可选迁移**）
-- ============================================================================
-- 为什么需要它？
--   v1 的 notes_fts 使用 FTS5 默认分词器 unicode61。unicode61 把「连续的中日韩
--   表意文字」当作**一个 token**：标题「我的笔记本」整体是一个 token，
--   因此 MATCH '"笔记"'、MATCH '"笔记本"' 都**查不到**（实测见
--   src/db/__checks__/migration.check.sql 的 check_13）。
--   中文用户最自然的检索方式恰恰是**子串**（「笔记」「检索」「便签」都是 2 字词），
--   故 v2 追加一张 trigram 分词器的 FTS5 表：trigram 把文本切成 3 字符滑窗，
--   原生支持子串 / LIKE 加速，中文（含 2 字词以外的任意长词）都能命中。
--
-- 为什么放在"可选迁移"里？（选定理由，前端实现见 src/db/search.ts 头注释）
--   trigram tokenizer 自 SQLite **3.34.0** 起内置于 FTS5 模块，无需额外编译开关；
--   本项目 tauri-plugin-sql → sqlx → libsqlite3-sys(bundled) 静态编译的是
--   SQLite 3.46.0（已在 target/debug/build/libsqlite3-sys-*/output 与
--   sqlite3/sqlite3.h 中确认，且编译开关含 -DSQLITE_ENABLE_FTS5），
--   因此运行时必然可用。但为了**不把应用启动绑死在某个 SQLite 版本上**，
--   本文件被登记为 src/db/schema.ts 中 optional: true 的迁移：
--   initDb() 先探测（ENABLE_FTS5 编译开关 + sqlite_version() >= 3.34.0），
--   探测通过才执行；探测失败或执行失败时**跳过且不写版本号**，
--   检索自动回落到 LIKE '%q%' 路径，应用照常可用、下次启动可自愈重试。
--   两条路径都在代码里实现，见 src/db/search.ts。
--
-- 与 Rust 侧的关系：
--   src-tauri/src/lib.rs 的 MIGRATION_SOURCES 目前只 include_str! 了 1_init.sql。
--   本文件**故意不注册**到 Rust 的 sqlx migrator：sqlx 迁移在
--   Database.load() 阶段一次性执行，没有任何"探测失败就跳过"的余地，
--   一旦运行环境的 SQLite 不支持 trigram 就会让整个数据库打不开。
--   因此 v2 由前端 initDb()（契约 §4.2：启动必须先 await initDb()）负责执行。
--   若将来要让 Rust 侧接管，需先在 Rust 里加同样的能力探测再登记。
--
-- 幂等性：全部语句可重复执行 —— CREATE ... IF NOT EXISTS + 清空后回填。
-- ============================================================================

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts_trigram USING fts5(
  title,
  content,
  note_id UNINDEXED,
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS trg_notes_tri_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts_trigram(title, content, note_id) VALUES (new.title, new.content, new.id);
END;

CREATE TRIGGER IF NOT EXISTS trg_notes_tri_au AFTER UPDATE OF title, content ON notes BEGIN
  DELETE FROM notes_fts_trigram WHERE note_id = old.id;
  INSERT INTO notes_fts_trigram(title, content, note_id) VALUES (new.title, new.content, new.id);
END;

CREATE TRIGGER IF NOT EXISTS trg_notes_tri_ad AFTER DELETE ON notes BEGIN
  DELETE FROM notes_fts_trigram WHERE note_id = old.id;
END;

-- 回填历史数据（在 v1 已经写入过笔记的库上创建本表时必需；空库上是 no-op）
DELETE FROM notes_fts_trigram;
INSERT INTO notes_fts_trigram(title, content, note_id) SELECT title, content, id FROM notes;
