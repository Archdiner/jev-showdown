import { Battle } from '@pkmn/sim';
import { SideId, otherSide } from '../engine/exact/battle-utils.js';
import {
  likelyMoves,
  publicMatchup,
  publicSpeed,
  rankedSwitches,
  switchFeatureInput,
  featureVector,
} from '../engine/exact/matchup.js';
import fittedSwitch from '../engine/exact/switch-weights.json';

/** Four characters matches the token estimate used by the Jev state cap. */
const CHARS_PER_TOKEN = 4;

export const BRIEF_SECTIONS = ['sides', 'bench', 'damage', 'speed', 'field', 'sets', 'switch'] as const;
export type BriefSection = (typeof BRIEF_SECTIONS)[number];

export interface ContextBrief {
  text: string;
  sections: BriefSection[];
  truncated: boolean;
}

interface PublicMon {
  slot: number;
  species: string;
  level: number;
  hp: number;
  maxHp: number;
  frac: number;
  status: string;
  boosts: string;
  speStage: number;
  moves: string[];
  ability?: string;
  item?: string;
  fainted: boolean;
  active: boolean;
}

/**
 * Situation brief for a later strategist. Numbers come from the public
 * matchup helpers and the fitted switch model. Opponent species, moves,
 * abilities, and items appear only after the log reveals them.
 * This does not call a model and does not register a config layer.
 */
export function renderContextBrief(battle: Battle, side: SideId, tokenBudget = 800): ContextBrief {
  const maxChars = Math.max(0, tokenBudget) * CHARS_PER_TOKEN;
  const ours = sideMons(battle, side, true);
  const theirs = sideMons(battle, otherSide(side), false);
  let used = 0;
  const blocks: string[] = [];
  const included: BriefSection[] = [];
  let truncated = false;
  for (const id of BRIEF_SECTIONS) {
    const body = sectionText(id, battle, side, ours, theirs);
    const block = `## ${id}\n${body}`;
    if (used + block.length + 1 > maxChars) {
      truncated = true;
      continue;
    }
    blocks.push(block);
    included.push(id);
    used += block.length + 1;
  }
  return { text: blocks.join('\n'), sections: included, truncated };
}

function sectionText(
  id: BriefSection,
  battle: Battle,
  side: SideId,
  ours: PublicMon[],
  theirs: PublicMon[]
): string {
  if (id === 'sides') return monBlock('US', ours) + '\n' + monBlock('THEM', theirs) + `\nunrevealed=${unrevealedCount(battle, side)}`;
  if (id === 'bench') return benchBlock(battle, side, ours, theirs);
  if (id === 'damage') return damageBlock(ours, theirs, weatherId(battle));
  if (id === 'speed') return speedBlock(ours, theirs);
  if (id === 'field') return fieldBlock(battle, side);
  if (id === 'sets') return setsBlock(theirs, unrevealedCount(battle, side));
  return switchBlock(battle, side);
}

function monBlock(title: string, mons: PublicMon[]): string {
  if (mons.length === 0) return `${title}\nnone revealed`;
  const lines = mons.map(mon => {
    const hp = mon.maxHp > 0 ? `${mon.hp}/${mon.maxHp}` : 'hidden';
    const own = mon.ability || mon.item ? ` ability=${mon.ability ?? '?'} item=${mon.item ?? '?'}` : '';
    return `#${mon.slot} ${mon.species} lv${mon.level} hp=${hp} status=${mon.status} boosts=${mon.boosts} moves=${mon.moves.join('/') || 'none'}${own}${mon.active ? ' active' : ''}${mon.fainted ? ' fainted' : ''}`;
  });
  return `${title}\n${lines.join('\n')}`;
}

function benchBlock(battle: Battle, side: SideId, ours: PublicMon[], theirs: PublicMon[]): string {
  const ranked = rankedSwitches(battle, side, true);
  const ourBench = ranked.length
    ? ranked.map(row => `${row.choice} ${row.species} margin=${row.margin.toFixed(2)}`).join('\n')
    : 'none';
  const theirBench = theirs.filter(mon => !mon.active && !mon.fainted);
  const them = theirBench.length
    ? theirBench.map(mon => `#${mon.slot} ${mon.species} hp=${mon.hp}/${mon.maxHp}`).join('\n')
    : 'none revealed';
  return `OUR SWITCH-INS\n${ourBench}\nTHEIR REVEALED BENCH\n${them}\n(our bench count ${ours.filter(mon => !mon.active && !mon.fainted).length})`;
}

