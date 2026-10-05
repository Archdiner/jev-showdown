import * as path from 'path';
import { checkGameInvariants } from '../../client/game-integrity.js';
import { percentile } from '../../client/live-metrics.js';
import { foldCycle, stallAlert } from '../cycle.js';
import { invalidChoiceReasonsOf } from './games.js';
import { defaultAnalystDirs, listGameJsonl } from '../ingest.js';
import type { CheckHit, Evidence, InvariantCheck, ObservedGame, ProcessSnapshot, SentinelContext } from './types.js';

const OPS_FACILITIES = ['factory', 'gatekeeper', 'live', 'analyst'] as const;

export const CHECKS: InvariantCheck[] = [
  {
    id: 'duplicate-ladder-runners',
    severity: 'P0',
    title: 'More than one ladder.ts is playing one account',
    suggestedFix: 'The runner takes state/ladder-<userid>.lock before login. If two processes are still choosing, drain the extra one (SIGUSR1 or state/DRAIN). A lock from another host is not taken over, so two machines on one account still forfeit rooms.',
    detect: duplicateLadderRunners,
  },
  {
    id: 'choice-sent-not-applied',
    severity: 'P0',
    title: 'A turn-1 choice was logged sent and the game ended on our timer',
    suggestedFix: 'Treat /choose returning true as delivery, not application. Resend the same choice until a later turn or a new request shows the server took it.',
    detect: choiceSentNotApplied,
  },
  {
    id: 'phantom-games',
    severity: 'P0',
    title: 'A 0-turn tie or disconnect was recorded as a finished game',
    suggestedFix: 'Do not append a game row for a room that ended with no turns as a tie or disconnect. Those rows inflate the record.',
    detect: phantomGames,
  },
  {
    id: 'invalid-choices',
    severity: 'P0',
    title: 'A finished game logged invalid choices',
    suggestedFix: 'The choice must be one of the legal actions on that request. An invalid choice is a lost turn. When invalidChoiceReasons is present, each new reason is listed on the incident.',
    detect: invalidChoices,
  },
  {
    id: 'crash-or-fallback',
    severity: 'P0',
    title: 'A finished game logged a crash or a fallback',
    suggestedFix: 'A crash or a fallback means the engine did not play its choice. Fix the mechanism that threw or ran over the timer. Do not special-case a species.',
    detect: crashOrFallback,
  },
  {
    id: 'species-count',
    severity: 'P0',
    title: 'gen9-stats.json has fewer than 500 species',
    suggestedFix: 'Restore data/gen9-stats.json with npm run data:refresh. Tests must write stubs in a temp directory, not the repo data file. Self-play on a 1-species file is not gen9 random battles.',
    detect: speciesCount,
  },
  {
    id: 'ghost-rooms',
    severity: 'P1',
    title: 'A battle room is still open while a drain is waiting',
    suggestedFix: 'A drain cannot finish while a room has no result. Forfeit a room whose newest timestamp is stale, and do not count a room that already has a result.',
    detect: ghostRooms,
  },
  {
    id: 'drain-pending',
    severity: 'P1',
    title: 'A drain file has been pending for more than 10 minutes',
    suggestedFix: 'Remove state/DRAIN and live-runs/*.drain after the process exits. A file left in place blocks the next start and a file that stays while the process lives means the drain is hung.',
    detect: drainPending,
  },
  {
    id: 'runner-down',
    severity: 'P1',
    title: 'A ladder run file has a pid that is no longer the runner',
    suggestedFix: 'The run meta in live-runs is still the latest batch and summary.json is older than that file. Restart one ladder.ts. Do not start a second copy on the same account.',
    detect: runnerDown,
  },
  {
    id: 'ops-worker-missing',
    severity: 'P1',
    title: 'An ops worker is missing while the loop is up',
    suggestedFix: 'factory, gatekeeper, live, and analyst each need one fresh heartbeat. Start the missing worker. supervise restarts a facility that exits.',
    detect: workersMissing,
  },
  {
    id: 'ops-worker-duplicate',
    severity: 'P1',
    title: 'Two processes are heartbeating as the same ops worker',
    suggestedFix: 'Leave one process per facility. A second factory or live worker double-claims jobs and can log in twice.',
    detect: workersDuplicate,
  },
  {
    id: 'improvement-stall',
    severity: 'P1',
    title: 'Losses were reviewed and nothing was queued for 15 minutes',
    suggestedFix: 'Each live loss must enqueue a hypothesis variant or a mined position, or append a skip reason to state/ops/dispositions.jsonl. The factory reads open Hypothesis nodes and hypotheses.json on idle. Restart the analyst and the factory so a backlog is claimed. Do not delete analyst-seen.json.',
    detect: improvementStall,
  },
  {
    id: 'analyst-log-dir',
    severity: 'P1',
    title: 'The analyst is running without LADDER_LOG_DIR and its default dirs are empty',
    suggestedFix: 'Export LADDER_LOG_DIR to the directory that contains logs/ladder/games.jsonl before starting the analyst. The default logs/ladder and live-runs paths are empty, so it reviews nothing.',
    detect: analystLogDir,
  },
  {
    id: 'circuits-all-pulled',
    severity: 'P1',
    title: 'circuits.json has pulled every config, so ops live is idle',
    suggestedFix: 'A pull is a loss streak or a rating drop on one config. Clear the pull on the champion after the cause is fixed, or the live loop keeps skipping search.',
    detect: circuitsAllPulled,
  },
  {
    id: 'mixed-ratings',
    severity: 'P1',
    title: 'One row is both a local result and a ladder result',
    suggestedFix: 'Keep localbot and the public ladder in separate rows. A row that is both moves the circuit breaker with a rating that is not the ladder. Separate local and ladder rows are not compared.',
    detect: mixedRatings,
  },
  {
    id: 'replay-unconfirmed',
    severity: 'P2',
    title: 'A public game has replayUrl null and replayStatus unconfirmed',
    suggestedFix: 'Write the game row when the replay.pokemonshowdown.com URL arrives. Leave replayUrl null until then, and do not leave a public game unconfirmed.',
    detect: replayUnconfirmed,
  },
  {
    id: 'timer-margin-null',
    severity: 'P2',
    title: 'A played ladder game has minTimerMarginSec null',
    suggestedFix: 'Record the smallest seconds-left seen on our clock. A null margin hides timer losses. Local games and battle-local rows are not the ladder clock.',
    detect: timerMarginNull,
  },
  {
    id: 'elo-null-on-forfeit',
    severity: 'P2',
    title: 'A forfeit game has eloAfter null',
    suggestedFix: 'Copy the rating popup onto forfeit rows. A null eloAfter on a forfeit drops that game out of the rating series. A loss that stays at the 1000 floor stores eloAfter null on purpose.',
    detect: eloNullOnForfeit,
  },
  {
    id: 'required-fields-null',
    severity: 'P2',
    title: 'A ladder game record is missing a required field',
    suggestedFix: 'jev.ladder-game.v1 rows need battleId, outcome, endReason, username, format, and turns. Leave elo and gxe null when the server omits them. Do not omit the identity fields.',
    detect: requiredFieldsNull,
  },
  {
    id: 'latency-p95',
    severity: 'P2',
    title: 'Decision latency p95 is over the ladder budget',
    suggestedFix: 'The live decision budget is 12s. A p95 over that budget is the search running long. The gate self-play guardrail remains p99 under 2s.',
    detect: latencyP95,
  },
  {
    id: 'elo-drop',
    severity: 'P2',
    title: 'Ladder Elo fell by more than the threshold across the last N games',
    suggestedFix: 'The drop uses the same 40-point window as the circuit breaker, over the last 10 rated ladder games, phantoms excluded. Inspect those games before the next search.',
    detect: eloDrop,
  },
  {
    id: 'win-rate-batch',
    severity: 'P2',
    title: 'A batch win rate is under the target',
    suggestedFix: 'A full batch (10 games, grouped by git sha) more than 10 points under a 50% target is a trend. It is not a promotion. Promotion stays the gate.',
    detect: winRateBatch,
  },
  {
    id: 'checkout-behind',
    severity: 'P2',
    title: 'A checkout is behind origin/main',
    suggestedFix: 'Fast-forward the ops checkout and the ladder checkout (LIVE_REPO_DIR, or the git root of LADDER_LOG_DIR) to origin/main before the next ladder session.',
    detect: checkoutBehind,
  },
  {
    id: 'malformed-log-line',
    severity: 'P3',
    title: 'A JSONL line is not an object',
    suggestedFix: 'Append one JSON object per line. A partial or text line is skipped by readers and hides the game that followed it.',
    detect: malformedLines,
  },
  {
    id: 'stale-lock',
    severity: 'P3',
    title: 'A ladder account lock is held by a pid that is not running',
    suggestedFix: 'Remove state/ladder-<userid>.lock when its pid is dead. A stale lock in the ops checkout or the live checkout (LIVE_REPO_DIR) blocks the next login on that tree.',
    detect: staleLocks,
  },
  {
    id: 'duplicate-battle-id',
    severity: 'P0',
    title: 'A battle id is stored more than once',
    suggestedFix: 'The recorder claims the room and appends one row. npm run ops -- repair-games flags the extra rows in games.contamination.jsonl and does not rewrite the log. Readers keep one decisive result.',
    detect: ctx => integrityHits(ctx, 'duplicate-battle-id'),
  },
  {
    id: 'null-replay-url',
    severity: 'P2',
    title: 'A finished game has replayUrl null',
    suggestedFix: 'Store the public replay link, including a hidden room\'s -{password}pw suffix. A local server stores the local log path. Do not leave replayUrl null.',
    detect: ctx => integrityHits(ctx, 'null-replay-url'),
  },
  {
    id: 'null-required-field',
    severity: 'P2',
    title: 'A finished game is missing a required field',
    suggestedFix: 'minTimerMarginSec, endReason, durationMs, configId, gitSha, and replayUrl are required. A missing opponent rating stays null with opponentRatingReason unreported. A missing or mismatched eloAfter stays null with eloAfterReason. Those reasoned nulls are not this check.',
    detect: ctx => integrityHits(ctx, 'null-required-field'),
  },
];

