import { Battle, BattleStreams, Teams, RandomPlayerAI } from '@pkmn/sim';
import { ID } from '@pkmn/data';
import { TeamGenerators } from '@pkmn/randoms';
import { Bot } from '../bot/bot.js';
import { RandomBot } from '../baselines/random-bot.js';
import { MaxDamageBot } from '../baselines/max-damage-bot.js';
import { BattleLogger } from './battle-logger.js';
import { GameState, Action, BotConfig } from '../types/index.js';

export interface SelfPlayConfig {
  numGames: number;
  bot1Type: 'mcts' | 'random' | 'maxdamage';
  bot2Type: 'mcts' | 'random' | 'maxdamage';
  seed?: number;
  verbose?: boolean;
}

export interface SelfPlayResult {
  bot1Wins: number;
  bot2Wins: number;
  ties: number;
  totalGames: number;
  winRate: number;
}

export class SelfPlayHarness {
  private logger: BattleLogger;

  constructor(logger: BattleLogger) {
    this.logger = logger;
  }

  async runGames(config: SelfPlayConfig): Promise<SelfPlayResult> {
    let bot1Wins = 0;
    let bot2Wins = 0;
    let ties = 0;

    console.log(`Starting ${config.numGames} self-play games...`);
    console.log(`Bot 1: ${config.bot1Type} vs Bot 2: ${config.bot2Type}`);

    for (let i = 0; i < config.numGames; i++) {
      if (config.verbose || i % 10 === 0) {
        console.log(`Game ${i + 1}/${config.numGames}`);
      }

      const result = await this.runSingleGame(config, i);
      
      if (result === 'p1') bot1Wins++;
      else if (result === 'p2') bot2Wins++;
      else ties++;

      if (config.verbose || (i + 1) % 10 === 0) {
        const currentWinRate = bot1Wins / (i + 1);
        console.log(`  Current win rate: ${(currentWinRate * 100).toFixed(1)}% (${bot1Wins}-${bot2Wins}-${ties})`);
      }
    }

    const winRate = bot1Wins / config.numGames;

    console.log('\n=== Final Results ===');
    console.log(`Bot 1 (${config.bot1Type}): ${bot1Wins} wins`);
    console.log(`Bot 2 (${config.bot2Type}): ${bot2Wins} wins`);
    console.log(`Ties: ${ties}`);
    console.log(`Win rate: ${(winRate * 100).toFixed(2)}%`);

    return {
      bot1Wins,
      bot2Wins,
      ties,
      totalGames: config.numGames,
      winRate,
    };
  }

  private async runSingleGame(
    config: SelfPlayConfig,
    gameIndex: number
  ): Promise<'p1' | 'p2' | 'tie'> {
    return new Promise((resolve) => {
      const streams = BattleStreams.getPlayerStreams(new BattleStreams.BattleStream());
      const spec = { formatid: 'gen9randombattle' as ID };
      
      const teamGen = TeamGenerators.getTeamGenerator('gen9randombattle');
      const team1 = teamGen.getTeam();
      const team2 = teamGen.getTeam();
      
      const p1spec = { name: 'Bot1', team: Teams.pack(team1) };
      const p2spec = { name: 'Bot2', team: Teams.pack(team2) };

      if (config.bot1Type === 'random') {
        const p1 = new RandomPlayerAI(streams.p1);
        void p1.start();
      } else {
        this.setupCustomBot(streams.p1, config.bot1Type);
      }

      if (config.bot2Type === 'random') {
        const p2 = new RandomPlayerAI(streams.p2);
        void p2.start();
      } else {
        this.setupCustomBot(streams.p2, config.bot2Type);
      }

      let winner: 'p1' | 'p2' | 'tie' = 'tie';

      void (async () => {
        for await (const chunk of streams.omniscient) {
          const lines = chunk.split('\n');
          
          for (const line of lines) {
            if (line.startsWith('|win|')) {
              winner = line.includes('Bot1') ? 'p1' : 'p2';
              resolve(winner);
              return;
            } else if (line === '|tie' || line.startsWith('|tie|')) {
              resolve('tie');
              return;
            }
          }
        }
        resolve(winner);
      })();

      void streams.omniscient.write(`>start ${JSON.stringify(spec)}
>player p1 ${JSON.stringify(p1spec)}
>player p2 ${JSON.stringify(p2spec)}`);
    });
  }

