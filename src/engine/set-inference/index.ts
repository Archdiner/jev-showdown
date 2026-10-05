import { Dex } from '@pkmn/sim';
import type { PokemonBelief, RandbatsStats } from '../../types/index.js';
import type { BeliefTracker } from '../belief-tracker.js';
import {
  abilityName,
  isStatus,
  itemName,
  levelOf,
  lookupSpecies,
  moveName,
  movePriority,
  mulberry32,
  randbatsStat,
  spreadFor,
  stageMultiplier,
  statusBansChoice,
  toId,
  type StatBlock,
  typeName,
} from './catalog.js';
import { informativeItemLikelihood, weatherName } from './damage.js';
import {
  channelDistribution,
  emptyEvidence,
  moveInclusion,
  multiplyLikelihood,
  nextMoveDistribution,
  probabilityOf,
  rolePosterior,
  topOf,
  type Mass,
  type MonEvidence,
} from './posterior.js';
import {
  sampleWorldsFrom,
  teammateDistribution,
  toPokemonSet,
  type ConcretePokemon,
  type OpponentWorld,
} from './sample.js';

export type { ConcretePokemon, OpponentWorld, Mass, MonEvidence, StatBlock };
export { probabilityOf, topOf, toPokemonSet };

export interface FoeSketch {
  species: string;
  level?: number;
  moves?: string[];
  ability?: string;
  item?: string;
  teraType?: string;
}

export interface OurSet {
  species: string;
  level: number;
  ability?: string;
  item?: string;
  evs?: StatBlock;
  ivs?: StatBlock;
}

export interface SpeedObservation {
  species: string;
  foeMovedFirst: boolean;
  /** Viewer's speed after item, boosts, paralysis, and tailwind. */
  ourSpeed: number;
  foeStage?: number;
  foeParalyzed?: boolean;
  foeTailwind?: boolean;
  trickRoom?: boolean;
}

export interface DamageObservation {
  foeSpecies: string;
  foeIsAttacker: boolean;
  move: string;
  otherSpecies: string;
  otherLevel: number;
  otherAbility?: string;
  otherItem?: string;
  otherEvs?: StatBlock;
  otherIvs?: StatBlock;
  otherBoosts?: Partial<StatBlock>;
  foeBoosts?: Partial<StatBlock>;
  defenderStatus?: string;
  observed: number;
  tolerance: number;
  weather?: 'Sun' | 'Rain' | 'Sand' | 'Snow';
}

export interface RevealEvent {
  kind: 'move' | 'item' | 'tera';
  species: string;
  truth: string;
}

type Side = 'p1' | 'p2';

interface PendingAttack {
  attackerSide: Side;
  attackerSpecies: string;
  attackerPos: string;
  move: string;
  targetSide: Side;
  targetPos: string;
  crit: boolean;
  hits: number;
  damage?: { before: number; after: number; max: number };
}

const CHOICE = ['Choice Band', 'Choice Specs', 'Choice Scarf'];
const SPEED_MISS = 0.05;
const EXTENSION_ROCK: Record<'Sun' | 'Rain' | 'Sand' | 'Snow', string> = {
  Sun: 'Heat Rock',
  Rain: 'Damp Rock',
  Sand: 'Smooth Rock',
  Snow: 'Icy Rock',
};
const WEATHER_MOVES: Record<string, 'Sun' | 'Rain' | 'Sand' | 'Snow'> = {
  sunnyday: 'Sun',
  raindance: 'Rain',
  sandstorm: 'Sand',
  snowscape: 'Snow',
  chillyreception: 'Snow',
};
/** Weather from a move or ability lasts 5 turns; an extension rock makes it 8. */
const WEATHER_TURNS = 5;

/**
 * Posterior over a random-battle opponent: roles, moves, items, abilities,
 * Tera types, and the unrevealed teammates. `sampleWorlds(n)` draws concrete
 * teams from that posterior for a search.
 */
export class SetInference {
  private readonly mons = new Map<string, MonEvidence>();
  private readonly order: string[] = [];
  private readonly positions = new Map<string, string>();
  private readonly boosts = new Map<string, Partial<StatBlock>>();
  private readonly status = new Map<string, string>();
  private readonly hp = new Map<string, { cur: number; max: number }>();
  private readonly ourTeam = new Map<string, OurSet>();
  private active = new Map<Side, string>();
  private stayMoves = new Map<string, string[]>();
  private tailwind: Record<Side, number> = { p1: 0, p2: 0 };
  private trickRoom = 0;
  private grassy = false;
  private weather?: 'Sun' | 'Rain' | 'Sand' | 'Snow';
  private pending: PendingAttack | null = null;
  private turnActions: Array<{ side: Side; kind: 'move' | 'switch'; species: string; move?: string; priority: number }> = [];
  private healed = new Set<string>();
  private upkeepPending = false;
  private speedApplied = new Set<string>();
  private leftoversApplied = new Set<string>();
  private damageUpdates = new Map<string, number>();
  private speedChecked = false;
  /** Opt-in (beliefUpdaterEnabled): who set the current weather and how many upkeeps it has lasted. */
  private weatherSetter: { species: string; kind: 'Sun' | 'Rain' | 'Sand' | 'Snow' } | null = null;
  private weatherUpkeeps = 0;
  private readonly rng: () => number;

