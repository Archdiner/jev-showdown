import { GatewayClient } from '../gateway-client.js';
import { renderContextBrief } from '../context-brief.js';
import { assembleBrief, boardFromSim } from '../context/index.js';
import { CONTEXT_BLOCK_IDS } from '../context/types.js';
import { loadGuidance, loadHypotheses } from '../context/meta.js';
import { emptyLog } from '../context/log.js';
import { choiceAllowed, safeChoose, startRandomBattle, teamsForSeed } from '../../engine/exact/battle-utils.js';
import { withTeraChoices } from '../context/board.js';
import { decideBoard } from './engine.js';
import { contextConfigOf, loadJevSoloConfig, withBlock } from './config.js';
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

test('every block is on by default and can be ablated', () => {
  const config = loadJevSoloConfig();
  for (const id of CONTEXT_BLOCK_IDS) {
    expect(config.blocks?.[id]?.enabled).toBe(true);
  }
  const hidden = loadHypotheses() as Array<{ id?: string; change?: string }>;
  const teams = teamsForSeed(50000);
  const battle = startRandomBattle(teams.p1, teams.p2, 50000);
  const fullBoard = boardFromSim(battle, 'p1', {});
  fullBoard.situationBrief = renderContextBrief(battle, 'p1', 2000).text;
  const brief = assembleBrief(fullBoard, contextConfigOf(config));
  expect(brief.blocks.map(block => block.id).sort()).toEqual([...CONTEXT_BLOCK_IDS].sort());
  expect(brief.text).toContain('32.3%');
  expect(brief.text).toContain('tera_rate=79.8%');
  expect(brief.text).toContain('koNow=');
  expect(brief.text).toContain('## sides');
  const guidance = brief.blocks.find(block => block.id === 'meta-guidance')?.text ?? '';
  for (const principle of loadGuidance()) expect(guidance).toContain(principle.id);
  for (const row of hidden) expect(brief.text).toContain(`${row.id}:`);
  expect(brief.text).toContain(hidden[0]?.change ?? 'H01-missing');
  const hazards = brief.blocks.find(block => block.id === 'field')?.text ?? '';
  expect(hazards).toContain('hazards');
  const sets = brief.blocks.find(block => block.id === 'set-inference')?.text ?? '';
  expect(sets.length).toBeGreaterThan(0);

  for (const id of CONTEXT_BLOCK_IDS) {
    const ablated = assembleBrief(fullBoard, contextConfigOf(withBlock(config, id, false)));
    expect(ablated.blocks.some(block => block.id === id)).toBe(false);
  }
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
