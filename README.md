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
| 后台界面 | Vue 3 + Vite + Tailwind v4 | 组件化 + 设计令牌，明暗双主题；与博客同一套暖色气质 |
| 反代 | Caddy | 自动 HTTPS，零配置 |

> 上游 `app/` 目录（业务逻辑，约 240 KB JS）**保持原样**，只通过一层适配器接入上述栈。
> 这样上游修 bug 时，重新同步 + 跑一次适配补丁即可，见 [docs/UPSTREAM.md](docs/UPSTREAM.md)。

---

## 一分钟部署（Linux VPS）

**最简单**——不带任何参数，脚本自己决定怎么部署：

```bash
curl -fsSL https://raw.githubusercontent.com/kejiland/qingyu-universal/main/deploy/install.sh | bash
```

有域名的话加上它，就能拿到自动 HTTPS（条件不满足时脚本会自动降级，不会失败）：

```bash
curl -fsSL https://raw.githubusercontent.com/kejiland/qingyu-universal/main/deploy/install.sh \
  | bash -s -- --domain blog.example.com
```

脚本会自动：安装 Docker → 判断部署模式 → 生成 `.env` 与随机密钥 → 构建镜像 →
启动容器 → 等待健康检查 → 输出**访问地址**与初始化密钥。

### 最省事的用法（推荐）

```bash
./deploy/install.sh
```

**不需要任何参数。** 脚本会自己判断该怎么部署：

| 情况 | 脚本的行为 |
| --- | --- |
| 没给域名 | 自动探测公网 IP，挑一个空闲端口，用 `http://<IP>:<端口>` 访问 |
| 给了域名，且 80/443 空闲、DNS 已指向本机 | 启动 Caddy，自动申请 Let's Encrypt 证书 |
| 给了域名，但 80/443 被占用或 DNS 未生效 | **自动降级**为自定义端口 + 纯 HTTP，并说明原因 |

关键点是**它不会因为端口或 DNS 问题中止**。你不需要先搞清楚端口占用、
DNS 解析这些事——脚本自己选好能跑通的配置，最后告诉你访问地址。

### 有终端时会先检测、再让你选

在真实终端里（不是 CI），脚本会先报告检测结果，然后用回车即默认的方式提问：

```
==> 环境检查
    系统          Debian GNU/Linux 13 (trixie) / x86_64
    公网 IP       203.0.113.5
    curl          已安装
    Docker        已就绪
    可用磁盘      977271 MB
    端口 80/443   空闲（可启用自动 HTTPS）

==> 请选择部署方式
    1) 域名 + 自动 HTTPS   （推荐；需要域名解析到 203.0.113.5）
    2) IP + 端口           （无需域名，纯 HTTP）
  选择 [1]: 
```

**一路回车就能装完。** 80/443 被占用时，脚本会说明原因（HTTP-01 固定走 80、
TLS-ALPN 固定走 443，属协议限制），再问你用哪个端口，留空自动选：

```
==> 80/443 已被占用，无法申请 Let's Encrypt 证书
    （HTTP-01 验证固定走 80，TLS-ALPN 固定走 443 —— 这是协议限制，不是本项目的限制）
    可选：腾出端口后重跑可启用 HTTPS；或继续用自定义端口（纯 HTTP）

  自定义端口（留空自动选空闲端口）: 
```

不需要交互时加 `--yes`（或用 `curl | bash`、CI 等无终端环境，脚本会自动识别）：

```bash
curl -fsSL .../install.sh | bash -s -- --yes
```

> 实现细节：`curl … | bash` 时 stdin 是**脚本本身**，普通 `read` 会把脚本内容
> 当成用户输入吃掉。所以交互一律从 `/dev/tty` 读，`/dev/tty` 不可用时自动退回
> 非交互模式。

降级后的输出长这样：

```
访问地址    http://blog.example.com:8080

未能启用自动 HTTPS 的原因：端口 80/443 已被占用
已自动改用端口 8080 继续部署，无需你处理。
条件具备后可一条命令切换：
  ./deploy/install.sh upgrade --domain blog.example.com

⚠ 注意：此模式下管理后台的登录密码是明文传输的。
```

等 80/443 腾出来、或 DNS 生效之后，跑一次最后那条命令就会切回 HTTPS。

### 为什么降级后拿不到证书

