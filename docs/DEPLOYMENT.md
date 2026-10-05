# 多云与生产部署

本文档覆盖 Docker Compose 之外的生产部署方式。

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

SQLite 版本默认 `replicaCount: 1`，PVC 使用 `ReadWriteOnce`。多实例部署需要 PostgreSQL 与 Redis，当前 Helm Chart 尚未启用 PostgreSQL 适配。

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
./deploy/install.sh backup
./deploy/install.sh restore <快照文件>
```

Kubernetes：

```bash
kubectl exec deploy/qingyu -- node dist/cli/backup.js /data/backups
```