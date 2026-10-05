import { Battle, PRNG, PokemonSet, Teams } from '@pkmn/sim';
import { TeamGenerators } from '@pkmn/randoms';

export type SideId = 'p1' | 'p2';

let generatorsReady = false;

export function ensureGenerators(): void {
  if (!generatorsReady) {
    Teams.setGeneratorFactory(TeamGenerators);
    generatorsReady = true;
  }
}

export function otherSide(side: SideId): SideId {
  return side === 'p1' ? 'p2' : 'p1';
}

/**
 * Legal choice strings taken from the side's active request.
 * Switches are included unless the pokemon is strictly trapped.
 */
export function legalChoices(battle: Battle, sideId: SideId): string[] {
  const side = battle.getSide(sideId);
  const req = side.activeRequest as any;
  if (!req || req.wait) return [];

  if (req.teamPreview) return ['default'];

  if (req.forceSwitch) {
    const choices: string[] = [];
    for (let i = 0; i < side.pokemon.length; i++) {
      const mon = side.pokemon[i];
      if (mon && !mon.fainted && !mon.isActive) choices.push(`switch ${i + 1}`);
    }
    return choices;
  }

  const choices: string[] = [];
  const active = req.active?.[0];
  if (active?.moves) {
    for (let i = 0; i < active.moves.length; i++) {
      if (!active.moves[i].disabled) choices.push(`move ${i + 1}`);
    }
  }
  if (active && !active.trapped) {
    for (let i = 0; i < side.pokemon.length; i++) {
      const mon = side.pokemon[i];
      if (mon && !mon.fainted && !mon.isActive) choices.push(`switch ${i + 1}`);
    }
  }
  return choices;
}

function battleSnapshot(battle: Battle): string {
  // The protocol log grows every turn and is copied into every search node.
  // Choices do not read it. Dropping it keeps late-game turns inside the 2s cap.
  const state = battle.toJSON() as { log?: unknown };
  state.log = [];
  return JSON.stringify(state);
}

export function cloneBattle(battle: Battle): Battle {
  return Battle.fromJSON(JSON.parse(battleSnapshot(battle)));
}

export function snapshot(battle: Battle): string {
  return battleSnapshot(battle);
}

export function cloneFromSnapshot(snap: string): Battle {
  return Battle.fromJSON(JSON.parse(snap));
}

/**
 * Choices the request lists, minus switches the simulator will reject.
 * A hidden trap is not written on the request (`trapped === 'hidden'`),
 * but `choose('switch')` still fails and rewrites the request.
 */
export function playableChoices(battle: Battle, sideId: SideId): string[] {
  const choices = legalChoices(battle, sideId);
  const active = battle.getSide(sideId).active[0];
  if (!active?.trapped) return choices;
  const withoutSwitch = choices.filter(choice => !choice.startsWith('switch'));
  return withoutSwitch.length > 0 ? withoutSwitch : choices;
}

/**
 * A cloned battle keeps a choice that was already typed in. Search has to
 * score the pair it was given, not that leaked earlier choice.
 */
function releasePendingChoices(battle: Battle): void {
  for (const side of battle.sides) {
    if (!side.choice?.actions?.length) continue;
    try {
      side.clearChoice();
    } catch {
      // Nothing left to undo.
    }
  }
}

/**
 * Apply the choices that are actually being requested.
 * Returns false when the sim rejects a choice. Never throws.
 */
export function playChoices(
  battle: Battle,
  side: SideId,
  myChoice: string | undefined,
  oppChoice: string | undefined,
): boolean {
  releasePendingChoices(battle);
  const opp = otherSide(side);
  const plan: Array<[SideId, string | undefined]> = [
    [side, myChoice],
    [opp, oppChoice],
  ];
  for (const [id, choice] of plan) {
    if (!choice) continue;
    const req = battle.getSide(id).activeRequest as any;
    if (!req || req.wait) continue;
    let ok = false;
    try {
      ok = battle.choose(id, choice);
    } catch {
      ok = false;
    }
    if (!ok) return false;
  }
  return true;
}

