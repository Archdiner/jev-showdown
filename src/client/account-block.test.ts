import { WebSocketServer, type WebSocket } from 'ws';
import {
  accountBlockFromIdentity,
  accountBlockFromPopup,
  parseFormatRating,
  parseUpdateUser,
} from './account-block.js';
import { ShowdownClient } from './showdown-client.js';

const PROXY_POPUP = '|popup||html|Your IP (203.0.113.5) is currently locked due to being a proxy. We automatically lock these connections since they are used to spam, hack, or otherwise attack our server. Disable any proxies you are using to connect to PS.\n\n<a href="view-help-request--appeal"><button class="button">Help me with a lock from a proxy</button></a>';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withServer(
  onConnection: (socket: WebSocket) => void,
  run: (port: number, connections: () => number) => Promise<void>,
): Promise<void> {
  let connections = 0;
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve());
    wss.once('error', reject);
  });
  wss.on('connection', socket => {
    connections += 1;
    onConnection(socket);
  });
  const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('test server has no port');
  try {
    await run(address.port, () => connections);
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
  }
}

function clientFor(port: number): ShowdownClient {
  return new ShowdownClient({
    server: `ws://127.0.0.1:${port}/showdown/websocket`,
    username: 'Archinder',
    local: true,
  });
}

describe('account block parsing', () => {
  it('recognizes the proxy lock popup and the ‽ / ! prefixes', () => {
    const proxy = accountBlockFromPopup(PROXY_POPUP.slice('|popup|'.length));
    expect(proxy?.kind).toBe('proxy');
    expect(proxy?.message).toMatch(/203\.0\.113\.5/);
    expect(proxy?.message).toMatch(/no reconnect/i);

    expect(accountBlockFromPopup('You are banned from battling. Your battle ban will expire in a few days.')?.kind).toBe('banned');
    expect(accountBlockFromPopup('You are barred from starting any new games until your battle ban expires.')?.kind).toBe('banned');
    expect(accountBlockFromPopup('You are locked. Your lock will expire in a few days.')?.kind).toBe('locked');
    expect(accountBlockFromPopup('You are namelocked and can\'t have a username.')?.kind).toBe('locked');
    expect(accountBlockFromPopup('You are locked because someone using your IP has spammed/hacked other websites. This usually means either you\'re using a proxy, or you have a virus.')?.kind).toBe('proxy');
    expect(accountBlockFromPopup("Couldn't search: You are already searching for a gen9randombattle battle.")).toBeNull();

    expect(accountBlockFromIdentity('\u203DArchinder')?.kind).toBe('locked');
    expect(accountBlockFromIdentity('!Archinder')?.kind).toBe('muted');
    expect(accountBlockFromIdentity('\u2716Archinder')?.kind).toBe('locked');
    expect(accountBlockFromIdentity(' Archinder')).toBeNull();
    expect(parseUpdateUser('|updateuser|\u203DArchinder|1|1|{}')?.block?.kind).toBe('locked');
    expect(parseUpdateUser('|updateuser| Archinder|1|1|{}')).toMatchObject({ username: 'Archinder', named: true, block: null });
  });

  it('reads the format rating out of a /rank table', () => {
    const table = '|raw|<div class="ladder"><div>User: <strong>Archinder</strong></div><table><tr><td>gen9randombattle</td><td><strong>1488</strong></td><td>3</td><td>1</td><td>4</td></tr></table></div>';
    expect(parseFormatRating(table, 'gen9randombattle')).toBe(1488);
    expect(parseFormatRating('|raw|<div class="ladder"><em>This user has not played any ladder games yet.</em></div>', 'gen9randombattle')).toBeNull();
    expect(parseFormatRating('|request|{}', 'gen9randombattle')).toBeUndefined();
  });
});

describe('showdown client lock handling', () => {
  it('does not throw from send() when the socket is down', () => {
    const client = clientFor(9);
    expect(() => client.send('|/ping')).not.toThrow();
    expect(client.send('|/ping')).toBe(false);
    expect(client.isReady()).toBe(false);
    expect(client.isBlocked()).toBe(false);
  });

  it('exits on the proxy popup and the ‽ name, and does not reconnect after close 1000', async () => {
    await withServer(socket => {
      socket.on('message', data => {
        if (!data.toString().includes('/trn')) return;
        socket.send('|updateuser|\u203DArchinder|1|1|{}');
        socket.send(PROXY_POPUP);
        socket.close(1000);
      });
      socket.send('|challstr|4|abc');
    }, async (port, connections) => {
      const client = clientFor(port);
      await expect(client.connect()).rejects.toThrow(/no reconnect/);
      expect(client.isBlocked()).toBe(true);
      expect(client.isReady()).toBe(false);
      expect(client.send('|/search gen9randombattle')).toBe(false);
      await delay(1800);
      expect(connections()).toBe(1);
      client.disconnect();
    });
  }, 10000);

  it('treats a lock popup followed by a normal close as non-retriable', async () => {
    await withServer(socket => {
      socket.on('message', data => {
        if (!data.toString().includes('/trn')) return;
        socket.send(PROXY_POPUP);
        socket.send('|updateuser| Archinder|1|1|{}');
        socket.close(1000);
      });
      socket.send('|challstr|4|abc');
    }, async (port, connections) => {
      const client = clientFor(port);
      await expect(client.connect()).rejects.toThrow(/locked this IP as a proxy/);
      await delay(1800);
      expect(connections()).toBe(1);
      expect(client.isReady()).toBe(false);
      client.disconnect();
    });
  }, 10000);

  it('treats a ! name as muted and does not reconnect', async () => {
    await withServer(socket => {
      socket.on('message', data => {
        if (!data.toString().includes('/trn')) return;
        socket.send('|updateuser|!Archinder|1|1|{}');
        socket.close(1000);
      });
      socket.send('|challstr|4|abc');
    }, async (port, connections) => {
      const client = clientFor(port);
      await expect(client.connect()).rejects.toThrow(/! prefix/);
      await delay(1800);
      expect(connections()).toBe(1);
      client.disconnect();
    });
  }, 10000);

  it('still reconnects after a normal close', async () => {
    const sockets: WebSocket[] = [];
    await withServer(socket => {
      sockets.push(socket);
      socket.on('message', data => {
        if (data.toString().includes('/trn')) socket.send('|updateuser| Archinder|1|1|{}');
      });
      socket.send('|challstr|4|abc');
    }, async (port, connections) => {
      const client = clientFor(port);
      await client.connect();
      expect(client.isReady()).toBe(true);
      expect(client.send('|/ping')).toBe(true);
      sockets[0].close(1000);
      await delay(1800);
      expect(connections()).toBe(2);
      expect(client.isReady()).toBe(true);
      client.disconnect();
      await delay(1500);
      expect(connections()).toBe(2);
    });
  }, 10000);
});
