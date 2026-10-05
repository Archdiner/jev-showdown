import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { beat } from './heartbeat.js';
import { opsPaths } from './paths.js';

const FACILITIES = ['factory', 'gatekeeper', 'live', 'analyst'] as const;

export interface SuperviseOptions {
  once?: boolean;
  local?: boolean;
  server?: string;
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

/** A clean exit is finished. Any other exit restarts, with the delay capped at 30s. */
export function restartPlan(code: number | null, attempt: number): { action: 'done' | 'restart'; delayMs: number } {
  if (code === 0) return { action: 'done', delayMs: 0 };
  const shift = Math.max(0, attempt);
  return { action: 'restart', delayMs: Math.min(30_000, 500 * 2 ** shift) };
}

/** Restarts a facility that exits with an error. A clean --once exit is left alone. */
export function supervise(opts: SuperviseOptions = {}): Promise<void> {
  const paths = opsPaths();
  beat(paths, 'supervisor', 'ok', opts.once ? 'once' : 'running');
  const children = new Set<ChildProcess>();
  const launch = opts.spawnImpl ?? spawn;
  return new Promise(resolve => {
    let pending = FACILITIES.length;
    const done = () => {
      pending -= 1;
      if (pending === 0) {
        beat(paths, 'supervisor', 'stopped', 'exit');
        resolve();
      }
    };
    for (const name of FACILITIES) start(name, 0, done);

    function start(name: (typeof FACILITIES)[number], attempt: number, finish: () => void): void {
      const args = ['tsx', 'src/ops/cli.ts', name];
      if (opts.once) args.push('--once');
      if (name === 'live' && opts.local) args.push('--local');
      if (name === 'live' && opts.server) args.push(`--server=${opts.server}`);
      const child = launch('npx', args, { stdio: 'inherit', env: process.env });
      children.add(child);
      let closed = false;
      child.on('error', () => {
        if (closed) return;
        closed = true;
        process.exitCode = 1;
        children.delete(child);
        beat(paths, 'supervisor', 'error', `${name} failed to start`);
        finish();
      });
      child.on('exit', code => {
        if (closed) return;
        closed = true;
        children.delete(child);
        const plan = restartPlan(code, attempt);
        if (plan.action === 'done') {
          finish();
          return;
        }
        beat(paths, 'supervisor', 'error', `${name} exited ${code}, restarting in ${plan.delayMs}ms`);
        setTimeout(() => start(name, attempt + 1, finish), plan.delayMs);
      });
    }
  });
}

export function stopChildren(children: ChildProcess[]): void {
  for (const child of children) child.kill('SIGTERM');
}
