import { BattleStreams, RandomPlayerAI, Teams } from '@pkmn/sim';
import { WebSocketServer, type WebSocket } from 'ws';
import { ensureGenerators, teamsForSeed } from '../engine/exact/battle-utils.js';

export interface LocalServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Speaks enough of the Showdown websocket for `ShowdownClient` with `local: true`.
 * One search starts one gen9randombattle against a random opponent. After each
 * game the server sends rating and GXE so the live facility can record them.
 */
export async function startLocalServer(port = 0): Promise<LocalServer> {
  ensureGenerators();
  const wss = new WebSocketServer({ port });
  await new Promise<void>(resolve => wss.once('listening', () => resolve()));
  const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('local server has no port');
  let seq = 0;

  wss.on('connection', socket => {
    let username = 'localbot';
    let rating = 1000;
    let games = 0;
    const rooms = new Map<string, ReturnType<typeof BattleStreams.getPlayerStreams>>();
    socket.send('|challstr|local\n');

    socket.on('message', data => {
      const text = data.toString();
      const trn = text.match(/\/trn ([^,|]+)/);
      if (trn) {
        username = trn[1].trim();
        socket.send(`|updateuser| ${username}|1|1\n`);
      }
      if (text.includes('/search')) {
        seq += 1;
        void startBattle(socket, rooms, username, seq, () => {
          games += 1;
          return { games, bump: (won: boolean | null) => {
            if (won === true) rating += 8;
            if (won === false) rating -= 6;
            return rating;
          } };
        });
      }
      const choose = text.match(/(?:^|\n)>?([^\n|]*)\|\/choose\s+([^\n]+)/);
      if (choose) {
        const players = rooms.get(choose[1].trim());
        if (players) void players.p1.write(choose[2].trim());
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${address.port}/showdown/websocket`,
    port: address.port,
    close: () => new Promise(resolve => wss.close(() => resolve())),
  };
}

function startBattle(
  socket: WebSocket,
  rooms: Map<string, ReturnType<typeof BattleStreams.getPlayerStreams>>,
  username: string,
  seq: number,
  account: () => { games: number; bump: (won: boolean | null) => number },
): void {
  const room = `battle-local-${seq}`;
  const stream = new BattleStreams.BattleStream({ keepAlive: false });
  const players = BattleStreams.getPlayerStreams(stream);
  rooms.set(room, players);
  const ai = new RandomPlayerAI(players.p2);
  void ai.start();
  const teams = teamsForSeed(seq);
  let introduced = false;

  void (async () => {
    for await (const chunk of players.p1) {
      if (!chunk.trim()) continue;
      const inputLog = stream.battle?.inputLog.join('\n') ?? '';
      const sim = `|siminput|${encodeURIComponent(inputLog)}`;
      let body = chunk.includes('|request|')
        ? chunk.replace('|request|', `${sim}\n|request|`)
        : `${chunk}\n${sim}`;
      if (!introduced) {
        introduced = true;
        body = `|init|battle\n|player|p1|${username}\n|player|p2|Local Opponent\n${body}`;
      }
      const lines = chunk.split('\n');
      const wonLine = lines.find(line => line.startsWith('|win|'));
      const tieLine = lines.find(line => line === '|tie' || line.startsWith('|tie|'));
      const ended = Boolean(wonLine || tieLine);
      if (ended) {
        const won = wonLine?.slice(5).trim() === username ? true : tieLine ? null : false;
        const { games, bump } = account();
        const next = bump(won);
        const gxe = Math.max(0, Math.min(100, 50 + (next - 1000) / 8));
        const ratingLine = `|rating|${next}|${gxe.toFixed(1)}|${games}`;
        body = body.replace(wonLine || tieLine || '|win|', `${ratingLine}\n${wonLine || tieLine}`);
      }
      if (socket.readyState === socket.OPEN) socket.send(`>${room}\n${body}`);
      if (ended) break;
    }
  })().catch(error => {
    if (socket.readyState === socket.OPEN) {
      socket.send(`>${room}\n|error|${error instanceof Error ? error.message : error}`);
    }
  });

  void players.omniscient.write(`>start ${JSON.stringify({ formatid: 'gen9randombattle' })}\n`);
  void players.omniscient.write(`>player p1 ${JSON.stringify({ name: username, team: Teams.pack(teams.p1) })}\n`);
  void players.omniscient.write(`>player p2 ${JSON.stringify({ name: 'Local Opponent', team: Teams.pack(teams.p2) })}\n`);
}
