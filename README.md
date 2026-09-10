# 国庆印尼旅游 · 岛屿之间

2026 国庆科莫多、巴厘岛 / 罗威纳、布罗莫攻略与搭子云端协作网站。

使用方式：浏览公开攻略；登录 ChatGPT 后创建小组，系统复制攻略模板。复制小组邀请链接并转换二维码，搭子扫描、登录、加入后即可一起编辑。不要将私人预算导出文件公开。

## 开发

Node.js >= 22.13。`npm ci` 安装，`npm run dev` 本地开发，`npm run typecheck` 检查类型，`npm test` 测试金额与时区，`npm run build` 生产构建。数据库变更运行 `npm run db:generate`。

本地生产 Worker 的模拟身份接口测试：启动 `wrangler dev --config dist/server/wrangler.json --port 3001 --local --persist-to .wrangler/state` 并应用迁移后，运行 `node tests/api-check.mjs`。该测试仅针对本机，不能用于生产身份模拟。

部署需要 Sites 的 D1 与受信认证边缘层；不能直接作为 GitHub Pages 静态站点部署。源码不包含用户 PDF、个人价格、云端数据库或凭据。

航班采用手动状态和外部查询；地图提供 OSM 浏览及 Google Maps 导航；预算汇率为手动填写。完整范围参见 PROJECT_BRIEF.md、PAGE_MAP.md 和 DATA_MAP.md。

照片：Jakub Hałun / Wikimedia Commons，CC BY 4.0，缩放并裁切。来源及授权在网站照片下方。
