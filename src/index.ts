export { Bot } from './bot/bot.js';
export { buildBot } from './config/bot.js';
export { specForAlias } from './config/aliases.js';
export { ENV_PROFILES } from './config/env.js';
export type { BotSpec, LiveBattleBridge } from './config/interfaces.js';
export { ShowdownClient } from './client/showdown-client.js';
export { BattleLogger } from './learning/battle-logger.js';
export { SelfPlayHarness } from './learning/self-play.js';
export { BeliefTracker } from './engine/belief-tracker.js';
export {
  SetInference,
  inferenceFromBelief,
  inferenceFromFoes,
  probabilityOf,
  sampleWorlds,
  toPokemonSet,
  topOf,
} from './engine/set-inference/index.js';
export type {
  ConcretePokemon,
  FoeSketch,
  OpponentWorld,
  RevealEvent,
} from './engine/set-inference/index.js';
export { MCTSEngine } from './engine/mcts.js';
export { Evaluator } from './engine/evaluator.js';
export { DamageCalculator } from './engine/damage-calc.js';
export { RandomBot } from './baselines/random-bot.js';
export { MaxDamageBot } from './baselines/max-damage-bot.js';
export { dataLoader } from './data/data-loader.js';
export { createLLMClient } from './utils/llm-client.js';
export {
  GatewayClient,
  JevAdvisor,
  LossReviewer,
  chooseAction,
  DEFAULT_REVIEWER_MODEL_ID,
  JEV_MODEL_ID,
  resolveReviewerModel,
} from './llm/index.js';

export * from './types/index.js';
