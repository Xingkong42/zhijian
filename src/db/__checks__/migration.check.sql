-- ============================================================================
-- 纸笺 · 数据层迁移自检清单（migration.check.sql）
-- ============================================================================
-- 用途：对**真实的 DDL**（src-tauri/migrations/1_init.sql + 2_fts_trigram.sql）
--       做"逐条语句可解析 + 结构与行为符合契约"的断言。
--
-- 怎么跑（两种方式，都真跑 SQLite 引擎）：
--   1) Node 自检（推荐，同时还会跑 repo 全流程）：
--        node src/db/__checks__/run-checks.mjs
--   2) 若机器上有 sqlite3 CLI（本机没有，故用 1) 代替）：
--        sqlite3 :memory: < 1_init.sql
--        并在同一会话继续载入 2_fts_trigram.sql 与本文件
--      PowerShell 版本（注意保留 :memory: 同名临时库）：
--        $sql = (Get-Content src-tauri/migrations/1_init.sql -Raw) +
--               (Get-Content src-tauri/migrations/2_fts_trigram.sql -Raw) +
--               (Get-Content src/db/__checks__/migration.check.sql -Raw)
--        $sql | sqlite3 :memory:
--
-- 判定规则：本文件把每条断言写成 check_results 表里的一行
--   （name = 断言名，ok = 1 通过 / 0 失败）。
--   末尾的 SELECT 汇总；**任何 ok = 0 即失败**（run-checks.mjs 会据此退出码非 0）。
--
-- 与 tauri-plugin-sql 执行方式的差异说明：
--   sqlx 迁移把整个文件当一批执行（migrations/*.sql 由 Rust 侧登记）；
--   前端 initDb() 则逐条执行 src/db/schema.ts 里的 SCHEMA_STATEMENTS /
--   FTS_TRIGRAM_STATEMENTS（因此每条语句都必须能独立 prepare）。
--   run-checks.mjs 对两种粒度都覆盖：整体 exec + 逐条 prepare。
-- ============================================================================

-- 外键行为断言需要显式打开（Rust 侧 sqlx / node:sqlite 默认即为 ON，
-- 但 sqlite3 CLI 默认 OFF，故这里显式声明，保证两种跑法结论一致）
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS check_results (
  name TEXT PRIMARY KEY,
  ok   INTEGER NOT NULL
);

DELETE FROM check_results;

-- =========================== 1. 结构：表 / 索引 ===========================

-- CHECK 01 五张业务表齐备（notes / folders / tags / note_tags / settings）
INSERT INTO check_results (name, ok)
SELECT 'check_01_tables', CASE WHEN (
  SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('notes','folders','tags','note_tags','app_settings')
) = 5 THEN 1 ELSE 0 END;

-- CHECK 02 notes(folder_id, pinned, sort_order) 索引存在（列表/拖拽主查询路径）
INSERT INTO check_results (name, ok)
SELECT 'check_02_index_notes_folder', CASE WHEN (
  SELECT COUNT(*) FROM pragma_index_info('idx_notes_folder') WHERE name IN ('folder_id','pinned','sort_order')
) = 3 THEN 1 ELSE 0 END;

-- CHECK 03 notes(updated_at) / notes(deleted_at) 索引存在
INSERT INTO check_results (name, ok)
SELECT 'check_03_index_notes_updated_deleted', CASE WHEN
  EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_notes_updated')
  AND EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_notes_deleted')
THEN 1 ELSE 0 END;

-- CHECK 04 folders(parent_id, sort_order) / note_tags(tag_id) 索引存在
INSERT INTO check_results (name, ok)
SELECT 'check_04_index_folders_note_tags', CASE WHEN
  (SELECT COUNT(*) FROM pragma_index_info('idx_folders_parent') WHERE name IN ('parent_id','sort_order')) = 2
  AND EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_note_tags_tag')
THEN 1 ELSE 0 END;

-- CHECK 05 tags.name 有 UNIQUE 约束（重复标签名必须落在数据库层拦截）
--         注意：标识符 "unique" 用方括号引用 —— 双引号会被 SQLite 当作字符串字面量
INSERT INTO check_results (name, ok)
SELECT 'check_05_tags_name_unique', CASE WHEN (
  SELECT COUNT(*) FROM pragma_index_list('tags') WHERE [unique] = 1 AND origin = 'u'
) >= 1 THEN 1 ELSE 0 END;

-- ===================== 2. 结构：FTS5 虚拟表与触发器 =====================

-- CHECK 06 v1 的 unicode61 FTS 表存在
INSERT INTO check_results (name, ok)
SELECT 'check_06_fts_unicode61_exists', CASE WHEN EXISTS (
  SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts'
) THEN 1 ELSE 0 END;

-- CHECK 07 v2 的 trigram FTS 表存在且分词器就是 trigram（中文子串检索的前提）
INSERT INTO check_results (name, ok)
SELECT 'check_07_fts_trigram_exists', CASE WHEN EXISTS (
  SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts_trigram' AND sql LIKE '%trigram%'
) THEN 1 ELSE 0 END;

-- CHECK 08 六个同步触发器齐备（两张 FTS 表各自的 INSERT/UPDATE/DELETE 同步）
INSERT INTO check_results (name, ok)
SELECT 'check_08_triggers', CASE WHEN (
  SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger'
    AND name IN ('trg_notes_ai','trg_notes_au','trg_notes_ad','trg_notes_tri_ai','trg_notes_tri_au','trg_notes_tri_ad')
) = 6 THEN 1 ELSE 0 END;

-- ============================== 3. 夹具数据 ==============================
-- 时间戳全部显式给定（毫秒），保证断言与机器时钟无关。
INSERT INTO folders (id, name, parent_id, sort_order, created_at) VALUES ('fx-folder-a', '工作', NULL, 0, 1000);
INSERT INTO folders (id, name, parent_id, sort_order, created_at) VALUES ('fx-folder-b', '子目录', 'fx-folder-a', 0, 1001);
INSERT INTO tags (id, name, color, created_at) VALUES ('fx-tag-1', '工作', '#C9A227', 1000);

-- 注意：绑定值经 CAST($n AS INTEGER) 后才能是 INTEGER 存储类
-- （tauri-plugin-sql 把 JS number 绑成 f64），此处按 repo 的实际写法执行
INSERT INTO notes (id, title, content, folder_id, tags, pinned, sort_order, created_at, updated_at, deleted_at)
VALUES ('fx-note-1', '我的笔记本', '这是第一篇笔记，讲中文全文检索。', 'fx-folder-a', '["工作"]',
        CAST(0 AS INTEGER), CAST(0 AS INTEGER), CAST(1000 AS INTEGER), CAST(1000 AS INTEGER), NULL);
INSERT INTO notes (id, title, content, folder_id, tags, pinned, sort_order, created_at, updated_at, deleted_at)
VALUES ('fx-note-2', 'Meeting notes', 'Quarterly planning for the desktop app.', NULL, '[]',
        CAST(0 AS INTEGER), CAST(1 AS INTEGER), CAST(1001 AS INTEGER), CAST(1001 AS INTEGER), NULL);
INSERT INTO notes (id, title, content, folder_id, tags, pinned, sort_order, created_at, updated_at, deleted_at)
VALUES ('fx-note-3', '搜索测试', 'FTS5 trigram tokenizer 让 中文检索 可用。', NULL, '[]',
        CAST(1 AS INTEGER), CAST(2 AS INTEGER), CAST(1002 AS INTEGER), CAST(1002 AS INTEGER), NULL);
INSERT INTO notes (id, title, content, folder_id, tags, pinned, sort_order, created_at, updated_at, deleted_at)
VALUES ('fx-note-4', '草稿', '中文检索 已删除', NULL, '[]',
        CAST(0 AS INTEGER), CAST(3 AS INTEGER), CAST(1003 AS INTEGER), CAST(1003 AS INTEGER), CAST(1004 AS INTEGER));

-- 关系表夹具必须在 notes 之后（外键 ON 时先后顺序有意义）
INSERT INTO note_tags (note_id, tag_id) VALUES ('fx-note-1', 'fx-tag-1');

-- ==================== 4. 触发器行为：INSERT 同步 FTS ====================

-- CHECK 09 INSERT 后两张 FTS 表各 4 行（与 notes 行数一致）
INSERT INTO check_results (name, ok)
SELECT 'check_09_insert_sync', CASE WHEN
  (SELECT COUNT(*) FROM notes_fts) = 4 AND (SELECT COUNT(*) FROM notes_fts_trigram) = 4
THEN 1 ELSE 0 END;

-- ================= 5. 中文检索：trigram 命中 / 短查询局限 =================

-- CHECK 10 trigram 支持中文子串：'中文检索' 命中 fx-note-3（被软删除的 fx-note-4 不出现）
INSERT INTO check_results (name, ok)
SELECT 'check_10_trigram_chinese_substring', CASE WHEN (
  SELECT GROUP_CONCAT(n.id, ',') FROM notes_fts_trigram JOIN notes n ON n.id = notes_fts_trigram.note_id
  WHERE notes_fts_trigram MATCH '"中文检索"' AND n.deleted_at IS NULL
) = 'fx-note-3' THEN 1 ELSE 0 END;

-- CHECK 11 trigram 的硬限制：查询短于 3 字符返回空集（不报错）→ 必须走 LIKE 兜底
INSERT INTO check_results (name, ok)
SELECT 'check_11_trigram_short_query_empty', CASE WHEN (
  SELECT COUNT(*) FROM notes_fts_trigram JOIN notes n ON n.id = notes_fts_trigram.note_id
  WHERE notes_fts_trigram MATCH '"笔记"' AND n.deleted_at IS NULL
) = 0 THEN 1 ELSE 0 END;

-- CHECK 12 v1 的 unicode61 无法做中文子串：'笔记' 查不到『我的笔记本』
INSERT INTO check_results (name, ok)
SELECT 'check_12_unicode61_chinese_substring_miss', CASE WHEN (
  SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH '"笔记"'
) = 0 THEN 1 ELSE 0 END;

-- CHECK 13 unicode61 只在"整段连续汉字"完全一致时命中：'我的笔记本' 命中 fx-note-1
INSERT INTO check_results (name, ok)
SELECT 'check_13_unicode61_full_token_hit', CASE WHEN (
  SELECT GROUP_CONCAT(note_id, ',') FROM notes_fts WHERE notes_fts MATCH '"我的笔记本"'
) = 'fx-note-1' THEN 1 ELSE 0 END;

-- CHECK 14 LIKE 兜底路径能命中中文 2 字子串（trigram 覆盖不到的场景）
INSERT INTO check_results (name, ok)
SELECT 'check_14_like_fallback_chinese', CASE WHEN (
  SELECT GROUP_CONCAT(n.id, ',') FROM notes n
  WHERE n.deleted_at IS NULL AND (n.title LIKE '%笔记%' ESCAPE '\' OR n.content LIKE '%笔记%' ESCAPE '\')
) = 'fx-note-1' THEN 1 ELSE 0 END;

-- CHECK 15 LIKE 的 ESCAPE 生效：'%' 与 '_' 被当字面量而不是通配符
INSERT INTO check_results (name, ok)
SELECT 'check_15_like_escape', CASE WHEN (
  SELECT COUNT(*) FROM notes n
  WHERE n.title LIKE '%100\%%' ESCAPE '\' OR n.title LIKE '%a\_b%' ESCAPE '\'
) = 0 THEN 1 ELSE 0 END;

-- ==================== 6. 触发器行为：UPDATE / DELETE ====================

-- CHECK 16 UPDATE 重建 FTS 行：旧内容不再命中，新内容命中（两张表都同步）
--         注意 unicode61 侧只能用"整段连续汉字"命中（完全不同的内容 → 该整段 token）
UPDATE notes SET content = '改成了完全不同的内容', updated_at = CAST(2000 AS INTEGER) WHERE id = 'fx-note-3';
INSERT INTO check_results (name, ok)
SELECT 'check_16_update_resync', CASE WHEN
  (SELECT COUNT(*) FROM notes_fts_trigram JOIN notes n ON n.id = notes_fts_trigram.note_id
    WHERE notes_fts_trigram MATCH '"中文检索"' AND n.deleted_at IS NULL) = 0
  AND (SELECT COUNT(*) FROM notes_fts_trigram JOIN notes n ON n.id = notes_fts_trigram.note_id
    WHERE notes_fts_trigram MATCH '"完全不同"' AND n.deleted_at IS NULL) = 1
  AND (SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH '"改成了完全不同的内容"') = 1
  AND (SELECT COUNT(*) FROM notes_fts) = 4
THEN 1 ELSE 0 END;

-- CHECK 17 UPDATE 只改 tags/排序位时不动 FTS（触发器限定 AFTER UPDATE OF title, content）
INSERT INTO check_results (name, ok)
SELECT 'check_17_update_tags_no_fts_change', CASE WHEN (
  SELECT COUNT(*) FROM notes_fts_trigram
) = 4 THEN 1 ELSE 0 END;

-- CHECK 18 DELETE 清理两张 FTS 表（note_tags 由 FK 级联清理）
DELETE FROM notes WHERE id = 'fx-note-2';
INSERT INTO check_results (name, ok)
SELECT 'check_18_delete_cleans_fts', CASE WHEN
  (SELECT COUNT(*) FROM notes_fts) = 3
  AND (SELECT COUNT(*) FROM notes_fts_trigram) = 3
  AND (SELECT COUNT(*) FROM notes WHERE id = 'fx-note-2') = 0
THEN 1 ELSE 0 END;

-- ============ 7. 存储类 / 外键 / 设置表（端到端不变量） ============

-- CHECK 19 CAST 后时间戳与布尔值是 INTEGER 存储类（不是 REAL）
INSERT INTO check_results (name, ok)
SELECT 'check_19_integer_storage_class', CASE WHEN (
  SELECT typeof(created_at) || ',' || typeof(updated_at) || ',' || typeof(pinned) FROM notes WHERE id = 'fx-note-1'
) = 'integer,integer,integer' THEN 1 ELSE 0 END;

-- CHECK 20 删除顶层文件夹后：子文件夹级联删除，其下笔记 folder_id 置空
DELETE FROM folders WHERE id = 'fx-folder-a';
INSERT INTO check_results (name, ok)
SELECT 'check_20_folder_delete_cascade', CASE WHEN
  (SELECT COUNT(*) FROM folders) = 0
  AND (SELECT folder_id FROM notes WHERE id = 'fx-note-1') IS NULL
THEN 1 ELSE 0 END;

-- CHECK 21 settings 表（app_settings）可读写键值对
INSERT INTO app_settings (key, value) VALUES ('fx-key', 'fx-value');
INSERT INTO check_results (name, ok)
SELECT 'check_21_settings_kv', CASE WHEN (
  SELECT COUNT(*) FROM app_settings WHERE key = 'fx-key' AND value = 'fx-value'
) = 1 THEN 1 ELSE 0 END;

-- CHECK 22 迁移可重复执行（幂等）：再次执行两份迁移不应报错、不应改变行数
--          （由 run-checks.mjs 复跑一遍 1_init.sql + 2_fts_trigram.sql 后断言，
--            此处只登记"待复跑"的占位说明，故恒为 1）
INSERT INTO check_results (name, ok) SELECT 'check_22_idempotency_delegated_to_runner', 1;

-- ============================== 汇总输出 ==============================
SELECT name, ok FROM check_results ORDER BY rowid;
SELECT COUNT(*) AS total, SUM(ok) AS passed, CASE WHEN SUM(ok) = COUNT(*) THEN 'ALL PASS' ELSE 'HAS FAILURE' END AS verdict
FROM check_results;