  private setupCustomBot(stream: any, botType: string): void {
    const bot = this.createBot(botType);
    let requestCount = 0;
    
    void (async () => {
      try {
        for await (const chunk of stream) {
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (line.startsWith('|request|') && line.length > 10) {
              try {
                requestCount++;
                const request = JSON.parse(line.slice(9));
                if (request.active || request.forceSwitch) {
                  const actions = this.getLegalActions(request);
                  if (actions.length > 0) {
                    const state = this.buildGameState(request);
                    const action = bot.selectAction(state, actions);
                    stream.write(this.actionToCommand(action, request));
                  }
                }
              } catch (e) {
                console.error(`Error processing request ${requestCount}:`, e);
              }
            }
          }
        }
      } catch (e) {
        console.error('Error in custom bot stream:', e);
      }
    })();
  }

  private buildGameState(request: any): GameState {
    const myTeam = request.side?.pokemon?.map((p: any, i: number) => ({
      species: p.ident.split(':')[1]?.trim() || 'Unknown',
      level: p.level || 80,
      possibleSets: new Map(),
      revealedMoves: new Set(p.moves || []),
      stats: p.stats,
    })) || [];

    return {
      myTeam,
      opponentTeam: Array(6).fill(null).map(() => ({
        species: 'Unknown',
        level: 80,
        possibleSets: new Map(),
        revealedMoves: new Set(),
      })),
      myActive: 0,
      opponentActive: 0,
      turn: 1,
      myTeraUsed: false,
      opponentTeraUsed: false,
      field: {
        trickRoom: false,
        screens: {},
      },
      hazards: {
        my: { stealthRock: false, spikes: 0, toxicSpikes: 0 },
        opponent: { stealthRock: false, spikes: 0, toxicSpikes: 0 },
      },
    };
  }

  private createBot(type: string): any {
    switch (type) {
      case 'random':
        return new RandomBot();
      case 'maxdamage':
        return new MaxDamageBot();
      case 'mcts':
        const config: BotConfig = {
          searchTimeMs: 50,
          searchIterations: 20,
          explorationConstant: 1.4,
          sampledWorlds: 1,
          useTeraHeuristic: true,
          useLLMPrior: false,
        };
        const bot = new Bot(config, this.logger);
        return bot;
      default:
        return new RandomBot();
    }
  }

  private getLegalActions(request: any): Action[] {
    const actions: Action[] = [];

    if (request.active && request.active[0]) {
      const active = request.active[0];
      if (active.moves) {
        for (let i = 0; i < active.moves.length; i++) {
          if (!active.moves[i].disabled) {
            actions.push({ type: 'move', moveIndex: i + 1 });
          }
        }
      }
    }

    if (request.side && request.side.pokemon && !request.forceSwitch) {
      for (let i = 1; i < request.side.pokemon.length; i++) {
        const mon = request.side.pokemon[i];
        if (mon.condition && !mon.condition.includes('fnt')) {
          actions.push({ type: 'switch', switchIndex: i + 1 });
        }
      }
    } else if (request.forceSwitch) {
      for (let i = 1; i < request.side.pokemon.length; i++) {
        const mon = request.side.pokemon[i];
        if (mon.condition && !mon.condition.includes('fnt')) {
          actions.push({ type: 'switch', switchIndex: i + 1 });
        }
      }
    }

    return actions.length > 0 ? actions : [{ type: 'move', moveIndex: 1 }];
  }

  private actionToCommand(action: Action, request: any): string {
    if (action.type === 'move') {
      return `move ${action.moveIndex}`;
    } else {
      return `switch ${action.switchIndex}`;
    }
  }
}
