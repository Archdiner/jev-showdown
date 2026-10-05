import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { describe, expect, it } from '@jest/globals';
import { Protocol } from '@pkmn/protocol';
import { BeliefTracker } from '../engine/belief-tracker.js';
import { loadConfig } from '../config/load.js';
import { gen9RandomBattle } from '../formats/gen9-randombattle.js';
import type { Action, GameState, PokemonBelief, RandbatsStats, RoleData } from '../types/index.js';
import type { OpponentTracking } from '../types/format.js';
import { dataLoader } from '../data/data-loader.js';
import { legalActionsForRequest, pickBestLegal } from './choice.js';
import { BattleDriver } from './battle-driver.js';
import { DecisionClient } from './decision-client.js';
import { ShowdownClient } from './showdown-client.js';
import { OpponentTracker, type OpponentPosterior } from './opponent-tracker.js';

/**
 * The opponent tracker as it was before calibrated set inference (commit 9afcca1).
 * Belief updates always go through BeliefTracker. There is no posterior.
 * Stats are injected so this reference never reads data/gen9-stats.json.
 */
class Pre62Tracker {
  private beliefs: BeliefTracker;
  private seen = new Map<string, { species: string; level: number; side: 'p1' | 'p2' }>();
  private activeBySide = new Map<'p1' | 'p2', string>();
  readonly ourSide: () => 'p1' | 'p2' | null;

  constructor(ourSide: () => 'p1' | 'p2' | null, stats: RandbatsStats) {
    this.ourSide = ourSide;
    this.beliefs = new BeliefTracker(stats);
  }

  applyLine(line: string): void {
    if (!line.startsWith('|')) return;
    let args: readonly unknown[];
    try {
      args = Protocol.parseBattleLine(line).args;
    } catch {
      return;
    }
    const cmd = args[0];
    const a = typeof args[1] === 'string' ? args[1] : undefined;
    const b = typeof args[2] === 'string' ? args[2] : undefined;
    if (cmd === 'switch' || cmd === 'drag' || cmd === 'replace') {
      this.onReveal(a, b, cmd === 'replace');
      return;
    }
    if (cmd === 'move') {
      this.onMove(a, b);
      return;
    }
    if (cmd === '-ability') {
      this.onAbility(a, b);
      return;
    }
    if (cmd === '-item' || cmd === '-enditem') {
      this.onItem(a, b);
      return;
    }
    if (cmd === '-terastallize') this.onTera(a, b);
  }

  tracking(): OpponentTracking {
    const revealedMoves = new Map<string, Set<string>>();
    const revealedItems = new Map<string, string>();
    const revealedAbilities = new Map<string, string>();
    const team = new Map<string, PokemonBelief>();
    for (const seen of this.seen.values()) {
      if (seen.side === this.ourSide()) continue;
      const belief = this.beliefs.getBelief(`${seen.side}:${seen.species}`);
      if (!belief) continue;
      revealedMoves.set(seen.species, new Set(belief.revealedMoves));
      if (belief.revealedItem) revealedItems.set(seen.species, belief.revealedItem);
      if (belief.revealedAbility) revealedAbilities.set(seen.species, belief.revealedAbility);
      team.set(seen.species, belief);
    }
    let activeSpecies: string | null = null;
    for (const [side, species] of this.activeBySide) {
      if (side !== this.ourSide()) activeSpecies = species;
    }
    return { team, activeSpecies, revealedMoves, revealedItems, revealedAbilities };
  }

  private onReveal(ident: string | undefined, details: string | undefined, replace: boolean): void {
    if (!ident || !details) return;
    const who = identify(ident, details);
    if (!who || who.side === this.ourSide()) return;
    const id = `${who.side}:${who.species}`;
    if (!this.beliefs.getBelief(id)) this.beliefs.initializeBelief(id, who.species, who.level);
    this.seen.set(id, who);
    if (!replace) this.activeBySide.set(who.side, who.species);
  }

  private onMove(ident: string | undefined, move: string | undefined): void {
    if (!ident || !move || move === 'Recharge') return;
    const seen = seenByIdent(this.seen, ident);
    if (!seen || seen.side === this.ourSide()) return;
    this.beliefs.updateOnMove(`${seen.side}:${seen.species}`, move);
    this.activeBySide.set(seen.side, seen.species);
  }

