import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  clearanceMet,
  isEpisodeCheck,
  isGroupKey,
  type EpisodeClock,
  type EpisodeGroup,
} from './episodes.js';
import type { CheckHit, Evidence, Incident, IncidentEvent, IncidentStatus, InvariantCheck, Severity } from './types.js';
import { DEFAULTS, SEVERITY_RANK, actionable } from './types.js';

export interface IncidentStore {
  eventsPath: string;
  statePath: string;
}

export interface ReconcileInput {
  continuous: Array<{ check: InvariantCheck; hit: CheckHit }>;
  groups: EpisodeGroup[];
  clock: EpisodeClock;
}

export function incidentStore(opsDir: string): IncidentStore {
  return {
    eventsPath: path.join(opsDir, 'incidents.jsonl'),
    statePath: path.join(opsDir, 'incidents.json'),
  };
}

export function readEvents(file: string): IncidentEvent[] {
  if (!fs.existsSync(file)) return [];
  const events: IncidentEvent[] = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as IncidentEvent);
    } catch {
      continue;
    }
  }
  return events;
}

export function foldIncidents(events: IncidentEvent[]): Incident[] {
  return applyEvents([], events);
}

/** Fold `events` onto an existing snapshot. Does not re-read the event log. */
export function applyEvents(prior: Incident[], events: IncidentEvent[]): Incident[] {
  const byId = new Map<string, Incident>();
  for (const incident of prior) byId.set(incident.id, copyIncident(incident));
  for (const event of events) applyEvent(byId, event);
  return [...byId.values()].sort(compareIncidents);
}

function copyIncident(incident: Incident): Incident {
  const evidence = Array.isArray(incident.evidence) ? incident.evidence.map(item => ({ ...item })) : [];
  return { ...incident, evidence };
}

function applyEvent(byId: Map<string, Incident>, event: IncidentEvent): void {
  if (!event.incidentId || !event.checkId) return;
  const current = byId.get(event.incidentId);
  if (event.type === 'opened') {
    if (current) return;
    byId.set(event.incidentId, incidentFrom(event, event.ts));
    return;
  }
  if (!current) return;
  if (event.type === 'updated') {
    applyUpdate(current, event);
    return;
  }
  if (event.type === 'reopened') {
    current.status = 'open';
    current.lastSeen = event.ts;
    current.count = event.count ?? current.count + 1;
    current.evidence = event.evidence ?? current.evidence;
    current.detail = event.detail ?? current.detail;
    current.episodeOpenedAt = event.episodeOpenedAt ?? event.ts;
    current.clearSince = null;
    current.resolvedAt = null;
    current.verifiedAt = null;
    current.inBaseline = event.inBaseline !== false;
    current.battles = event.battles ?? current.battles;
    current.lastFailureTs = event.lastFailureTs ?? current.lastFailureTs;
    current.gitSha = event.gitSha ?? current.gitSha;
    current.runId = event.runId ?? current.runId;
    return;
  }
  if (event.type === 'acknowledged' && current.status === 'open') {
    current.status = 'acknowledged';
    if (event.rootCause) current.rootCause = event.rootCause;
    return;
  }
  if (event.type === 'fixing' && (current.status === 'open' || current.status === 'acknowledged')) {
    current.status = 'fixing';
    current.pr = event.pr ?? current.pr;
    return;
  }
  if (event.type === 'resolved' && actionable(current.status)) {
    current.status = 'resolved';
    current.clearSince = event.clearSince ?? event.ts;
    current.resolvedAt = event.ts;
    if (event.rootCause) current.rootCause = event.rootCause;
    return;
  }
  if (event.type === 'verified' && current.status === 'resolved') {
    current.status = 'verified';
    current.verifiedAt = event.ts;
    return;
  }
  if (event.type === 'root-cause') {
    current.rootCause = event.rootCause ?? current.rootCause;
  }
  if (event.type === 'linked') {
    current.ref = event.ref ?? current.ref;
  }
}

