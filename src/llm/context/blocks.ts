import type { BoardInput, BoardMon, ContextBlock, RollLine } from './types.js';
import { loadGuidance, loadReplayStats, switchPhase, switchPriorPercent } from './meta.js';
import { deriveSituation, formatPrinciple, selectPrinciples } from './situation.js';

function monLine(mon: BoardMon, tag: string): string {
  const hp = mon.fainted ? 'fainted' : mon.hpPercent == null ? 'hp=?' : `hp=${mon.hpPercent}%`;
  const boosts = Object.entries(mon.boosts).filter(([, stage]) => stage).map(([stat, stage]) => `${stat}${stage}`).join('/') || 'none';
  const moves = mon.moveSlots.length > 0 ? mon.moveSlots.join('/') : mon.knownMoves.length > 0 ? mon.knownMoves.join('/') : 'none';
  return [
    `${tag} slot=${mon.slot}`,
    mon.species,
    mon.active ? 'active' : 'bench',
    mon.seen ? 'seen' : 'unseen',
    `L${mon.level}`,
    mon.types.length ? mon.types.join('/') : 'types=?',
    hp,
    `status=${mon.status ?? 'none'}`,
    `boosts=${boosts}`,
    mon.abilityKnown ? `ability=${mon.ability}` : 'ability=unknown',
    mon.itemKnown ? `item=${mon.item}` : 'item=unknown',
    mon.teraKnown ? `tera=${mon.terastallized ? mon.terastallized : mon.teraType}` : 'tera=unknown',
    `teraUsed=${mon.terastallized ? 'yes' : 'no'}`,
    `moves=${moves}`,
  ].join(' ');
}

function sideLines(team: BoardMon[], prefix: string): string {
  if (team.length === 0) return `${prefix}: none revealed`;
  return team.map((mon, index) => monLine(mon, `${prefix}${index + 1}`)).join('\n');
}

function rollLines(rows: RollLine[], max: number): string {
  if (rows.length === 0) return 'none';
  return rows.slice(0, max).map(row => row.text).join('\n');
}

