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
  fallbackStats?: {
    fallbackCount: number;
    totalCalls: number;
    fallbackRate: number;
  };
}

export class SelfPlayHarness {
  private logger: BattleLogger;

  constructor(logger: BattleLogger) {
    this.logger = logger;
  }

  async runGames(config: SelfPlayConfig): Promise<SelfPlayResult & { lastLog?: string }> {
    let bot1Wins = 0;
    let bot2Wins = 0;
    let ties = 0;
    let lastLog = '';
    let totalFallbackCount = 0;
    let totalSimCalls = 0;

    console.log(`Starting ${config.numGames} self-play games...`);
    console.log(`Bot 1: ${config.bot1Type} vs Bot 2: ${config.bot2Type}`);

    for (let i = 0; i < config.numGames; i++) {
      if (config.verbose || i % 10 === 0) {
        console.log(`Game ${i + 1}/${config.numGames}`);
      }

      const result = await this.runSingleGame(config, i);
      lastLog = result.log;
      
      if (result.winner === 'p1') bot1Wins++;
      else if (result.winner === 'p2') bot2Wins++;
      else ties++;
      
      if (result.fallbackStats) {
        totalFallbackCount += result.fallbackStats.fallbackCount;
        totalSimCalls += result.fallbackStats.totalCalls;
      }

      if (config.verbose || (i + 1) % 10 === 0) {
        const currentWinRate = bot1Wins / (i + 1);
        console.log(`  Current win rate: ${(currentWinRate * 100).toFixed(1)}% (${bot1Wins}-${bot2Wins}-${ties})`);
      }
    }

    const winRate = bot1Wins / config.numGames;
    const fallbackRate = totalSimCalls > 0 ? totalFallbackCount / totalSimCalls : 0;

    console.log('\n=== Final Results ===');
    console.log(`Bot 1 (${config.bot1Type}): ${bot1Wins} wins`);
    console.log(`Bot 2 (${config.bot2Type}): ${bot2Wins} wins`);
    console.log(`Ties: ${ties}`);
    console.log(`Win rate: ${(winRate * 100).toFixed(2)}%`);
    
    if (config.bot1Type === 'mcts' || config.bot2Type === 'mcts') {
      console.log(`\n=== Simulation Stats ===`);
      console.log(`Total sim calls: ${totalSimCalls}`);
      console.log(`Fallback count: ${totalFallbackCount}`);
      console.log(`Fallback rate: ${(fallbackRate * 100).toFixed(2)}%`);
    }

    return {
      bot1Wins,
      bot2Wins,
      ties,
      totalGames: config.numGames,
      winRate,
      lastLog,
      fallbackStats: totalSimCalls > 0 ? {
        fallbackCount: totalFallbackCount,
        totalCalls: totalSimCalls,
        fallbackRate,
      } : undefined,
    };
  }

  private async runSingleGame(
    config: SelfPlayConfig,
    gameIndex: number
  ): Promise<{ 
    winner: 'p1' | 'p2' | 'tie'; 
    log: string;
    fallbackStats?: { fallbackCount: number; totalCalls: number; fallbackRate: number };
  }> {
    return new Promise((resolve) => {
      const streams = BattleStreams.getPlayerStreams(new BattleStreams.BattleStream());
      const spec = { formatid: 'gen9randombattle' as ID };
      
      const teamGen = TeamGenerators.getTeamGenerator('gen9randombattle');
      const team1 = teamGen.getTeam();
      const team2 = teamGen.getTeam();
      
      const p1spec = { name: 'Bot1', team: Teams.pack(team1) };
      const p2spec = { name: 'Bot2', team: Teams.pack(team2) };

      let bot1Instance: any = null;
      let bot2Instance: any = null;

      if (config.bot1Type === 'random') {
        const p1 = new RandomPlayerAI(streams.p1);
        void p1.start();
      } else {
        void (async () => {
          bot1Instance = await this.setupCustomBot(streams.p1, config.bot1Type);
        })();
      }

      if (config.bot2Type === 'random') {
        const p2 = new RandomPlayerAI(streams.p2);
        void p2.start();
      } else {
        void (async () => {
          bot2Instance = await this.setupCustomBot(streams.p2, config.bot2Type);
        })();
      }

      let winner: 'p1' | 'p2' | 'tie' = 'tie';
      const fullLog: string[] = [];

      void (async () => {
        for await (const chunk of streams.omniscient) {
          // Capture every line from omniscient stream
          fullLog.push(chunk);
          
          const lines = chunk.split('\n');
          
          for (const line of lines) {
            if (line.startsWith('|win|')) {
              winner = line.includes('Bot1') ? 'p1' : 'p2';
              // Wait a bit for any final messages
              await new Promise(r => setTimeout(r, 50));
              
              // Collect fallback stats from bot1 if it's an MCTS bot
              const fallbackStats = bot1Instance?.getFallbackStats?.() || bot2Instance?.getFallbackStats?.();
              
              resolve({ winner, log: fullLog.join(''), fallbackStats });
              return;
            } else if (line === '|tie' || line.startsWith('|tie|')) {
              await new Promise(r => setTimeout(r, 50));
              
              const fallbackStats = bot1Instance?.getFallbackStats?.() || bot2Instance?.getFallbackStats?.();
              
              resolve({ winner: 'tie', log: fullLog.join(''), fallbackStats });
              return;
            }
          }
        }
        
        const fallbackStats = bot1Instance?.getFallbackStats?.() || bot2Instance?.getFallbackStats?.();
        resolve({ winner, log: fullLog.join(''), fallbackStats });
      })();

      void streams.omniscient.write(`>start ${JSON.stringify(spec)}
>player p1 ${JSON.stringify(p1spec)}
>player p2 ${JSON.stringify(p2spec)}`);
    });
  }

