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

脚本会自动：安装 Docker → 判断部署模式 → 检测本机防火墙并询问是否放行 → 生成 `.env` 与随机密钥 → 构建镜像 →
启动容器 → 等待健康检查 → 输出**访问地址**与初始化密钥。

### 国内服务器：网络卡就加 `--mirror`

国内机房直连 GitHub、Docker Hub、npm 经常超时，加上 `--mirror` 会自动改走国内源：

```bash
curl -fsSL https://raw.githubusercontent.com/kejiland/qingyu-universal/main/deploy/install.sh \
  | bash -s -- --mirror
```

它只做三件事，任何一步失败都会自动回落官方源，**不会因为加速站挂了而装不上**：

| 加速项 | 做法 |
| --- | --- |
| 代码下载 | GitHub 克隆 / 压缩包 / 版本查询先走加速前缀（`--github-proxy` 可换成你自己的） |
| Docker 镜像 | 往 `/etc/docker/daemon.json` 写 `registry-mirrors`（已有配置一律不动） |
| npm 依赖 | 构建镜像时把 registry 换成 `registry.npmmirror.com` |

选择会写进 `.env`，以后 `upgrade` 不用重复加；想关掉用 `--no-mirror`。

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
| 服务器开着 ufw / firewalld | 问一句「要不要自动放行端口」，同意就代劳；`-y` 时只打印命令 |

关键点是**它不会因为端口或 DNS 问题中止**。你不需要先搞清楚端口占用、
DNS 解析这些事——脚本自己选好能跑通的配置，最后告诉你访问地址。

### 数据库也一样：回车即默认，想要 PostgreSQL 说一声

默认是 SQLite（备份就是一个文件）。想要 PostgreSQL，直接在命令里指定就行，
不用先研究配置：

```bash
./deploy/install.sh install --db postgres          # 脚本自动装好内置 PostgreSQL
./deploy/install.sh install \
  --database-url 'postgres://用户名:密码@主机:5432/库名'   # 用你自己的云数据库
```

- **内置 PostgreSQL**：自动拉镜像、建库、写随机密码；端口只在容器网络内，不占用宿主机 5432。
- **自己的云数据库**：填连接串即可，应用首次启动自动建表（阿里云 RDS / 腾讯云 / Supabase 都行）。
- 已有 SQLite 站点想切过去，见 [PostgreSQL 迁移](docs/POSTGRES.md)。
- 随时用 `./deploy/install.sh info` 查看当前用的是哪种数据库。

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

紧接着问数据库（同样回车即默认，想要 PostgreSQL 选 `2` 或 `3`）：

```text
==> 请选择数据库
    1) SQLite                  （推荐；零依赖，备份就是一个文件）
    2) PostgreSQL · 内置容器    （脚本自动装好，多进程/高并发更稳）
    3) PostgreSQL · 我自己的库 （阿里云 RDS / 腾讯云 / Supabase…）
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

可用选项：`--port <端口>`、`--ip <地址>`（不填自动探测公网 IP）、`--mirror`（国内网络加速）。

从已克隆的仓库运行（推荐，可用本地最新代码）：

```bash
git clone https://github.com/kejiland/qingyu-universal
cd qingyu-universal
./deploy/install.sh --domain blog.example.com
```

Windows（Docker Desktop，需已启动 Docker Desktop）：

```powershell
# 交互式安装：会问你「选 SQLite 还是 PostgreSQL」「没有域名用哪个端口」
.\deploy\install.ps1

# 无域名：IP + 端口（默认 8080，80/443 被占用也没关系）
.\deploy\install.ps1 -Port 8080

# 有域名：自动 HTTPS
.\deploy\install.ps1 -Domain blog.example.com

# 日常运维（和 Linux 版一样的子命令）
.\deploy\install.ps1 info       # 访问地址、初始化密钥、版本、运行状态
.\deploy\install.ps1 doctor     # 一键体检：Docker / 容器 / 端口 / 防火墙 / 数据库
.\deploy\install.ps1 upgrade    # 拉新版本并重建（自动先备份）
.\deploy\install.ps1 backup     # 生成数据库快照
```

> Windows 小提示：端口参数写 `-Port`；数据库参数必须写 `-Database sqlite|postgres`（`-Db` 在 PowerShell 里会和公共参数 `-Debug` 冲突，属于语言限制）。用「管理员 PowerShell」运行时，脚本会自动新增防火墙放行规则；不是管理员时会打印一条命令给你照抄。

部署完成后打开 `https://blog.example.com/admin`，填入脚本输出的 **初始化密钥** 设置管理员密码。以后随时可用 `./deploy/install.sh info` 找回访问地址、初始化密钥、版本和运行状态。

