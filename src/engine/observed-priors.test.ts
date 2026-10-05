import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RandbatsStats } from '../types/index.js';
import { buildDecisionBattle } from '../client/decision-battle.js';
import { legalChoices, startRandomBattle, teamsForSeed } from './exact/battle-utils.js';
import { completeFoeTeam } from './foe-prior.js';
import { parseRebuildArgs } from '../cli/rebuild-priors.js';
import {
  applyObservedFile,
  blendStats,
  clearObservedPriorCache,
  DEFAULT_PRIOR_STRENGTH,
  emptyObservedPriors,
  OBSERVED_PRIORS_VERSION,
  observedPriorsPath,
  observeMons,
  opponentMons,
  readObservedPriors,
  rebuildObservedPriors,
  writeObservedPriors,
  ObservedMon,
} from './observed-priors.js';

const SETUP: ObservedMon = {
  species: 'Garchomp',
  moves: ['Swords Dance', 'Earthquake', 'Scale Shot', 'Fire Fang'],
  ability: 'Rough Skin',
  item: 'Loaded Dice',
};

const STATS: RandbatsStats = {
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
  Dragonite: {
    level: 80,
    abilities: { Multiscale: 1 },
    items: { 'Heavy-Duty Boots': 1 },
    roles: {
      'Dragon Dance': {
        weight: 1,
        abilities: { Multiscale: 1 },
        items: { 'Heavy-Duty Boots': 1 },
        moves: { 'Dragon Dance': 1, Outrage: 1, Earthquake: 1, 'Extreme Speed': 1 },
      },
    },
  },
};

function lead() {
  return { species: 'Garchomp', level: 74, hp: 200, maxhp: 200, moves: [] as string[] };
}

function filled(stats: RandbatsStats) {
  const [mon] = completeFoeTeam([lead()], stats, { teamSize: 1 });
  return mon;
}

function withObservations(times: number, mon: ObservedMon = SETUP) {
  const file = emptyObservedPriors();
  for (let i = 0; i < times; i++) observeMons(file, STATS, [mon]);
  return blendStats(STATS, file);
}

const LOG = `
|player|p1|Alpha|1|1500
|player|p2|Bravo|2|1600
|switch|p1a: Garchomp|Garchomp, L80|300/300
|switch|p2a: Dragonite|Dragonite, L80|320/320
|move|p1a: Garchomp|Earthquake|p2a: Dragonite
|move|p2a: Dragonite|Dragon Dance|p1a: Garchomp
|move|p2a: Dragonite|Outrage|p1a: Garchomp
|move|p2a: Dragonite|Extreme Speed|p1a: Garchomp
|move|p2a: Dragonite|Earthquake|p1a: Garchomp
|-ability|p2a: Dragonite|Multiscale
|-item|p2a: Dragonite|Heavy-Duty Boots
|win|Bravo
`;

