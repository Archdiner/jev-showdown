import { WebSocketServer, type WebSocket } from 'ws';
import { ShowdownClient } from './showdown-client.js';
import { battleInitRooms, roomLines } from './protocol-frames.js';

describe('batched room frames', () => {
  it('reads each battle room id from its own |init|battle, not from search order', () => {
    const payload = [
      '>battle-gen9randombattle-2692982986',
      '|init|battle',
      '|player|p2|lilyfith|2|1400',
      '|request|{"rqid":2}',
      '>battle-gen9randombattle-2692982991',
      '|init|battle',
      '|player|p2|michaboo|2|1300',
      '|request|{"rqid":4}',
    ].join('\n');
    expect(battleInitRooms(payload)).toEqual([
      'battle-gen9randombattle-2692982986',
      'battle-gen9randombattle-2692982991',
    ]);
    expect(battleInitRooms('>battle-gen9randombattle-1\n|init|battle|battle-gen9randombattle-2692982986')).toEqual([
      'battle-gen9randombattle-2692982986',
    ]);
  });

  it('keeps each battle\'s lines on that battle', () => {
    const payload = [
      '>battle-gen9randombattle-7005',
      '|request|{"rqid":2}',
      '>battle-gen9randombattle-7020',
      '|init|battle',
      '|request|{"rqid":5}',
    ].join('\n');
    expect(roomLines(payload)).toEqual([
      { roomid: 'battle-gen9randombattle-7005', line: '|request|{"rqid":2}' },
      { roomid: 'battle-gen9randombattle-7020', line: '|init|battle' },
      { roomid: 'battle-gen9randombattle-7020', line: '|request|{"rqid":5}' },
    ]);
  });

  it('unwraps a sockjs array and ignores heartbeats', () => {
    const frame = `a${JSON.stringify([
      '>battle-gen9randombattle-7005\n|request|{"rqid":2}',
      '>battle-gen9randombattle-7020\n|inactive|Bot has 10 seconds left.',
    ])}`;
    expect(roomLines('h')).toEqual([]);
    expect(roomLines(frame)).toEqual([
      { roomid: 'battle-gen9randombattle-7005', line: '|request|{"rqid":2}' },
      { roomid: 'battle-gen9randombattle-7020', line: '|inactive|Bot has 10 seconds left.' },
    ]);
  });

  it('delivers a two-battle websocket frame to the right rooms', async () => {
    const lines: Array<{ roomid: string; line: string }> = [];
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', () => resolve());
      wss.once('error', reject);
    });
    wss.on('connection', (socket: WebSocket) => {
      socket.on('message', data => {
        if (!data.toString().includes('/trn')) return;
        socket.send('|updateuser| BotAlpha|1|1|{}');
        socket.send([
          '>battle-gen9randombattle-7005',
          '|request|{"rqid":2}',
          '>battle-gen9randombattle-7020',
          '|init|battle',
          '|player|p1|BotAlpha',
          '|request|{"rqid":5}',
        ].join('\n'));
      });
      socket.send('|challstr|4|abc');
    });
    const address = wss.address();
    if (!address || typeof address === 'string') throw new Error('test server has no port');
    const client = new ShowdownClient({
      server: `ws://127.0.0.1:${address.port}/showdown/websocket`,
      username: 'BotAlpha',
      local: true,
    });
    client.on('line', (roomid: string, line: string) => {
      if (roomid.startsWith('battle-')) lines.push({ roomid, line });
    });
    try {
      await client.connect();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(lines.filter(row => row.roomid === 'battle-gen9randombattle-7005').map(row => row.line))
        .toEqual(['|request|{"rqid":2}']);
      expect(lines.filter(row => row.roomid === 'battle-gen9randombattle-7020').map(row => row.line))
        .toEqual(['|init|battle', '|player|p1|BotAlpha', '|request|{"rqid":5}']);
    } finally {
      client.disconnect();
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
    }
  });
});
