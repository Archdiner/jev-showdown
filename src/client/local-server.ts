import { spawn, ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

const require = createRequire(import.meta.url);

export interface LocalServer {
  port: number;
  wsUrl: string;
  stop: () => Promise<void>;
}

/**
 * Start the MIT `pokemon-showdown` server for local games.
 * Guest login is enabled with the server's own --no-security flag.
 * A previous config.js in the package is restored on shutdown.
 */
export async function startLocalServer(port: number): Promise<LocalServer> {
  const pkgJson = require.resolve('pokemon-showdown/package.json');
  const root = path.dirname(pkgJson);
  const configPath = path.join(root, 'config', 'config.js');
  const previous = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.join(root, 'config', 'ladders'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config', 'chat-plugins'), { recursive: true });
  fs.mkdirSync(path.join(root, 'logs', 'modlog'), { recursive: true });
  fs.writeFileSync(
    configPath,
    `'use strict';
exports.port = ${port};
exports.bindaddress = '127.0.0.1';
exports.crashguard = true;
exports.watchconfig = false;
exports.repl = false;
`,
  );

  const child = spawn(
    process.execPath,
    [path.join(root, 'pokemon-showdown'), 'start', '--skip-build', '--no-security', String(port)],
    {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PSPORT: String(port) },
    },
  );

  let log = '';
  const logPath = path.join(process.cwd(), 'logs', 'local-showdown.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { flags: 'w' });
  const collect = (chunk: Buffer) => {
    const text = chunk.toString();
    log += text;
    logStream.write(text);
    if (log.length > 20000) log = log.slice(-12000);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  try {
    await waitForPort(port, 60000, () => child.exitCode);
  } catch (err) {
    await stopProcess(child);
    restoreConfig(configPath, previous);
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${reason}\n${log.slice(-2000)}`);
  }

  return {
    port,
    wsUrl: `ws://127.0.0.1:${port}/showdown/websocket`,
    stop: async () => {
      await stopProcess(child);
      logStream.end();
      restoreConfig(configPath, previous);
    },
  };
}

function restoreConfig(configPath: string, previous: Buffer | null): void {
  if (previous) fs.writeFileSync(configPath, previous);
  else if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
}

function waitForPort(port: number, timeoutMs: number, exitCode: () => number | null): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (exitCode() !== null) {
        reject(new Error(`pokemon-showdown exited early (${exitCode()})`));
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`pokemon-showdown did not listen on port ${port}`));
        return;
      }
      const socket = net.connect({ port, host: '127.0.0.1' });
      const done = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        if (ok) resolve();
        else setTimeout(attempt, 250);
      };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    };
    attempt();
  });
}

function stopProcess(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    if (child.exitCode !== null || !child.pid) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      resolve();
    }, 4000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  });
}
