const endReason = document.querySelector('#endReason');
const band = document.querySelector('#band');
const meta = document.querySelector('#meta');
const ops = document.querySelector('#ops');
const rates = document.querySelector('#rates');
const calibration = document.querySelector('#calibration');
const calNote = document.querySelector('#calNote');
const filtered = document.querySelector('#filtered');
const runs = document.querySelector('#runs');
const rows = document.querySelector('#rows');
const configRows = document.querySelector('#configRows');
const incidentsMeta = document.querySelector('#incidents-meta');
const incidentsBody = document.querySelector('#incidents');
const scorecard = document.querySelector('#scorecard');

function text(value) {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

function pct(rate) {
  return rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(1)}%`;
}

function duration(ms) {
  if (ms === null || ms === undefined) return '—';
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function card(parent, title, tally, className) {
  const node = document.createElement('div');
  node.className = `card ${className}`;
  const label = document.createElement('span');
  label.textContent = title;
  const strong = document.createElement('strong');
  const ci = tally.ciLow === null ? '' : ` (${pct(tally.ciLow)}–${pct(tally.ciHigh)})`;
  strong.textContent = `${pct(tally.winRate)}  ${tally.wins}-${tally.losses}-${tally.ties}${ci}`;
  node.append(label, strong);
  parent.append(node);
}

function calCard(parent, title, strong, detail) {
  const node = document.createElement('div');
  node.className = 'card';
  const label = document.createElement('span');
  label.textContent = title;
  const value = document.createElement('strong');
  value.textContent = strong;
  node.append(label, value);
  if (detail) {
    const note = document.createElement('span');
    note.textContent = detail;
    node.append(note);
  }
  parent.append(node);
}

function countPct(rate, numerator, denominator) {
  if (rate === null || rate === undefined || !denominator) return '—';
  return `${pct(rate)} (${numerator}/${denominator})`;
}

function renderCalibration(summary, filtered) {
  calibration.replaceChildren();
  calNote.textContent = filtered
    ? 'This filter. Predicted foe action, damage, KOs, and speed order against the protocol that followed the choice. Damage is mean absolute error as a fraction of max HP.'
    : 'All logged turns. Predicted foe action, damage, KOs, and speed order against the protocol that followed the choice. Damage is mean absolute error as a fraction of max HP.';
  if (!summary || !summary.compared) {
    const empty = document.createElement('p');
    empty.textContent = 'No compared turns yet.';
    calibration.append(empty);
    return;
  }
  calCard(calibration, 'Foe action', countPct(summary.foeActionAccuracy, summary.foeActionCorrect, summary.foeActions), `${summary.compared} turns`);
  calCard(calibration, 'Damage dealt', summary.damageDealtMae === null ? '—' : `${(summary.damageDealtMae * 100).toFixed(1)}% HP`, 'mean absolute error');
  calCard(calibration, 'Damage taken', summary.damageTakenMae === null ? '—' : `${(summary.damageTakenMae * 100).toFixed(1)}% HP`, 'mean absolute error');
  calCard(calibration, 'KO misses', countPct(summary.koErrorRate, summary.koErrors, summary.koCompared), `ours ${summary.ourKoErrors}, foe ${summary.foeKoErrors}`);
  calCard(calibration, 'Speed order', countPct(summary.speedOrderErrorRate, summary.speedOrderErrors, summary.speedCompared), 'who acted first');
}

function score(tally) {
  if (!tally) return '—';
  return `${pct(tally.winRate)} ${tally.wins}-${tally.losses}-${tally.ties}`;
}

function renderConfigs(list) {
  configRows.replaceChildren();
  if (!list.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 10;
    td.textContent = 'No finished games.';
    tr.append(td);
    configRows.append(tr);
    return;
  }
  for (const row of list) {
    const tr = document.createElement('tr');
    tr.append(
      cell(row.configId),
      cell(row.role),
      cell(row.share),
      cell(`${row.wins}-${row.losses}-${row.ties}`),
      cell(row.eloDelta === null || row.eloDelta === undefined ? null : Math.round(row.eloDelta)),
      cell(row.invalidMoves),
      cell(score(row.report && row.report.strategy)),
      cell(score(row.report && row.report.timerDisconnect)),
      cell(score(row.report && row.report.crash)),
      cell(score(row.report && row.report.all)),
    );
    configRows.append(tr);
  }
}

function cell(value) {
  const td = document.createElement('td');
  td.textContent = text(value);
  return td;
}

function render(body, status) {
  if (status && status.ops) ops.textContent = `${status.ops.statusText}\n\n${status.ops.reportText}`;
  const games = body.games;
  const report = games.report;
  meta.textContent = `${body.fixtureMode ? 'Fixture data. ' : ''}${games.record.games} games, rating ${text(games.elo)}. Strategy excludes timer, disconnect, and crash. Ladder lines have no end reason, so they stay in strategy and their losses are also counted as unclassified (${report.unclassifiedLosses}).`;
  rates.replaceChildren();
  renderConfigs(games.configs || []);
  card(rates, 'Strategy', report.strategy, 'strategy');
  card(rates, 'Timer / disconnect', report.timerDisconnect, 'timer');
  card(rates, 'Crash', report.crash, 'crash');
  card(rates, 'All finished', report.all, '');
  const unfiltered = endReason.value === 'any' && band.value === 'any';
  renderCalibration(unfiltered ? games.calibration : games.filteredCalibration, !unfiltered);
  const slice = games.filteredReport.all;
  const noun = slice.games === 1 ? 'game' : 'games';
  filtered.textContent = `This filter (${games.filter.endReason}, ${games.filter.band}): ${pct(slice.winRate)} on ${slice.games} ${noun}, ${slice.wins}-${slice.losses}-${slice.ties}. Across all games: strategy losses ${report.strategyLosses}, timer/disconnect losses ${report.timerDisconnectLosses}, crash losses ${report.crashLosses}, unclassified losses ${report.unclassifiedLosses}.`;
  const byRun = games.byRun || [];
  runs.textContent = byRun.length === 0
    ? ''
    : byRun.map(run => `${run.runId}${run.batchLabel ? ` ${run.batchLabel}` : ''}${run.hostname ? ` ${run.hostname}` : ''} ${run.wins}-${run.losses}-${run.ties}`).join(' · ');
  rows.replaceChildren();
  if (games.filtered.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 22;
    td.textContent = 'No games in this filter. Per-game JSONL is used when present; otherwise [ladder] N/M lines are shown without an end reason.';
    tr.append(td);
    rows.append(tr);
    return;
  }
  for (const game of games.filtered) {
    const tr = document.createElement('tr');
    tr.className = game.lossClass;
    const replay = document.createElement('td');
    if (game.replayUrl) {
      const link = document.createElement('a');
      link.href = game.replayUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = 'replay';
      replay.append(link);
    } else {
      replay.textContent = '—';
    }
    tr.append(
      replay,
      cell(game.opponent),
      cell(game.opponentRating),
      cell(game.ratingBefore),
      cell(game.ratingAfter),
      cell(game.outcome),
      cell(game.endReason),
      cell(game.lossClass),
      cell(duration(game.durationMs)),
      cell(game.latency && game.latency.p50),
      cell(game.latency && game.latency.p95),
      cell(game.latency && game.latency.p99),
      cell(game.latency && game.latency.max),
      cell(game.minTimerSeconds),
      cell(game.engine),
      cell(game.configId),
      cell(game.configHash),
      cell(game.gitSha),
      cell(game.runId),
      cell(game.batchLabel),
      cell(game.hostname),
      cell(game.concurrency),
    );
    rows.append(tr);
  }
}

function renderIncidents(payload) {
  const list = payload && payload.incidents ? payload.incidents : [];
  const open = list.filter(item => item.status === 'open' || item.status === 'acknowledged' || item.status === 'fixing');
  incidentsMeta.textContent = list.length === 0
    ? 'No open incidents. npm run ops -- sentinel writes state/ops/incidents.jsonl.'
    : `${open.length} open, ${list.length} not yet verified. Ranked by severity.`;
  incidentsBody.replaceChildren();
  if (list.length === 0) return;
  for (const incident of list) {
    const tr = document.createElement('tr');
    const severity = document.createElement('td');
    severity.className = `sev-${incident.severity}`;
    severity.textContent = incident.severity;
    tr.append(
      severity,
      cell(incident.status),
      cell(incident.count),
      cell(incident.title),
      cell(incident.detail),
    );
    incidentsBody.append(tr);
  }
}

async function load() {
  const params = new URLSearchParams({ endReason: endReason.value, band: band.value });
  const [gamesResponse, statusResponse, incidentsResponse, scorecardResponse] = await Promise.all([
    fetch(`/api/games?${params}`),
    fetch('/api/status'),
    fetch('/api/incidents'),
    fetch('/api/scorecard'),
  ]);
  if (incidentsResponse.ok) renderIncidents(await incidentsResponse.json());
  else incidentsMeta.textContent = `Incidents API returned ${incidentsResponse.status}.`;
  if (scorecardResponse.ok) {
    const body = await scorecardResponse.json();
    scorecard.textContent = body.scorecard || 'Scorecard is empty.';
  } else {
    scorecard.textContent = `Scorecard API returned ${scorecardResponse.status}.`;
  }
  if (!gamesResponse.ok) {
    meta.textContent = `Games API returned ${gamesResponse.status}.`;
    return;
  }
  render(await gamesResponse.json(), statusResponse.ok ? await statusResponse.json() : null);
}

endReason.addEventListener('change', load);
band.addEventListener('change', load);
load();
const events = new EventSource('/api/events');
events.addEventListener('snapshot', load);
