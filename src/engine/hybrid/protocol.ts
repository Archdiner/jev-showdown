import { Dex } from '@pkmn/sim';

export type SpeedOrder = 'faster' | 'slower';

export interface PublicNotes {
  myHazards: string[];
  foeHazards: string[];
  /** Species id -> took residual hazard damage, so Heavy-Duty Boots is impossible. */
  hazardChip: Set<string>;
  /** Species id -> revealed a status move, so Assault Vest is impossible. */
  statusMove: Set<string>;
  /** Species id -> speed order versus us on a non-priority exchange. */
  speed: Map<string, SpeedOrder>;
}

const HAZARD_NAMES = ['stealthrock', 'spikes', 'toxicspikes', 'stickyweb', 'gmaxsteelsurge'];

/**
 * Read public protocol only. `ourSide` is the side making the decision.
 * Hazard chip and a revealed status move are negative evidence for items.
 */
export function parsePublic(lines: readonly string[], ourSide: 'p1' | 'p2'): PublicNotes {
  const foe = ourSide === 'p1' ? 'p2' : 'p1';
  const myHazards = new Set<string>();
  const foeHazards = new Set<string>();
  const hazardChip = new Set<string>();
  const statusMove = new Set<string>();
  const speed = new Map<string, SpeedOrder>();
  let trickRoom = false;
  let chunk: string[] = [];

  const flush = () => {
    noteSpeed(chunk, foe, trickRoom, speed);
    chunk = [];
  };

  for (const line of lines) {
    if (line.startsWith('|turn|') || line.startsWith('|start|')) {
      flush();
      continue;
    }
    chunk.push(line);
    if (line.startsWith('|fieldstart|') && /trick room/i.test(line)) trickRoom = true;
    if (line.startsWith('|fieldend|') && /trick room/i.test(line)) trickRoom = false;

    const sideStart = /^\|-sidestart\|(p[12])[^|]*\|(.*)$/.exec(line);
    if (sideStart) {
      const id = hazardId(sideStart[2]);
      if (id) (sideStart[1] === ourSide ? myHazards : foeHazards).add(id);
    }
    const sideEnd = /^\|-sideend\|(p[12])[^|]*\|(.*)$/.exec(line);
    if (sideEnd) {
      const id = hazardId(sideEnd[2]);
      if (id) (sideEnd[1] === ourSide ? myHazards : foeHazards).delete(id);
    }

    const moved = /^\|move\|(p[12])[abc]:\s*([^|]+)\|([^|]+)/.exec(line);
    if (moved && moved[1] === foe && isStatusMove(moved[3])) {
      statusMove.add(speciesId(moved[2]));
    }

    const damage = /^\|-damage\|(p[12])[abc]:\s*([^|]+)\|[^|]*\|\[from\]\s*(?:move:\s*)?([^|]+)/.exec(line);
    if (damage && damage[1] === foe && isHazardSource(damage[3])) {
      hazardChip.add(speciesId(damage[2]));
    }
  }
  flush();

  return { myHazards: [...myHazards], foeHazards: [...foeHazards], hazardChip, statusMove, speed };
}

function noteSpeed(
  chunk: string[],
  foe: 'p1' | 'p2',
  trickRoom: boolean,
  speed: Map<string, SpeedOrder>,
): void {
  const order: Array<{ side: string; species: string; priority: number }> = [];
  for (const line of chunk) {
    const moved = /^\|move\|(p[12])[abc]:\s*([^|]+)\|([^|]+)/.exec(line);
    if (!moved) continue;
    order.push({
      side: moved[1],
      species: speciesId(moved[2]),
      priority: Dex.moves.get(moved[3]).priority || 0,
    });
  }
  const ours = order.find(row => row.side !== foe && row.priority === 0);
  const theirs = order.find(row => row.side === foe && row.priority === 0);
  if (!ours || !theirs) return;
  const foeFirst = order.indexOf(theirs) < order.indexOf(ours);
  const faster = trickRoom ? !foeFirst : foeFirst;
  speed.set(theirs.species, faster ? 'faster' : 'slower');
}

function hazardId(raw: string): string | null {
  const name = raw.replace(/^move:\s*/i, '').trim();
  const id = toId(name);
  if (HAZARD_NAMES.includes(id)) return id;
  const move = Dex.moves.get(name);
  if (move.exists && move.sideCondition && HAZARD_NAMES.includes(toId(move.sideCondition))) {
    return toId(move.sideCondition);
  }
  return null;
}

function isHazardSource(raw: string): boolean {
  const move = Dex.moves.get(raw);
  if (!move.exists) return hazardId(raw) != null;
  if (move.id === 'gmaxsteelsurge' || move.id === 'stealthrock' || move.id === 'spikes') return true;
  return Boolean(move.sideCondition);
}

function isStatusMove(name: string): boolean {
  const move = Dex.moves.get(name);
  return move.exists && move.category === 'Status';
}

function speciesId(name: string): string {
  return toId(name);
}

function toId(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
