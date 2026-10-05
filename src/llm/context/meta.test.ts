import {
  loadGuidance,
  loadHypotheses,
  loadReplayStats,
  resetMetaCache,
  switchPhase,
  switchPriorPercent,
} from './meta.js';

beforeEach(() => {
  resetMetaCache();
});

test('top-level switch prior follows the published turn bins', () => {
  const stats = loadReplayStats();
  expect(stats?.hi.n).toBe(260);
  expect(stats?.hi.hard_switch_rate).toBeCloseTo(23.1);
  expect(switchPhase(1)).toBe('turn1');
  expect(switchPhase(4)).toBe('early');
  expect(switchPhase(10)).toBe('mid');
  expect(switchPhase(20)).toBe('late');
  expect(switchPriorPercent(1)).toBeCloseTo(32.3);
  expect(switchPriorPercent(4)).toBeCloseTo(32.0);
  expect(switchPriorPercent(10)).toBeCloseTo(26.0);
  expect(switchPriorPercent(20)).toBeCloseTo(19.4);
});

test('principle and hypothesis files are optional', () => {
  expect(loadGuidance()).toEqual([]);
  expect(loadHypotheses()).toEqual([]);
});