function damageBlock(ours: PublicMon[], theirs: PublicMon[], weather: string | undefined): string {
  const us = ours.find(mon => mon.active && !mon.fainted);
  const them = theirs.find(mon => mon.active && !mon.fainted);
  if (!us || !them) return 'no active pair';
  const lines: string[] = [];
  for (const move of us.moves) {
    lines.push(`our ${move} into ${them.species} threat=${threat(us, them, move, weather).toFixed(2)}`);
  }
  const replies = them.moves.length ? them.moves : likelyMoves(them.species, []);
  lines.push(incoming('their', replies, them, us, weather));
  for (const mon of ours) {
    if (mon.fainted || mon.active) continue;
    lines.push(incoming(`into ${mon.species}`, replies, them, mon, weather));
  }
  return lines.join('\n');
}

function incoming(label: string, moves: string[], attacker: PublicMon, defender: PublicMon, weather: string | undefined): string {
  if (moves.length === 0) return `${label} ${defender.species}: no inferred moves`;
  const parts = moves.map(move => `${move}=${threat(attacker, defender, move, weather).toFixed(2)}`);
  return `${label} ${defender.species}: ${parts.join(' ')}`;
}

function threat(attacker: PublicMon, defender: PublicMon, move: string, weather: string | undefined): number {
  return publicMatchup({
    ourSpecies: attacker.species,
    ourLevel: attacker.level,
    ourHpFrac: attacker.frac,
    ourMoves: [move],
    foeSpecies: defender.species,
    foeLevel: defender.level,
    foeHpFrac: defender.frac,
    foeMoves: ['protect'],
    weather,
  }).ourThreat;
}

function speedBlock(ours: PublicMon[], theirs: PublicMon[]): string {
  const us = ours.find(mon => mon.active);
  const them = theirs.find(mon => mon.active);
  if (!us || !them) return 'speed unknown';
  const ourSpeed = speedIndex(us);
  const theirSpeed = speedIndex(them);
  const order = ourSpeed === theirSpeed ? 'tie' : ourSpeed > theirSpeed ? us.species : them.species;
  return `${us.species}=${ourSpeed} ${them.species}=${theirSpeed} first=${order} (base stat x level; Choice Scarf x1.5 only if that item is revealed)`;
}

function speedIndex(mon: PublicMon): number {
  let speed = publicSpeed(mon.species, mon.level);
  if ((mon.item || '').toLowerCase().replace(/[^a-z0-9]/g, '') === 'choicescarf') speed = Math.floor(speed * 1.5);
  return applyStage(speed, mon.speStage);
}

function applyStage(stat: number, stage: number): number {
  if (stage === 0) return stat;
  const num = stage > 0 ? 2 + stage : 2;
  const den = stage > 0 ? 2 : 2 - stage;
  return Math.floor((stat * num) / den);
}

function fieldBlock(battle: Battle, side: SideId): string {
  const field = battle.field as { weather?: { id?: string }; terrain?: { id?: string }; pseudoWeather?: Record<string, unknown> };
  const us = battle.getSide(side);
  const them = us.foe;
  return [
    `weather=${field.weather?.id || 'none'} terrain=${field.terrain?.id || 'none'} trickRoom=${Boolean(field.pseudoWeather?.trickroom)}`,
    `hazards us ${hazards(us.sideConditions)}`,
    `hazards them ${hazards(them.sideConditions)}`,
    `screens us reflect=${Boolean(us.sideConditions.reflect)} lightscreen=${Boolean(us.sideConditions.lightscreen)}`,
    `screens them reflect=${Boolean(them.sideConditions.reflect)} lightscreen=${Boolean(them.sideConditions.lightscreen)}`,
  ].join('\n');
}

function hazards(conditions: { [id: string]: unknown }): string {
  const layers = (id: string) => {
    const state = conditions[id] as { layers?: number } | undefined;
    if (!state) return 0;
    return state.layers ?? 1;
  };
  return `rocks=${layers('stealthrock') > 0} spikes=${layers('spikes')} tspikes=${layers('toxicspikes')}`;
}

function setsBlock(theirs: PublicMon[], hidden: number): string {
  const lines = theirs.map(mon => {
    const moves = mon.moves.length ? mon.moves : likelyMoves(mon.species, []);
    return `${mon.species} moves=${moves.join('/') || 'none'} ability=${mon.ability ?? 'hidden'} item=${mon.item ?? 'hidden'}`;
  });
  lines.push(`unrevealed slots=${hidden}; no species list`);
  return lines.join('\n');
}

