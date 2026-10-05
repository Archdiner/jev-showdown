import { WebSocketServer, type WebSocket } from 'ws';
import { ShowdownClient } from './showdown-client.js';
import { STALE_BATTLE_MS, battleTimestamp, isStaleBattle } from './stale-room.js';

describe('stale battle timestamps', () => {
  it('reads |t:| and treats a missing clock as live', () => {
    const now = 1_700_000_000_000;
    expect(battleTimestamp('|t:|1700000000')).toBe(1700000000);
    expect(battleTimestamp('|turn|2')).toBeNull();
    expect(isStaleBattle(null, now)).toBe(false);
    expect(isStaleBattle(Math.floor(now / 1000) - 60, now)).toBe(false);
    expect(isStaleBattle(Math.floor((now - STALE_BATTLE_MS) / 1000) - 60, now)).toBe(true);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withServer(
  onConnection: (socket: WebSocket) => void,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve());
    wss.once('error', reject);
  });
  wss.on('connection', onConnection);
  const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('test server has no port');
  try {
    await run(address.port);
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
  }
}

function history(room: string, unix: number | null): string {
  const lines = [`>${room}`, '|init|battle', '|player|p1|BotAlpha'];
  if (unix !== null) lines.push(`|t:|${unix}`);
  lines.push('|request|{"rqid":2}');
  return lines.join('\n');
}

describe('stale battle rooms', () => {
  it('forfeits a room with no timestamp newer than 70 minutes and does not count its lines', async () => {
    const room = 'battle-gen9randombattle-ghost';
    const old = Math.floor(Date.now() / 1000) - 80 * 60;
    const lines: string[] = [];
    const sent: string[] = [];
    let stale: string | null = null;
    await withServer(socket => {
      socket.on('message', data => {
        const text = data.toString();
        sent.push(text);
        if (!text.includes('/trn')) return;
        socket.send('|updateuser| BotAlpha|1|1|{}');
        socket.send(history(room, old));
      });
      socket.send('|challstr|4|abc');
    }, async port => {
      const client = new ShowdownClient({
        server: `ws://127.0.0.1:${port}/showdown/websocket`,
        username: 'BotAlpha',
        local: true,
      });
      client.on('line', (id: string, line: string) => {
        if (id.startsWith('battle-')) lines.push(`${id} ${line}`);
      });
      client.on('staleRoom', (id: string) => {
        stale = id;
      });
      await client.connect();
      await delay(40);
      expect(stale).toBe(room);
      expect(lines).toEqual([]);
      expect(sent.some(message => message === `${room}|/forfeit`)).toBe(true);
      client.disconnect();
    });
  });

  it('keeps a live room, including one with an old timestamp and a recent one', async () => {
    const room = 'battle-gen9randombattle-live';
    const now = Math.floor(Date.now() / 1000);
    const lines: string[] = [];
    const sent: string[] = [];
    await withServer(socket => {
      socket.on('message', data => {
        const text = data.toString();
        sent.push(text);
        if (!text.includes('/trn')) return;
        socket.send('|updateuser| BotAlpha|1|1|{}');
        socket.send([
          `>${room}`,
          '|init|battle',
          `|t:|${now - 3 * 60 * 60}`,
          `|t:|${now}`,
          '|request|{"rqid":2}',
        ].join('\n'));
      });
      socket.send('|challstr|4|abc');
    }, async port => {
      const client = new ShowdownClient({
        server: `ws://127.0.0.1:${port}/showdown/websocket`,
        username: 'BotAlpha',
        local: true,
      });
      client.on('line', (id: string, line: string) => {
        if (id === room) lines.push(line);
      });
      await client.connect();
      await delay(40);
      expect(lines).toContain('|request|{"rqid":2}');
      expect(sent.some(message => message.includes('/forfeit'))).toBe(false);
      client.disconnect();
    });
  });

  it('treats a room with no |t:| as live and does not rejoin a forfeited ghost', async () => {
    const ghost = 'battle-gen9randombattle-ghost';
    const live = 'battle-gen9randombattle-local';
    const old = Math.floor(Date.now() / 1000) - 80 * 60;
    const lines: string[] = [];
    const sent: string[] = [];
    const sockets: WebSocket[] = [];
    await withServer(socket => {
      sockets.push(socket);
      socket.on('message', data => {
        const text = data.toString();
        sent.push(text);
        if (!text.includes('/trn')) return;
        socket.send('|updateuser| BotAlpha|1|1|{}');
        if (sockets.length === 1) {
          socket.send(history(ghost, old));
          socket.send(history(live, null));
        }
      });
      socket.send('|challstr|4|abc');
    }, async port => {
      const client = new ShowdownClient({
        server: `ws://127.0.0.1:${port}/showdown/websocket`,
        username: 'BotAlpha',
        local: true,
      });
      client.on('line', (id: string, line: string) => {
        if (id.startsWith('battle-')) lines.push(`${id} ${line}`);
      });
      await client.connect();
      await delay(40);
      expect(lines.some(line => line.startsWith(live))).toBe(true);
      expect(lines.some(line => line.startsWith(ghost))).toBe(false);
      sockets[0].close(1000);
      await delay(1500);
      const joins = sent.filter(message => message.includes('/join'));
      expect(joins.some(message => message.includes(ghost))).toBe(false);
      expect(joins.some(message => message.includes(live))).toBe(true);
      client.disconnect();
    });
  }, 10000);
});
