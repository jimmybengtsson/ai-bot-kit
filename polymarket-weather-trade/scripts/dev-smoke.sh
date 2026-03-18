#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"

curl -fsS "$BASE_URL/health/live" >/dev/null
curl -fsS "$BASE_URL/health/ready" >/dev/null || true
curl -fsS "$BASE_URL/health" >/dev/null || true
curl -fsS "$BASE_URL/status" >/dev/null

echo "Smoke check passed for $BASE_URL"
