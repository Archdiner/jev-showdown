import { PRNG } from '@pkmn/sim';
import { decide, specFromId } from '../engine/exact/policies.js';
import { EXACT_1PLY } from '../engine/exact/search.js';
import { cloneBattle, legalChoices, startRandomBattle, teamsForSeed } from '../engine/exact/battle-utils.js';
import { maxDamageChoice } from '../engine/exact/max-damage.js';
import { strictLegalActions } from './choice.js';
import { actionFromChoice, buildDecisionBattle, chooseLive, LivePosition } from './decision-battle.js';
import { ladderConfigId, ladderPolicy, policyHash } from './ladder-engine.js';

function openedBattle() {
  const teams = teamsForSeed(7);
  const battle = startRandomBattle(teams.p1, teams.p2, 7);
  if (battle.requestState === 'teampreview') {
    battle.choose('p1', 'default');
    battle.choose('p2', 'default');
  }
  return battle;
}

function positionFrom(battle: ReturnType<typeof openedBattle>): LivePosition {
  const foe = battle.p2.active[0];
  const bench = battle.p2.pokemon.filter(mon => mon !== foe);
  const snap = (mon: typeof foe) => ({
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

describe('ladder engine factory', () => {
  it('returns the gate champion policy for search and exact', () => {
    const gate = specFromId('champion-exact-1ply');
    const live = ladderPolicy('search');
    expect(ladderConfigId('search')).toBe('champion-exact-1ply');
    expect(live).toEqual(gate);
    expect(policyHash(live)).toBe(policyHash(gate));
    expect(policyHash(live)).toBe(policyHash(specFromId(ladderConfigId('search'))));
    if (live.kind !== 'exact' || gate.kind !== 'exact') throw new Error('expected the exact policy');
    expect(live.config).toBe(EXACT_1PLY);
    expect(live.config).toBe(gate.config);
    expect(live.config.samples).toBe(8);
  });

  it('returns the gate max-damage policy', () => {
    const gate = specFromId('maxdamage-v1');
    const live = ladderPolicy('max-damage');
    expect(ladderConfigId('max-damage')).toBe('maxdamage-v1');
    expect(live).toEqual(gate);
    expect(policyHash(live)).toBe(policyHash(gate));
    expect(live).toEqual({ kind: 'maxdamage' });
  });

  it('plays the same choice as the gate on one battle', async () => {
    const battle = openedBattle();
    const rng = () => new PRNG([7, 11, 13, 17] as any);
    const search = await decide(ladderPolicy('search'), cloneBattle(battle), 'p1', rng());
    const gateSearch = await decide(specFromId('champion-exact-1ply'), cloneBattle(battle), 'p1', rng());
    expect(search.choice).toBe(gateSearch.choice);

    const damage = await decide(ladderPolicy('max-damage'), cloneBattle(battle), 'p1', rng());
    const gateDamage = await decide(specFromId('maxdamage-v1'), cloneBattle(battle), 'p1', rng());
    expect(damage.choice).toBe(gateDamage.choice);
    expect(damage.choice).toBe(maxDamageChoice(cloneBattle(battle), 'p1'));
  });

  it('builds a request-aligned battle and chooses with the gate policy', async () => {
    const battle = openedBattle();
    const position = positionFrom(battle);
    const built = buildDecisionBattle(position);
    expect(built).not.toBeNull();
    if (!built) return;

    const liveMoves = (position.request.active?.[0]?.moves || []).map((move: { id: string }) => move.id);
    expect(built.p1.active[0].moveSlots.map(slot => slot.id)).toEqual(liveMoves);

    const legal = strictLegalActions(position.request);
    expect(legal.length).toBeGreaterThan(1);
    const picked = await chooseLive('search', position, legal);
    const gate = await decide(specFromId('champion-exact-1ply'), cloneBattle(built), 'p1', new PRNG([1, 2, 3, 4] as any));
    expect(picked.action).toEqual(actionFromChoice(gate.choice));
    expect(legalChoices(built, 'p1')).toContain(gate.choice);

    const damage = await chooseLive('max-damage', position, legal);
    expect(damage.action).toEqual(actionFromChoice(maxDamageChoice(cloneBattle(built), 'p1')));

    const steered = legal[legal.length - 1];
    const steeredChoice = steered.type === 'switch' ? `switch ${steered.switchIndex}` : `move ${steered.moveIndex}`;
    const fromConfig = await chooseLive('search', position, legal, {
      decide: async () => ({ choice: steeredChoice, scores: [{ choice: steeredChoice, score: 3 }] }),
    });
    expect(fromConfig.action).toEqual(steered);
    expect(fromConfig.score).toBe(3);
    await expect(chooseLive('search', position, legal, {
      decide: async () => ({ choice: 'move 99' }),
    })).rejects.toThrow(/not legal/);
  });

  it('answers a knockout with a switch', async () => {
    const battle = openedBattle();
    const active = battle.p1.active[0];
    if (!active) throw new Error('no active');
    active.hp = 0;
    active.fainted = true;
    battle.p1.pokemonLeft = battle.p1.pokemon.filter(mon => !mon.fainted).length;
    active.switchFlag = true;
    battle.makeRequest('switch');

    const position = positionFrom(battle);
    const legal = strictLegalActions(position.request);
    expect(legal.every(action => action.type === 'switch')).toBe(true);
    expect(legal.length).toBeGreaterThan(0);

    const picked = await chooseLive('search', position, legal);
    expect(picked.action.type).toBe('switch');
    expect(legal).toContainEqual(picked.action);
  });

  it('revival blessing offers a fainted teammate the sim will accept', () => {
    const battle = openedBattle();
    const bench = battle.p1.pokemon.find(mon => !mon.isActive);
    const active = battle.p1.active[0];
    if (!bench || !active) throw new Error('need an active and a bench mon');
    bench.hp = 0;
    bench.fainted = true;
    battle.p1.slotConditions[active.position].revivalblessing = { id: 'revivalblessing' } as never;
    active.switchFlag = true;
    battle.makeRequest('switch');

    const choices = legalChoices(battle, 'p1');
    expect(choices.length).toBeGreaterThan(0);
    for (const choice of choices) {
      const slot = Number(choice.slice('switch '.length)) - 1;
      expect(battle.p1.pokemon[slot]?.fainted).toBe(true);
    }
    const position = positionFrom(battle);
    const built = buildDecisionBattle(position);
    expect(built).not.toBeNull();
    expect(legalChoices(built!, 'p1')).toEqual(choices);
    expect(battle.choose('p1', choices[0])).toBe(true);
  });
});
