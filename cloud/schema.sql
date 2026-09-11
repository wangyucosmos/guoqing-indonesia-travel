-- 国庆印尼旅游 · 云端协作版 D1 结构
-- 权限模型：没有账号，但每个成员有自己的钥匙（tokens 表）；建组人是组长。
-- 邀请链接只带 invite_code，扫码填名字后服务器才发钥匙。适合几个人的旅行小组。

CREATE TABLE IF NOT EXISTS groups (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  secret       TEXT NOT NULL UNIQUE,      -- 旧版万能钥匙，仅过渡期有效（见 legacy_until）
  created_at   TEXT NOT NULL,
  owner_id     TEXT NOT NULL DEFAULT '',  -- 组长的 member_id
  invite_code  TEXT NOT NULL DEFAULT '',  -- 邀请码，组长可随时更换
  approval     INTEGER NOT NULL DEFAULT 0,-- 1 = 新人入组要组长同意
  legacy_until TEXT NOT NULL DEFAULT ''   -- 旧钥匙有效期；新建的组为空 = 从不生效
);

CREATE TABLE IF NOT EXISTS members (
  group_id   TEXT NOT NULL,
  member_id  TEXT NOT NULL,           -- 首次进组时浏览器本地生成，之后由 tokens 绑定
  name       TEXT NOT NULL,
  joined_at  TEXT NOT NULL,
  seen_at    TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'editor',  -- owner | editor | viewer
  status     TEXT NOT NULL DEFAULT 'active',  -- active | pending | removed
  PRIMARY KEY (group_id, member_id)
);

-- 每人可以有多把钥匙（每台设备一把）。只存哈希；移除成员时整批删掉。
CREATE TABLE IF NOT EXISTS tokens (
  hash        TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  member_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tokens_member ON tokens (group_id, member_id);

-- 换设备码：8 位数字，10 分钟有效，一次性
CREATE TABLE IF NOT EXISTS transfers (
  code        TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  member_id   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0
);

-- 记录的历史版本：每次改动前快照，每条最多留 20 个
CREATE TABLE IF NOT EXISTS history (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  entry_id    TEXT NOT NULL,
  version     INTEGER NOT NULL,
  title       TEXT, data TEXT, scope TEXT, day TEXT, sort REAL, deleted INTEGER,
  changed_at  TEXT NOT NULL,
  changed_by  TEXT NOT NULL,
  action      TEXT NOT NULL             -- update | delete | restore | revert
);
CREATE INDEX IF NOT EXISTS idx_history_entry ON history (entry_id, version DESC);

-- 模块 = 页面上的一个页签。内置的和自建的走同一张表，
-- 所以内置模块也能改名、换图标、加字段、隐藏、排序。
CREATE TABLE IF NOT EXISTS modules (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  icon        TEXT NOT NULL DEFAULT '📌',
  layout      TEXT NOT NULL DEFAULT 'card',   -- card | check | day
  fields      TEXT NOT NULL DEFAULT '[]',     -- JSON: [{key,label,type,options}]
  group_by    TEXT NOT NULL DEFAULT '',       -- 按哪个字段分组显示（空 = 不分组），例如航班按"谁的"分
  locked      INTEGER NOT NULL DEFAULT 0,     -- 1 = 只有组长能改这个模块里的记录
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
