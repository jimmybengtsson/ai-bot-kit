#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/.dev-server.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "Server status: stopped"
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" >/dev/null 2>&1; then
  echo "Server status: running (pid=$PID)"
else
  echo "Server status: stopped (stale pid file)"
fi