function improvementStall(ctx: SentinelContext): CheckHit[] {
  const rows = ctx.rows.filter(row => path.basename(row.file) === 'cycle.jsonl' && row.value);
  const alert = stallAlert(foldCycle(rows.map(row => row.value)), ctx.now);
  if (!alert) return [];
  const file = rows[0]?.file ?? path.join(ctx.layout.opsDir, 'cycle.jsonl');
  return [{
    key: 'improvement-stall',
    detail: alert.message,
    evidence: [{ file, detail: alert.message }],
  }];
}

function integrityHits(ctx: SentinelContext, code: 'duplicate-battle-id' | 'null-replay-url' | 'null-required-field'): CheckHit[] {
  const located = ctx.rows.flatMap(row => (row.value ? [{ file: row.file, line: row.line, value: row.value }] : []));
  return checkGameInvariants(located.map(row => row.value))
    .filter(finding => finding.code === code)
    .map(finding => {
      const match = located.find(row => {
        const battleId = typeof row.value.battleId === 'string' ? row.value.battleId : null;
        return finding.battleId !== null && battleId === finding.battleId;
      });
      return {
        key: `${finding.battleId ?? 'row'}:${finding.field ?? code}`,
        detail: finding.detail,
        evidence: [{
          file: match?.file ?? path.join(ctx.layout.ladderLogDir, 'games.jsonl'),
          line: match?.line,
          detail: finding.detail,
        }],
      };
    });
}

