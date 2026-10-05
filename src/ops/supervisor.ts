import { spawn, type ChildProcess } from 'child_process';
import { beat } from './heartbeat.js';
import { opsPaths } from './paths.js';

const FACILITIES = ['factory', 'gatekeeper', 'live', 'analyst'] as const;

export interface SuperviseOptions {
  once?: boolean;
  local?: boolean;
  server?: string;
}

/** Restarts a facility that exits with an error. A clean --once exit is left alone. */
export function supervise(opts: SuperviseOptions = {}): Promise<void> {
  const paths = opsPaths();
  beat(paths, 'supervisor', 'ok', opts.once ? 'once' : 'running');
  const children = new Set<ChildProcess>();
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
      const child = spawn('npx', args, { stdio: 'inherit', env: process.env });
      children.add(child);
      child.on('exit', code => {
        children.delete(child);
        if (code === 0 || attempt >= 2) {
          finish();
          return;
        }
        beat(paths, 'supervisor', 'error', `${name} exited ${code}, restarting`);
        setTimeout(() => start(name, attempt + 1, finish), 500);
      });
    }
  });
}

export function stopChildren(children: ChildProcess[]): void {
  for (const child of children) child.kill('SIGTERM');
}