> Fly.io / Render / Railway / Kubernetes / Redis / 多架构镜像与签名见 [多云与生产部署](docs/DEPLOYMENT.md)。
> PostgreSQL schema 与数据迁移见 [PostgreSQL 迁移](docs/POSTGRES.md)。

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

> **懒得记命令？** 装好之后直接运行 `./deploy/install.sh`（不带任何参数），会弹出数字菜单：
> 按 `1`-`13` 选升级 / 体检 / 备份 / 定时备份 / 打包迁移等，直接回车退出。
> 加了 `-y` 或明确写了子命令（如 `doctor`）则不会弹，自动化脚本不受影响。

```bash
./deploy/install.sh upgrade          # 升级（升级前自动备份，数据保留）
./deploy/install.sh rollback         # 回滚到上一个版本（回滚前自动备份，可再滚回来）
./deploy/install.sh backup           # 数据库快照 → data/backups
./deploy/install.sh restore <快照>    # 从快照恢复
./deploy/install.sh start            # 启动服务
./deploy/install.sh stop             # 停止服务（数据保留）
./deploy/install.sh restart          # 重启应用（改完 .env 后用它生效）
./deploy/install.sh logs             # 查看日志
./deploy/install.sh status           # 容器与健康状态
./deploy/install.sh info             # 查看访问地址、初始化密钥、版本、文章数等部署信息
./deploy/install.sh doctor           # 一键体检：网站打不开/传不了图先跑它，每项给 ✅⚠️❌ 和修复命令
./deploy/install.sh uninstall        # 停止并删除容器（数据卷保留）
```

### 备份与迁移（服务器坏了也不怕）

**开定时备份（一条命令）**

```bash
./deploy/install.sh autobackup                    # 每天 03:30 自动快照，保留最近 7 份
systemctl list-timers | grep qingyu               # 看下次执行时间
systemctl start qingyu-backup.service             # 立刻手动跑一次（等同 backup）
```

脚本会写一个 systemd 定时器（没有 systemd 的机器自动改用 crontab），失败不影响网站运行；
`doctor` 体检里也会显示「定时备份是否已启用 + 下次执行时间 + 现有快照份数」。

**换服务器 / 搬家（一条命令打包）**

```bash
./deploy/install.sh migrate          # 生成 ~/qingyu-migrate-<时间>.tar.gz
```

包里包含：站点配置 `.env`（域名、端口、密钥原样保留）+ 整个数据卷（文章、评论、上传的图片、历史快照），
以及一份给新服务器用的恢复脚本。到新服务器后按包内 `README.txt` 三步走：

```bash
tar xzf qingyu-migrate-20261006-120000.tar.gz
bash qingyu-migrate-20261006-120000/deploy/install.sh install -y   # 复用包里的 .env 装程序
bash qingyu-migrate-20261006-120000/restore-here.sh --data-only   # 把数据装回去
```

> 打包文件里有管理员密钥和数据库密码，请当作敏感文件保管（脚本已自动设为仅 root 可读）。

> 回滚对两种安装方式都有效：git 检出走本地历史（不联网），压缩包安装按版本号重新下载历史代码包。脚本会按需自动安装 git，装不上也不影响回滚。

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
| `DATABASE_URL` | PostgreSQL 连接串，留空用 SQLite | 空 |
| `COMPOSE_PROFILES` | 启用的可选容器（`postgres` / `redis` / `domain`） | 空 |
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
| 设置（站点信息、高级设置、修改密码） | ✅ |
| 备份（列表、创建、删除、恢复） | ✅ |
| 日志（操作审计、错误聚合） | ✅ |
| 订阅者（名单、分组、群发） | ✅ |
| Webmention（审核、删除） | ✅ |
| 统计（趋势图、来源分布） | ✅ |

### 后台策略：新版为默认，旧版只作紧急回退

新版后台已经覆盖全部常用模块和高级设置，界面中不再显示旧版入口：

```
/admin             → 新版后台（默认）
/admin/settings/advanced → 导航、页脚、公告、功能开关、评论规则、友链、广告位
/admin-legacy      → 旧版后台（不显示入口，仅在紧急排障时保留）
```

> 构建产物不存在时（未执行 `admin:build`），`/admin` 会自动回落到旧版后台，
> 因此开发环境和精简部署都不会出现白屏。

---

## 公开站首屏：SSR + 轻量启动器

公开站不再让首屏直接下载整份单文件 SPA。服务端返回的 HTML 自带正文，页面先加载一个约 0.9 KB 的启动器，
再在浏览器空闲（或用户第一次交互）时才拉取主包，旧版后台则拆成独立分包按需加载：

| 文件 | 大小 | 何时加载 |
| --- | --- | --- |
| `boot.min.js` | ~0.9 KB | 首屏立即 |
| `app.min.js` | ~157 KB | 空闲或首次交互 |
| `admin-legacy.min.js` | ~28 KB | 仅旧后台回退时 |

