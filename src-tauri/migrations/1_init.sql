-- 纸笺 schema v1（FROZEN，只能追加不能修改；改动请新增 2_xxx.sql）
-- 与 src/db/schema.ts 的 SCHEMA_STATEMENTS 保持一致。

CREATE TABLE IF NOT EXISTS folders (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  parent_id   TEXT REFERENCES folders(id) ON DELETE CASCADE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id, sort_order);

CREATE TABLE IF NOT EXISTS tags (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  color       TEXT NOT NULL DEFAULT '#C9A227',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  folder_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
  tags        TEXT NOT NULL DEFAULT '[]',
  pinned      INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id, pinned DESC, sort_order ASC);
CREATE INDEX IF NOT EXISTS idx_notes_deleted ON notes(deleted_at);
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC);

CREATE TABLE IF NOT EXISTS note_tags (
  note_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title,
  content,
  note_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS trg_notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(title, content, note_id) VALUES (new.title, new.content, new.id);
END;

CREATE TRIGGER IF NOT EXISTS trg_notes_au AFTER UPDATE OF title, content ON notes BEGIN
  DELETE FROM notes_fts WHERE note_id = old.id;
  INSERT INTO notes_fts(title, content, note_id) VALUES (new.title, new.content, new.id);
END;

CREATE TRIGGER IF NOT EXISTS trg_notes_ad AFTER DELETE ON notes BEGIN
  DELETE FROM notes_fts WHERE note_id = old.id;
END;

CREATE TABLE IF NOT EXISTS app_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
