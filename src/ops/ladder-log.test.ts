import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { viewerLines } from '../client/hidden-info.js';
import { startRandomBattle, teamsForSeed } from '../engine/exact/battle-utils.js';
import { runAnalyst } from './analyst.js';
import { gameFromRow } from './ingest.js';
import { attachLadderDecisions, findingFromLadderLog, protocolFromGame } from './ladder-log.js';
import { opsPaths } from './paths.js';
import { listJobs } from './queue.js';

function tempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-ladder-log-'));
  const prior = process.env.GRAPH_DB;
  const ops = process.env.OPS_DIR;
  delete process.env.GRAPH_DB;
  delete process.env.OPS_DIR;
  const paths = opsPaths(root);
  if (prior === undefined) delete process.env.GRAPH_DB;
  else process.env.GRAPH_DB = prior;
  if (ops === undefined) delete process.env.OPS_DIR;
  else process.env.OPS_DIR = ops;
  return paths;
}

/** A move request from a seeded random battle, after team preview. */
function moveRequest(seed: number): { request: unknown; replay: string; turn: number } {
  const teams = teamsForSeed(seed);
  const battle = startRandomBattle(teams.p1, teams.p2, seed);
  if (battle.requestState === 'teampreview') {
    battle.choose('p1', 'default');
    battle.choose('p2', 'default');
  }
  const request = JSON.parse(JSON.stringify(battle.p1.activeRequest));
  if (!request || request.teamPreview || request.wait) {
    throw new Error(`seed ${seed} did not reach a move request`);
  }
  const replay = [...viewerLines(battle.log, 'p1'), '|win|p2'].join('\n');
  return { request, replay, turn: battle.turn };
}

describe('ladder per-battle JSONL', () => {
  const savedGateway = process.env.VERCEL_AI_GATEWAY_KEY;
  const savedAi = process.env.AI_GATEWAY_API_KEY;
  beforeEach(() => {
    delete process.env.VERCEL_AI_GATEWAY_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
  });
  afterEach(() => {
    if (savedGateway === undefined) delete process.env.VERCEL_AI_GATEWAY_KEY;
    else process.env.VERCEL_AI_GATEWAY_KEY = savedGateway;
    if (savedAi === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = savedAi;
  });

  test('a turn row with a request object is mined and classed from the choice', async () => {
    const paths = tempPaths();
    const ladder = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-ladder-jsonl-'));
    const replayDir = path.join(ladder, 'replays');
    fs.mkdirSync(replayDir, { recursive: true });
    const battleId = 'gen9randombattle-77';
    const { request, replay, turn } = moveRequest(11);
    const replayPath = path.join(replayDir, `archinder-${battleId}.log`);
    fs.writeFileSync(replayPath, replay);
    const file = path.join(ladder, `archinder-battle-${battleId}.jsonl`);
    const turnRow = {
      ts: 1,
      type: 'turn',
      kind: 'turn',
      battleId,
      turn,
      choice: 'switch 2',
      fallback: false,
      request,
    };
    const result = {
      ts: 2,
      type: 'result',
      schema: 'jev.ladder-game.v1',
      kind: 'ladder-game',
      id: battleId,
      battleId,
      username: 'archinder',
      ourSide: 'p1',
      outcome: 'loss',
      winner: 'p2',
      configId: 'champion-exact-1ply',
      engine: 'search',
      localReplayPath: replayPath,
      logPath: file,
    };
    fs.writeFileSync(file, `${JSON.stringify(turnRow)}\n${JSON.stringify(result)}\n`);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain('|request|');
    expect(text).not.toContain('>start');
    expect(replay).not.toContain('|request|');

    const game = attachLadderDecisions([gameFromRow(result, file)!])[0];
    const protocol = protocolFromGame(game);
    expect(protocol).toContain('|request|');
    const finding = findingFromLadderLog(game.ladderDecisions ?? []);
    expect(finding?.criticalTurn).toBe(turn);
    expect(finding?.mistakeClass).toBe('switch-timing');

    const reviewed = await runAnalyst(paths, { once: true, ladderDirs: [ladder] });
    expect(reviewed).toBe(1);
    const jobs = listJobs(paths);
    expect(jobs.some(job => job.spec.kind === 'position-replay')).toBe(true);
    expect(jobs.some(job => job.spec.variantId === 'switch-timing')).toBe(true);
    expect(jobs.some(job => job.spec.variantId === 'preservation')).toBe(false);
    const notes = fs.readFileSync(paths.dispositions, 'utf8');
    expect(notes).not.toContain('no >start input and no |request|');
  }, 180_000);
});