  constructor(
    readonly stats: RandbatsStats,
    private readonly options: {
      ourSide?: () => Side | null;
      priorOnly?: boolean;
      seed?: number;
      beliefs?: BeliefTracker;
      /**
       * Opt-in belief tightening beyond the default evidence (port of #82):
       * weather that outlasts 5 turns marks the foe setter's extension rock,
       * and Trick / Switcheroo item swaps are read the right way round.
       * Unset keeps every existing posterior byte-identical.
       */
      beliefUpdaterEnabled?: boolean;
    } = {},
  ) {
    this.rng = mulberry32(options.seed ?? 1);
  }

  /** True when the opt-in belief updater runs (never for the prior-only model). */
  get beliefUpdaterEnabled(): boolean {
    return this.options.beliefUpdaterEnabled === true && !this.priorOnly;
  }

  /** Read-only view of one foe's evidence (tests and the decision-battle fill). */
  getMonEvidence(species: string): Readonly<MonEvidence> | undefined {
    return this.mon(species);
  }

  /** Foe species seen so far, in reveal order (SetInference keys). */
  foeSpecies(): string[] {
    return [...this.order];
  }

  /**
   * Weather set by a foe lasted past the 5-turn default, so the setter holds
   * the matching extension rock. Soft (x0.05 on every other item) so a
   * misattributed setter cannot empty the posterior.
   */
  noteWeatherExtended(species: string, kind: 'Sun' | 'Rain' | 'Sand' | 'Snow'): void {
    const mon = this.mon(species);
    if (!mon || !this.beliefUpdaterEnabled || mon.revealedItem) return;
    const rock = EXTENSION_ROCK[kind];
    this.scaleItems(mon, this.itemNames(mon).map(name => ({
      name,
      factor: toId(name) === toId(rock) ? 1 : SPEED_MISS,
    })));
  }

  get priorOnly(): boolean {
    return this.options.priorOnly === true;
  }

  addFoe(species: string, level?: number): MonEvidence {
    const found = lookupSpecies(this.stats, species);
    const name = found?.key || Dex.species.get(species).name || species;
    const mon = this.ensure(name, level || levelOf(found?.table, 80));
    this.writeBelief(this.foeSide(), mon);
    return mon;
  }

  seeMove(species: string, move: string): void {
    const name = moveName(move);
    const mon = this.mon(species);
    if (!name || !mon) return;
    if (!mon.revealedMoves.includes(name)) mon.revealedMoves.push(name);
    const stay = this.stayMoves.get(mon.species) || [];
    if (stay.length > 0 && stay.some(seen => seen !== name)) this.banItems(mon, CHOICE);
    if (!stay.includes(name)) stay.push(name);
    this.stayMoves.set(mon.species, stay);
    if (!this.priorOnly && isStatus(name)) {
      this.banItems(mon, ['Assault Vest']);
      if (statusBansChoice(name)) this.banItems(mon, CHOICE);
    }
    this.writeBelief(this.foeSide(), mon);
  }

  seeAbility(species: string, ability: string): void {
    const name = abilityName(ability);
    const mon = this.mon(species);
    if (!name || !mon || mon.revealedAbility) return;
    const before = mon.revealedAbility;
    mon.revealedAbility = name;
    if (!this.priorOnly && rolePosterior(this.stats, mon, false).length === 0) mon.revealedAbility = before;
    this.writeBelief(this.foeSide(), mon);
  }

  seeItem(species: string, item: string): void {
    const name = itemName(item);
    const mon = this.mon(species);
    if (!name || !mon || mon.revealedItem) return;
    mon.revealedItem = name;
    this.writeBelief(this.foeSide(), mon);
  }

  seeTera(species: string, tera: string): void {
    const name = typeName(tera);
    const mon = this.mon(species);
    if (!name || !mon || mon.revealedTera) return;
    const before = mon.revealedTera;
    mon.revealedTera = name;
    if (!this.priorOnly && rolePosterior(this.stats, mon, false).length === 0) mon.revealedTera = before;
    this.writeBelief(this.foeSide(), mon);
  }

  noteHazard(species: string, source: string): void {
    const mon = this.mon(species);
    if (!mon || this.priorOnly) return;
    const id = toId(source);
    if (id.includes('stealthrock') || id === 'spikes') this.banItems(mon, ['Heavy-Duty Boots']);
    if (id.includes('stealthrock') || id === 'spikes') this.banAbilities(mon, ['Magic Guard']);
    if (id === 'spikes') this.banAbilities(mon, ['Levitate']);
  }

  noteNoLeftovers(species: string): void {
    const mon = this.mon(species);
    if (!mon || this.priorOnly || mon.revealedItem) return;
    this.scaleItems(mon, [{ name: 'Leftovers', factor: SPEED_MISS }]);
  }

