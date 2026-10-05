import { appendJsonl, readJsonl, type OpsPaths } from './paths.js';

export type FacilityName = 'factory' | 'gatekeeper' | 'live' | 'analyst' | 'supervisor' | 'sentinel';

export interface Heartbeat {
  facility: FacilityName;
  pid: number;
  ts: number;
  status: 'ok' | 'error' | 'stopped';
  detail?: string;
}

export function beat(paths: OpsPaths, facility: FacilityName, status: Heartbeat['status'], detail?: string): void {
  appendJsonl(paths.heartbeats, { facility, pid: process.pid, ts: Date.now(), status, detail } satisfies Heartbeat);
}

export function latestHeartbeats(paths: OpsPaths): Record<string, Heartbeat> {
  const out: Record<string, Heartbeat> = {};
  for (const row of readJsonl<Heartbeat>(paths.heartbeats)) out[row.facility] = row;
  return out;
}
