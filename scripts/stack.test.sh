#!/usr/bin/env bash
# Hermetic checks for scripts/stack.sh. Holds stand-in processes; no ladder client.
# The Mac login shell is zsh, so the drain clear and the orphan kill are invoked
# with zsh. That is the path where an unquoted pid list and a missed *.drain glob fail.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
STACK="$ROOT/scripts/stack.sh"
tmp=$(mktemp -d)
lockdir="$tmp/locked"
rogues=()
cleanup() {
  JEV_STACK_PIDS="$tmp/pids" JEV_STACK_LOG_DIR="$tmp/logs" JEV_STACK_SIGNAL_WAIT=0.4 \
    JEV_STACK_DRAIN_FILE="$tmp/state/DRAIN" LIVE_RUNS_DIR="$tmp/runs" \
    bash "$STACK" stop ladder >/dev/null 2>&1 || true
  JEV_STACK_PIDS="$tmp/pids" JEV_STACK_LOG_DIR="$tmp/logs" JEV_STACK_SIGNAL_WAIT=0.4 \
    bash "$STACK" stop ops-live >/dev/null 2>&1 || true
  JEV_STACK_PIDS="$tmp/pids" JEV_STACK_LOG_DIR="$tmp/logs" JEV_STACK_SIGNAL_WAIT=0.4 \
    bash "$STACK" stop ops-sentinel >/dev/null 2>&1 || true
  if [[ ${#rogues[@]} -gt 0 ]]; then
    local g
    for g in "${rogues[@]}"; do
      kill -s KILL "-$g" 2>/dev/null || true
    done
  fi
  if [[ -d "$lockdir" ]]; then
    chmod u+w "$lockdir" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

export JEV_STACK_PIDS="$tmp/pids"
export JEV_STACK_LOG_DIR="$tmp/logs"
export JEV_STACK_HOLD=1
export JEV_STACK_SIGNAL_WAIT=0.4
export JEV_STACK_DRAIN_FILE="$tmp/state/DRAIN"
export LIVE_RUNS_DIR="$tmp/runs"
export STACK_SIGNAL_LOG="$tmp/signals"
mkdir -p "$tmp/pids" "$tmp/logs" "$tmp/state" "$tmp/runs"
printf 'hold\n' > "$JEV_STACK_DRAIN_FILE"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

command -v zsh >/dev/null 2>&1 || fail "zsh is required; the Mac login shell is zsh and this test invokes stack.sh that way"

help_text=$(zsh "$STACK" --help)
printf '%s\n' "$help_text" | grep -q 'ops-sentinel' || fail "usage omitted ops-sentinel: $help_text"
printf '%s\n' "$help_text" | grep -q 'nullglob' || fail "usage omitted nullglob"

# No live-runs/*.drain. Under zsh nomatch the old rm aborted and left DRAIN in place.
zsh "$STACK" start ladder >/dev/null
[[ ! -e "$JEV_STACK_DRAIN_FILE" ]] || fail "DRAIN survived ladder start when live-runs had no *.drain"
if find "$LIVE_RUNS_DIR" -name '*.drain' -print | grep -q .; then
  fail "a live-runs drain file survived the empty-glob start"
fi

status=$(zsh "$STACK" status ladder)
echo "$status" | grep -q 'ladder healthy pgid=' || fail "expected one healthy ladder group, got: $status"
pgid=$(echo "$status" | sed -n 's/.*pgid=\([0-9]*\).*/\1/p' | head -n 1)
[[ -n "$pgid" && "$pgid" -gt 1 ]] || fail "missing pgid"
ps -ww -o pgid= -p "$pgid" | grep -q "$pgid" || fail "pidfile pgid $pgid is not a live group"
ps -axww -o command= -p "$pgid" | grep -q 'src/cli/ladder.ts' || fail "group command line lost src/cli/ladder.ts"

if zsh "$STACK" start ladder >/dev/null 2>"$tmp/second.err"; then
  fail "second start should refuse"
fi
grep -q 'already running' "$tmp/second.err" || fail "second start did not say already running"

spawn_ladder_orphan() {
  local pid pg
  pid=$(node -e '
    const fs = require("fs");
    const { spawn } = require("child_process");
    const log = fs.openSync(process.argv[1], "a");
    const child = spawn(process.argv[2], process.argv.slice(3), {
      detached: true,
      stdio: ["ignore", log, log],
    });
    if (!child.pid) process.exit(1);
    process.stdout.write(String(child.pid));
    child.unref();
  ' "$tmp/rogue.log" bash "$ROOT/scripts/stack-hold.sh" src/cli/ladder.ts)
  sleep 0.25
  pg=$(ps -o pgid= -p "$pid" | tr -d '[:space:]')
  [[ -n "$pg" && "$pg" -gt 1 ]] || fail "orphan did not get a pgid (pid=$pid)"
  printf '%s\n' "$pg"
}

rogue_a=$(spawn_ladder_orphan)
rogue_b=$(spawn_ladder_orphan)
[[ "$rogue_a" != "$rogue_b" && "$rogue_a" != "$pgid" && "$rogue_b" != "$pgid" ]] || fail "orphan pgids were not distinct ($pgid $rogue_a $rogue_b)"
rogues=("$rogue_a" "$rogue_b")

set +e
dup=$(zsh "$STACK" status ladder 2>&1)
dup_code=$?
set -e
[[ "$dup_code" -ne 0 ]] || fail "status should fail when two orphan groups exist: $dup"
echo "$dup" | grep -Eq 'duplicate|orphan' || fail "status did not flag both orphans: $dup"

zsh "$STACK" stop ladder >/dev/null
if ps -p "$pgid" >/dev/null 2>&1; then
  fail "recorded group $pgid still alive after stop"
fi
if ps -p "$rogue_a" >/dev/null 2>&1; then
  fail "orphan group $rogue_a still alive after stop"
fi
if ps -p "$rogue_b" >/dev/null 2>&1; then
  fail "orphan group $rogue_b still alive after stop"
fi
rogues=()
set +e
down=$(zsh "$STACK" status ladder 2>&1)
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

zsh "$STACK" start ops-sentinel >/dev/null
sentinel_status=$(zsh "$STACK" status ops-sentinel)
echo "$sentinel_status" | grep -q 'ops-sentinel healthy pgid=' || fail "sentinel was not healthy: $sentinel_status"
sentinel_pgid=$(echo "$sentinel_status" | sed -n 's/.*pgid=\([0-9]*\).*/\1/p' | head -n 1)
ps -axww -o command= -p "$sentinel_pgid" | grep -q 'src/ops/cli.ts sentinel' || fail "sentinel command line was not src/ops/cli.ts sentinel"
zsh "$STACK" stop ops-sentinel >/dev/null
if ps -p "$sentinel_pgid" >/dev/null 2>&1; then
  fail "sentinel group $sentinel_pgid still alive after stop"
fi

printf 'hold\n' > "$JEV_STACK_DRAIN_FILE"
printf 'x\n' > "$LIVE_RUNS_DIR/run-1.drain"
zsh "$STACK" start ladder >/dev/null
[[ ! -e "$JEV_STACK_DRAIN_FILE" ]] || fail "DRAIN survived ladder start"
[[ ! -e "$LIVE_RUNS_DIR/run-1.drain" ]] || fail "live-runs/*.drain survived ladder start"
zsh "$STACK" stop ladder >/dev/null

mkdir -p "$lockdir"
printf 'hold\n' > "$lockdir/DRAIN"
chmod a-w "$lockdir"
export JEV_STACK_DRAIN_FILE="$lockdir/DRAIN"
set +e
refuse=$(zsh "$STACK" start ladder 2>&1)
refuse_code=$?
set -e
[[ "$refuse_code" -ne 0 ]] || fail "start should refuse when DRAIN cannot be removed: $refuse"
printf '%s\n' "$refuse" | grep -q 'still exists' || fail "refusal did not say the drain file still exists: $refuse"
[[ -e "$lockdir/DRAIN" ]] || fail "unwritable DRAIN disappeared"
[[ ! -f "$tmp/pids/ladder.pid" ]] || fail "ladder pidfile was written after a refused start"
if ps -axww -o command= | grep -E 'src/cli/ladder\.ts' | grep -v grep >/dev/null; then
  fail "a ladder process was started while DRAIN still existed"
fi
chmod u+w "$lockdir"
export JEV_STACK_DRAIN_FILE="$tmp/state/DRAIN"

echo "stack tests ok"