function switchBlock(battle: Battle, side: SideId): string {
  const features = switchFeatureInput(battle, otherSide(side));
  const probability = fittedSwitchProbability(featureVector(features));
  return `p=${probability.toFixed(2)} foeThreat=${features.foeThreat.toFixed(2)} ourThreat=${features.ourThreat.toFixed(2)} benchMargin=${features.benchMargin.toFixed(2)} (fitted high-Elo switch model)`;
}

function unrevealedCount(battle: Battle, side: SideId): number {
  const foe = battle.getSide(otherSide(side));
  const seen = seenSpecies(battle, otherSide(side));
  return foe.pokemon.filter(mon => !seen.has(mon.species.name.toLowerCase())).length;
}

function sideMons(battle: Battle, side: SideId, own: boolean): PublicMon[] {
  const seen = own ? null : seenSpecies(battle, side);
  const reveals = own ? null : moveReveals(battle, side);
  const rows: PublicMon[] = [];
  battle.getSide(side).pokemon.forEach((mon, index) => {
    const species = mon.species.name;
    if (seen && !seen.has(species.toLowerCase())) return;
    const reveal = reveals?.get(species.toLowerCase());
    const boosts = mon.boosts || {};
    const exactMoves = (mon.moveSlots || []).map(slot => slot.id).filter(Boolean);
    rows.push({
      slot: index + 1,
      species,
      level: mon.level,
      hp: mon.hp,
      maxHp: mon.maxhp,
      frac: mon.maxhp > 0 ? Math.max(0, mon.hp) / mon.maxhp : 0,
      status: mon.status || 'none',
      boosts: `${boosts.atk || 0}/${boosts.def || 0}/${boosts.spa || 0}/${boosts.spd || 0}/${boosts.spe || 0}`,
      speStage: boosts.spe || 0,
      moves: own ? exactMoves : (reveal?.moves ?? []),
      ability: own ? mon.ability || undefined : reveal?.ability,
      item: own ? mon.item || undefined : reveal?.item,
      fainted: mon.fainted || mon.hp <= 0,
      active: mon.isActive,
    });
  });
  return rows;
}

function seenSpecies(battle: Battle, side: SideId): Set<string> {
  const seen = new Set<string>();
  for (const line of logLines(battle)) {
    if (!line.startsWith('|switch|') && !line.startsWith('|drag|') && !line.startsWith('|replace|')) continue;
    const parts = line.split('|');
    if (!(parts[2] || '').toLowerCase().startsWith(side)) continue;
    const species = (parts[3] || '').split(',')[0].trim().toLowerCase();
    if (species) seen.add(species);
  }
  return seen;
}

function moveReveals(battle: Battle, side: SideId): Map<string, { moves: string[]; ability?: string; item?: string }> {
  const map = new Map<string, { moves: string[]; ability?: string; item?: string }>();
  const ensure = (ident: string) => {
    const species = (ident.split(':')[1] || '').trim().toLowerCase();
    const row = map.get(species) ?? { moves: [] };
    map.set(species, row);
    return row;
  };
  for (const line of logLines(battle)) {
    const parts = line.split('|');
    const ident = parts[2] || '';
    if (!ident.toLowerCase().startsWith(side)) continue;
    const tag = parts[1];
    if (tag === 'move' && parts[3]) ensure(ident).moves.push(toId(parts[3]));
    if ((tag === '-ability' || tag === 'ability') && parts[3]) ensure(ident).ability = parts[3];
    if ((tag === '-item' || tag === 'item') && parts[3]) ensure(ident).item = parts[3];
  }
  return map;
}

function logLines(battle: Battle): string[] {
  return (battle.log as string[]).filter(line => typeof line === 'string');
}

function toId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Same logistic as `switchProbability` in the fitted switch model. */
function fittedSwitchProbability(features: number[]): number {
  let logit = 0;
  for (let i = 0; i < features.length; i++) logit += (fittedSwitch.weights[i] || 0) * features[i];
  if (logit > 30) return 1;
  if (logit < -30) return 0;
  return 1 / (1 + Math.exp(-logit));
}

function weatherId(battle: Battle): string | undefined {
  const weather = (battle.field as { weather?: { id?: string } }).weather?.id;
  return weather || undefined;
}
