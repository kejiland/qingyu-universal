# ============================================================
# 轻语博客 · 自托管通用版 镜像（多阶段构建）
# ------------------------------------------------------------
#   1) admin-build  后台 SPA（Vue + Vite + Tailwind）
#   2) server-build 服务端 TypeScript
#   3) 运行阶段      只带编译产物与生产依赖
# 构建：docker build -f deploy/Dockerfile -t qingyu-universal .
# ============================================================
FROM node:24-alpine AS admin-build
# 国内加速（--mirror）时由 compose 注入 npmmirror 源；留空走官方源
ARG NPM_REGISTRY=""
WORKDIR /app/admin

COPY admin/package.json admin/package-lock.json ./
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
 && npm ci --no-audit --no-fund

COPY admin/ ./
# 后台的类型来自服务端契约（@api-types 别名指向 ../generated）
COPY generated/ /app/generated/
RUN npm run build

# ------------------------------------------------------------
FROM node:24-alpine AS server-build
# 国内加速（--mirror）时由 compose 注入 npmmirror 源；留空走官方源
ARG NPM_REGISTRY=""

# 构建版本（git 短 SHA），由 compose 的 build.args 注入。
# 打进镜像后由 /healthz 与启动横幅输出 —— 用于确认「升级到底生效没有」。
ARG BUILD_REVISION=""
ENV BUILD_REVISION=$BUILD_REVISION
WORKDIR /app

COPY package.json package-lock.json ./
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
 && npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
# app/public 的启动器与压缩产物由 frontend:build 生成，避免镜像里出现陈旧的 app.min.js
COPY app ./app
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund

# ------------------------------------------------------------
FROM node:24-alpine
# 运行阶段还要装 postgresql-client（PostgreSQL 模式首次建表用），
# 而 Alpine 官方源 dl-cdn.alpinelinux.org 在部分网络下不可达。
# 传 ALPINE_MIRROR（如 https://mirrors.aliyun.com/alpine）即可换源；留空走官方源。
ARG ALPINE_MIRROR=""
WORKDIR /app

# 非 root 运行：直接使用镜像内置的 node 用户（uid/gid 1000）
# 运行阶段也要声明 —— ARG/ENV 不跨 FROM 阶段继承
ARG BUILD_REVISION=""
ENV BUILD_REVISION=$BUILD_REVISION \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    ADMIN_DIST_DIR=/app/admin/dist

COPY --from=server-build /app/node_modules ./node_modules
COPY --from=server-build /app/dist ./dist
COPY --from=admin-build /app/admin/dist ./admin/dist
COPY package.json ./
# 使用 server-build 阶段生成的 app（含 boot / legacy 分包的最新压缩产物）
COPY --from=server-build /app/app ./app
# 运行时首次启动要用它建表（PostgreSQL 模式）；不打进镜像会在容器里找不到文件
COPY deploy/postgres/schema.sql ./deploy/postgres/schema.sql

RUN if [ -n "$ALPINE_MIRROR" ]; then \
      sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${ALPINE_MIRROR%/}#g" /etc/apk/repositories; \
    fi \
 && apk add --no-cache postgresql-client \
 && mkdir -p /data \
 && chown -R node:node /data

USER node
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node dist/cli/health.js || exit 1

CMD ["node", "dist/index.js"]