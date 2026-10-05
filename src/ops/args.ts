export const OPS_USAGE = `usage: npm run ops -- factory|gatekeeper|live|analyst|sentinel|incidents|scorecard|status|report|supervise|repair-games|dry-run
  factory, gatekeeper, live, analyst, supervise accept --once
  live --local
      Start a local server on a free port, log in as localbot, and do not contact
      https://play.pokemonshowdown.com. No Showdown account is required.
  live --local --port 8010
  live --local --server ws://127.0.0.1:8010/showdown/websocket
  live --local --username NAME
  live
      Public ladder with SHOWDOWN_USERNAME and SHOWDOWN_PASSWORD.
      Refuses to start when ladder.ts (run-live.sh) is already on that account.
  Flags accept --name value and --name=value.
  live --runners N --concurrency K
  gatekeeper --bootstrap checks configs/champion.yaml and does not label it without paired games
  analyst also tails logs/ladder and live-runs JSONL. --ladder-dir and --live-runs replace those defaults.
  Opponent priors use the foe's seat from ourSide or the |player| line. A scraped replay counts both players.
  report --daily is the plain-English day summary
  sentinel [--once] [--json] [--since 24h|ISO]
      Run the reliability checks every 60s. --once exits 1 only for an open, unacknowledged P0 inside the baseline.
      --since or SENTINEL_SINCE is that baseline. When both are unset, it is the current ladder run's start.
      --once --json prints those incidents as one JSON object. Acknowledged and fixing P0s do not change the exit code.
      --ack ID, --fixing ID --pr URL, and --root-cause ID --text REASON move an incident.
      LIVE_REPO_DIR, or the git root of LADDER_LOG_DIR when that root is not the ops cwd, is the ladder checkout. Runner liveness uses ps or kill -0, never /proc.
  incidents ack|resolve --before ISO --reason TEXT
  incidents ack|resolve --sha SHA --reason TEXT
  incidents link ID REF
      Mark matching incidents, or attach a ledger ref such as INC-007. The scorecard prints the ref.
  scorecard [--since 24h|ISO] [--md]
      One screen for the owner. --since 24h is a duration. An ISO timestamp is the start of the window.
      Elo, win rate, and record are compared with the previous window of the same length.
      Phantom games, local games, and a duplicate disconnect tie are excluded.
  repair-games
      Flag contaminated rows in games.contamination.jsonl. Does not delete or
      rewrite the game log. --games and --live select the files.
Facilities share the graph and the JSONL logs. They do not import each other.`;

export function opsFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/** `--name value` and `--name=value`. */
export function opsValue(argv: string[], name: string): string | undefined {
  const prefixed = `--${name}=`;
  const eq = argv.find(arg => arg.startsWith(prefixed));
  if (eq) return eq.slice(prefixed.length);
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for --${name}`);
  }
  return value;
}

export function opsNumber(argv: string[], name: string): number | undefined {
  const value = opsValue(argv, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number`);
  return parsed;
}
