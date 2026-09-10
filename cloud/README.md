# 国庆印尼旅游 · 云端协作版

搭子扫码进来，一起编辑行程、清单、预算；模块和字段本身也能自己加。
没有账号系统 —— 一条带密钥的链接就是入场券。

- 前端：`public/`（原生 JS，无构建步骤）
- 接口：`functions/api/travel.js`（Cloudflare Pages Functions）
- 数据库：Cloudflare D1，建表脚本 `schema.sql`
- 二维码：`public/qr.js`，本地生成，不调任何第三方二维码服务

**页面运行时零外部请求** —— 不加载字体、地图、统计、CDN，只跟自己的 `/api` 说话。
这是为了在大陆网络下能稳定打开。

---

## 一次性部署（约 20 分钟）

### 1. 买域名

Cloudflare 控制台 → **Domain Registration** → **Register Domain**。
`.com` 约 $10.44/年，按成本价，续费同价。需要 Visa/Mastercard 或 PayPal。

> 免费的 `xxx.pages.dev` 在大陆访问不稳定，**必须自备域名**。
> 服务器在 Cloudflare（境外），不需要 ICP 备案。

### 2. 建数据库

Cloudflare 控制台 → **Storage & Databases → D1** → **Create**，
名字填 `guoqing-indonesia`。

### 3. 建 Pages 项目

**Workers & Pages → Create → Pages → Connect to Git**，选 `guoqing-indonesia-travel` 仓库，构建设置：

| 项 | 值 |
|---|---|
| Framework preset | None |
| Build command | 留空 |
| Build output directory | `public` |
| Root directory | `cloud` |

### 4. 绑定数据库

项目 **Settings → Functions → D1 database bindings → Add binding**：

- Variable name：`DB`（**必须叫这个**，代码里读的是 `env.DB`）
- D1 database：`guoqing-indonesia`

Production 和 Preview 两个环境都要加。加完**重新部署一次**才生效。

### 5. 建表

在本机仓库目录下跑一次（`--remote` 是打到线上库，不是本地）：

```bash
npx wrangler d1 execute guoqing-indonesia --remote --file cloud/schema.sql
```

### 6. 绑定域名

项目 **Custom domains → Set up a custom domain**，填你买的域名。
证书几分钟内自动签发。

### 7. 验收（这一步不能省）

用**手机蜂窝网络**（不是 Wi-Fi）打开域名，确认：

1. 页面能打开
2. 建一个小组，二维码能显示
3. 把链接发到微信里，**在微信内置浏览器里点开**能正常加载
4. 换一台手机扫码，能填名字进组，改的内容两边都看得到

四条都过了再把二维码发给搭子。

---

## 本地开发

```bash
cd cloud
npx wrangler pages dev public --d1 DB=guoqing-indonesia --port 8788 --persist-to .wrangler/state
```

首次要给本地库建表 —— miniflare 的库文件在
`.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite`，
用 sqlite3 把 `schema.sql` 灌进去即可（`wrangler d1 execute --local` 走的是另一个实例，对不上）。

改完代码刷新页面就行，没有构建步骤。

---

## 安全边界

**拿到邀请链接的人，不用登录就能读写整个小组的全部内容。**

这是刻意的设计：几个人的旅行小组，加账号体系不值得。代价是链接必须当钥匙保管。

具体做法：

- 密钥 40 位随机，放在链接的 `#` 片段里 —— `#` 后面的内容浏览器**不会**发给服务器，
  所以不会进 Cloudflare 访问日志，也不会随 Referer 泄露给外部站点
- 页面加载后立刻用 `history.replaceState` 把地址栏里的密钥清掉，截图转发不会漏
- 调接口时密钥走 `X-Trip-Key` 请求头，不放 URL query
- 每个人首次进组时本机生成一个 member id，用来标记"谁改的"和隔离私人记录

**不适合放**：证件号、银行卡、护照照片、订单密码。页面底部有提示。

想换掉泄露的链接：目前只能新建小组。轮换密钥的功能还没做。

---

## 冲突处理

每条记录带版本号。两个人同时改同一条时，后保存的会收到 409，
弹窗保持打开、**保留你已经填的内容**，并提示队友刚改过；确认后再点一次保存就覆盖成你的版本。

前台每 15 秒自动同步一次；切回前台或网络恢复时立刻同步。编辑弹窗打开时不打扰。

---

## 结构

```
cloud/
├── schema.sql                 建表（groups / members / modules / entries）
├── wrangler.toml              本地开发配置
├── functions/api/
│   ├── travel.js              全部接口：建组/加入/模块增删改/记录增删改/回收站
│   └── _seed.js               建组时铺的初始攻略数据（下划线开头不会成为路由）
└── public/
    ├── index.html             页面骨架
    ├── app.js                 主应用，按云端返回的模块定义动态渲染
    ├── qr.js                  二维码生成（字节模式，纠错 M，版本 1–10）
    ├── seed.js                未建组时只读公开攻略用的数据副本
    └── style.css
```

模块（页签）和字段定义都存在数据库里，内置模块和自建模块走同一套逻辑 ——
所以内置模块也能改名、换图标、加字段、隐藏。内置模块不能删，只能隐藏。
