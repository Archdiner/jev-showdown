import { Protocol } from '@pkmn/protocol';

export interface ReplayPokemon {
  species: string;
  level: number;
  moves: string[];
  ability?: string;
  item?: string;
  teraType?: string;
}

export interface ReplayPlayer {
  name: string;
  rating: number | null;
  pokemon: ReplayPokemon[];
}

export interface ReplayDatasetRow {
  replayId: string;
  format: string;
  formatId: string;
  rating: number | null;
  uploadtime: number | null;
  views: number | null;
  winner: string | null;
  turns: number;
  p1: ReplayPlayer;
  p2: ReplayPlayer;
}

interface MutableMon {
  species: string;
  level: number;
  moves: Set<string>;
  ability?: string;
  item?: string;
  teraType?: string;
}

/**
 * Turn a public replay log into one row for later opponent modeling.
 * The log is the same battle protocol the live client parses.
 */
export function parseReplayLog(input: {
  id: string;
  log: string;
  format?: string;
  formatId?: string;
  rating?: number | null;
  uploadtime?: number | null;
  views?: number | null;
  players?: string[];
}): ReplayDatasetRow {
  const sides: Record<'p1' | 'p2', Map<string, MutableMon>> = { p1: new Map(), p2: new Map() };
  const names: Record<'p1' | 'p2', string> = { p1: input.players?.[0] ?? '', p2: input.players?.[1] ?? '' };
  const ratings: Record<'p1' | 'p2', number | null> = { p1: null, p2: null };
  let winner: string | null = null;
  let turns = 0;

  for (const { args } of Protocol.parse(input.log)) {
    const cmd = args[0];
    if (cmd === 'player' && (args[1] === 'p1' || args[1] === 'p2')) {
      names[args[1]] = String(args[2] ?? names[args[1]]);
      const rating = args[4];
      if (typeof rating === 'string' && /^\d+$/.test(rating)) ratings[args[1]] = Number(rating);
      continue;
    }
    if (cmd === 'turn') {
      turns = Number(args[1]) || turns;
      continue;
    }
    if (cmd === 'win') {
      winner = String(args[1] ?? '');
      continue;
    }
    if (cmd === 'switch' || cmd === 'drag' || cmd === 'replace' || cmd === 'detailschange') {
      const who = identify(String(args[1] ?? ''), String(args[2] ?? ''));
      if (!who) continue;
      const existing = findMon(sides[who.side], who.nickname) ?? {
        species: who.species,
        level: who.level,
        moves: new Set<string>(),
      };
      existing.species = who.species || existing.species;
      existing.level = who.level || existing.level;
      sides[who.side].set(who.nickname, existing);
      continue;
    }
    if (cmd === 'move') {
      const who = identify(String(args[1] ?? ''), '');
      const move = String(args[2] ?? '');
      if (!who || !move || move === 'Recharge') continue;
      const mon = ensureMon(sides[who.side], who.nickname);
      mon.moves.add(move);
      continue;
    }
    if (cmd === '-ability') {
      const who = identify(String(args[1] ?? ''), '');
      if (!who || !args[2]) continue;
      ensureMon(sides[who.side], who.nickname).ability = String(args[2]);
      continue;
    }
    if (cmd === '-item' || cmd === '-enditem') {
      const who = identify(String(args[1] ?? ''), '');
      if (!who || !args[2]) continue;
      ensureMon(sides[who.side], who.nickname).item = String(args[2]);
      continue;
    }
    if (cmd === '-terastallize') {
      const who = identify(String(args[1] ?? ''), '');
      if (!who || !args[2]) continue;
      ensureMon(sides[who.side], who.nickname).teraType = String(args[2]);
    }
  }

  return {
    replayId: input.id,
    format: input.format ?? '',
    formatId: input.formatId ?? 'gen9randombattle',
    rating: input.rating ?? null,
    uploadtime: input.uploadtime ?? null,
    views: input.views ?? null,
    winner,
    turns,
    p1: toPlayer(names.p1, ratings.p1, sides.p1),
    p2: toPlayer(names.p2, ratings.p2, sides.p2),
  };
}

function toPlayer(name: string, rating: number | null, mons: Map<string, MutableMon>): ReplayPlayer {
  return {
    name,
    rating,
    pokemon: [...mons.values()].map(mon => ({
      species: mon.species,
      level: mon.level,
      moves: [...mon.moves],
      ability: mon.ability,
      item: mon.item,
      teraType: mon.teraType,
    })),
  };
}

function findMon(mons: Map<string, MutableMon>, nickname: string): MutableMon | undefined {
  return mons.get(nickname);
}

function ensureMon(mons: Map<string, MutableMon>, nickname: string): MutableMon {
  const existing = mons.get(nickname);
  if (existing) return existing;
  const created: MutableMon = { species: nickname, level: 80, moves: new Set() };
  mons.set(nickname, created);
  return created;
}

function identify(ident: string, details: string): { side: 'p1' | 'p2'; species: string; level: number; nickname: string } | null {
  if (!ident) return null;
  let parsed: { player: string; name: string };
  try {
    parsed = Protocol.parsePokemonIdent(ident as Protocol.PokemonIdent);
  } catch {
    return null;
  }
  if (parsed.player !== 'p1' && parsed.player !== 'p2') return null;
  let species = details.split(',')[0]?.trim() || parsed.name;
  let level = 80;
  if (details) {
    try {
      const detailed = Protocol.parseDetails(
        parsed.name,
        ident as Protocol.PokemonIdent,
        details as Protocol.PokemonDetails,
      );
      if (detailed.speciesForme) species = detailed.speciesForme;
      if (detailed.level) level = detailed.level;
    } catch {
      const levelMatch = details.match(/L(\d+)/);
      if (levelMatch) level = Number(levelMatch[1]);
    }
  }
  return { side: parsed.player, species, level, nickname: parsed.name };
}