这是个硬约束，不是本项目的限制：Let's Encrypt 的两种自动验证方式都绑死端口——
HTTP-01 固定走 **80**，TLS-ALPN 固定走 **443**。换成别的端口就拿不到自动证书。

想要「自定义端口 + 有效证书」，只能改用 DNS-01 验证（在 DNS 里加 TXT 记录），
那需要带 DNS 插件的自定义 Caddy 镜像，不在当前范围内。
另一条路是用反向隧道，见下一节。
### 服务器不提供 80/443（云厂商限制、ISP 封禁、NAT 后）

这和"端口被占用"是两回事：**占用**是别的程序在用（腾出来或反代即可），
**不提供**是流量根本到不了这台机器（比如家用宽带、受限 VPS、多层 NAT）。

这种情况下上面三个方案都不成立，本应用也无法自行解决 —— 需要一个
**反向隧道**：由内往外建立连接，外部通过隧道服务商的域名访问，
不需要任何入站端口。

| 方案 | 说明 |
| --- | --- |
| **Cloudflare Tunnel**（`cloudflared`） | 免费、自带 HTTPS 与 CDN。代价是又依赖 Cloudflare |
| **Tailscale Funnel** | 免费额度、不依赖 Cloudflare，但域名是 `*.ts.net` |
| **其它隧道**（frp / ngrok / bore） | 需要自己有一台有公网端口的机器做中转 |

以 Cloudflare Tunnel 为例（外部无需开放端口）：

```bash
./deploy/install.sh --port 8787          # 本应用监听 0.0.0.0:8787，纯 HTTP
cloudflared tunnel --url http://localhost:8787
```

拿到隧道域名后，把 `.env` 的 `SITE_URL` 改成那个 `https://` 地址并重启 ——
否则 RSS、Sitemap、分享卡片里的链接会指向 `127.0.0.1`：

```bash
sed -i 's|^SITE_URL=.*|SITE_URL=https://你的隧道域名|' .env
docker compose up -d
```

隧道模式下 `TRUST_PROXY` 保持 `0` 即可（隧道本身会终止 TLS，
但如果它不覆盖 `X-Forwarded-For`，设为 1 反而会信任伪造头）。

### 与现有 Web 服务器共存（方案 3）

如果服务器上已经跑着 nginx / Apache，让它继续对外，把请求转发给本应用即可。
本应用的容器会监听宿主机的一个端口，你只需要在反代里指过去。

部署时用**不带 `--domain`** 的方式，让脚本不启动 Caddy：

```bash
./deploy/install.sh --port 8787           # 应用监听 0.0.0.0:8787
```

然后在 nginx 里加：

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;   # 注意用 $remote_addr
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 64m;                         # 上传上限
}
```

两点要特别注意：

1. **`X-Forwarded-For` 必须由反代覆盖**（用 `$remote_addr`，不要用 `$proxy_add_x_forwarded_for`）。
   否则客户端可以自带这个头，伪造 IP 绕过限流。
2. 这种模式下 `.env` 里 `TRUST_PROXY=0`，应用的限流会以**反代的 IP** 为准
   （所有人看起来是同一个 IP）。若要恢复按真实访客 IP 限流，
   把 `.env` 的 `TRUST_PROXY` 改成 `1` 并重启 —— 前提是你已按第 1 点覆盖了该头。

### 两种部署模式

**域名不是必需的。** 不给 `--domain` 时走 IP + 端口模式：

```bash
# 无域名：直接用 http://<服务器IP>:8080 访问，普通 HTTP，不涉及证书
curl -fsSL https://raw.githubusercontent.com/kejiland/qingyu-universal/main/deploy/install.sh | bash -s -- --port 8080

# 有域名：启用 Caddy + Let's Encrypt 自动 HTTPS
curl -fsSL https://raw.githubusercontent.com/kejiland/qingyu-universal/main/deploy/install.sh | bash -s -- --domain blog.example.com
```

| | 有域名 | 无域名 |
| --- | --- | --- |
| 访问方式 | `https://blog.example.com` | `http://<IP>:<端口>` |
| 反向代理 | Caddy（自动申请并续期证书） | **不启动**，app 直接对外 |
| 占用端口 | 80 / 443 | 仅 `--port`（默认 8080） |
| 证书 | Let's Encrypt | 无（所以不会有任何证书警告） |
| 脚本探测 | — | 自动探测公网 IP 写入 `SITE_URL` |
| `TRUST_PROXY` | `1`（信任 Caddy 注入的客户端 IP） | `0`（没有反代时**不能**信任转发头，否则限流可被伪造绕过） |

