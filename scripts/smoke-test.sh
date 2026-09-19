#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${MULTIPATH_TEST_PORT:-18080}"
"$ROOT/scripts/test.sh"
MULTIPATH_PORT="$PORT" java -cp "$ROOT/build/classes" multipath.MultiPathServer > "$ROOT/build/smoke-server.log" 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; }
trap cleanup EXIT
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -fsS "http://127.0.0.1:$PORT/api/health" | grep -q '"status":"ok"'
curl -fsS "http://127.0.0.1:$PORT/" | grep -q 'MultiPath'
curl -fsS "http://127.0.0.1:$PORT/api/simulate?mode=success" | grep -q '"success":true'
curl -sS "http://127.0.0.1:$PORT/api/simulate?mode=fail" | grep -q '"fallbackUsed":true'
curl -fsS "http://127.0.0.1:$PORT/api/simulate?mode=slow" | grep -q '"success":true'
curl -fsS --get --data-urlencode "url=http://127.0.0.1:$PORT/api/health" "http://127.0.0.1:$PORT/api/probe" | grep -q '"statusCode":200'
curl -fsS "http://127.0.0.1:$PORT/api/metrics" | grep -q '"requests":4'
echo "SMOKE TEST PASSED"
