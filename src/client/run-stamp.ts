import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Batch name from `LIVE_BATCH_LABEL`, or from the file `run-live.sh` is writing to. */
export function readBatchLabel(env: NodeJS.ProcessEnv = process.env): string | null {
  const named = env.LIVE_BATCH_LABEL?.trim();
  if (named) return named;
  return labelFromStdout();
}

export function currentHostname(): string {
  return os.hostname();
}

function labelFromStdout(): string | null {
  try {
    const target = fs.readlinkSync('/proc/self/fd/1');
    if (!target || /^(pipe|socket):/.test(target) || target.startsWith('/dev/')) return null;
    const base = path.basename(target);
    if (!/\.(log|txt|jsonl)$/i.test(base)) return null;
    return base.replace(/\.(log|txt|jsonl)$/i, '') || null;
  } catch {
    return null;
  }
}
