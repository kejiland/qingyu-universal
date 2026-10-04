# ============================================================
# 轻语博客 · 自托管通用版 镜像
# ------------------------------------------------------------
# 无构建步骤、无第三方运行时依赖：Node 内置 node:sqlite 与 WebCrypto。
# 构建：docker build -f deploy/Dockerfile -t qingyu-universal .
# ============================================================
FROM node:24-alpine

# 非 root 运行；uid/gid 固定 1000，便于宿主目录直接挂载。
RUN addgroup -g 1000 -S qingyu \
 && adduser -u 1000 -S qingyu -G qingyu

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY scripts ./scripts
COPY app ./app

RUN mkdir -p /data \
 && chown -R qingyu:qingyu /data /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data

USER qingyu
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node scripts/health.js || exit 1

CMD ["node", "server/index.js"]