  noteSpeed(obs: SpeedObservation): void {
    const mon = this.mon(obs.species);
    if (!mon || this.priorOnly || mon.revealedItem || this.speedApplied.has(mon.species)) return;
    const species = Dex.species.get(mon.species);
    if (!species.exists) return;
    const speEv = mon.revealedMoves.some(move => move === 'Gyro Ball' || move === 'Trick Room') ? 0 : 85;
    const base = randbatsStat(species.baseStats.spe, mon.level, speEv, speEv === 0 ? 0 : 31);
    const speeds = [base, Math.floor(base * 1.5)].map(speed => this.modifySpeed(speed, obs));
    const scarfOk = this.orderMatches(speeds[1], obs.ourSpeed, obs.foeMovedFirst, !!obs.trickRoom);
    const plainOk = this.orderMatches(speeds[0], obs.ourSpeed, obs.foeMovedFirst, !!obs.trickRoom);
    if (scarfOk === plainOk) return;
    this.speedApplied.add(mon.species);
    const updates = this.itemNames(mon).map(name => ({
      name,
      factor: toId(name) === 'choicescarf'
        ? (scarfOk ? 1 : SPEED_MISS)
        : (plainOk ? 1 : SPEED_MISS),
    }));
    this.scaleItems(mon, updates);
  }

  noteDamage(obs: DamageObservation): void {
    const mon = this.mon(obs.foeSpecies);
    if (!mon || this.priorOnly || mon.revealedItem) return;
    const used = this.damageUpdates.get(mon.species) || 0;
    if (used >= 2) return;
    const candidates = this.itemNames(mon);
    if (candidates.length < 2) return;
    const spread = spreadFor(mon.species, mon.level, rolePosterior(this.stats, mon, false)[0]?.data, lookupSpecies(this.stats, mon.species)?.table);
    const ability = mon.revealedAbility || this.singleAbility(mon);
    if (!mon.revealedAbility && !ability) return;
    const likelihood = informativeItemLikelihood({
      attackerSpecies: obs.foeIsAttacker ? mon.species : obs.otherSpecies,
      attackerLevel: obs.foeIsAttacker ? mon.level : obs.otherLevel,
      attackerAbility: obs.foeIsAttacker ? ability : obs.otherAbility,
      attackerEvs: obs.foeIsAttacker ? spread.evs : obs.otherEvs,
      attackerIvs: obs.foeIsAttacker ? spread.ivs : obs.otherIvs,
      attackerBoosts: obs.foeIsAttacker ? obs.foeBoosts : obs.otherBoosts,
      defenderSpecies: obs.foeIsAttacker ? obs.otherSpecies : mon.species,
      defenderLevel: obs.foeIsAttacker ? obs.otherLevel : mon.level,
      defenderAbility: obs.foeIsAttacker ? obs.otherAbility : ability,
      defenderEvs: obs.foeIsAttacker ? obs.otherEvs : spread.evs,
      defenderIvs: obs.foeIsAttacker ? obs.otherIvs : spread.ivs,
      defenderBoosts: obs.foeIsAttacker ? obs.otherBoosts : obs.foeBoosts,
      defenderStatus: obs.defenderStatus,
      move: obs.move,
      observed: obs.observed,
      tolerance: obs.tolerance,
      weather: obs.weather,
      candidates,
    }, obs.foeIsAttacker ? 'attacker' : 'defender', obs.otherItem);
    if (!likelihood) return;
    this.damageUpdates.set(mon.species, used + 1);
    this.scaleItems(mon, [...likelihood.entries()].map(([name, factor]) => ({ name, factor })));
  }

  attachOurTeam(team: OurSet[]): void {
    this.ourTeam.clear();
    for (const mon of team) {
      const name = Dex.species.get(mon.species).name || mon.species;
      this.ourTeam.set(toId(name), { ...mon, species: name });
    }
  }

  /**
   * What a public protocol line is about to reveal, before it is applied.
   * Already-known moves, items, and Teras are not events.
   */
  upcoming(line: string): RevealEvent | null {
    const event = this.describe(line);
    if (!event || !this.isFoe(event.side)) return null;
    const species = event.species || this.positions.get(event.position || '');
    if (!species) return null;
    const mon = this.mons.get(species);
    if (event.kind === 'move') {
      const move = moveName(event.value);
      if (!move || mon?.revealedMoves.includes(move)) return null;
      return { kind: 'move', species, truth: move };
    }
    if (event.kind === 'item') {
      const item = itemName(event.value);
      if (!item || mon?.revealedItem) return null;
      return { kind: 'item', species, truth: item };
    }
    const tera = typeName(event.value);
    if (!tera || mon?.revealedTera) return null;
    return { kind: 'tera', species, truth: tera };
  }

