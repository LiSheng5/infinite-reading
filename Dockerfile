# 无限阅读 · 自托管镜像（开源路线图 W3 / L5：Docker / NAS）
#
# 纯静态，nginx 直接托管运行文件：不装依赖、不构建、镜像很小。
#   docker build -t infinite-reading .
#   docker run --rm -p 8080:80 infinite-reading      # → http://localhost:8080/
#   docker run --rm -p 8080:80 infinite-reading      # 想直接看演示：http://localhost:8080/?demo=1
#
# 只拷运行需要的文件（docs / eval / tools 属于开发资料，留在仓库里就够了）。

FROM nginx:1.27-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

COPY index.html manifest.webmanifest sw.js /usr/share/nginx/html/
COPY css /usr/share/nginx/html/css
COPY js /usr/share/nginx/html/js
COPY icons /usr/share/nginx/html/icons
COPY LICENSE README.md /usr/share/nginx/html/

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

EXPOSE 80
