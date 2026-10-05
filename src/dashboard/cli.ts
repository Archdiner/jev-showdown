#!/usr/bin/env node
import { resolvePaths } from './paths.js';
import { startDashboard } from './server.js';

const env = { ...process.env };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--port') env.DASHBOARD_PORT = args[++i];
  else if (arg === '--host') env.DASHBOARD_HOST = args[++i];
  else if (arg === '--fixture') env.DASHBOARD_FIXTURE_DIR = args[++i];
  else if (arg === '--help') {
    console.log('Usage: npm run dashboard -- [--port 8787] [--host 127.0.0.1] [--fixture dir]');
    process.exit(0);
  }
}

const paths = resolvePaths(env, process.cwd());
startDashboard(paths).then(server => {
  console.log(`ops dashboard ${server.url}`);
}).catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
