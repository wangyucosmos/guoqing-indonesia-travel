# 数据与权限

`groups`：id、name、owner、invite、created_at。invite 为两个随机 UUID 拼接，仅小组成员可读取；创建者可轮换。邀请链接视作加入凭证。

`members`：group_id 与 user_id 复合主键，name 展示名。

`entries`：id、group_id、kind、scope、owner、title、data JSON、version、updated_at、updated_by、deleted。

所有 API 禁用缓存。GET 仅返回已登录用户加入的小组；记录查询同时校验成员身份和 private owner 条件。POST 校验 Origin 与 Sites 提供的登录身份、成员资格、字段和记录版本。公开页面只返回去除私人费用后的静态资料，不返回数据库内容。

同一版本只允许一次成功更新；冲突返回 409。删除为软删除，恢复同样校验版本。小组创建与模板复制使用 D1 batch 事务。版本号用于冲突检测，不代表完整历史快照。

GET `/api/travel?group=...`：用户、已加入小组、可见记录与成员显示名。
POST `/api/travel`：create、join、rotate、add、update、delete、restore。

权威认证在 Sites 边缘层完成，应用使用官方 auth add-on 读取受信身份头。生产 Worker 不应绕过 Sites 直接对外开放。本地 API 测试使用本地模拟身份，不证明真实账号登录已人工验收。

公共模板：`lib/guide.ts`。校验、时区和金额函数：`lib/travel.ts`。建表：Drizzle SQL。没有用户原 PDF、机票截图、私人价格或凭据入库/入仓库。

A/B 方案隔离：`modules.plan` 与 `entries.plan` 均为 `A` 或 `B`。新库默认 A；`migrate-plans.sql` 为已有 B 记录新增列并默认 B。GET `/api/travel?g=...&p=A|B` 只返回一套计划；首次读取缺失计划时按模板补建。POST 模块/记录操作携带并校验当前 plan，避免跨方案写入。`history` 仍由全局唯一 entry_id 关联。

返回主站链接为纯静态页面导航，不读写用户或旅行数据，不调用 API。
