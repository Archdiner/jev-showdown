import { Dex } from '@pkmn/dex';

export interface SpecificHit {
  path: string;
  kind: 'species' | 'move' | 'position-rule';
  value: string;
}

const MOVE_RULE = /\b(?:use|click|go|always)\s+([a-z0-9][a-z0-9-]*)/gi;
const POSITION_RULE = /\bturn\s+\d+\b/i;

let speciesIds: Set<string> | null = null;
let moveIds: Set<string> | null = null;

function speciesSet(): Set<string> {
  if (speciesIds) return speciesIds;
  speciesIds = new Set();
  for (const species of Dex.species.all()) {
    if (!species.exists || species.id.length < 4) continue;
    speciesIds.add(species.id);
    const compact = species.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (compact.length >= 4) speciesIds.add(compact);
  }
  return speciesIds;
}

function moveSet(): Set<string> {
  if (moveIds) return moveIds;
  moveIds = new Set();
  for (const move of Dex.moves.all()) {
    if (move.exists && move.id.length >= 4) moveIds.add(move.id);
  }
  return moveIds;
}

/** Species tokens, "use <move>" rules, and turn-specific choice text. */
export function specificityHits(text: string, path = ''): SpecificHit[] {
  const hits: SpecificHit[] = [];
  const species = speciesSet();
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length >= 4 && species.has(token)) {
      hits.push({ path, kind: 'species', value: token });
    }
  }
  const moves = moveSet();
  for (const match of text.matchAll(MOVE_RULE)) {
    const id = match[1].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (moves.has(id)) hits.push({ path, kind: 'move', value: id });
  }
  if (POSITION_RULE.test(text) && /\b(switch|move|click)\b/i.test(text)) {
    hits.push({ path, kind: 'position-rule', value: 'turn-specific choice' });
  }
  return hits;
}

export function walkStrings(value: unknown, path: string, visit: (text: string, path: string) => void): void {
  if (typeof value === 'string') {
    visit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, `${path}[${index}]`, visit));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walkStrings(child, path ? `${path}.${key}` : key, visit);
    }
  }
}

export function assertGeneralValue(value: unknown, label: string): void {
  walkStrings(value, label, (text, path) => {
    const hits = specificityHits(text, path);
    if (hits.length > 0) {
      const hit = hits[0];
      throw new Error(
        `Specific ${hit.kind} "${hit.value}" at ${path}. ` +
        'Configs and hypotheses name a mechanism or eval term, not a species, move, or position.'
      );
    }
  });
}
