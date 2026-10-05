import { Dex } from '@pkmn/sim';
import { RandbatsStats } from '../types/index.js';
import { legalChoices, startRandomBattle, teamsForSeed } from './exact/battle-utils.js';
import { strictLegalActions } from '../client/choice.js';
import { buildDecisionBattle, chooseLive, LivePosition } from '../client/decision-battle.js';
import { loadConfig } from '../config/load.js';
import { battleWithFoePriors, foePriorsEnabled } from '../client/decision-battle.js';
import { completeFoeTeam, FOE_PRIOR_MIN_BUDGET_MS } from './foe-prior.js';
import { compareFoePriors } from './foe-prior-compare.js';

const GARCHOMP: RandbatsStats = {
  Garchomp: {
    level: 74,
    abilities: { 'Rough Skin': 1 },
    items: { 'Rocky Helmet': 1 },
    roles: {
      'Fast Support': {
        weight: 0.8,
        abilities: { 'Rough Skin': 1 },
        items: { 'Rocky Helmet': 1 },
        moves: { Earthquake: 1, Outrage: 1, 'Stealth Rock': 0.8, Spikes: 0.1 },
      },
      'Setup Sweeper': {
        weight: 0.2,
        abilities: { 'Rough Skin': 1 },
        items: { 'Loaded Dice': 1 },
        moves: { Earthquake: 1, 'Swords Dance': 1, 'Scale Shot': 1, 'Fire Fang': 0.5 },
      },
    },
  },
  Blissey: bench(85),
  Toxapex: bench(82),
  Skarmory: bench(80),
  Pikachu: bench(88),
  Magikarp: bench(100),
  Snorlax: bench(80),
};

function bench(level: number): RandbatsStats[string] {
  return {
    level,
    abilities: { Pressure: 1 },
    items: { Leftovers: 1 },
    roles: {
      Bench: {
        weight: 1,
        abilities: { Pressure: 1 },
        items: { Leftovers: 1 },
        moves: { Tackle: 1, Protect: 0.5 },
      },
    },
  };
}

function active(moves: string[], extra: Partial<LivePosition['foeActive']> = {}) {
  return {
    species: 'Garchomp',
    level: 74,
    hp: 200,
    maxhp: 200,
    moves,
    ...extra,
  };
}

describe('foe priors', () => {
  it('fills unrevealed moves, item, and ability from the role weights', () => {
    const [mon] = completeFoeTeam([active([])], GARCHOMP, { teamSize: 1 });
    expect(mon.moves).toEqual(['Earthquake', 'Outrage', 'Stealth Rock', 'Scale Shot']);
    expect(mon.ability).toBe('Rough Skin');
    expect(mon.item).toBe('Rocky Helmet');
    expect(mon.moves).not.toContain('Tackle');
  });

  it('keeps a revealed move and drops roles that cannot have it', () => {
    const [mon] = completeFoeTeam([active(['swordsdance'])], GARCHOMP, { teamSize: 1 });
    expect(mon.moves[0]).toBe('Swords Dance');
    expect(mon.moves).toEqual(['Swords Dance', 'Earthquake', 'Scale Shot', 'Fire Fang']);
    expect(mon.item).toBe('Loaded Dice');
  });

  it('keeps four revealed moves and a revealed item', () => {
    const [mon] = completeFoeTeam(
      [active(['Fire Fang', 'Scale Shot', 'earthquake', 'Swords Dance'], { item: 'Lum Berry', ability: 'roughskin' })],
      GARCHOMP,
      { teamSize: 1 },
    );
    expect(mon.moves).toEqual(['Fire Fang', 'Scale Shot', 'Earthquake', 'Swords Dance']);
    expect(mon.item).toBe('Lum Berry');
    expect(mon.ability).toBe('Rough Skin');
  });

  it('does not wipe the set when a revealed move is missing from every role', () => {
    const [mon] = completeFoeTeam([active(['Tackle'])], GARCHOMP, { teamSize: 1 });
    expect(mon.moves[0]).toBe('Tackle');
    expect(mon.moves).toContain('Earthquake');
    expect(mon.moves).toHaveLength(4);
  });

  it('adds placeholders for unseen teammates and leaves a fainted reveal fainted', () => {
    const team = completeFoeTeam([active([], { fainted: true, hp: 0 })], GARCHOMP);
    expect(team).toHaveLength(6);
    expect(team[0].species).toBe('Garchomp');
    expect(team[0].fainted).toBe(true);
    const benchMons = team.slice(1);
    expect(benchMons.every(mon => mon.placeholder && !mon.fainted && mon.hp === 100)).toBe(true);
    expect(new Set(team.map(mon => mon.species)).size).toBe(6);
    expect(benchMons.every(mon => mon.moves.length > 0)).toBe(true);
    const again = completeFoeTeam([active([], { fainted: true, hp: 0 })], GARCHOMP);
    expect(again.map(mon => mon.species)).toEqual(team.map(mon => mon.species));
  });

  it('returns no invented lead when nothing has been revealed', () => {
    expect(completeFoeTeam([], GARCHOMP)).toEqual([]);
  });

  it('stays off unless a config or the foe-priors variant asks for it', () => {
    expect(foePriorsEnabled(undefined, 'switch-depth2')).toBe(false);
    expect(foePriorsEnabled(false)).toBe(false);
    expect(foePriorsEnabled(true)).toBe(true);
    expect(foePriorsEnabled(undefined, 'foe-priors')).toBe(true);
    const champion = loadConfig('configs/champion.yaml');
    const opted = loadConfig('configs/examples/foe-priors.yaml');
    expect(champion.config.search.params.foePriors).toBeUndefined();
    expect(opted.config.search.params.foePriors).toBe(true);
    expect(opted.config.search.params.samples).toBe(8);
    expect(opted.configId).not.toBe(champion.configId);
  });
});