function duplicateLadderRunners(ctx: SentinelContext): CheckHit[] {
  const accounts = new Map<string, { pids: Set<number>; evidence: Evidence[] }>();
  const add = (account: string, pid: number | null, evidence: Evidence) => {
    const row = accounts.get(account) ?? { pids: new Set<number>(), evidence: [] };
    if (pid !== null) row.pids.add(pid);
    row.evidence.push(evidence);
    accounts.set(account, row);
  };

  if (ctx.processesScanned) {
    for (const proc of ctx.processes) {
      const account = ladderAccount(proc);
      if (!account) continue;
      add(account, proc.pid, { file: 'process', detail: `pid ${proc.pid} ${proc.cmd}` });
    }
    for (const run of ctx.runs) {
      if (run.local) continue;
      if (!pidIsAlive(ctx, run.pid)) continue;
      const account = (run.username || 'unscoped').toLowerCase();
      add(account, run.pid, { file: run.path, detail: `run ${run.runId} pid ${run.pid} username ${run.username ?? 'unset'}` });
    }
    for (const lock of ctx.locks) {
      if (lock.pid === null || !pidIsAlive(ctx, lock.pid)) continue;
      const account = (lock.username || 'unscoped').toLowerCase();
      add(account, lock.pid, { file: lock.path, detail: `${lock.checkout} checkout lock pid ${lock.pid}` });
    }
  }

  const turns = ctx.rows.filter(row => row.value && isPidBattleRow(row.value) && inLookback(ctx, numberOf(row.value.ts)));
  const byBattle = new Map<string, { pids: Set<number>; evidence: Evidence[]; account: string }>();
  for (const row of turns) {
    const value = row.value;
    if (!value) continue;
    const battleId = text(value.battleId);
    if (!battleId) continue;
    const pid = numberOf(value.pid);
    const bucket = byBattle.get(battleId) ?? {
      pids: new Set<number>(),
      evidence: [],
      account: accountFromFile(row.file) ?? (text(value.username) || 'unscoped').toLowerCase(),
    };
    if (pid !== null) bucket.pids.add(pid);
    const kind = text(value.type) ?? text(value.kind) ?? text(value.schema) ?? 'row';
    bucket.evidence.push({ file: row.file, line: row.line, detail: `pid ${pid ?? 'unset'} ${kind} ${text(value.choice) ?? ''}`.trim() });
    byBattle.set(battleId, bucket);
  }
  for (const [battleId, bucket] of byBattle) {
    if (bucket.pids.size < 2) continue;
    for (const pid of bucket.pids) {
      add(bucket.account, pid, bucket.evidence.find(item => item.detail.startsWith(`pid ${pid}`)) ?? bucket.evidence[0]);
    }
    const forfeits = recentReal(ctx).filter(game => game.battleId === battleId && game.endReason === 'our-forfeit');
    for (const game of forfeits) {
      add(bucket.account, null, { file: game.file, line: game.line, detail: `${game.battleId} ended our-forfeit` });
    }
  }

  const hits: CheckHit[] = [];
  for (const [account, row] of accounts) {
    if (row.pids.size < 2) continue;
    hits.push({
      key: account,
      detail: `${account}: ${row.pids.size} ladder pids on one account`,
      evidence: row.evidence.slice(0, 8),
    });
  }
  return hits;
}

