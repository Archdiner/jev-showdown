import { buildBot } from '../config/bot.js';
import type { BotSpec } from '../config/interfaces.js';
import { agreement, devPositions, loadPool } from '../config/positions.js';

/** Dev-split agreement only. The other split is not loaded here. */
export async function scoreDev(spec: BotSpec, poolFile?: string): Promise<number> {
  const dev = devPositions(loadPool(poolFile));
  if (dev.length === 0) return 0;
  const bot = buildBot(spec);
  return agreement(dev, (battle, side) => bot.decide({ battle, side }));
}
