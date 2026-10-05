#!/usr/bin/env bash
# Process-group leader for one stack component. The supervisor execs this
# with POSIX setsid, so this pid is the pgid stored in state/pids/.
set -euo pipefail
cd "$(dirname "$0")/.."

component="${1:?component}"
shift

export LADDER_LOG_DIR="${LADDER_LOG_DIR:-$PWD/logs/ladder}"
export LIVE_RUNS_DIR="${LIVE_RUNS_DIR:-$PWD/live-runs}"
mkdir -p "$LADDER_LOG_DIR" "$LIVE_RUNS_DIR"

case "$component" in
  ladder)
    # Preflight already ran in scripts/stack.sh. The ladder client records the
    # account lock (pid + username on the live-runs row) before it logs in.
    exec npx tsx src/cli/ladder.ts "$@"
    ;;
  ops-factory)
    exec npx tsx src/ops/cli.ts factory "$@"
    ;;
  ops-gatekeeper)
    exec npx tsx src/ops/cli.ts gatekeeper "$@"
    ;;
  ops-analyst)
    exec npx tsx src/ops/cli.ts analyst "$@"
    ;;
  ops-live)
    exec npx tsx src/ops/cli.ts live "$@"
    ;;
  ops-sentinel)
    exec npx tsx src/ops/cli.ts sentinel "$@"
    ;;
  dashboard)
    exec npx tsx src/dashboard/cli.ts "$@"
    ;;
  *)
    echo "unknown component: $component" >&2
    exit 2
    ;;
esac
