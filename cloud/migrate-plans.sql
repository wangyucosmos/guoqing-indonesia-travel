-- A/B 方案迁移：旧网站所有内容安全归入 B；A 首次读取时按模板创建。
ALTER TABLE modules ADD COLUMN plan TEXT NOT NULL DEFAULT 'B';
ALTER TABLE entries ADD COLUMN plan TEXT NOT NULL DEFAULT 'B';
CREATE INDEX IF NOT EXISTS idx_modules_group_plan ON modules (group_id, plan, sort);
CREATE INDEX IF NOT EXISTS idx_entries_group_plan ON entries (group_id, plan, module_id, deleted);
