import { calculate, Pokemon, Move, Field, Result } from '@smogon/calc';
import { Generations } from '@smogon/calc/dist/data';

export interface DamageResult {
  min: number;
  max: number;
  expected: number;
  range: [number, number][];
  koChance: number;
}

export class DamageCalculator {
  private gen = Generations.get(9);

  calculateDamage(
    attacker: Pokemon,
    defender: Pokemon,
    move: Move,
    field?: Field
  ): DamageResult {
    const result = calculate(this.gen, attacker, defender, move, field);

    if (!result.damage || typeof result.damage === 'number') {
      return {
        min: 0,
        max: 0,
        expected: 0,
        range: [],
        koChance: 0,
      };
    }

    const damageArray = result.damage as number[];
    const min = Math.min(...damageArray);
    const max = Math.max(...damageArray);
    const expected = damageArray.reduce((a, b) => a + b, 0) / damageArray.length;

    const range: [number, number][] = damageArray.map(d => [d, (d / defender.maxHP()) * 100]);

    const koChance = result.kochance
      ? Object.values(result.kochance).reduce((sum, val) => sum + (val.chance || 0), 0)
      : 0;

    return {
      min,
      max,
      expected,
      range,
      koChance,
    };
  }

  canOutspeed(mon1Speed: number, mon2Speed: number): boolean {
    return mon1Speed > mon2Speed;
  }

  getSpeedOrder(
    mon1: Pokemon,
    mon2: Pokemon,
    field?: Field
  ): 'first' | 'second' | 'speedTie' {
    const speed1 = mon1.rawStats.spe;
    const speed2 = mon2.rawStats.spe;

    if (speed1 > speed2) return 'first';
    if (speed2 > speed1) return 'second';
    return 'speedTie';
  }

  inferScarf(
    observedSpeed: number,
    baseSpeed: number,
    level: number
  ): boolean {
    const normalSpeed = this.calculateSpeed(baseSpeed, level, 85, 31);
    const scarfSpeed = normalSpeed * 1.5;
    
    return Math.abs(observedSpeed - scarfSpeed) < Math.abs(observedSpeed - normalSpeed);
  }

  private calculateSpeed(
    base: number,
    level: number,
    ev: number,
    iv: number,
    nature: number = 1
  ): number {
    return Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level / 100 + 5) * nature);
  }
}

export const damageCalc = new DamageCalculator();
