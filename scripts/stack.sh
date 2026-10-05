#!/usr/bin/env bash
# Start, stop, and inspect the live stack as process groups.
# screen -X quit does not signal the children; stop does, by pgid and by command line.
#
#   scripts/stack.sh start|stop|status|restart <component> [args...]
#   scripts/stack.sh status
#
# The Mac login shell is zsh. zsh does not word-split an unquoted pid list, and
# an unmatched glob aborts the command, so this file re-execs under bash before
# any option that zsh would reject. npm run stack is the same bash invocation.
if [ -z "${BASH_VERSION:-}" ]; then
  exec /usr/bin/env bash "$0" "$@"
fi
set -euo pipefail
shopt -s nullglob

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
PIDS=${JEV_STACK_PIDS:-$ROOT/state/pids}
LOGS=${JEV_STACK_LOG_DIR:-$ROOT/logs/stack}
WAIT=${JEV_STACK_SIGNAL_WAIT:-5}
# supervise does not start sentinel: a P0 makes --once exit 1, and that restart
# loop would treat the exit as a crash. This supervisor owns the long-running worker.
COMPONENTS=(ladder ops-factory ops-gatekeeper ops-analyst ops-live ops-sentinel dashboard)

usage() {
  cat <<'EOF'
Usage: scripts/stack.sh <start|stop|status|restart> [component] [args...]

Components: ladder, ops-factory, ops-gatekeeper, ops-analyst, ops-live,
ops-sentinel, dashboard

The script always runs under bash (shebang, and re-exec when a zsh login shell
invokes it). set -euo pipefail and nullglob are on, so a missing live-runs/*.drain
does not abort the command.

start launches the component in its own process group and records the pgid in
state/pids/<component>.pid. Logs go to logs/stack/<component>.log.
LADDER_LOG_DIR (default logs/ladder) and LIVE_RUNS_DIR (default live-runs) are set.

ladder start deletes state/DRAIN and every live-runs/*.drain, then refuses to
detach if state/DRAIN is still present. It then runs live preflight (clean tree
on origin/main, species floor, account lock, local canary). The ladder client
records the lock.

stop sends SIGINT, then SIGTERM, then SIGKILL to that group, then to any
leftover process whose command line is that component. It exits non-zero if
any match is still running.

status with no component requires exactly one healthy group for every component.
status <component> requires that for one component, and always flags a
src/cli/ladder.ts, src/ops/cli.ts <role>, or src/dashboard/cli.ts process that
is not in a recorded group.
EOF
}

is_component() {
  case "$1" in
    ladder|ops-factory|ops-gatekeeper|ops-analyst|ops-live|ops-sentinel|dashboard) return 0 ;;
    *) return 1 ;;
  esac
}

pidfile() {
  printf '%s/%s.pid' "$PIDS" "$1"
}

logfile() {
  printf '%s/%s.log' "$LOGS" "$1"
}

# True when this command line is the component's process (or a test stand-in
# whose argv contains that command).
cmdline_matches() {
  local component="$1"
  local cmd="$2"
  case "$component" in
    ladder)
      [[ "$cmd" =~ (^|[[:space:]/])src/cli/ladder\.ts([[:space:]]|$) ]]
      ;;
    ops-factory)
      [[ "$cmd" =~ src/ops/cli\.ts[[:space:]]+factory([[:space:]]|$) ]]
      ;;
    ops-gatekeeper)
      [[ "$cmd" =~ src/ops/cli\.ts[[:space:]]+gatekeeper([[:space:]]|$) ]]
      ;;
    ops-analyst)
      [[ "$cmd" =~ src/ops/cli\.ts[[:space:]]+analyst([[:space:]]|$) ]]
      ;;
    ops-live)
      [[ "$cmd" =~ src/ops/cli\.ts[[:space:]]+live([[:space:]]|$) ]]
      ;;
    ops-sentinel)
      [[ "$cmd" =~ src/ops/cli\.ts[[:space:]]+sentinel([[:space:]]|$) ]]
      ;;
    dashboard)
      [[ "$cmd" =~ (^|[[:space:]/])src/dashboard/cli\.ts([[:space:]]|$) ]]
      ;;
    *)
      return 1
      ;;
  esac
}

list_processes() {
  if ps -axww -o pid= -o pgid= -o command= >/dev/null 2>&1; then
    ps -axww -o pid=,pgid=,command=
  else
    ps -eww -o pid=,pgid=,args=
  fi
}

group_alive() {
  local pgid="$1"
  local pid g cmd
  while read -r pid g cmd; do
    if [[ "$g" == "$pgid" ]]; then
      return 0
    fi
  done < <(list_processes)
  return 1
}

# Echo "pid pgid command" lines for one component.
matching_processes() {
  local component="$1"
  local pid g cmd
  while read -r pid g cmd; do
    [[ -n "${pid:-}" ]] || continue
    if cmdline_matches "$component" "$cmd"; then
      printf '%s %s %s\n' "$pid" "$g" "$cmd"
    fi
  done < <(list_processes)
}

matching_pgids() {
  matching_processes "$1" | awk '{print $2}' | awk '!seen[$0]++'
}

read_pgid() {
  local file
  file=$(pidfile "$1")
  if [[ -f "$file" ]]; then
    tr -d '[:space:]' < "$file"
  fi
}

known_pgid() {
  local component pgid
  for component in "${COMPONENTS[@]}"; do
    pgid=$(read_pgid "$component")
    if [[ -n "$pgid" && "$pgid" == "$1" ]]; then
      return 0
    fi
  done
  return 1
}

refuse_pgid() {
  local pgid="$1"
  if [[ -z "$pgid" || "$pgid" -le 1 ]]; then
    echo "refusing to signal pgid ${pgid:-<empty>}" >&2
    return 0
  fi
  return 1
}

wait_dead() {
  local pgid="$1"
  local ticks i
  ticks=$(awk -v w="$WAIT" 'BEGIN { n = int(w * 10); if (n < 1) n = 1; print n }')
  i=0
  while [[ "$i" -lt "$ticks" ]]; do
    if ! group_alive "$pgid"; then
      return 0
    fi
    sleep 0.1
    i=$((i + 1))
  done
  if group_alive "$pgid"; then
    return 1
  fi
  return 0
}

signal_group() {
  local pgid="$1"
  if refuse_pgid "$pgid"; then
    return 1
  fi
  if ! group_alive "$pgid"; then
    return 0
  fi
  kill -s INT "-$pgid" 2>/dev/null || true
  if wait_dead "$pgid"; then
    return 0
  fi
  kill -s TERM "-$pgid" 2>/dev/null || true
  if wait_dead "$pgid"; then
    return 0
  fi
  kill -s KILL "-$pgid" 2>/dev/null || true
  wait_dead "$pgid" || true
}

# Detach via the setsid binary when it can fork, otherwise Node's detached
# spawn (POSIX setsid). macOS does not ship setsid; both paths record a pgid.
detach() {
  local log="$1"
  shift
  mkdir -p "$(dirname "$log")"
  if command -v setsid >/dev/null 2>&1 && setsid -f /bin/true >/dev/null 2>&1; then
    # setsid -f exits after the fork. The child writes its pid, which is the pgid.
    local stamp
    stamp=$(mktemp)
    setsid -f bash -c 'echo $$ > "$1"; shift; exec "$@"' _ "$stamp" "$@" >>"$log" 2>&1 </dev/null || true
    local i=0
    while [[ ! -s "$stamp" && "$i" -lt 50 ]]; do
      sleep 0.05
      i=$((i + 1))
    done
    if [[ ! -s "$stamp" ]]; then
      rm -f "$stamp"
      echo "setsid did not record a pid" >&2
      return 1
    fi
    cat "$stamp"
    rm -f "$stamp"
    return 0
  fi
  node -e '
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
  ' "$log" "$@"
}

build_cmd() {
  local component="$1"
  shift
  if [[ "${JEV_STACK_HOLD:-}" == 1 ]]; then
    case "$component" in
      ladder) CMD=(bash "$SCRIPT_DIR/stack-hold.sh" src/cli/ladder.ts) ;;
      ops-factory) CMD=(bash "$SCRIPT_DIR/stack-hold.sh" src/ops/cli.ts factory) ;;
      ops-gatekeeper) CMD=(bash "$SCRIPT_DIR/stack-hold.sh" src/ops/cli.ts gatekeeper) ;;
      ops-analyst) CMD=(bash "$SCRIPT_DIR/stack-hold.sh" src/ops/cli.ts analyst) ;;
      ops-live) CMD=(bash "$SCRIPT_DIR/stack-hold.sh" src/ops/cli.ts live) ;;
      ops-sentinel) CMD=(bash "$SCRIPT_DIR/stack-hold.sh" src/ops/cli.ts sentinel) ;;
      dashboard) CMD=(bash "$SCRIPT_DIR/stack-hold.sh" src/dashboard/cli.ts) ;;
    esac
    return 0
  fi
  CMD=(bash "$SCRIPT_DIR/stack-launch.sh" "$component" "$@")
}

ensure_env() {
  export LADDER_LOG_DIR="${LADDER_LOG_DIR:-$ROOT/logs/ladder}"
  export LIVE_RUNS_DIR="${LIVE_RUNS_DIR:-$ROOT/live-runs}"
  mkdir -p "$LADDER_LOG_DIR" "$LIVE_RUNS_DIR" "$PIDS" "$LOGS"
}

# Delete the repo drain switch and every live-runs/*.drain. nullglob makes a
# directory with no *.drain expand to zero names, so the DRAIN removal is not
# skipped. Refuse when a marker is still on disk (a directory that cannot be
# written, for example) so the next batch cannot drain at 0 games.
clear_ladder_drain() {
  local drain runs f
  drain="${JEV_STACK_DRAIN_FILE:-$ROOT/state/DRAIN}"
  runs="${LIVE_RUNS_DIR:-$ROOT/live-runs}"
  mkdir -p "$(dirname "$drain")" "$runs"
  rm -f -- "$drain" || true
  for f in "$runs"/*.drain; do
    rm -f -- "$f" || true
  done
  local stuck
  stuck=()
  if [[ -e "$drain" ]]; then
    stuck+=("$drain")
  fi
  for f in "$runs"/*.drain; do
    if [[ -e "$f" ]]; then
      stuck+=("$f")
    fi
  done
  if [[ ${#stuck[@]} -eq 0 ]]; then
    return 0
  fi
  for f in "${stuck[@]}"; do
    echo "refusing to start ladder: $f still exists" >&2
  done
  return 1
}

start_component() {
  local component="$1"
  shift
  ensure_env
  local existing
  existing=$(matching_pgids "$component" | tr '\n' ' ')
  if [[ -n "${existing// /}" ]]; then
    echo "$component is already running (pgid ${existing})" >&2
    return 1
  fi
  local recorded
  recorded=$(read_pgid "$component" || true)
  if [[ -n "$recorded" ]] && group_alive "$recorded"; then
    echo "$component pidfile pgid $recorded is still alive" >&2
    return 1
  fi
  if [[ "$component" == "ladder" ]]; then
    clear_ladder_drain || return 1
  fi
  if [[ "$component" == "ladder" && "${JEV_STACK_HOLD:-}" != 1 ]]; then
    echo "ladder start: live preflight, then the ladder client (account lock is recorded before login)"
    (cd "$ROOT" && npx tsx src/cli/preflight.ts "$@")
  fi
  local log
  log=$(logfile "$component")
  printf '%s\n' "--- $(date -u +%Y-%m-%dT%H:%M:%SZ) start $component ---" >> "$log"
  build_cmd "$component" "$@"
  local leader
  leader=$(detach "$log" "${CMD[@]}")
  leader=$(printf '%s' "$leader" | tr -d '[:space:]')
  if [[ -z "$leader" ]]; then
    echo "$component did not start" >&2
    return 1
  fi
  sleep 0.2
  local pgid
  pgid=$(ps -o pgid= -p "$leader" 2>/dev/null | tr -d '[:space:]' || true)
  if [[ -z "$pgid" ]]; then
    pgid=$leader
  fi
  if ! group_alive "$pgid"; then
    echo "$component exited during start. Log: $log" >&2
    return 1
  fi
  printf '%s\n' "$pgid" > "$(pidfile "$component")"
  echo "$component started pgid=$pgid log=$log"
}

stop_component() {
  local component="$1"
  local pgid
  pgid=$(read_pgid "$component" || true)
  if [[ -n "$pgid" ]]; then
    signal_group "$pgid" || true
  fi
  local groups
  groups=()
  local g
  while IFS= read -r g; do
    [[ -n "$g" ]] || continue
    groups+=("$g")
  done < <(matching_pgids "$component" || true)
  if [[ ${#groups[@]} -gt 0 ]]; then
    for g in "${groups[@]}"; do
      signal_group "$g" || true
    done
  fi
  local leftover
  leftover=$(matching_pgids "$component" || true)
  rm -f "$(pidfile "$component")"
  if [[ -n "$leftover" ]]; then
    echo "$component stop left processes in pgid: $(echo "$leftover" | tr '\n' ' ')" >&2
    matching_processes "$component" >&2 || true
    return 1
  fi
  echo "$component stopped"
}

status_component() {
  local component="$1"
  local require_up="${2:-1}"
  local recorded
  recorded=$(read_pgid "$component" || true)
  local groups
  groups=()
  local g
  while IFS= read -r g; do
    [[ -n "$g" ]] || continue
    groups+=("$g")
  done < <(matching_pgids "$component" || true)
  local count=${#groups[@]}
  if [[ "$count" -eq 1 && -n "$recorded" && "${groups[0]}" == "$recorded" ]] && group_alive "$recorded"; then
    local pids
    pids=$(matching_processes "$component" | awk '{print $1}' | tr '\n' ',' | sed 's/,$//')
    echo "$component healthy pgid=$recorded pids=$pids log=$(logfile "$component")"
    return 0
  fi
  if [[ "$count" -gt 1 ]]; then
    local joined=""
    for g in "${groups[@]}"; do
      joined="${joined}${g},"
    done
    echo "$component duplicate pgids=${joined%,}"
    return 1
  fi
  if [[ "$count" -eq 1 && "${groups[0]}" != "$recorded" ]]; then
    local cmd
    cmd=$(matching_processes "$component" | head -n 1 | cut -d' ' -f3-)
    echo "$component orphan pgid=${groups[0]} pidfile=${recorded:-none} cmd=$cmd"
    return 1
  fi
  if [[ -n "$recorded" ]] && group_alive "$recorded"; then
    echo "$component unhealthy pgid=$recorded (group is alive and its command line does not match)"
    return 1
  fi
  if [[ "$require_up" -eq 1 ]]; then
    echo "$component down"
    return 1
  fi
  echo "$component down"
  return 0
}

# Processes whose command matches a component and whose pgid is not that component's pidfile.
report_orphans() {
  local component failed=0
  for component in "${COMPONENTS[@]}"; do
    local recorded
    recorded=$(read_pgid "$component" || true)
    local line pid g cmd
    while read -r line; do
      [[ -n "$line" ]] || continue
      pid=${line%% *}
      local rest=${line#* }
      g=${rest%% *}
      cmd=${rest#* }
      if [[ -n "$recorded" && "$g" == "$recorded" ]]; then
        continue
      fi
      echo "orphan component=$component pgid=$g pid=$pid cmd=$cmd"
      failed=1
    done < <(matching_processes "$component" || true)
  done
  return "$failed"
}

cmd="${1:-}"
if [[ -z "$cmd" || "$cmd" == "-h" || "$cmd" == "--help" ]]; then
  usage
  exit 0
fi
shift || true
component="${1:-}"

case "$cmd" in
  start|stop|restart)
    if ! is_component "${component:-}"; then
      echo "unknown component: ${component:-<missing>}" >&2
      usage >&2
      exit 2
    fi
    shift
    ;;
  status)
    if [[ -n "$component" ]] && ! is_component "$component"; then
      echo "unknown component: $component" >&2
      usage >&2
      exit 2
    fi
    ;;
  *)
    echo "unknown command: $cmd" >&2
    usage >&2
    exit 2
    ;;
esac

case "$cmd" in
  start)
    start_component "$component" "$@"
    ;;
  stop)
    stop_component "$component"
    ;;
  restart)
    stop_component "$component"
    start_component "$component" "$@"
    ;;
  status)
    failed=0
    if [[ -n "$component" ]]; then
      status_component "$component" 1 || failed=1
      report_orphans || failed=1
    else
      for component in "${COMPONENTS[@]}"; do
        status_component "$component" 1 || failed=1
      done
      report_orphans || failed=1
    fi
    exit "$failed"
    ;;
esac
