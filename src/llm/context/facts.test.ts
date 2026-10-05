import { boardFromSim } from './board.js';
import { buildFacts } from './facts.js';
import { emptyLog } from './log.js';
import { startRandomBattle, teamsForSeed } from '../../engine/exact/battle-utils.js';
import type { BoardInput, BoardMon } from './types.js';

function mon(partial: Partial<BoardMon> & Pick<BoardMon, 'species' | 'slot'>): BoardMon {
  return {
    active: partial.slot === 1,
    fainted: false,
    seen: true,
    level: 80,
    hpPercent: 100,
    boosts: {},
    types: [],
    knownMoves: [],
    moveSlots: [],
    abilityKnown: false,
    itemKnown: false,
    teraKnown: false,
    ...partial,
  };
}

function board(): BoardInput {
  return {
    turn: 1,
    player: 'p1',
    foeSide: 'p2',
    myTeam: [mon({ species: 'Garchomp', slot: 1, moveSlots: ['Earthquake'], knownMoves: ['Earthquake'], ability: 'Rough Skin', abilityKnown: true, item: 'Rocky Helmet', itemKnown: true, teraType: 'Ground', teraKnown: true, nature: 'Serious', evs: { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 } })],
    opponentTeam: [mon({ species: 'Blissey', slot: 1, knownMoves: ['Soft-Boiled'] })],
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
    legal: [],
    pools: {},
  };
}

test('damage rolls use the revealed move and an assumed spread', () => {
  const facts = buildFacts(board());
  const quake = facts.ourAttacks.find(row => row.move === 'Earthquake' && row.defender === 'Blissey');
  expect(quake).toBeDefined();
  expect(quake?.maxPct).toBeGreaterThan(0);
  expect(quake?.text).toContain('dmg=');
  expect(quake?.text).toContain('koNow=no');
  expect(facts.threat).toContain('Garchomp first');
  expect(facts.threat).toContain('active KO threat: unknown');
  const faint = buildFacts({
    ...board(),
    opponentTeam: [{ ...board().opponentTeam[0], hpPercent: 1 }],
  });
  expect(faint.threat).toContain('koNow=yes');
  expect(faint.threat).toContain('active KO threat:');
  expect(facts.teraAttacks.some(row => row.text.includes('tera'))).toBe(true);
  expect(facts.speed).toContain('Garchomp');
  expect(facts.sets.some(row => row.text.includes('no randbats row'))).toBe(true);
});

test('screen-seed openings state speed, damage, and a current-HP KO', () => {
  for (const seed of [50000, 50024, 50049]) {
    const teams = teamsForSeed(seed);
    const battle = startRandomBattle(teams.p1, teams.p2, seed);
    const facts = buildFacts(boardFromSim(battle, 'p1', {}));
    expect(facts.threat.startsWith('speed ')).toBe(true);
    expect(facts.threat).toMatch(/active KO threat: (yes|no|unknown)/);
    if (facts.ourAttacks.some(row => row.maxPct > 0)) expect(facts.threat).toContain('koNow=');
  }
});
