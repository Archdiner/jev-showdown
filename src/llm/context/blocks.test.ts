import { blockById } from './blocks.js';
import { emptyLog } from './log.js';
import { loadGuidance, loadHypotheses, resetMetaCache } from './meta.js';
import { deriveSituation, selectPrinciples } from './situation.js';
import type { BoardInput, BoardMon } from './types.js';

function mon(species: string, slot: number): BoardMon {
  return {
    species,
    slot,
    active: slot === 1,
    fainted: false,
    seen: true,
    level: 80,
    hpPercent: 100,
    boosts: {},
    types: [],
    knownMoves: [],
    moveSlots: slot === 1 ? ['Earthquake'] : [],
    abilityKnown: false,
    itemKnown: false,
    teraKnown: false,
  };
}

function board(): BoardInput {
  return {
    turn: 1,
    player: 'p1',
    foeSide: 'p2',
    myTeam: [mon('Garchomp', 1)],
    opponentTeam: [mon('Blissey', 1)],
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
      { id: 'a0', choice: 'move 1', action: { type: 'move', moveIndex: 1 }, label: 'Earthquake' },
      { id: 'a1', choice: 'switch 2', action: { type: 'switch', switchIndex: 2 }, label: 'switch bench' },
    ],
    pools: {},
    facts: {
      ourAttacks: [],
      foeAttacks: [],
      teraAttacks: [],
      speed: 'speed unknown',
      sets: [],
      threat: 'speed unknown\nactive KO threat: yes',
      threatened: true,
    },
  };
}

beforeEach(() => {
  resetMetaCache();
});

test('switch odds quote the top-rated prior for this turn', () => {
  const block = blockById('switch-odds');
  expect(block).toBeDefined();
  const text = block!.render(board(), { id: 'switch-odds', version: '1', enabled: true, maxChars: 500 });
  expect(text).toContain('23.1%');
  expect(text).toContain('phase=turn1 prior=32.3%');
  expect(text).toContain('threatened');
});

test('turn 1 with a switch and tera selects a matching principle', () => {
  const situation = deriveSituation(board());
  expect(situation.switching).toBe(true);
  expect(situation.canTera).toBe(true);
  const picked = selectPrinciples(loadGuidance(), situation, 500);
  expect(picked.length).toBeGreaterThan(0);
  expect(picked.some(row => row.topic === 'switching' || row.topic === 'tera')).toBe(true);
  const guidance = blockById('meta-guidance')!.render(board(), {
    id: 'meta-guidance',
    version: '1',
    enabled: true,
    maxChars: 1100,
  });
  expect(guidance).toMatch(/G\d+/);
  const hidden = loadHypotheses() as Array<{ change?: string }>;
  expect(guidance).not.toContain(hidden[0]?.change ?? 'H01-missing');
});