function choiceSentNotApplied(ctx: SentinelContext): CheckHit[] {
  const hits: CheckHit[] = [];
  const timers = new Set(
    recentReal(ctx)
      .filter(game => game.endReason === 'our-timer' && (game.turns ?? 0) <= 1)
      .map(game => game.battleId),
  );
  const byFile = groupRows(ctx);
  for (const [file, rows] of byFile) {
    for (let index = 0; index < rows.length; index++) {
      const value = rows[index].value;
      if (!value || !sentTrue(value)) continue;
      const battleId = text(value.battleId) ?? '';
      const turn = numberOf(value.turn);
      const timerGame = timers.has(battleId) || (text(value.endReason) === 'our-timer');
      const laterTimer = rows.slice(index + 1).some(row => {
        const end = row.value ? text(row.value.endReason) : null;
        const turns = row.value ? numberOf(row.value.turns) : null;
        return end === 'our-timer' && (turns === null || turns <= 1);
      });
      if (!timerGame && !laterTimer) continue;
      if (turn !== null && turn > 1) continue;
      if (appliedAfter(rows, index)) continue;
      if (!inLookback(ctx, numberOf(value.ts)) || !admitted(ctx, numberOf(value.ts))) continue;
      const id = battleId || `${file}:${rows[index].line}`;
      const game = ctx.games.find(item => item.battleId === battleId);
      hits.push({
        key: id,
        detail: `${id} logged sent=true and ended our-timer on turn ${turn ?? 1} without a move, switch, or later turn`,
        evidence: [{ file, line: rows[index].line, detail: `sent=true choice ${text(value.choice) ?? ''}` }],
        at: numberOf(value.ts) ?? game?.ts ?? null,
        gitSha: game?.gitSha ?? null,
        runId: game?.runId ?? null,
        battleId: battleId || id,
      });
    }
  }
  return dedupeHits(hits);
}

function phantomGames(ctx: SentinelContext): CheckHit[] {
  return recent(ctx)
    .filter(game => game.phantom)
    .map(game => fieldHit(
      game,
      game.battleId || `${game.file}:${game.line}`,
      `is a 0-turn ${game.endReason ?? game.outcome} and is excluded from the scorecard record`,
    ));
}

function crashOrFallback(ctx: SentinelContext): CheckHit[] {
  const hits: CheckHit[] = [];
  for (const game of recentReal(ctx)) {
    if (game.crashes > 0) {
      hits.push(fieldHit(game, `crash:${game.battleId || game.line}`, `crashes=${game.crashes}`));
    }
    if (game.fallbacks > 0) {
      hits.push(fieldHit(game, `fallback:${game.battleId || game.line}`, `fallbacks=${game.fallbacks}`));
    }
  }
  return hits;
}

function speciesCount(ctx: SentinelContext): CheckHit[] {
  if (ctx.speciesError || ctx.speciesCount === null || ctx.speciesCount < ctx.speciesMin) {
    const count = ctx.speciesCount === null ? 'unreadable' : String(ctx.speciesCount);
    return [{
      key: 'gen9-stats',
      detail: `${ctx.speciesPath} has ${count} species (minimum ${ctx.speciesMin})`,
      evidence: [{ file: ctx.speciesPath, detail: ctx.speciesError ?? `${count} species` }],
    }];
  }
  return [];
}

function ghostRooms(ctx: SentinelContext): CheckHit[] {
  if (ctx.drains.length === 0) return [];
  const finished = new Set(ctx.games.map(game => game.battleId).filter(Boolean));
  const open = new Map<string, Evidence>();
  for (const row of ctx.rows) {
    const value = row.value;
    if (!value) continue;
    const battleId = text(value.battleId);
    if (!battleId || finished.has(battleId)) continue;
    const kind = text(value.type) ?? text(value.kind);
    if (kind !== 'turn' && kind !== 'choice-delivery' && kind !== 'decision' && kind !== 'game_start') continue;
    if (!inLookback(ctx, numberOf(value.ts))) continue;
    open.set(battleId, { file: row.file, line: row.line, detail: `${battleId} has ${kind} and no result` });
  }
  return [...open.entries()].map(([battleId, evidence]) => ({
    key: battleId,
    detail: `${battleId} is open while ${ctx.drains.map(drain => drain.path).join(', ')} is present`,
    evidence: [evidence, { file: ctx.drains[0].path, detail: 'drain file present' }],
  }));
}

function drainPending(ctx: SentinelContext): CheckHit[] {
  const old = ctx.drains.filter(drain => ctx.now - drain.mtimeMs >= ctx.drainPendingMs);
  if (old.length === 0) return [];
  const byCheckout = new Map<string, typeof old>();
  for (const drain of old) {
    const list = byCheckout.get(drain.checkout) ?? [];
    list.push(drain);
    byCheckout.set(drain.checkout, list);
  }
  return [...byCheckout.entries()].map(([checkout, drains]) => ({
    key: checkout,
    detail: drains.map(drain => `${checkout} checkout ${drain.path} is ${Math.round((ctx.now - drain.mtimeMs) / 60000)} min old`).join('; '),
    evidence: drains.map(drain => ({ file: drain.path, detail: `${checkout} checkout mtime age ${Math.round((ctx.now - drain.mtimeMs) / 1000)}s` })),
  }));
}

function runnerDown(ctx: SentinelContext): CheckHit[] {
  if (!ctx.processesScanned) return [];
  const hits: CheckHit[] = [];
  for (const run of ctx.runs) {
    if (run.local) continue;
    if (ctx.now - run.mtimeMs > ctx.lookbackMs) continue;
    const alive = pidIsAlive(ctx, run.pid);
    if (alive) continue;
    if (ctx.summaryMtimeMs !== null && ctx.summaryMtimeMs >= run.mtimeMs) continue;
    hits.push({
      key: run.runId,
      detail: `run ${run.runId} pid ${run.pid} is not a live ladder.ts and summary.json is not newer than the run file`,
      evidence: [{ file: run.path, detail: `pid ${run.pid} username ${run.username ?? 'unset'}` }],
    });
  }
  return hits;
}

