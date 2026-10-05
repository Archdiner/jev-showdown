import { emptyLog, readLog } from './log.js';

test('lead-in switches are not hard switches', () => {
  const summary = readLog(
    [
      '|switch|p2a: Garchomp|Garchomp, L80|100/100',
      '|switch|p1a: Dragapult|Dragapult, L80|100/100',
      '|turn|1',
      '|move|p2a: Garchomp|Earthquake|p1a: Dragapult',
    ],
    'p2'
  );
  expect(summary.opponentHardSwitches).toBe(0);
  expect(summary.opponentStays).toBe(1);
  expect(summary.lastOpponentSwitchTurn).toBeNull();
});

test('a later voluntary switch counts, a faint replacement does not', () => {
  const summary = readLog(
    [
      '|turn|1',
      '|move|p2a: Garchomp|Earthquake|p1a: Dragapult',
      '|turn|2',
      '|switch|p2a: Corviknight|Corviknight, L84|100/100',
      '|turn|3',
      '|faint|p2a: Corviknight',
      '|switch|p2a: Garchomp|Garchomp, L80|100/100',
      '|drag|p2a: Dragapult|Dragapult, L80|100/100',
    ],
    'p2'
  );
  expect(summary.opponentHardSwitches).toBe(1);
  expect(summary.opponentForcedSwitches).toBe(2);
  expect(summary.opponentStays).toBe(1);
  expect(summary.lastOpponentSwitchTurn).toBe(2);
  expect(emptyLog().opponentHardSwitches).toBe(0);
});
