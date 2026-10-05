import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface DashboardPaths {
  cwd: string;
  host: string;
  port: number;
  fixtureMode: boolean;
  opsDir: string;
  ladderLogDir: string;
  searchLogDir: string;
  graphDb: string;
}

interface FileConfig {
  host?: string;
  port?: number;
  opsDir?: string;
  ladderLogDir?: string;
  searchLogDir?: string;
}

function expand(value: string, cwd: string): string {
  const home = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  return path.resolve(cwd, home);
}

export function resolvePaths(env: NodeJS.ProcessEnv, cwd: string): DashboardPaths {
  const configPath = env.DASHBOARD_CONFIG ? expand(env.DASHBOARD_CONFIG, cwd) : path.join(cwd, 'dashboard.config.json');
  let file: FileConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      file = JSON.parse(fs.readFileSync(configPath, 'utf8')) as FileConfig;
    } catch {
      file = {};
    }
  }
  const fixture = env.DASHBOARD_FIXTURE_DIR ? expand(env.DASHBOARD_FIXTURE_DIR, cwd) : '';
  const graphFor = (opsDir: string) => env.GRAPH_DB
    ? expand(env.GRAPH_DB, cwd)
    : path.resolve(opsDir) === path.resolve(cwd, 'state', 'ops')
      ? path.join(cwd, 'state', 'graph.db')
      : path.join(opsDir, 'graph.db');
  const searchDefault = env.JEV_SEARCH_DIR
    ? path.join(expand(env.JEV_SEARCH_DIR, cwd), env.JEV_SEARCH_DIR.replace(/\\/g, '/').endsWith('live-runs') ? '' : 'live-runs')
    : expand(env.SEARCH_LOG_DIR || file.searchLogDir || '~/jev-search/live-runs', cwd);
  if (fixture) {
    return {
      cwd,
      host: env.DASHBOARD_HOST || file.host || '127.0.0.1',
      port: Number(env.DASHBOARD_PORT || file.port || 8787),
      fixtureMode: true,
      opsDir: path.join(fixture, 'ops'),
      ladderLogDir: path.join(fixture, 'ladder'),
      searchLogDir: path.join(fixture, 'search'),
      graphDb: env.GRAPH_DB ? expand(env.GRAPH_DB, cwd) : path.join(fixture, 'graph.db'),
    };
  }
  const opsDir = expand(env.OPS_DIR || file.opsDir || 'state/ops', cwd);
  return {
    cwd,
    host: env.DASHBOARD_HOST || file.host || '127.0.0.1',
    port: Number(env.DASHBOARD_PORT || file.port || 8787),
    fixtureMode: false,
    opsDir,
    ladderLogDir: expand(env.LADDER_LOG_DIR || file.ladderLogDir || 'logs/ladder', cwd),
    searchLogDir: searchDefault,
    graphDb: graphFor(opsDir),
  };
}
