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

### 新手向导：一次问答走完全流程

**全新安装且没给任何参数时，脚本会先问你几个问题**——有终端才会问，
`-y`、CI、`curl … | bash` 一律不打扰，直接用推荐值装：

```
  ┌──────────────────────────────────────────────────────────┐
  │  轻语博客 · 安装向导                                      │
  └──────────────────────────────────────────────────────────┘

    这台机器：Debian GNU/Linux 12 / x86_64   可用磁盘 42133 MB
    公网 IP ：203.0.113.7

    接下来几个问题，每个都给好了推荐答案 —— 直接回车就是推荐方案。
    输入 b 回到上一题，输入 q 放弃安装。

  ── 第 1 问：别人怎么访问你的博客？
    1) 域名 + 自动 HTTPS  【推荐】
    2) IP + 端口
  选 1 还是 2 [1]:
```

一共五问：**访问方式 → 域名 → 数据库 → 定时备份 → 邮件**，最后有一屏「确认一下」：

| 操作 | 效果 |
| --- | --- |
| 回车 | 用推荐答案 / 确认开始安装 |
| `b` | 回到上一题 |
| `1` `2` `3` `4` | 在确认页跳回去改「访问方式 / 数据库 / 备份 / 邮件」 |
| `q` | 放弃（什么都没装，随时可重来） |

细节上替新手挡了几刀：域名会自动剥掉误粘的 `http://` 和路径，写成 `1.2.3.4`
或明显不是域名时会提示重填（三次都错就自动改回 IP + 端口）；端口会自动挑一个空闲的；
80/443 被占用时会先说明「证书验证固定走这两个端口」，再让你选。

### 可配置项：配置档与演练模式

| 用法 | 说明 |
| --- | --- |
| `install --dry-run` | **只打印将要做什么**，不装 Docker、不下载代码、不写 `.env`、不启容器 |
| `install --save-config my.conf` | 把本次的选择写成配置档（含 SMTP 密码，权限 600） |
| `install --config my.conf` | 照着配置档装；**命令行参数优先于配置档**，配置档只补你没给的项 |
| `install --timezone Asia/Shanghai` | 设系统时区（定时备份按它执行） |
| `install --smtp-host/-port/-user/-pass/-from …` | 邮件通知；留空 = 不配置，之后可在后台「设置 → 邮件」里补 |
| `install --no-autobackup` / `--skip-preflight` / `--no-doctor` | 分别跳过定时备份、起飞前检查、安装后体检 |

配置档就是 `KEY=VALUE`（`#` 开头是注释），可版本化管理、可复用：

```ini
# my.conf
DOMAIN=blog.example.com
DB=postgres
TIMEZONE=Asia/Shanghai
AUTOBACKUP=1
AT=03:30
KEEP=7
```

可选键：`DOMAIN` `PORT` `DB` `DATABASE_URL` `DIR` `REF` `REPO` `EMAIL` `IP` `TIMEZONE`
`SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `SMTP_FROM` `MIRROR` `KEEP` `AT` `AUTOBACKUP`。

### 断点续跑：装到一半失败不用从头再来

安装被拆成 6 步，每做完一步就记一笔到安装目录：

```
┌─ 第 2/6 步  检查并准备系统环境（curl / git / Docker）
==> 这一步上次已经完成，直接跳过（想从头执行请加 --reset）
└─ 第 2/6 步完成
```

**原样再跑一次同一条命令即可**——最慢的两步（装 Docker、构建镜像）不会重复做。
配置和数据全程保留，失败时脚本会直接告诉你「当前卡在第几步、下一步该跑什么」。

- `install --reset` 清除进度记录，从头执行（`.env` 与数据仍然保留）
- **已经装完的目录再跑 `install`，会自动转为 `upgrade`**，不会把线上配置顶掉
- `upgrade` 会先把「从哪个版本升到哪个版本」列出来（含新增提交数），再备份、再重建

### 安装后引导：装完告诉你「接下来三件事」

安装成功会自动跑一遍 `doctor` 体检，并给出明确指引：

```
    1) 打开 https://blog.example.com      （首次打开要等十几秒做数据库迁移）
    2) 打开 https://blog.example.com/admin 设置管理员密码
       安装密钥：qy-xxxxxxxx
    3) 确认 SITE_URL 是真实域名（现在若是 localhost / 内网 IP 就改 .env 后 restart）

  出问题先跑： ./deploy/install.sh doctor
