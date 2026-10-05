export const OPS_USAGE = `usage: npm run ops -- factory|gatekeeper|live|analyst|sentinel|scorecard|status|report|supervise|dry-run
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
  sentinel [--once] [--json]
      Run the reliability checks every 60s. --once exits non-zero when a P0 incident is open.
      --ack ID, --fixing ID --pr URL, and --root-cause ID --text REASON move an incident.
  scorecard [--since 24h] [--md]
      One screen for the owner. Phantom 0-turn ties and disconnects are excluded.
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
