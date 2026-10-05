import { legalChoices, startRandomBattle, teamsForSeed } from './battle-utils.js';

function opened() {
  const teams = teamsForSeed(7);
  const battle = startRandomBattle(teams.p1, teams.p2, 7);
  if (battle.requestState === 'teampreview') {
    battle.choose('p1', 'default');
    battle.choose('p2', 'default');
  }
  return battle;
}

/**
 * INC-007: a Revival Blessing forced switch was listed as a switch to a
 * healthy teammate. The sim rejects that choice. The legal list is the
 * fainted teammates, and the sim accepts one of them.
 */
describe('INC-007', () => {
  test('legalChoices offers fainted teammates on a Revival Blessing forced switch', () => {
    const battle = opened();
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
    expect(battle.choose('p1', choices[0])).toBe(true);
  });
});
