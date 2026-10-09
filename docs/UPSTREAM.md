# 上游代码同步说明

本项目**不重写** upstream 的业务逻辑，而是复用 [qingyu-blog](https://github.com/kejiland/qingyu-blog)
的代码，并用一层同形绑定把它运行在原生 Node 上。本文档说明边界、改动清单与同步流程。

- 上游基线：`kejiland/qingyu-blog` @ `ad3bfb95bdb5bf5783c66db67bbd108c6f33d71c`
- 同步日期：2026-10-04
- 增量同步：2026-10-06 已把基线之后的 3 个提交（`c10eb07` / `daf85a8` / `c9559ef`）人工合入，
  对应原版 2.10.60 → 2.10.63 的「导航默认项自动补齐」「新增导航项显示开关」「AI 结果不按代码块显示」
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

## 二、改动清单（全部在 `scripts/apply-upstream-adapters.mjs` 中，幂等）

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

原生后台的自有增量（**同步时最容易被冲掉，务必核对**）：`/admin` 默认使用上游原生后台
（`app/public/admin.js` + `admin.css`），本项目在它内部补齐了 Vue 新版后台独有的能力。
`cp -a /tmp/upstream/public app/public` 会整文件覆盖这两个文件，因此
`npm run sync:upstream` 结束时会跑一次自检并在报告中列出缺失项。增量清单与判定标记：

| 功能 | 标记（admin.js） | 样式标记（admin.css） |
| --- | --- | --- |
| 新站上手引导 | `WELCOME_DISMISS_KEY` | `.ab-welcome-card` |
| 顶栏主题色选择器（与前台联动） | `abAccentToggle` / `accentSwatchesMarkup` | 复用前台的 `.accent-*` |
| 编辑器 AI「标签建议」 | `data-abai="tags"` | — |
| 页脚 / 友链拖拽排序 | `ab-link-drag` | `.ab-link-drag` |
| 高级设置 JSON 模式 | `data-sjson` / `openJsonModal` | — |
| 设置页「AI 助手」配置 | `bindAiSettings` / `ab-ai-model` | `.ab-ai-model` |
| 设置页「存储」配置（媒体/音乐放哪） | `bindStorageSettings` / `abStMode` | 复用既有 `.ab-field` 等 |
| 侧边栏切页保留滚动位置 | `navScrollTop` | — |
| 媒体复制链接补全为完整地址 | `function absUrl` | — |
| 对应文案 | `admin.welcome.*` / `admin.settings.json*` / `admin.settings.ai*` / `admin.settings.storage*` | 见 `locales/*.json` |

后端的自有增量（`src/` 与 `app/migrations/` 不受上游同步影响，但同样纳入自检，
防止误删或手工回滚）：`ai_config` / `storage_config` 两张表、
`src/bindings/{ai-config,storage-config,object-ops,object-migrate}.ts`、
`src/api/{admin-auth,audit}.ts` 与 `src/api/routes/{admin-ai,admin-storage}.ts`、
`worker-env.ts` 里 `env.AI` 与 `env.R2_*` / `env.LOCAL_STORAGE` 的动态 getter。
`npm run sync:upstream` 的 `checkAdminIncrements()` 会逐项核对这些标记。

> Vue 后台（`admin/`）**不再默认挂载**：`/admin` 交给上游原生后台，
> 只有 `ADMIN_SPA=1` 时 `src/app.ts` 才重新挂载 Vue SPA。
> 因此同步上游后要确认的是「原生后台的增量还在」，而不是「admin/dist 还在」。

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