  observe(line: string): void {
    if (!line.startsWith('|')) return;
    const parts = line.split('|').slice(1);
    const cmd = parts[0];
    if (cmd === 'move' || cmd === 'switch' || cmd === 'drag' || cmd === 'turn' || cmd === 'upkeep' || cmd === 'faint') {
      this.flushAttack();
    }
    if (cmd === 'switch' || cmd === 'drag' || cmd === 'replace') {
      this.onSwitch(parts[1], parts[2], parts[3], cmd !== 'replace');
      return;
    }
    if (cmd === 'move') {
      this.onMove(parts[1], parts[2], parts[3]);
      return;
    }
    if (cmd === '-damage' || cmd === '-heal') {
      const borne = itemBearer(parts);
      if (borne) {
        const parsed = this.ident(borne.ident);
        if (parsed && this.isFoe(parsed.side)) this.seeItem(this.positions.get(parsed.position) || parsed.name, borne.item);
        if (cmd === '-heal') this.onHeal(borne.ident, parts[2], parts[3]);
        return;
      }
      if (cmd === '-damage') this.onDamage(parts[1], parts[2], parts[3]);
      else this.onHeal(parts[1], parts[2], parts[3]);
      return;
    }
    if (cmd === '-crit') {
      if (this.pending) this.pending.crit = true;
      return;
    }
    if (cmd === '-hitcount') {
      if (this.pending) this.pending.hits = Number(parts[2]) || 1;
      return;
    }
    if (cmd === '-ability') {
      this.onAbility(parts[1], parts[2]);
      return;
    }
    if (cmd === '-item' || cmd === '-enditem') {
      this.onItem(parts[1], parts[2], parts[3]);
      return;
    }
    if (cmd === '-terastallize') {
      this.onTera(parts[1], parts[2]);
      return;
    }
    if (cmd === '-boost' || cmd === '-unboost') {
      this.onBoost(parts[1], parts[2], Number(parts[3]) || 1, cmd === '-unboost');
      return;
    }
    if (cmd === '-status') {
      const pos = this.pos(parts[1]);
      if (pos) this.status.set(pos, parts[2] || '');
      return;
    }
    if (cmd === '-weather') {
      const kind = weatherName(parts[1]);
      if (this.beliefUpdaterEnabled) this.trackWeather(parts, kind);
      this.weather = kind;
      return;
    }
    if (cmd === '-fieldstart' || cmd === '-fieldend') {
      const effect = toId(parts[1] || '');
      if (effect.includes('trickroom')) this.trickRoom = cmd === '-fieldstart' ? 5 : 0;
      if (effect.includes('grassyterrain')) this.grassy = cmd === '-fieldstart';
      return;
    }
    if (cmd === '-sidestart' || cmd === '-sideend') {
      const side = parts[1]?.startsWith('p2') ? 'p2' : parts[1]?.startsWith('p1') ? 'p1' : null;
      if (side && toId(parts[2] || '').includes('tailwind')) this.tailwind[side] = cmd === '-sidestart' ? 4 : 0;
      return;
    }
    if (cmd === 'upkeep') {
      this.upkeepPending = true;
      return;
    }
    if (cmd === 'turn') {
      if (this.upkeepPending) this.onUpkeep();
      this.upkeepPending = false;
      this.turnActions = [];
      this.speedChecked = false;
      this.healed.clear();
      for (const side of ['p1', 'p2'] as Side[]) {
        if (this.tailwind[side] > 0) this.tailwind[side]--;
      }
      if (this.trickRoom > 0) this.trickRoom--;
    }
  }

  observeLog(lines: readonly string[]): void {
    for (const line of lines) this.observe(line);
  }

  roleDistribution(species: string): Mass[] {
    const mon = this.mon(species);
    if (!mon) return [];
    return rolePosterior(this.stats, mon, this.priorOnly).map(role => ({
      value: role.role,
      probability: role.probability,
    }));
  }

  moveDistribution(species: string): Mass[] {
    const mon = this.mon(species);
    return mon ? nextMoveDistribution(this.stats, mon, this.priorOnly) : [];
  }

  /** P(move is on the set). These do not sum to 1. */
  moveInclusion(species: string): Mass[] {
    const mon = this.mon(species);
    if (!mon) return [];
    return [...moveInclusion(this.stats, mon, this.priorOnly).entries()].map(([value, probability]) => ({ value, probability }));
  }

  itemDistribution(species: string): Mass[] {
    const mon = this.mon(species);
    return mon ? channelDistribution(this.stats, mon, 'items', this.priorOnly) : [];
  }

  abilityDistribution(species: string): Mass[] {
    const mon = this.mon(species);
    return mon ? channelDistribution(this.stats, mon, 'abilities', this.priorOnly) : [];
  }

  teraDistribution(species: string): Mass[] {
    const mon = this.mon(species);
    return mon ? channelDistribution(this.stats, mon, 'tera', this.priorOnly) : [];
  }

  teammateDistribution(): Mass[] {
    const revealed = this.order.map(species => {
      const top = this.roleDistribution(species)[0]?.value || '';
      const moves = this.mons.get(species)?.revealedMoves || [];
      return { species, role: moves.includes('Tera Blast') ? 'Tera Blast user' : top };
    });
    return teammateDistribution(this.stats, revealed);
  }