export function reconcile(
  incidents: Incident[],
  input: ReconcileInput,
  now: number,
  soakMs: number,
): { events: IncidentEvent[]; incidents: Incident[] } {
  const events: IncidentEvent[] = [];
  const next = incidents.map(cloneIncident);
  const existed = new Set(next.map(item => item.id));
  const seen = new Set<string>();
  const openedNow = new Set<string>();

  for (const { check, hit } of input.continuous) {
    const id = incidentId(check.id, hit.key);
    seen.add(id);
    const current = next.find(item => item.id === id);
    const evidence = hit.evidence.slice(0, 32);
    if (!current) {
      const created = blank(check, hit.key, id, now, hit.detail, evidence, 1);
      next.push(created);
      openedNow.add(id);
      events.push(eventFrom(created, now, 'opened'));
      continue;
    }
    if (current.status === 'resolved' || current.status === 'verified') {
      reopen(current, now, hit.detail, evidence, current.count + 1);
      openedNow.add(id);
      events.push(eventFrom(current, now, 'reopened'));
      continue;
    }
    touchContinuous(current, check, hit.detail, evidence, now, events);
  }

  for (const group of input.groups) {
    const id = incidentId(group.checkId, group.key);
    seen.add(id);
    const current = next.find(item => item.id === id);
    if (!current) {
      const created = blankGroup(group, id, now);
      next.push(created);
      openedNow.add(id);
      events.push(eventFrom(created, now, 'opened'));
      continue;
    }
    if (current.status === 'resolved' || current.status === 'verified') {
      const cutoff = current.resolvedAt ?? current.clearSince ?? 0;
      const newerTs = (group.lastFailureTs ?? now) > cutoff;
      const newBattle = group.battles.some(battle => !current.battles.includes(battle));
      const inWindow = input.clock.baselineMs === null || (group.lastFailureTs ?? now) >= input.clock.baselineMs;
      if ((!newerTs && !newBattle) || !inWindow) continue;
      reopen(current, now, group.detail, group.evidence, group.battles.length);
      current.battles = group.battles;
      current.lastFailureTs = group.lastFailureTs;
      current.gitSha = group.gitSha;
      current.runId = group.runId;
      current.inBaseline = true;
      openedNow.add(id);
      events.push(eventFrom(current, now, 'reopened'));
      continue;
    }
    const severityChanged = current.severity !== group.severity;
    const evidenceGrew = hasNewEvidence(current.evidence, group.evidence);
    current.lastSeen = now;
    current.count = group.battles.length;
    current.detail = group.detail;
    current.evidence = group.evidence;
    current.severity = group.severity;
    current.title = group.title;
    current.suggestedFix = group.suggestedFix;
    current.battles = group.battles;
    current.lastFailureTs = group.lastFailureTs;
    current.gitSha = group.gitSha;
    current.runId = group.runId;
    current.inBaseline = true;
    if (severityChanged || evidenceGrew) events.push(eventFrom(current, now, 'updated'));
    if (existed.has(id) && !openedNow.has(id) && clearanceMet(current, input.clock)) {
      resolveIncident(current, now, current.rootCause);
      events.push(eventFrom(current, now, 'resolved'));
    }
  }

  for (const incident of next) {
    if (isEpisodeCheck(incident.checkId)) stampBaseline(incident, input.clock);
    if (seen.has(incident.id)) {
      maybeVerify(incident, now, soakMs, events);
      continue;
    }
    if (isEpisodeCheck(incident.checkId)) {
      if (!isGroupKey(incident.key) && incident.status === 'open' && incident.firstSeen !== now) {
        resolveIncident(incident, now, incident.rootCause ?? 'grouped by run');
        events.push(eventFrom(incident, now, 'resolved'));
        continue;
      }
      if (actionable(incident.status) && existed.has(incident.id) && !openedNow.has(incident.id) && clearanceMet(incident, input.clock)) {
        resolveIncident(incident, now, incident.rootCause);
        events.push(eventFrom(incident, now, 'resolved'));
        continue;
      }
      maybeVerify(incident, now, soakMs, events);
      continue;
    }
    if (actionable(incident.status)) {
      resolveIncident(incident, now, incident.rootCause);
      events.push(eventFrom(incident, now, 'resolved'));
      continue;
    }
    maybeVerify(incident, now, soakMs, events);
  }

  return { events, incidents: next.sort(compareIncidents) };
}

