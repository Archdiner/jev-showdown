import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { roomLines } from '../client/protocol-frames.js';
import { ChoiceTrace, ServerLine } from './invariants.js';

export interface SoakFaults {
  /**
   * Do not forward the first `/choose` of each room. The proxy then sends our
   * turn clock. The watchdog resends only when that clock arrives after the choice.
   */
  dropFirstChoice: boolean;
  /** Deliver `|init|battle` twice for each room. */
  duplicateJoin: boolean;
}

export interface SoakProxy {
  url: string;
  serverLines: ServerLine[];
  chooses: ChoiceTrace[];
  close: () => Promise<void>;
}

interface PendingAck {
  roomId: string;
  trace: ChoiceTrace;
}

/**
 * Sits in front of the ops local server so a soak can see every room line
 * and can drop a choice or repeat a room join without changing that server.
 */
export async function startSoakProxy(upstream: string, faults: SoakFaults): Promise<SoakProxy> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => wss.once('listening', () => resolve()));
  const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('soak proxy has no port');

  const serverLines: ServerLine[] = [];
  const chooses: ChoiceTrace[] = [];
  const droppedRooms = new Set<string>();
  const duplicatedRooms = new Set<string>();

  wss.on('connection', client => {
    const up = new WebSocket(upstream, { perMessageDeflate: false });
    const buffered: RawData[] = [];
    let open = false;
    const pending: PendingAck[] = [];

    const record = (roomId: string, line: string) => {
      serverLines.push({ roomId, line });
    };

    const noteUpstream = (text: string) => {
      const lines = roomLines(text);
      for (const entry of lines) record(entry.roomid, entry.line);
      for (const entry of lines) {
        if (!entry.roomid.startsWith('battle-')) continue;
        const index = pending.findIndex(item => item.roomId === entry.roomid);
        if (index < 0) continue;
        const item = pending.splice(index, 1)[0];
        item.trace.ackedAt = Date.now();
      }
      if (faults.duplicateJoin) {
        for (const entry of lines) {
          if (!entry.line.startsWith('|init|battle') || !entry.roomid || duplicatedRooms.has(entry.roomid)) continue;
          duplicatedRooms.add(entry.roomid);
          const extra = `>${entry.roomid}\n|init|battle\n`;
          record(entry.roomid, '|init|battle');
          if (client.readyState === WebSocket.OPEN) client.send(extra);
        }
      }
    };

    const forwardClient = (data: RawData) => {
      const text = data.toString();
      const choice = parseChoose(text);
      if (choice && faults.dropFirstChoice && !droppedRooms.has(choice.roomId)) {
        droppedRooms.add(choice.roomId);
        chooses.push({
          roomId: choice.roomId,
          choice: choice.choice,
          at: Date.now(),
          forwarded: false,
          ackedAt: null,
        });
        console.error(`[soak] dropped choice room=${choice.roomId}`);
        const clock = '|inactive|Time left: 150 sec this turn | 150 sec total | 60 sec grace';
        const roomId = choice.roomId;
        setImmediate(() => {
          record(roomId, clock);
          if (client.readyState === WebSocket.OPEN) client.send(`>${roomId}\n${clock}\n`);
        });
        return;
      }
      if (choice) {
        const trace: ChoiceTrace = {
          roomId: choice.roomId,
          choice: choice.choice,
          at: Date.now(),
          forwarded: true,
          ackedAt: null,
        };
        chooses.push(trace);
        pending.push({ roomId: choice.roomId, trace });
      }
      if (up.readyState === WebSocket.OPEN) up.send(text);
    };

    client.on('message', data => {
      if (!open) buffered.push(data);
      else forwardClient(data);
    });
    up.on('open', () => {
      open = true;
      for (const data of buffered) forwardClient(data);
      buffered.length = 0;
    });
    up.on('message', data => {
      const text = data.toString();
      noteUpstream(text);
      if (client.readyState === WebSocket.OPEN) client.send(text);
    });
    up.on('close', () => {
      if (client.readyState === WebSocket.OPEN) client.close();
    });
    client.on('close', () => {
      if (up.readyState === WebSocket.OPEN) up.close();
    });
    up.on('error', err => {
      console.error(`[soak] upstream ${err instanceof Error ? err.message : err}`);
    });
  });

  return {
    url: `ws://127.0.0.1:${address.port}/showdown/websocket`,
    serverLines,
    chooses,
    close: () => new Promise(resolve => wss.close(() => resolve())),
  };
}

function parseChoose(text: string): { roomId: string; choice: string } | null {
  const match = text.match(/(?:^|\n)>?([^\n|]*)\|\/choose\s+([^\n]+)/);
  if (!match) return null;
  return { roomId: match[1].trim(), choice: match[2].trim() };
}
