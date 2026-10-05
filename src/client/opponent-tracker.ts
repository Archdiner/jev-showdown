import { Protocol } from '@pkmn/protocol';
import { BeliefTracker } from '../engine/belief-tracker.js';
import { SetInference, type OpponentWorld } from '../engine/set-inference/index.js';
import { Format, OpponentTracking, SetCandidate } from '../types/format.js';
import { PokemonBelief } from '../types/index.js';

interface SeenPokemon {
  species: string;
  level: number;
  side: 'p1' | 'p2';
}

/**
 * Narrows opponent randbats roles from protocol reveals.
 * SetInference owns the posterior and writes it onto the shared BeliefTracker.
 * This class keeps the seen/active maps the ladder client already reads.
 */
export class OpponentTracker {
  private beliefs: BeliefTracker;
  private sets: SetInference;
  private seen = new Map<string, SeenPokemon>();
  private activeBySide = new Map<'p1' | 'p2', string>();
  readonly ourSide: () => 'p1' | 'p2' | null;

  constructor(private readonly format: Format, ourSide: () => 'p1' | 'p2' | null) {
    this.ourSide = ourSide;
    this.beliefs = new BeliefTracker();
    this.sets = new SetInference(this.beliefs.stats, { ourSide, beliefs: this.beliefs });
  }

  /** Concrete foe teams from the current posterior. Identical draws are merged. */
  sampleWorlds(n: number): OpponentWorld[] {
    return this.sets.sampleWorlds(n);
  }

  applyLine(line: string): void {
    if (this.ourSide()) this.sets.observe(line);
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
    // observe() already wrote the posterior. initializeBelief would reset it.
    if (!this.ourSide() && !this.beliefs.getBelief(id)) {
      this.beliefs.initializeBelief(id, who.species, who.level);
    }
    this.seen.set(id, who);
    if (!replace) this.activeBySide.set(who.side, who.species);
  }

  private onMove(ident: string | undefined, move: string | undefined): void {
    if (!ident || !move || move === 'Recharge') return;
    const seen = this.seenByIdent(ident);
    if (!seen || seen.side === this.ourSide()) return;
    if (!this.ourSide()) this.beliefs.updateOnMove(this.key(seen), move);
    this.activeBySide.set(seen.side, seen.species);
  }

  private onAbility(ident: string | undefined, ability: string | undefined): void {
    if (!ident || !ability) return;
    const seen = this.seenByIdent(ident);
    if (!seen || seen.side === this.ourSide()) return;
    if (!this.ourSide()) this.beliefs.updateOnAbility(this.key(seen), ability);
  }

  private onItem(ident: string | undefined, item: string | undefined): void {
    if (!ident || !item) return;
    const seen = this.seenByIdent(ident);
    if (!seen || seen.side === this.ourSide()) return;
    if (!this.ourSide()) this.beliefs.updateOnItem(this.key(seen), item);
  }

  private onTera(ident: string | undefined, tera: string | undefined): void {
    if (!ident || !tera) return;
    const seen = this.seenByIdent(ident);
    if (!seen || seen.side === this.ourSide()) return;
    if (!this.ourSide()) this.beliefs.updateOnTeraType(this.key(seen), tera);
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
