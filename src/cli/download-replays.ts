#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { parseReplayLog } from '../client/replay-dataset.js';

interface DownloadOptions {
  format: string;
  minRating: number;
  pages: number;
  out: string;
  delayMs: number;
  help: boolean;
}

interface SearchHit {
  uploadtime: number;
  id: string;
  format: string;
  players: string[];
  rating: number | null;
  private?: number;
}

function parseArgs(argv: string[]): DownloadOptions {
  const opts: DownloadOptions = {
    format: 'gen9randombattle',
    minRating: 1600,
    pages: 1,
    out: 'data/replays/gen9randombattle.jsonl',
    delayMs: 250,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--format') opts.format = next();
    else if (arg === '--min-rating') opts.minRating = Number(next());
    else if (arg === '--pages') opts.pages = Number(next());
    else if (arg === '--out') opts.out = next();
    else if (arg === '--delay-ms') opts.delayMs = Number(next());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function printHelp(): void {
  console.log(`Download public high-Elo gen9randombattle replays and parse them into JSONL.

  npm run replays:download -- --format gen9randombattle --min-rating 1600 --pages 3 --out data/replays/gen9randombattle.jsonl

Uses https://replay.pokemonshowdown.com/search.json?format=gen9randombattle
and pages with the before=<uploadtime> cursor. Each replay is fetched as JSON
and parsed with @pkmn/protocol into species, moves, abilities, items, and tera types.
`);
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function searchPage(format: string, before?: number): Promise<SearchHit[]> {
  const url = new URL('https://replay.pokemonshowdown.com/search.json');
  url.searchParams.set('format', format);
  if (before) url.searchParams.set('before', String(before));
  const hits = await fetchJson(url.toString());
  if (!Array.isArray(hits)) return [];
  return hits as SearchHit[];
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  const seen = new Set<string>();
  const stream = fs.createWriteStream(opts.out, { flags: 'w' });
  let written = 0;
  let before: number | undefined;

  for (let page = 0; page < opts.pages; page++) {
    const hits = await searchPage(opts.format, before);
    if (hits.length === 0) break;
    before = hits[hits.length - 1]?.uploadtime;

    for (const hit of hits) {
      if (!hit?.id || seen.has(hit.id) || hit.private) continue;
      if (hit.rating === null || hit.rating === undefined || hit.rating < opts.minRating) continue;
      seen.add(hit.id);
      await sleep(opts.delayMs);
      const replay = await fetchJson(`https://replay.pokemonshowdown.com/${hit.id}.json`);
      const row = parseReplayLog({
        id: hit.id,
        log: replay.log || '',
        format: replay.format || hit.format,
        formatId: replay.formatid || opts.format,
        rating: replay.rating ?? hit.rating,
        uploadtime: replay.uploadtime ?? hit.uploadtime,
        views: replay.views ?? null,
        players: replay.players || hit.players,
      });
      stream.write(`${JSON.stringify(row)}\n`);
      written += 1;
      console.log(`[replays] ${hit.id} rating=${row.rating} turns=${row.turns} mons=${row.p1.pokemon.length + row.p2.pokemon.length}`);
    }
  }

  await new Promise<void>(resolve => stream.end(() => resolve()));
  console.log(`[replays] wrote ${written} games to ${opts.out}`);
}

main().catch(err => {
  console.error('[replays]', err instanceof Error ? err.message : err);
  process.exit(1);
});
