# Operations

`scripts/stack.sh` is how a live stack is started and stopped. Do not wrap these processes in `screen`. `screen -X quit` leaves the zsh, login, npm, tsx, and node trees running under PID 1. That is how a second ops-live loop, a second ladder runner, and a retired local server stayed up.

## Commands

```bash
scripts/stack.sh start|stop|status|restart <component> [args...]
scripts/stack.sh status
```

Components:

| Component | Command |
| --- | --- |
| `ladder` | live preflight, then `npx tsx src/cli/ladder.ts` |
| `ops-factory` | `npx tsx src/ops/cli.ts factory` |
| `ops-gatekeeper` | `npx tsx src/ops/cli.ts gatekeeper` |
| `ops-analyst` | `npx tsx src/ops/cli.ts analyst` |
| `ops-live` | `npx tsx src/ops/cli.ts live` |
| `ops-sentinel` | `npx tsx src/ops/cli.ts sentinel` |
| `dashboard` | `npx tsx src/dashboard/cli.ts` |

`npm run ops -- supervise` starts factory, gatekeeper, live, and analyst. It does not start sentinel: a P0 makes `sentinel --once` exit 1, and the supervisor would restart that as a crash. `ops-sentinel` is a stack component so the long-running worker still has one process group.

Extra arguments are forwarded. `scripts/stack.sh start ladder --games 10 --engine max-damage` is the live client with those flags.

## Shell

The Mac login shell is zsh. zsh does not split an unquoted list of pids, and an unmatched `live-runs/*.drain` aborts the command before `rm` runs. `scripts/stack.sh` has a bash shebang and, when `BASH_VERSION` is unset, re-execs itself with `bash` before `set -euo pipefail` and `shopt -s nullglob`. `npm run stack` is that same `bash scripts/stack.sh` invocation. Process-group ids are read one per line into an array, so a stop still signals every orphan group.

## Drain files

`start ladder` and `restart ladder` delete `state/DRAIN` and every `LIVE_RUNS_DIR/*.drain` before preflight and before the client is detached. `nullglob` makes a directory with no `.drain` file expand to nothing, so that deletion still removes `state/DRAIN`. If `state/DRAIN` or a `.drain` file is still present afterward, start prints `still exists` and does not launch a process. A batch therefore does not inherit a drain and finish at 0 games. `JEV_STACK_DRAIN_FILE` overrides the `state/DRAIN` path.

## Process groups

Each component is started in its own session. Linux uses `setsid -f`. macOS has no `setsid` binary, so the same POSIX `setsid` is made through Node's detached spawn. The pgid is written to `state/pids/<component>.pid`. Stdout and stderr go to `logs/stack/<component>.log`.

Every component is started with:

- `LADDER_LOG_DIR` (default `logs/ladder`)
- `LIVE_RUNS_DIR` (default `live-runs`)

`stop` sends `SIGINT`, waits, then `SIGTERM`, then `SIGKILL`, to that process group. It then does the same to any process that is still matching the component's command line, including a tree that `screen` orphaned. The wait between signals is `JEV_STACK_SIGNAL_WAIT` seconds (default 5). Stop exits non-zero if a match is still running.

`SIGINT` asks the ladder client to disconnect without forfeiting. `SIGTERM` is the drain signal (`SIGUSR1` is the other drain signal and is not used here).

## Status

`scripts/stack.sh status` exits 0 only when every component has exactly one healthy group and every `src/cli/ladder.ts`, `src/ops/cli.ts <role>`, and `src/dashboard/cli.ts` process sits in the group recorded for that component. A down component, a second group, or an orphan exits non-zero. That is the check an incident loop can call.

`scripts/stack.sh status ladder` requires that one component to be healthy, and still exits non-zero if some other component's command is running outside its recorded group. A component that was never started, and has no process, does not by itself fail a single-component status.

## Ladder login

`start ladder` runs `npm run live:preflight` in the foreground before it detaches the client. Preflight refuses a dirty tree, a commit that is not on `origin/main`, fewer than 500 species, a live `state/ladder-<userid>.lock`, another public ladder process for the account, or a failed local canary. The ladder client then takes that lock (pid, start time, and host) before it logs in. A failed preflight does not leave a ladder process behind.

`restart` stops the component, then starts it. Forwarded flags apply to the new process.
