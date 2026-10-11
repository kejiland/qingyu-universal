# 多云与生产部署

本文档覆盖数据库选择，以及 Docker Compose 之外的生产部署方式。

## 数据库选择

三种选择，靠 `.env` 里的配置决定：

| 选择 | 配置 | 适用场景 |
| --- | --- | --- |
| SQLite（默认） | 不设置 `DATABASE_URL` | 单机博客，备份就是一个文件 |
| 内置 PostgreSQL | `COMPOSE_PROFILES=postgres` + `POSTGRES_*` | 多进程 / 高并发 |
| 自己的云数据库 | `DATABASE_URL=postgres://用户:密码@主机:5432/库名` | 阿里云 RDS / 腾讯云 / Supabase 等托管服务 |

内置 PostgreSQL 不占用宿主机 5432，也不暴露到公网。
SQLite → PostgreSQL 的数据迁移见 [PostgreSQL 迁移](POSTGRES.md)。

用 Compose 部署时，把 `postgres` 加进 `COMPOSE_PROFILES` 并填好
`DATABASE_URL`、`POSTGRES_*` 即可（`.env.example` 里有现成模板）：

```bash
docker compose --profile postgres up -d
```

## 多架构镜像

推送到 `v*` 标签时，GitHub Actions 会：

1. 构建 `linux/amd64` 与 `linux/arm64`
2. 推送到 GitHub Container Registry
3. 生成 SPDX JSON SBOM
4. 使用 cosign keyless 签名镜像
5. 创建带 SBOM 的 GitHub Release

```bash
git tag v0.3.0
git push origin v0.3.0
```

默认镜像地址：

```text
ghcr.io/kejiland/qingyu-universal:v0.3.0
```

## Fly.io

```bash
fly launch --no-deploy --copy-config --config deploy/fly.toml
fly volumes create qingyu_data --size 1 --region sin
fly secrets set \
  SITE_URL=https://你的应用.fly.dev \
  BLOG_ADMIN_SETUP_KEY=你的初始化密钥 \
  BLOG_WRITE_TOKEN=你的写入令牌
fly deploy --config deploy/fly.toml
```

Fly 的 `qingyu_data` 卷会挂载到 `/data`，SQLite 与上传文件会持久化。

## Render

在 Render 控制台选择 **New > Blueprint**，连接仓库后使用：

```text
deploy/render.yaml
```

Blueprint 会创建 Web Service、1 GB 持久磁盘与随机初始化密钥。

## Railway

Railway 读取：

```text
deploy/railway.json
```

需要手动添加持久卷到 `/data`，并设置：

```text
SITE_URL
BLOG_ADMIN_SETUP_KEY
BLOG_WRITE_TOKEN
DATA_DIR=/data
```

## Kubernetes / Helm

```bash
helm install qingyu deploy/helm/qingyu-universal \
  --set image.tag=v0.3.0 \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=blog.example.com \
  --set secrets.adminSetupKey=你的初始化密钥 \
  --set secrets.writeToken=你的写入令牌
```

SQLite 版本默认 `replicaCount: 1`，PVC 使用 `ReadWriteOnce`。多实例部署需要 PostgreSQL 与 Redis，
Chart 不内置数据库实例，用 `env.DATABASE_URL` / `env.REDIS_URL` 指向外部托管服务即可。

## Redis / Valkey

默认使用 SQLite 内部的 KV 表。要启用 Redis/Valkey：

```env
REDIS_URL=redis://redis:6379
```

Compose 内置可选配置：

```bash
docker compose --profile redis up -d
```

Redis 用于限流、点赞去重、AI 额度和管理员会话。Redis 短暂不可用时会自动回退 SQLite KV，站点不会直接不可用。

## 数据备份

Compose：

```bash
# 先备份再重启；备份是 data/backups 下的快照文件
docker compose exec app node dist/cli/backup.js /data/backups
```

> 回滚版本需要靠 git 自行回退到上一个提交后重新 `docker compose up -d --build`。
> 表结构迁移是幂等的，回退代码后旧迁移不会重复执行。

Kubernetes：

```bash
kubectl exec deploy/qingyu -- node dist/cli/backup.js /data/backups
```