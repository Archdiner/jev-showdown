import { Battle as ClientBattle } from '@pkmn/client';
import { Generations } from '@pkmn/data';
import { Dex } from '@pkmn/dex';
import { Battle as SimBattle } from '@pkmn/sim';
import type { SideId } from '../engine/exact/battle-utils.js';
import { buildDecisionBattle } from './decision-battle.js';
import { livePositionFromClient, type ViewerSide } from './live-position.js';

const gens = new Generations(Dex);

/**
 * `hidden` is what a Showdown client knows. `full` is the omniscient sim,
 * kept so a run can be compared with the old self-play.
 */
export type InformationMode = 'hidden' | 'full';

/** Job field wins. Otherwise `JEV_INFORMATION`. Otherwise hidden. */
export function informationMode(requested?: InformationMode): InformationMode {
  if (requested === 'hidden' || requested === 'full') return requested;
  const env = process.env.JEV_INFORMATION;
  if (env === 'hidden' || env === 'full') return env;
  return 'hidden';
}

/**
 * Protocol lines `side` would see. `|split|` keeps that side's secret line
 * and everyone else's public line, which is how the server addresses HP.
 * Private `|request|` lines are omitted; the caller adds its own request.
 */
export function viewerLines(log: readonly string[], side: ViewerSide): string[] {
  const out: string[] = [];
  for (let i = 0; i < log.length; i++) {
    const line = log[i];
    if (typeof line !== 'string') continue;
    if (line.startsWith('|split|')) {
      const owner = line.slice('|split|'.length);
      const secret = log[i + 1];
      const shared = log[i + 2];
      i += 2;
      const picked = owner === side ? secret : shared;
      if (typeof picked === 'string' && picked && picked !== '|') out.push(picked);
      continue;
    }
    if (!line || line === '|' || line.startsWith('|request|')) continue;
    out.push(line);
  }
  return out;
}

function replayClient(log: readonly string[], side: ViewerSide, request: unknown): ClientBattle {
  const client = new ClientBattle(gens);
  for (const line of viewerLines(log, side)) {
    try {
      client.add(line);
    } catch {
      // BattleDriver skips a protocol line it cannot parse and keeps the rest.
    }
  }
  if (request && typeof request === 'object') {
    try {
      client.add(`|request|${JSON.stringify(request)}`);
    } catch {
      // The request object is still passed to buildDecisionBattle.
    }
  }
  return client;
}

/**
 * The battle the live ladder would search, for one side of a local sim.
 *
 * The viewer log is replayed into `@pkmn/client`. `livePositionFromClient`
 * and `buildDecisionBattle` then run, which is the ladder's opponent-state
 * path. A foe-model change there (randbats priors, unseen placeholders)
 * applies to self-play without a second implementation.
 *
 * p1 of the returned battle is the deciding side. `move N` and `switch N`
 * match that side's request on the real battle.
 */
export function ladderDecisionBattle(battle: SimBattle, side: SideId): SimBattle | null {
  const request = battle.getSide(side).activeRequest;
  if (!request || request.wait || request.teamPreview) return null;
  return decisionBattleFromViewerLog(battle.log.join('\n'), side, request);
}

/** Replay a spectator log and the side's `|request|` into the ladder's decision battle. */
export function decisionBattleFromViewerLog(log: string, side: ViewerSide, request: unknown): SimBattle | null {
  if (!request || typeof request !== 'object') return null;
  const client = replayClient(log.split('\n'), side, request);
  try {
    return buildDecisionBattle(livePositionFromClient(client, request, side));
  } catch {
    return null;
  } finally {
    try {
      client.destroy();
    } catch {
      // The position is already plain data.
    }
  }
}
