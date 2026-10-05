import { Battle, BattleStreams } from '@pkmn/sim';
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

/** Ladder / local-server session. Choices come only from buildBot. */
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

  async onRequest(room: string, request: unknown, log: string, side: SideId): Promise<string> {
    const known = this.attached.get(room);
    const battle = known?.battle ?? this.bridge.reconstruct({ room, log, request, side });
    if (!battle) {
      throw new Error(
        `No sim battle for ${room}. cursor/live-client must implement LiveBattleBridge or call attach().`
      );
    }
    const decision = await this.bot.decide({
      battle,
      side: known?.side ?? side,
      gameId: room,
      variantId: this.variantId,
    });
    return decision.choice;
  }
}
