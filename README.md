# 轻语博客 · 自托管通用版（qingyu-universal）

把 [qingyu-blog](https://github.com/kejiland/qingyu-blog) 从「深度绑定 Cloudflare」变成
**可以部署在任何 VPS / NAS / 云主机** 的通用版本：一条命令拉起，数据在自己手里。

- **现代 Node 技术栈** —— TypeScript + Hono + zod + pino + vitest，有类型、有测试、有构建
- **默认单机开箱即用** —— SQLite + 本地磁盘 + Caddy 自动 HTTPS，无需注册任何云服务
- **可选接入云服务** —— S3 兼容对象存储（R2 / MinIO / BWS / OSS）、SMTP 或 Resend、任意 OpenAI 兼容 AI
- **业务行为与线上版一致** —— 复用上游业务代码，API 字段、后台、主题、全文搜索全部保留

---

## 技术栈

| 层 | 选型 | 为什么 |
| --- | --- | --- |
| 运行时 | Node.js 24 LTS | `node:sqlite` 在 24 起稳定，无需原生编译 |
| 语言 | TypeScript（`tsc` 构建） | 服务层有编译期约束；上游 `app/` 保持 JS 以便同步 |
| HTTP | [Hono](https://hono.dev) + `@hono/node-server` | 与上游的 Workers 形态天然契合，路由/中间件/流式响应齐备 |
| 数据库 | `node:sqlite`（WAL + FTS5） | 一方 API，零原生编译；D1 本就是 SQLite，语义完全对齐 |
| 配置校验 | zod | 配置错误在**启动时**报出，而不是运行到某个分支才炸 |
| 日志 | pino（+ pino-pretty） | 结构化 JSON，可直接被 Loki / journald 采集 |
| 定时任务 | node-cron | 替代 Cloudflare Cron Triggers，时区可配 |
| 邮件 | nodemailer | 相比手写 SMTP，连接池 / STARTTLS / AUTH 回退都更可靠 |
| 测试 | vitest | 单元测试 + 端到端冒烟测试 |
| 反代 | Caddy | 自动 HTTPS，零配置 |

> 上游 `app/` 目录（业务逻辑，约 240 KB JS）**保持原样**，只通过一层适配器接入上述栈。
> 这样上游修 bug 时，重新同步 + 跑一次适配补丁即可，见 [docs/UPSTREAM.md](docs/UPSTREAM.md)。

---

## 一分钟部署（Linux VPS）

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/qingyu-universal/main/deploy/install.sh \
  | bash -s -- --domain blog.example.com
```

脚本会自动：安装 Docker → 生成 `.env` 与随机密钥 → 构建镜像 → 启动应用与 Caddy →
等待健康检查 → 输出后台地址与初始化密钥。

从已克隆的仓库运行（推荐，可用本地最新代码）：

```bash
git clone https://github.com/<owner>/qingyu-universal
cd qingyu-universal
./deploy/install.sh --domain blog.example.com
```

Windows（Docker Desktop）：

```powershell
.\deploy\install.ps1 -Domain blog.example.com
```

部署完成后打开 `https://blog.example.com/admin`，填入脚本输出的 **初始化密钥** 设置管理员密码。

### 常用运维命令

```bash
./deploy/install.sh upgrade          # 升级（升级前自动备份，数据保留）
./deploy/install.sh backup           # 数据库快照 → data/backups
./deploy/install.sh restore <快照>    # 从快照恢复
./deploy/install.sh logs             # 查看日志
./deploy/install.sh status           # 容器与健康状态
./deploy/install.sh uninstall        # 停止并删除容器（数据卷保留）
```

---

## 本地开发

要求 **Node.js ≥ 24**（`node:sqlite` 在 24 起稳定，无需实验性开关）。

```bash
npm ci                    # 安装依赖
cp .env.example .env      # 至少设置 SITE_URL 与 BLOG_ADMIN_SETUP_KEY
npm run build             # TypeScript 编译到 dist/
npm run migrate           # 应用 32 个数据库迁移
npm start                 # http://localhost:8787
```

开发时用 `npm run dev`（tsx 监听 `src/`，改动即时重启，无需重新构建）。

### 测试

```bash
npm test                  # 单元测试 + 契约测试（72 项）
npm run typecheck:tests   # 测试代码（含生成的客户端类型）编译期检查
npm run api:generate      # 重新生成 OpenAPI 与客户端类型
npm run typecheck         # 仅类型检查

# 端到端冒烟测试（需先启动实例）
BASE_URL=http://localhost:8787 SETUP_KEY=<安装密钥> npm run smoke
```

单元测试覆盖：D1 兼容层的语句绑定/事务回滚/参数归一化、KV 的 TTL 与类型转换、
本地存储的签名校验与目录穿越防护、32 个迁移的完整应用与幂等重放、配置校验与 S3 回落逻辑、
服务端 SEO 的注入/回退/XSS 防护/草稿不泄露。

端到端测试覆盖：健康检查 / 管理员初始化 / 登录 / 权限拦截 / 文章 CRUD / **服务端 SEO** /
全文搜索 / 评论 / RSS / Sitemap / 媒体直传 / 站点备份 / 删除，共 25 项。

---

## 配置说明

全部配置都在 `.env`。完整清单见 [.env.example](.env.example)，关键项：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `SITE_URL` | 对外访问地址（影响 RSS / Sitemap / 邮件链接 / CORS 白名单） | `http://localhost:8787` |
| `SITE_DOMAIN` | Caddy 使用的域名（留空 = localhost 自签证书） | 空 |
| `BLOG_ADMIN_SETUP_KEY` | 首次初始化管理员的安装密钥 | 空（**建议必填**） |
| `DATA_DIR` | 数据目录（SQLite / 上传 / 备份） | `./data` |
| `TRUST_PROXY` | 是否信任反代注入的客户端 IP 头 | `1` |
| `LOG_LEVEL` / `LOG_PRETTY` | 日志级别 / 是否彩色输出 | `info` / `0` |
| `CRON_TIMEZONE` / `BACKUP_CRON` | 定时任务时区与自动备份时间 | `UTC` / `0 19 * * *` |

### 存储：本地磁盘 或 任意 S3

**默认本地磁盘**，媒体与音乐落在 `DATA_DIR/uploads`，由应用签发一次性上传地址，
无需注册任何云服务即可使用。

要改用对象存储，填入任意 S3 兼容服务即可（Cloudflare R2 / MinIO / AWS S3 /
Backblaze B2 / 阿里云 OSS …）：

```env
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_REGION=auto                # R2=auto；MinIO 通常 us-east-1；AWS 填真实区域
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_MEDIA_BUCKET=qingyu-media
S3_MEDIA_PUBLIC_BASE=https://media.example.com
S3_MUSIC_BUCKET=qingyu-music
S3_MUSIC_PUBLIC_BASE=https://music.example.com
S3_BACKUP_BUCKET=qingyu-backup
```

浏览器会直传对象存储（不占服务器带宽），行为与线上 Cloudflare 版一致。
若从线上版迁移，也可直接沿用 `R2_*` 变量名，配置层两者都认。

### AI：任意 OpenAI 兼容接口

```env
AI_BASE_URL=https://api.deepseek.com/v1     # 或 OpenAI / Groq / SiliconFlow / Ollama…
AI_API_KEY=sk-...
AI_MODEL=deepseek-chat
BLOG_AI_ENABLED=        # 空 = 开启；0/false/off = 关闭
BLOG_AI_PUBLIC=         # 0/false/off = 仅管理员可触发生成
```

留空则 AI 功能自动隐藏，其余功能不受影响。支持 Ollama / LocalAI / vLLM 等本地推理。

### 邮件：SMTP 或 Resend

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_SECURE=0           # 465 端口用 1
BLOG_MAIL_FROM=博客 <noreply@example.com>
```

启动时会做一次 SMTP 连接与认证自检，配置错误只告警不阻塞启动。
留空则关闭订阅邮件；后台订阅管理、确认链接等依赖邮件的功能会优雅降级。

---

## SEO 与社交分享

上游把 SEO 逻辑放在浏览器里（`app/public/app.js` 的 `updateSEO()`）——它会在页面加载后用
JS 改写 `<meta>`、canonical 与 JSON-LD。这对**不执行 JS 的社交爬虫完全无效**：微信、
Twitter、Discord 抓到的永远是 `index.html` 里写死的那套标题。

自托管版把这套规则搬到了服务端，在返回 HTML **之前**就注入正确的标签：

| 页面 | 注入内容 |
| --- | --- |
| `/posts/<id>/` | `og:type=article`、文章标题/摘要/封面、绝对 `og:url` 与 canonical、`article:tag`、`article:published_time`、`BlogPosting` JSON-LD |
| `/` | 站点名与简介、绝对 canonical、`WebSite` JSON-LD |
| 草稿 / 定时 / 不存在的文章 | 只注入站点级信息并标记 `robots: noindex, nofollow`——**文章标题不会泄露给爬虫** |

字段优先级与 `updateSEO()` 完全一致，避免爬虫看到的和用户看到的对不上：

```
标题   : seo.title  →  「文章标题 · 站点名」
描述   : seo.desc   →  excerpt  →  正文去 Markdown 后前 200 字  →  站点简介
分享图 : og_image   →  cover    →  （留空则用 summary 卡片）
canonical: seo.canonical  →  https://<SITE_URL>/posts/<id>/
```

`seo` 字段（`title` / `desc` / `canonical` / `noindex`）在后台文章编辑器里就能填，
数据库早就存着了，之前只是没人渲染它。

**注意**：站点名与简介来自后台的「站点基础信息」；没配置时会回退到内置默认值。
自托管站点建议先把它改成自己的名字。

安全细节：文章标题会经过 HTML 属性转义，JSON-LD 会转义 `<` `>` `&` 与 U+2028/2029，
因此标题里的 `</script>` 或 `"` 无法逃逸出标签。响应头复用上游的 `securityHeaders()`，
与静态资源路径保持一致。

详见 [docs/SEO.md](docs/SEO.md)。

---

## API 契约

上游的接口是 62 个手写路由分支加 16 处 `await request.json()`，**零 schema 校验**：
类型错误会被 `String()` 静默强转成脏数据存进库，也没有机器可读的接口描述。

自托管版在 `src/api/` 加了一层契约，三者同源：

```
src/api/contract/*.ts   zod schema（唯一事实来源）
      ├──→ 运行时校验        拒绝坏请求，错误信息带字段路径
      ├──→ OpenAPI 3.1      /openapi.json 与 generated/openapi.json
      └──→ 客户端类型        generated/api.d.ts
```

两个关键设计：

**校验是只读的。** 请求 clone 后解析、仅用于判断是否 400，转发给上游的仍是原始请求。
原因：zod 的 `z.object()` 默认**剥掉未声明字段**，如果拿解析结果去转发，上游需要的字段会被静默删掉。
原样转发从根本上排除了这类行为变化。

**响应也要校验。** 每条路由声明响应 schema，处理完回头校验真实响应体
（`API_VALIDATE_RESPONSES=off|warn|strict`）。这个机制立刻抓到一个真实缺陷：
`POST /api/posts/:id/comments` 的响应**不含 `post_id`**，而列表接口用 `SELECT *` 是含的——
两个接口的评论形状不同，靠读代码很难发现。

当前已覆盖文章 / 评论 / 检索 / 设置 / 健康检查共 9 个操作，其余约 50 个仍走上游兜底，
行为完全不受影响。迁移一个域 = 把它的路由从兜底提到契约层，可逐个进行、随时停手。

```bash
npm run api:generate      # 重新生成 OpenAPI 与客户端类型
curl localhost:8787/openapi.json
```

详见 [docs/API.md](docs/API.md)。

---

## 架构

核心原则：**业务逻辑复用上游，平台能力由适配器提供。**

```
app/worker.js  +  app/functions/**     上游业务代码（文章/评论/统计/AI/搜索/备份…）
        │  通过 Cloudflare 风格的绑定访问平台能力
        ▼
src/bindings/*                          自托管绑定实现（TypeScript）
  ├── d1.ts        env.DB      → node:sqlite（WAL + FTS5 trigram）
  ├── kv.ts        env.BLOG    → SQLite KV 表（含 TTL）
  ├── assets.ts    env.ASSETS  → public/ 目录（含 _redirects 语义）
  ├── storage.ts   R2/S3       → 本地磁盘 + 签名上传端点
  ├── ai.ts        env.AI      → OpenAI 兼容接口
  └── mail.ts      Resend      → SMTP（nodemailer）
        │
        ▼
src/app.ts                               Hono：专有路由 + 兜底转交 worker.fetch
src/index.ts                             启动：配置 → 绑定 → 迁移 → HTTP → 调度
```

为什么要保留这层绑定，而不是把业务代码改写成 Hono 路由：

- 上游 `api-core.js` 有 12 万行业务逻辑，重写等于把「文章/评论/统计/搜索/备份/审计/
  Webmention/订阅」全部重新实现并逐一对齐行为——成本极高且必然引入回归；
- D1 就是 SQLite，绑定契约本身是标准接口，实现它是**低成本、高保真**的路径；
- 上游继续演进时，本项目只需重新同步 `app/` + 跑一次幂等补丁。

详见 [docs/UPSTREAM.md](docs/UPSTREAM.md)。

### 目录结构

```
app/                    上游业务代码（worker.js / functions/ / public/ / migrations/）
src/
  index.ts              启动入口：装配绑定、迁移、HTTP、定时任务、优雅退出
  app.ts                Hono 应用：专有路由 + 转交上游 worker.fetch
  config.ts             dotenv + zod 配置校验与归一化
  logger.ts             pino（并接管上游 console.*）
  migrate.ts            迁移执行器（事务化、幂等）
  scheduler.ts          node-cron 调度（定时发布 / 邮件投递 / 自动备份）
  types.ts              D1 / KV / ASSETS / AI 契约类型
  bindings/             各平台能力的自托管实现
  routes/               健康检查 / 本地上传 / 配置注入 / 公开对象
  cli/                  migrate / seed / health / backup / restore / smoke
tests/                  vitest 单元测试
scripts/                上游适配补丁（唯一保留的 .mjs 工具脚本）
deploy/                 Dockerfile / Caddyfile / install.sh / install.ps1
compose.yaml            app + Caddy 编排
data/                   运行时数据（不入库）：qingyu.db、uploads/、backups/
```

---

## 与上游云版本的关系

这是一个**独立项目**：独立仓库、独立版本号、独立部署方式，不与 Cloudflare 版共用
CI 或部署流程。两个兼容边界：

1. **REST API 字段保持兼容** —— 前端可以互换；
2. **支持导入上游导出的 JSON 备份** —— 作为一次性迁移手段。

Cloudflare 版仍然是线上首选（边缘缓存、免费额度、零运维）；通用版面向
「必须自托管 / 数据必须落地 / 不能用 Cloudflare」的场景。

---

## 路线图

- [x] **v0.1** Docker + SQLite + 本地磁盘 + Caddy + 一键部署脚本；AI / SMTP / S3 适配
- [x] **v0.2** TypeScript + Hono + zod + pino + node-cron + nodemailer；单元测试与 CI
- [x] **v0.2.1** 文章页 / 首页服务端 SEO 渲染（OG 卡片、JSON-LD、canonical）
- [x] **v0.2.2** API 契约层：zod schema → OpenAPI → 客户端类型，响应漂移检测
- [ ] **v0.3** 前端拆分（公开站 SSR + 后台 SPA）、站点 JSON 备份导入、数据库外键约束
- [ ] **v0.3** 契约覆盖剩余约 50 个接口（管理认证 / 媒体 / 订阅 / 备份）
- [ ] **v0.3.1** PostgreSQL 适配、Redis/Valkey 限流
- [ ] **v0.4** PaaS 模板（Railway / Render / Fly.io / Cloud Run）、多架构镜像发布
- [ ] **v0.5** Helm Chart、SQLite → PostgreSQL 迁移工具、镜像签名与 SBOM

## 许可证

MIT，与上游保持一致。业务代码版权归原项目作者，见 [LICENSE](LICENSE)。