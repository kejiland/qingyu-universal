# PostgreSQL 迁移

当前状态：

- [x] PostgreSQL schema：`deploy/postgres/schema.sql`
- [x] SQLite → PostgreSQL 数据迁移 CLI
- [x] 行数校验、保留原始 SQLite 数据库
- [ ] 运行时 PostgreSQL 适配器（下一阶段）

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

## 安全规则

1. 迁移脚本只读取 SQLite，不会修改源库。
2. 目标库导入前必须备份。
3. `--truncate` 会清空目标业务表，生产环境确认后再使用。
4. 导入完成后逐表校验 PostgreSQL 行数不少于 SQLite 行数。
5. 当前版本的运行服务仍使用 SQLite；完成运行时适配器后再切换流量。