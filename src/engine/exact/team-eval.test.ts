import fs from 'fs';
import path from 'path';
import { loadConfig } from '../../config/load.js';
import { ensureLayers } from '../../config/layers/index.js';
import { hasComponent } from '../../config/registry.js';
import { legalChoices, safeChoose, startRandomBattle, teamsForSeed } from './battle-utils.js';
import { maxDamageChoice } from './max-damage.js';
import { fitLogistic, scoreLogistic } from './logistic.js';
import { koProbability } from './ko-groups.js';
import { damageRollChart, speciesForCalc } from './max-damage.js';
import { FITTED_1PLY, FITTED_DEPTH2, exactSearch } from './search.js';
import { fittedModel, fittedTeamEval } from './fitted-eval.js';
import {
  MIN_RANDBATS_SPECIES,
  TEAM_EVAL_FEATURES,
  assertRandbatsSpecies,
  featureRecord,
  randbatsSpeciesCount,
} from './team-features.js';
import { splitForSeed } from './fit-team-eval.js';

function opened(seed: number) {
  const teams = teamsForSeed(seed);
  const battle = startRandomBattle(teams.p1, teams.p2, seed);
  battle.makeChoices('default', 'default');
  return battle;
}

/** A position where p1 has at least two move choices. */
function withMoves(seedStart: number) {
  for (let seed = seedStart; seed < seedStart + 40; seed++) {
    const battle = opened(seed);
    for (let turn = 0; turn < 12 && !battle.ended; turn++) {
      const legal = legalChoices(battle, 'p1');
      const moves = legal.filter(choice => choice.startsWith('move '));
      if (moves.length >= 2) return { battle, legal };
      const p2 = legalChoices(battle, 'p2');
      if (legal.length) safeChoose(battle, 'p1', maxDamageChoice(battle, 'p1', legal));
      if (!battle.ended && p2.length) safeChoose(battle, 'p2', maxDamageChoice(battle, 'p2', p2));
    }
  }
  throw new Error(`no move position from seed ${seedStart}`);
}

describe('fitted team eval', () => {
  test('randbats pool covers at least 500 species', () => {
    expect(randbatsSpeciesCount()).toBeGreaterThanOrEqual(MIN_RANDBATS_SPECIES);
    expect(assertRandbatsSpecies()).toBeGreaterThanOrEqual(MIN_RANDBATS_SPECIES);
  });

  test('features are finite and the logistic weights match them', () => {
    const battle = opened(4);
    const features = featureRecord(battle, 'p1');
    expect(Object.keys(features)).toEqual([...TEAM_EVAL_FEATURES]);
    for (const value of Object.values(features)) expect(Number.isFinite(value)).toBe(true);
    expect(features.bias).toBe(1);
    const model = fittedModel();
    expect(model.features).toEqual([...TEAM_EVAL_FEATURES]);
    expect(model.weights).toHaveLength(TEAM_EVAL_FEATURES.length);
    expect(model.weights.some(weight => weight !== 0)).toBe(true);
    expect(Number.isFinite(fittedTeamEval(battle, 'p1'))).toBe(true);
    const report = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'state', 'models', 'team-eval-fit.json'), 'utf8')) as {
      species: number;
      weights: number[];
      dev: { team: { logLoss: number; constantLogLoss: number; n: number } };
      heldout: { team: { logLoss: number; constantLogLoss: number; n: number } };
    };
    expect(report.species).toBeGreaterThanOrEqual(MIN_RANDBATS_SPECIES);
    expect(report.weights).toEqual(model.weights);
    expect(report.dev.team.n).toBeGreaterThan(100);
    expect(report.heldout.team.n).toBeGreaterThan(100);
    expect(report.dev.team.logLoss).toBeLessThan(report.dev.team.constantLogLoss);
    expect(report.heldout.team.logLoss).toBeLessThan(report.heldout.team.constantLogLoss);
  });

  test('Heavy-Duty Boots remove hazard pressure and Tera spends the resource', () => {
    let battle = opened(1);
    let grounded = false;
    for (let seed = 1; seed <= 30 && !grounded; seed++) {
      battle = opened(seed);
      battle.p1.sideConditions.stealthrock = { id: 'stealthrock' } as never;
      const exposed = battle.p1.pokemon.some(mon => {
        if (!mon || mon.fainted) return false;
        const types: string[] = mon.getTypes?.() || [];
        return !types.includes('Flying') && mon.item !== 'heavydutyboots';
      });
      grounded = exposed;
    }
    expect(grounded).toBe(true);
    battle.p1.sideConditions.stealthrock = { id: 'stealthrock' } as never;
    const before = featureRecord(battle, 'p1').hazardPressure;
    for (const mon of battle.p1.pokemon) mon.item = 'heavydutyboots' as never;
    const after = featureRecord(battle, 'p1').hazardPressure;
    expect(after).toBeGreaterThan(before);

    const teraBefore = featureRecord(battle, 'p1').tera;
    battle.p1.pokemon[0].terastallized = 'Water' as never;
    expect(featureRecord(battle, 'p1').tera).toBeLessThan(teraBefore);
  });

  test('a terminal position is a win or a loss, not a logit', () => {
    const battle = opened(2);
    (battle as { winner?: string; ended?: boolean }).ended = true;
    (battle as { winner?: string }).winner = 'P1';
    expect(fittedTeamEval(battle, 'p1')).toBe(1000);
    expect(fittedTeamEval(battle, 'p2')).toBe(-1000);
  });

  test('logistic regression separates a labeled line and the seed split holds out 20%', () => {
    const examples = [];
    for (let i = 0; i < 40; i++) {
      const label = i % 2;
      examples.push({ features: [1, label ? 2 : -2, 0], label });
    }
    const fitted = fitLogistic(examples, 1, 200);
    const score = scoreLogistic(examples, fitted.weights);
    expect(score.accuracy).toBeGreaterThan(0.9);
    const counts = { train: 0, dev: 0, heldout: 0 };
    for (let seed = 1; seed <= 100; seed++) counts[splitForSeed(seed)]++;
    expect(counts.heldout).toBe(20);
    expect(counts.dev).toBe(20);
    expect(counts.train).toBe(60);
  });

  test('damage rolls collapse to a KO probability in range', () => {
    expect(speciesForCalc('Gastrodon-East')).toBe('Gastrodon');
    expect(damageRollChart([1, 2, 3])).toEqual([1, 2, 3]);
    expect(damageRollChart([[1, 2], [3, 4, 5]])).toEqual([3, 4, 5]);
    const { battle, legal } = withMoves(6);
    const move = legal.find(choice => choice.startsWith('move '));
    expect(move).toBeTruthy();
    const pKo = koProbability(battle, 'p1', move!);
    if (pKo != null) {
      expect(pKo).toBeGreaterThanOrEqual(0);
      expect(pKo).toBeLessThanOrEqual(1);
    }
    expect(koProbability(battle, 'p1', 'switch 2')).toBeNull();
  });
});

