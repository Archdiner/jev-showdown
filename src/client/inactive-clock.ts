import { toID } from './ids.js';

/**
 * Our turn clock from one Showdown inactive line.
 *
 * `undefined` means the line is not our clock (leave `secondsLeft` alone).
 * `null` means the battle timer was turned off.
 * A number is seconds left this turn, from the private `Time left:` line or
 * from a public line that names us.
 */
export function ourClockUpdate(line: string, username: string): number | null | undefined {
  const off = line.startsWith('|inactiveoff|');
  if (!off && !line.startsWith('|inactive|')) return undefined;
  const body = line.slice(off ? '|inactiveoff|'.length : '|inactive|'.length);
  if (off && /timer is now off/i.test(body)) return null;

  // Sent only to the player who has to move:
  // |inactive|Time left: 150 sec this turn | 150 sec total | 60 sec grace
  const timeLeft = body.match(/^Time left:\s*(\d+)\s+sec(?:ond)?s?\b/i);
  if (timeLeft) return Number(timeLeft[1]);

  // |inactive|NAME has 20 seconds left.
  // |inactive|NAME has 20 seconds left this turn.
  const named = body.match(/^(.*?) has (\d+) seconds left\b/i);
  if (named) {
    const who = named[1].trim();
    if (toID(who) === toID(username) || /^you$/i.test(who)) return Number(named[2]);
    return undefined;
  }

  const youHave = body.match(/^You have (\d+) seconds left\b/i);
  if (youHave) return Number(youHave[1]);
  return undefined;
}
