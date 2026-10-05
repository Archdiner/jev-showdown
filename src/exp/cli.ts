import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { parse as parseYaml } from 'yaml';
import { loadConfig, toSpec } from '../config/load.js';
import type { BotSpec } from '../config/interfaces.js';
import { obviousMoveGuardrail } from '../config/guardrail.js';
import { generatePositions, poolPath } from '../config/positions.js';
import { RegressionTracker } from '../graph/regression-tracker.js';
import { ablate } from './ablate.js';
import { checkGatekeeper } from './gatekeeper.js';
import { snapshotFromResults } from './metrics.js';
import { diffConfigs } from './mutate.js';
import { playPaired, sideWinRate } from './play.js';
import { ExperimentSpecSchema, type ExperimentSpec } from './spec.js';
import { appendLedger, leaderboard } from './store.js';
import { sweep } from './sweep.js';
import { tournament } from './tournament.js';
import { validateConfigs } from './validate.js';

function opt(argv: string[], name: string): string | undefined {
  const hit = argv.find(arg => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function positional(argv: string[]): string[] {
  return argv.filter(arg => !arg.startsWith('--'));
}

function loadSpec(file: string): ExperimentSpec {
  const text = fs.readFileSync(path.resolve(file), 'utf8');
  const raw = file.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  return ExperimentSpecSchema.parse(raw);
}

function botFromFile(file: string, spec: Pick<ExperimentSpec, 'env' | 'costCapUsd'>): BotSpec {
  return { ...toSpec(loadConfig(file), spec.env), llmCostCapUsd: spec.costCapUsd };
}

function commitSha(): string | undefined {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

function saveSnapshot(configId: string, snap: ReturnType<typeof snapshotFromResults>): void {
  const dir = path.join(process.cwd(), 'state', 'metrics');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${configId}.json`);
  let prior: ReturnType<typeof snapshotFromResults> | null = null;
  if (fs.existsSync(file)) prior = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify(snap, null, 2));
  if (!prior) return;
  const found = new RegressionTracker().detectRegressions(prior, snap);
  if (found.length === 0) {
    console.log(`regression check vs previous ${configId}: none`);
    return;
  }
  for (const row of found) {
    console.log(`regression ${row.metric_path} ${row.severity} ${row.baseline_value} -> ${row.candidate_value}`);
  }
}

async function runSpec(file: string): Promise<void> {
  const spec = loadSpec(file);
  const challengerFile = spec.challenger || spec.base;
  if (!challengerFile) throw new Error(`${spec.id} needs challenger or base`);
  const challenger = botFromFile(challengerFile, spec);
  const opponents = spec.opponent ? [spec.opponent] : spec.panel;
  console.log(`run ${spec.id} configId=${challenger.configId} env=${spec.env} games=${spec.games}`);
  const guardrail = await obviousMoveGuardrail(challenger, spec.env);
  console.log(`guardrail obvious-move ${guardrail.passed}/${guardrail.total} (not a tuning score)`);
  for (const opponentFile of opponents) {
    const opponent = botFromFile(opponentFile, spec);
    const results = await playPaired(challenger, opponent, spec.games, spec.seedStart);
    const rate = sideWinRate(results, challenger.configId);
    const keeper = await checkGatekeeper(challenger);
    const snap = snapshotFromResults(challenger.configId, results, commitSha());
    saveSnapshot(challenger.configId, snap);
    appendLedger({
      ts: Date.now(),
      kind: 'run',
      specId: spec.id,
      configId: challenger.configId,
      configName: challenger.config.name,
      opponentConfigId: opponent.configId,
      games: rate.games,
      wins: rate.wins,
      winRate: rate.winRate,
      heldOutAgreement: keeper.heldOut.agreement ?? undefined,
      liveGames: keeper.live?.games,
    });
    const summary = {
      spec: spec.id,
      configId: challenger.configId,
      opponentConfigId: opponent.configId,
      games: rate.games,
      wins: rate.wins,
      winRate: rate.winRate,
      invalid: results.reduce((sum, game) => sum + game.p1Invalid + game.p2Invalid, 0),
      crashes: results.filter(game => game.crashed).length,
      heldOutPositions: keeper.heldOut.positions,
      heldOutAgreement: keeper.heldOut.agreement,
      live: keeper.live,
      guardrail,
      commit: commitSha(),
    };
    console.log(`EXP_SUMMARY ${JSON.stringify(summary)}`);
  }
}

async function sweepSpec(file: string): Promise<void> {
  const spec = loadSpec(file);
  if (!spec.base) throw new Error(`${spec.id} needs base`);
  if (!spec.axes?.length) throw new Error(`${spec.id} needs axes`);
  const opponentFile = spec.opponent || spec.panel[0];
  const opponent = botFromFile(opponentFile, spec);
  const base = loadConfig(spec.base).config;
  const rows = await sweep({
    base,
    opponent,
    axes: spec.axes,
    method: spec.method ?? 'grid',
    games: spec.games,
    seedStart: spec.seedStart,
    env: spec.env,
    devWeight: spec.devWeight,
    llmCostCapUsd: spec.costCapUsd,
  });
  for (const row of rows) {
    console.log(`${row.score.toFixed(3)} win=${row.winRate.toFixed(3)} dev=${row.devAgreement.toFixed(3)} ${row.name} ${row.configId}`);
    appendLedger({
      ts: Date.now(),
      kind: 'sweep',
      specId: spec.id,
      configId: row.configId,
      configName: row.name,
      opponentConfigId: opponent.configId,
      games: row.games,
      wins: row.wins,
      winRate: row.winRate,
      devAgreement: row.devAgreement,
      tuningScore: row.score,
    });
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = positional(argv.slice(1));
  if (command === 'validate') {
    const report = validateConfigs();
    for (const file of report.ok) console.log(`ok ${file}`);
    for (const error of report.errors) console.error(`FAIL ${error.file}: ${error.message}`);
    if (report.errors.length) process.exit(1);
    console.log(`validated ${report.ok.length} configs`);
    return;
  }
  if (command === 'run') {
    if (!args[0]) throw new Error('usage: exp run <spec>');
    await runSpec(args[0]);
    return;
  }
  if (command === 'sweep') {
    if (!args[0]) throw new Error('usage: exp sweep <spec>');
    await sweepSpec(args[0]);
    return;
  }
  if (command === 'ablate') {
    if (!args[0]) throw new Error('usage: exp ablate <config> [--games=4] [--opponent=configs/panel/random.yaml]');
    const games = Number(opt(argv, 'games') || '4');
    const opponentFile = opt(argv, 'opponent') || 'configs/panel/random.yaml';
    const loaded = loadConfig(args[0]);
    const env = 'gate' as const;
    const opponent = { ...toSpec(loadConfig(opponentFile), env), llmCostCapUsd: 0 };
    const rows = await ablate({
      config: loaded.config,
      opponent,
      games,
      seedStart: 1,
      env,
      llmCostCapUsd: 0,
    });
    for (const row of rows) console.log(`${row.score.toFixed(3)} ${row.label} ${row.configId} win=${row.winRate.toFixed(3)} dev=${row.devAgreement.toFixed(3)}`);
    return;
  }
  if (command === 'tournament') {
    if (args.length < 2) throw new Error('usage: exp tournament <config> <config> ... [--games=4]');
    const games = Number(opt(argv, 'games') || '4');
    const specs = args.map(file => ({ ...toSpec(loadConfig(file), 'gate'), llmCostCapUsd: 0 }));
    const rows = await tournament(specs, games, 1);
    for (const row of rows) console.log(`${row.elo.toFixed(1)} ${row.name} ${row.configId} ${row.wins}/${row.games}`);
    return;
  }
  if (command === 'leaderboard') {
    const rows = leaderboard();
    if (rows.length === 0) console.log('leaderboard empty');
    for (const row of rows) console.log(`${(row.winRate * 100).toFixed(1)}% ${row.wins}/${row.games} ${row.configId}`);
    return;
  }
  if (command === 'diff') {
    if (!args[1]) throw new Error('usage: exp diff <a> <b>');
    const a = loadConfig(args[0]);
    const b = loadConfig(args[1]);
    console.log(`${a.config.name} ${a.configId}`);
    console.log(`${b.config.name} ${b.configId}`);
    const lines = diffConfigs(a.config, b.config);
    if (lines.length === 0) console.log('no differences');
    for (const line of lines) console.log(line);
    return;
  }
  if (command === 'positions') {
    const games = Number(opt(argv, 'games') || '4');
    const maxPositions = Number(opt(argv, 'max') || '24');
    const out = opt(argv, 'out') || poolPath();
    const records = generatePositions({ games, maxPositions, labelDepth: 2, seedStart: 1, outPath: out });
    const held = records.filter(row => row.split === 'held-out').length;
    console.log(`positions ${records.length} held-out ${held} dev ${records.length - held} -> ${out}`);
    return;
  }
  console.log(`usage:
  npm run exp -- validate
  npm run exp -- run <spec>
  npm run exp -- sweep <spec>
  npm run exp -- ablate <config> [--games=4] [--opponent=configs/panel/random.yaml]
  npm run exp -- tournament <config> <config> ... [--games=4]
  npm run exp -- leaderboard
  npm run exp -- diff <a> <b>
  npm run exp -- positions [--games=4] [--max=24]
Sweeps score win rate plus the dev set. Held-out and live results are reported by run only. Promotion is npm run gate.`);
  if (command && command !== 'help') process.exit(1);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
