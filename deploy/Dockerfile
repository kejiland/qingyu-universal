# ============================================================
# 轻语博客 · 自托管通用版 镜像（多阶段构建）
# ------------------------------------------------------------
#   1) admin-build  后台 SPA（Vue + Vite + Tailwind）
#   2) server-build 服务端 TypeScript
#   3) 运行阶段      只带编译产物与生产依赖
# 构建：docker build -f deploy/Dockerfile -t qingyu-universal .
# ============================================================
FROM node:24-alpine AS admin-build
WORKDIR /app/admin

COPY admin/package.json admin/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY admin/ ./
# 后台的类型来自服务端契约（@api-types 别名指向 ../generated）
COPY generated/ /app/generated/
RUN npm run build

# ------------------------------------------------------------
FROM node:24-alpine AS server-build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund

# ------------------------------------------------------------
FROM node:24-alpine
WORKDIR /app

# 非 root 运行：直接使用镜像内置的 node 用户（uid/gid 1000）
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    ADMIN_DIST_DIR=/app/admin/dist

COPY --from=server-build /app/node_modules ./node_modules
COPY --from=server-build /app/dist ./dist
COPY --from=admin-build /app/admin/dist ./admin/dist
COPY package.json ./
COPY app ./app

RUN mkdir -p /data \
 && chown -R node:node /data

USER node
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node dist/cli/health.js || exit 1

CMD ["node", "dist/index.js"]