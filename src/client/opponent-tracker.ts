import { Protocol } from '@pkmn/protocol';
import { BeliefTracker } from '../engine/belief-tracker.js';
import { SetInference, type OpponentWorld } from '../engine/set-inference/index.js';
import { Format, OpponentTracking, SetCandidate } from '../types/format.js';
import { PokemonBelief, RandbatsStats } from '../types/index.js';

interface SeenPokemon {
  species: string;
  level: number;
  side: 'p1' | 'p2';
}

/** The posterior object. Production uses SetInference. Tests can substitute one. */
export interface OpponentPosterior {
  observe(line: string): void;
  sampleWorlds(n: number): OpponentWorld[];
}

export interface OpponentTrackerOptions {
  /**
   * Config `setInference.id`. Only `calibrated` builds a posterior.
   * `loose` (the champion and the default) and every other id keep BeliefTracker.
   */
  setInference?: string | null;
  /** Randbats table. Omit to use the loaded data file. Tests pass a fixture. */
  stats?: RandbatsStats;
  /** Called after a posterior update throws. The battle has already switched to BeliefTracker. */
  onBeliefError?: (error: unknown, beliefErrors: number) => void;
  /**
   * Builds the posterior. Ignored unless `setInference` is `calibrated`.
   * The default constructs SetInference.
   */
  posteriorFactory?: (beliefs: BeliefTracker, ourSide: () => 'p1' | 'p2' | null) => OpponentPosterior;
}

/** True only for the opt-in posterior. Champion `loose` and a missing id are legacy. */
export function calibratedBeliefs(setInferenceId: string | null | undefined): boolean {
  return setInferenceId === 'calibrated';
}

/**
 * Narrows opponent randbats roles from protocol reveals.
 * The default is the BeliefTracker path from before calibrated set inference.
 * `setInference: calibrated` lets SetInference own the posterior and write it
 * onto that tracker. A throw drops the posterior for the rest of the battle.
 */
export class OpponentTracker {
  private beliefs: BeliefTracker;
  private sets: OpponentPosterior | null = null;
  private readonly statsOption: RandbatsStats | undefined;
  private readonly onBeliefError?: (error: unknown, beliefErrors: number) => void;
  private seen = new Map<string, SeenPokemon>();
  private activeBySide = new Map<'p1' | 'p2', string>();
  private transcript: string[] = [];
  private beliefErrorCount = 0;
  readonly ourSide: () => 'p1' | 'p2' | null;

  constructor(
    private readonly format: Format,
    ourSide: () => 'p1' | 'p2' | null,
    options?: OpponentTrackerOptions,
  ) {
    this.ourSide = ourSide;
    this.statsOption = options?.stats;
    this.onBeliefError = options?.onBeliefError;
    this.beliefs = new BeliefTracker(options?.stats);
    if (calibratedBeliefs(options?.setInference)) {
      const factory = options?.posteriorFactory;
      this.sets = factory
        ? factory(this.beliefs, ourSide)
        : new SetInference(this.beliefs.stats, { ourSide, beliefs: this.beliefs });
    }
  }

  /** Posterior updates that threw. Stays 0 when the battle never opted in. */
  beliefErrors(): number {
    return this.beliefErrorCount;
  }

  /** True while this battle is still updating the posterior. */
  usesPosterior(): boolean {
    return this.sets !== null;
  }

  /** Concrete foe teams from the current posterior. Identical draws are merged. */
  sampleWorlds(n: number): OpponentWorld[] {
    if (!this.sets) return [];
    return this.sets.sampleWorlds(n);
  }

  applyLine(line: string): void {
    if (this.sets) {
      this.transcript.push(line);
      if (this.ourSide()) {
        try {
          this.sets.observe(line);
        } catch (err) {
          this.failPosterior(err);
          return;
        }
      }
    }
    this.applyProtocol(line);
  }

  tracking(): OpponentTracking {
    const revealedMoves = new Map<string, Set<string>>();
    const revealedItems = new Map<string, string>();
    const revealedAbilities = new Map<string, string>();
    const team = new Map<string, PokemonBelief>();

    for (const seen of this.seen.values()) {
      if (seen.side === this.ourSide()) continue;
      const belief = this.beliefs.getBelief(this.key(seen));
      if (!belief) continue;
      revealedMoves.set(seen.species, new Set(belief.revealedMoves));
      if (belief.revealedItem) revealedItems.set(seen.species, belief.revealedItem);
      if (belief.revealedAbility) revealedAbilities.set(seen.species, belief.revealedAbility);
      team.set(seen.species, belief);
    }

    return {
      team,
      activeSpecies: this.foeActive(),
      revealedMoves,
      revealedItems,
      revealedAbilities,
    };
  }