```

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

**默认本地磁盘**，媒体与音乐落在 `DATA_DIR/uploads/{media,music,og}`，
由应用签发一次性上传地址，无需注册任何云服务即可使用。

**文件到底保存在哪？**

| 模式 | 落点 | 访问方式 |
| --- | --- | --- |
| 本机磁盘（默认） | 服务器上 `DATA_DIR/uploads/media`（图片）、`/music`（音乐）、`/og`（站点图标） | 本站直接对外发 `/media/*`、`/music/*`、`/og/*`（支持 Range，音乐可拖进度） |
| 对象存储 | 你自己账号下的桶（`media` / `music` / `backup`） | 浏览器直传桶，前台按「公开域名」直连；不占服务器带宽与磁盘 |

两种模式下，**数据库里存的都是同一种东西**：本地模式存根相对地址（`/media/x.png`），
云端模式存公开外链。媒体页的「复制 / 复制 MD」在复制那一刻才补全站点域名，
所以换域名、换端口、换 CDN 都不会让已有内容失效。

#### 推荐：在后台可视化配置（不用改 env 文件）

`后台 → 设置 → 存储`：

1. **当前保存位置** —— 展示本机上传目录与各类文件数量，一眼看清东西在哪。
2. **存储方式** —— 本机磁盘 / S3 兼容对象存储（第三方云端）二选一。
3. **对象存储配置** —— 端点、区域、Access Key、Secret、各桶与公开域名。
4. **测试连通性** —— 本机模式验「磁盘可写」；云端模式用**表单里的候选值**真签一次
   SigV4 并写删一个探针对象（所以可以先验证再保存）。
5. **保存配置** —— 存进独立表 `storage_config`，**立即生效、无需重启**。

几条刻意的设计：

* **密钥只单向进入服务端**：读接口只回传打码值（`first4****last4`）与「是否已配置」。
  留空 = 不修改原密钥，要清空得显式勾选「清除已保存的密钥」。
  存储配置**不经过** `/api/settings` —— 那是匿名可读且带缓存头的公开接口。
* **配置不完整时优雅降级**：选了云但端点/密钥/桶/公开域名没填齐，新上传自动退回本机磁盘，
  界面上明确标注「已选对象存储但配置不完整，暂用本机磁盘」，而不是把上传打死。
* **本地与云并存**：`/media/*`、`/music/*`、`/og/*` 三条本地读取路由是**常驻**的。
  切到云之后，库里那些相对地址的老文件仍由本机继续服务，**不会 404**；
  确认云端稳定后再迁移或清理本地副本。
* **迁移是逐对象的**：先上传，**只有确认某个对象已进桶**才把引用它的行改写成云端外链，
  绝不会出现「库里指向云、云上没文件」的坏引用。可重复执行，单个失败不中断，默认不删本地副本。

#### 也可以用环境变量（首次部署默认值）

```env
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_REGION=auto                # R2=auto；MinIO 通常 us-east-1；AWS 填真实区域
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_MEDIA_BUCKET=qingyu-media
S3_MEDIA_PUBLIC_BASE=https://media.example.com   # 必须可匿名读取
S3_MUSIC_BUCKET=qingyu-music                     # 留空沿用媒体桶
S3_MUSIC_PUBLIC_BASE=https://music.example.com   # 留空沿用媒体域名
S3_BACKUP_BUCKET=qingyu-backup                   # 留空沿用媒体桶
```

端点 + Access Key + Secret 三者齐全才判定为启用云端。**后台配置优先于环境变量**：
在后台保存过一次之后，本段就只是「重置回默认值」的兜底。

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

也可以不改 env 文件：`后台 → 设置 → AI 助手` 可视化填写 Base URL / API Key / 模型，
支持**拉取上游模型列表并点选**、以及一次真实的连通性测试。
配置存进独立表 `ai_config`（同样不经过公开的 `/api/settings`，密钥只回传打码值），
保存后立即生效、**无需重启**，且**优先于**上面的环境变量。

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

### 首屏图片反代（外链图床加速）

封面 / 头像如果挂在境外图床，浏览器首次访问要自己完成 DNS + TCP + TLS —— 实测到
Cloudflare 西雅图节点**仅 TLS 握手就要 0.39~0.54s**，首屏 `load` 事件被拖到 2s 级，
而图片本体可能只有 2KB：慢的是跨洋建连，不是带宽。

开启后（默认开启），渲染期把跨域 `http(s)` 图片改写成同源的 `/api/img?url=…`，
服务端抓取一次并落盘缓存，之后返回**同源 immutable 字节**：

```env
IMAGE_PROXY=1              # 0 = 关闭（/api/img 直接 302 回原始地址，行为与改动前一致）
IMAGE_PROXY_MAX_MB=15      # 单张上限，超出 413
IMAGE_PROXY_CACHE_MB=512   # 缓存总容量，超出按最久未访问淘汰
```

覆盖 7 个渲染点：SSR 的列表封面 / 系列封面 / 正文配图，前端的列表封面 / 正文图 /
博主头像 / 前后台 favicon。文章写入成功后会**后台预热**封面与正文前几张外链图，
这样作者自己打开时缓存通常已经热了 —— 否则第一位读者仍然是冷抓取。

安全上做了 SSRF 防护：只允许 http/https；DNS 解析后命中环回 / RFC1918 / 链路本地 /
CGNAT / 组播 / IPv6 ULA 一律 403；重定向逐跳重新校验（不交给 fetch 自动跟随）；
只接受 `image/*` 且流式限体积。刻意**不拦** RFC 保留的文档 / 基准段
（`192.0.2/24`、`198.51.100/24`、`203.0.113/24`、`198.18/15`）—— 那些段上没有内网服务，
拦了没有安全收益，却会误伤 Clash / Mihomo 的 fake-IP DNS（默认就用 `198.18.0.0/15`）。

---

## 后台

**默认使用上游原生后台**：`/admin` 由 `app/public/admin.js` + `admin.css` 承接，
与 Cloudflare 版同一套 UI、布局与样式（深色渐变侧栏 + 玻璃拟态卡片），
通过 `app.js` 的 `ensureAdminBundle()` 按需加载，首屏不为它付费。

同时，**新版 Vue 后台新增的能力已全部合并进这套原生后台**，功能上不缺项：

| Vue 版新增 | 上游原生后台 |
| --- | --- |
| 首次上手引导（五步 checklist + 进度条 + 关闭记忆） | ✅ 仪表盘自动弹出，头像菜单可重开 |
| 主题色选择器（与前台博客双向联动） | ✅ 顶栏取色按钮，共用 `localStorage['qingyu.accent']` |
| AI 写作助手（标题 / 标签 / 润色 / 翻译） | ✅ 编辑器助手条（含「标签建议」） |
| 修订历史 / 预览链接 / OG 分享图 | ✅ 编辑器内已接 |
| 订阅者分组筛选 + 单个编辑 | ✅ |
| 高级设置可视化编辑（导航 / 页脚 / 友链 / 广告位） | ✅ 含拖拽排序与「JSON」高级模式 |
| 首页标签显示白名单、导出静态站 | ✅ |
| 设置页配置 AI 助手（自定义模型 / 拉取模型列表 / 连通性测试） | ✅ 设置 → AI 助手 |
| 设置页配置对象存储 + 本机文件迁移上云 | ✅ 设置 → 存储 |

这两个设置页都是**独立保存**（页面内的「保存配置」按钮），不随顶部「保存设置」一起提交 ——
原因见上文「存储」与「AI」两节：它们的配置含密钥，必须走独立表 + 独立鉴权接口，
绝不能混进匿名可读的 `/api/settings`。两者保存后都会立即刷新运行时绑定，**无需重启**。

### Vue 后台：源码保留，默认不挂载

`admin/`（Vue 3 + Vite + Tailwind）源码保留在仓库，但 `/admin` 不再默认指向它 ——
只有显式配置 `ADMIN_SPA=1`（且 `admin/dist` 构建产物存在）时才会重新挂载，
用于对照与排障。理由：两套后台功能等价，而原生后台与上游完全同源，
上游改版时同步成本最低。

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

### 后台策略：原生后台为默认，Vue 后台按需开启

```
/admin                  → 上游原生后台（默认）
/admin                → Vue 新版后台（仅 ADMIN_SPA=1 时接管，会遮住上面那个）
/admin-legacy           → 最小回退分包（原生后台包加载失败时兜底）
```

原生后台的侧栏共 18 个入口：仪表盘 / 全部文章 / 详细统计 / 写新文章 / 标签 /
系列 / 全部评论 / 待审核 / Webmention / 媒体资源 / 音乐 / 订阅者 / 审计日志 /
健康检查 / 错误日志 / 备份 / 导入导出 / 博客设置。

> 上线前务必递增 `app/public/app.js` 的 `BLOG_VERSION`（同步脚本
> `apply-frontend-split.mjs` 也会自动递增；当前 `2.10.104`）：`admin.min.js` / `admin.min.css`
> 这些资源的缓存键就是 `?v=<BLOG_VERSION>`，版本号不变会被浏览器长缓存，
> 表现为「改完前端看不到效果」。

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
- [x] **v0.9-s** 后台补齐 P2 详细统计（与现有风格统一）：
  - **详细统计** `/admin/analytics`：范围切换（全部 / 近 30 天 / 近 7 天）、4 张汇总卡（总浏览 / 总点赞 / 总评论 / 最热文章）、单篇排行（浏览 / 点赞 / 评论 / 综合得分 + 迷你趋势折线），支持一键导出 CSV（BOM + CRLF，Excel 直接打开），点行进入该文章编辑
  - 侧栏「站点」组新增「详细统计」入口（第 16 个入口），整页骨架屏 / 空状态与其余页面一致
- [x] **v0.9-t** 后台补齐 P2 健康检查（与现有风格统一，原版 18 个入口至此全部覆盖）：
  - **健康检查** `/admin/health`：一键检查数据库（含 7 张表记录数）、缓存存储、媒体存储、备份存储、AI 服务、邮件发送，顶部显示「正常 x / 未配置 y」与最近检查时间，可随时重新检查
  - 修正原版只认 Resend 的判定：通用版默认 SMTP（`MAIL_SEND`）发信同样显示「正常」
  - 侧栏「系统」组新增「健康检查」入口（第 17 个入口）
- [x] **v0.9-u** 编辑器补齐写作体验（与现有风格统一）：
  - **AI 写作助手**：标题下方新增助手条，支持标题建议 / 标签建议 / 润色 / 翻译（中 / 英 / 日 / 韩 / 印地语），结果可一键应用、追加到末尾、复制；服务端未配置 AI 时整块自动隐藏，不影响原有功能
  - **修订历史**：顶部「修订历史」弹窗，左侧按时间列出版本（创建 / 保存 / 恢复 / 更新），右侧显示版本详情与和当前内容的行级差异（红删绿增），可一键恢复；恢复前先把当前内容存为一条修订，随时能再切回来
  - **预览链接**：顶部「预览链接」弹窗，一键生成带签名的预览地址（默认 7 天有效），支持复制与新窗口打开，发布前可直接把链接发给别人看
- [x] **v0.9-v** 高级设置可视化编辑器（与现有风格统一）：
  - **顶部导航**：不再手写 JSON，逐项填「显示文字 / 链接地址」，可拖动 ⠿ 手柄排序、↑↓ 微调、一键添加子菜单（一级下拉）、删除与「恢复默认」；文字留空仍按语言自动翻译，`i18n` 等原有字段原样保留
  - **页脚导航 / 友情链接**：同一套可视化行编辑（新增 / 删除 / 拖拽排序），保存出来的结构与前台渲染完全兼容
  - **广告位**：从 JSON 改成表单（启用开关、AdSense 客户端 ID、搜索栏下方 / 列表间隔 / 文章底部广告代码、间隔篇数），保存时自动带上历史遗留字段
  - 四个卡片右上角都保留「JSON」开关，高级用户随时切换成 JSON 直接编辑（带格式校验，格式不对不让应用）
- [x] **v0.9-w** 订阅者分组与单个编辑（与现有风格统一）：
  - **分组筛选**：名单上方新增分组 chips（带人数），可与状态统计卡叠加筛选，筛不到时自动复位；分组来自订阅者行上的字段，不引入独立分组表
  - **单个编辑**：每行新增「编辑分组」弹窗，用逗号 / 中文逗号 / 顿号分隔即可新建、改名或清空分组，保存后本地即时更新并重算分组统计，不整页刷新
  - **群发修复**：发送范围改为分组多选（不勾选 = 全部已确认），补上必填的邮件正文，修好按钮 loading 态；所选分组没有已确认订阅者时给出明确提示而不是假装成功
  - **契约登记**：`PUT /api/admin/subscribers/:id` 进入契约与接口文档（请求 / 响应 schema + 契约测试），群发请求体也补了 body 声明
- [x] **v0.9-x** 编辑器对照表补齐（相关阅读 / 单篇统计 / OG 分享图）：
  - **OG 分享图**：文章编辑器「封面」卡片下新增「分享图（OG）」区块——手动「生成分享图」按钮 + 默认勾选的「保存时自动生成」；标题 / 日期 / 标签 / 系列任一变化（指纹不同）才会重画，生成失败不阻塞文章保存。画布 1200×630，配色跟随后台主色，落款用设置里的站点名；出图后拿 `POST /api/admin/og-upload-url` 签名直传，本地磁盘与 S3/R2 同一条路
  - **相关阅读**：前台「相关阅读」本就已接，本轮把 `GET /api/posts/:id/relations` 从兼容占位收紧为强契约（关联项 / 反向链接的完整字段）
  - **单篇数据统计**：`GET /api/posts/:id/stats`（读计数）补登记进契约，`POST` 上报同时收紧（`views` / `like` 请求体 + 去重时的 `duplicated` 字段），三条兼容路由全部移出 misc
  - **契约与测试**：新增 `PostRelationItem` / `PostRelationsResponse` / `PostStatsBody` / `PostStatsResponse` / `OgUploadBody` / `OgUploadResponse` 六个 schema 与 4 条测试，测试 **151 passed / 5 skipped**
- [x] **v0.9-y** 同步原版最近三项（`c10eb07` / `daf85a8` / `c9559ef`，上游 2.10.60 → 2.10.63）：
  - **导航旧配置自动补齐**：老配置首次加载按 `navDefaultsVersion` 自动补上新增默认导航项，补过一次即记版本，用户删掉的项不会再被加回来（同步 2.10.63 时已带上）
  - **导航显示开关**：高级设置 → 功能开关里的「显示新增导航项（分类 / 历史 / 系列 / 热门）」，关掉只隐藏这四项，自定义链接不受影响（同步 2.10.63 时已带上）
  - **AI 结果不用等宽字体**：编辑器 AI 助手的结果区由 `<pre>` 改为正文样式（保留换行与滚动，跟随系统字体），不再整段等宽代码感
- [x] **v0.9-z** 导出静态站（补齐对照表最后一项「导入导出 → 静态站导出」）：
  - **服务端渲染打包**：新增 `GET /api/admin/export-static`，用与前台 SSR 完全相同的渲染器把整站打成 ZIP（零依赖 store 打包，`src/lib/zip.ts`），一次导出即可丢给任意静态托管
  - **产物**：首页、每篇文章 `posts/<id>/index.html`、归档/标签/分类/关于/友链/热门、历史/系列/留言板/订阅/作者空壳页、`404.html`、`posts.min.js`、`config.min.js`（`mode: 'static'`）、`sitemap.xml`、`feed.xml` 与一份中文部署说明
  - **路径已改相对**：页面里的站内绝对地址会按层级改成 `../`、`../../`，放进任何目录都能打开；带协议的地址（`mailto:` 等）保持原样
  - **顺带修**：站点框架原来读的是 `nav` 键，但后台保存的是 `nav_menu`，导致自定义导航在服务端渲染的页面里一直不生效，现已两个键都读
  - **测试**：新增 `tests/static-export.test.ts` 8 条（含自己解 ZIP 中央目录），测试 **159 passed / 5 skipped**
- [x] **v0.9-z2** 前台质感 + 主题色与后台联动（本轮）：
  - **主题色双向同步**：后台顶栏新增主题色选择器，与前台共用 `localStorage['qingyu.accent']` 和同一套色板（terra / indigo / bamboo / dusk）。前台 `app.js` 监听 `storage` 事件，后台换色时已打开的博客标签页会实时跟随，反之亦然；`admin/index.html` 首屏内联脚本提前应用 `data-accent`，无闪色
  - **构建漏项修复（隐蔽但影响很大）**：`scripts/build-frontend.mjs` 的压缩任务表漏了 6 项（`style.css`、`music-player.css/js`、`posts.js`、`bg-anim.js`、`config.js`），站点实际加载 `*.min.*`，导致改源码不生效。已补齐并加注释说明该列表必须穷举
  - **SSR 健壮性**：`hydrateChrome()` 补齐 nav / footer 缺失字段，`activeOf()` 容忍 `active` 传字符串，修掉导航高亮静默失效的隐患（测试 168 passed / 5 skipped）
  - **对比度**：前后台 8 套色板（4 主色 × 明暗）全部通过 WCAG AA，校验脚本 `npm run check:contrast` 现同时覆盖后台色板
  - **前台质感**：顶栏滚动浮起（分隔线 + 阴影 + 玻璃模糊）、换肤 320ms 过渡（仅切换瞬间生效，不拖慢常态 hover）、列表错峰入场，`prefers-reduced-motion` 全量降级
  - **踩坑记录**：`app.min.js?v=2.10.84` 版本号不变会被浏览器长缓存，改完前端务必强刷或调版本号
- [x] **v0.9-z3** 后台回归上游原生 UI + 功能补齐（本轮）：
  - **`/admin` 回到上游原生后台**：`src/app.ts` 不再默认挂载 Vue SPA，请求落到兜底后由上游 worker 返回外壳、`app.js` 的 `ensureAdminBundle()` 加载 `admin.min.js` —— 保持上游的 UI / 布局 / 样式；Vue 后台源码保留，改由 `ADMIN_SPA=1` 显式开启
  - **补齐 Vue 版新增能力**（原生后台内实现，零框架依赖）：首次上手引导（五步 checklist + 进度条 + 关闭记忆 + 头像菜单重开）、顶栏主题色选择器（复用 `app.js` 的色板与 `localStorage['qingyu.accent']`，与前台标签页双向联动）、编辑器 AI「标签建议」按钮
  - **高级设置对齐**：页脚导航 / 友链新增拖拽排序（与顶部导航同一套手势，拖拽前先收回输入框的值）；顶部导航 / 页脚导航 / 友链 / 广告位新增「JSON」高级模式（应用前做形状校验，非法 JSON 不改动任何数据）
  - **i18n**：新增 30 条文案，五语言包 + 内置中文兜底同步；`I18N_VER` 递增
  - **缓存版本统一提升到 `2.10.93`**（`app.js` 的 `BLOG_VERSION`、`sw.js` 的 `CACHE_VERSION`、`index.html` 的全部 `?v=`），否则 `admin.min.js` 改完看不到效果
- [x] **v0.9-z4** 设置页独立配置闭环 + 审计覆盖 + 后台暗色可读性修复（本轮）：
  - **设置 → AI 助手**：自定义 OpenAI 兼容 Base URL / API Key / 模型，支持**拉取上游 `/v1/models` 并点选**、一次真实连通性测试；配置落独立表 `ai_config`，通过动态绑定**保存即生效、无需重启**，且优先于环境变量。密钥只单向进入服务端，读接口只回传打码值
  - **设置 → 存储**：本机磁盘 / S3 兼容对象存储二选一，可视化填端点与桶，「用表单里的候选值真签一次 SigV4」的连通性测试，以及**逐对象**迁移上云（确认对象已进桶才改写库内引用，杜绝「库里指向云、云上没文件」）。配置不完整时自动降级回本机磁盘；库内根相对地址的老文件由常驻本地路由继续服务，切云**不会 404**
  - **操作日志（审计）**：覆盖 16 类动作（文章增删改 / 媒体删除 / 标签改名删除 / 设置与 AI 更新 / 登录与登出 / 备份增删恢复 / 清空日志），默认 5000 条 90 天自动裁剪（`AUDIT_MAX_ROWS` / `AUDIT_RETENTION_DAYS`）。日志里的 IP 依赖 `TRUST_PROXY`：**直连暴露请设 `TRUST_PROXY=0`**，否则可伪造 `X-Forwarded-For` 绕过登录限流
  - **后台暗色可读性修复**：「设置 → 功能开关 → 首页标签」的胶囊在暗色模式下，未选中态因引用了**从未定义的** `--ab-bg-soft` 而回退成近白底（对比仅 **1.16:1**，看不见字），选中态白字压在浅色主色上（**2.63:1**，又白又亮）。现改为 `--ab-hover` 底色 + 「弱主色底 / 主色字 / 主色描边 / ✓」的选中态，**4 套主题色 × 明暗共 8 组合实测全部 ≥4.5:1**
  - **其它**：写接口契约容忍度对齐上游（`normalizePost()` 能接受的 JSON 值不再被契约层拒掉）、SSR 站点框架补全、文章列表索引迁移 `0038`
  - **测试 200 passed / 5 skipped**；缓存版本提升到 `2.10.104`
- [x] **v0.9-z5** 一键脚本新手友好化（本轮，只改 `deploy/install.sh`，应用代码零改动）：
  - **安装向导**：全新安装且不带参数时先走一遍问答（访问方式 → 域名 → 数据库 → 定时备份 → 邮件），
    每题都有推荐答案、直接回车即可；`b` 回退上一题、确认页可跳回改任意一项、`q` 放弃；
    域名会自动剥掉误粘的 `http://` 与路径，非法输入提示重填，三次都错自动改回 IP + 端口
  - **可配置项与配置档**：新增 `--config` / `--save-config` / `--dry-run` / `--timezone` /
    `--smtp-host|port|user|pass|from` / `--no-autobackup` / `--skip-preflight` / `--no-doctor`；
    配置档是 `KEY=VALUE` 文件，可版本化复用，**命令行参数优先于配置档**
  - **安装后引导 + 自动体检**：装完自动跑一遍 `doctor`，并给出「接下来三件事」
    （打开站点 → 用安装密钥设管理员密码 → 把 `SITE_URL` 改成真实域名）
  - **断点续跑 / 幂等**：安装拆成 6 步并记录进度，中途失败**原样重跑即可续跑**，
    已完成步骤自动跳过；`--reset` 从头执行；**已装完的目录再跑 `install` 自动转 `upgrade`**；
    `upgrade` 会先列出版本差异（含新增提交数）再备份重建
  - **顺手补的坑**：新增 `.gitattributes` 把 `*.sh` 钉成 LF —— Windows 上
    `core.autocrlf=true` 检出带 CR 的脚本，到了 Linux 容器里第一行
    `set -euo pipefail\r` 就会报 `invalid option name` 直接退出；补齐 `--repo` / `--no-mirror`
    等遗漏的用法说明；新增 `tests/install-script.test.ts` 护栏测试
    （语法、`--help` 与实际解析的选项必须一一对应、新增能力的关键符号仍在）
  - **测试 206 passed / 6 skipped**（17 个文件）；本轮未改动任何应用代码，缓存版本不变
- [x] **v0.9-z6** 首屏加载优化：外链图片本地缓存反代（本轮）：
  - **定位（先排除服务端）**：首页 SSR TTFB 实测 **9ms**、`/api/posts` 7ms、`/api/settings` 5ms、
    文章页 48ms，本地静态资源 4~23ms（CSS 19KB gz、i18n 19KB gz），CSS 内无外部字体。
    **服务端每一条路由都在 50ms 以内，完全不是瓶颈。** 慢的是浏览器直连的境外图床：
    封面 `images.2024921.xyz`（CF 西雅图节点）实测 TLS 握手 **0.39~0.54s**、TTFB **0.68~0.87s**、
    总计 **0.78~1.40s**，而图片本体只有 1.9KB —— 跨洋建连延迟，不是带宽
  - **反代 `/api/img`**：渲染期把跨域 http(s) 图片改写成同源 `/api/img?url=…`，
    服务端抓取一次并落盘到 `DATA_DIR/cache/img`，之后返回同源 immutable 字节。
    SSR（列表封面 / 系列封面 / 正文配图）与前端（列表封面 / 正文图 / 博主头像 / 前后台 favicon）
    共 7 个渲染点全部接入；前端改动走 `scripts/apply-frontend-split.mjs` 注入，
    不会被上游同步覆盖，且两套规则由 `tests/image-proxy.test.ts` 交叉断言防漂移
  - **写路径预热**：反代只有「第一次抓、之后走缓存」两段，新封面是全新 URL，
    等读者触发的话第一位读者仍是冷抓取 —— 文章 `POST/PUT /api/posts` 成功后后台预热
    封面与正文前几张外链图（读的是响应 clone，原响应原样返回，不影响契约校验）
  - **SSRF 防护**：只允许 http/https；DNS 解析后命中环回 / RFC1918 / 链路本地 / CGNAT /
    组播 / IPv6 ULA 与链路本地一律 403；重定向**逐跳重新校验**（不交给 fetch 自动跟随）；
    只接受 `image/*` 且流式限体积。刻意**不拦** RFC 保留的文档 / 基准段
    （`192.0.2/24`、`198.51.100/24`、`203.0.113/24`、`198.18/15`）—— 那些段上没有内网服务，
    拦了没有安全收益却会误伤 fake-IP DNS（实测容器内图床被解析成 `198.18.2.245`，
    一拦就把整个反代打成 403，而容器其实能直连图床）
  - **可关**：`IMAGE_PROXY=0` 时 `/api/img` 直��� 302 回原始地址，行为与改动前完全一致；
    `IMAGE_PROXY_MAX_MB`（单张上限，默认 15）、`IMAGE_PROXY_CACHE_MB`（总容量，默认 512，
    超出按最久未访问淘汰）
  - **收起的误判**：首页有两处 `style.min.css` 一度被当成重复样式表，实际第二处在
    `<noscript>` 里，是给禁用 JS 访客的降级引用，不是冗余
  - **测试 232 passed / 6 skipped**（18 个文件，新增 `tests/image-proxy.test.ts` 26 项）；
    缓存版本提升到 `2.10.105`
- [x] **v0.3** 路径级契约覆盖完成（60 条路径；兼容接口响应字段将逐步收紧）
- [x] **v0.3.1-a** Redis / Valkey 可选限流（配置 `REDIS_URL` 即启用）
- [x] **v0.3.1-b** PostgreSQL 运行时适配（配置 `DATABASE_URL` 即切换）
- [x] **v0.4** Fly.io / Render / Railway 模板、多架构 GHCR 镜像、SBOM 与 cosign 签名
- [x] **v0.5-a** Helm Chart、镜像签名与 SBOM
- [x] **v0.5-b** PostgreSQL schema 与 SQLite → PostgreSQL 数据迁移工具
- [x] **v0.5-c** PostgreSQL 一键部署（交互式三选一 / `--db postgres` / `--database-url`）

## 许可证

MIT，与上游保持一致。业务代码版权归原项目作者，见 [LICENSE](LICENSE)。
