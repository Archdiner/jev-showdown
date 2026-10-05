/**
 * One local game of the strategist config through buildBot.
 * No gateway key is required. The local server embeds the sim input log.
 *
 *   npx tsx src/llm/strategist-engine-smoke.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { judge } from '../ops/gatekeeper.js';
import { startLocalServer } from '../ops/local-server.js';
import { runLive } from '../ops/live.js';
import { opsPaths, readJsonl } from '../ops/paths.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strategist-smoke-'));
const priorGraph = process.env.GRAPH_DB;
const priorOps = process.env.OPS_DIR;
delete process.env.GRAPH_DB;
delete process.env.OPS_DIR;
const paths = opsPaths(root);
if (priorGraph === undefined) delete process.env.GRAPH_DB;
else process.env.GRAPH_DB = priorGraph;
if (priorOps === undefined) delete process.env.OPS_DIR;
else process.env.OPS_DIR = priorOps;

const verdict = judge(paths, {
  configPath: 'configs/strategist.yaml',
  action: 'live-approved',
  wins: 250,
  losses: 100,
  invalid: 0,
  crashes: 0,
  diagnostics: { passed: 1, failed: 0, total: 1 },
});
if (!verdict.labeled) {
  console.error(verdict.reason);
  process.exit(1);
}

const server = await startLocalServer(0);
try {
  const summary = await runLive({
    paths,
    local: true,
    server: server.url,
    games: 1,
    runners: 1,
    concurrency: 1,
    username: 'localbot',
    once: true,
    timeoutMs: 90_000,
  });
  const games = readJsonl<{ configPath: string; winner: string }>(paths.liveGames);
  console.log(JSON.stringify({
    games: summary.games,
    rating: summary.rating,
    gxe: summary.gxe,
    configPath: games[0]?.configPath,
    winner: games[0]?.winner,
  }));
  if (summary.games !== 1 || games.length !== 1) process.exit(1);
  if (!games[0].configPath.endsWith('configs/strategist.yaml')) process.exit(1);
} finally {
  await server.close();
}
