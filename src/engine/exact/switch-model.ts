import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Battle } from '@pkmn/sim';
import { SideId, legalChoices, moveSlotIndex } from './battle-utils.js';
import {
  SWITCH_FEATURES,
  featureVector,
  rankedSwitches,
  switchFeatureInput,
} from './matchup.js';
import { expectedDamage } from './max-damage.js';

export interface WeightedChoice {
  choice: string;
  prob: number;
}

function loadWeights(): number[] {
  const here = dirname(fileURLToPath(import.meta.url));
  // Prefer the source file so a fit is visible without rebuilding dist.
  const srcFile = resolve(here, '../../../src/engine/exact/switch-weights.json');
  const localFile = resolve(here, 'switch-weights.json');
  const file = existsSync(srcFile) ? srcFile : localFile;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { weights?: number[] };
  const loaded = parsed.weights || [];
  if (loaded.length !== SWITCH_FEATURES.length) {
    throw new Error(`switch weights ${loaded.length} != ${SWITCH_FEATURES.length}`);
  }
  return loaded;
}

const weights = loadWeights();

export function modelWeights(): number[] {
  return weights.slice();
}

export function switchProbability(features: number[]): number {
  let logit = 0;
  for (let i = 0; i < features.length; i++) logit += (weights[i] || 0) * features[i];
  if (logit > 30) return 1;
  if (logit < -30) return 0;
  return 1 / (1 + Math.exp(-logit));
}

/**
 * Mixture of "stay and attack" and "switch to bench mon X".
 * Stay mass is split across moves by expected damage. Switch mass is
 * split across bench mons by matchup margin. This replaces a single
 * max-damage reply inside search.
 */
export function replyDistribution(battle: Battle, side: SideId, legal = legalChoices(battle, side)): WeightedChoice[] {
  const moves = legal.filter(choice => choice.startsWith('move '));
  // Public moves only. The fit never saw the hidden movepool.
  const switches = rankedSwitches(battle, side, false).filter(row => legal.includes(row.choice));
  if (moves.length === 0 && switches.length === 0) {
    return legal.map(choice => ({ choice, prob: 1 / legal.length }));
  }
  if (moves.length === 0) {
    return normalize(switches.map(row => ({ choice: row.choice, prob: Math.exp(row.margin) })));
  }

  const features = featureVector(switchFeatureInput(battle, side));
  if (features.length !== SWITCH_FEATURES.length) {
    throw new Error(`switch features ${features.length} != ${SWITCH_FEATURES.length}`);
  }
  const pSwitch = switches.length > 0 ? switchProbability(features) : 0;
  const stay = 1 - pSwitch;

  const moveWeights = moves.map(choice => ({ choice, prob: Math.max(0.05, moveDamage(battle, side, choice)) }));
  const moveTotal = moveWeights.reduce((sum, row) => sum + row.prob, 0) || 1;
  const switchWeights = switches.map(row => ({ choice: row.choice, prob: Math.exp(row.margin) }));
  const switchTotal = switchWeights.reduce((sum, row) => sum + row.prob, 0) || 1;

  return normalize([
    ...moveWeights.map(row => ({ choice: row.choice, prob: stay * row.prob / moveTotal })),
    ...switchWeights.map(row => ({ choice: row.choice, prob: pSwitch * row.prob / switchTotal })),
  ]);
}

function moveDamage(battle: Battle, side: SideId, choice: string): number {
  const attacker = battle.getSide(side).active[0];
  const defender = battle.getSide(side).foe.active[0];
  if (!attacker || !defender) return 0;
  const index = moveSlotIndex(choice);
  const moveId = attacker.moveSlots[index]?.id;
  if (!moveId) return 0;
  const weather = (battle.field as any).weather?.id as string | undefined;
  return expectedDamage(attacker, defender, moveId, weather);
}

export function pruneReplies(replies: WeightedChoice[], maxReplies: number, minProb: number): WeightedChoice[] {
  const kept = replies
    .filter(reply => reply.prob >= minProb)
    .sort((a, b) => b.prob - a.prob || a.choice.localeCompare(b.choice));
  const capped = kept.slice(0, Math.max(1, maxReplies || kept.length));
  if (capped.length === 0) return replies.slice(0, 1);
  return normalize(capped);
}

function normalize(rows: WeightedChoice[]): WeightedChoice[] {
  const total = rows.reduce((sum, row) => sum + row.prob, 0);
  if (total <= 0) return rows.map(row => ({ choice: row.choice, prob: 1 / rows.length }));
  return rows.map(row => ({ choice: row.choice, prob: row.prob / total }));
}
