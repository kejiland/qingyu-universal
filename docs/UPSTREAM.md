# 上游代码同步说明

本项目**不重写** upstream 的业务逻辑，而是复用 [qingyu-blog](https://github.com/kejiland/qingyu-blog)
的代码，并用一层同形绑定把它运行在原生 Node 上。本文档说明边界、改动清单与同步流程。

- 上游基线：`kejiland/qingyu-blog` @ `99ce57a`（原版 **2.10.92**）
- 同步日期：2026-10-07
- 增量同步记录：
  - 2026-10-06 合入基线之后的 3 个提交（`c10eb07` / `daf85a8` / `c9559ef`），
    对应原版 2.10.60 → 2.10.63 的「导航默认项自动补齐」「新增导航项显示开关」「AI 结果不按代码块显示」
  - 2026-10-07 从 `c9559ef` 同步到 `99ce57a`（原版 2.10.63 → 2.10.92，约 22 个提交）。
    本轮**只动了 `app/public/**`**（23 个文件，+1670/−140）：`functions/`、`migrations/`、`worker.js` 零变化，
    因此 `src/bindings/*` 无需任何改动。新增能力主要是：
    「首页显示的标签」白名单（`site_settings.home_tags`）、导航项三态 `discover`
    （内置入口也可移出一级导航 / 自定义项可收进「发现」）、新版分类下拉与首字封面样式。
- 本项目版本：同步后全站统一为 **2.10.93**
- 差异清单：见 [docs/COMPARE.md](COMPARE.md)
- 复用目录：`app/worker.js`、`app/functions/**`、`app/public/**`、`app/migrations/**`

---

## 一、为什么可以复用

上游对平台的依赖收敛在少量绑定上，全部是**标准接口**，可在 Node 中等价实现：

| 上游调用 | 平台语义 | 自托管实现 | 改动 |
| --- | --- | --- | --- |
| `env.DB.prepare(sql).bind(...).all()/first()/run()` | D1（SQLite） | `node:sqlite` | 无需改动 |
| `env.DB.batch([...])` | D1 事务批处理 | `BEGIN`/`COMMIT`/`ROLLBACK` | 无需改动 |
| `env.BLOG.get/put/delete` | KV（含 TTL） | SQLite KV 表 | 无需改动 |
| `env.ASSETS.fetch(request)` | 静态资源 | 文件系统 + `_redirects` | 无需改动 |
| `env.AI.run(model, {messages})` | Workers AI | OpenAI 兼容接口 | 无需改动 |
| `presignPut` / `presignGet` / `r2DeleteObject` | R2 S3 预签名 | S3 SigV4 或本地磁盘 | **3 处接缝** |
| `fetch('https://api.resend.com/emails')` | Resend | SMTP 适配器 | **2 处接缝** |
| `worker.scheduled(event, env)` | Cron Triggers | 进程内调度器 | 无需改动 |
| `request.cf.country` / `CF-*` 头 | 边缘信息 | 反代注入 / 可选 GeoIP | 无需改动 |

关键事实：**D1 就是 SQLite**，且上游 32 个迁移、FTS5 trigram 全文索引、`ON CONFLICT`、
`RETURNING` 等用法全部是标准 SQLite 语法，因此数据库层可以零改动。

---

## 二、改动清单

三条幂等脚本串在 `npm run sync:upstream` 里，顺序固定：

| 脚本 | 职责 |
| --- | --- |
| `scripts/apply-upstream-adapters.mjs` | 平台绑定接缝（本文第二节 1/2 小节） |
| `scripts/apply-frontend-split.mjs` | 前端拆分 + 展示层补丁 + 版本号统一 |
| `scripts/apply-own-patches.mjs` | 自有增强补丁回放（本文第二节 3 小节） |

### 1. `app/functions/_lib/music.js`（5 处）

| 位置 | 改动 | 原因 |
| --- | --- | --- |
| `presignPut` 开头 | 有 `env.LOCAL_STORAGE` 时委托给本地磁盘适配器 | 未配 S3 时提供上传能力 |
| `presignGet` 开头 | 同上（下载方向） | 备份对象读取 |
| `r2DeleteObject` 开头 | 本地模式直接删文件 | 媒体 / 音乐删除 |
| `r2SignParams` | `region` 从 `env.R2_REGION` 读取（默认 `auto`） | R2 固定 `auto`，MinIO / AWS 需真实区域 |
| `signS3` | 签名使用上一步的 region | 同上 |

### 2. `app/functions/_lib/subscribe.js`（3 处）

| 位置 | 改动 | 原因 |
| --- | --- | --- |
| `mailConfigured` | 有 `env.MAIL_SEND` 也算已配置 | 允许 SMTP 替代 Resend |
| `sendEmail` 开头 | 有 `env.MAIL_SEND` 时优先走它 | 接入 SMTP 适配器 |
| 错误文案 | 补充 SMTP 提示 | 提示准确性 |

**业务逻辑（文章、评论、统计、搜索、备份、Webmention、订阅管理、AI 提示词、
后台接口、前端界面）一行未改。**

### 3. 自有增强补丁（`scripts/apply-own-patches.mjs`）

这些改动是「上游没有、只有本自托管版要的」，因此必须能在每次上游覆盖后**幂等重放**。
脚本用 `replaceOnce(text, from, to, label)` 做替换：**命中次数 ≠ 1 就抛错**，
避免上游改动锚点后静默丢补丁。

| 补丁 | 落点 | 识别标记（已存在则跳过） |
| --- | --- | --- |
| 首页「站点概览」卡片 | `app.js` 新增 `renderHomeStats()` 并在 `renderHome()` 里调用 | `app.includes('function renderHomeStats(')` |
| 主题色 WCAG AA 校准 | `style.css` 共 10 处 `--accent*` 变量 | `css.includes('--accent: #a95233;')` |
| 五语「站点概览」文案 | `i18n.js` 的 `home.stats.*` + `locales/{zh-CN,en,ja,ko,hi}.json` | 锚点行为 `"home.latest"` |
| 页脚「建站年份 / ICP 备案号」接入 `site_info` 覆盖链 | `app.js` 的 `renderFooter()` + `src/ssr/chrome.ts` | `app.includes("if (siteInfo.startYear)")` |
| AI 请求的前端超时放宽 | `app.js` 的 `apiFetch()` 与 AI 摘要调用点、`admin.js` 三处 AI 调用点 | `app.includes("Number(opts && opts.timeoutMs)")` |

依赖顺序：`renderHomeStats()` 用到 `fmtDate()`，后者由 `apply-frontend-split.mjs` 补入，
所以 `apply-own-patches.mjs` **必须排在它之后**，脚本里有显式断言。

> **易错点**：`style.css` 只在校准时改，但页面实际加载的是 `style.min.css`。
> 因此 `scripts/build-frontend.mjs` 里专门加了 `style.css → style.min.css` 的压缩任务；
> 少了这一步，主题色校准会在线上完全失效（曾经踩过）。

### 4. Vue 后台外壳对齐上游（`admin/`）

`admin/` 是自托管版自己的代码，不参与上游同步，但**外观必须与上游 `/admin/` 看不出差别**。

对齐口径：**只改外壳，页面内部（卡片 / 表格 / 表单）沿用现状**。

| 部位 | 上游（`app/public/admin.css`） | 本版落点 |
| --- | --- | --- |
| 侧栏 | `.ab-sider` 252px → 折叠 72px，深色渐变 | `AdminLayout.vue` + `style.css` 的 `.admin-sider` |
| 侧栏配色 | `--ab-sider-bg: linear-gradient(180deg,#23201a,#191612)` | 同名色值搬成 `--sider-bg`（深色主题 `#1e1b17 → #15120f`） |
| 品牌区 | `siteLogoURL()` + 站名 | `.admin-sider-brand`（读 `/api/settings` 的 `footer.copyrightName` / `site.name`） |
| 顶栏 | 62px：汉堡 + 面包屑 + 预览站点 + 语言 + 账户 | `.admin-header` + `.admin-crumb` |
| 页头 | `--ab-serif` 衬线大标题 24px | `.page-title`，走 `--serif` 令牌 |
| 内容区 | `max-width:1280px; padding:28px 30px 36px` | `.admin-content` 同参数 |
| 页脚 | `博客管理后台 © 2026`，居中 12.5px | `.admin-foot` |
| 导航分组 | 概览 / 文章管理 / 评论管理 / 内容与设置 | `AdminLayout.vue` 的 `navGroups`，条目与上游同名 |
| 移动端 | `<=991px` 侧栏化抽屉 + mask | `.admin-sider-mask` + `is-collapsed` 系列 |

页头副标题由外壳统一渲染（路由 `meta.subtitle`），因此各 `*View.vue` **不得再自带头部标题**，
否则会出现「同一个标题渲染两遍」。

### 5. 新版后台按需挂载（`src/app.ts`）

`admin/dist` 是先构建、后启动的产物。早期版本在**进程启动时一次性**判定产物是否存在，
于是 `npm run admin:build` 之后必须重启才能生效，否则 `/admin` 会静默回落到上游旧版后台 ——
表现为「改了后台却看到旧界面」，很容易被误判成 UI 不一致。

现改为**按需判定**：`/admin` 与 `/admin/*` 前面挂一道 `adminGate` 中间件，
可用性结果缓存 1s；判定不可用就原样转发给上游 `worker.fetch()`，与末尾兜底同一条路径。

---

## 三、绑定实现要点

### D1（`src/bindings/d1.ts`）
- `node:sqlite` 的 `DatabaseSync`，WAL + `synchronous=NORMAL` + `busy_timeout=5000`
- 预编译语句缓存（超过 400 条时清空）
- `undefined → null`、`boolean → 0/1`（D1 参数类型限制）
- `batch()` 用事务包裹；`run()` 返回 D1 形状的 `meta.changes` / `last_row_id`

### KV（`src/bindings/kv.ts`）
- 表结构 `_kv_store(k, v, expires_at)`
- `get(key, 'json' | 'text' | 'arrayBuffer' | 'stream')`、`put(..., { expirationTtl })`
- 读取时惰性清理过期键（每分钟最多一次全表清理）

### 存储（`src/bindings/storage.ts`）
- 本地磁盘模式：`DATA_DIR/uploads/{media,music,backups,og}`
- 上传地址用 HMAC-SHA256 签名并带有效期，`/api/local-upload` 校验后落盘
- 公开读取 `/media/*`、`/music/*`、`/og/*`，支持 HTTP Range（音频拖动播放）
- 目录穿越防护：key 必须在允许前缀内，且解析后仍位于 uploads 目录内

### 邮件（`src/bindings/mail.ts`）
- 使用 nodemailer：连接池、STARTTLS 协商、AUTH 机制回退、MIME 组装交给成熟库
- 启动时做一次 `transport.verify()` 自检，配置错误只告警、不阻塞启动
- 通过 `env.MAIL_SEND` 注入；上游 `sendEmail()` 优先走它，未配置时回退 Resend

### AI（`src/bindings/ai.ts`）
- 把 `env.AI.run(model, { messages })` 适配为 OpenAI `/chat/completions`
- 把 `choices[0].message.content` 包装回上游期望的 `{ response }` 形状
- **`AI_MODEL` 必须显式配置**：适配器在未配置时兜底成 `gpt-4o-mini`，而构造函数里
  `this.model` 永不为空，所以上游传来的 `@cf/...` 模型名**永远到不了请求体**；
  第三方网关多半没有 `gpt-4o-mini`，漏配的现象是「ping 通了、UI 出来了、一点摘要就 502」
- 支持 `AI_TIMEOUT_MS`（默认 60s）与 `AI_MAX_RETRIES`（默认 1，即最多请求 2 次）：
  第三方网关会间歇性 `fetch failed` / 慢到几十秒，只重试网络错误、超时、429 与 5xx，
  其余 4xx 重试也没有意义

---

## 四、从上游同步的流程

```bash
# 1. 拉取上游最新代码
git clone --depth 1 https://github.com/kejiland/qingyu-blog /tmp/upstream

# 2. 用上游最新内容覆盖 app/ 下的目录（src/ deploy/ 等自有代码不动）
#    建议先 git commit，便于用 git checkout 核对差异
cp -a /tmp/upstream/functions   app/functions
cp -a /tmp/upstream/public      app/public
cp -a /tmp/upstream/migrations  app/migrations
cp    /tmp/upstream/worker.js   app/worker.js

# 3. 重新应用适配补丁（幂等，重复执行安全）
npm run sync:upstream

# 4. 安装依赖并构建
npm ci
npm run build

# 5. 回归验证
npm run migrate
npm start &
npm test
BASE_URL=http://localhost:8787 SETUP_KEY=... npm run smoke
```

公开站前端拆分（自有改动）：`app/public` 新增 `boot.js`（首屏启动器）与 `admin-legacy.js`（旧后台分包），
并相应修改了 `index.html`、`sw.js`、`_headers`。`npm run sync:upstream` 已串联 `apply-frontend-split.mjs`，
上游覆盖回单文件形态时会幂等重新拆分，并在必要时递增补丁版本。

**版本号统一（易踩坑）**：上游偶发只递增 `index.html` / `sw.js` 却漏改 `app.js`
（例如 2.10.92 时 `app.js` 里仍是 `BLOG_VERSION='2.10.83'`），`llms.txt` 也常忘记更新。
`apply-frontend-split.mjs` 的 `bumpCacheVersion()` 因此改成：取 `app.js` / `index.html` /
`sw.js` / `llms.txt` **四者中的最高版本**作为基准再递增，并把四个位置一起改成新版本，
保证全站版本号一致。若上游后续修正了这个漂移，这段逻辑仍然安全（幂等且只会更保守）。

视觉打磨（自有改动）：外观改进**不写进上游 `style.css`**，全部放在独立的 `app/public/polish.css`，
由构建产出 `polish.min.css` 并在主样式后加载。同步脚本同样幂等补回 `index.html` 的样式引用、
`sw.js` 缓存清单与 `_headers` 规则；同时以 `function fmtDate` 是否存在为标记，重新应用
卡片日期规范化（YYYY-MM-DD）与摘要回退到 `search` 字段这两处展示层补丁。

> 若上游删除了旧文件，`cp -a` 不会清理残留，请用 `git status` 核对后再提交。

> **注意**：上游若新增平台绑定（例如 `env.QUEUE`、`env.BROWSER`），需要在 `src/`
> 下补一个同形实现，并更新本文档的对照表。

---

## 五、迁移说明

上游的 32 个迁移是**跨版本增量**的，其中 `0003_cover_column.sql` 在全新数据库上
会因 `0001_init.sql` 已含 `cover` 列而报 `duplicate column name`——上游 `deploy.yml`
对此做了「列已存在即忽略」处理。本项目 `src/migrate.ts` 采用同样策略，
并把每个迁移记录到 `_migrations` 表，保证重复执行安全且不会漏跑新迁移。

---

## 六、后台配置键对照（每次同步后必查）

前台 `app.js` 通过 `/api/settings` 读到的键，必须都能在后台某一处被写入，
否则会出现「上游有这功能、自托管版却配不出来」的隐性缺口。

| `site_settings` 键 | 前台消费点 | 后台入口（Vue） | 后台入口（旧版 `admin.js`） |
| --- | --- | --- | --- |
| `nav_menu` / `nav` | `renderNav()` | 高级设置 → 顶部导航 | 站点 → 导航 |
| `nav_defaults_version` | 默认项自动补齐 | 保存时自动写入 | 同 |
| `footer_nav` | `renderFooter()` | 高级设置 → 页脚导航 | 站点 → 页脚 |
| `friend_links` | 页脚 + 朋友圈页 | 高级设置 → 友情链接 | 站点 → 友链 |
| `home_tags` | `renderHomeTagRow()` 白名单 | 高级设置 → **首页显示的标签** | 功能开关 → 首页标签 |
| `features.navExtras` | 是否显示新增导航项 | 高级设置 → 功能开关 | 功能开关 |
| `features.ads` | 广告位 | 高级设置 → 广告位 | 功能开关 |

> 同步完上游后，请对照本表检查新增键。本轮补齐的两个就是 `home_tags`
> 与导航项的 `discover` 三态（后者以 `nav_menu[i].discover` 形式存在，
> 三态语义：`true` 收进「发现」、`false` 留在一级导航、**键不存在**＝跟随内置默认）。

### 页脚字段：只有 4 个 `site_info` 字段会覆盖静态 `config.js`

页脚默认取自静态 `config.js` 的 `footer`，后台的 `site_info` 只能**逐字段覆盖**它。
覆盖链在两处，**必须同构**（否则 SSR 首屏与 SPA 会不一致）：

| `site_info` 字段 | 覆盖 `footer` 的 | 来源 |
| --- | --- | --- |
| `copyright` | `copyrightName` | 上游已有 |
| `footerText` | `decl` | 上游已有 |
| `startYear` | `startYear` | **自托管版增强**（自有补丁） |
| `icp` | `icp` | **自托管版增强**（自有补丁） |

> 上游只覆盖前两项，`startYear`（版权起始年）与 `icp`（备案号）只能改静态文件——
> 后台虽然给了输入框、值也存进去了，前台却永远读不到，是典型的「假设置项」。
> 修复点在两处：`app/public/app.js` 由 `apply-own-patches.mjs` 的第 5 类补丁追加，
> `src/ssr/chrome.ts` 的页脚合成处同步加两行。`tests/footer-identity.test.ts`
> 钉住：两边字段集合必须完全一致、且这 4 个字段都在链上。

### 后台保存的键必须正好是上游这 10 个

上游 `saveSettings()` 只写：`site_info`、`profile`、`nav_menu`、`nav_defaults_version`、
`home_tags`、`footer_nav`、`friend_links`、`moderate_comments`、`comment_blocklist`、`features`。
多写会变成孤儿键（`site` 是旧键名、`footer` 不是合法键、`nav` 已被迁移
`0012_clear_orphaned_nav.sql` 清除且现在无任何消费点——`app.js:1045` 只读 `nav_menu`）。
`tests/footer-identity.test.ts` 会守住这一点。

**本轮核对补充**（容易踩的坑，写在表里免得下次再查一遍）：

| 事实 | 说明 |
| --- | --- |
| `footer` **不是** `site_settings` 键 | 取自静态 `config.js`（`window.BLOG_CONFIG`）。后台只把 `site_info.copyright` → `copyrightName`、`site_info.footerText` → `decl` 叠加进去，不要去 `site_settings` 里找 `footer` |
| `nav` 键已被主动 DELETE | 迁移 `0012_clear_orphaned_nav.sql` 会清掉它，导航只用 `nav_menu` |
| `posts.min.js` 是**首帧数据源** | `window.BLOG_POSTS` 已改为由 DB 动态生成（`/posts.js` + `/posts.min.js`，带 ETag + 304），不再是从上游拷来的静态文件 |

---

## 七、契约支持面（每次同步后必查）

`src/api/routes/*.ts` 里的路由登记会同时喂给三处：zod 请求体校验、响应 schema 校验
（strict 模式下漂移直接 500）、`/api` 的 OpenAPI 文档、以及 `generated/api.d.ts`（Vue 后台用）。
所以**登记了但上游没实现的方法，会一路污染到文档和后台类型**。

> **铁律**：契约里不能为了让文档好看而登记上游没有的能力。
> 「文档说有、实际 405」比「文档没写」更糟——后台照着类型调用会拿到 405，
> 而排查时没人会怀疑「文档写错了」。

核对方式：以**上游 `app/functions/**` 的源码**为准，看该 handler 实际处理了哪些 method，
而不是看契约里写了什么。

本轮按真实支持面修正的四处（`tests/contract-methods.test.ts` 会持续守住）：

| 路径 | 修前（契约撒谎） | 修后（上游真实支持） | 依据 |
| --- | --- | --- | --- |
| `/api/ai/ping` | `POST` | 删（只接受 `GET`） | `ai/ping.js` 明确只处理 GET |
| `/api/admin/subscribers` | `POST` | 删（只实现 `GET`） | `handleSubscribersAdmin()` 只实现 GET |
| `/api/admin/tags` | `GET` | **`POST`**（批量重命名 / 删除标签） | `api-core.js:1846` |
| `/api/site-files/:name` | 未登记 | **补 `POST`** | `handleSiteFiles()` 只实现 GET + POST |
| `/api/site-files` / `/api/site-files/:name` | 登记了 `PUT` / `DELETE` | 删（从未实现，必然 405） | 同上 |

### 请求体 schema 必须容忍 `GET` 会返回的 `null`

这是「双向不对称」最容易藏身的地方：`GET /api/posts/:id` 对未定时的文章返回
`publishAt: null`，而上游 `admin.js` 保存时写的正是 `publishAt: post.publishAt || null`。
若 schema 只写 `.optional()`（允许 undefined、**拒绝 null**），
就会出现「GET 出来的对象存不回去」——上游 Cloudflare 版没有校验中间件，null 一路畅通，
于是表现成本版独有的 400。

修复写法（`src/api/contract/posts.ts`）：

```ts
publishAt:  z.union([z.number(), z.string()]).nullable().optional(),
publish_at: z.union([z.number(), z.string()]).nullable().optional(),
```

`tests/contract-nullable.test.ts` 会守住三条：单独传 `null` 必须被接受、
有值时保持校验强度（布尔仍被拒）、**「GET 出来的原样对象」整体回写必须能过**。

### 已知的同源缺口（不擅自补）

| 缺口 | 说明 |
| --- | --- |
| `site-files` 无删除 | 上游只实现 GET 列表/读取 + POST 写入，属「有上传无删除」。硬加会破坏与 Cloudflare 版的一致性 |
| 导入导出丢 `author` / `seo` | `transferPostMarkdown()` 的 `stringKeys` 不含 `author`，`transferNormalizePost()` 也不返回 `seo`。`tests/transfer-roundtrip.test.ts` 显式钉住这两个缺口——哪天它们「回来了」说明我们与上游分叉了 |

### 媒体上传：缩略图必须真的 PUT（Vue 后台对齐上游 `uploadImageAsset`）

Vue 后台的媒体页曾有两个上游没有、纯属本版实现差异的 bug，都属于
「流程走了一半」——登记了元数据，字节却没传上去。

上游 `app/public/admin.js` 的 `uploadImageAsset()` 是**两步都 PUT**：

```js
var u = await api('api/media/upload-url', { ... makeThumb: !!packed.thumb });
await put(u.uploadUrl, mainFile, u.contentType);
if (packed.thumb && u.thumbUploadUrl) await put(u.thumbUploadUrl, packed.thumb, 'image/webp');
var registered = await api('api/media', { ... thumbUrl: u.thumbPublicUrl || '' });
```

对照实现（`admin/src/views/MediaView.vue` + `admin/src/lib/image.ts`）必须满足：

1. **压缩参数逐条对齐**——主图 `2200 / 0.82`，缩略图 `640 / 0.76`，`gif|svg|ico` 不压缩也不生成缩略图，
   压缩后反而更大则保留原图，缩略图命名为 `<base>-thumb.webp`
2. **缩略图真的传字节**，且**只有 PUT 成功才登记 `thumbUrl`**（否则列表回退原图）
3. **复制必须两段式降级**：自托管常是 `http://IP` / `http://域名`，**不是安全上下文，
   `navigator.clipboard` 整个不存在**，只用 Clipboard API 会一直提示「复制失败」。
   顺序是 Clipboard API → `textarea + execCommand('copy')`，与上游 `copyText()` 同款

`tests/media-upload.test.ts` 会直接从**上游 `admin.js` 源码**里抓 `compressImageFile` 的函数体做逐条比对，
避免哪天上游改了参数而我们还在用旧值。