function openedBattle() {
  const teams = teamsForSeed(7);
  const battle = startRandomBattle(teams.p1, teams.p2, 7);
  if (battle.requestState === 'teampreview') {
    battle.choose('p1', 'default');
    battle.choose('p2', 'default');
  }
  return battle;
}

function hiddenLead(stats: RandbatsStats): LivePosition {
  const battle = openedBattle();
  const foe = battle.p2.active[0];
  if (!foe) throw new Error('no foe');
  const species = foe.species.name;
  return {
    request: battle.p1.activeRequest,
    foeActive: {
      species,
      level: foe.level,
      hp: foe.hp,
      maxhp: foe.maxhp,
      moves: [],
      fainted: false,
    },
    foeBench: [],
    speciesStats: { ...stats, [species]: stats.Garchomp },
  };
}

describe('decision battle priors', () => {
  it('does not fill the foe unless the position asks for priors', () => {
    const position = hiddenLead(GARCHOMP);
    delete position.speciesStats;
    const built = buildDecisionBattle(position);
    expect(built).not.toBeNull();
    if (!built) return;
    expect(built.p2.pokemon).toHaveLength(1);
    expect(built.p2.active[0].moveSlots.map(slot => slot.id)).toEqual(['tackle']);
  });

  it('fills a sim battle when the caller passes the table', () => {
    const battle = openedBattle();
    const foe = battle.p2.active[0];
    const stats = { ...GARCHOMP, [foe.species.name]: GARCHOMP.Garchomp };
    const modeled = battleWithFoePriors(battle, 'p1', stats);
    expect(modeled).not.toBeNull();
    if (!modeled) return;
    expect(modeled.p2.pokemon).toHaveLength(6);
    expect(modeled.p1.pokemon.length).toBeGreaterThan(0);
  });

  it('puts the weighted set on the active foe and six pokemon on the team', () => {
    const position = hiddenLead(GARCHOMP);
    const built = buildDecisionBattle(position);
    expect(built).not.toBeNull();
    if (!built) return;
    const ids = built.p2.active[0].moveSlots.map(slot => slot.id);
    expect(ids).toEqual(['earthquake', 'outrage', 'stealthrock', 'scaleshot']);
    expect(Dex.abilities.get(built.p2.active[0].ability).name).toBe('Rough Skin');
    expect(Dex.items.get(built.p2.active[0].item).name).toBe('Rocky Helmet');
    expect(built.p2.pokemon).toHaveLength(6);
    expect(built.p2.pokemonLeft).toBe(6);
  });

  it('keeps a one-pokemon foe when the prior is off, so a knockout ends the battle', () => {
    const position = hiddenLead(GARCHOMP);
    const revealed = buildDecisionBattle({ ...position, modelHidden: false });
    const modeled = buildDecisionBattle(position);
    expect(revealed && modeled).toBeTruthy();
    if (!revealed || !modeled) return;
    expect(revealed.p2.pokemon).toHaveLength(1);

    revealed.p2.active[0].faint();
    revealed.faintMessages();
    expect(revealed.ended).toBe(true);
    expect(revealed.winner).toBe('P1');

    modeled.p2.active[0].faint();
    modeled.faintMessages();
    expect(modeled.ended).toBe(false);
    expect(modeled.p2.pokemonLeft).toBe(5);
  });

  it('skips the prior when the search budget is below the floor', () => {
    const position = hiddenLead(GARCHOMP);
    const built = buildDecisionBattle(position, { budgetMs: FOE_PRIOR_MIN_BUDGET_MS - 1 });
    expect(built).not.toBeNull();
    if (!built) return;
    expect(built.p2.pokemon).toHaveLength(1);
    expect(built.p2.active[0].moveSlots.map(slot => slot.id)).toEqual(['tackle']);
  });

  it('still returns a legal live choice with the prior table', async () => {
    const position = hiddenLead(GARCHOMP);
    const legal = strictLegalActions(position.request);
    const picked = await chooseLive('search', position, legal, { budgetMs: 8000 });
    expect(legal).toContainEqual(picked.action);
    const built = buildDecisionBattle(position);
    if (!built) throw new Error('battle');
    expect(legalChoices(built, 'p1').length).toBeGreaterThan(0);
  });
});

describe('hidden-info comparison', () => {
  it('finishes paired games without an illegal choice', async () => {
    const report = await compareFoePriors({
      pairs: 1,
      samples: 1,
      stats: GARCHOMP,
      oracle: false,
      maxTurns: 12,
      seed: 3,
    });
    expect(report.games).toBe(2);
    expect(report.crashes).toBe(0);
    expect(report.invalidChoices).toBe(0);
    expect(report.latencyMs.prior.n).toBeGreaterThan(0);
    expect(report.latencyMs.revealed.n).toBeGreaterThan(0);
  }, 30000);
});
