#!/usr/bin/env bash
# 停止 llm-relay 后台进程
set -uo pipefail

cd "$(dirname "$0")"
PID_FILE=".run.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "未找到 PID 文件 $PID_FILE，进程可能未启动或已停止。"
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  # 对整个进程组发信号(负PGID)，确保连子进程(next-server)一起停止
  # 避免重蹈覆辙：只 kill 父进程 npm，子进程变孤儿继续占端口
  PGID=$(ps -o pgid= "$PID" | tr -d ' ')
  kill -- -"$PGID"
  echo "已发送停止信号给进程组 $PGID"
  # 等待组长退出(子进程退出更快,但以组长为准)
  for _ in $(seq 1 20); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$PID" 2>/dev/null; then
    echo "未在 5s 内退出，发送 SIGKILL 给进程组"
    kill -9 -- -"$PGID"
  fi
  echo "已停止"
else
  echo "PID $PID 已不在运行，清理残留 PID 文件。"
fi
rm -f "$PID_FILE"
