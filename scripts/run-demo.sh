#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/test.sh"
exec java -cp "$ROOT/build/classes" multipath.MultiPathServer
