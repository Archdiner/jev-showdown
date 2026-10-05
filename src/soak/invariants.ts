import { LadderGameContract, validateGamesJsonl } from '../client/ladder-game-schema.js';

export interface ServerLine {
  roomId: string;
  line: string;
}

export interface ChoiceTrace {
  roomId: string;
  choice: string;
  at: number;
  forwarded: boolean;
  ackedAt: number | null;
}

export interface ReplayLog {
  roomId: string;
  lines: string[];
}

/**
 * What one soak phase observed. Empty `failures` means the phase held.
 * `drainBoundMs` set means this phase must exit on its own within that bound
 * after the drain signal. `null` means the phase was expected to play out.
 */
export interface SoakObservation {
  gamesJsonl: string;
  replays: ReplayLog[];
  serverLines: ServerLine[];
  chooses: ChoiceTrace[];
  /** Forwarded choices must be acknowledged inside this window. */
  choiceAckMs: number;
  drainMs: number | null;
  drainBoundMs: number | null;
  /** Fault mode dropped a choice. The watchdog resend must show up in the battle log. */
  expectWatchdog: boolean;
  sawWatchdog: boolean;
  /** This local server always emits `|rating|elo|gxe`. */
  requireRating: boolean;
  /** Drain phase: the client must stop before playing every requested game. */
  requestedGames: number | null;
  /** Clean and fault phases: at least this many finished records. */
  minimumRecords: number;
}

export function evaluateSoak(observation: SoakObservation): string[] {
  const failures: string[] = [];
  let records: LadderGameContract[] = [];
  try {
    records = validateGamesJsonl(observation.gamesJsonl);
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
    return failures;
  }

  if (records.length < observation.minimumRecords) {
    failures.push(`expected at least ${observation.minimumRecords} game records, found ${records.length}`);
  }

  const ids = new Map<string, number>();
  for (const record of records) {
    ids.set(record.battleId, (ids.get(record.battleId) ?? 0) + 1);
    if (record.invalidChoices !== 0) {
      failures.push(`${record.battleId} invalidChoices=${record.invalidChoices}`);
    }
    if (record.endReason === 'our-timer') {
      failures.push(`${record.battleId} lost on our timer`);
    }
    if (record.turns < 1) {
      failures.push(`${record.battleId} is a phantom 0-turn record`);
    }
    if (record.replayStatus !== 'local-only' || record.replayUrl !== null) {
      failures.push(`${record.battleId} replayStatus=${record.replayStatus} replayUrl=${record.replayUrl}`);
    }
    if (observation.requireRating && (record.eloAfter === null || record.gxe === null)) {
      failures.push(`${record.battleId} missing rating eloAfter=${record.eloAfter} gxe=${record.gxe}`);
    }
  }
  for (const [id, count] of ids) {
    if (count > 1) failures.push(`${id} was recorded ${count} times`);
  }

  const ended = new Set<string>();
  for (const entry of observation.serverLines) {
    if (entry.line.startsWith('|win|') || entry.line === '|tie' || entry.line.startsWith('|tie|')) {
      if (entry.roomId.startsWith('battle-')) ended.add(entry.roomId);
    }
  }
  for (const id of ended) {
    if (!ids.has(id)) failures.push(`ended battle ${id} has no game record`);
  }
  for (const id of ids.keys()) {
    if (!ended.has(id)) failures.push(`phantom record ${id} (the server never ended that room)`);
  }

  failures.push(...misroutedLines(observation.replays, observation.serverLines));
  failures.push(...unackedChoices(observation.chooses, observation.choiceAckMs));

  if (observation.expectWatchdog && !observation.sawWatchdog) {
    failures.push('fault injection dropped a choice and the watchdog did not resend it');
  }

  if (observation.drainBoundMs !== null) {
    if (observation.drainMs === null) {
      failures.push('drain did not finish');
    } else if (observation.drainMs > observation.drainBoundMs) {
      failures.push(`drain took ${observation.drainMs}ms (bound ${observation.drainBoundMs}ms)`);
    }
    if (observation.requestedGames !== null && records.length >= observation.requestedGames) {
      failures.push(`drain played all ${observation.requestedGames} requested games`);
    }
  }

  return failures;
}

export function misroutedLines(replays: ReplayLog[], serverLines: ServerLine[]): string[] {
  const byRoom = new Map<string, string[]>();
  for (const entry of serverLines) {
    if (!entry.roomId.startsWith('battle-')) continue;
    const list = byRoom.get(entry.roomId) ?? [];
    list.push(entry.line);
    byRoom.set(entry.roomId, list);
  }
  const failures: string[] = [];
  const replayByRoom = new Map(replays.map(replay => [replay.roomId, replay.lines]));

  for (const [roomId, lines] of replayByRoom) {
    const own = countLines(byRoom.get(roomId) ?? []);
    for (const line of lines) {
      const left = own.get(line) ?? 0;
      if (left > 0) {
        own.set(line, left - 1);
        continue;
      }
      const elsewhere = [...byRoom.entries()].some(([id, roomLines]) => id !== roomId && roomLines.includes(line));
      if (elsewhere) {
        failures.push(`${roomId} stored a line owned by another room: ${clip(line)}`);
      }
    }
  }

  for (const [roomId, lines] of byRoom) {
    const replay = countLines(replayByRoom.get(roomId) ?? []);
    if (!replayByRoom.has(roomId)) {
      failures.push(`${roomId} received ${lines.length} server lines and no replay log`);
      continue;
    }
    for (const line of lines) {
      const left = replay.get(line) ?? 0;
      if (left > 0) replay.set(line, left - 1);
      else failures.push(`${roomId} did not handle server line: ${clip(line)}`);
    }
  }
  return failures;
}

export function unackedChoices(chooses: ChoiceTrace[], choiceAckMs: number): string[] {
  const failures: string[] = [];
  for (const choice of chooses) {
    if (!choice.forwarded) continue;
    if (choice.ackedAt === null) {
      failures.push(`choice in ${choice.roomId} was not acknowledged: ${clip(choice.choice)}`);
      continue;
    }
    const waited = choice.ackedAt - choice.at;
    if (waited > choiceAckMs) {
      failures.push(`choice in ${choice.roomId} acknowledged in ${waited}ms (bound ${choiceAckMs}ms)`);
    }
  }
  return failures;
}

function countLines(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

function clip(line: string): string {
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}
