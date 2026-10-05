import * as fs from 'fs';
import { GraphDB } from '../../graph/db.js';
import { compareIncidents } from './incidents.js';
import { actionable, type Incident, type IncidentEvent, type ObservedGame, type SentinelContext } from './types.js';

export interface Scorecard {
  sinceMs: number;
  generatedAt: number;
  sources: string[];
  phantomRule: string;
  phantomsExcluded: number;
  localExcluded: number;
  reliability: {
    uptime: number | null;
    uptimeDetail: string;
    openP0: number;
    openP1: number;
    soaking: number;
    opened: number;
    verified: number;
    mttrMs: number | null;
    mttrDetail: string;
  };
  progress: {
    eloFirst: number | null;
    eloLast: number | null;
    eloGames: number;
    eloSource: string;
    wins: number;
    losses: number;
    ties: number;
    counted: number;
    winRate: number | null;
    winTarget: number;
    batches: Array<{ id: string; wins: number; losses: number; ties: number; games: number; winRate: number | null }>;
    variants: Array<{ id: string; wins: number; losses: number; ties: number; games: number; winRate: number | null }>;
    loopCycles: number | null;
    loopDetail: string;
    promoted: string[];
    rejected: string[];
    regressions: string[];
    previous: WindowRecord & { start: number; end: number };
  };
  openIncidents: Array<{ id: string; severity: string; status: string; count: number; title: string; detail: string }>;
  omittedOpen: number;
  notes: string[];
}

const PHANTOM_RULE = 'phantom is true, or turns = 0 with outcome tie and endReason disconnect or unknown';

export interface WindowRecord {
  eloFirst: number | null;
  eloLast: number | null;
  eloGames: number;
  wins: number;
  losses: number;
  ties: number;
  counted: number;
  winRate: number | null;
}

export function buildScorecard(ctx: SentinelContext, incidents: Incident[], events: IncidentEvent[], sinceMs: number): Scorecard {
  const since = ctx.now - sinceMs;
  const currentGames = gamesBetween(ctx.games, since, ctx.now + 60_000, true);
  const previousGames = gamesBetween(ctx.games, since - sinceMs, since, false);
  const phantoms = currentGames.filter(game => game.phantom);
  const local = currentGames.filter(game => !game.phantom && game.local);
  const counted = countable(currentGames);
  const previousCounted = countable(previousGames);
  const ladderRated = ratedLadder(counted);
  const previous = { ...windowRecord(previousCounted), start: since - sinceMs, end: since };
  const sources = sourceList(ctx);
  const uptime = liveUptime(ctx, since);
  const opened = events.filter(event => (event.type === 'opened' || event.type === 'reopened') && event.ts >= since).length;
  const verifiedEvents = events.filter(event => event.type === 'verified' && event.ts >= since);
  const mttrValues = verifiedEvents
    .map(event => event.episodeOpenedAt === undefined ? null : event.ts - event.episodeOpenedAt)
    .filter((value): value is number => value !== null && value >= 0);
  const open = incidents.filter(item => actionable(item.status)).sort(compareIncidents);
  const listed = previewIncidents(open);
  const graph = readGraph(ctx, since);
  const batches = batchRows(ctx, counted);
  const variants = variantRows(counted);
  const tally = tallyOf(counted);
  const notes = [
    `Phantom games excluded: ${phantoms.length}. Rule: ${PHANTOM_RULE}.`,
    `Local games excluded from Elo and win rate: ${local.length}.`,
  ];
  if (!ctx.processesScanned) notes.push('Process list was not scanned. Runner pid checks are in npm run ops -- sentinel.');
  if (ctx.git.behind === null) notes.push(`Git: ${ctx.git.detail}`);
  if (!fs.existsSync(ctx.layout.graphDb)) notes.push(`Loop decisions were not read. ${ctx.layout.graphDb} is absent.`);

  return {
    sinceMs,
    generatedAt: ctx.now,
    sources,
    phantomRule: PHANTOM_RULE,
    phantomsExcluded: phantoms.length,
    localExcluded: local.length,
    reliability: {
      uptime: uptime.ratio,
      uptimeDetail: uptime.detail,
      openP0: open.filter(item => item.severity === 'P0').length,
      openP1: open.filter(item => item.severity === 'P1').length,
      soaking: incidents.filter(item => item.status === 'resolved').length,
      opened,
      verified: verifiedEvents.length,
      mttrMs: mttrValues.length ? mttrValues.reduce((sum, value) => sum + value, 0) / mttrValues.length : null,
      mttrDetail: mttrValues.length
        ? `mean time from episode open to verified, ${mttrValues.length} incident${mttrValues.length === 1 ? '' : 's'}`
        : 'no incident was verified in the window',
    },
    progress: {
      eloFirst: ladderRated[0]?.eloAfter ?? null,
      eloLast: ladderRated[ladderRated.length - 1]?.eloAfter ?? null,
      eloGames: ladderRated.length,
      eloSource: ladderRated[0]?.file ?? pathOr(ctx.layout.ladderLogDir, 'games.jsonl'),
      wins: tally.wins,
      losses: tally.losses,
      ties: tally.ties,
      counted: tally.games,
      winRate: tally.games ? tally.wins / tally.games : null,
      winTarget: ctx.winTarget,
      batches,
      variants,
      loopCycles: graph.cycles,
      loopDetail: graph.detail,
      promoted: graph.promoted,
      rejected: graph.rejected,
      regressions: graph.regressions,
      previous,
    },
    openIncidents: listed.map(item => ({
      id: item.id,
      severity: item.severity,
      status: item.status,
      count: item.count,
      title: item.title,
      detail: item.detail,
    })),
    omittedOpen: open.length - listed.length,
    notes,
  };
}

