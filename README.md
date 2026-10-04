# 轻语博客 · 自托管通用版（qingyu-universal）

把 [qingyu-blog](https://github.com/kejiland/qingyu-blog) 从「深度绑定 Cloudflare」变成
**可以部署在任何 VPS / NAS / 云主机** 的通用版本：一条命令拉起，数据在自己手里。

- **零第三方运行时依赖** —— 只用 Node 内置能力（`node:sqlite` + WebCrypto），无 `npm install`
- **默认单机开箱即用** —— SQLite + 本地磁盘 + Caddy 自动 HTTPS
- **可选接入云服务** —— S3 兼容对象存储、PostgreSQL（规划中）、OpenAI 兼容 AI、SMTP/Resend
- **业务行为与线上版一致** —— 直接复用上游业务代码，API 字段、后台、主题、搜索全部保留

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

## 本地开发（不用 Docker）

要求 **Node.js ≥ 22.5**（推荐 24 LTS；`node:sqlite` 在 24 起稳定）。

```bash
cp .env.example .env      # 至少设置 SITE_URL 与 BLOG_ADMIN_SETUP_KEY
npm run migrate           # 应用 32 个数据库迁移
npm start                 # http://localhost:8787
```

验证：

```bash
BASE_URL=http://localhost:8787 SETUP_KEY=<你的安装密钥> node scripts/smoke.mjs
```

冒烟测试覆盖：健康检查 / 管理员初始化 / 登录 / 权限拦截 / 文章 CRUD / 全文搜索 /
评论 / RSS / Sitemap / 媒体直传 / 站点备份 / 删除，共 18 项。

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

留空则关闭订阅邮件；后台订阅管理、确认链接等依赖邮件的功能会自动降级提示。

---

## 架构：适配器复用，而不是重写

上游 `qingyu-blog` 是纯 Cloudflare 形态，但它的**业务代码本身就是可移植的**：
所有平台能力都通过少量绑定（`env.DB` / `env.BLOG` / `env.ASSETS` / `env.AI` / `env.R2_*`）访问，
而 D1 本身**就是 SQLite**。因此本项目不改写业务逻辑，而是提供一层同形绑定：

```
app/worker.js  +  app/functions/**     上游业务代码（文章/评论/统计/AI/搜索/备份…）
        │  通过 Cloudflare 风格的绑定访问平台能力
        ▼
server/bindings/*                       自托管绑定实现
  ├── d1.js       env.DB      → node:sqlite（含 FTS5 trigram 全文索引）
  ├── kv.js       env.BLOG    → SQLite KV 表（含 TTL）
  ├── assets.js   env.ASSETS  → public/ 目录（含 _redirects 语义）
  ├── storage.js  R2/S3       → 本地磁盘 + 签名上传端点
  ├── ai.js       env.AI      → OpenAI 兼容接口
  └── mail.js     Resend      → SMTP
        │
        ▼
server/index.js                         原生 Node HTTP → Web Fetch 桥接 + 定时调度
```

好处：**行为与线上版一致**，上游修 bug 时只需重新同步 `app/` 并跑一次
`node scripts/apply-upstream-adapters.mjs`（幂等补丁，共 8 处接缝改动，业务逻辑零修改）。

详见 [docs/UPSTREAM.md](docs/UPSTREAM.md)。

### 目录结构

```
app/                    上游业务代码（worker.js / functions/ / public/ / migrations/）
server/
  index.js              服务入口：路由 / 本地上传 / 静态对象 / 调度
  config.js             .env → Workers 风格 env 绑定
  migrate.js            迁移执行器（幂等、事务化）
  scheduler.js          替代 Cloudflare Cron（定时发布 / 邮件投递 / 自动备份）
  http.js               Node ↔ Web Fetch 桥接、Range 静态文件
  bindings/             各平台能力的自托管实现
scripts/                冒烟测试 / 种子导入 / 备份 / 恢复 / 上游适配补丁
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

- [x] **v0.1** Docker + SQLite + 本地磁盘 + Caddy + 一键部署脚本；AI(SMTP/S3) 适配
- [ ] **v0.2** PostgreSQL 适配、Redis/Valkey 限流、站点 JSON 备份跨版本导入
- [ ] **v0.3** PaaS 模板（Railway / Render / Fly.io / Cloud Run）、多架构镜像发布
- [ ] **v0.4** Helm Chart、SQLite → PostgreSQL 迁移工具、镜像签名与 SBOM

## 许可证

MIT，与上游保持一致。业务代码版权归原项目作者，见 [LICENSE](LICENSE)。