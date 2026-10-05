import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAnalyst } from './analyst.js';
import { openDb } from './db.js';
import { gameFromRow, ourSideInLog } from './ingest.js';
import { opsPaths } from './paths.js';
import { countsToPriors, emptyCounts, observeLog } from './priors.js';

function tempPaths() {
  return opsPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-ingest-')));
}

describe('opponent seat', () => {
  test('counts the foe seat and ignores our moves', () => {
    const asP2 = emptyCounts();
    observeLog(
      '|move|p1a: Tackle|p2a: Us\n|move|p2a: Surf|p1a: Foe\n|switch|p2a: Bench|Bench, L80|100/100',
      asP2,
      'p1',
    );
    expect(asP2.physical).toBe(1);
    expect(asP2.special).toBe(0);
    expect(asP2.switch).toBe(0);
    const priors = countsToPriors(asP2);
    expect(priors.physical).toBe(1);
    expect(priors.special).toBe(0);
    expect(priors.switch).toBe(1);

    const both = emptyCounts();
    observeLog('|move|p2a: Surf|p1a: Foe\n|move|p1a: Tackle|p2a: Foe', both, 'each');
    expect(both.physical).toBe(1);
    expect(both.special).toBe(1);
  });

  test('a target mention of p2 is not a switch', () => {
    const counts = emptyCounts();
    observeLog('|move|p1a: Tackle|p2a: Foe', counts, 'p1');
    expect(counts.switch).toBe(0);
    expect(counts.physical).toBe(1);
  });

  test('our seat comes from the player line', () => {
    const log = '|player|p1|Foe|1\n|player|p2|BotAlpha|2\n';
    expect(ourSideInLog(log, 'BotAlpha')).toBe('p2');
    expect(ourSideInLog(log, 'someone-else')).toBeNull();
    expect(ourSideInLog(log, '')).toBeNull();
  });
});

describe('ladder log ingest', () => {
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

  test('a ladder loss is reviewed once and priors follow the foe, including when we are p2', async () => {
    const paths = tempPaths();
    const ladder = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-ladder-'));
    const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-runs-'));
    const replayDir = path.join(ladder, 'replays');
    fs.mkdirSync(replayDir);
    const replayFile = path.join(replayDir, 'game.log');
    fs.writeFileSync(replayFile, [
      '|player|p1|Foe|1',
      '|player|p2|BotAlpha|2',
      '|move|p1a: Tackle|p2a: Us',
      '|move|p2a: Surf|p1a: Foe',
      '|switch|p2a: Bench|Bench, L80|100/100',
      '|win|Foe',
    ].join('\n'));
    const record = {
      schema: 'jev.ladder-game.v1',
      kind: 'ladder-game',
      id: 'battle-1-1',
      battleId: 'battle-1',
      ts: 1,
      username: 'BotAlpha',
      outcome: 'loss',
      localReplayPath: replayFile,
    };
    fs.writeFileSync(path.join(ladder, 'games.jsonl'), `${JSON.stringify(record)}\n`);
    fs.writeFileSync(path.join(ladder, 'BotAlpha-battle-1.jsonl'), `${JSON.stringify({ type: 'turn', turn: 1 })}\n${JSON.stringify({ type: 'result', ...record })}\n{bad\n`);
    fs.writeFileSync(path.join(runs, 'copy.jsonl'), `${JSON.stringify(record)}\n`);
    fs.writeFileSync(path.join(ladder, 'metrics.jsonl'), `${JSON.stringify({ type: 'game', id: 'metrics-loss', outcome: 'loss', log: '|move|p2a: Surf|p1a: Foe' })}\n`);

    const reviewed = await runAnalyst(paths, { once: true, ladderDirs: [ladder, runs] });
    expect(reviewed).toBe(1);
    expect(await runAnalyst(paths, { once: true, ladderDirs: [ladder, runs] })).toBe(0);

    const counts = JSON.parse(fs.readFileSync(`${paths.priors}.counts.json`, 'utf8'));
    expect(counts.games).toBe(1);
    expect(counts.physical).toBe(1);
    expect(counts.special).toBe(0);
    expect(counts.switch).toBe(0);
    const db = openDb(paths);
    const hypotheses = db.getNodesByType('Hypothesis');
    db.close();
    expect(hypotheses.length).toBeGreaterThan(0);
    expect(hypotheses[0].title).not.toMatch(/Tackle|Surf|Foe/);
  });

  test('a row with no seat does not invent a foe, and still records the loss', async () => {
    const paths = tempPaths();
    const ladder = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-ladder-'));
    fs.writeFileSync(path.join(ladder, 'games.jsonl'), `${JSON.stringify({
      kind: 'ladder-game',
      id: 'unknown-side',
      outcome: 'loss',
      log: '|move|p2a: Surf|p1a: Foe\n|move|p1a: Tackle|p2a: Foe',
    })}\n`);
    const reviewed = await runAnalyst(paths, { once: true, ladderDirs: [ladder] });
    expect(reviewed).toBe(1);
    expect(fs.existsSync(paths.priors)).toBe(false);
    const parsed = gameFromRow({
      kind: 'ladder-game',
      id: 'named',
      username: 'BotAlpha',
      outcome: 'win',
      log: '|player|p2|BotAlpha\n|move|p1a: Tackle|p2a: Us',
    }, ladder);
    expect(parsed?.ourSide).toBe('p2');
    expect(parsed?.foeSide).toBe('p1');
  });
});
