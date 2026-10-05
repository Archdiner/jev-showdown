import { Dex } from '@pkmn/sim';

/**
 * Species name @smogon/calc can construct.
 * A cosmetic forme has no calc row; its battle stats are baseSpecies.
 * Every other forme keeps its own name.
 */
export function battleSpecies(name: string): string {
  const species = Dex.species.get(name);
  if (!species.exists) return name;
  if (species.isCosmeticForme) return species.baseSpecies;
  return species.name;
}