function workersMissing(ctx: SentinelContext): CheckHit[] {
  if (!loopExpected(ctx)) return [];
  const hits: CheckHit[] = [];
  for (const name of OPS_FACILITIES) {
    if (freshPids(ctx, name).size > 0) continue;
    if (ctx.processes.some(proc => facilityOf(proc) === name)) continue;
    hits.push({
      key: name,
      detail: `${name} has no heartbeat newer than ${Math.round(ctx.staleMs / 1000)}s and no matching process`,
      evidence: [{ file: path.join(ctx.layout.opsDir, 'heartbeats.jsonl'), detail: `${name} missing` }],
    });
  }
  return hits;
}

function workersDuplicate(ctx: SentinelContext): CheckHit[] {
  const hits: CheckHit[] = [];
  for (const name of OPS_FACILITIES) {
    const pids = new Set<number>(freshPids(ctx, name));
    for (const proc of ctx.processes) {
      if (facilityOf(proc) === name) pids.add(proc.pid);
    }
    if (pids.size < 2) continue;
    const evidence: Evidence[] = [];
    for (const beat of ctx.heartbeats) {
      if (beat.facility !== name || typeof beat.pid !== 'number' || !pids.has(beat.pid)) continue;
      evidence.push({ file: beat.file, line: beat.line, detail: `${name} pid ${beat.pid}` });
    }
    for (const proc of ctx.processes) {
      if (facilityOf(proc) === name) evidence.push({ file: 'process', detail: `pid ${proc.pid} ${proc.cmd}` });
    }
    hits.push({
      key: name,
      detail: `${name} has ${pids.size} live pids`,
      evidence: evidence.slice(0, 8),
    });
  }
  return hits;
}

function analystLogDir(ctx: SentinelContext): CheckHit[] {
  if (!ctx.processesScanned) return [];
  const analysts = ctx.processes.filter(proc => facilityOf(proc) === 'analyst' && proc.env);
  const hits: CheckHit[] = [];
  for (const proc of analysts) {
    const env = proc.env ?? {};
    if (env.LADDER_LOG_DIR) continue;
    const dirs = defaultAnalystDirs(ctx.layout.cwd, env);
    const found = dirs.flatMap(dir => listGameJsonl(dir));
    const elsewhere = listGameJsonl(ctx.layout.ladderLogDir);
    if (found.length > 0 || elsewhere.length === 0) continue;
    hits.push({
      key: 'analyst',
      detail: `analyst pid ${proc.pid} has no LADDER_LOG_DIR and ${dirs.join(', ')} has no game JSONL, while ${ctx.layout.ladderLogDir} does`,
      evidence: [
        { file: 'process', detail: `pid ${proc.pid} LADDER_LOG_DIR unset` },
        { file: elsewhere[0], detail: 'games exist outside the analyst default dirs' },
      ],
    });
  }
  return hits;
}

function circuitsAllPulled(ctx: SentinelContext): CheckHit[] {
  const circuits = ctx.circuits;
  if (!circuits) return [];
  const entries = Object.entries(circuits);
  if (entries.length === 0) return [];
  const open = entries.filter(([, state]) => !state?.pulled);
  if (open.length > 0) return [];
  return [{
    key: 'all-pulled',
    detail: `every config in circuits.json is pulled (${entries.map(([id, state]) => `${id}: ${state?.reason ?? 'pulled'}`).join('; ')})`,
    evidence: [{ file: ctx.circuitsPath, detail: `${entries.length} configs pulled` }],
  }];
}

function mixedRatings(ctx: SentinelContext): CheckHit[] {
  const hits: CheckHit[] = [];
  for (const beat of ctx.heartbeats) {
    if (!inLookback(ctx, numberOf(beat.ts))) continue;
    const scope = text(beat.scope);
    const detail = text(beat.detail) ?? '';
    if (!contradicts(scope, text(beat.source), beat.localServer === true, beat.localServer === false, detail)) continue;
    hits.push({
      key: `${beat.file}:${beat.line}`,
      detail: `one heartbeat is both local and ladder: ${detail || scope}`,
      evidence: [{ file: beat.file, line: beat.line, detail: detail || scope || 'mixed' }],
    });
  }
  for (const row of ctx.rows) {
    const value = row.value;
    if (!value || !inLookback(ctx, numberOf(value.ts))) continue;
    const detail = `${text(value.detail) ?? ''} ${text(value.username) ?? ''} ${text(value.battleId) ?? ''}`.trim();
    if (!contradicts(text(value.scope), text(value.source), value.localServer === true || value.local === true, value.localServer === false, detail)) continue;
    if (!isGameRowValue(value) && text(value.facility) !== null) continue;
    const battle = text(value.battleId) ?? `${row.file}:${row.line}`;
    hits.push({
      key: battle,
      detail: `${battle} is both a local row and a ladder row`,
      evidence: [{ file: row.file, line: row.line, detail }],
    });
  }
  return dedupeHits(hits);
}

