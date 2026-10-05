#!/usr/bin/env bash
# Live ladder runner. One login. Drain with SIGTERM, SIGUSR1, state/DRAIN, or live-runs/<run>.drain.
set -euo pipefail
cd "$(dirname "$0")"
exec npx tsx src/cli/ladder.ts "$@"