  private onAbility(ident: string | undefined, ability: string | undefined): void {
    if (!ident || !ability) return;
    const seen = seenByIdent(this.seen, ident);
    if (!seen || seen.side === this.ourSide()) return;
    this.beliefs.updateOnAbility(`${seen.side}:${seen.species}`, ability);
  }

  private onItem(ident: string | undefined, item: string | undefined): void {
    if (!ident || !item) return;
    const seen = seenByIdent(this.seen, ident);
    if (!seen || seen.side === this.ourSide()) return;
    this.beliefs.updateOnItem(`${seen.side}:${seen.species}`, item);
  }

  private onTera(ident: string | undefined, tera: string | undefined): void {
    if (!ident || !tera) return;
    const seen = seenByIdent(this.seen, ident);
    if (!seen || seen.side === this.ourSide()) return;
    this.beliefs.updateOnTeraType(`${seen.side}:${seen.species}`, tera);
  }
}

function role(
  weight: number,
  moves: Record<string, number>,
  items: Record<string, number>,
  tera: Record<string, number>,
  ability: string,
): RoleData {
  return { weight, moves, items, teraTypes: tera, abilities: { [ability]: 1 } };
}

const stats: RandbatsStats = {
  Ampharos: {
    level: 88,
    abilities: { Static: 1 },
    items: { 'Assault Vest': 0.5, 'Life Orb': 0.25, 'Choice Specs': 0.25 },
    roles: {
      'AV Pivot': role(0.5, {
        'Volt Switch': 1, 'Dragon Pulse': 1, Thunderbolt: 0.5, 'Focus Blast': 0.5,
      }, { 'Assault Vest': 1 }, { Fairy: 1 }, 'Static'),
      Wallbreaker: role(0.5, {
        Thunderbolt: 1, 'Dragon Pulse': 1, 'Focus Blast': 1, Agility: 0.5, 'Volt Switch': 0.5,
      }, { 'Life Orb': 0.5, 'Choice Specs': 0.5 }, { Electric: 1 }, 'Static'),
    },
  },
  Pelipper: {
    level: 83,
    abilities: { Drizzle: 1 },
    items: { 'Heavy-Duty Boots': 1 },
    roles: {
      'Bulky Support': role(1, { Hurricane: 1, 'U-turn': 1 }, { 'Heavy-Duty Boots': 1 }, { Water: 1 }, 'Drizzle'),
    },
  },
};

const ABILITY = '|-ability|p2a: Ampharos|Static';
const FIXTURE = [
  '|init|battle',
  '|player|p1|Champion|1|1200',
  '|player|p2|Rival|2|1500',
  '|switch|p1a: Pelipper|Pelipper, L83|100/100',
  '|switch|p2a: Ampharos|Ampharos, L88|100/100',
  '|turn|1',
  '|move|p2a: Ampharos|Agility|p2a: Ampharos',
  '|-boost|p2a: Ampharos|spe|2',
  ABILITY,
  '|-damage|p1a: Pelipper|91/100|[from] item: Rocky Helmet|[of] p2a: Ampharos',
  '|-terastallize|p2a: Ampharos|Electric',
  '|turn|2',
];

const REQUEST = {
  rqid: 2,
  turn: 2,
  side: {
    id: 'p1',
    pokemon: [
      {
        ident: 'p1: Pelipper',
        details: 'Pelipper, L83',
        condition: '91/100',
        active: true,
        moves: ['hurricane', 'uturn'],
      },
      {
        ident: 'p1: Wingull',
        details: 'Wingull, L90',
        condition: '100/100',
        active: false,
        moves: ['hurricane'],
      },
    ],
  },
  active: [{
    moves: [
      { move: 'Hurricane', id: 'hurricane', pp: 16, maxpp: 16, target: 'normal', disabled: false },
      { move: 'U-turn', id: 'uturn', pp: 32, maxpp: 32, target: 'normal', disabled: false },
    ],
  }],
};

interface Playable {
  applyLine(line: string): void;
  tracking(): OpponentTracking;
}

