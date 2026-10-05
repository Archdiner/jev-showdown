import { runGame, type GameJob } from '../bench/game.js';
import { teamsForSeed } from '../engine/exact/battle-utils.js';
import { specForAlias } from './aliases.js';

/** Seeds for the frozen champion / stacked-qw-fitted decision traces. */
export const PLUS_PARITY_SEEDS = [5101, 5102];

export interface ParityGame {
  seed: number;
  p1: string;
  p2: string;
  winner: string;
  turns: number;
  choices: string[];
}

/**
 * Play stacked-qw-fitted vs champion (both seats) on fixed seeds, hidden
 * information, and record every choice. Used to prove opt-in configs
 * (stacked-plus, foeBelief, replyModel: switch) leave the default paths of
 * champion and stacked-qw-fitted byte-identical in behaviour.
 */
export async function collectPlusParity(): Promise<ParityGame[]> {
  const champion = specForAlias('champion', 'selfplay');
  const stacked = specForAlias('stacked-qw-fitted', 'selfplay');
  const out: ParityGame[] = [];
  let index = 0;
  for (const seed of PLUS_PARITY_SEEDS) {
    const teams = teamsForSeed(seed);
    for (const [p1, p2] of [[stacked, champion], [champion, stacked]] as const) {
      const job: GameJob = {
        index: index++,
        seed,
        p1Team: teams.p1,
        p2Team: teams.p2,
        p1,
        p2,
        logDecisions: true,
        information: 'hidden',
      };
      const result = await runGame(job);
      out.push({
        seed,
        p1: p1.config.name,
        p2: p2.config.name,
        winner: result.winner,
        turns: result.turns,
        choices: (result.decisions ?? []).map(d => `${d.turn}:${d.side}:${d.configId}:${d.choice}`),
      });
    }
  }
  return out;
}