export function writeIncidents(
  store: IncidentStore,
  events: IncidentEvent[],
  incidents: Incident[],
  soakMs: number,
  now: number,
  maxEventBytes: number = DEFAULTS.maxEventBytes,
): void {
  fs.mkdirSync(path.dirname(store.eventsPath), { recursive: true });
  if (events.length > 0) {
    fs.appendFileSync(store.eventsPath, events.map(event => JSON.stringify(event)).join('\n') + '\n');
    rotateEvents(store.eventsPath, maxEventBytes);
  }
  const body = {
    version: 1,
    updatedAt: now,
    soakMs,
    incidents,
  };
  fs.writeFileSync(store.statePath, `${JSON.stringify(body, null, 2)}\n`);
}

export function loadIncidents(store: IncidentStore): Incident[] {
  if (fs.existsSync(store.statePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(store.statePath, 'utf8')) as { incidents?: Incident[] };
      if (Array.isArray(parsed.incidents)) return parsed.incidents.map(normalizeIncident).sort(compareIncidents);
    } catch {
      // Fall through to the event log when the snapshot is unreadable.
    }
  }
  return foldIncidents(readEvents(store.eventsPath));
}

export function acknowledge(store: IncidentStore, id: string, now = Date.now()): string | null {
  return transition(store, id, now, incident => {
    if (incident.status !== 'open') return `incident ${id} is ${incident.status}, not open`;
    return { type: 'acknowledged', status: 'acknowledged' };
  });
}

export function markFixing(store: IncidentStore, id: string, pr: string, now = Date.now()): string | null {
  if (!pr) return 'a PR link is required';
  return transition(store, id, now, incident => {
    if (incident.status !== 'open' && incident.status !== 'acknowledged') return `incident ${id} is ${incident.status}`;
    return { type: 'fixing', status: 'fixing', pr };
  });
}

export function recordRootCause(store: IncidentStore, id: string, rootCause: string, now = Date.now()): string | null {
  if (!rootCause.trim()) return 'a root cause is required';
  return transition(store, id, now, () => ({
    type: 'root-cause',
    status: 'open',
    rootCause: rootCause.trim(),
  }));
}

export function linkIncident(store: IncidentStore, id: string, ref: string, now = Date.now()): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return 'a ledger ref is required';
  return transition(store, id, now, () => ({
    type: 'linked',
    status: 'open',
    ref: trimmed,
  }));
}

export interface IncidentFilter {
  before?: number;
  sha?: string;
}

export function selectIncidents(incidents: Incident[], filter: IncidentFilter): Incident[] {
  return incidents.filter(incident => matchesFilter(incident, filter));
}

export function acknowledgeMatching(store: IncidentStore, filter: IncidentFilter, reason: string, now = Date.now()): { ids: string[]; error: string | null } {
  return matchTransition(store, filter, reason, now, incident => {
    if (incident.status !== 'open') return false;
    incident.status = 'acknowledged';
    incident.rootCause = reason;
    return true;
  }, 'acknowledged');
}

export function resolveMatching(store: IncidentStore, filter: IncidentFilter, reason: string, now = Date.now()): { ids: string[]; error: string | null } {
  return matchTransition(store, filter, reason, now, incident => {
    if (!actionable(incident.status)) return false;
    resolveIncident(incident, now, reason);
    incident.inBaseline = false;
    return true;
  }, 'resolved');
}