export const contextBlocks: ContextBlock[] = [
  {
    id: 'sides',
    version: '1',
    defaultMaxChars: 1800,
    render(board) {
      return [sideLines(board.myTeam, 'M'), sideLines(board.opponentTeam, 'F')].join('\n');
    },
  },
  {
    id: 'set-inference',
    version: '1',
    defaultMaxChars: 1600,
    render(board) {
      const sets = board.facts?.sets ?? [];
      if (sets.length === 0) return 'no set rows';
      return sets.map(set => set.text).join('\n');
    },
  },
  {
    id: 'damage-matrix',
    version: '1',
    defaultMaxChars: 2200,
    render(board) {
      const ours = rollLines(board.facts?.ourAttacks ?? [], 24);
      const tera = rollLines(board.facts?.teraAttacks ?? [], 8);
      const threat = board.facts?.threat ?? 'threat unknown';
      return `${threat}\nour moves\n${ours}\nif we tera\n${tera}`;
    },
  },
  {
    id: 'switch-ins',
    version: '1',
    defaultMaxChars: 1200,
    render(board) {
      return `their likely moves into our mons\n${rollLines(board.facts?.foeAttacks ?? [], 24)}`;
    },
  },
  {
    id: 'speed-tiers',
    version: '1',
    defaultMaxChars: 600,
    render(board) {
      return board.facts?.speed || 'speed unknown';
    },
  },
  {
    id: 'field',
    version: '1',
    defaultMaxChars: 400,
    render(board) {
      const screens = board.field.screens;
      const mine = board.hazards.my;
      const opp = board.hazards.opponent;
      return [
        `weather=${board.field.weather ?? 'none'} terrain=${board.field.terrain ?? 'none'} trickRoom=${board.field.trickRoom}`,
        `screens reflect=${screens.reflect ?? 0} lightScreen=${screens.lightScreen ?? 0}`,
        `hazards mine rocks=${mine.stealthRock} spikes=${mine.spikes} tspikes=${mine.toxicSpikes}`,
        `hazards foe rocks=${opp.stealthRock} spikes=${opp.spikes} tspikes=${opp.toxicSpikes}`,
        `teraAvailable=${board.canTera} myTeraUsed=${board.myTeraUsed} foeTeraUsed=${board.opponentTeraUsed}`,
      ].join('\n');
    },
  },
  {
    id: 'history',
    version: '1',
    defaultMaxChars: 800,
    render(board) {
      if (board.log.recent.length === 0) return 'no public log yet';
      return board.log.recent.join('\n');
    },
  },
  {
    id: 'switch-odds',
    version: '1',
    defaultMaxChars: 500,
    render(board) {
      const stats = loadReplayStats();
      const bucket = stats?.hi;
      const phase = switchPhase(board.turn);
      const prior = bucket ? switchPriorPercent(board.turn, bucket) : null;
      const observedDenom = board.log.opponentHardSwitches + board.log.opponentStays;
      const observed = observedDenom > 0 ? Math.round((board.log.opponentHardSwitches / observedDenom) * 1000) / 10 : null;
      const lines = [
        bucket
          ? `top-rated gen9randombattle replays n=${bucket.n}: hard-switch ${bucket.hard_switch_rate}% of decisions, turn1 ${bucket.turn1_hard_switch_pct}%, early ${bucket.hard_switch_early}%, mid ${bucket.hard_switch_mid}%, late ${bucket.hard_switch_late}%`
          : 'replay switch prior missing',
        prior == null ? 'this-turn prior unknown' : `this turn ${board.turn} phase=${phase} prior=${prior}%`,
        `this game foe hard-switches ${board.log.opponentHardSwitches} stays ${board.log.opponentStays} forced ${board.log.opponentForcedSwitches}` +
          (observed == null ? '' : ` observed=${observed}%`) +
          (board.log.lastOpponentSwitchTurn == null ? '' : ` lastSwitchTurn=${board.log.lastOpponentSwitchTurn}`),
        board.facts?.threatened ? 'their active is threatened by a likely hit of at least 50%' : 'their active is not threatened at the 50% line',
      ];
      return lines.join('\n');
    },
  },
  {
    id: 'win-conditions',
    version: '1',
    defaultMaxChars: 800,
    render(board) {
      return winText(board);
    },
  },
  {
    id: 'meta-guidance',
    version: '1',
    defaultMaxChars: 1100,
    render(board, settings) {
      const principles = loadGuidance();
      if (principles.length === 0) return '';
      const situation = deriveSituation(board);
      const budget = Math.max(80, settings.maxChars - `[${settings.id} v${settings.version}]`.length - 2);
      const picked = selectPrinciples(principles, situation, budget);
      if (picked.length === 0) return '';
      return picked.map(formatPrinciple).join('\n');
    },
  },
];

function winText(board: BoardInput): string {
  const attacks = board.facts?.ourAttacks ?? [];
  const incoming = board.facts?.foeAttacks ?? [];
  if (attacks.length === 0 && incoming.length === 0) return 'no damage numbers yet';
  const foes = new Set(attacks.map(row => row.defender));
  const scored = board.myTeam.filter(mon => !mon.fainted).map(mon => {
    const rows = attacks.filter(row => row.attacker === mon.species);
    const threatenedFoes = new Set(rows.filter(row => row.maxPct >= 50).map(row => row.defender));
    return { mon, hits: threatenedFoes.size, foes: foes.size };
  });
  scored.sort((a, b) => b.hits - a.hits || (b.mon.hpPercent ?? 0) - (a.mon.hpPercent ?? 0));
  const preserve = scored.find(row => row.hits > 0) ?? scored[0];
  const sack = [...scored].reverse().find(row => row.mon !== preserve?.mon && ((row.mon.hpPercent ?? 100) <= 40 || !!row.mon.status));
  const threats = incoming.filter(row => row.defender === board.myTeam[board.myActive]?.species && row.maxPct >= 50);
  const parts = [
    preserve ? `preserve ${preserve.mon.species} (hits >=50% on ${preserve.hits}/${preserve.foes || 0} revealed foes, hp=${preserve.mon.hpPercent ?? '?'}%)` : 'preserve unknown',
    sack ? `sack candidate ${sack.mon.species} hp=${sack.mon.hpPercent ?? '?'}% status=${sack.mon.status ?? 'none'}` : 'no low-hp sack candidate',
    threats.length ? `active is threatened by ${threats.map(row => row.move).slice(0, 3).join(',')}` : 'active is not threatened at the 50% line',
  ];
  return parts.join('\n');
}

export function blockById(id: string): ContextBlock | undefined {
  return contextBlocks.find(block => block.id === id);
}