```
npm run frontend:build   # 只重新压缩三个前端分包
npm run build            # 类型检查 + 前端分包
```

`npm run sync:upstream` 会自动重新应用这份拆分（`apply-frontend-split.mjs`，幂等，必要时递增补丁版本）。

### 视觉打磨：独立叠加样式 `polish.min.css`

上游的 `style.css`（133 KB）由同步脚本覆盖，**本项目不直接改它**。所有外观改进写在自有文件
`app/public/polish.css`（约 11 KB），由 `npm run frontend:build` 压缩成 `polish.min.css`，
紧跟在主样式之后加载 —— 升级上游样式不会冲掉这些改动，也不会反过来被它污染。

覆盖范围：顶栏毛玻璃与导航胶囊态、首页标题排版、文章卡片层次 / 日期胶囊 / 标签芯片、
文章页阅读节奏（标题、引用、代码块、表格）、页脚分层、焦点可见性、滚动条，以及
`prefers-reduced-motion` 动效降级。全部只用既有的 `--bg / --card / --fg / --muted / --border / --accent` 变量，
因此四套 accent 主题与暗色模式自动跟随，无需重复写配色。

同步后 `apply-frontend-split.mjs` 会幂等补回 `index.html` 的样式引用、`sw.js` 缓存清单与 `_headers` 长缓存规则。

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
scripts/                 上游适配补丁 / 前端分包与压缩构建工具（.mjs）
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
- [x] **v0.7-a** 撤下旧后台入口；高级设置完整迁移到新版（旧路径保留为紧急回退）
- [x] **v0.7-b** 公开站前端拆分（SSR 首屏 + 轻量启动器按需加载；旧后台独立分包，弃用 Astro 重写）
- [x] **v0.8** 公开站视觉打磨：日期规范成 YYYY-MM-DD、卡片摘要回退到 search 全文、独立叠加样式 `polish.min.css`
- [x] **v0.9** 部署脚本一键体检 `doctor`：Docker / 容器 / 端口 / 防火墙 / 公网地址 / 磁盘 / 错误日志，每项给 ✅⚠️❌ 加一句修复命令
- [x] **v0.9-a** 国内网络加速 `--mirror`：GitHub 代码加速、Docker Hub `registry-mirrors`、npm npmmirror，失败自动回落官方源
- [x] **v0.9-b** 二次运行弹数字菜单：升级 / 体检 / 信息 / 状态 / 备份 / 日志 / 重启 / 停止 / 启动 / 回滚 / 卸载，回车即退出；交互终端 + 已部署过才会出现，CI 与 `-y` 不受影响
- [x] **v0.9-c** 防火墙询问后自动放行：检测 ufw / firewalld，确认后只「新增放行规则」（域名模式含 80/443+443udp），非交互时退回打印命令；升级时也会复查端口
- [x] **v0.9-g** 备份与迁移：`autobackup` 装 systemd/crontab 定时备份（每天自动快照、只保留最近 N 份，`--at`/`--keep`/`--off` 可调）；`backup --keep N` 自动清理旧快照；`migrate` 一键打包整站（`.env` + 数据卷 + 恢复脚本）用于换服务器；`uninstall --purge` 彻底删数据（二次确认，多卷时拒绝乱删）；`doctor` 增加「定时备份是否已启用 + 下次执行时间」检查
- [x] **v0.9-e** Windows 部署脚本与 Linux 版对齐：`info`/`doctor`/`upgrade`/`backup`/`restore`/`status` 子命令、`-Port`/`-Database` 选择、生成的 `.env` 字段与 `install.sh` 一致（非管理员时给出防火墙放行命令）
- [x] **v0.9-d** CI 新增「干净 Debian 一键安装验收」：在什么都没有的容器里让脚本自己装 curl/git/Docker、装完做健康检查 + doctor + 幂等重跑（.env 必须原封不动）
- [x] **v0.9-h** 起飞前资源体检：安装开头先报「CPU 核数 · 内存 · 可用内存」，内存低于 1GB / 无 swap / 磁盘偏小时提前给可执行建议（加 swap 或改用预构建镜像），避免构建到一半 OOM
- [x] **v0.9-i** 安装与升级分步显示：每一步显示「第 N/M 步 + 这步在干什么」并在结束时打勾，小白用户能清楚看到进度走到哪
- [x] **v0.9-j** 失败自动求助：任何一步出错时自动打印「当前步骤 / 出错位置 / 按顺序可执行的修复命令」，并按容器、网络、包管理器、权限等失败类型给出不同解法；明确告知配置和数据不会因失败丢失
- [x] **v0.9-k** 后台首次上手引导：新站登录后自动弹出「五步把新站变成能用的博客」卡片（完善站点信息 / 写第一篇文章 / 上传图片 / 查看评论 / 确认定时备份），带进度条与勾选记忆，可关闭后随时在侧栏重新打开
- [x] **v0.9-l** 前台首页「站点概览」小卡片：文章数 / 分类数 / 标签数 / 总字数 / 最近更新，数据由已加载文章列表本地统计（零额外请求），中英日韩印地五语文案，移动端两列自适应
- [x] **v0.9-m** 界面对比度自检工具：新增 `npm run check:contrast`，自动解析前台 / 后台样式表的主题变量，按 WCAG AA 标准逐项计算文字与背景的对比度（含 4套主题配色板 × 明暗两套），低于 4.5:1 直接让 CI 失败；同时借工具把原本偏淡的主色、弱化文字、警告 / 成功色统一调到达标，并新增 `--accent-fg` 让深色主题按钮改用深色字
- [x] **v0.9-n** 配色规范固化：`doctor` 体检新增「界面配色可读性」一节（有源码与 Node 时自动跑对比度自检，不达标直接列出行），并新增 [docs/DESIGN.md](docs/DESIGN.md) 说明变量体系、`--accent-fg` 深色主题约定与提交前检查清单
  - doctor 新增第 8.5 节「界面配色可读性」，缺 Node 或源码时自动跳过不打扰
  - 新增 `docs/DESIGN.md`：对比度底线、变量清单、深色主题按钮用深色字的约定
