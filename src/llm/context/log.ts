import type { LogSummary } from './types.js';

const KEEP = /^\|(?:move|switch|drag|faint|-terastallize|-ability|-item|-enditem|-weather|-fieldstart|-sidestart|-status|-boost)\|/;

/**
 * Public log only. A hard switch is a voluntary `|switch|` after turn 1
 * that is not a faint replacement and not a drag.
 */
export function readLog(lines: readonly string[], foeSide: 'p1' | 'p2'): LogSummary {
  const foe = `${foeSide}a:`;
  let turn = 0;
  let foeFainted = false;
  let opponentHardSwitches = 0;
  let opponentStays = 0;
  let opponentForcedSwitches = 0;
  let lastOpponentSwitchTurn: number | null = null;
  const recent: string[] = [];

  for (const line of lines) {
    if (line.startsWith('|turn|')) {
      turn = Number(line.slice(6)) || turn;
      foeFainted = false;
    } else if (line.startsWith('|faint|') && line.includes(foe)) {
      foeFainted = true;
    } else if ((line.startsWith('|switch|') || line.startsWith('|drag|')) && line.includes(foe)) {
      if (turn >= 1) {
        if (line.startsWith('|drag|') || foeFainted) opponentForcedSwitches++;
        else {
          opponentHardSwitches++;
          lastOpponentSwitchTurn = turn;
        }
      }
      foeFainted = false;
    } else if (line.startsWith('|move|') && line.includes(foe) && turn >= 1) {
      opponentStays++;
    }

    if (KEEP.test(line)) recent.push(compactLine(line));
  }

  return {
    recent: recent.slice(-12),
    opponentHardSwitches,
    opponentStays,
    opponentForcedSwitches,
    lastOpponentSwitchTurn,
  };
}

function compactLine(line: string): string {
  return line.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
}

export function emptyLog(): LogSummary {
  return {
    recent: [],
    opponentHardSwitches: 0,
    opponentStays: 0,
    opponentForcedSwitches: 0,
    lastOpponentSwitchTurn: null,
  };
}
