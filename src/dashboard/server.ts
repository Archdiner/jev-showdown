import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { configPanels, filterGames, reportGames } from './games.js';
import { combineCalibrations } from '../client/prediction.js';
import type { DashboardPaths } from './paths.js';
import { buildSnapshot, type Snapshot } from './snapshot.js';

function publicDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
}

function slices(snapshot: Snapshot, query: URLSearchParams) {
  const base = { apiVersion: snapshot.apiVersion, generatedAt: snapshot.generatedAt, fixtureMode: snapshot.fixtureMode };
  return {
    '/api/snapshot': snapshot,
    '/api/status': { ...base, ops: snapshot.ops, sources: snapshot.sources, gaps: snapshot.gaps },
    '/api/runs': { ...base, runs: snapshot.runs },
    '/api/games': { ...base, games: gamesPayload(snapshot, query) },
    '/api/metrics': { ...base, metrics: { ...snapshot.metrics, variants: snapshot.metrics.variants, configs: configPanels(filterGames(snapshot.games.recent, { endReason: query.get('endReason'), band: query.get('band') })), report: reportGames(filterGames(snapshot.games.recent, { endReason: query.get('endReason'), band: query.get('band') })) } },
    '/api/agents': { ...base, agents: snapshot.agents },
  };
}

function gamesPayload(snapshot: Snapshot, query: URLSearchParams) {
  const endReason = query.get('endReason');
  const band = query.get('band');
  const filtered = filterGames(snapshot.games.recent, { endReason, band });
  return {
    ...snapshot.games,
    configs: configPanels(filtered),
    filter: { endReason: endReason || 'any', band: band || 'any' },
    filtered,
    filteredReport: reportGames(filtered),
    calibration: snapshot.calibration,
    filteredCalibration: combineCalibrations(filtered.map(game => game.calibration)),
  };
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function startDashboard(paths: DashboardPaths): Promise<{ url: string; close: () => Promise<void> }> {
  const clients = new Set<http.ServerResponse>();
  let last = '';
  let timer: NodeJS.Timeout | null = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/app.js')) {
      const file = pathname === '/app.js' ? 'app.js' : 'index.html';
      const type = file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
      const full = path.join(publicDir(), file);
      if (!fs.existsSync(full)) return send(res, 404, { error: 'missing page' });
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(full));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      if (last) res.write(`event: snapshot\ndata: ${last}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && pathname.startsWith('/api/')) {
      const snapshot = buildSnapshot(paths);
      const routes = slices(snapshot, url.searchParams);
      if (!(pathname in routes)) return send(res, 404, { error: 'unknown endpoint' });
      return send(res, 200, routes[pathname as keyof typeof routes]);
    }
    send(res, 404, { error: 'not found' });
  });

  const publish = () => {
    last = JSON.stringify(buildSnapshot(paths));
    for (const client of clients) client.write(`event: snapshot\ndata: ${last}\n\n`);
  };

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(paths.port, paths.host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : paths.port;
      timer = setInterval(publish, 2000);
      publish();
      resolve({
        url: `http://${paths.host}:${port}`,
        close: () => new Promise(done => {
          if (timer) clearInterval(timer);
          for (const client of clients) client.end();
          server.close(() => done());
        }),
      });
    });
  });
}
