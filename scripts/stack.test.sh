#!/usr/bin/env bash
# Hermetic checks for scripts/stack.sh. Holds stand-in processes; no ladder client.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
STACK="$ROOT/scripts/stack.sh"
tmp=$(mktemp -d)
rogue=""
cleanup() {
  JEV_STACK_PIDS="$tmp/pids" JEV_STACK_LOG_DIR="$tmp/logs" JEV_STACK_SIGNAL_WAIT=0.4 \
    bash "$STACK" stop ladder >/dev/null 2>&1 || true
  JEV_STACK_PIDS="$tmp/pids" JEV_STACK_LOG_DIR="$tmp/logs" JEV_STACK_SIGNAL_WAIT=0.4 \
    bash "$STACK" stop ops-live >/dev/null 2>&1 || true
  if [[ -n "${rogue:-}" ]]; then
    kill -s KILL "-$rogue" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

export JEV_STACK_PIDS="$tmp/pids"
export JEV_STACK_LOG_DIR="$tmp/logs"
export JEV_STACK_HOLD=1
export JEV_STACK_SIGNAL_WAIT=0.4
export STACK_SIGNAL_LOG="$tmp/signals"
mkdir -p "$tmp/pids" "$tmp/logs"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

bash "$STACK" start ladder >/dev/null
status=$(bash "$STACK" status ladder)
echo "$status" | grep -q 'ladder healthy pgid=' || fail "expected one healthy ladder group, got: $status"
pgid=$(echo "$status" | sed -n 's/.*pgid=\([0-9]*\).*/\1/p' | head -n 1)
[[ -n "$pgid" && "$pgid" -gt 1 ]] || fail "missing pgid"
ps -ww -o pgid= -p "$pgid" | grep -q "$pgid" || fail "pidfile pgid $pgid is not a live group"
ps -axww -o command= -p "$pgid" | grep -q 'src/cli/ladder.ts' || fail "group command line lost src/cli/ladder.ts"

if bash "$STACK" start ladder >/dev/null 2>"$tmp/second.err"; then
  fail "second start should refuse"
fi
grep -q 'already running' "$tmp/second.err" || fail "second start did not say already running"

rogue=$(node -e '
  const fs = require("fs");
  const { spawn } = require("child_process");
  const log = fs.openSync(process.argv[1], "a");
  const child = spawn(process.argv[2], process.argv.slice(3), {
    detached: true,
    stdio: ["ignore", log, log],
  });
  process.stdout.write(String(child.pid));
  child.unref();
' "$tmp/rogue.log" bash "$ROOT/scripts/stack-hold.sh" src/cli/ladder.ts)
sleep 0.3
rogue=$(ps -o pgid= -p "$rogue" | tr -d '[:space:]')

set +e
dup=$(bash "$STACK" status ladder 2>&1)
dup_code=$?
set -e
[[ "$dup_code" -ne 0 ]] || fail "status should fail when a duplicate group exists: $dup"
echo "$dup" | grep -Eq 'duplicate|orphan' || fail "status did not flag the duplicate: $dup"

bash "$STACK" stop ladder >/dev/null
if ps -p "$pgid" >/dev/null 2>&1; then
  fail "recorded group $pgid still alive after stop"
fi
if ps -p "$rogue" >/dev/null 2>&1; then
  fail "orphan group $rogue still alive after stop"
fi
rogue=""
set +e
down=$(bash "$STACK" status ladder 2>&1)
down_code=$?
set -e
[[ "$down_code" -ne 0 ]] || fail "status should be non-zero when ladder is down"
echo "$down" | grep -q 'ladder down' || fail "expected ladder down, got: $down"

export STACK_HOLD_STICKY=1
: > "$STACK_SIGNAL_LOG"
bash "$STACK" start ops-live >/dev/null
bash "$STACK" stop ops-live >/dev/null
signals=$(cat "$STACK_SIGNAL_LOG")
printf '%s\n' "$signals" | head -n 1 | grep -q INT || fail "first signal was not INT: $signals"
printf '%s\n' "$signals" | grep -q TERM || fail "TERM was not sent after INT: $signals"
unset STACK_HOLD_STICKY

echo "stack tests ok"
