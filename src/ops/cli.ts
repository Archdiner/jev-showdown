#!/usr/bin/env node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAnalyst } from './analyst.js';
import { runFactory } from './factory.js';
import { runGatekeeper } from './gatekeeper.js';
import { runLive } from './live.js';
import { opsPaths } from './paths.js';
import { dailyReport } from './report.js';
import { statusReport } from './status.js';
import { supervise } from './supervisor.js';
import { startLocalServer } from './local-server.js';
import { OPS_USAGE, opsFlag, opsNumber, opsValue } from './args.js';
import { acknowledge, incidentStore, markFixing, recordRootCause } from './sentinel/incidents.js';
import { layoutFromEnv, renderScorecard, runSentinel } from './sentinel/run.js';
import { defaultGameLogs, runRepair } from './sentinel.js';

function flag(name: string): boolean {
  return opsFlag(process.argv, name);
}

function opt(name: string): string | undefined {
  return opsValue(process.argv, name);
}

function num(name: string): number | undefined {
  return opsNumber(process.argv, name);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const paths = opsPaths();
  if (command === 'factory') {
    await runFactory(paths, { once: flag('once') });
    return;
  }
  if (command === 'gatekeeper') {
    await runGatekeeper(paths, { once: flag('once'), bootstrap: flag('bootstrap'), pairs: num('pairs') });
    return;
  }
  if (command === 'live') {
    for (;;) {
      const summary = await runLive({
        paths,
        once: flag('once'),
        local: flag('local'),
        server: opt('server'),
        port: num('port'),
        username: opt('username'),
        games: num('games'),
        runners: num('runners'),
        concurrency: num('concurrency'),
        exploreRate: num('explore'),
        maxLosses: num('max-losses'),
        maxDrop: num('max-drop'),
        window: num('window'),
      });
      console.log(JSON.stringify(summary));
      if (summary.skipped !== 'window' || flag('once')) return;
    }
  }
  if (command === 'analyst') {
    const extra = [opt('ladder-dir'), opt('live-runs')].filter((dir): dir is string => Boolean(dir));
    await runAnalyst(paths, { once: flag('once'), replay: opt('replay'), ladderDirs: extra.length ? extra : undefined });
    return;
  }
  if (command === 'sentinel') {
    const layout = layoutFromEnv();
    const store = incidentStore(layout.opsDir);
    const ack = opt('ack');
    const fixing = opt('fixing');
    const cause = opt('root-cause');
    if (ack || fixing || cause) {
      const error = ack
        ? acknowledge(store, ack)
        : fixing
          ? markFixing(store, fixing, opt('pr') ?? '')
          : recordRootCause(store, cause ?? '', opt('text') ?? '');
      if (error) throw new Error(error);
      console.log(ack ? `acknowledged ${ack}` : fixing ? `fixing ${fixing}` : `root cause recorded for ${cause}`);
      return;
    }
    const code = await runSentinel(layout, {
      once: flag('once'),
      json: flag('json'),
      soakMs: num('soak-ms'),
      intervalMs: num('interval-ms'),
    });
    if (flag('once')) process.exitCode = code;
    return;
  }
  if (command === 'scorecard') {
    console.log(renderScorecard(layoutFromEnv(), { since: opt('since'), markdown: flag('md') }));
    return;
  }
  if (command === 'status') {
    console.log(statusReport(paths));
    return;
  }
  if (command === 'report') {
    console.log(dailyReport(paths));
    return;
  }
  if (command === 'repair-games') {
    const listed = [opt('games'), opt('live')].filter((file): file is string => Boolean(file));
    const files = (listed.length > 0 ? listed : defaultGameLogs()).filter(file => fs.existsSync(file));
    console.log(runRepair(files));
    return;
  }
  if (command === 'supervise' || command === 'supervisor') {
    await supervise({ once: flag('once'), local: flag('local'), server: opt('server') });
    if (process.exitCode) process.exit(process.exitCode);
    return;
  }
  if (command === 'dry-run') {
    await dryRun();
    return;
  }
  console.log(OPS_USAGE);
}

async function dryRun(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-ops-'));
  process.env.OPS_DIR = root;
  process.env.GRAPH_DB = path.join(root, 'graph.db');
  const paths = opsPaths(root);
  const { bootstrapChampion } = await import('./gatekeeper.js');
  const verdict = bootstrapChampion(paths);
  console.log(verdict.reason);
  const server = await startLocalServer(0);
  try {
    if (!verdict.labeled) {
      console.log('Live did not search: the gatekeeper did not approve a config.');
      console.log(statusReport(paths));
      console.log(dailyReport(paths));
      return;
    }
    const summary = await runLive({
      paths,
      local: true,
      server: server.url,
      games: 1,
      runners: 1,
      concurrency: 1,
      username: 'localbot',
      once: true,
    });
    console.log(JSON.stringify(summary));
    await runAnalyst(paths, { once: true });
    console.log(statusReport(paths));
    console.log(dailyReport(paths));
  } finally {
    await server.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