function identify(ident: string, details: string): { species: string; level: number; side: 'p1' | 'p2' } | null {
  let parsed: { player: 'p1' | 'p2' | 'p3' | 'p4'; name: string };
  try {
    parsed = Protocol.parsePokemonIdent(ident as Protocol.PokemonIdent);
  } catch {
    return null;
  }
  if (parsed.player !== 'p1' && parsed.player !== 'p2') return null;
  let species = details.split(',')[0]?.trim() || parsed.name;
  let level = 80;
  try {
    const detailed = Protocol.parseDetails(parsed.name, ident as Protocol.PokemonIdent, details as Protocol.PokemonDetails);
    if (detailed.speciesForme) species = detailed.speciesForme;
    if (detailed.level) level = detailed.level;
  } catch {
    const levelMatch = details.match(/L(\d+)/);
    if (levelMatch) level = Number(levelMatch[1]);
  }
  return { species, level, side: parsed.player };
}

function seenByIdent(
  seen: Map<string, { species: string; level: number; side: 'p1' | 'p2' }>,
  ident: string,
): { species: string; level: number; side: 'p1' | 'p2' } | undefined {
  let parsed: { player: 'p1' | 'p2' | 'p3' | 'p4'; name: string };
  try {
    parsed = Protocol.parsePokemonIdent(ident as Protocol.PokemonIdent);
  } catch {
    return undefined;
  }
  if (parsed.player !== 'p1' && parsed.player !== 'p2') return undefined;
  for (const row of seen.values()) {
    if (row.side === parsed.player && (row.species === parsed.name || `${row.side}:${row.species}`.endsWith(`:${parsed.name}`))) {
      return row;
    }
  }
  return [...seen.values()].find(row => row.side === parsed.player && row.species === parsed.name);
}