  /** Concrete foe teams drawn from the posterior. Identical draws are merged. */
  sampleWorlds(n: number): OpponentWorld[] {
    const revealed = this.order.map(species => this.mons.get(species)!).filter(Boolean);
    const active = [...this.active.entries()].find(([side]) => side === this.foeSide())?.[1];
    return sampleWorldsFrom(this.stats, revealed, active, n, this.rng, this.priorOnly);
  }

  private ensure(species: string, level: number): MonEvidence {
    const existing = this.mons.get(species);
    if (existing) return existing;
    const mon = emptyEvidence(species, level);
    this.mons.set(species, mon);
    this.order.push(species);
    return mon;
  }

  private mon(species: string): MonEvidence | undefined {
    if (this.mons.has(species)) return this.mons.get(species);
    const found = lookupSpecies(this.stats, species);
    if (found && this.mons.has(found.key)) return this.mons.get(found.key);
    return undefined;
  }

  private itemNames(mon: MonEvidence): string[] {
    const rows = channelDistribution(this.stats, { ...mon, itemLikelihood: new Map(), revealedItem: undefined }, 'items', true);
    return rows.map(row => row.value);
  }

  private singleAbility(mon: MonEvidence): string | undefined {
    const rows = channelDistribution(this.stats, { ...mon, abilityLikelihood: new Map(), revealedAbility: undefined }, 'abilities', true);
    if (rows.length === 1) return rows[0].value;
    if (rows[0] && rows[0].probability >= 0.99) return rows[0].value;
    return undefined;
  }

  private banItems(mon: MonEvidence, names: string[]): void {
    this.scaleItems(mon, names.map(name => ({ name, factor: 0 })));
  }

  private banAbilities(mon: MonEvidence, names: string[]): void {
    if (this.priorOnly) return;
    const before = new Map(mon.abilityLikelihood);
    for (const name of names) multiplyLikelihood(mon.abilityLikelihood, name, 0);
    if (rolePosterior(this.stats, mon, false).length === 0) mon.abilityLikelihood = before;
    else this.writeBelief(this.foeSide(), mon);
  }

  private scaleItems(mon: MonEvidence, updates: Array<{ name: string; factor: number }>): void {
    if (this.priorOnly) return;
    const before = new Map(mon.itemLikelihood);
    for (const update of updates) {
      if (update.factor === 1) continue;
      multiplyLikelihood(mon.itemLikelihood, update.name, update.factor);
    }
    if (rolePosterior(this.stats, mon, false).length === 0) mon.itemLikelihood = before;
    else this.writeBelief(this.foeSide(), mon);
  }

  private modifySpeed(speed: number, obs: SpeedObservation): number {
    let value = Math.floor(speed * stageMultiplier(obs.foeStage || 0));
    if (obs.foeTailwind) value *= 2;
    if (obs.foeParalyzed) value = Math.floor(value * 0.5);
    return value;
  }

  private orderMatches(foeSpeed: number, ourSpeed: number, foeFirst: boolean, trickRoom: boolean): boolean {
    if (foeSpeed === ourSpeed) return true;
    const foeFaster = trickRoom ? foeSpeed < ourSpeed : foeSpeed > ourSpeed;
    return foeFaster === foeFirst;
  }

  private writeBelief(side: Side, mon: MonEvidence): void {
    const beliefs = this.options.beliefs;
    if (!beliefs) return;
    const id = `${side}:${mon.species}`;
    if (!beliefs.getBelief(id)) beliefs.initializeBelief(id, mon.species, mon.level);
    const belief: PokemonBelief | undefined = beliefs.getBelief(id);
    if (!belief) return;
    belief.level = mon.level;
    belief.revealedMoves = new Set(mon.revealedMoves);
    belief.revealedAbility = mon.revealedAbility;
    belief.revealedItem = mon.revealedItem;
    belief.revealedTeraType = mon.revealedTera;
    const roles = rolePosterior(this.stats, mon, this.priorOnly);
    if (roles.length) belief.possibleSets = new Map(roles.map(role => [role.role, role.probability]));
  }

  private foeSide(): Side {
    return this.viewer() === 'p2' ? 'p1' : 'p2';
  }

  private viewer(): Side | null {
    if (!this.options.ourSide) return 'p1';
    return this.options.ourSide();
  }

  private isFoe(side: Side | null): boolean {
    const viewer = this.viewer();
    return !!side && viewer !== null && side !== viewer;
  }

  private onSwitch(ident: string | undefined, details: string | undefined, hp: string | undefined, countsAsSwitch: boolean): void {
    const parsed = this.ident(ident);
    if (!parsed || !details) return;
    const species = Dex.species.get(details.split(',')[0]?.trim() || parsed.name).name || details.split(',')[0]?.trim();
    const levelMatch = details.match(/L(\d+)/);
    const found = lookupSpecies(this.stats, species || '');
    const level = levelMatch ? Number(levelMatch[1]) : levelOf(found?.table, 80);
    const name = found?.key || species;
    this.positions.set(parsed.position, name);
    this.active.set(parsed.side, name);
    this.readHp(parsed.position, hp);
    if (!this.isFoe(parsed.side)) return;
    this.ensure(name, level);
    if (countsAsSwitch) this.stayMoves.set(name, []);
    this.writeBelief(parsed.side, this.mons.get(name)!);
    if (countsAsSwitch) this.turnActions.push({ side: parsed.side, kind: 'switch', species: name, priority: 0 });
  }