无域名模式刻意**不启动 Caddy**：Caddy 在没有域名时会用自签证书并强制 HTTPS，
浏览器会报证书错误——对 IP 访问来说这是纯负担。

以后有了域名，改一条命令即可切换，数据完全保留：

```bash
./deploy/install.sh upgrade --domain your.domain.com
```

可用选项：`--port <端口>`、`--ip <地址>`（不填自动探测公网 IP）。

从已克隆的仓库运行（推荐，可用本地最新代码）：

```bash
git clone https://github.com/kejiland/qingyu-universal
cd qingyu-universal
./deploy/install.sh --domain blog.example.com
```

Windows（Docker Desktop）：

```powershell
.\deploy\install.ps1 -Domain blog.example.com
```

部署完成后打开 `https://blog.example.com/admin`，填入脚本输出的 **初始化密钥** 设置管理员密码。以后随时可用 `./deploy/install.sh info` 找回访问地址、初始化密钥、版本和运行状态。

WSL2（Docker Desktop）默认只把端口映射到 Windows 的 `localhost`。如果要在局域网或公网访问，运行 Windows 侧脚本（会请求管理员权限）：

```powershell
.\deploy\windows\expose-wsl.ps1 -Port 8080 -Distro Debian -TryUpnp
```

脚本会自动添加 Windows 端口转发、放行防火墙，并尝试通过 UPnP 配置路由器。若公网端口检测仍为关闭，需要在路由器把公网 TCP 8080 转发到本机局域网地址的 8080 端口；没有公网入站条件时，改用 README 前面的 Cloudflare Tunnel / Tailscale Funnel。WSL 重启后 IP 可能变化，重新运行此脚本即可。

### 更新到新版本

**一条命令，永远有效**（从任何目录执行都行）：

```bash
curl -fsSL https://raw.githubusercontent.com/kejiland/qingyu-universal/main/deploy/install.sh \
  | bash -s -- upgrade
```

它先取最新的安装脚本、再取最新的代码，因此**不会出现「用旧脚本更新」的死循环**。
升级前会自动备份数据库，`.env` 与 `data/` 不受影响。

升级完成后验证：

```bash
curl -s http://localhost:8080/healthz   # 端口换成你的
# → {"version":"0.3.0","revision":"374a49d", ...}
```

`revision` 是构建时的 commit 短 SHA —— 有它才能确认升级真的生效了。

#### 开发时：直接同步本地代码

如果你在本地改了代码、想立刻同步到测试环境，**不需要先提交或推送**，
直接从源码目录执行 upgrade 即可 —— 脚本会把本地代码复制过去而不是下载：

```bash
cd ~/qingyu-universal          # 你的源码目录
./deploy/install.sh upgrade    # 默认同步到 /opt/qingyu-universal
# 或指定目标：./deploy/install.sh upgrade --dir /opt/qingyu-universal
```

三种取码路径由脚本自动判断：

| 你的情况 | 脚本的行为 |
| --- | --- |
| 从源码目录执行 | 复制本地代码（开发循环） |
| 安装目录是 git 仓库 | `git pull --ff-only` |
| 压缩包安装（curl 装出来的） | 下载 GitHub 最新代码包 |

### 常用运维命令