export function formatScorecard(card: Scorecard, style: 'text' | 'md' = 'text'): string {
  const lines: string[] = [];
  const title = `jev scorecard (since ${formatDuration(card.sinceMs)}, as of ${new Date(card.generatedAt).toISOString()})`;
  lines.push(style === 'md' ? `# ${title}` : title);
  lines.push(`Sources: ${card.sources.join('; ')}`);
  lines.push(`Phantoms excluded: ${card.phantomsExcluded}. ${card.phantomRule}. Counted games: ${card.progress.counted}. Local excluded: ${card.localExcluded}.`);
  lines.push('');
  lines.push(style === 'md' ? '## Reliability' : 'Reliability');
  const uptime = card.reliability.uptime === null ? 'unknown' : pct(card.reliability.uptime);
  lines.push(`  uptime     ${uptime}  ${card.reliability.uptimeDetail}`);
  lines.push(`  open P0    ${card.reliability.openP0}`);
  lines.push(`  open P1    ${card.reliability.openP1}`);
  lines.push(`  opened     ${card.reliability.opened}   verified ${card.reliability.verified}   soaking ${card.reliability.soaking}`);
  const mttr = card.reliability.mttrMs === null ? 'n/a' : formatDuration(card.reliability.mttrMs);
  lines.push(`  MTTR       ${mttr}  ${card.reliability.mttrDetail}`);
  if (card.openIncidents.length) {
    lines.push('  open incidents:');
    for (const incident of card.openIncidents) {
      lines.push(`    ${incident.severity} ${incident.status} x${incident.count} ${incident.title} — ${incident.detail}`);
    }
    if (card.omittedOpen > 0) {
      const noun = card.omittedOpen === 1 ? 'incident' : 'incidents';
      lines.push(`    ${card.omittedOpen} lower-severity ${noun} not listed on this screen`);
    }
  }
  lines.push('');
  lines.push(style === 'md' ? '## Progress' : 'Progress');
  const elo = card.progress.eloGames === 0
    ? 'no rated ladder games in the window'
    : `${card.progress.eloFirst} → ${card.progress.eloLast} (${signed((card.progress.eloLast ?? 0) - (card.progress.eloFirst ?? 0))}) across ${card.progress.eloGames} games`;
  lines.push(`  Elo        ${elo}`);
  lines.push('             first rated ladder game to last rated ladder game; phantoms and local games omitted');
  lines.push(`             source ${card.progress.eloSource}`);
  const rate = card.progress.winRate === null ? 'n/a' : pct(card.progress.winRate);
  lines.push(`  win rate   ${rate}  ${card.progress.wins}-${card.progress.losses}-${card.progress.ties} on ${card.progress.counted} games  target ${pct(card.progress.winTarget)}`);
  lines.push(...priorLines(card));
  lines.push('  batches');
  if (card.progress.batches.length === 0) lines.push('    none');
  for (const batch of card.progress.batches) {
    lines.push(`    ${batch.id}  ${batch.wins}-${batch.losses}-${batch.ties}  ${batch.winRate === null ? 'n/a' : pct(batch.winRate)}  n=${batch.games}`);
  }
  lines.push('  variants');
  if (card.progress.variants.length === 0) lines.push('    none');
  for (const variant of card.progress.variants) {
    lines.push(`    ${variant.id}  ${variant.wins}-${variant.losses}-${variant.ties}  ${variant.winRate === null ? 'n/a' : pct(variant.winRate)}  n=${variant.games}`);
  }
  const cycles = card.progress.loopCycles === null ? 'unknown' : String(card.progress.loopCycles);
  lines.push(`  loop       ${cycles} cycles  ${card.progress.loopDetail}`);
  lines.push(`  promoted   ${card.progress.promoted.length ? card.progress.promoted.join(' | ') : 'none'}`);
  lines.push(`  rejected   ${card.progress.rejected.length ? card.progress.rejected.join(' | ') : 'none'}`);
  lines.push(`  regressions ${card.progress.regressions.length ? card.progress.regressions.join(' | ') : 'none'}`);
  lines.push('');
  lines.push(style === 'md' ? '## Notes' : 'Notes');
  for (const note of card.notes) lines.push(`  ${note}`);
  return lines.join('\n');
}

