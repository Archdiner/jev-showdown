import { PRNG, type Battle } from '@pkmn/sim';
import { buildBot } from '../config/bot.js';
import { loadConfig } from '../config/load.js';
import { cloneBattle, startRandomBattle, teamsForSeed } from '../engine/exact/battle-utils.js';
import { maxDamageChoice } from '../engine/exact/max-damage.js';
import { decide } from '../engine/exact/policies.js';
import { EXACT_1PLY, EXACT_1PLY_QW } from '../engine/exact/search.js';
import { ladderDecisionBattle } from './hidden-info.js';
import { buildDecisionBattle, readBattleEvidence, type LivePosition } from './decision-battle.js';

const SEEDS = [3, 7, 11, 19];
const champion = buildBot('configs/champion.yaml', 'selfplay');

function open(seed: number): Battle {
  const teams = teamsForSeed(seed);
  const battle = startRandomBattle(teams.p1, teams.p2, seed);
  if (battle.requestState === 'teampreview') {
    battle.choose('p1', 'default');
    battle.choose('p2', 'default');
  }
  return battle;
}

function positionFrom(battle: Battle): LivePosition {
  const foe = battle.p2.active[0];
  const bench = battle.p2.pokemon.filter(mon => mon !== foe);
  const snap = (mon: NonNullable<typeof foe>) => ({
    species: mon.species.name,
    level: mon.level,
    hp: mon.hp,
    maxhp: mon.maxhp,
    ability: mon.ability,
    item: mon.item,
    moves: mon.moveSlots.map(slot => slot.id),
    fainted: mon.fainted,
  });
  return {
    request: battle.p1.activeRequest,
    foeActive: foe ? snap(foe) : null,
    foeBench: bench.map(snap),
  };
}

function dirty(position: LivePosition): LivePosition {
  return {
    ...position,
    turn: 9,
    myHazards: ['stealthrock'],
    foeHazards: ['spikes'],
    foeActive: position.foeActive ? { ...position.foeActive, terastallized: 'Fire' } : null,
  };
}

function hazardKeys(side: { sideConditions: Record<string, unknown> }): string[] {
  return Object.keys(side.sideConditions).sort();
}

async function choices(battle: Battle, seed: number) {
  const rng = () => new PRNG([seed, 1, 2, 3] as never);
  const exact = await decide({ kind: 'exact', config: EXACT_1PLY }, cloneBattle(battle), 'p1', rng());
  const quick = await decide({ kind: 'exact', config: EXACT_1PLY_QW }, cloneBattle(battle), 'p1', rng());
  const damage = maxDamageChoice(cloneBattle(battle), 'p1');
  const champ = await champion.decide({ battle: cloneBattle(battle), side: 'p1', rng: rng() });
  return { exact: exact.choice, quick: quick.choice, damage, champ: champ.choice };
}

describe('decision enrichment stays off the default engines', () => {
  it('keeps the hybrid flag off the champion and on the hybrid config', () => {
    const champ = loadConfig('configs/champion.yaml').config;
    const hybrid = loadConfig('configs/hybrid.yaml').config;
    expect(champ.search.id).not.toBe('hybrid');
    expect(champ.hybrid).toBeUndefined();
    expect(hybrid.search.id).toBe('hybrid');
    expect(hybrid.hybrid?.params.enrichDecisionState).toBe(true);
  });

  it('ignores hazards, revealed Tera, and turn unless enrich is set', () => {
    const battle = open(7);
    const clean = buildDecisionBattle(positionFrom(battle));
    const leaked = buildDecisionBattle(dirty(positionFrom(battle)));
    const rich = buildDecisionBattle(dirty(positionFrom(battle)), { enrich: true });
    expect(clean).not.toBeNull();
    expect(leaked).not.toBeNull();
    expect(rich).not.toBeNull();
    if (!clean || !leaked || !rich) return;

    expect(leaked.turn).toBe(clean.turn);
    expect(leaked.turn).not.toBe(9);
    expect(hazardKeys(leaked.p1)).toEqual(hazardKeys(clean.p1));
    expect(hazardKeys(leaked.p2)).toEqual(hazardKeys(clean.p2));
    expect(leaked.p2.active[0]?.terastallized).toBe(clean.p2.active[0]?.terastallized);
    expect(readBattleEvidence(leaked)).toBeNull();

    expect(rich.turn).toBe(9);
    expect(rich.p1.sideConditions.stealthrock).toBeTruthy();
    expect(rich.p2.sideConditions.spikes).toBeTruthy();
    expect(rich.p2.active[0]?.terastallized).toBe('Fire');
    expect(readBattleEvidence(rich)?.turn).toBe(9);
  });

  it('leaves the hidden-info turn off until the hybrid flag is set', () => {
    const battle = open(11);
    battle.turn = 6;
    const plain = ladderDecisionBattle(battle, 'p1');
    const rich = ladderDecisionBattle(battle, 'p1', { enrich: true });
    expect(plain).not.toBeNull();
    expect(rich).not.toBeNull();
    expect(plain!.turn).not.toBe(6);
    expect(rich!.turn).toBe(6);
  });

  it('picks the same moves for exact-1ply, quick wins, max-damage, and the champion', async () => {
    for (const seed of SEEDS) {
      const battle = open(seed);
      const clean = buildDecisionBattle(positionFrom(battle));
      const leaked = buildDecisionBattle(dirty(positionFrom(battle)));
      expect(clean).not.toBeNull();
      expect(leaked).not.toBeNull();
      if (!clean || !leaked) continue;
      expect(await choices(leaked, seed)).toEqual(await choices(clean, seed));
    }
  }, 120000);
});
