-- B 方案迁移：加列、加表。不删不改任何现有数据。
ALTER TABLE groups  ADD COLUMN owner_id     TEXT NOT NULL DEFAULT '';
ALTER TABLE groups  ADD COLUMN invite_code  TEXT NOT NULL DEFAULT '';
ALTER TABLE groups  ADD COLUMN approval     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE groups  ADD COLUMN legacy_until TEXT NOT NULL DEFAULT '';
ALTER TABLE members ADD COLUMN role         TEXT NOT NULL DEFAULT 'editor';
ALTER TABLE members ADD COLUMN status       TEXT NOT NULL DEFAULT 'active';
ALTER TABLE modules ADD COLUMN locked       INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY, group_id TEXT NOT NULL, member_id TEXT NOT NULL,
  created_at TEXT NOT NULL, label TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_tokens_member ON tokens (group_id, member_id);
CREATE TABLE IF NOT EXISTS transfers (
  code TEXT PRIMARY KEY, group_id TEXT NOT NULL, member_id TEXT NOT NULL,
  expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS history (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, entry_id TEXT NOT NULL, version INTEGER NOT NULL,
  title TEXT, data TEXT, scope TEXT, day TEXT, sort REAL, deleted INTEGER,
  changed_at TEXT NOT NULL, changed_by TEXT NOT NULL, action TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_history_entry ON history (entry_id, version DESC);