- [x] **v0.9-o** 与原版功能对照：新增 [docs/COMPARE.md](docs/COMPARE.md)，逐项列出与 [qingyu-blog](https://github.com/kejiland/qingyu-blog) 的差异（已对齐部分、后台还缺的 8 个页面、编辑器未接的 6 个功能、有意不同的云能力与后续顺序）；
  并把原版 2.10.61 → 2.10.63 的 3 个新功能全部同步过来：导航默认项自动补齐、新增导航项显示开关（新后台也有）、AI 结果不再按代码块显示，同时补登记「读取备份内容」接口文档
- [x] **v0.9-p** 后台补齐 P0 三个页面（与现有风格统一）：
  - **标签管理** `/admin/tags`：自动汇总全部标签与文章数，支持搜索、重命名、删除（一次请求批量更新所有文章，不逐篇写）
  - **系列管理** `/admin/series`：按系列分组展示文章与序号，支持重命名、移出系列（逐篇取完整文章回写，不会清空正文）
  - **待审评论** `/admin/comments/pending`：侧栏新增入口并带数量角标，直达时自动落在「待审核」筛选
- [x] **v0.9-q** 后台补齐 P1 两个页面（与现有风格统一）：
  - **音乐管理** `/admin/music`：上传（拖拽 + 按「歌名-歌手」自动解析）、搜索、行内试听进度条、改名、删除、每页 15 条分页；单曲上限 30MB，走对象存储 / 本地磁盘直传
  - **导入导出** `/admin/import-export`：全部导出 Markdown（ZIP，含 `posts.json`）、导出备份 JSON、单篇导出 MD，支持多选导入 `.md` / `.json`（同 ID 覆盖、批次内自动去重），与原版交换格式一致
- [x] **v0.9-r** 后台首页改为仪表盘（概览，与现有风格统一）：
  - **仪表盘** `/admin`：7 项核心指标（文章 / 已发布 / 定时 / 草稿 / 置顶 / 评论 / 待审），近 30 天访问与评论趋势、访问来源 5 组概览、站点资源（媒体 / 音乐 / 订阅 / 备份）、最新文章与最新评论
  - 侧栏新增「概览 · 仪表盘」入口，登录后默认进入仪表盘；整页骨架屏，任一接口失败只提示不阻塞其余数据
- [x] **v0.3** 路径级契约覆盖完成（60 条路径；兼容接口响应字段将逐步收紧）
- [x] **v0.3.1-a** Redis / Valkey 可选限流（配置 `REDIS_URL` 即启用）
- [x] **v0.3.1-b** PostgreSQL 运行时适配（配置 `DATABASE_URL` 即切换）
- [x] **v0.4** Fly.io / Render / Railway 模板、多架构 GHCR 镜像、SBOM 与 cosign 签名
- [x] **v0.5-a** Helm Chart、镜像签名与 SBOM
- [x] **v0.5-b** PostgreSQL schema 与 SQLite → PostgreSQL 数据迁移工具
- [x] **v0.5-c** PostgreSQL 一键部署（交互式三选一 / `--db postgres` / `--database-url`）

## 许可证

MIT，与上游保持一致。业务代码版权归原项目作者，见 [LICENSE](LICENSE)。