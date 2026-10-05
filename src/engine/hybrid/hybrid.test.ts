import { Dex, PRNG } from '@pkmn/sim';
import { HybridParamsSchema } from '../../config/schema.js';
import { GatewayClient } from '../../llm/gateway-client.js';
import { legalChoices, startRandomBattle, teamsForSeed } from '../exact/battle-utils.js';
import { isPlayableChoice } from '../exact/battle-utils.js';
import type { RandbatsStats } from '../../types/index.js';
import { parsePublic } from './protocol.js';
import { regretMatch } from './regret.js';
import { createHybridSearch } from './search.js';
import { judgeMove } from './llm.js';
import { assertRandbatsSpecies, itemAllowed, MIN_RANDBATS_SPECIES, sampleHybridWorlds } from './worlds.js';
import { loadConfig } from '../../config/load.js';
import type { FoeMon } from '../../client/decision-battle.js';

function foe(partial: Partial<FoeMon> & { species: string }): FoeMon {
  return {
    species: partial.species,
    level: 80,
    hp: 100,
    maxhp: 100,
    moves: partial.moves || [],
    hazardChip: partial.hazardChip,
    statusMove: partial.statusMove,
    speed: partial.speed,
  };
}

function wideStats(): RandbatsStats {
  const stats: RandbatsStats = {};
  const species = Dex.species.all().filter(row => row.exists && row.num > 0);
  for (const row of species) {
    if (Object.keys(stats).length >= MIN_RANDBATS_SPECIES) break;
    const ability = row.abilities?.['0'] || 'Pressure';
    stats[row.name] = {
      level: 80,
      abilities: { [ability]: 1 },
      items: { Leftovers: 1 },
      roles: {
        Standard: {
          weight: 1,
          moves: { Tackle: 1, Protect: 1 },
        },
      },
    };
  }
  return stats;
}

