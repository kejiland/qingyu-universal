# 轻语博客 · 自托管通用版（qingyu-universal）

把 [qingyu-blog](https://github.com/kejiland/qingyu-blog) 从 Cloudflare Workers 迁到任意 VPS / NAS / 云主机：
Node + TypeScript + Docker，数据、文件、数据库全在自己手里。

---

## 架构

```
浏览器 ──> Caddy（自动 HTTPS / 反代 / 静态资源）
              │
              ├── /api/**        Node 服务（Hono，端口 8787，容器内）
              └── /*             SSR + 前端静态页

Node 服务
  ├─ API 层        src/api       路由 + zod 契约 + OpenAPI
  ├─ 业务逻辑      app/          来自上游 qingyu-blog，原样保留（JS）
  ├─ 适配层        src/bindings  Workers API → 本地实现（D1→SQLite、KV、R2→本地磁盘…）
  ├─ SSR / SEO     src/ssr、src/routes
  └─ CLI           src/cli       migrate / seed / backup / restore / health / smoke

存储
  ├─ 数据库        SQLite（默认，node:sqlite）/ PostgreSQL（可选 profile）
  ├─ 文件          本地磁盘 data/（可选 S3 兼容对象存储）
  └─ 缓存          内存 + 定时任务 src/scheduler.ts

```

关键约束：**`app/` 不改**。上游代码原样同步，靠 `src/bindings` 适配，所以升级上游只需跑
`npm run sync:upstream`。

---

## 目录结构

```
qingyu-universal/
├─ app/            上游业务代码（Functions 形式，保持原样，不修改）
│  ├─ functions/   API 与页面处理
│  ├─ migrations/  SQL 迁移（0001~0039，幂等）
│  └─ public/      博客前端静态资源
├─ src/            本项目服务代码（TypeScript）
│  ├─ api/         路由、zod 契约、OpenAPI 定义
│  ├─ bindings/    Workers → 本地运行时适配
│  ├─ ssr/         服务端渲染
│  ├─ routes/      健康检查、SEO、静态导出、图片代理
│  ├─ cli/         migrate / seed / backup / restore / health / smoke
│  ├─ index.ts     HTTP 入口
│  └─ config.ts    环境变量校验（启动即校验）
├─ deploy/         部署物（见下）
├─ scripts/        构建与上游同步脚本
├─ tests/          vitest 测试（22 个文件）
├─ docs/           详细文档
├─ compose.yaml            默认编排：拉 GHCR 预构建镜像 + Caddy
├─ compose.build.yaml      覆盖项：改为现场源码构建
└─ package.json           要求 Node ≥ 24
```

### `deploy/` 里有什么

| 文件 | 用途 |
| --- | --- |
| `install.sh` | 一键引导：下载 qy.sh 并把终端交给它 |
| `qy.sh` | **部署助手本体**，数字菜单，Linux 服务器用 |
| `install.ps1` | Windows 侧的一键引导 |
| `Dockerfile` | 镜像构建 |
| `Caddyfile` | Caddy 配置（HTTPS + 反代） |
| `postgres/schema.sql` | PostgreSQL 建表脚本 |
| `helm/` | K8s Helm Chart |
| `render.yaml` / `railway.json` / `fly.toml` | Render / Railway / Fly 部署模板 |

---

## 脚本使用

### 一键部署（Linux，推荐）

需要 Docker、Docker Compose、curl、git：

```bash
curl -fsSL https://raw.githubusercontent.com/kejiland/qingyu-universal/main/deploy/install.sh | bash
```

进去就是数字菜单，全程不用手写 `.env`：

| 编号 | 功能 | 编号 | 功能 |
| --- | --- | --- | --- |
| 1 | 安装（已装过会问是否重装） | 7 | 域名与 HTTPS（设置 / 更换 / 解除） |
| 2 | 更新（自动先备份） | 8 | 体检（网站打不开先跑这个） |
| 3 | 回滚 | 9 | 清理磁盘 |
| 4 | 备份恢复 | 10 | 卸载 / 重装 |
| 5 | 启停与日志 | 11 | 设置快捷键 |
| 6 | 查看状态 | 0 | 退出 |

每做完一步提示 `按回车继续，按 k 回到主菜单`：回车继续，按 `k`/`K` 直接重启脚本回到主菜单。
嫌 `k` 不顺手就选 11 换键，配置存在 `/opt/qingyu-universal/.qyrc`（可用 `QINGYU_DIR` 改位置），
删掉该文件恢复默认。

装完默认是 IP + 端口；绑域名走菜单 7，Caddy 自动签 Let's Encrypt 证书（域名需已解析到本机）。

### 直接跑单条命令

```bash
bash deploy/qy.sh install     # 安装
bash deploy/qy.sh update      # 更新（自动先备份）
bash deploy/qy.sh rollback    # 回滚
bash deploy/qy.sh backup      # 备份
bash deploy/qy.sh restore     # 从备份恢复
bash deploy/qy.sh logs        # 看日志
bash deploy/qy.sh restart     # 重启
bash deploy/qy.sh status      # 看状态
bash deploy/qy.sh domain      # 配域名和 HTTPS
bash deploy/qy.sh doctor      # 体检
bash deploy/qy.sh clean       # 清理 Docker 缓存
bash deploy/qy.sh uninstall   # 卸载（可选保留数据）
bash deploy/qy.sh hotkey      # 设置快捷键
bash deploy/qy.sh -h          # 帮助
```

默认安装目录 `/opt/qingyu-universal`，换位置：`export QINGYU_DIR=/你的路径`。

### 手动部署

```bash
git clone https://github.com/kejiland/qingyu-universal.git
cd qingyu-universal
cp .env.example .env      # 至少填 SITE_URL 和 BLOG_ADMIN_SETUP_KEY
docker compose up -d      # 拉预构建镜像（快）
curl -fsS http://127.0.0.1:8787/healthz
```

要现场编译源码：`docker compose -f compose.yaml -f compose.build.yaml up -d --build`（需 ≥2G 内存）。
之后浏览器打开 `SITE_URL/admin` 设管理员密码。

### 常用 npm 脚本

```bash
npm run build          # 编译服务端 + 前端
npm run dev            # 本地开发（tsx watch）
npm run migrate        # 应用数据库迁移
npm test               # vitest 全量测试
npm run typecheck      # 类型检查
npm run sync:upstream  # 同步上游 qingyu-blog 代码
npm run db:migrate:postgres   # SQLite → PostgreSQL
```

---

## 文档

| 文件 | 内容 |
| --- | --- |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | 部署细节（域名、对象存储、数据库选型） |
| [docs/API.md](docs/API.md) | API 说明 |
| [docs/POSTGRES.md](docs/POSTGRES.md) | 用 PostgreSQL |
| [docs/UPSTREAM.md](docs/UPSTREAM.md) | 上游同步流程 |
| [docs/DESIGN.md](docs/DESIGN.md) | 设计取舍 |

## License

见 [LICENSE](LICENSE)。
