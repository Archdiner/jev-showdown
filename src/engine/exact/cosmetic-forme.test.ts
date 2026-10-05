import { expectedDamage, speciesForCalc } from './max-damage.js';

/**
 * Regression: @smogon/calc throws on a cosmetic forme, and expectedDamage
 * used to swallow that as 0. calcMon must ask speciesForCalc for the name.
 */
describe('cosmetic forme', () => {
  test('Gastrodon-East maps to the base species in calcMon', () => {
    expect(speciesForCalc('Gastrodon-East')).toBe('Gastrodon');
    expect(speciesForCalc('Ogerpon-Wellspring')).toBe('Ogerpon-Wellspring');
    const east = { species: { name: 'Gastrodon-East' }, level: 80, boosts: {}, hp: 300 };
    const base = { species: { name: 'Gastrodon' }, level: 80, boosts: {}, hp: 300 };
    const fromEast = expectedDamage(east, base, 'earthquake');
    const fromBase = expectedDamage(base, base, 'earthquake');
    expect(fromEast).toBeGreaterThan(0);
    expect(fromEast).toBe(fromBase);
  });
});
