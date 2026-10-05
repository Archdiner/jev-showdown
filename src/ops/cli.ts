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

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function opt(name: string): string | undefined {
  const hit = process.argv.find(arg => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function num(name: string): number | undefined {
  const value = opt(name);
  return value === undefined ? undefined : Number(value);
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
    const summary = await runLive({
      paths,
      once: flag('once'),
      local: flag('local'),
      server: opt('server'),
      games: num('games'),
      runners: num('runners'),
      concurrency: num('concurrency'),
      exploreRate: num('explore'),
      maxLosses: num('max-losses'),
      maxDrop: num('max-drop'),
      window: num('window'),
    });
    console.log(JSON.stringify(summary));
    return;
  }
  if (command === 'analyst') {
    await runAnalyst(paths, { once: flag('once'), replay: opt('replay') });
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
  if (command === 'supervise' || command === 'supervisor') {
    await supervise({ once: flag('once'), local: flag('local'), server: opt('server') });
    return;
  }
  if (command === 'dry-run') {
    await dryRun();
    return;
  }
  console.log(`usage: npm run ops -- factory|gatekeeper|live|analyst|status|report|supervise|dry-run
  factory, gatekeeper, live, analyst, supervise accept --once
  live --local uses the local server instead of the ladder
  live --runners=N --concurrency=K
  gatekeeper --bootstrap checks configs/champion.yaml and does not label it without paired games
  report --daily is the plain-English day summary
Facilities share the graph and the JSONL logs. They do not import each other.`);
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