function replayUnconfirmed(ctx: SentinelContext): CheckHit[] {
  return recentReal(ctx)
    .filter(game => game.ladder && !game.replayUrl && game.replayStatus === 'unconfirmed')
    .map(game => fieldHit(game, game.battleId || String(game.line), 'replayUrl null, replayStatus unconfirmed'));
}

function timerMarginNull(ctx: SentinelContext): CheckHit[] {
  return recentReal(ctx)
    .filter(game => (game.turns ?? 0) > 0 && game.minTimerMarginSec === null && !isLocalGame(game))
    .map(game => fieldHit(game, game.battleId || String(game.line), 'minTimerMarginSec null'));
}

function eloNullOnForfeit(ctx: SentinelContext): CheckHit[] {
  return recentReal(ctx)
    .filter(game => {
      if (game.endReason !== 'our-forfeit' && game.endReason !== 'opponent-forfeit') return false;
      if (game.eloAfter !== null) return false;
      // #57 stores eloAfter null when a loss stays at the 1000 floor (before === after).
      if (game.eloBefore === 1000) return false;
      return true;
    })
    .map(game => fieldHit(game, game.battleId || String(game.line), `eloAfter null on ${game.endReason}`));
}

function requiredFieldsNull(ctx: SentinelContext): CheckHit[] {
  const hits: CheckHit[] = [];
  for (const game of recent(ctx)) {
    if (game.schema !== 'jev.ladder-game.v1' || game.phantom) continue;
    const missing: string[] = [];
    if (!game.battleId) missing.push('battleId');
    if (!game.outcome) missing.push('outcome');
    if (!game.endReason) missing.push('endReason');
    if (!game.username) missing.push('username');
    if (!game.format) missing.push('format');
    if (game.turns === null) missing.push('turns');
    if (missing.length === 0) continue;
    hits.push(fieldHit(game, game.battleId || `${game.file}:${game.line}`, `missing ${missing.join(', ')}`));
  }
  return hits;
}

function latencyP95(ctx: SentinelContext): CheckHit[] {
  const samples = ctx.decisionSamples.filter(sample => {
    const row = ctx.rows.find(item => item.file === sample.file && item.line === sample.line);
    const ts = row?.value ? numberOf(row.value.ts) : null;
    return inLookback(ctx, ts);
  });
  const byFile = new Map<string, number[]>();
  for (const sample of samples) {
    const list = byFile.get(sample.file) ?? [];
    list.push(sample.ms);
    byFile.set(sample.file, list);
  }
  const hits: CheckHit[] = [];
  for (const [file, values] of byFile) {
    const p95 = percentile(values, 95);
    if (p95 === null || p95 <= ctx.latencyBudgetMs) continue;
    hits.push({
      key: file,
      detail: `${path.basename(file)} decision p95 ${Math.round(p95)}ms exceeds ${ctx.latencyBudgetMs}ms (${values.length} samples)`,
      evidence: [{ file, detail: `p95=${Math.round(p95)} n=${values.length}` }],
    });
  }
  return hits;
}

function eloDrop(ctx: SentinelContext): CheckHit[] {
  const rated = recentReal(ctx)
    .filter(game => game.ladder && game.eloAfter !== null && game.ts !== null)
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  if (rated.length < ctx.eloDropGames) return [];
  const window = rated.slice(-ctx.eloDropGames);
  const first = window[0].eloAfter ?? 0;
  const last = window[window.length - 1].eloAfter ?? 0;
  const drop = first - last;
  if (drop <= ctx.eloDrop) return [];
  return [{
    key: 'ladder',
    detail: `Elo ${first} → ${last} (${drop} points) across the last ${window.length} rated ladder games`,
    evidence: [
      { file: window[0].file, line: window[0].line, detail: `eloAfter ${first}` },
      { file: window[window.length - 1].file, line: window[window.length - 1].line, detail: `eloAfter ${last}` },
    ],
  }];
}

function winRateBatch(ctx: SentinelContext): CheckHit[] {
  const games = recentReal(ctx).filter(game => game.ladder && game.outcome && game.ts !== null);
  const groups = new Map<string, ObservedGame[]>();
  const anySha = games.some(game => game.gitSha);
  if (anySha) {
    for (const game of games) {
      const key = game.gitSha ?? 'no-git';
      const list = groups.get(key) ?? [];
      list.push(game);
      groups.set(key, list);
    }
  } else {
    const ordered = [...games].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    for (let index = 0; index + ctx.batchSize <= ordered.length; index += ctx.batchSize) {
      groups.set(`batch-${index / ctx.batchSize + 1}`, ordered.slice(index, index + ctx.batchSize));
    }
  }
  const floor = ctx.winTarget - ctx.winMargin;
  const hits: CheckHit[] = [];
  for (const [key, rows] of groups) {
    if (rows.length < ctx.batchSize) continue;
    const wins = rows.filter(game => game.outcome === 'win').length;
    const rate = wins / rows.length;
    if (rate >= floor) continue;
    hits.push({
      key,
      detail: `${key} won ${wins}/${rows.length} (${pct(rate)}) under ${pct(floor)} (target ${pct(ctx.winTarget)} minus ${pct(ctx.winMargin)})`,
      evidence: [{ file: rows[0].file, line: rows[0].line, detail: `${wins} wins in ${rows.length}` }],
    });
  }
  return hits;
}

