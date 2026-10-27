# 无限阅读 · 自托管镜像（开源路线图 W3 / L5：Docker / NAS）
#
# 阶段 1 起源码经 Vite 构建，镜像改两段式：先构建 dist/site，再由 nginx 直接托管产物。
#   docker build -t infinite-reading .
#   docker run --rm -p 8080:80 infinite-reading      # → http://localhost:8080/
#
# 运行段依旧零依赖、零状态（不装 node、不挂卷）；构建段只在 docker build 时跑一次。
# 构建上下文靠 .dockerignore 瘦身（docs / eval / tools / .git 不进镜像）。

FROM node:24-alpine AS build
WORKDIR /app

# playwright 是测试工具，装依赖时别把浏览器拉进构建上下文
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# 只出多文件站点产物（单文件 dist/ir.html 是给用户手发的，不进镜像）
RUN npm run build:site

FROM nginx:1.27-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# 直接托管构建产物：index.html / assets（hash 文件名）/ icons / manifest.webmanifest / sw.js
COPY --from=build /app/dist/site /usr/share/nginx/html
COPY LICENSE README.md /usr/share/nginx/html/

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

EXPOSE 80
