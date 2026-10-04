# ============================================================
# 轻语博客 · 自托管通用版 镜像（多阶段构建）
# ------------------------------------------------------------
# 构建阶段：安装依赖 + TypeScript 编译 + 裁剪 devDependencies
# 运行阶段：只带编译产物与生产依赖
# 构建：docker build -f deploy/Dockerfile -t qingyu-universal .
# ============================================================
FROM node:24-alpine AS build
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
    DATA_DIR=/data

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
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