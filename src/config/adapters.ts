import { Battle, BattleStreams } from '@pkmn/sim';
import {
  formatChoice,
  isTeamPreview,
  isWaitRequest,
  strictLegalActions,
  teamPreviewChoice,
} from '../client/choice.js';
import type { SideId } from '../engine/exact/battle-utils.js';
import type { AttributedDecision, LiveBattleBridge } from './interfaces.js';
import type { BuiltBot } from './bot.js';

/** In-process self-play. The battle object is the one the harness is playing. */
export class SelfplayAdapter {
  constructor(readonly bot: BuiltBot) {}

  decide(battle: Battle, side: SideId): Promise<AttributedDecision> {
    return this.bot.decide({ battle, side });
  }
}

/**
 * Local Pokemon Showdown server path. The server's input log is replayed
 * through BattleStream, then the same `bot.decide` runs.
 */
export class LocalServerAdapter {
  constructor(readonly bot: BuiltBot) {}

  decideFromInputLog(inputLog: string, side: SideId): Promise<AttributedDecision> {
    return this.bot.decide({ battle: battleFromInputLog(inputLog), side });
  }

  decideFromSnapshot(snapshotJson: string, side: SideId): Promise<AttributedDecision> {
    return this.bot.decide({ battle: Battle.fromJSON(JSON.parse(snapshotJson)), side });
  }
}

export function battleFromInputLog(inputLog: string): Battle {
  const stream = new BattleStreams.BattleStream({ keepAlive: true });
  stream.write(inputLog);
  if (!stream.battle) throw new Error('input log did not create a battle');
  return stream.battle;
}

export const inputLogBridge: LiveBattleBridge = {
  reconstruct(input) {
    if (!input.log.includes('>start ')) return null;
    try {
      return battleFromInputLog(input.log);
    } catch {
      return null;
    }
  },
};

export interface DeliveredChoice {
  choice: string | null;
  fallback: boolean;
}

/**
 * A legal choice taken from the raw request. Wait requests send nothing.
 * Team preview uses the natural team order. Otherwise the first legal move,
 * then the first legal switch, then the server's own default.
 */
export function fallbackChoice(request: unknown): string | null {
  if (isWaitRequest(request)) return null;
  const preview = teamPreviewChoice(request);
  if (preview) return preview;
  const rqid = typeof (request as { rqid?: unknown })?.rqid === 'number'
    ? (request as { rqid: number }).rqid
    : undefined;
  const legal = strictLegalActions(request);
  const move = legal.find(action => action.type === 'move') ?? legal[0];
  if (!move) return 'default';
  return formatChoice(move, rqid);
}

function requestAllows(choice: string, request: unknown): boolean {
  if (isWaitRequest(request)) return false;
  const bare = choice.split('|')[0];
  if (isTeamPreview(request)) {
    const preview = teamPreviewChoice(request);
    return Boolean(preview) && bare === preview!.split('|')[0];
  }
  return strictLegalActions(request).some(action => formatChoice(action) === bare);
}

/** Ladder / local-server session. A missing sim still yields a legal choice. */
export class LadderSession {
  private attached = new Map<string, { battle: Battle; side: SideId }>();

  constructor(
    readonly bot: BuiltBot,
    private bridge: LiveBattleBridge = inputLogBridge,
    private variantId?: string
  ) {}

  attach(room: string, battle: Battle, side: SideId): void {
    this.attached.set(room, { battle, side });
  }

  async onRequest(room: string, request: unknown, log: string, side: SideId): Promise<DeliveredChoice> {
    if (isWaitRequest(request)) return { choice: null, fallback: false };
    const fallback = fallbackChoice(request);
    try {
      const known = this.attached.get(room);
      const battle = known?.battle ?? this.bridge.reconstruct({ room, log, request, side });
      if (!battle) return { choice: fallback, fallback: true };
      const decision = await this.bot.decide({
        battle,
        side: known?.side ?? side,
        gameId: room,
        variantId: this.variantId,
      });
      if (!requestAllows(decision.choice, request)) return { choice: fallback, fallback: true };
      return { choice: decision.choice, fallback: false };
    } catch {
      return { choice: fallback, fallback: true };
    }
  }
}