function checkoutBehind(ctx: SentinelContext): CheckHit[] {
  const hits: CheckHit[] = [];
  for (const checkout of ctx.checkouts) {
    if (checkout.git.behind === null || checkout.git.behind <= 0) continue;
    hits.push({
      key: checkout.role,
      detail: `${checkout.role} checkout ${checkout.dir}: ${checkout.git.detail}`,
      evidence: [{ file: checkout.dir, detail: `${checkout.role} checkout ${checkout.git.detail}` }],
    });
  }
  return hits;
}

function staleLocks(ctx: SentinelContext): CheckHit[] {
  if (!ctx.processesScanned) return [];
  return ctx.locks
    .filter(lock => lock.pid === null || !pidIsAlive(ctx, lock.pid))
    .map(lock => ({
      key: `${lock.checkout}:${path.basename(lock.path)}`,
      detail: `${lock.checkout} checkout ${lock.path} pid ${lock.pid ?? 'unset'} is not running`,
      evidence: [{ file: lock.path, detail: `${lock.checkout} checkout ${lock.dir} pid ${lock.pid ?? 'unset'}` }],
    }));
}

function malformedLines(ctx: SentinelContext): CheckHit[] {
  return ctx.rows
    .filter(row => row.error)
    .map(row => ({
      key: `${row.file}:${row.line}`,
      detail: `${row.file}:${row.line} ${row.error}`,
      evidence: [{ file: row.file, line: row.line, detail: row.error ?? 'invalid JSON' }],
    }));
}

function invalidChoices(ctx: SentinelContext): CheckHit[] {
  const fromRows = reasonsOnRows(ctx);
  const hits: CheckHit[] = [];
  const seen = new Set<string>();
  for (const game of recentReal(ctx)) {
    const key = game.battleId || `${game.file}:${game.line}`;
    if (seen.has(key)) continue;
    const reasons = mergeReasons(game.invalidChoiceReasons, fromRows.get(game.battleId) ?? []);
    if (game.invalid <= 0 && reasons.length === 0) continue;
    seen.add(key);
    const count = game.invalid > 0 ? `invalidChoices=${game.invalid}` : 'invalidChoiceReasons present with invalidChoices=0';
    const detail = reasons.length ? `${count} reasons: ${reasons.join('; ')}` : count;
    const hit = fieldHit(game, key, detail);
    hit.evidence.push(...reasons.map(reason => ({ file: game.file, line: game.line, detail: reason })));
    hits.push(hit);
  }
  for (const [battleId, reasons] of fromRows) {
    if (!battleId || seen.has(battleId) || reasons.length === 0) continue;
    const row = ctx.rows.find(item => {
      if (!item.value || !inLookback(ctx, numberOf(item.value.ts)) || !admitted(ctx, numberOf(item.value.ts))) return false;
      const id = text(item.value.battleId) ?? text(item.value.id);
      return id === battleId;
    });
    if (!row) continue;
    seen.add(battleId);
    hits.push({
      key: battleId,
      detail: `${battleId} invalidChoiceReasons: ${reasons.join('; ')}`,
      evidence: [
        { file: row.file, line: row.line, detail: reasons.join('; ') },
        ...reasons.map(reason => ({ file: row.file, line: row.line, detail: reason })),
      ],
      at: numberOf(row.value?.ts),
      battleId,
      gitSha: text(row.value?.gitSha),
      runId: text(row.value?.runId),
    });
  }
  return hits;
}

function reasonsOnRows(ctx: SentinelContext): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of ctx.rows) {
    if (!row.value || !Object.prototype.hasOwnProperty.call(row.value, 'invalidChoiceReasons')) continue;
    if (!inLookback(ctx, numberOf(row.value.ts)) || !admitted(ctx, numberOf(row.value.ts))) continue;
    const battleId = text(row.value.battleId) ?? text(row.value.id) ?? '';
    const reasons = invalidChoiceReasonsOf(row.value.invalidChoiceReasons);
    if (!reasons.length) continue;
    out.set(battleId, mergeReasons(out.get(battleId) ?? [], reasons));
  }
  return out;
}

function mergeReasons(left: string[], right: string[]): string[] {
  const out = [...left];
  for (const reason of right) {
    if (!out.includes(reason)) out.push(reason);
  }
  return out;
}

function countField(
  ctx: SentinelContext,
  _name: string,
  test: (game: ObservedGame) => boolean,
  detail: (game: ObservedGame) => string,
): CheckHit[] {
  return recentReal(ctx).filter(test).map(game => fieldHit(game, game.battleId || String(game.line), detail(game)));
}

function fieldHit(game: ObservedGame, key: string, detail: string): CheckHit {
  return {
    key,
    detail: `${game.battleId || game.file} ${detail}`,
    evidence: [{ file: game.file, line: game.line, detail }],
    at: game.ts,
    gitSha: game.gitSha,
    runId: game.runId,
    battleId: game.battleId || key,
  };
}

function recent(ctx: SentinelContext): ObservedGame[] {
  return ctx.games.filter(game => inLookback(ctx, game.ts) && admitted(ctx, game.ts));
}

