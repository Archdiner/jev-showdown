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
  const full = blockById('meta-guidance')!.render(board(), {
    id: 'meta-guidance',
    version: '1',
    enabled: true,
    variant: 'all',
    maxChars: 20000,
  });
  expect(loadGuidance().every(row => full.includes(row.id))).toBe(true);
});

test('decision lines mark a tera-only KO and a survival flip', () => {
  const input = board();
  input.myTeam[0].teraKnown = true;
  input.myTeam[0].teraType = 'Ground';
  input.canTera = true;
  input.myTeam.push({ ...mon('Snorlax', 2), active: false });
  input.legal = [
    { id: 'a0', choice: 'move 1', action: { type: 'move', moveIndex: 1 }, label: 'Earthquake' },
    { id: 'a1', choice: 'move 1 terastallize', action: { type: 'move', moveIndex: 1, terastallize: true }, label: 'Earthquake + tera' },
    { id: 'a2', choice: 'switch 2', action: { type: 'switch', switchIndex: 2 }, label: 'switch Snorlax' },
  ];
  input.facts = {
    ourAttacks: [{ move: 'Earthquake', attacker: 'Garchomp', defender: 'Blissey', text: '', minPct: 20, maxPct: 30 }],
    foeAttacks: [
      { move: 'Ice Beam', attacker: 'Blissey', defender: 'Garchomp', text: '', minPct: 80, maxPct: 120 },
      { move: 'Ice Beam', attacker: 'Blissey', defender: 'Snorlax', text: '', minPct: 10, maxPct: 20 },
    ],
    teraAttacks: [{ move: 'Earthquake', attacker: 'Garchomp', defender: 'Blissey', text: '', minPct: 110, maxPct: 140 }],
    teraDefense: [{ move: 'Ice Beam', attacker: 'Blissey', defender: 'Garchomp', text: '', minPct: 10, maxPct: 30 }],
    speed: 'speed',
    threat: 'threat',
    sets: [],
    threatened: true,
  };
  const text = blockById('decision')!.render(input, { id: 'decision', version: '1', enabled: true, maxChars: 2400 });
  expect(text).toContain('exchange weKO=yes theyKO=yes');
  expect(text).toContain('tera flipsKO=yes flipsSurvival=yes');
  expect(text).toContain('a0 Earthquake koNow=no sure=no');
  expect(text).toContain('a1 Earthquake + tera koNow=yes sure=yes flipsKO=yes');
  expect(text).toContain('a2 switch Snorlax incomingMax=20% koNow=no');
});

test('meta stats quote the top-rated tera and hazard rates', () => {
  const text = blockById('meta-stats')!.render(board(), {
    id: 'meta-stats',
    version: '1',
    enabled: true,
    maxChars: 700,
  });
  expect(text).toContain('n=260');
  expect(text).toContain('tera_rate=79.8%');
  expect(text).toContain('tera_turn_median=20');
  expect(text).toContain('hazards in 53.5%');
});