  private onMove(ident: string | undefined, move: string | undefined, target: string | undefined): void {
    const parsed = this.ident(ident);
    const name = moveName(move);
    if (!parsed || !name) return;
    const species = this.positions.get(parsed.position) || parsed.name;
    this.active.set(parsed.side, species);
    const targetPos = this.ident(target);
    this.pending = {
      attackerSide: parsed.side,
      attackerSpecies: species,
      attackerPos: parsed.position,
      move: name,
      targetSide: targetPos?.side || (parsed.side === 'p1' ? 'p2' : 'p1'),
      targetPos: targetPos?.position || '',
      crit: false,
      hits: 1,
    };
    if (this.isFoe(parsed.side)) this.seeMove(species, name);
    this.turnActions.push({ side: parsed.side, kind: 'move', species, move: name, priority: movePriority(name) });
    this.maybeSpeed();
  }

  private maybeSpeed(): void {
    if (this.speedChecked) return;
    const moves = this.turnActions.filter(action => action.kind === 'move');
    const sides = new Set(moves.map(action => action.side));
    if (sides.size < 2 || this.turnActions.some(action => action.kind === 'switch')) return;
    const first = moves[0];
    const second = moves.find(action => action.side !== first.side);
    this.speedChecked = true;
    if (!second || first.priority !== second.priority) return;
    const foe = first.side === this.foeSide() ? first : second.side === this.foeSide() ? second : null;
    const ours = first.side === this.viewer() ? first : second.side === this.viewer() ? second : null;
    if (!foe || !ours) return;
    const ourSpeed = this.ourEffectiveSpeed(ours.species);
    if (ourSpeed == null) return;
    const foePos = [...this.positions.entries()].find(([, species]) => species === foe.species)?.[0];
    this.noteSpeed({
      species: foe.species,
      foeMovedFirst: first === foe,
      ourSpeed,
      foeStage: foePos ? this.boosts.get(foePos)?.spe || 0 : 0,
      foeParalyzed: foePos ? this.status.get(foePos) === 'par' : false,
      foeTailwind: this.tailwind[foe.side] > 0,
      trickRoom: this.trickRoom > 0,
    });
  }

  private ourEffectiveSpeed(species: string): number | null {
    const ours = this.ourTeam.get(toId(species));
    const dex = Dex.species.get(species);
    if (!ours || !dex.exists) return null;
    const ev = ours.evs?.spe ?? 85;
    const iv = ours.ivs?.spe ?? 31;
    let speed = randbatsStat(dex.baseStats.spe, ours.level, ev, iv);
    if (toId(ours.item || '') === 'choicescarf') speed = Math.floor(speed * 1.5);
    const pos = [...this.positions.entries()].find(([, name]) => toId(name) === toId(species))?.[0];
    speed = Math.floor(speed * stageMultiplier(pos ? this.boosts.get(pos)?.spe || 0 : 0));
    const side = this.viewer();
    if (side && this.tailwind[side] > 0) speed *= 2;
    if (pos && this.status.get(pos) === 'par') speed = Math.floor(speed * 0.5);
    return speed;
  }

  private onDamage(ident: string | undefined, hp: string | undefined, from: string | undefined): void {
    const parsed = this.ident(ident);
    if (!parsed) return;
    const previous = this.hp.get(parsed.position);
    const next = this.readHp(parsed.position, hp);
    const reason = from || '';
    if (reason.includes('item:')) return;
    if (/Stealth Rock|Spikes/i.test(reason) && this.isFoe(parsed.side)) {
      this.noteHazard(this.positions.get(parsed.position) || parsed.name, reason);
      return;
    }
    if (!this.pending || this.pending.targetPos !== parsed.position || reason.includes('[from]')) return;
    if (previous && next) this.pending.damage = { before: previous.cur, after: next.cur, max: next.max };
  }

  private onHeal(ident: string | undefined, hp: string | undefined, from: string | undefined): void {
    const parsed = this.ident(ident);
    if (!parsed) return;
    this.readHp(parsed.position, hp);
    this.healed.add(parsed.position);
  }