function recentReal(ctx: SentinelContext): ObservedGame[] {
  return recent(ctx).filter(game => !game.phantom);
}

function inLookback(ctx: SentinelContext, ts: number | null): boolean {
  if (ts === null) return true;
  return ts >= ctx.now - ctx.lookbackMs && ts <= ctx.now + 60_000;
}

function admitted(ctx: SentinelContext, ts: number | null): boolean {
  if (ctx.baselineMs === null) return true;
  if (ts === null) return false;
  return ts >= ctx.baselineMs;
}

function pidIsAlive(ctx: SentinelContext, pid: number): boolean {
  if (ctx.processes.some(proc => proc.pid === pid)) return true;
  return ctx.pidAlive(pid);
}

function isLocalGame(game: ObservedGame): boolean {
  if (game.local) return true;
  if (game.battleId.startsWith('battle-local')) return true;
  return game.file.endsWith('live-games.jsonl');
}

function contradicts(
  scope: string | null,
  source: string | null,
  localFlag: boolean,
  ladderFlag: boolean,
  detail: string,
): boolean {
  const localish = localFlag || scope === 'local' || source === 'local' || /\blocalbot\b|\bbotalpha\b|\bbotbravo\b|127\.0\.0\.1/i.test(detail);
  const ladderish = ladderFlag || scope === 'ladder' || source === 'ladder' || /\bladder\b|sim3\.psim\.us/i.test(detail);
  return localish && ladderish;
}

function freshPids(ctx: SentinelContext, facility: string): Set<number> {
  const pids = new Set<number>();
  for (const beat of ctx.heartbeats) {
    if (beat.facility !== facility || beat.status !== 'ok') continue;
    const ts = numberOf(beat.ts);
    if (ts === null || ctx.now - ts > ctx.staleMs || ts > ctx.now + 1000) continue;
    if (typeof beat.pid === 'number') pids.add(beat.pid);
  }
  return pids;
}

function loopExpected(ctx: SentinelContext): boolean {
  if (OPS_FACILITIES.some(name => freshPids(ctx, name).size > 0)) return true;
  if (freshPids(ctx, 'supervisor').size > 0) return true;
  return ctx.processes.some(proc => facilityOf(proc) !== null);
}

function facilityOf(proc: ProcessSnapshot): (typeof OPS_FACILITIES)[number] | null {
  const match = proc.cmd.match(/src\/ops\/cli\.ts\s+(factory|gatekeeper|live|analyst)\b/);
  if (!match) return null;
  return match[1] as (typeof OPS_FACILITIES)[number];
}

function ladderAccount(proc: ProcessSnapshot): string | null {
  if (!/src\/cli\/ladder\.ts|run-live\.sh/.test(proc.cmd)) return null;
  const flag = proc.cmd.match(/--username(?:=|\s+)(\S+)/);
  if (flag) return flag[1].toLowerCase();
  const env = proc.env?.SHOWDOWN_USERNAME;
  if (env) return env.toLowerCase();
  return 'unscoped';
}

function accountFromFile(file: string): string | null {
  const base = path.basename(file);
  const index = base.indexOf('-battle');
  if (index <= 0) return null;
  return base.slice(0, index).toLowerCase();
}

function isChoiceRow(value: Record<string, unknown>): boolean {
  const kind = text(value.type) ?? text(value.kind);
  return kind === 'turn' || kind === 'choice-delivery' || kind === 'choice';
}

function isPidBattleRow(value: Record<string, unknown>): boolean {
  if (isChoiceRow(value)) return true;
  return isGameRowValue(value);
}

function isGameRowValue(value: Record<string, unknown>): boolean {
  const schema = text(value.schema);
  const kind = text(value.kind);
  const type = text(value.type);
  if (schema === 'jev.ladder-game.v1') return true;
  if (kind === 'ladder-game' || kind === 'live-game') return true;
  if (type === 'result' || type === 'game') return true;
  return false;
}

function sentTrue(value: Record<string, unknown>): boolean {
  return value.sent === true;
}

function appliedAfter(rows: Array<{ value: Record<string, unknown> | null }>, index: number): boolean {
  for (const row of rows.slice(index + 1)) {
    const value = row.value;
    if (!value) continue;
    if (value.applied === true) return true;
    const blob = JSON.stringify(value);
    if (/\|move\||\|switch\||\|teampreview\|/.test(blob)) return true;
    const turn = blob.match(/\|turn\|(\d+)/);
    if (turn && Number(turn[1]) >= 2) return true;
  }
  return false;
}

function groupRows(ctx: SentinelContext): Map<string, Array<{ line: number; value: Record<string, unknown> | null }>> {
  const map = new Map<string, Array<{ line: number; value: Record<string, unknown> | null }>>();
  for (const row of ctx.rows) {
    const list = map.get(row.file) ?? [];
    list.push({ line: row.line, value: row.value });
    map.set(row.file, list);
  }
  return map;
}

function dedupeHits(hits: CheckHit[]): CheckHit[] {
  const map = new Map<string, CheckHit>();
  for (const hit of hits) {
    if (!map.has(hit.key)) map.set(hit.key, hit);
  }
  return [...map.values()];
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function pct(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}