describe('selective depth-2', () => {
  test('a zero budget keeps a legal depth-1 move', () => {
    const { battle, legal } = withMoves(8);
    const trace = exactSearch(battle, 'p1', { ...FITTED_DEPTH2, deadlineMs: 1, budgetMs: undefined, samples: 1 });
    expect(legal).toContain(trace.choice);
    expect(trace.depthReached).toBe(1);
    expect(trace.scores.length).toBeGreaterThan(0);
  });

  test('with time left the search deepens and stays legal', () => {
    const { battle, legal } = withMoves(9);
    const trace = exactSearch(battle, 'p1', {
      ...FITTED_DEPTH2,
      budgetMs: 5000,
      selective: { topN: 1, topM: 1 },
      deeperChoices: 1,
      rollGrouping: 'ko',
    });
    expect(legal).toContain(trace.choice);
    expect(trace.depthReached).toBe(2);
    expect(trace.scores.length).toBe(legal.length);
    const again = exactSearch(battle, 'p1', {
      ...FITTED_DEPTH2,
      budgetMs: 5000,
      selective: { topN: 1, topM: 1 },
      deeperChoices: 1,
      rollGrouping: 'ko',
    });
    expect(again.choice).toBe(trace.choice);
  }, 20000);

  test('fitted 1-ply returns one score per legal choice', () => {
    const { battle, legal } = withMoves(5);
    const trace = exactSearch(battle, 'p1', { ...FITTED_1PLY, samples: 1, tera: false });
    expect(trace.scores).toHaveLength(legal.length);
    expect(legal).toContain(trace.choice);
  });
});

describe('config plugs the eval and the depth-2 search', () => {
  beforeAll(() => ensureLayers());

  test('fitted-team and selective-depth2 are registered components', () => {
    expect(hasComponent('evaluator', 'fitted-team')).toBe(true);
    expect(hasComponent('search', 'selective-depth2')).toBe(true);
    const fitted = loadConfig(path.join(process.cwd(), 'configs/examples/evaluator-fitted-team.yaml'));
    const deep = loadConfig(path.join(process.cwd(), 'configs/examples/search-selective-depth2.yaml'));
    expect(fitted.config.evaluator.id).toBe('fitted-team');
    expect(deep.config.search.id).toBe('selective-depth2');
    expect(deep.config.search.params).toMatchObject({ depth: 2, topN: 3, topM: 2, rollGrouping: 'ko' });
    expect(deep.config.evaluator.id).toBe('fitted-team');
  });
});