  private flushAttack(): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending?.damage || pending.crit || pending.hits > 1) return;
    const foeIsAttacker = this.isFoe(pending.attackerSide);
    const foeIsDefender = this.isFoe(pending.targetSide);
    if (foeIsAttacker === foeIsDefender) return;
    const foeSpecies = foeIsAttacker ? pending.attackerSpecies : this.positions.get(pending.targetPos) || '';
    const ourSpecies = foeIsAttacker ? this.positions.get(pending.targetPos) || '' : pending.attackerSpecies;
    const ours = this.ourTeam.get(toId(ourSpecies));
    if (!foeSpecies || !ours) return;
    const exact = pending.damage.max !== 100;
    const fraction = exact ? null : (pending.damage.before - pending.damage.after) / pending.damage.max;
    const defenderMax = foeIsAttacker ? this.ourMaxHp(ours) : this.foeMaxHp(foeSpecies);
    if (!defenderMax) return;
    const observed = exact ? pending.damage.before - pending.damage.after : Math.round((fraction || 0) * defenderMax);
    if (observed <= 0) return;
    const foePos = foeIsAttacker ? pending.attackerPos : pending.targetPos;
    const ourPos = foeIsAttacker ? pending.targetPos : pending.attackerPos;
    this.noteDamage({
      foeSpecies,
      foeIsAttacker,
      move: pending.move,
      otherSpecies: ours.species,
      otherLevel: ours.level,
      otherAbility: ours.ability,
      otherItem: ours.item,
      otherEvs: ours.evs,
      otherIvs: ours.ivs,
      otherBoosts: this.boosts.get(ourPos),
      foeBoosts: this.boosts.get(foePos),
      defenderStatus: this.status.get(foeIsAttacker ? ourPos : foePos),
      observed,
      tolerance: exact ? 1 : Math.max(2, defenderMax * 0.02),
      weather: this.weather,
    });
  }

  /**
   * `|-weather|X|[upkeep]` counts a turn of the current weather. A fresh
   * `|-weather|X|[from] ability: Y|[of] p2a: Z` or one right after a foe's
   * weather move records the setter. Anything else (ours, none) clears it.
   */
  private trackWeather(parts: string[], kind: 'Sun' | 'Rain' | 'Sand' | 'Snow' | undefined): void {
    if (!kind) {
      this.weatherSetter = null;
      this.weatherUpkeeps = 0;
      return;
    }
    if (parts.includes('[upkeep]')) {
      if (!this.weatherSetter || this.weatherSetter.kind !== kind) return;
      this.weatherUpkeeps++;
      if (this.weatherUpkeeps === WEATHER_TURNS) this.noteWeatherExtended(this.weatherSetter.species, kind);
      return;
    }
    this.weatherUpkeeps = 0;
    this.weatherSetter = null;
    const of = parts.find(part => part.startsWith('[of] '));
    const fromAbility = parts.some(part => part.startsWith('[from] ability:'));
    let setter: { side: Side; species: string } | null = null;
    if (fromAbility && of) {
      const parsed = this.ident(of.slice('[of] '.length).trim());
      const species = parsed ? this.positions.get(parsed.position) : undefined;
      if (parsed && species) setter = { side: parsed.side, species };
    } else if (!fromAbility && this.pending && WEATHER_MOVES[toId(this.pending.move)] === kind) {
      setter = { side: this.pending.attackerSide, species: this.pending.attackerSpecies };
    }
    if (setter && this.isFoe(setter.side)) this.weatherSetter = { species: setter.species, kind };
  }

  private ourMaxHp(ours: OurSet): number {
    return spreadFor(ours.species, ours.level, undefined, undefined).stats.hp;
  }

  private foeMaxHp(species: string): number {
    const mon = this.mon(species);
    if (!mon) return 0;
    return spreadFor(mon.species, mon.level, rolePosterior(this.stats, mon, false)[0]?.data, lookupSpecies(this.stats, mon.species)?.table).stats.hp;
  }

  private onUpkeep(): void {
    if (this.grassy || this.priorOnly) return;
    for (const [side, species] of this.active) {
      if (!this.isFoe(side)) continue;
      const pos = [...this.positions.entries()].find(([, name]) => name === species)?.[0];
      if (!pos || this.healed.has(pos) || this.leftoversApplied.has(species)) continue;
      this.leftoversApplied.add(species);
      const hp = this.hp.get(pos);
      if (!hp || hp.cur <= 0 || hp.cur >= hp.max) continue;
      this.noteNoLeftovers(species);
    }
  }

  private onAbility(ident: string | undefined, ability: string | undefined): void {
    const parsed = this.ident(ident);
    if (!parsed || !ability || !this.isFoe(parsed.side)) return;
    const species = this.positions.get(parsed.position);
    if (species) this.seeAbility(species, ability);
  }

  private onItem(ident: string | undefined, item: string | undefined, from: string | undefined): void {
    const parsed = this.ident(ident);
    if (!parsed || !item) return;
    if (this.beliefUpdaterEnabled && from && /move: (trick|switcheroo)/i.test(from)) {
      // `-item` names what the mon received. Ours came from the foe active,
      // which is its original item; the foe's came from us and says nothing.
      if (this.isFoe(parsed.side)) return;
      const foe = this.active.get(this.foeSide());
      if (foe && this.mons.has(foe)) this.seeItem(foe, item);
      return;
    }
    if (!this.isFoe(parsed.side)) return;
    if (from && /knocked off|stole|tricked/i.test(from)) return;
    const species = this.positions.get(parsed.position);
    if (species) this.seeItem(species, item);
  }

  private onTera(ident: string | undefined, tera: string | undefined): void {
    const parsed = this.ident(ident);
    if (!parsed || !tera || !this.isFoe(parsed.side)) return;
    const species = this.positions.get(parsed.position);
    if (species) this.seeTera(species, tera);
  }

  private onBoost(ident: string | undefined, stat: string | undefined, amount: number, down: boolean): void {
    const pos = this.pos(ident);
    if (!pos || !stat) return;
    const key = stat as keyof StatBlock;
    const current = this.boosts.get(pos) || {};
    const next = { ...current, [key]: (current[key] || 0) + (down ? -amount : amount) };
    this.boosts.set(pos, next);
  }

  private readHp(position: string, text: string | undefined): { cur: number; max: number } | null {
    const match = text?.match(/(\d+)\/(\d+)/);
    if (!match) return null;
    const hp = { cur: Number(match[1]), max: Number(match[2]) };
    this.hp.set(position, hp);
    return hp;
  }

  private pos(ident: string | undefined): string | null {
    return this.ident(ident)?.position || null;
  }

  private ident(ident: string | undefined): { side: Side; position: string; name: string } | null {
    if (!ident) return null;
    const match = /^p([12])([a-z]):\s*(.*)$/.exec(ident);
    if (!match) return null;
    const side = (`p${match[1]}`) as Side;
    return { side, position: `${side}${match[2]}`, name: match[3] };
  }

  private describe(line: string): { kind: 'move' | 'item' | 'tera'; side: Side; position: string; species?: string; value: string } | null {
    if (!line.startsWith('|')) return null;
    const parts = line.split('|').slice(1);
    const parsed = this.ident(parts[1]);
    if (!parsed) return null;
    if (parts[0] === 'move' && parts[2]) return { kind: 'move', side: parsed.side, position: parsed.position, value: parts[2] };
    if ((parts[0] === '-item' || parts[0] === '-enditem') && parts[2]) {
      if (parts[3] && /knocked off|stole|tricked/i.test(parts[3])) return null;
      return { kind: 'item', side: parsed.side, position: parsed.position, value: parts[2] };
    }
    if ((parts[0] === '-damage' || parts[0] === '-heal') && itemBearer(parts)) {
      const borne = itemBearer(parts)!;
      const holder = this.ident(borne.ident);
      if (!holder) return null;
      return { kind: 'item', side: holder.side, position: holder.position, value: borne.item };
    }
    if (parts[0] === '-terastallize' && parts[2]) return { kind: 'tera', side: parsed.side, position: parsed.position, value: parts[2] };
    return null;
  }
}