describe('observed set priors', () => {
  let dir = '';
  const env = process.env.JEV_OBSERVED_PRIORS;

  beforeEach(() => {
    clearObservedPriorCache();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observed-priors-'));
  });

  afterEach(() => {
    clearObservedPriorCache();
    if (env === undefined) delete process.env.JEV_OBSERVED_PRIORS;
    else process.env.JEV_OBSERVED_PRIORS = env;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves the base table unchanged when nothing has been observed', () => {
    const blended = blendStats(STATS, emptyObservedPriors());
    expect(blended.Garchomp).toBe(STATS.Garchomp);
    expect(filled(blended).moves).toEqual(['Earthquake', 'Outrage', 'Stealth Rock', 'Scale Shot']);
    expect(filled(blended).item).toBe('Rocky Helmet');
  });

  it('does not let two contrary sets replace the base mode or the filled moves', () => {
    const file = emptyObservedPriors();
    observeMons(file, STATS, [SETUP, SETUP]);
    const blended = blendStats(STATS, file);
    const fast = blended.Garchomp.roles['Fast Support'].weight;
    const setup = blended.Garchomp.roles['Setup Sweeper'].weight;
    expect(fast).toBeCloseTo(32 / 42, 6);
    expect(setup).toBeCloseTo(10 / 42, 6);
    expect(fast).toBeGreaterThan(setup);
    expect(filled(blended).moves).toEqual(filled(STATS).moves);
    expect(filled(blended).item).toBe('Rocky Helmet');
    expect(blended.Garchomp.roles['Fast Support'].moves).toEqual(STATS.Garchomp.roles['Fast Support'].moves);
  });

  it('lets a large sample flip the mode and the filled set', () => {
    const blended = withObservations(200);
    const fast = blended.Garchomp.roles['Fast Support'].weight;
    const setup = blended.Garchomp.roles['Setup Sweeper'].weight;
    expect(setup).toBeCloseTo(208 / 240, 6);
    expect(setup).toBeGreaterThan(fast);
    expect(filled(blended).moves).toEqual(['Earthquake', 'Scale Shot', 'Swords Dance', 'Fire Fang']);
    expect(filled(blended).item).toBe('Loaded Dice');
  });

  it('updates role weight from a partial reveal and leaves move frequencies alone', () => {
    const file = emptyObservedPriors();
    observeMons(file, STATS, [{ species: 'Garchomp', moves: ['swordsdance'] }]);
    expect(file.species.Garchomp.roles['Setup Sweeper'].fullSets).toBe(0);
    expect(file.species.Garchomp.roles['Fast Support']).toBeUndefined();
    const blended = blendStats(STATS, file);
    expect(blended.Garchomp.roles['Fast Support'].weight).toBeCloseTo(32 / 41, 6);
    expect(blended.Garchomp.roles['Setup Sweeper'].weight).toBeCloseTo(9 / 41, 6);
    expect(blended.Garchomp.roles['Fast Support'].moves).toEqual(STATS.Garchomp.roles['Fast Support'].moves);
    expect(blended.Garchomp.roles['Setup Sweeper'].moves).toEqual(STATS.Garchomp.roles['Setup Sweeper'].moves);
    expect(filled(blended).moves).toEqual(filled(STATS).moves);
  });

  it('counts a move the table has never seen and does not treat it as an absence', () => {
    const file = emptyObservedPriors();
    observeMons(file, STATS, [{
      species: 'Garchomp',
      moves: ['Tackle', 'Earthquake', 'Outrage', 'Stealth Rock'],
    }]);
    expect(file.species.Garchomp.unknownMoves).toBe(1);
    expect(file.species.Garchomp.roles['Fast Support'].fullSets).toBe(0);
    expect(file.species.Garchomp.roles['Fast Support'].moves).toEqual({});
    const blended = blendStats(STATS, file);
    expect(blended.Garchomp.roles['Fast Support'].moves).toEqual(STATS.Garchomp.roles['Fast Support'].moves);
  });

  it('ignores a file from another version', () => {
    const file = emptyObservedPriors();
    observeMons(file, STATS, Array.from({ length: 200 }, () => SETUP));
    const blended = blendStats(STATS, { ...file, version: 99 as typeof OBSERVED_PRIORS_VERSION });
    expect(blended).toBe(STATS);
  });

  it('round-trips the versioned file and treats a missing file as the base table', () => {
    const out = path.join(dir, 'observed-sets.json');
    const file = emptyObservedPriors();
    observeMons(file, STATS, [SETUP]);
    writeObservedPriors(out, file);
    const read = readObservedPriors(out);
    expect(read?.version).toBe(OBSERVED_PRIORS_VERSION);
    expect(read?.priorStrength).toBe(DEFAULT_PRIOR_STRENGTH);
    expect(read?.pokemon).toBe(1);
    expect(read?.generatedAt).not.toBe(new Date(0).toISOString());
    expect(applyObservedFile(STATS, path.join(dir, 'missing.json'))).toBe(STATS);
    fs.writeFileSync(out, '{not json');
    clearObservedPriorCache();
    expect(applyObservedFile(STATS, out)).toBe(STATS);
    expect(readObservedPriors(out)).toBeNull();
  });

  it('caches a blend until the file changes', () => {
    const out = path.join(dir, 'observed-sets.json');
    const light = emptyObservedPriors();
    observeMons(light, STATS, [SETUP, SETUP]);
    writeObservedPriors(out, light);
    const first = applyObservedFile(STATS, out);
    expect(applyObservedFile(STATS, out)).toBe(first);
    const heavy = emptyObservedPriors();
    observeMons(heavy, STATS, Array.from({ length: 200 }, () => SETUP));
    writeObservedPriors(out, heavy);
    const stamped = new Date(Date.now() + 5000);
    fs.utimesSync(out, stamped, stamped);
    const next = applyObservedFile(STATS, out);
    expect(next).not.toBe(first);
    expect(filled(next).item).toBe('Loaded Dice');
  });

  it('counts only the opponent, including when the game row is written after the log', () => {
    expect(opponentMons(LOG, 'Alpha').map(mon => mon.species)).toEqual(['Dragonite']);
    expect(opponentMons(LOG, 'Bravo').map(mon => mon.species)).toEqual(['Garchomp']);
    expect(opponentMons(LOG, 'Nobody')).toEqual([]);

    const logName = 'm-battle-room.log';
    fs.writeFileSync(path.join(dir, logName), LOG);
    fs.writeFileSync(path.join(dir, 'Alpha-battle-copy.log'), LOG);
    fs.writeFileSync(path.join(dir, 'stranger-battle-other.log'), `${LOG}\n|turn|3\n`);
    fs.writeFileSync(path.join(dir, 'z-games.jsonl'), `${JSON.stringify({
      username: 'Alpha',
      localReplayPath: path.join(dir, logName),
    })}\n`);

    const out = path.join(dir, 'observed-sets.json');
    const result = rebuildObservedPriors({ base: STATS, roots: [dir], out });
    expect(result.file.games).toBe(1);
    expect(result.file.species.Dragonite.n).toBe(1);
    expect(result.file.species.Dragonite.roles['Dragon Dance'].fullSets).toBe(1);
    expect(result.file.species.Garchomp).toBeUndefined();
    expect(result.skipped).toBeGreaterThan(0);
  });

  it('does not blend a table the caller passed in', () => {
    const out = path.join(dir, 'observed-sets.json');
    const heavy = emptyObservedPriors();
    observeMons(heavy, STATS, Array.from({ length: 200 }, () => SETUP));
    writeObservedPriors(out, heavy);
    process.env.JEV_OBSERVED_PRIORS = out;

    const teams = teamsForSeed(7);
    const battle = startRandomBattle(teams.p1, teams.p2, 7);
    if (battle.requestState === 'teampreview') {
      battle.choose('p1', 'default');
      battle.choose('p2', 'default');
    }
    const foe = battle.p2.active[0];
    const species = foe.species.name;
    const built = buildDecisionBattle({
      request: battle.p1.activeRequest,
      foeActive: { species, level: foe.level, hp: foe.hp, maxhp: foe.maxhp, moves: [], fainted: false },
      foeBench: [],
      speciesStats: { ...STATS, [species]: STATS.Garchomp },
    });
    expect(built).not.toBeNull();
    expect(built!.p2.active[0].moveSlots.map(slot => slot.id)).toEqual([
      'earthquake', 'outrage', 'stealthrock', 'scaleshot',
    ]);
    expect(legalChoices(built!, 'p1').length).toBeGreaterThan(0);
  });

  it('parses the rebuild command', () => {
    expect(parseRebuildArgs([])).toMatchObject({
      logs: ['logs/ladder', 'live-runs'],
      stats: 'data/gen9-stats.json',
      out: 'state/meta/observed-sets.json',
      strength: DEFAULT_PRIOR_STRENGTH,
    });
    expect(parseRebuildArgs(['--logs', 'a', '--logs=b', '--strength=10', '--username=Alpha'])).toMatchObject({
      logs: ['a', 'b'],
      strength: 10,
      username: 'Alpha',
    });
    expect(() => parseRebuildArgs(['--strength=0'])).toThrow(/strength/);
  });

  it('turns an empty override off', () => {
    process.env.JEV_OBSERVED_PRIORS = '';
    expect(observedPriorsPath()).toBeNull();
    expect(applyObservedFile(STATS)).toBe(STATS);
  });
});