  activeRoles(): SetCandidate[] {
    const species = this.foeActive();
    if (!species) return [];
    const belief = this.beliefForSpecies(species);
    if (!belief) return [];
    return this.format.getPossibleSets(belief);
  }

  /**
   * Drop the posterior and rebuild beliefs with BeliefTracker over every line
   * seen in this battle. Later lines stay on that path.
   */
  private failPosterior(err: unknown): void {
    const lines = this.transcript;
    this.beliefErrorCount += 1;
    this.sets = null;
    this.transcript = [];
    this.beliefs = new BeliefTracker(this.statsOption);
    this.seen.clear();
    this.activeBySide.clear();
    try {
      this.onBeliefError?.(err, this.beliefErrorCount);
    } catch {
      // A log failure must not replace the fallback.
    }
    for (const line of lines) this.applyProtocol(line);
  }

  /** Legacy updates run unless the posterior is active and our side is known. */
  private legacyBeliefs(): boolean {
    return this.sets === null || this.ourSide() === null;
  }

  private applyProtocol(line: string): void {
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
    if (cmd === '-terastallize') {
      this.onTera(a, b);
    }
  }

  private foeActive(): string | null {
    const ours = this.ourSide();
    for (const [side, species] of this.activeBySide) {
      if (side !== ours) return species;
    }
    return null;
  }

  private onReveal(ident: string | undefined, details: string | undefined, replace: boolean): void {
    if (!ident || !details) return;
    const who = this.identify(ident, details);
    if (!who || who.side === this.ourSide()) return;
    const id = this.key(who);
    if (this.legacyBeliefs() && !this.beliefs.getBelief(id)) {
      this.beliefs.initializeBelief(id, who.species, who.level);
    }
    this.seen.set(id, who);
    if (!replace) this.activeBySide.set(who.side, who.species);
  }

  private onMove(ident: string | undefined, move: string | undefined): void {
    if (!ident || !move || move === 'Recharge') return;
    const seen = this.seenByIdent(ident);
    if (!seen || seen.side === this.ourSide()) return;
    if (this.legacyBeliefs()) this.beliefs.updateOnMove(this.key(seen), move);
    this.activeBySide.set(seen.side, seen.species);
  }

  private onAbility(ident: string | undefined, ability: string | undefined): void {
    if (!ident || !ability) return;
    const seen = this.seenByIdent(ident);
    if (!seen || seen.side === this.ourSide()) return;
    if (this.legacyBeliefs()) this.beliefs.updateOnAbility(this.key(seen), ability);
  }

  private onItem(ident: string | undefined, item: string | undefined): void {
    if (!ident || !item) return;
    const seen = this.seenByIdent(ident);
    if (!seen || seen.side === this.ourSide()) return;
    if (this.legacyBeliefs()) this.beliefs.updateOnItem(this.key(seen), item);
  }

  private onTera(ident: string | undefined, tera: string | undefined): void {
    if (!ident || !tera) return;
    const seen = this.seenByIdent(ident);
    if (!seen || seen.side === this.ourSide()) return;
    if (this.legacyBeliefs()) this.beliefs.updateOnTeraType(this.key(seen), tera);
  }

  private beliefForSpecies(species: string): PokemonBelief | undefined {
    for (const seen of this.seen.values()) {
      if (seen.species === species && seen.side !== this.ourSide()) {
        return this.beliefs.getBelief(this.key(seen));
      }
    }
    return undefined;
  }

  private seenByIdent(ident: string): SeenPokemon | undefined {
    let parsed: { player: 'p1' | 'p2' | 'p3' | 'p4'; name: string };
    try {
      parsed = Protocol.parsePokemonIdent(ident as Protocol.PokemonIdent);
    } catch {
      return undefined;
    }
    if (parsed.player !== 'p1' && parsed.player !== 'p2') return undefined;
    for (const seen of this.seen.values()) {
      if (seen.side === parsed.player && (seen.species === parsed.name || this.key(seen).endsWith(`:${parsed.name}`))) {
        return seen;
      }
    }
    const bySpecies = [...this.seen.values()].find(seen => seen.side === parsed.player && seen.species === parsed.name);
    return bySpecies;
  }

  private identify(ident: string, details: string): SeenPokemon | null {
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

  private key(seen: SeenPokemon): string {
    return `${seen.side}:${seen.species}`;
  }
}