/**
 * `|from] item:` on a damage or heal line belongs to `[of]` when that
 * pokemon is named (Rocky Helmet, Rough Skin berries). Otherwise it belongs
 * to the pokemon in the line (Life Orb recoil, Leftovers).
 */
function itemBearer(parts: string[]): { ident: string; item: string } | null {
  const from = parts.find(part => part.includes('item:'));
  if (!from || (parts[0] !== '-damage' && parts[0] !== '-heal')) return null;
  const item = from.split('item:')[1]?.trim();
  if (!item) return null;
  const of = parts.find(part => part.startsWith('[of] '));
  const ident = of ? of.slice('[of] '.length).trim() : parts[1];
  if (!ident) return null;
  return { ident, item };
}

export function sampleWorlds(source: SetInference, n: number): OpponentWorld[] {
  return source.sampleWorlds(n);
}

/** Build a posterior from the foe Pokémon a search has already seen. */
export function inferenceFromFoes(
  stats: RandbatsStats,
  foes: FoeSketch[],
  options?: { seed?: number; ourSide?: Side },
): SetInference {
  const inference = new SetInference(stats, {
    ourSide: () => options?.ourSide || 'p1',
    seed: options?.seed ?? 1,
  });
  const foeSide = (options?.ourSide || 'p1') === 'p1' ? 'p2' : 'p1';
  foes.forEach((foe, index) => {
    const mon = inference.addFoe(foe.species, foe.level);
    if (index === 0) {
      inference.observe(`|switch|${foeSide}a: ${mon.species}|${mon.species}, L${mon.level}|100/100`);
    }
    for (const move of foe.moves || []) inference.seeMove(mon.species, move);
    if (foe.ability) inference.seeAbility(mon.species, foe.ability);
    if (foe.item) inference.seeItem(mon.species, foe.item);
    if (foe.teraType) inference.seeTera(mon.species, foe.teraType);
  });
  return inference;
}

/** Same posterior as inferenceFromFoes, from a PokemonBelief a search already holds. */
export function inferenceFromBelief(
  stats: RandbatsStats,
  belief: PokemonBelief,
  options?: { seed?: number; ourSide?: Side },
): SetInference {
  return inferenceFromFoes(stats, [{
    species: belief.species,
    level: belief.level,
    moves: [...belief.revealedMoves],
    ability: belief.revealedAbility,
    item: belief.revealedItem,
    teraType: belief.revealedTeraType,
  }], options);
}
