#!/bin/bash
# 津电云 · 一键本地启动
# 双击本文件即可在本地启动静态服务并在默认浏览器中打开页面
cd "$(dirname "$0")" || exit 1

PORT=8080
# 若 8080 端口已被占用，自动切换至 8081
if lsof -i :$PORT >/dev/null 2>&1; then
  PORT=8081
fi

echo "正在启动津电云本地服务 (http://127.0.0.1:$PORT)..."
open "http://127.0.0.1:$PORT" &
exec python3 -m http.server $PORT
