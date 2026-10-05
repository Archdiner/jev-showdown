#!/usr/bin/env bash
# Test stand-in. Its arguments are the real command line the supervisor matches
# (src/cli/ladder.ts, src/ops/cli.ts factory, ...). It does not start a client.
set -u

log="${STACK_SIGNAL_LOG:-}"
note() {
  if [[ -n "$log" ]]; then printf '%s\n' "$1" >> "$log"; fi
}

if [[ "${STACK_HOLD_STICKY:-}" == 1 ]]; then
  trap 'note INT' INT
  trap 'note TERM' TERM
else
  trap 'note INT; exit 0' INT
  trap 'note TERM; exit 0' TERM
fi

while true; do
  sleep 30
done
