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
if [[ ! -f package.json || ! -f package-lock.json ]]; then
  echo "缺少 package.json 或 package-lock.json，无法安装依赖。" >&2
  exit 1
fi

# 已有实例运行则先执行 stop.sh 再启动
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "检测到已有实例在运行，先执行 stop.sh 进行重启..."
  ./stop.sh
fi
# PID 文件残留但进程已死，清理掉
rm -f "$PID_FILE"

# 全新环境自动安装依赖；依赖清单变化时也重新执行 npm ci。
# 哈希标记放在 node_modules 内，npm ci 重建目录后再写入。
DEPENDENCY_STAMP="$ROOT/node_modules/.llm-relay-dependency-hash"
DEPENDENCY_HASH="$({ sha256sum package.json package-lock.json; } | sha256sum | cut -d ' ' -f 1)"
INSTALLED_HASH=""
if [[ -f "$DEPENDENCY_STAMP" ]]; then
  INSTALLED_HASH="$(cat "$DEPENDENCY_STAMP")"
fi

if [[ ! -d node_modules || "$INSTALLED_HASH" != "$DEPENDENCY_HASH" ]]; then
  echo "首次运行或依赖清单已变化，执行 npm ci..."
  if ! npm ci >>"$LOG_FILE" 2>&1; then
    echo "依赖安装失败，请查看日志: $LOG_FILE" >&2
    exit 1
  fi
  printf '%s\n' "$DEPENDENCY_HASH" >"$DEPENDENCY_STAMP"
else
  echo "依赖未变化，跳过安装。"
fi

# 支持两种模式：
# - 默认每次启动前都会执行一次 build（避免“有时看不到更新”）
# - 如需临时跳过构建，可设置 LLM_RELAY_SKIP_BUILD=1（用于只做快速重启）
if [[ "${LLM_RELAY_SKIP_BUILD:-0}" == "1" ]]; then
  echo "检测到 LLM_RELAY_SKIP_BUILD=1，跳过构建，直接启动..."
else
  echo "执行构建..."
  npm run build >>"$LOG_FILE" 2>&1
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
