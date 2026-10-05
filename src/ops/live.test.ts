import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocketServer } from 'ws';
import { judge } from './gatekeeper.js';
import { runLive } from './live.js';
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
});