describe('hybrid search pieces', () => {
  it('refuses a randbats table under 500 species', () => {
    expect(() => assertRandbatsSpecies({ Pikachu: { level: 80, abilities: {}, items: {}, roles: {} } })).toThrow(/500/);
    expect(Object.keys(wideStats()).length).toBeGreaterThanOrEqual(500);
    expect(() => assertRandbatsSpecies(wideStats())).not.toThrow();
  });

  it('drops Assault Vest after a status move and Boots after hazard chip', () => {
    const status = foe({ species: 'Example', statusMove: true, moves: ['Thunder Wave'] });
    const chipped = foe({ species: 'Example', hazardChip: true });
    expect(itemAllowed('assaultvest', status)).toBe(false);
    expect(itemAllowed('heavydutyboots', status)).toBe(true);
    expect(itemAllowed('heavydutyboots', chipped)).toBe(false);
    expect(itemAllowed('leftovers', chipped)).toBe(true);
    expect(itemAllowed('assaultvest', foe({ species: 'Example', moves: ['Will-O-Wisp'] }))).toBe(false);
  });

  it('reads hazard chip and a status move from the public log', () => {
    const notes = parsePublic([
      '|move|p2a: Foe|Thunder Wave|p1a: Us',
      '|-sidestart|p2: Foe|Stealth Rock',
      '|-damage|p2a: Foe|80/100|[from] Stealth Rock',
      '|move|p1a: Us|Tackle|p2a: Foe',
      '|move|p2a: Foe|Earthquake|p1a: Us',
    ], 'p1');
    expect(notes.statusMove.has('foe')).toBe(true);
    expect(notes.hazardChip.has('foe')).toBe(true);
    expect(notes.foeHazards).toContain('stealthrock');
    // Thunder Wave is priority 0, so the foe moved first on a speed turn.
    expect(notes.speed.get('foe')).toBe('faster');
    const slower = parsePublic([
      '|move|p1a: Us|Tackle|p2a: Foe',
      '|move|p2a: Foe|Earthquake|p1a: Us',
    ], 'p1');
    expect(slower.speed.get('foe')).toBe('slower');
  });

  it('regret-matches a dominated row to the better action', () => {
    const matched = regretMatch([
      [5, 4],
      [0, 1],
    ], 32);
    expect(matched.colMix.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    expect(matched.rowValues[0]).toBeGreaterThan(matched.rowValues[1]);
  });

  it('does not let judgment override outside the margin', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls.push(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"choice":"switch 2"}' } }] }), { status: 200 });
    };
    const client = new GatewayClient({ apiKey: 'test-key', fetchImpl, log: () => undefined, timeoutMs: 1000, perTurnLatencyBudgetMs: 5000, maxRetries: 0 });
    const params = HybridParamsSchema.parse({ judgment: true, margin: 0.5 });
    const skipped = await judgeMove(client, params, null, [
      { choice: 'move 1', score: 3, koRate: 0.5 },
      { choice: 'switch 2', score: 1, koRate: 0 },
    ], 2000);
    expect(skipped.choice).toBeNull();
    expect(calls).toHaveLength(0);

    const close = await judgeMove(client, params, null, [
      { choice: 'move 1', score: 1.2, koRate: 0.2 },
      { choice: 'switch 2', score: 1.0, koRate: 0.1 },
    ], 2000);
    expect(close.choice).toBe('switch 2');
    const body = JSON.parse(calls[0]);
    expect(body.temperature).toBeUndefined();
    expect(body.reasoning_effort).toBe('medium');
    expect(body.providerOptions.gateway.only).toEqual(['cerebras']);
    expect(body.max_tokens).toBe(10000);

    const every = await judgeMove(client, HybridParamsSchema.parse({
      judgment: true,
      everyTurn: true,
      margin: 0.5,
      model: 'spacexai/grok-4.7',
      effort: 'none',
      maxTokens: 1000,
    }), null, [
      { choice: 'move 1', score: 3, koRate: 0.5 },
      { choice: 'switch 2', score: 1, koRate: 0 },
    ], 2000, 'sides: US test');
    expect(every.choice).toBeNull();
    const grok = JSON.parse(calls[1]);
    expect(grok.reasoning_effort).toBe('none');
    expect(grok.providerOptions).toBeUndefined();
    expect(grok.max_tokens).toBe(1000);
    expect(grok.messages[1].content).toContain('sides: US test');

    const wide = await judgeMove(client, HybridParamsSchema.parse({
      everyTurn: true,
      margin: 3,
      model: 'spacexai/grok-4.7',
      effort: 'none',
      maxTokens: 1000,
    }), null, [
      { choice: 'move 1', score: 3, koRate: 0.5 },
      { choice: 'switch 2', score: 1, koRate: 0 },
    ], 2000);
    expect(wide.choice).toBe('switch 2');
  });

  it('draws the calibrated posterior when the sampler knob says so', () => {
    expect(HybridParamsSchema.parse({}).sampler).toBe('loose');
    expect(loadConfig('configs/hybrid.yaml').config.hybrid?.params.plan).toBe(false);
    expect(loadConfig('configs/hybrid.yaml').config.hybrid?.params.judgment).toBe(false);
    expect(loadConfig('configs/hybrid.yaml').config.hybrid?.params.everyTurn).toBe(false);
    expect(loadConfig('configs/hybrid-core.yaml').config.hybrid?.params.sampler).toBe('loose');
    expect(loadConfig('configs/hybrid-calibrated.yaml').config.hybrid?.params.sampler).toBe('calibrated');

    const stats = wideStats();
    stats.Pikachu = {
      level: 80,
      abilities: { Static: 1 },
      items: { Leftovers: 1 },
      roles: {
        Lead: {
          weight: 1,
          moves: { 'Thunder Wave': 1, Thunderbolt: 1, 'Quick Attack': 1, Protect: 1 },
          items: { 'Heavy-Duty Boots': 1, 'Assault Vest': 1, Leftovers: 1 },
        },
      },
    };
    const evidence = {
      knownFoes: [foe({
        species: 'Pikachu',
        moves: ['Thunder Wave'],
        hazardChip: true,
        statusMove: true,
      })],
    };
    const rng = () => new PRNG([4, 5, 6, 7] as never);
    const loose = sampleHybridWorlds(evidence, 6, stats, rng(), 'balanced', 'loose');
    const calibrated = sampleHybridWorlds(evidence, 6, stats, rng(), 'balanced', 'calibrated');
    expect(loose.length).toBeGreaterThan(0);
    expect(calibrated.length).toBeGreaterThan(0);
    const items = calibrated.flatMap(world => world.foeTeam.filter(set => set.species === 'Pikachu').map(set => set.item));
    expect(items.length).toBeGreaterThan(0);
    expect(items.every(item => item !== 'Heavy-Duty Boots' && item !== 'Assault Vest')).toBe(true);
    expect(calibrated.every(world => world.foeTeam[0]?.moves.includes('Thunder Wave'))).toBe(true);
  });

  it('returns a legal choice from sampled worlds', async () => {
    const teams = teamsForSeed(11);
    const battle = startRandomBattle(teams.p1, teams.p2, 11);
    if (battle.requestState === 'teampreview') {
      battle.choose('p1', 'default');
      battle.choose('p2', 'default');
    }
    const impl = createHybridSearch(HybridParamsSchema.parse({}) as never);
    const trace = await impl.search(battle, 'p1', {
      evaluate: {} as never,
      behavior: {} as never,
      plan: null,
      rng: new PRNG([4, 5, 6, 7] as never),
      hybrid: HybridParamsSchema.parse({
        worlds: 2,
        samples: 1,
        sampler: 'calibrated',
        plan: false,
        opponent: false,
        judgment: false,
        maxActions: 4,
        maxReplies: 2,
        tera: true,
      }),
      randbats: wideStats(),
      llmAllowed: false,
      deadlineMs: Date.now() + 8000,
    });
    expect(legalChoices(battle, 'p1').length).toBeGreaterThan(0);
    expect(isPlayableChoice(battle, 'p1', trace.choice) || trace.choice === 'default').toBe(true);
    expect(trace.scores.length).toBeGreaterThan(0);
  }, 20000);
});
