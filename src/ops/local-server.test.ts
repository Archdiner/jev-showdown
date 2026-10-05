import { WebSocket } from 'ws';
import { createLocalServerRun, localRoomName, startLocalServer } from './local-server.js';

function firstRoom(url: string): Promise<string> {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('local server did not open a room'));
    }, 30_000);
    ws.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    ws.on('message', data => {
      const match = data.toString().match(/>(battle-local-\S+)/);
      if (!match) return;
      clearTimeout(timer);
      ws.close();
      resolve(match[1]);
    });
    ws.on('open', () => {
      ws.send('/trn localbot,0,\n');
      ws.send('/search gen9randombattle\n');
    });
  });
}

describe('ops local server room ids', () => {
  test('each server life uses its own room prefix', () => {
    const first = createLocalServerRun();
    const second = createLocalServerRun();
    expect(first).not.toBe(second);
    expect(localRoomName(first, 1)).toBe(`battle-local-${first}-1`);
    expect(localRoomName('server-b', 1)).toBe('battle-local-serverb-1');
    expect(localRoomName(first, 1)).not.toBe('battle-local-1');
    expect(localRoomName(second, 1)).not.toBe(localRoomName(first, 1));
  });

  test('a restarted server does not reopen battle-local-1', async () => {
    const first = await startLocalServer(0);
    const second = await startLocalServer(0);
    try {
      const [roomA, roomB] = await Promise.all([firstRoom(first.url), firstRoom(second.url)]);
      expect(roomA).toBe(localRoomName(first.runId, 1));
      expect(roomB).toBe(localRoomName(second.runId, 1));
      expect(roomA).not.toBe('battle-local-1');
      expect(roomB).not.toBe('battle-local-1');
      expect(roomA).not.toBe(roomB);
    } finally {
      await first.close();
      await second.close();
    }
  }, 60_000);
});
