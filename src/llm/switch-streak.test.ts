import { describe, expect, it } from '@jest/globals';
import { startRandomBattle, teamsForSeed } from '../engine/exact/battle-utils.js';
import { vetoChoice } from './sim-veto.js';
import { noteSwitchChoice, penalizeSwitchScores, switchState } from './switch-streak.js';

describe('switch streak', () => {
  it('charges a repeated switch that does not move the board and lets one pivot stand', () => {
    const scores = [
      { choice: 'switch 4', score: 2 },
      { choice: 'move 1', score: 1.2 },
    ];
    const once = penalizeSwitchScores(scores, 1, false, 1.1);
    const kept = vetoChoice({
      proposal: 'switch 4',
      scores: once,
      margin: 1,
      legal: ['switch 4', 'move 1'],
    });
    expect(kept.choice).toBe('switch 4');

    const again = penalizeSwitchScores(scores, 2, false, 1.1);
    const replaced = vetoChoice({
      proposal: 'switch 4',
      scores: again,
      margin: 1,
      legal: ['switch 4', 'move 1'],
    });
    expect(replaced.choice).toBe('move 1');
    expect(replaced.veto).not.toBeNull();
    expect(penalizeSwitchScores(scores, 4, true, 1.1)).toEqual(scores);
  });

  it('counts consecutive switches on one battle until the foe changes', () => {
    const teams = teamsForSeed(3);
    const battle = startRandomBattle(teams.p1, teams.p2, 3);
    noteSwitchChoice(battle, 'p1', 'switch 4');
    noteSwitchChoice(battle, 'p1', 'switch 4');
    expect(switchState(battle, 'p1').streak).toBe(2);
    expect(switchState(battle, 'p1').progress).toBe(false);
    const foe = battle.p2.active[0];
    if (foe) foe.hp = Math.max(0, foe.hp - Math.ceil(foe.maxhp * 0.2));
    expect(switchState(battle, 'p1').progress).toBe(true);
    expect(switchState(battle, 'p1').streak).toBe(0);
  });
});
