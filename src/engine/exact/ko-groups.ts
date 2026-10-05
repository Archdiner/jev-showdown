import { Battle, Dex } from '@pkmn/sim';
import { SideId } from './battle-utils.js';
import { damageRolls, expectedDamage } from './max-damage.js';

/**
 * Probability the move KOs the defender.
 * The 16-roll chart supplies P(KO | hit). Accuracy folds misses into the non-KO bucket.
 * Null when the choice is a switch or a status move and there is no damage roll to group.
 */
export function koProbability(battle: Battle, side: SideId, choice: string): number | null {
  if (!choice.startsWith('move ')) return null;
  const attacker = battle.getSide(side).active[0];
  const defender = battle.getSide(side).foe.active[0];
  if (!attacker || !defender || defender.hp <= 0) return null;
  const index = Number(choice.slice(5)) - 1;
  const moveId = attacker.moveSlots[index]?.id;
  if (!moveId) return null;
  const move = Dex.moves.get(moveId);
  if (!move.exists || !move.basePower || move.category === 'Status') return null;
  const weather = (battle.field as { weather?: { id?: string } }).weather?.id;
  const rolls = damageRolls(attacker, defender, moveId, weather);
  if (!rolls || rolls.length === 0) {
    const expected = expectedDamage(attacker, defender, moveId, weather);
    if (expected <= 0) return 0;
    return expected >= defender.hp ? 1 : 0;
  }
  const koRolls = rolls.filter(roll => roll >= defender.hp).length / rolls.length;
  const accuracy = move.accuracy === true || move.accuracy == null ? 1 : Number(move.accuracy) / 100;
  const hit = Number.isFinite(accuracy) ? accuracy : 1;
  return Math.max(0, Math.min(1, koRolls * hit));
}
