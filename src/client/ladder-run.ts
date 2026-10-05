import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { toID } from './ids.js';

/** Written by ladder.ts when a batch starts. ops live reads it before a public login. */
export interface LadderRunMeta {
  runId: string;
  pid: number;
  engine?: string;
  username?: string;
  local?: boolean;
  configId?: string;
  configHash?: string;
  gitSha?: string | null;
  configSource?: string;
  configPath?: string | null;
  drainFile?: string;
  globalDrainFile?: string;
}

export function writeLadderRun(dir: string, meta: LadderRunMeta): string {
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, `${meta.runId}.json`);
  fs.writeFileSync(file, JSON.stringify(meta, null, 2));
  return file;
}

export function readLadderRuns(dir: string): LadderRunMeta[] {
  if (!fs.existsSync(dir)) return [];
  const runs: LadderRunMeta[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    let parsed: LadderRunMeta;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as LadderRunMeta;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed.pid !== 'number') continue;
    if (!parsed.runId && !parsed.engine && !parsed.username) continue;
    runs.push(parsed);
  }
  return runs;
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function defaultLadderRunDirs(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string[] {
  const dirs = [path.resolve(cwd, 'live-runs')];
  for (const value of [env.JEV_SEARCH_DIR, env.SEARCH_LOG_DIR]) {
    if (value) dirs.push(expandHome(value, cwd));
  }
  const homeRuns = path.join(os.homedir(), 'jev-search', 'live-runs');
  if (fs.existsSync(homeRuns)) dirs.push(homeRuns);
  return [...new Set(dirs.map(dir => path.resolve(dir)))];
}

/**
 * A public ladder.ts batch on this account must not share the login.
 * A public batch that did not record a username is only a warning.
 * Local ladder batches are ignored.
 */
export function publicAccountConflict(
  username: string,
  runs: LadderRunMeta[],
  alive: (pid: number) => boolean = pidAlive,
): { action: 'refuse' | 'warn'; message: string } | null {
  const ours = toID(username);
  const active = runs.filter(run => run.local !== true && alive(run.pid));
  const same = active.filter(run => run.username && toID(run.username) === ours);
  if (same.length > 0) {
    const list = same.map(run => `pid ${run.pid} (${run.username})`).join(', ');
    return {
      action: 'refuse',
      message: `ops live will not log in as ${username}: ladder.ts is already on that account (${list}). Drain that batch before starting another public session.`,
    };
  }
  const unknown = active.filter(run => !run.username);
  if (unknown.length > 0) {
    const list = unknown.map(run => `pid ${run.pid}`).join(', ');
    return {
      action: 'warn',
      message: `ops live warning: ladder.ts is already on the public ladder (${list}) and that run did not record a username. It may be the same account as ${username}.`,
    };
  }
  return null;
}

function expandHome(value: string, cwd: string): string {
  const home = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  return path.resolve(cwd, home);
}
