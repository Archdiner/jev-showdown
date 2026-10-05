import { GatewayClient } from '../gateway-client.js';
import { assembleBrief } from '../context/index.js';
import { loadHypotheses } from '../context/meta.js';
import { emptyLog } from '../context/log.js';
import { choiceAllowed, safeChoose, startRandomBattle, teamsForSeed } from '../../engine/exact/battle-utils.js';
import { withTeraChoices } from '../context/board.js';
import { decideBoard } from './engine.js';
import { loadJevSoloConfig, withBlock } from './config.js';
import { PLAIN_INSTRUCTION, PLANNER_INSTRUCTION } from './questions.js';
import type { BoardInput } from '../context/types.js';

function scripted(body: unknown): GatewayClient {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return new GatewayClient({ apiKey: 'test-key', fetchImpl, log: () => {}, perTurnLatencyBudgetMs: 5000 });
}

function board(overrides: Partial<BoardInput> = {}): BoardInput {
  return {
    turn: 1,
    player: 'p1',
    foeSide: 'p2',
    myTeam: [],
    opponentTeam: [],
    myActive: 0,
    opponentActive: 0,
    field: { trickRoom: false, screens: {} },
    hazards: {
      my: { stealthRock: false, spikes: 0, toxicSpikes: 0 },
      opponent: { stealthRock: false, spikes: 0, toxicSpikes: 0 },
    },
    myTeraUsed: false,
    opponentTeraUsed: false,
    canTera: true,
    log: emptyLog(),
    legal: [
      { id: 'a0', choice: 'move 1', action: { type: 'move', moveIndex: 1 }, label: 'Protect' },
      { id: 'a1', choice: 'switch 2', action: { type: 'switch', switchIndex: 2 }, label: 'switch bench' },
    ],
    pools: {},
    facts: {
      ourAttacks: [],
      foeAttacks: [],
      teraAttacks: [],
      speed: 'speed unknown',
      sets: [],
      threat: 'speed unknown',
      threatened: true,
    },
    ...overrides,
  };
}

test('the default config keeps planner wording free of fixture species', () => {
  const config = loadJevSoloConfig();
  expect(config.id).toBe('jev-solo');
  expect(config.question).toBe('choice');
  expect(config.criteria).toBe('planner');
  expect(PLAIN_INSTRUCTION + PLANNER_INSTRUCTION).not.toMatch(/Garchomp|Rotom/);
});

test('the brief includes the switch prior and a principle, not a hypothesis', () => {
  const config = loadJevSoloConfig();
  const brief = assembleBrief(board(), { version: 1, blocks: config.blocks });
  const odds = brief.blocks.find(block => block.id === 'switch-odds')?.text ?? '';
  expect(odds).toContain('32.3%');
  const guidance = brief.blocks.find(block => block.id === 'meta-guidance')?.text ?? '';
  expect(guidance).toMatch(/G\d+/);
  const hidden = loadHypotheses() as Array<{ change?: string }>;
  expect(brief.text).not.toContain(hidden[0]?.change ?? 'H01-missing');
  const off = assembleBrief(board(), { version: 1, blocks: withBlock(config, 'meta-guidance', false).blocks });
  expect(off.blocks.some(block => block.id === 'meta-guidance')).toBe(false);
});

test('Jev is followed, and a failed call plays the first legal action', async () => {
  const picked = await decideBoard(
    board(),
    loadJevSoloConfig(),
    scripted({
      model: 'typesafe-ai/jev',
      answers: { bestAction: { type: 'choice', choice: 'a1', probabilities: { a0: 0.1, a1: 0.9 } } },
      usage: { inputTokens: 20, outputTokens: 1 },
    })
  );
  expect(picked.choice).toBe('switch 2');
  expect(picked.trace.fallback).toBe(false);
  expect(picked.trace.hardSwitch).toBe(true);

  const failed = await decideBoard(
    board(),
    loadJevSoloConfig(),
    new GatewayClient({ apiKey: '', fetchImpl: async () => { throw new Error('should not fetch'); }, log: () => {} })
  );
  expect(failed.choice).toBe('move 1');
  expect(failed.action).toEqual({ type: 'move', moveIndex: 1 });
  expect(failed.trace.fallback).toBe(true);
  expect(failed.trace.error).toBe('missing_api_key');
});

test('a legal tera choice is played instead of the first move', () => {
  const teams = teamsForSeed(4);
  const battle = startRandomBattle(teams.p1, teams.p2, 4);
  const tera = withTeraChoices(battle, 'p1').find(choice => choice.endsWith('terastallize'));
  expect(tera).toBeDefined();
  expect(choiceAllowed(battle, 'p1', tera!)).toBe(true);
  expect(safeChoose(battle, 'p1', tera!)).toBe(true);
});
