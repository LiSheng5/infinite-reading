#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/serve.py —— 「无限阅读」便携静态服务（Python 3，零依赖）

被根目录的启动.bat 调用（机器上有 Python 时优先用它）。
服务目录是构建产物 dist/site（阶段 1 起源码经 Vite 构建；先 npm run build）。
为什么不用 `python -m http.server`：它没有任何排除能力，服务仓库根会把
sidecar/data/（本地服务的 token、Resend API Key、SQLite 库）直接端出去。
这里只监听 127.0.0.1，且对两类敏感路径统一拒绝（纵深防御；正常情况下
它们根本不在 dist/site 里）：
  - sidecar/data/   本地服务的凭证与数据
  - .git/           仓库内部

用法：python tools/serve.py [端口=8000]
"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'dist', 'site')
BLOCKED = ('sidecar/data', '.git')
DEFAULT_PORT = 8000


def is_blocked(url_path):
    """URL 路径归一化后命中 BLOCKED 前缀（大小写不敏感，吃掉 . 与 .. 段）。"""
    p = url_path.split('?', 1)[0].split('#', 1)[0].replace('\\', '/')
    stack = []
    for seg in p.split('/'):
        if seg in ('', '.'):
            continue
        if seg == '..':
            if stack:
                stack.pop()
            continue
        stack.append(seg.lower())
    rel = '/'.join(stack)
    for b in BLOCKED:
        if rel == b or rel.startswith(b + '/'):
            return True
    return False


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def send_head(self):
        if is_blocked(self.path):
            self.send_error(403, 'Forbidden')
            return None
        return super().send_head()


def main():
    if not os.path.isfile(os.path.join(ROOT, 'index.html')):
        print('没找到 ' + ROOT)
        print('先构建站点：npm run build（或 npm run build:site）')
        sys.exit(1)
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            p = int(sys.argv[1])
            if 0 < p < 65536:
                port = p
        except ValueError:
            pass
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print('Infinite Reading  ->  http://localhost:%d/' % port)
    print('Root: ' + ROOT)
    print('Serving loopback only; sidecar/data and .git are refused.')
    print('Press Ctrl+C to stop.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
