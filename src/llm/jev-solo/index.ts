export { JevSoloEngine, decideBoard, jevSoloFromState, jevSoloOnBattle, loadPools, sharedJevClient } from './engine.js';
export { loadJevSoloConfig, normalizeConfig, withBlock, DEFAULT_CONFIG_PATH } from './config.js';
export type { JevSoloConfig, QuestionDesign, CriteriaStyle } from './config.js';
export { absorb, emptyTotals, mergeTotals, percentile, rate, wilson } from './stats.js';
export type { JevTotals, JevTrace } from './stats.js';
