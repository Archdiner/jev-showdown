#!/usr/bin/env bash
# Live ladder runner. Preflight checks the tree, the species table, the account
# lock, and a local canary before this process logs in.
# Drain with SIGTERM, SIGUSR1, state/DRAIN, or live-runs/<run>.drain.
# LIVE_BATCH_LABEL names the batch on each game row. A redirected log file name is used when that env is unset:
#   LIVE_BATCH_LABEL=batch-9 ./run-live.sh --games 30 > logs/batch-9.log
set -euo pipefail
cd "$(dirname "$0")"
npx tsx src/cli/preflight.ts "$@"
exec npx tsx src/cli/ladder.ts "$@"
