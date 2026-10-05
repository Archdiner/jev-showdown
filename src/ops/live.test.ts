import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocketServer } from 'ws';
import { writeLadderRun } from '../client/ladder-run.js';
import { judge } from './gatekeeper.js';
import { PUBLIC_WEBSOCKET, resolveLiveIdentity, runLive } from './live.js';
import { openDb } from './db.js';
import { opsPaths } from './paths.js';

function tempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-live-'));
  const priorGraph = process.env.GRAPH_DB;
  const priorOps = process.env.OPS_DIR;
  delete process.env.GRAPH_DB;
  delete process.env.OPS_DIR;
  const paths = opsPaths(root);
  if (priorGraph === undefined) delete process.env.GRAPH_DB;
  else process.env.GRAPH_DB = priorGraph;
  if (priorOps === undefined) delete process.env.OPS_DIR;
  else process.env.OPS_DIR = priorOps;
  return paths;
}

async function rejectingServer() {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => wss.once('listening', () => resolve()));
  const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  let searches = 0;
  wss.on('connection', socket => {
    socket.send('|challstr|local\n');
    socket.on('message', data => {
      const text = data.toString();
      const trn = text.match(/\/trn ([^,|]+)/);
      if (trn) socket.send(`|updateuser| ${trn[1].trim()}|1|1\n`);
      if (text.includes('/search')) {
        searches += 1;
        socket.send('|popup|Due to high load, you are limited to 5 games at the same time.\n');
      }
    });
  });
  return {
    searches: () => searches,
    url: `ws://127.0.0.1:${address.port}/showdown/websocket`,
    close: () => new Promise<void>(resolve => wss.close(() => resolve())),
  };
}

describe('live search slots', () => {
  test('a rejected search does not consume the only slot', async () => {
    const paths = tempPaths();
    judge(paths, {
      configPath: 'configs/champion.yaml',
      action: 'champion',
      wins: 250,
      losses: 100,
      invalid: 0,
      crashes: 0,
      diagnostics: { passed: 1, failed: 0, total: 1 },
    });
    const db = openDb(paths);
    expect(db.getNodesByType('Champion').length).toBeGreaterThan(0);
    db.close();
    const server = await rejectingServer();
    try {
      await expect(runLive({
        paths,
        local: true,
        server: server.url,
        games: 1,
        runners: 1,
        concurrency: 1,
        username: 'localbot',
        once: true,
        timeoutMs: 4_500,
      })).rejects.toThrow(/timed out after 0 games/);
      expect(server.searches()).toBeGreaterThanOrEqual(2);
    } finally {
      await server.close();
    }
  }, 20_000);

  test('an open-ended local session ends a window instead of throwing', async () => {
    const paths = tempPaths();
    judge(paths, {
      configPath: 'configs/champion.yaml',
      action: 'champion',
      wins: 250,
      losses: 100,
      invalid: 0,
      crashes: 0,
      diagnostics: { passed: 1, failed: 0, total: 1 },
    });
    const server = await rejectingServer();
    try {
      const summary = await runLive({
        paths,
        local: true,
        server: server.url,
        username: 'localbot',
        timeoutMs: 400,
      });
      expect(summary.skipped).toBe('window');
      expect(summary.games).toBe(0);
    } finally {
      await server.close();
    }
  }, 20_000);
});