/**
 * HP-fraction difference plus faint counts, from `side`'s perspective.
 * A terminal win or loss dominates any in-game HP swing.
 */
export function hpEval(battle: Battle, sideId: SideId): number {
  const me = battle.getSide(sideId);
  const foe = me.foe;
  let score = 0;

  for (const p of me.pokemon) {
    const frac = p.maxhp > 0 ? Math.max(0, p.hp) / p.maxhp : 0;
    score += frac;
    if (p.fainted || p.hp <= 0) score -= 2;
  }
  for (const p of foe.pokemon) {
    const frac = p.maxhp > 0 ? Math.max(0, p.hp) / p.maxhp : 0;
    score -= frac;
    if (p.fainted || p.hp <= 0) score += 2;
  }

  if (battle.ended && battle.winner) {
    score += battle.winner === me.name ? 1000 : -1000;
  }
  return score;
}

/**
 * Submit `choice`. Returns false when that exact string was rejected.
 * Some other legal choice is sent so the battle does not stall, and the
 * caller counts the rejection once.
 */
export function commitChoice(battle: Battle, sideId: SideId, choice: string): boolean {
  const legal = legalChoices(battle, sideId);
  if (legal.length === 0) return true;

  if (legal.includes(choice)) {
    try {
      if (battle.choose(sideId, choice)) return true;
    } catch {
      // The sim rejected it. Fall through and send something else.
    }
    try {
      battle.getSide(sideId).clearChoice();
    } catch {
      // already clear
    }
  }

  const refreshed = legalChoices(battle, sideId);
  const retry = refreshed.find(option => option !== choice) || refreshed[0] || legal.find(option => option !== choice) || legal[0];
  if (retry) {
    try {
      battle.choose(sideId, retry);
    } catch {
      // The battle stays on this request. The loop notices if it sticks.
    }
  }
  return false;
}

export function safeChoose(battle: Battle, sideId: SideId, choice: string): boolean {
  const legal = legalChoices(battle, sideId);
  if (legal.length === 0) return true;
  const pick = legal.includes(choice) ? choice : legal[0];
  try {
    if (battle.choose(sideId, pick)) return pick === choice;
  } catch {
    // fall through to a clean retry
  }
  try {
    battle.getSide(sideId).clearChoice();
  } catch {
    // already clear
  }
  try {
    return battle.choose(sideId, legal[0]);
  } catch {
    return false;
  }
}

export function teamsForSeed(seed: number): { p1: PokemonSet[]; p2: PokemonSet[] } {
  ensureGenerators();
  const gen = Teams.getGenerator('gen9randombattle', [seed >>> 0, 0x9e3779b9, 0x12345678, 0xdecafbad] as any);
  return { p1: gen.getTeam(), p2: gen.getTeam() };
}

export function startRandomBattle(
  p1: PokemonSet[],
  p2: PokemonSet[],
  seed: number,
): Battle {
  ensureGenerators();
  const battle = new Battle({
    formatid: 'gen9randombattle' as any,
    seed: new PRNG([seed >>> 0, 7, 11, 13] as any).startingSeed,
  });
  battle.setPlayer('p1', { name: 'P1', team: p1 });
  battle.setPlayer('p2', { name: 'P2', team: p2 });
  return battle;
}

export function moveChoice(battle: Battle, sideId: SideId, moveId: string): string | null {
  const mon = battle.getSide(sideId).active[0];
  if (!mon) return null;
  const idx = mon.moveSlots.findIndex(m => m.id === moveId);
  if (idx < 0) return null;
  return `move ${idx + 1}`;
}

export function switchChoice(battle: Battle, sideId: SideId, species: string): string | null {
  const side = battle.getSide(sideId);
  const idx = side.pokemon.findIndex(p => p.species.name === species);
  if (idx < 0) return null;
  return `switch ${idx + 1}`;
}
