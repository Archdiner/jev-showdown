import { boardFromSim, choiceToAction, withTeraChoices } from './board.js';
import { startRandomBattle, teamsForSeed } from '../../engine/exact/battle-utils.js';

test('the sim board lists our party and only revealed foes', () => {
  const teams = teamsForSeed(4);
  const battle = startRandomBattle(teams.p1, teams.p2, 4);
  const board = boardFromSim(battle, 'p1', {});
  expect(board.myTeam).toHaveLength(6);
  expect(board.opponentTeam.length).toBeGreaterThan(0);
  expect(board.opponentTeam.length).toBeLessThan(6);
  const revealed = new Set(board.opponentTeam.map(mon => mon.species));
  for (const pokemon of battle.p2.pokemon) {
    const seen = !!(pokemon as { previouslySwitchedIn?: number }).previouslySwitchedIn;
    if (!seen) expect(revealed.has(pokemon.species.name)).toBe(false);
  }
  expect(board.legal.length).toBeGreaterThan(1);
  expect(board.legal.some(option => option.choice.startsWith('move'))).toBe(true);
});

test('tera is offered only as an extra copy of a legal move', () => {
  const teams = teamsForSeed(4);
  const battle = startRandomBattle(teams.p1, teams.p2, 4);
  const choices = withTeraChoices(battle, 'p1');
  const teras = choices.filter(choice => choice.endsWith('terastallize'));
  expect(teras.length).toBeGreaterThan(0);
  for (const choice of teras) {
    expect(choices).toContain(choice.replace(' terastallize', ''));
    expect(choiceToAction(choice)).toMatchObject({ type: 'move', terastallize: true });
  }
});
