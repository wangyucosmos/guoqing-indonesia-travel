-- 国庆印尼旅游 · 云端协作版 D1 结构
-- 设计要点：没有账号系统。一个小组 = 一条 groups 记录 + 一串密钥，
-- 谁拿到带密钥的链接谁就能编辑。适合几个人的旅行小组，不适合公开数据。

CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  secret      TEXT NOT NULL UNIQUE,   -- 邀请密钥，只在链接的 # 片段里传，不进服务器日志
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  group_id   TEXT NOT NULL,
  member_id  TEXT NOT NULL,           -- 首次进组时浏览器本地生成，用来标记"谁改的"和私人记录归属
  name       TEXT NOT NULL,
  joined_at  TEXT NOT NULL,
  seen_at    TEXT NOT NULL,
  PRIMARY KEY (group_id, member_id)
);

-- 模块 = 页面上的一个页签。内置的和自建的走同一张表，
-- 所以内置模块也能改名、换图标、加字段、隐藏、排序。
CREATE TABLE IF NOT EXISTS modules (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  icon        TEXT NOT NULL DEFAULT '📌',
  layout      TEXT NOT NULL DEFAULT 'card',   -- card | check | day
  fields      TEXT NOT NULL DEFAULT '[]',     -- JSON: [{key,label,type,options}]
  sort        REAL NOT NULL,
  builtin     TEXT,                            -- route/guide/flight/pack/music/budget/note，自建模块为 NULL
  hidden      INTEGER NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_modules_group ON modules (group_id, sort);

CREATE TABLE IF NOT EXISTS entries (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  module_id   TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  data        TEXT NOT NULL DEFAULT '{}',     -- JSON，键对应所属模块的 fields
  scope       TEXT NOT NULL DEFAULT 'group',  -- group 全组可见 / private 仅创建者
  owner       TEXT NOT NULL DEFAULT '',
  day         TEXT NOT NULL DEFAULT '',       -- 归属日期，用于 day 布局和"这天要带什么"
  sort        REAL NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_entries_group  ON entries (group_id, module_id, deleted);
CREATE INDEX IF NOT EXISTS idx_entries_day    ON entries (group_id, day);
