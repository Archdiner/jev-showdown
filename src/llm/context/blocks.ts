import type { BoardInput, BoardMon, ContextBlock, LegalOption, RollLine } from './types.js';
import { loadGuidance, loadHypotheses, loadReplayStats, switchPhase, switchPriorPercent } from './meta.js';
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
      if (settings.variant === 'all') return principles.map(formatPrinciple).join('\n');
      const situation = deriveSituation(board);
      const budget = Math.max(80, settings.maxChars - `[${settings.id} v${settings.version}]`.length - 2);
      const picked = selectPrinciples(principles, situation, budget);
      if (picked.length === 0) return '';
      return picked.map(formatPrinciple).join('\n');
    },
  },
  {
    id: 'meta-stats',
    version: '1',
    defaultMaxChars: 700,
    render() {
      const bucket = loadReplayStats()?.hi;
      if (!bucket) return '';
      return [
        `top-rated gen9randombattle n=${bucket.n} turns_median=${bucket.turns_median ?? '?'}`,
        `tera_rate=${bucket.player_tera_rate ?? '?'}% tera_turn_median=${bucket.tera_turn_median ?? '?'} tera_offensive=${bucket.tera_offensive_stab_pct ?? '?'}% tera_defensive=${bucket.tera_other_defensive_pct ?? '?'}%`,
        `move shares setup=${bucket.setup_move_share ?? '?'}% status=${bucket.status_move_share ?? '?'}% hazard=${bucket.hazard_move_share ?? '?'}% pivot=${bucket.pivot_move_share ?? '?'}% recovery=${bucket.recovery_move_share ?? '?'}%`,
        `hazards in ${bucket.games_with_any_hazard_pct ?? '?'}% of games first_hazard_turn=${bucket.first_hazard_turn_median ?? '?'} winner_mons_left=${bucket.winner_mons_left_median ?? '?'}`,
      ].join('\n');
    },
  },
  {
    id: 'situation-brief',
    version: '1',
    defaultMaxChars: 8000,
    render(board) {
      return board.situationBrief?.trim() || '';
    },
  },
  {
    id: 'hypotheses',
    version: '1',
    defaultMaxChars: 5000,
    render() {
      const rows = loadHypotheses() as Array<{ id?: string; change?: string }>;
      if (rows.length === 0) return '';
      const lines = rows.map(row => `${row.id ?? '?'}: ${row.change ?? ''}`);
      return ['Research notes, not orders. The decision lines decide KOs, switches, and Tera.', ...lines].join('\n');
    },
  },
  {
    id: 'decision',
    version: '1',
    defaultMaxChars: 2400,
    render(board) {
      return decisionText(board);
    },
  },
];

function decisionText(board: BoardInput): string {
  const mine = board.myTeam[board.myActive];
  const foe = board.opponentTeam[board.opponentActive];
  if (!mine || !foe || mine.fainted || foe.fainted) return 'no active pair';
  const ourRows = rowsBetween(board.facts?.ourAttacks, mine.species, foe.species);
  const teraRows = rowsBetween(board.facts?.teraAttacks, mine.species, foe.species);
  const incoming = rowsBetween(board.facts?.foeAttacks, foe.species, mine.species);
  const teraIncoming = (board.facts?.teraDefense ?? []).filter(row => row.defender === mine.species && row.attacker === foe.species);
  const incomingKo = incoming.some(row => kills(row, mine));
  const teraIncomingKo = teraIncoming.some(row => kills(row, mine));
  const canReadTera = mine.teraKnown && !!mine.teraType && teraIncoming.length > 0;
  const lines: string[] = [];
  let weKo = false;
  let teraOnlyKo = false;
  for (const option of board.legal) {
    const action = option.action;
    if (option.choice === 'default' || (action.type === 'move' && action.moveIndex <= 0)) continue;
    if (action.type === 'switch') {
      const mon = board.myTeam.find(candidate => candidate.slot === action.switchIndex);
      const hits = rowsBetween(board.facts?.foeAttacks, foe.species, mon?.species);
      const worst = hits.reduce((max, row) => Math.max(max, row.maxPct), 0);
      const dies = mon ? hits.some(row => kills(row, mon)) : false;
      lines.push(`${option.id} ${option.label} incomingMax=${hits.length ? worst : '?'}% koNow=${hits.length === 0 ? 'unknown' : dies ? 'yes' : 'no'}`);
      continue;
    }
    const moveName = optionMove(board, option);
    const row = (action.terastallize ? teraRows : ourRows).find(candidate => candidate.move === moveName);
    const plain = ourRows.find(candidate => candidate.move === moveName);
    const now = ko(row, foe);
    const without = ko(plain, foe);
    if (now) weKo = true;
    if (action.terastallize && now && !without) teraOnlyKo = true;
    const sure = row && foe.hpPercent != null && row.minPct >= foe.hpPercent ? 'yes' : 'no';
    const flip = action.terastallize ? ` flipsKO=${now && !without ? 'yes' : 'no'}` : '';
    lines.push(`${option.id} ${option.label} koNow=${row ? (now ? 'yes' : 'no') : '?'} sure=${row ? sure : '?'}${flip}`);
  }
  const they = incoming.length === 0 ? 'unknown' : incomingKo ? 'yes' : 'no';
  const survival = canReadTera ? (incomingKo && !teraIncomingKo ? 'yes' : 'no') : 'unknown';
  const headline = [
    `exchange weKO=${weKo ? 'yes' : 'no'} theyKO=${they}`,
    `tera flipsKO=${teraOnlyKo ? 'yes' : 'no'} flipsSurvival=${survival}`,
    `incoming KO if we stay: ${they}`,
  ];
  return [...headline, ...lines].join('\n');
}

function rowsBetween(rows: RollLine[] | undefined, attacker: string | undefined, defender: string | undefined): RollLine[] {
  if (!rows || !attacker || !defender) return [];
  return rows.filter(row => row.attacker === attacker && row.defender === defender);
}

function ko(row: RollLine | undefined, defender: BoardMon): boolean {
  return !!row && defender.hpPercent != null && row.maxPct >= defender.hpPercent;
}

function kills(row: RollLine, defender: BoardMon): boolean {
  return defender.hpPercent != null && row.maxPct >= defender.hpPercent;
}

function optionMove(board: BoardInput, option: LegalOption): string | undefined {
  if (option.action.type !== 'move') return undefined;
  const actor = board.myTeam[board.myActive];
  return actor?.moveSlots[option.action.moveIndex - 1];
}

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
