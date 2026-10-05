import * as path from 'path';
import { searchDeadline } from '../../config/bot.js';
import { loadConfig } from '../../config/load.js';
import { exactConfig } from '../../config/layers/search.js';
import { SearchParamsSchema } from '../../config/schema.js';
import { legalChoices, startRandomBattle, teamsForSeed } from './battle-utils.js';
import { exactSearch, searchBudgetExpired } from './search.js';

describe('search budget', () => {
  test('the deadline returns the partial ranking and samples are kept', () => {
    expect(searchBudgetExpired(undefined, 4)).toBe(false);
    expect(searchBudgetExpired(0, 0)).toBe(false);
    expect(searchBudgetExpired(0, 1)).toBe(true);
    expect(searchDeadline(1_000, 2_000, 8_000)).toBe(3_000);
    expect(searchDeadline(1_000, 9_000, 8_000)).toBe(9_000);

    const champion = loadConfig(path.join(process.cwd(), 'configs/champion.yaml'));
    expect(champion.config.search.params.samples).toBe(8);
    const params = SearchParamsSchema.parse({ samples: 8 });
    expect(exactConfig(params, 'max-damage', 'hp', 1, 12)).toMatchObject({
      samples: 8,
      deadlineMs: 12,
      depth: 1,
      errorAsLoss: false,
    });

    const teams = teamsForSeed(3);
    const battle = startRandomBattle(teams.p1, teams.p2, 3);
    battle.makeChoices('default', 'default');
    const legal = legalChoices(battle, 'p1');
    expect(legal.length).toBeGreaterThan(1);
    const stopped = exactSearch(battle, 'p1', {
      depth: 1,
      opponentModel: 'max-damage',
      evalMode: 'hp',
      errorAsLoss: false,
      samples: 8,
      deadlineMs: 0,
    });
    expect(stopped.scores).toHaveLength(1);
    expect(stopped.choice).toBe(stopped.scores[0].choice);
    const full = exactSearch(battle, 'p1', {
      depth: 1,
      opponentModel: 'max-damage',
      evalMode: 'hp',
      errorAsLoss: false,
      samples: 1,
    });
    expect(full.scores).toHaveLength(legal.length);
  });
});
