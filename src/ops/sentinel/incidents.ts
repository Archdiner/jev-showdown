import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { CheckHit, Evidence, Incident, IncidentEvent, IncidentStatus, InvariantCheck, Severity } from './types.js';
import { SEVERITY_RANK, actionable } from './types.js';

export interface IncidentStore {
  eventsPath: string;
  statePath: string;
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
  const byId = new Map<string, Incident>();
  for (const event of events) {
    if (!event.incidentId || !event.checkId) continue;
    const current = byId.get(event.incidentId);
    if (event.type === 'opened') {
      if (current) continue;
      byId.set(event.incidentId, incidentFrom(event, event.ts));
      continue;
    }
    if (!current) continue;
    if (event.type === 'updated') {
      current.lastSeen = event.ts;
      current.count = event.count ?? current.count;
      current.evidence = event.evidence ?? current.evidence;
      current.detail = event.detail ?? current.detail;
      current.severity = event.severity ?? current.severity;
      current.title = event.title || current.title;
      continue;
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
      continue;
    }
    if (event.type === 'acknowledged' && current.status === 'open') {
      current.status = 'acknowledged';
      continue;
    }
    if (event.type === 'fixing' && (current.status === 'open' || current.status === 'acknowledged')) {
      current.status = 'fixing';
      current.pr = event.pr ?? current.pr;
      continue;
    }
    if (event.type === 'resolved' && actionable(current.status)) {
      current.status = 'resolved';
      current.clearSince = event.clearSince ?? event.ts;
      current.resolvedAt = event.ts;
      continue;
    }
    if (event.type === 'verified' && current.status === 'resolved') {
      current.status = 'verified';
      current.verifiedAt = event.ts;
      continue;
    }
    if (event.type === 'root-cause') {
      current.rootCause = event.rootCause ?? current.rootCause;
    }
  }
  return [...byId.values()].sort(compareIncidents);
}

export function reconcile(
  incidents: Incident[],
  hits: Array<{ check: InvariantCheck; hit: CheckHit }>,
  now: number,
  soakMs: number,
): IncidentEvent[] {
  const events: IncidentEvent[] = [];
  const seen = new Set<string>();
  for (const { check, hit } of hits) {
    const id = incidentId(check.id, hit.key);
    seen.add(id);
    const current = incidents.find(item => item.id === id);
    const evidence = hit.evidence.slice(0, 8);
    if (!current) {
      events.push(base(check, hit, id, now, 'opened', 'open', 1, now, evidence));
      continue;
    }
    if (current.status === 'resolved' || current.status === 'verified') {
      events.push(base(check, hit, id, now, 'reopened', 'open', current.count + 1, now, evidence));
      continue;
    }
    events.push({
      ...base(check, hit, id, now, 'updated', current.status, current.count + 1, current.episodeOpenedAt, evidence),
    });
  }
  for (const incident of incidents) {
    if (seen.has(incident.id)) continue;
    if (actionable(incident.status)) {
      events.push({
        ts: now,
        type: 'resolved',
        incidentId: incident.id,
        checkId: incident.checkId,
        key: incident.key,
        severity: incident.severity,
        title: incident.title,
        status: 'resolved',
        clearSince: now,
        episodeOpenedAt: incident.episodeOpenedAt,
        rootCause: incident.rootCause,
        pr: incident.pr,
      });
      continue;
    }
    if (incident.status === 'resolved') {
      const since = incident.clearSince ?? incident.resolvedAt ?? now;
      if (now - since >= soakMs) {
        events.push({
          ts: now,
          type: 'verified',
          incidentId: incident.id,
          checkId: incident.checkId,
          key: incident.key,
          severity: incident.severity,
          title: incident.title,
          status: 'verified',
          clearSince: since,
          episodeOpenedAt: incident.episodeOpenedAt,
          rootCause: incident.rootCause,
          pr: incident.pr,
        });
      }
    }
  }
  return events;
}

export function writeIncidents(store: IncidentStore, events: IncidentEvent[], incidents: Incident[], soakMs: number, now: number): void {
  fs.mkdirSync(path.dirname(store.eventsPath), { recursive: true });
  if (events.length > 0) {
    fs.appendFileSync(store.eventsPath, events.map(event => JSON.stringify(event)).join('\n') + '\n');
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
  return foldIncidents(readEvents(store.eventsPath));
}

export function acknowledge(store: IncidentStore, incidentId: string, now = Date.now()): string | null {
  return transition(store, incidentId, now, incident => {
    if (incident.status !== 'open') return `incident ${incidentId} is ${incident.status}, not open`;
    return {
      type: 'acknowledged',
      status: 'acknowledged',
    };
  });
}

export function markFixing(store: IncidentStore, incidentId: string, pr: string, now = Date.now()): string | null {
  if (!pr) return 'a PR link is required';
  return transition(store, incidentId, now, incident => {
    if (incident.status !== 'open' && incident.status !== 'acknowledged') {
      return `incident ${incidentId} is ${incident.status}`;
    }
    return { type: 'fixing', status: 'fixing', pr };
  });
}

export function recordRootCause(store: IncidentStore, incidentId: string, rootCause: string, now = Date.now()): string | null {
  if (!rootCause.trim()) return 'a root cause is required';
  return transition(store, incidentId, now, () => ({
    type: 'root-cause',
    status: 'open',
    rootCause: rootCause.trim(),
  }));
}

function transition(
  store: IncidentStore,
  id: string,
  now: number,
  build: (incident: Incident) => { type: IncidentEvent['type']; status: IncidentStatus; pr?: string; rootCause?: string } | string,
): string | null {
  const incidents = loadIncidents(store);
  const incident = incidents.find(item => item.id === id);
  if (!incident) return `no incident ${id}`;
  const next = build(incident);
  if (typeof next === 'string') return next;
  const event: IncidentEvent = {
    ts: now,
    type: next.type,
    incidentId: incident.id,
    checkId: incident.checkId,
    key: incident.key,
    severity: incident.severity,
    title: incident.title,
    status: next.type === 'root-cause' ? incident.status : next.status,
    pr: next.pr ?? incident.pr,
    rootCause: next.rootCause ?? incident.rootCause,
    episodeOpenedAt: incident.episodeOpenedAt,
  };
  const folded = foldIncidents([...readEvents(store.eventsPath), event]);
  writeIncidents(store, [event], folded, 0, now);
  return null;
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

function incidentFrom(event: IncidentEvent, ts: number): Incident {
  return {
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
    episodeOpenedAt: event.episodeOpenedAt ?? ts,
    clearSince: null,
    resolvedAt: null,
    verifiedAt: null,
  };
}

function base(
  check: InvariantCheck,
  hit: CheckHit,
  id: string,
  now: number,
  type: IncidentEvent['type'],
  status: IncidentStatus,
  count: number,
  episodeOpenedAt: number,
  evidence: Evidence[],
): IncidentEvent {
  return {
    ts: now,
    type,
    incidentId: id,
    checkId: check.id,
    key: hit.key,
    severity: check.severity,
    title: check.title,
    status,
    detail: hit.detail,
    evidence,
    count,
    suggestedFix: check.suggestedFix,
    episodeOpenedAt,
  };
}

export function openP0(incidents: Incident[]): number {
  return incidents.filter(item => item.severity === 'P0' && actionable(item.status)).length;
}

export function countSeverity(incidents: Incident[], severity: Severity): number {
  return incidents.filter(item => item.severity === severity && actionable(item.status)).length;
}