export function parseSince(value: string | undefined, fallbackMs: number, now = Date.now()): number {
  if (!value) return fallbackMs;
  const trimmed = value.trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(trimmed);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2];
    const scale = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return amount * scale;
  }
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  }
  const absolute = Date.parse(trimmed);
  if (Number.isFinite(absolute)) {
    const span = now - absolute;
    if (span <= 0) throw new Error(`--since ${trimmed} is not before now`);
    return span;
  }
  throw new Error(`--since must look like 24h, 7d, 30m, a millisecond count, or an ISO timestamp (got ${value})`);
}

function gamesBetween(games: ObservedGame[], start: number, end: number, endInclusive: boolean): ObservedGame[] {
  return games.filter(game => {
    if (game.ts === null) return false;
    if (game.ts < start) return false;
    return endInclusive ? game.ts <= end : game.ts < end;
  });
}

function countable(games: ObservedGame[]): ObservedGame[] {
  return games.filter(game => !game.phantom && !game.local && game.outcome);
}

function ratedLadder(games: ObservedGame[]): ObservedGame[] {
  return games.filter(game => game.ladder && game.eloAfter !== null).sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}

function windowRecord(counted: ObservedGame[]): WindowRecord {
  const rated = ratedLadder(counted);
  const tally = tallyOf(counted);
  return {
    eloFirst: rated[0]?.eloAfter ?? null,
    eloLast: rated[rated.length - 1]?.eloAfter ?? null,
    eloGames: rated.length,
    wins: tally.wins,
    losses: tally.losses,
    ties: tally.ties,
    counted: tally.games,
    winRate: tally.winRate,
  };
}