```bash
./deploy/install.sh upgrade          # 升级（升级前自动备份，数据保留）
./deploy/install.sh backup           # 数据库快照 → data/backups
./deploy/install.sh restore <快照>    # 从快照恢复
./deploy/install.sh logs             # 查看日志
./deploy/install.sh status           # 容器与健康状态
./deploy/install.sh info             # 查看访问地址、初始化密钥、版本、文章数等部署信息
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

## 新版后台

后台已从「单文件 315 KB 手写 DOM」重构为 **Vue 3 + Vite + TypeScript + Tailwind** 应用，
源码在 `admin/`，构建产物由服务端托管在 `/admin/`。

```bash
npm run admin:install     # 安装后台依赖
npm run admin:dev         # 开发模式（热更新，代理 API 到 :8787）
npm run admin:build       # 构建到 admin/dist
```

### 界面

- **设计令牌驱动**：颜色、圆角、阴影、字体统一在 `admin/src/style.css` 的 `@theme` 中定义，
  明暗双色板通过 CSS 变量切换，组件不需要写两遍 `dark:` 变体
- **暖色编辑风**：与博客正文的赭橙主色同源，大量留白、克制阴影、短促动效
- **响应式**：≥1024px 固定侧栏，小屏收为抽屉
- **无 UI 框架依赖**：组件用 Tailwind 工具类 + 少量语义类（`.card` `.btn` `.input`）自建，
  因此样式完全可控，不会出现「一眼看出是某个 UI 库」的味道

### 已迁移的模块

| 模块 | 状态 |
| --- | --- |
| 登录 / 首次初始化 | ✅ |
| 文章列表（搜索、状态筛选、计数） | ✅ |
| 文章编辑器（Markdown 分栏实时预览、封面、标签、SEO 覆盖、定时发布） | ✅ |
| 媒体库（拖拽上传、进度、复制链接、删除） | ✅ |
| 评论管理（状态筛选、单条/批量审核、删除） | ✅ |
| 设置（站点信息、修改密码） | ✅ |
| 备份（列表、创建、删除、恢复） | ✅ |
| 日志（操作审计、错误聚合） | ✅ |
| 订阅者（名单、分组、群发） | ✅ |
| Webmention（审核、删除） | ✅ |
| 统计（趋势图、来源分布） | ✅ |

### 迁移策略：新旧共存，零功能中断

上游的路由判定是 `path.indexOf('/admin') === 0`，因此 **`/admin-legacy` 会自动落到旧版后台**，
无需改动任何上游代码。于是：

```
/admin          → 新版后台（逐模块迁移中）
/admin-legacy   → 旧版后台（功能完整，随时可用）
```

未迁移的模块在新版里显示占位页并提供「前往旧版后台」入口，**功能不丢失**。
迁移完成后再把 `/admin` 与 `/admin-legacy` 对调即可。

> 构建产物不存在时（未执行 `admin:build`），`/admin` 会自动回落到旧版后台，
> 因此开发环境和精简部署都不会出现白屏。

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
| 所有页面 | **顶栏（品牌 + 导航 + 操作区）与页脚**——不再等 JS 加载后才出现 |
| /archive | **按年/月分组的全部已发布文章** |
| /tags、/categories | **标签云 / 分类云（含计数）** |
| /about、/links | **关于正文 / 友链列表**（来自站点设置） |
| /popular | **按浏览量倒序的热门列表** |
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

当前已覆盖文章 / 评论 / 检索 / 设置 / 认证 / 媒体 / 备份 / 日志 / 健康检查共 **21 条路径**，其余仍走上游兜底，
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
admin/                  新版后台（Vue + Vite + Tailwind）
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
- [x] **v0.3** 后台重构为 Vue 3 + Vite + Tailwind SPA（文章 / 编辑器 / 媒体库）
- [x] **v0.3.1** 契约扩展到认证/媒体/评论管理/备份/日志（21 条路径），后台四大模块迁移完成
- [x] **v0.4** 文章页与首页列表服务端渲染（正文/列表进 HTML，爬虫免 JS 可见）
- [x] **v0.4.1** 数据库外键约束与级联清理（曾清理 18 条存量孤儿）
- [x] **v0.5** 后台模块迁移全部完成（订阅者 / Webmention / 统计）
- [x] **v0.5.1** 归档 / 标签 / 分类页服务端渲染
- [x] **v0.6** comments.parent_id 自引用外键（删除父评论时级联清理回复）
- [ ] **v0.7** 撤下旧版后台、公开站前端拆分（Astro/SSR 取代 296 KB 的 app.js）
- [ ] **v0.3** 契约覆盖剩余约 50 个接口（管理认证 / 媒体 / 订阅 / 备份）
- [ ] **v0.3.1** PostgreSQL 适配、Redis/Valkey 限流
- [ ] **v0.4** PaaS 模板（Railway / Render / Fly.io / Cloud Run）、多架构镜像发布
- [ ] **v0.5** Helm Chart、SQLite → PostgreSQL 迁移工具、镜像签名与 SBOM

## 许可证

MIT，与上游保持一致。业务代码版权归原项目作者，见 [LICENSE](LICENSE)。