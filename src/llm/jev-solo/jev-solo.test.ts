import { describe, expect, it } from '@jest/globals';
import { Teams, Battle } from '@pkmn/sim';
import { TeamGenerators } from '@pkmn/randoms';
import { GatewayClient } from '../gateway-client.js';
import { assembleBrief, boardFromSim, withTeraChoices } from '../context/index.js';
import { loadHypotheses, switchPriorPercent } from '../context/meta.js';
import { decideBoard } from './engine.js';
import { loadJevSoloConfig, withBlock } from './config.js';
import { PLAIN_INSTRUCTION, PLANNER_INSTRUCTION } from './questions.js';
import { wilson } from './stats.js';
import type { BoardInput } from '../context/types.js';
import { emptyLog } from '../context/log.js';

Teams.setGeneratorFactory(TeamGenerators);

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
      threatened: true,
    },
    ...overrides,
  };
}

describe('jev-solo', () => {
  it('loads the selectable config and keeps planner wording free of fixture species', () => {
    const config = loadJevSoloConfig();
    expect(config.id).toBe('jev-solo');
    expect(config.question).toBe('choice');
    expect(config.blocks?.['meta-guidance']?.enabled).toBe(true);
    expect(config.blocks?.['switch-odds']?.enabled).toBe(true);
    expect(PLAIN_INSTRUCTION + PLANNER_INSTRUCTION).not.toMatch(/Garchomp|Rotom/);
  });

  it('puts the top-rated switch prior and a matching principle in the brief', () => {
    expect(switchPriorPercent(1)).toBeCloseTo(32.3);
    const config = loadJevSoloConfig();
    const brief = assembleBrief(board(), { version: 1, blocks: config.blocks });
    const odds = brief.blocks.find(block => block.id === 'switch-odds')?.text ?? '';
    expect(odds).toContain('23.1%');
    expect(odds).toContain('32.3%');
    expect(odds).toContain('phase=turn1 prior=32.3%');
    const guidance = brief.blocks.find(block => block.id === 'meta-guidance')?.text ?? '';
    expect(guidance).toMatch(/G\d+/);
    const hidden = loadHypotheses() as Array<{ change?: string }>;
    expect(brief.text).not.toContain(hidden[0]?.change ?? 'H01-missing');
  });

  it('drops a context block when that block is off', () => {
    const config = withBlock(loadJevSoloConfig(), 'meta-guidance', false);
    const brief = assembleBrief(board(), { version: 1, blocks: config.blocks });
    expect(brief.blocks.some(block => block.id === 'meta-guidance')).toBe(false);
    expect(brief.text).not.toContain('[meta-guidance');
    expect(brief.blocks.some(block => block.id === 'switch-odds')).toBe(true);
  });

  it('follows Jev and falls back to the first legal action', async () => {
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

  it('hides unrevealed bench and unrevealed foe items, and offers tera', () => {
    const gen = Teams.getGenerator('gen9randombattle', [4, 5, 6, 7] as any);
    const battle = new Battle({ formatid: 'gen9randombattle' as any, seed: [4, 7, 11, 13] as any });
    battle.setPlayer('p1', { name: 'P1', team: gen.getTeam() });
    battle.setPlayer('p2', { name: 'P2', team: gen.getTeam() });
    const hidden = battle.p2.pokemon
      .filter(mon => !(mon as { previouslySwitchedIn?: number }).previouslySwitchedIn)
      .map(mon => mon.species.name);
    expect(hidden.length).toBeGreaterThan(0);
    const brief = assembleBrief(boardFromSim(battle, 'p1', {}), { version: 1, blocks: { 'set-inference': { enabled: false }, 'damage-matrix': { enabled: false }, 'switch-ins': { enabled: false }, 'win-conditions': { enabled: false } } });
    for (const species of hidden) expect(brief.text).not.toContain(species);
    const sides = brief.blocks.find(block => block.id === 'sides')?.text ?? '';
    expect(sides).toContain('item=unknown');
    expect(withTeraChoices(battle, 'p1').some(choice => choice.endsWith('terastallize'))).toBe(true);
  });

  it('reports a Wilson interval', () => {
    const [low, high] = wilson(60, 100);
    expect(low).toBeGreaterThan(0.5);
    expect(high).toBeLessThan(0.7);
  });
});
