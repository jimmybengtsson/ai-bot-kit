#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/.dev-server.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "Server already stopped"
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" >/dev/null 2>&1; then
  kill "$PID"
  sleep 1
  if kill -0 "$PID" >/dev/null 2>&1; then
    kill -9 "$PID"
  fi
  echo "Stopped server (pid=$PID)"
else
  echo "Server not running (stale pid file)"
fi

rm -f "$PID_FILE"