export function incidentId(checkId: string, key: string): string {
  const slug = `${checkId}-${key}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72);
  if (slug.length >= 8) return `inc-${slug}`;
  const hash = createHash('sha256').update(`${checkId}\0${key}`).digest('hex').slice(0, 12);
  return `inc-${checkId}-${hash}`;
}

export function compareIncidents(a: Incident, b: Incident): number {
  const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (rank !== 0) return rank;
  if (b.count !== a.count) return b.count - a.count;
  return a.id.localeCompare(b.id);
}

/** Exit 1 only for these. Acknowledged and fixing P0s stay on the scorecard and do not fail the scheduler. */
export function isSchedulerP0(item: Incident): boolean {
  return item.severity === 'P0' && item.status === 'open' && item.inBaseline !== false;
}

export function openP0(incidents: Incident[]): number {
  return incidents.filter(isSchedulerP0).length;
}

export function countSeverity(incidents: Incident[], severity: Severity): number {
  return incidents.filter(item => item.severity === severity && actionable(item.status) && item.inBaseline !== false).length;
}

export function shaCandidates(incident: Incident): string[] {
  const found = new Set<string>();
  if (incident.gitSha) found.add(incident.gitSha);
  const blob = `${incident.detail}\n${incident.evidence.map(item => item.detail).join('\n')}`;
  for (const match of blob.matchAll(/gitSha=([0-9a-f]+)/gi)) found.add(match[1]);
  return [...found];
}

function matchTransition(
  store: IncidentStore,
  filter: IncidentFilter,
  reason: string,
  now: number,
  apply: (incident: Incident) => boolean,
  type: IncidentEvent['type'],
): { ids: string[]; error: string | null } {
  const trimmed = reason.trim();
  if (!trimmed) return { ids: [], error: 'a reason is required' };
  if (filter.before === undefined && !filter.sha) return { ids: [], error: '--before or --sha is required' };
  const incidents = loadIncidents(store);
  const events: IncidentEvent[] = [];
  const ids: string[] = [];
  for (const incident of incidents) {
    if (!matchesFilter(incident, filter)) continue;
    if (!apply(incident)) continue;
    ids.push(incident.id);
    events.push(eventFrom(incident, now, type));
  }
  if (events.length > 0) writeIncidents(store, events, incidents, 0, now);
  return { ids, error: null };
}

function matchesFilter(incident: Incident, filter: IncidentFilter): boolean {
  if (filter.before !== undefined) {
    const when = incident.lastFailureTs ?? incident.firstSeen;
    if (when >= filter.before) return false;
  }
  if (filter.sha) {
    const needle = filter.sha.toLowerCase();
    const hit = shaCandidates(incident).some(sha => sha.toLowerCase().startsWith(needle));
    if (!hit) return false;
  }
  return true;
}

function transition(
  store: IncidentStore,
  id: string,
  now: number,
  build: (incident: Incident) => { type: IncidentEvent['type']; status: IncidentStatus; pr?: string; rootCause?: string; ref?: string } | string,
): string | null {
  const incidents = loadIncidents(store);
  const incident = incidents.find(item => item.id === id);
  if (!incident) return `no incident ${id}`;
  const next = build(incident);
  if (typeof next === 'string') return next;
  if (next.type !== 'root-cause' && next.type !== 'linked') incident.status = next.status;
  if (next.pr) incident.pr = next.pr;
  if (next.rootCause) incident.rootCause = next.rootCause;
  if (next.ref) incident.ref = next.ref;
  const event = eventFrom(incident, now, next.type);
  if (next.type === 'root-cause') event.status = incident.status;
  writeIncidents(store, [event], incidents, 0, now);
  return null;
}

function touchContinuous(
  current: Incident,
  check: InvariantCheck,
  detail: string,
  evidence: Evidence[],
  now: number,
  events: IncidentEvent[],
): void {
  const severityChanged = current.severity !== check.severity;
  const evidenceGrew = hasNewEvidence(current.evidence, evidence);
  current.lastSeen = now;
  current.count += 1;
  current.detail = detail;
  current.evidence = evidence;
  current.severity = check.severity;
  current.title = check.title;
  current.suggestedFix = check.suggestedFix;
  current.inBaseline = true;
  if (severityChanged || evidenceGrew) events.push(eventFrom(current, now, 'updated'));
}

function reopen(current: Incident, now: number, detail: string, evidence: Evidence[], count: number): void {
  current.status = 'open';
  current.lastSeen = now;
  current.count = count;
  current.detail = detail;
  current.evidence = evidence;
  current.episodeOpenedAt = now;
  current.clearSince = null;
  current.resolvedAt = null;
  current.verifiedAt = null;
  current.inBaseline = true;
}

function resolveIncident(incident: Incident, now: number, rootCause: string | null): void {
  incident.status = 'resolved';
  incident.clearSince = now;
  incident.resolvedAt = now;
  if (rootCause) incident.rootCause = rootCause;
}

function maybeVerify(incident: Incident, now: number, soakMs: number, events: IncidentEvent[]): void {
  if (incident.status !== 'resolved') return;
  const since = incident.clearSince ?? incident.resolvedAt ?? now;
  if (now - since < soakMs) return;
  incident.status = 'verified';
  incident.verifiedAt = now;
  events.push(eventFrom(incident, now, 'verified'));
}

function stampBaseline(incident: Incident, clock: EpisodeClock): void {
  if (clock.baselineMs === null) {
    incident.inBaseline = true;
    return;
  }
  if (incident.lastFailureTs !== null) {
    incident.inBaseline = incident.lastFailureTs >= clock.baselineMs;
    return;
  }
  const game = clock.games.find(item => item.battleId && (incident.key === item.battleId || incident.key.includes(item.battleId)));
  if (game?.ts !== null && game?.ts !== undefined) {
    incident.lastFailureTs = game.ts;
    incident.inBaseline = game.ts >= clock.baselineMs;
    return;
  }
  incident.inBaseline = incident.firstSeen >= clock.baselineMs;
}

function blank(
  check: InvariantCheck,
  key: string,
  id: string,
  now: number,
  detail: string,
  evidence: Evidence[],
  count: number,
): Incident {
  return {
    id,
    checkId: check.id,
    key,
    severity: check.severity,
    title: check.title,
    suggestedFix: check.suggestedFix,
    detail,
    firstSeen: now,
    lastSeen: now,
    count,
    evidence,
    status: 'open',
    rootCause: null,
    pr: null,
    ref: null,
    gitSha: null,
    runId: null,
    inBaseline: true,
    battles: [],
    lastFailureTs: null,
    episodeOpenedAt: now,
    clearSince: null,
    resolvedAt: null,
    verifiedAt: null,
  };
}

function blankGroup(group: EpisodeGroup, id: string, now: number): Incident {
  return {
    id,
    checkId: group.checkId,
    key: group.key,
    severity: group.severity,
    title: group.title,
    suggestedFix: group.suggestedFix,
    detail: group.detail,
    firstSeen: now,
    lastSeen: now,
    count: group.battles.length,
    evidence: group.evidence,
    status: 'open',
    rootCause: null,
    pr: null,
    ref: null,
    gitSha: group.gitSha,
    runId: group.runId,
    inBaseline: true,
    battles: group.battles,
    lastFailureTs: group.lastFailureTs,
    episodeOpenedAt: now,
    clearSince: null,
    resolvedAt: null,
    verifiedAt: null,
  };
}

function eventFrom(incident: Incident, now: number, type: IncidentEvent['type']): IncidentEvent {
  return {
    ts: now,
    type,
    incidentId: incident.id,
    checkId: incident.checkId,
    key: incident.key,
    severity: incident.severity,
    title: incident.title,
    status: type === 'root-cause' || type === 'linked' ? incident.status : statusFor(type),
    detail: incident.detail,
    evidence: incident.evidence,
    count: incident.count,
    rootCause: incident.rootCause,
    pr: incident.pr,
    suggestedFix: incident.suggestedFix,
    episodeOpenedAt: incident.episodeOpenedAt,
    clearSince: incident.clearSince,
    ref: incident.ref,
    gitSha: incident.gitSha,
    runId: incident.runId,
    inBaseline: incident.inBaseline,
    battles: incident.battles,
    lastFailureTs: incident.lastFailureTs,
  };
}

function statusFor(type: IncidentEvent['type']): IncidentStatus {
  if (type === 'acknowledged') return 'acknowledged';
  if (type === 'fixing') return 'fixing';
  if (type === 'resolved') return 'resolved';
  if (type === 'verified') return 'verified';
  return 'open';
}

function applyUpdate(current: Incident, event: IncidentEvent): void {
  current.lastSeen = event.ts;
  current.count = event.count ?? current.count;
  current.evidence = event.evidence ?? current.evidence;
  current.detail = event.detail ?? current.detail;
  current.severity = event.severity ?? current.severity;
  current.title = event.title || current.title;
  current.battles = event.battles ?? current.battles;
  current.lastFailureTs = event.lastFailureTs ?? current.lastFailureTs;
  current.gitSha = event.gitSha ?? current.gitSha;
  current.runId = event.runId ?? current.runId;
}

function incidentFrom(event: IncidentEvent, ts: number): Incident {
  return normalizeIncident({
    id: event.incidentId,
    checkId: event.checkId,
    key: event.key,
    severity: event.severity,
    title: event.title,
    suggestedFix: event.suggestedFix ?? null,
    detail: event.detail ?? '',
    firstSeen: ts,
    lastSeen: ts,
    count: event.count ?? 1,
    evidence: event.evidence ?? [],
    status: 'open',
    rootCause: event.rootCause ?? null,
    pr: event.pr ?? null,
    ref: event.ref ?? null,
    gitSha: event.gitSha ?? null,
    runId: event.runId ?? null,
    inBaseline: event.inBaseline !== false,
    battles: event.battles ?? [],
    lastFailureTs: event.lastFailureTs ?? null,
    episodeOpenedAt: event.episodeOpenedAt ?? ts,
    clearSince: null,
    resolvedAt: null,
    verifiedAt: null,
  });
}

function normalizeIncident(raw: Incident): Incident {
  return {
    ...raw,
    suggestedFix: raw.suggestedFix ?? null,
    rootCause: raw.rootCause ?? null,
    pr: raw.pr ?? null,
    ref: raw.ref ?? null,
    gitSha: raw.gitSha ?? null,
    runId: raw.runId ?? null,
    inBaseline: raw.inBaseline !== false,
    battles: raw.battles ?? [],
    lastFailureTs: raw.lastFailureTs ?? null,
    clearSince: raw.clearSince ?? null,
    resolvedAt: raw.resolvedAt ?? null,
    verifiedAt: raw.verifiedAt ?? null,
  };
}

function cloneIncident(incident: Incident): Incident {
  return normalizeIncident({ ...incident, evidence: incident.evidence.map(item => ({ ...item })), battles: [...(incident.battles ?? [])] });
}

function hasNewEvidence(prev: Evidence[], next: Evidence[]): boolean {
  const keys = new Set(prev.map(evidenceKey));
  return next.some(item => !keys.has(evidenceKey(item)));
}

function evidenceKey(item: Evidence): string {
  return `${item.file}\0${item.line ?? ''}\0${item.detail}`;
}

function rotateEvents(file: string, maxBytes: number): void {
  if (!fs.existsSync(file)) return;
  if (fs.statSync(file).size <= maxBytes) return;
  let index = 1;
  while (fs.existsSync(`${file}.${index}`)) index += 1;
  fs.renameSync(file, `${file}.${index}`);
}
