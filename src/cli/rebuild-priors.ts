#!/usr/bin/env node

import * as fs from 'fs';
import { DEFAULT_PRIOR_STRENGTH, rebuildObservedPriors } from '../engine/observed-priors.js';
import { RandbatsStats } from '../types/index.js';

interface RebuildArgs {
  help: boolean;
  logs: string[];
  stats: string;
  out: string;
  strength: number;
  username?: string;
}

export function parseRebuildArgs(argv: string[]): RebuildArgs {
  const logs: string[] = [];
  let stats = 'data/gen9-stats.json';
  let out = 'state/meta/observed-sets.json';
  let strength = DEFAULT_PRIOR_STRENGTH;
  let username: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (flag: string): string => {
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
      const next = argv[++i];
      if (!next) throw new Error(`missing value for ${flag}`);
      return next;
    };
    if (arg === '--help' || arg === '-h') {
      return { help: true, logs, stats, out, strength, username };
    }
    if (arg === '--logs' || arg.startsWith('--logs=')) logs.push(value('--logs'));
    else if (arg === '--stats' || arg.startsWith('--stats=')) stats = value('--stats');
    else if (arg === '--out' || arg.startsWith('--out=')) out = value('--out');
    else if (arg === '--strength' || arg.startsWith('--strength=')) strength = Number(value('--strength'));
    else if (arg === '--username' || arg.startsWith('--username=')) username = value('--username');
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!Number.isFinite(strength) || strength <= 0) throw new Error(`--strength must be a positive number`);
  if (logs.length === 0) logs.push('logs/ladder', 'live-runs');
  return { help: false, logs, stats, out, strength, username };
}

function printHelp(): void {
  console.log(`npm run priors:rebuild -- [--logs DIR]... [--stats FILE] [--out FILE] [--strength N] [--username NAME]

Recount the opponent's revealed sets from ladder JSONL and replay logs.
The default blend keeps ${DEFAULT_PRIOR_STRENGTH} pseudo-counts from the public randbats table.
`);
}

function main(): void {
  const opts = parseRebuildArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (!fs.existsSync(opts.stats)) {
    throw new Error(`stats file not found: ${opts.stats}`);
  }
  const base = JSON.parse(fs.readFileSync(opts.stats, 'utf8')) as RandbatsStats;
  const result = rebuildObservedPriors({
    base,
    roots: opts.logs,
    out: opts.out,
    priorStrength: opts.strength,
    username: opts.username,
  });
  console.log(`wrote ${opts.out}`);
  console.log(
    `games=${result.file.games} pokemon=${result.file.pokemon} files=${result.filesRead} skipped=${result.skipped} strength=${result.file.priorStrength}`,
  );
}

const entry = process.argv[1] || '';
if (entry.endsWith('rebuild-priors.ts') || entry.endsWith('rebuild-priors.js')) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