function priorLines(card: Scorecard): string[] {
  const prior = card.progress.previous;
  const current = card.progress;
  const start = new Date(prior.start).toISOString();
  const end = new Date(prior.end).toISOString();
  const lines = [
    `  vs prior   previous ${formatDuration(card.sinceMs)} (${start} → ${end}), same exclusions`,
    `  Elo        ${eloPhrase(prior)} → ${eloPhrase(current)}`,
    `  win rate   ${ratePhrase(prior)} → ${ratePhrase(current)}`,
    `  record     ${recordPhrase(prior)} → ${recordPhrase(current)}`,
  ];
  if (prior.eloLast !== null && current.eloLast !== null) {
    lines.push(`             end Elo ${signed(current.eloLast - prior.eloLast)} versus the previous window`);
  }
  if (prior.winRate !== null && current.winRate !== null) {
    lines.push(`             win rate ${signedPoints((current.winRate - prior.winRate) * 100)} points versus the previous window`);
  }
  return lines;
}

function eloPhrase(record: WindowRecord): string {
  if (record.eloGames === 0 || record.eloFirst === null || record.eloLast === null) return 'no rated ladder games';
  return `${record.eloFirst} → ${record.eloLast} (${signed(record.eloLast - record.eloFirst)}) on ${record.eloGames} games`;
}

function ratePhrase(record: WindowRecord): string {
  if (record.winRate === null) return 'n/a';
  return pct(record.winRate);
}

function recordPhrase(record: WindowRecord): string {
  return `${record.wins}-${record.losses}-${record.ties} on ${record.counted} games`;
}

function signedPoints(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (rounded > 0) return `+${rounded.toFixed(1)}`;
  return rounded.toFixed(1);
}

function liveUptime(ctx: SentinelContext, since: number): { ratio: number | null; detail: string } {
  const beats = ctx.heartbeats
    .filter(beat => beat.facility === 'live' && typeof beat.ts === 'number' && beat.ts >= since && beat.ts <= ctx.now)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  if (beats.length === 0) {
    return { ratio: null, detail: `no live heartbeats in the window (source ${ctx.layout.opsDir}/heartbeats.jsonl)` };
  }
  let up = 0;
  let down = 0;
  for (let index = 0; index < beats.length; index++) {
    const ts = Number(beats[index].ts);
    const next = index + 1 < beats.length ? Number(beats[index + 1].ts) : ctx.now;
    const gap = Math.max(0, next - ts);
    const ok = beats[index].status === 'ok';
    if (ok && gap <= ctx.staleMs) up += gap;
    else if (ok) {
      up += Math.min(ctx.staleMs, gap);
      down += Math.max(0, gap - ctx.staleMs);
    } else down += gap;
  }
  const total = up + down;
  const ratio = total === 0 ? null : up / total;
  return {
    ratio,
    detail: `live heartbeats from the first beat in the window; a gap over ${Math.round(ctx.staleMs / 1000)}s counts as down. source ${ctx.layout.opsDir}/heartbeats.jsonl`,
  };
}

function batchRows(ctx: SentinelContext, games: ObservedGame[]): Scorecard['progress']['batches'] {
  const groups = new Map<string, ObservedGame[]>();
  const anySha = games.some(game => game.gitSha);
  const ordered = [...games].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  if (anySha) {
    for (const game of ordered) {
      const id = game.gitSha ?? 'no-git';
      const list = groups.get(id) ?? [];
      list.push(game);
      groups.set(id, list);
    }
  } else {
    for (let index = 0; index < ordered.length; index += ctx.batchSize) {
      const slice = ordered.slice(index, index + ctx.batchSize);
      groups.set(`batch ${index / ctx.batchSize + 1}`, slice);
    }
  }
  return [...groups.entries()].map(([id, rows]) => ({ id, ...tallyOf(rows) }));
}

function variantRows(games: ObservedGame[]): Scorecard['progress']['variants'] {
  const groups = new Map<string, ObservedGame[]>();
  for (const game of games) {
    const id = game.variantId || game.configId || 'unlabeled';
    const list = groups.get(id) ?? [];
    list.push(game);
    groups.set(id, list);
  }
  return [...groups.entries()].map(([id, rows]) => ({ id, ...tallyOf(rows) }));
}

