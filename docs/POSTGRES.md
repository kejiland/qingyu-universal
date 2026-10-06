# PostgreSQL 迁移

当前状态：

- [x] PostgreSQL schema：`deploy/postgres/schema.sql`
- [x] SQLite → PostgreSQL 数据迁移 CLI
- [x] 行数校验、保留原始 SQLite 数据库
- [x] 运行时 PostgreSQL 适配器
- [x] 一键部署选择（交互式三选一 / `--db postgres` / `--database-url`）
- [x] 真实数据库集成测试（`TEST_DATABASE_URL` 存在时执行）

## 一键部署时选择 PostgreSQL

部署脚本会直接把数据库一起装好，三种方式任选：

**方式一：交互式（最省事）** —— 直接运行脚本，它会问你选哪个：

```bash
curl -fsSL https://raw.githubusercontent.com/kejiland/qingyu-universal/main/deploy/install.sh | bash
```

```text
==> 请选择数据库
    1) SQLite                  （推荐；零依赖，备份就是一个文件）
    2) PostgreSQL · 内置容器    （脚本自动装好，多进程/高并发更稳）
    3) PostgreSQL · 我有自己的库 （阿里云 RDS / 腾讯云 / Supabase…）
  选择 [1]:
```

一路回车就是 SQLite，输入 `2` 就是内置 PostgreSQL。

**方式二：命令行参数**

```bash
./deploy/install.sh install --db sqlite      # 默认
./deploy/install.sh install --db postgres    # 脚本内置的 PostgreSQL 容器
./deploy/install.sh install --db postgres --domain blog.example.com
```

**方式三：接你自己的云数据库**

```bash
./deploy/install.sh install \
  --database-url 'postgres://用户名:密码@主机:5432/库名'
```

内置 PostgreSQL 的几点说明：

- 端口只在容器网络内开放，**不占用宿主机 5432**，也不暴露到公网。
- 数据放在独立的 `postgres-data` 卷里，和 SQLite 的 `qingyu-data` 互不干扰。
- `./deploy/install.sh backup` / `restore` 对 PostgreSQL 走 `pg_dump` / `pg_restore`，与 SQLite 同一套命令。
- `./deploy/install.sh info` 会显示当前用的是 SQLite、内置 PG 还是外部 PG。

已有 SQLite 站点想切到 PostgreSQL，见下方「迁移数据」。

## Schema

```text
deploy/postgres/schema.sql
```

它等价覆盖 SQLite migrations 0001-0035 的业务表，包括：

- 文章、评论、统计、媒体、音乐、设置、订阅者
- 审计日志、错误日志、Webmention、备份
- `_migrations` 与 `_kv_store`
- 删除文章时自动清理评论的 PostgreSQL Trigger
- `posts.search_vector` 生成列与 GIN 全文索引

## 迁移数据

先在 staging 或空 PostgreSQL 数据库执行：

```bash
DATABASE_URL=postgres://user:pass@host:5432/qingyu \
npm run db:migrate:postgres -- \
  --sqlite ./data/qingyu.db \
  --truncate
```

参数：

| 参数 | 说明 |
| --- | --- |
| `--sqlite <path>` | SQLite 文件路径 |
| `--url <url>` | PostgreSQL 连接串，默认读取 `DATABASE_URL` |
| `--schema <path>` | schema 文件路径 |
| `--truncate` | 导入前清空目标表，只用于空库或测试库 |
| `--dry-run` | 只统计将迁移的行数，不写入 |

## 运行时切换

默认仍使用 SQLite。配置后即可切换：

```env
DATABASE_URL=postgres://user:pass@host:5432/qingyu
```

重启服务后：

- `/healthz` 的 `database` 返回 `postgres`
- 首次启动自动应用 PostgreSQL schema
- 评论、文章、媒体、搜索、限流、备份等使用 PostgreSQL
- 未配置 `DATABASE_URL` 时继续使用 SQLite

PostgreSQL 容器镜像已包含 `pg_dump` 与 `pg_restore`，部署脚本的整库备份/恢复同样支持 PostgreSQL。

## 安全规则

1. 迁移脚本只读取 SQLite，不会修改源库。
2. 目标库导入前必须备份。
3. `--truncate` 会清空目标业务表，生产环境确认后再使用。
4. 导入完成后逐表校验 PostgreSQL 行数不少于 SQLite 行数。
5. 切换前先执行迁移工具并核对行数；切换后保留 SQLite 原库作为回滚。