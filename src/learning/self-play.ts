import { teamsForSeed } from '../engine/exact/battle-utils.js';
import { runGame } from '../bench/game.js';
import type { InformationMode } from '../client/hidden-info.js';
import { specForAlias } from '../config/aliases.js';
import { BattleLogger } from './battle-logger.js';

export interface SelfPlayConfig {
  numGames: number;
  bot1Type: string;
  bot2Type: string;
  seed?: number;
  verbose?: boolean;
  /** `hidden` matches the ladder. `full` is the old omniscient sim. */
  information?: InformationMode;
}

export interface SelfPlayResult {
  bot1Wins: number;
  bot2Wins: number;
  ties: number;
  totalGames: number;
  winRate: number;
  fallbackStats?: {
    fallbackCount: number;
    totalCalls: number;
    fallbackRate: number;
  };
}

/** In-process self-play. Both sides are built with buildBot. */
export class SelfPlayHarness {
  constructor(private logger: BattleLogger) {}

  async runGames(config: SelfPlayConfig): Promise<SelfPlayResult & { lastLog?: string }> {
    void this.logger;
    const p1 = specForAlias(config.bot1Type, 'selfplay');
    const p2 = specForAlias(config.bot2Type, 'selfplay');
    let bot1Wins = 0;
    let bot2Wins = 0;
    let ties = 0;
    let lastLog = '';
    console.log(`Starting ${config.numGames} self-play games...`);
    console.log(`Bot 1: ${config.bot1Type} (${p1.configId}) vs Bot 2: ${config.bot2Type} (${p2.configId})`);

    for (let i = 0; i < config.numGames; i++) {
      if (config.verbose || i % 10 === 0) console.log(`Game ${i + 1}/${config.numGames}`);
      const seed = (config.seed ?? 1) + i;
      const teams = teamsForSeed(seed);
      const result = await runGame({
        index: i,
        seed,
        p1Team: teams.p1,
        p2Team: teams.p2,
        p1,
        p2,
        logProtocol: i === config.numGames - 1,
        information: config.information,
      });
      lastLog = result.log || lastLog;
      if (result.winner === 'p1') bot1Wins++;
      else if (result.winner === 'p2') bot2Wins++;
      else ties++;
      if (config.verbose || (i + 1) % 10 === 0) {
        console.log(`  Current win rate: ${((bot1Wins / (i + 1)) * 100).toFixed(1)}% (${bot1Wins}-${bot2Wins}-${ties})`);
      }
    }

    const winRate = config.numGames ? bot1Wins / config.numGames : 0;
    console.log('\n=== Final Results ===');
    console.log(`Bot 1 (${config.bot1Type}): ${bot1Wins} wins`);
    console.log(`Bot 2 (${config.bot2Type}): ${bot2Wins} wins`);
    console.log(`Ties: ${ties}`);
    console.log(`Win rate: ${(winRate * 100).toFixed(2)}%`);
    return { bot1Wins, bot2Wins, ties, totalGames: config.numGames, winRate, lastLog };
  }
}