describe('local live target', () => {
  const env = {
    SHOWDOWN_USERNAME: 'RealAccount',
    SHOWDOWN_PASSWORD: 'secret',
    SHOWDOWN_LOGIN_URL: 'https://play.pokemonshowdown.com/action.php',
  };

  test('a local session ignores the public username, password, and login server', () => {
    expect(resolveLiveIdentity({ local: true }, env)).toMatchObject({
      local: true,
      username: 'localbot',
      password: '',
      server: null,
      port: 0,
    });
    expect(resolveLiveIdentity({ local: true }, env).loginServer).not.toContain('pokemonshowdown.com');
    expect(resolveLiveIdentity({
      local: true,
      username: 'Alpha',
      port: 8010,
    }, env)).toMatchObject({ username: 'Alpha', password: '', server: null, port: 8010 });
    expect(resolveLiveIdentity({
      server: 'ws://127.0.0.1:8010/showdown/websocket',
    }, env)).toMatchObject({
      local: true,
      username: 'localbot',
      password: '',
      server: 'ws://127.0.0.1:8010/showdown/websocket',
    });
    expect(resolveLiveIdentity({}, env)).toMatchObject({
      local: false,
      username: 'RealAccount',
      password: 'secret',
      server: PUBLIC_WEBSOCKET,
      loginServer: env.SHOWDOWN_LOGIN_URL,
    });
    expect(() => resolveLiveIdentity({
      local: true,
      server: PUBLIC_WEBSOCKET,
    }, env)).toThrow(/loopback/);
  });

  test('--local starts a free-port server and never calls the public login server', async () => {
    const previous = {
      user: process.env.SHOWDOWN_USERNAME,
      pass: process.env.SHOWDOWN_PASSWORD,
      login: process.env.SHOWDOWN_LOGIN_URL,
    };
    process.env.SHOWDOWN_USERNAME = 'RealAccount';
    process.env.SHOWDOWN_PASSWORD = 'secret';
    process.env.SHOWDOWN_LOGIN_URL = 'https://play.pokemonshowdown.com/action.php';
    const fetches: string[] = [];
    const original = global.fetch;
    global.fetch = (async (input: string | URL) => {
      fetches.push(String(input));
      throw new Error(`unexpected fetch ${String(input)}`);
    }) as typeof fetch;
    const paths = tempPaths();
    judge(paths, {
      configPath: 'configs/champion.yaml',
      action: 'champion',
      wins: 250,
      losses: 100,
      invalid: 0,
      crashes: 0,
      diagnostics: { passed: 1, failed: 0, total: 1 },
    });
    try {
      const summary = await runLive({
        paths,
        local: true,
        games: 0,
        once: true,
        timeoutMs: 8_000,
      });
      expect(summary.games).toBe(0);
      expect(fetches.filter(url => url.includes('pokemonshowdown.com'))).toEqual([]);
      const beats = fs.readFileSync(paths.heartbeats, 'utf8');
      expect(beats).toContain('logged in localbot');
      expect(beats).not.toContain('RealAccount');
      expect(beats).not.toContain(':8000');
      expect(beats).toMatch(/local ws:\/\/127\.0\.0\.1:\d+\/showdown\/websocket user localbot/);
    } finally {
      global.fetch = original;
      if (previous.user === undefined) delete process.env.SHOWDOWN_USERNAME;
      else process.env.SHOWDOWN_USERNAME = previous.user;
      if (previous.pass === undefined) delete process.env.SHOWDOWN_PASSWORD;
      else process.env.SHOWDOWN_PASSWORD = previous.pass;
      if (previous.login === undefined) delete process.env.SHOWDOWN_LOGIN_URL;
      else process.env.SHOWDOWN_LOGIN_URL = previous.login;
    }
  }, 20_000);

  test('public live refuses the account an active ladder.ts batch already holds', async () => {
    const paths = tempPaths();
    judge(paths, {
      configPath: 'configs/champion.yaml',
      action: 'champion',
      wins: 250,
      losses: 100,
      invalid: 0,
      crashes: 0,
      diagnostics: { passed: 1, failed: 0, total: 1 },
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-live-lock-'));
    writeLadderRun(dir, {
      runId: 'active',
      pid: process.pid,
      username: 'RealAccount',
      local: false,
      engine: 'search',
    });
    const fetches: string[] = [];
    const original = global.fetch;
    global.fetch = (async (input: string | URL) => {
      fetches.push(String(input));
      throw new Error(`unexpected fetch ${String(input)}`);
    }) as typeof fetch;
    try {
      await expect(runLive({
        paths,
        username: 'RealAccount',
        password: 'secret',
        games: 1,
        once: true,
        ladderRunDirs: [dir],
        server: PUBLIC_WEBSOCKET,
        timeoutMs: 2_000,
      })).rejects.toThrow(/will not log in as RealAccount/);
      expect(fetches).toEqual([]);
    } finally {
      global.fetch = original;
    }
  });
});
