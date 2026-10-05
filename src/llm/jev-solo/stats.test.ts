import { absorb, emptyTotals, mergeTotals, percentile, rate, wilson, type JevTrace } from './stats.js';

function trace(partial: Partial<JevTrace>): JevTrace {
  return {
    fallback: false,
    called: true,
    hardSwitch: false,
    tera: false,
    teraLegal: false,
    switchLegal: false,
    latencyMs: 100,
    costUsd: 0.01,
    design: 'choice',
    blocks: [],
    briefChars: 0,
    ...partial,
  };
}

test('wilson interval contains the observed rate', () => {
  const [low, high] = wilson(60, 100);
  expect(low).toBeGreaterThan(0.49);
  expect(high).toBeLessThan(0.7);
  expect(low).toBeLessThan(0.6);
  expect(high).toBeGreaterThan(0.6);
  expect(wilson(0, 0)).toEqual([0, 1]);
});

test('traces fold into totals and percentiles', () => {
  const total = emptyTotals();
  absorb(total, trace({ hardSwitch: true, switchLegal: true, latencyMs: 40 }));
  absorb(total, trace({ fallback: true, called: false, tera: true, teraLegal: true, latencyMs: 900, costUsd: 0 }));
  expect(total.decisions).toBe(2);
  expect(total.calls).toBe(1);
  expect(total.failures).toBe(1);
  expect(total.hardSwitches).toBe(1);
  expect(total.teras).toBe(1);
  expect(total.latenciesMs).toEqual([40]);
  const merged = mergeTotals([total, emptyTotals()]);
  expect(merged.decisions).toBe(2);
  expect(percentile([10, 20, 30, 40], 50)).toBe(20);
  expect(percentile([], 95)).toBe(0);
  expect(rate(1, 4)).toBe('25.0% (1/4)');
  expect(rate(0, 0)).toBe('n/a');
});
