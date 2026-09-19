#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
rm -rf "$ROOT/build/classes"
mkdir -p "$ROOT/build/classes"
find "$ROOT/src" -name '*.java' -print0 | xargs -0 javac --release 11 -d "$ROOT/build/classes"
java -cp "$ROOT/build/classes" multipath.ResilienceEngineTest