function tallyOf(games: ObservedGame[]): { wins: number; losses: number; ties: number; games: number; winRate: number | null } {
  const wins = games.filter(game => game.outcome === 'win').length;
  const losses = games.filter(game => game.outcome === 'loss').length;
  const ties = games.filter(game => game.outcome === 'tie').length;
  const played = wins + losses + ties;
  return { wins, losses, ties, games: played, winRate: played ? wins / played : null };
}

function readGraph(ctx: SentinelContext, since: number): {
  cycles: number | null;
  detail: string;
  promoted: string[];
  rejected: string[];
  regressions: string[];
} {
  if (!fs.existsSync(ctx.layout.graphDb)) {
    return {
      cycles: null,
      detail: `${ctx.layout.graphDb} is absent`,
      promoted: [],
      rejected: [],
      regressions: [],
    };
  }
  const db = new GraphDB(ctx.layout.graphDb);
  try {
    const decisions = db.getNodesByType('Decision').filter(node => node.created_at >= since);
    const jobs = db.getNodesByType('Experiment').filter(node => {
      const meta = node.metadata as { ops?: unknown } | undefined;
      return Boolean(meta?.ops) && node.status === 'done' && node.updated_at >= since;
    });
    const promoted = decisions
      .filter(node => node.type === 'Decision' && (node.decision === 'champion' || node.decision === 'live-approved') && node.status === 'done')
      .map(node => node.type === 'Decision' ? `${node.decision}: ${node.description || node.title}` : node.title);
    const rejected = decisions
      .filter(node => node.type === 'Decision' && (node.decision === 'rejected' || node.status === 'rejected'))
      .map(node => node.type === 'Decision' ? `${node.title}: ${node.description || node.consequences || 'rejected'}` : node.title);
    const regressions = db.getNodesByType('Learning')
      .filter(node => {
        const meta = node.metadata as { opsKind?: string } | undefined;
        return meta?.opsKind === 'regression' && node.status === 'detected';
      })
      .map(node => node.type === 'Learning' ? (node.insight || node.title) : node.title);
    return {
      cycles: decisions.length + jobs.length,
      detail: `${decisions.length} gate decision${decisions.length === 1 ? '' : 's'} and ${jobs.length} finished factory job${jobs.length === 1 ? '' : 's'} in ${ctx.layout.graphDb}`,
      promoted,
      rejected,
      regressions,
    };
  } catch (err) {
    return {
      cycles: null,
      detail: err instanceof Error ? err.message : 'graph read failed',
      promoted: [],
      rejected: [],
      regressions: [],
    };
  } finally {
    db.close();
  }
}

function sourceList(ctx: SentinelContext): string[] {
  const files = [...new Set(ctx.games.map(game => game.file))];
  const named = [
    pathOr(ctx.layout.ladderLogDir, 'games.jsonl'),
    pathOr(ctx.layout.opsDir, 'live-games.jsonl'),
    pathOr(ctx.layout.opsDir, 'heartbeats.jsonl'),
    pathOr(ctx.layout.opsDir, 'incidents.json'),
    pathOr(ctx.layout.opsDir, 'incidents.jsonl'),
    ctx.layout.graphDb,
    ctx.speciesPath,
  ];
  const present = named.filter(file => files.includes(file) || fs.existsSync(file));
  for (const file of files) {
    if (!present.includes(file)) present.push(file);
  }
  return present.length ? present : ['no game, heartbeat, or incident files were present'];
}

function pathOr(dir: string, name: string): string {
  return `${dir}/${name}`;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function signed(value: number): string {
  if (value > 0) return `+${value}`;
  return String(value);
}

export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(ms)}ms`;
  if (abs < 60_000) return `${Math.round(ms / 1000)}s`;
  if (abs < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (abs <= 48 * 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function previewIncidents(open: Incident[]): Incident[] {
  const urgent = open.filter(item => item.severity === 'P0' || item.severity === 'P1');
  const rest = open.filter(item => item.severity !== 'P0' && item.severity !== 'P1').slice(0, 8);
  return [...urgent, ...rest];
}
