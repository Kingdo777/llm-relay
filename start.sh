#!/usr/bin/env bash
# 后台启动 llm-relay（Next.js 生产模式）
# 监听 0.0.0.0:3001，日志输出到 data/logs/app.log
set -euo pipefail

# 切到脚本所在目录，保证任意位置调用都一致
cd "$(dirname "$0")"

ROOT="$(pwd)"
PORT="${PORT:-3001}"
HOST="0.0.0.0"
LOG_DIR="$ROOT/data/logs"
LOG_FILE="$LOG_DIR/app.log"
PID_FILE="$ROOT/.run.pid"

mkdir -p "$LOG_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 22。" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "未找到 npm，请先安装 Node.js 22（包含 npm）。" >&2
  exit 1
fi
if ! command -v sha256sum >/dev/null 2>&1; then
  echo "未找到 sha256sum，请先安装 coreutils。" >&2
  exit 1
fi
if [[ ! -f package.json ]]; then
  echo "缺少 package.json，无法启动。" >&2
  exit 1
fi
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || ((PORT < 1 || PORT > 65535)); then
  echo "无效端口: $PORT（应为 1-65535）" >&2
  exit 1
fi

# 已有实例运行则先执行 stop.sh 再启动
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "检测到已有实例在运行，先执行 stop.sh 进行重启..."
  ./stop.sh
fi
# PID 文件残留但进程已死，清理掉
rm -f "$PID_FILE"

# 在耗时的依赖安装和构建前检查端口，避免最后启动时才发现冲突。
if ! node -e '
  const net = require("node:net");
  const server = net.createServer();
  server.once("error", () => process.exit(1));
  server.listen({ host: process.argv[1], port: Number(process.argv[2]), exclusive: true }, () => {
    server.close(() => process.exit(0));
  });
' "$HOST" "$PORT"; then
  echo "端口 $PORT 已被占用，无法启动 llm-relay。" >&2
  exit 1
fi

# 默认仅在源码、配置或依赖清单变化时重新 build。
# LLM_RELAY_SKIP_BUILD=1 无条件跳过；LLM_RELAY_FORCE_BUILD=1 无条件重建。
if [[ "${LLM_RELAY_SKIP_BUILD:-0}" == "1" ]]; then
  echo "检测到 LLM_RELAY_SKIP_BUILD=1，跳过构建，直接启动..."
else
  BUILD_STAMP="$ROOT/.next/.llm-relay-build-hash"
  BUILD_HASH="$({
    for path in app lib public; do
      [[ -d "$path" ]] && find "$path" -type f -print0
    done
    for path in package.json package-lock.json next.config.ts tsconfig.json; do
      [[ -f "$path" ]] && printf '%s\0' "$path"
    done
  } | sort -z | xargs -0 sha256sum | sha256sum | cut -d ' ' -f 1)"
  BUILT_HASH=""
  if [[ -f "$BUILD_STAMP" ]]; then
    BUILT_HASH="$(cat "$BUILD_STAMP")"
  fi

  if [[ "${LLM_RELAY_FORCE_BUILD:-0}" != "1" && -f "$ROOT/.next/BUILD_ID" && "$BUILT_HASH" == "$BUILD_HASH" ]]; then
    echo "源码和配置未变化，跳过构建。"
  else
    echo "执行构建..."
    if ! npm run build >>"$LOG_FILE" 2>&1; then
      echo "构建失败，请查看日志: $LOG_FILE" >&2
      exit 1
    fi
    printf '%s\n' "$BUILD_HASH" >"$BUILD_STAMP"
  fi
fi

echo "启动中... 日志: $LOG_FILE"
echo "监听: http://$HOST:$PORT  (PID 写入 $PID_FILE)"

# setsid 让进程在独立进程组里运行，stop 时可对整个进程组发信号，
# 避免 kill 父进程(npm)后留下子进程(next-server)变孤儿继续占端口
NODE_TLS_REJECT_UNAUTHORIZED=0 setsid npm run start -- -H "$HOST" -p "$PORT" >>"$LOG_FILE" 2>&1 &
APP_PID=$!
# 进程组 ID = 组长的 PID，即 $APP_PID
echo "$APP_PID" >"$PID_FILE"

sleep 1
if kill -0 "$APP_PID" 2>/dev/null; then
  echo "已启动（PID $APP_PID）"
  echo "查看日志: tail -f $LOG_FILE"
else
  echo "启动失败，请查看日志: $LOG_FILE"
  rm -f "$PID_FILE"
  exit 1
fi
