import { buildBot, type BuiltBot, type ConfigSource } from './bot.js';
import type { EnvName } from './env.js';
import { buildPositions } from '../engine/exact/diagnostics.js';

/**
 * Existing obvious-move suite. This is a crash/guardrail report only.
 * Sweeps and bandits must not add this pass rate to the tuning score.
 */
export async function obviousMoveGuardrail(source: ConfigSource | BuiltBot, env: EnvName = 'selfplay'): Promise<{
  passed: number;
  failed: number;
  total: number;
  configId: string;
}> {
  const bot = 'decide' in (source as BuiltBot) ? source as BuiltBot : buildBot(source as ConfigSource, env);
  const positions = buildPositions();
  let passed = 0;
  let failed = 0;
  for (const position of positions) {
    const decision = await bot.decide({ battle: position.battle, side: 'p1' });
    if (decision.choice === position.expected) passed++;
    else failed++;
  }
  return { passed, failed, total: positions.length, configId: bot.configId };
}