function canonBelief(mon: PokemonBelief) {
  return {
    species: mon.species,
    level: mon.level ?? null,
    possibleSets: [...mon.possibleSets.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    revealedMoves: [...mon.revealedMoves].sort(),
    revealedAbility: mon.revealedAbility ?? null,
    revealedItem: mon.revealedItem ?? null,
    revealedTeraType: mon.revealedTeraType ?? null,
    currentHp: mon.currentHp ?? null,
    maxHp: mon.maxHp ?? null,
    stats: mon.stats ?? null,
  };
}

function canonTracking(tracking: OpponentTracking) {
  return {
    activeSpecies: tracking.activeSpecies,
    team: [...tracking.team.entries()]
      .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
      .map(([species, belief]) => ({ species, belief: canonBelief(belief) })),
    revealedMoves: [...tracking.revealedMoves.entries()]
      .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
      .map(([species, moves]) => [species, [...moves].sort()]),
    revealedItems: [...tracking.revealedItems.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    revealedAbilities: [...tracking.revealedAbilities.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  };
}

/** GameState opponent beliefs plus the action pickBestLegal chooses from them. */
function decisionShot(tracker: Playable): { opponentBeliefs: ReturnType<typeof canonBelief>[]; action: Action } {
  const state: GameState = gen9RandomBattle.buildGameState(REQUEST, tracker.tracking());
  const legal = legalActionsForRequest(REQUEST, gen9RandomBattle);
  return {
    opponentBeliefs: state.opponentTeam.map(canonBelief),
    action: pickBestLegal(state, legal),
  };
}

/**
 * Replay the fixture the way the battle driver does: our side is known
 * before the line that named us is applied. Snapshots are taken at the
 * ability reveal and at the end of the log.
 */
function withSide(factory: (ourSide: () => 'p1' | 'p2' | null) => Playable): string {
  let side: 'p1' | 'p2' | null = null;
  const tracker = factory(() => side);
  const shots: unknown[] = [];
  for (const line of FIXTURE) {
    if (line.startsWith('|player|') && line.split('|')[3] === 'Champion') {
      side = line.split('|')[2] as 'p1' | 'p2';
    }
    tracker.applyLine(line);
    if (line === ABILITY || line === '|turn|2') {
      shots.push({ ...decisionShot(tracker), tracking: canonTracking(tracker.tracking()) });
    }
  }
  return JSON.stringify(shots);
}

function clientStub(): ShowdownClient {
  const socket = new EventEmitter();
  return Object.assign(socket, {
    choose: () => true,
    saveReplay: () => true,
    enableBattleTimer: () => true,
    trackRoom: () => undefined,
    untrackRoom: () => undefined,
    isReady: () => true,
  }) as unknown as ShowdownClient;
}

describe('opponent beliefs', () => {
  const championId = loadConfig('configs/champion.yaml').config.opponentModel.setInference.id;
  const calibratedId = loadConfig('configs/examples/opponent-calibrated.yaml').config.opponentModel.setInference.id;

  it('keeps the champion and the default byte-identical to the pre-#62 path', () => {
    expect(championId).toBe('loose');
    const before = fs.existsSync(path.join(process.cwd(), 'data', 'gen9-stats.json'))
      ? fs.readFileSync(path.join(process.cwd(), 'data', 'gen9-stats.json'))
      : null;
    const pre62 = withSide(ourSide => new Pre62Tracker(ourSide, stats));
    let built = 0;
    const champion = withSide(ourSide => new OpponentTracker(gen9RandomBattle, ourSide, {
      setInference: championId,
      stats,
      posteriorFactory() {
        built += 1;
        throw new Error('posterior constructed');
      },
    }));
    const defaults = ['strict', 'unconstrained', undefined].map(id => withSide(ourSide => new OpponentTracker(
      gen9RandomBattle,
      ourSide,
      { setInference: id, stats, posteriorFactory() { built += 1; throw new Error('posterior constructed'); } },
    )));
    const omitted = withSide(ourSide => new OpponentTracker(gen9RandomBattle, ourSide, { stats }));
    expect(champion).toBe(pre62);
    expect(omitted).toBe(pre62);
    for (const bytes of defaults) expect(bytes).toBe(pre62);
    expect(built).toBe(0);
    expect(JSON.parse(champion)).toHaveLength(2);
    expect(JSON.parse(champion)[1].action.type).toBe('move');
    const after = fs.existsSync(path.join(process.cwd(), 'data', 'gen9-stats.json'))
      ? fs.readFileSync(path.join(process.cwd(), 'data', 'gen9-stats.json'))
      : null;
    expect(after).toEqual(before);
  });

  it('uses the posterior when the config opts in', () => {
    expect(calibratedId).toBe('calibrated');
    const legacy = withSide(ourSide => new Pre62Tracker(ourSide, stats));
    const opted = withSide(ourSide => new OpponentTracker(gen9RandomBattle, ourSide, {
      setInference: calibratedId,
      stats,
    }));
    expect(opted).not.toBe(legacy);
    const end = JSON.parse(opted)[1];
    const old = JSON.parse(legacy)[1];
    expect(end.tracking.revealedItems).toEqual([['Ampharos', 'Rocky Helmet']]);
    expect(old.tracking.revealedItems).toEqual([]);
    expect(end.opponentBeliefs[0].revealedItem).toBe('Rocky Helmet');
    expect(old.opponentBeliefs[0].revealedItem).toBeNull();
    let side: 'p1' | 'p2' | null = null;
    const tracker = new OpponentTracker(gen9RandomBattle, () => side, { setInference: 'calibrated', stats });
    for (const line of FIXTURE) {
      if (line.startsWith('|player|') && line.split('|')[3] === 'Champion') {
        side = line.split('|')[2] as 'p1' | 'p2';
      }
      tracker.applyLine(line);
    }
    expect(tracker.usesPosterior()).toBe(true);
    expect(tracker.beliefErrors()).toBe(0);
    expect(Array.isArray(tracker.sampleWorlds(2))).toBe(true);
  });

  it('counts a throwing observe and falls back to the legacy beliefs', () => {
    let calls = 0;
    const logged: string[] = [];
    const legacy = withSide(ourSide => new Pre62Tracker(ourSide, stats));
    const fallen = withSide(ourSide => new OpponentTracker(gen9RandomBattle, ourSide, {
      setInference: 'calibrated',
      stats,
      onBeliefError(err) {
        logged.push(err instanceof Error ? err.message : String(err));
      },
      posteriorFactory(): OpponentPosterior {
        return {
          observe() {
            calls += 1;
            throw new Error('posterior failed');
          },
          sampleWorlds() {
            return [];
          },
        };
      },
    }));
    expect(calls).toBe(1);
    expect(logged).toEqual(['posterior failed']);
    expect(fallen).toBe(legacy);
  });

  it('records beliefErrors on the game and still chooses a move', async () => {
    const loader = dataLoader as unknown as { loaded: boolean; stats: RandbatsStats };
    const previous = { loaded: loader.loaded, stats: loader.stats };
    loader.loaded = true;
    loader.stats = stats;
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-belief-'));
    let calls = 0;
    let decided = 0;
    try {
      const socket = clientStub();
      const driver = new BattleDriver({
        client: socket,
        username: 'BotAlpha',
        format: gen9RandomBattle,
        engineName: 'search',
        decisions: {
          openBattle() { /* unused */ },
          closeBattle() { /* unused */ },
          async stop() { /* unused */ },
          async decide() {
            decided += 1;
            return { action: { type: 'move' as const, moveIndex: 1 }, score: 1, timeMs: 1, fallback: false };
          },
        } as unknown as DecisionClient,
        logDir,
        decisionTimeoutMs: 1000,
        settleMs: 0,
        configPath: 'configs/examples/opponent-calibrated.yaml',
        posteriorFactory(): OpponentPosterior {
          return {
            observe() {
              calls += 1;
              throw new Error('posterior failed');
            },
            sampleWorlds() {
              return [];
            },
          };
        },
      });
      const ended = new Promise<import('./game-record.js').LadderGameRecord>(resolve => driver.on('gameEnd', resolve));
      const room = 'battle-gen9randombattle-belief';
      socket.emit('line', room, '|player|p1|BotAlpha|1|1200');
      socket.emit('line', room, '|player|p2|Rival|2|1500');
      socket.emit('line', room, '|switch|p2a: Ampharos|Ampharos, L88|100/100');
      socket.emit('line', room, '|turn|1');
      socket.emit('line', room, `|request|${JSON.stringify(REQUEST)}`);
      await new Promise(resolve => setTimeout(resolve, 40));
      socket.emit('line', room, '|win|BotAlpha');
      const summary = await ended;
      expect(calls).toBe(1);
      expect(decided).toBe(1);
      expect(summary.beliefErrors).toBe(1);
      const stored = JSON.parse(fs.readFileSync(path.join(logDir, 'games.jsonl'), 'utf8')) as { beliefErrors: number };
      expect(stored.beliefErrors).toBe(1);
      const battleLog = fs.readdirSync(logDir).find(name => name.includes(room));
      expect(battleLog).toBeTruthy();
      const text = fs.readFileSync(path.join(logDir, battleLog as string), 'utf8');
      expect(text).toContain('"type":"belief_error"');
      expect(text).toContain('posterior failed');
      await driver.stop();

      let championBuilt = 0;
      const championSocket = clientStub();
      const champion = new BattleDriver({
        client: championSocket,
        username: 'BotAlpha',
        format: gen9RandomBattle,
        engineName: 'search',
        decisions: {
          openBattle() { /* unused */ },
          closeBattle() { /* unused */ },
          async stop() { /* unused */ },
        } as unknown as DecisionClient,
        logDir,
        decisionTimeoutMs: 1000,
        settleMs: 0,
        configPath: 'configs/champion.yaml',
        posteriorFactory() {
          championBuilt += 1;
          throw new Error('posterior constructed');
        },
      });
      const championEnd = new Promise<import('./game-record.js').LadderGameRecord>(resolve => champion.on('gameEnd', resolve));
      championSocket.emit('line', 'battle-gen9randombattle-champ', '|player|p1|BotAlpha|1|');
      championSocket.emit('line', 'battle-gen9randombattle-champ', '|win|BotAlpha');
      const championSummary = await championEnd;
      expect(championBuilt).toBe(0);
      expect(championSummary.beliefErrors).toBe(0);
      await champion.stop();
    } finally {
      loader.loaded = previous.loaded;
      loader.stats = previous.stats;
    }
  });
});