  private async setupCustomBot(stream: any, botType: string): Promise<any> {
    const bot = await this.createBot(botType);
    let requestCount = 0;
    let errorCount = 0;
    const opponentTeam = new Map<string, any>();
    let opponentActive: string | null = null;
    
    void (async () => {
      try {
        for await (const chunk of stream) {
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (line.startsWith('|error|')) {
              errorCount++;
              if (errorCount <= 5) {
                console.error(`Bot error ${errorCount}: ${line}`);
              }
            }
            
            if (line.startsWith('|switch|') || line.startsWith('|drag|')) {
              const parts = line.split('|');
              if (parts.length >= 4) {
                const player = parts[2];
                if (player.startsWith('p2') || player.startsWith('foe')) {
                  const details = parts[3];
                  const species = details.split(',')[0].trim();
                  opponentActive = species;
                  opponentTeam.set(player, { species, details });
                }
              }
            }
            
            if (line.startsWith('|request|') && line.length > 10) {
              try {
                requestCount++;
                const request = JSON.parse(line.slice(9));
                if (request.wait) {
                  continue;
                }
                if (request.active || request.forceSwitch) {
                  const actions = this.getLegalActions(request);
                  if (actions.length > 0) {
                    const state = this.buildGameState(request, opponentActive);
                    const action = await bot.selectAction(state, actions);
                    const cmd = this.actionToCommand(action, request);
                    stream.write(cmd);
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
    
    return bot;
  }

  private buildGameState(request: any, opponentActiveSpecies: string | null): GameState {
    const myTeam = request.side?.pokemon?.map((p: any, i: number) => {
      const species = p.ident?.split(':')[1]?.trim().split(',')[0] || p.details?.split(',')[0] || 'Unknown';
      const moves = new Set<string>();
      
      if (p.moves) {
        for (const moveName of p.moves) {
          moves.add(moveName);
        }
      }
      
      if (i === 0 && request.active?.[0]?.moves) {
        for (const move of request.active[0].moves) {
          if (move.id || move.move) {
            moves.add(move.id || move.move);
          }
        }
      }
      
      return {
        species,
        level: p.level || 80,
        possibleSets: new Map(),
        revealedMoves: moves,
        stats: p.stats || p.baseStats,
      };
    }) || [];

    const opponentTeam = [{
      species: opponentActiveSpecies || 'Unknown',
      level: 80,
      possibleSets: new Map<string, number>(),
      revealedMoves: new Set<string>(),
    }, ...Array(5).fill(null).map(() => ({
      species: 'Unknown',
      level: 80,
      possibleSets: new Map<string, number>(),
      revealedMoves: new Set<string>(),
    }))];

    // Extract player ID from request
    const playerId: 'p1' | 'p2' = request.side?.id || 'p1';

    return {
      myTeam,
      opponentTeam,
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
      playerId,
    };
  }

  private async createBot(type: string): Promise<any> {
    switch (type) {
      case 'random':
        return new RandomBot();
      case 'maxdamage':
        return new MaxDamageBot();
      case 'mcts':
        // Import gen9 format dynamically
        const { gen9RandomBattle } = await import('../formats/gen9-randombattle.js');
        const config: BotConfig = {
          searchTimeMs: 1200,
          searchIterations: 100,
          explorationConstant: 1.4,
          sampledWorlds: 4,
          useTeraHeuristic: true,
          useLLMPrior: false,
        };
        const bot = new Bot(config, gen9RandomBattle, this.logger);
        return bot;
      default:
        return new RandomBot();
    }
  }

  private getLegalActions(request: any): Action[] {
    const actions: Action[] = [];

    if (request.forceSwitch) {
      if (request.side && request.side.pokemon) {
        const activeIndex = request.side.pokemon.findIndex((p: any) => p.active);
        
        for (let i = 0; i < request.side.pokemon.length; i++) {
          if (i === activeIndex) continue;
          const mon = request.side.pokemon[i];
          if (mon.condition && !mon.condition.includes('fnt')) {
            actions.push({ type: 'switch', switchIndex: i + 1 });
          }
        }
      }
      
      if (actions.length === 0) {
        for (let i = 2; i <= 6; i++) {
          actions.push({ type: 'switch', switchIndex: i });
        }
      }
      return actions;
    }

    if (request.active && request.active[0]) {
      const active = request.active[0];
      if (active.moves) {
        for (let i = 0; i < active.moves.length; i++) {
          const move = active.moves[i];
          const hasDisabled = move.disabled === true;
          const hasNoPP = move.pp !== undefined && move.pp <= 0;
          if (!hasDisabled && !hasNoPP) {
            actions.push({ type: 'move', moveIndex: i + 1 });
          }
        }
      }

      // Check both trapped and maybeTrapped
      const isTrapped = active.trapped || active.maybeTrapped;
      
      if (request.side && request.side.pokemon && actions.length > 0 && !isTrapped) {
        const activeIndex = request.side.pokemon.findIndex((p: any) => p.active);
        
        for (let i = 0; i < request.side.pokemon.length; i++) {
          if (i === activeIndex) continue;
          const mon = request.side.pokemon[i];
          if (mon.condition && !mon.condition.includes('fnt')) {
            actions.push({ type: 'switch', switchIndex: i + 1 });
          }
        }
      }
    }

    if (actions.length === 0) {
      return [{ type: 'move', moveIndex: 1 }];
    }

    return actions;
  }

  private actionToCommand(action: Action, request: any): string {
    if (action.type === 'move') {
      let cmd = `move ${action.moveIndex}`;
      if (action.terastallize && request.active?.[0]?.canTerastallize) {
        cmd += ' terastallize';
      }
      return cmd;
    } else {
      return `switch ${action.switchIndex}`;
    }
  }
}
