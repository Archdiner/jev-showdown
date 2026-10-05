import { legalChoices, startRandomBattle, teamsForSeed } from '../engine/exact/battle-utils.js';
import { buildDecisionBattle, type LivePosition } from './decision-battle.js';

function opened() {
  const teams = teamsForSeed(7);
  const battle = startRandomBattle(teams.p1, teams.p2, 7);
  if (battle.requestState === 'teampreview') {
    battle.choose('p1', 'default');
    battle.choose('p2', 'default');
  }
  return battle;
}

function positionFrom(battle: ReturnType<typeof opened>): LivePosition {
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

/**
 * Regression: the hidden-info battle dropped the request's `reviving` flag,
 * so search offered a healthy switch while the real sim required a fainted one.
 */
describe('revivalblessing slot', () => {
  test('buildDecisionBattle copies the request reviving flag onto the slot condition', () => {
    const battle = opened();
    const bench = battle.p1.pokemon.find(mon => !mon.isActive);
    const active = battle.p1.active[0];
    if (!bench || !active) throw new Error('need an active and a bench mon');
    bench.hp = 0;
    bench.fainted = true;
    battle.p1.slotConditions[active.position].revivalblessing = { id: 'revivalblessing' } as never;
    active.switchFlag = true;
    battle.makeRequest('switch');

    const request = battle.p1.activeRequest as { side?: { pokemon?: Array<{ reviving?: boolean }> } };
    expect(request.side?.pokemon?.some(mon => mon.reviving)).toBe(true);

    const built = buildDecisionBattle(positionFrom(battle));
    expect(built).not.toBeNull();
    const builtActive = built!.p1.active[0];
    expect(builtActive).toBeTruthy();
    expect(built!.p1.slotConditions[builtActive.position]?.revivalblessing).toBeTruthy();
    expect(legalChoices(built!, 'p1')).toEqual(legalChoices(battle, 'p1'));
  });
});
