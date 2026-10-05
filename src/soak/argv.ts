/** Flags the canary keeps from the live command. Server, games, and log dir are replaced. */
const VALUE_FLAGS = new Set([
  '--format',
  '--search-ms',
  '--decision-ms',
  '--engine',
  '--opponent-engine',
  '--concurrency',
  '--runners',
  '--concurrency-config',
  '--ramp-from',
  '--ramp-target',
  '--games',
  '--log-dir',
  '--server',
  '--port',
  '--challenge',
  '--username',
]);

const DROP_VALUE = new Set([
  '--games',
  '--log-dir',
  '--server',
  '--port',
  '--challenge',
  '--username',
]);

const DROP_BOOL = new Set(['--local', '--accept', '--check', '--help', '-h']);

/** Last occurrence wins, matching the ladder argument parser. */
export function flagValue(argv: string[], name: string, fallback: string): string {
  let found = fallback;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== name) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) found = next;
  }
  return found;
}

/** Live flags that must reach the canary unchanged. Connection flags are stripped. */
export function forwardLiveFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (DROP_BOOL.has(arg)) continue;
    if (DROP_VALUE.has(arg)) {
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
      continue;
    }
    out.push(arg);
    if (VALUE_FLAGS.has(arg) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      out.push(argv[++i]);
    }
  }
  return out;
}

export function buildLadderArgv(input: {
  server: string;
  games: number;
  logDir: string;
  username: string;
  concurrency: number;
  engine: string;
  extra: string[];
}): string[] {
  return [
    ...input.extra,
    '--local',
    '--server', input.server,
    '--games', String(input.games),
    '--log-dir', input.logDir,
    '--username', input.username,
    '--concurrency', String(input.concurrency),
    '--engine', input.engine,
  ];
}
