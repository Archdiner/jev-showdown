import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { Protocol } from '@pkmn/protocol';
import { redactSecrets, safeError, toID } from './ids.js';

export interface ShowdownClientOptions {
  /** WebSocket URL, for example wss://sim3.psim.us/showdown/websocket */
  server: string;
  username: string;
  /** Omit or leave empty for a local server started with guest security disabled. */
  password?: string;
  /**
   * Official login endpoint. POST act=login with name, pass, and challstr.
   * Ignored when `local` is set.
   */
  loginServer?: string;
  /** Guest rename against a local server. Never contacts the login server. */
  local?: boolean;
  format?: string;
}

const DEFAULT_LOGIN_SERVER = 'https://play.pokemonshowdown.com/action.php';

/**
 * WebSocket client for a Pokémon Showdown server.
 * Login uses the official challstr → action.php → assertion → /trn flow.
 * Credentials are read from the options (filled from the environment by the CLI)
 * and are never written to logs.
 */
export class ShowdownClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private challstr = '';
  private assertion = '';
  private loggedIn = false;
  private connecting: Promise<void> | null = null;
  private loginWaiters: Array<(username: string) => void> = [];
  private loginRejecters: Array<(err: Error) => void> = [];
  private shouldReconnect = false;
  private backoffMs = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly rooms = new Set<string>();
  private intentionalClose = false;

  readonly options: Required<Pick<ShowdownClientOptions, 'server' | 'username' | 'format'>> &
    ShowdownClientOptions;

  constructor(options: ShowdownClientOptions) {
    super();
    this.options = {
      format: 'gen9randombattle',
      local: false,
      password: '',
      ...options,
      loginServer: options.loginServer || DEFAULT_LOGIN_SERVER,
    };
  }

  async connect(): Promise<void> {
    this.intentionalClose = false;
    this.shouldReconnect = true;
    await this.openAndLogin();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  trackRoom(roomId: string): void {
    if (roomId) this.rooms.add(roomId);
  }

  untrackRoom(roomId: string): void {
    this.rooms.delete(roomId);
  }

  search(format = this.options.format): void {
    this.send(`|/utm null`);
    this.send(`|/search ${format}`);
  }

  cancelSearch(): void {
    this.send('|/cancelsearch');
  }

  challenge(username: string, format = this.options.format): void {
    this.send(`|/utm null`);
    this.send(`|/challenge ${username}, ${format}`);
  }

  accept(username: string): void {
    this.send(`|/accept ${username}`);
  }

  choose(roomId: string, choice: string): void {
    this.send(`${roomId}|/choose ${choice}`);
  }

  saveReplay(roomId: string): void {
    this.send(`${roomId}|/savereplay`);
  }

  join(roomId: string): void {
    this.send(`|/join ${roomId}`);
  }

  send(message: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }
    this.ws.send(message);
  }

  isReady(): boolean {
    return this.loggedIn && this.ws?.readyState === WebSocket.OPEN;
  }

  private async openAndLogin(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.openSocket()
      .then(() => this.waitForLogin())
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  private openSocket(): Promise<void> {
    this.loggedIn = false;
    this.challstr = '';
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.options.server, { perMessageDeflate: false });
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('WebSocket connection timed out'));
      }, 15000);

      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', err => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on('message', data => {
        this.handlePayload(data.toString());
      });
      ws.on('close', () => {
        this.loggedIn = false;
        this.emit('disconnect');
        this.scheduleReconnect();
      });
      ws.on('error', err => {
        this.emit('socketError', safeError(err));
      });
    });
  }

  private waitForLogin(): Promise<void> {
    if (this.loggedIn) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Login timed out'));
      }, 20000);
      this.loginWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.loginRejecters.push(err => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.intentionalClose) return;
    if (this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openAndLogin()
        .then(() => {
          this.backoffMs = 1000;
          for (const room of this.rooms) this.join(room);
          this.emit('reconnect');
        })
        .catch(err => {
          console.error(`[client] reconnect failed: ${safeError(err)}`);
          this.scheduleReconnect();
        });
    }, delay);
  }

  private handlePayload(payload: string): void {
    let roomid = '';
    let body = payload;
    if (body.startsWith('>')) {
      const nl = body.indexOf('\n');
      roomid = nl === -1 ? body.slice(1) : body.slice(1, nl);
      body = nl === -1 ? '' : body.slice(nl + 1);
    }
    if (roomid.startsWith('battle-')) this.rooms.add(roomid);

    const lines = body.split('\n');
    for (const line of lines) {
      if (!line) continue;
      this.emit('line', roomid, line);
      this.handleLine(roomid, line);
    }
  }

  private handleLine(roomid: string, line: string): void {
    if (line.startsWith('|challstr|')) {
      this.challstr = line.slice('|challstr|'.length);
      void this.login().catch(err => {
        const error = err instanceof Error ? err : new Error(safeError(err));
        this.loginRejecters.splice(0).forEach(reject => reject(error));
        this.loginWaiters.splice(0);
        this.emit('loginError', safeError(error));
      });
      return;
    }

    if (line.startsWith('|updateuser|')) {
      this.onUpdateUser(line);
      return;
    }

    if (line.startsWith('|nametaken|')) {
      const reason = line.split('|').slice(3).join('|') || 'name taken';
      const error = new Error(`Login rejected: ${reason}`);
      this.loginRejecters.splice(0).forEach(reject => reject(error));
      this.loginWaiters.splice(0);
      this.emit('loginError', error.message);
      return;
    }

    if (line.startsWith('|popup|')) {
      const message = line.slice('|popup|'.length);
      this.noteReplayOrRating(message);
      this.emit('popup', message);
      return;
    }

    if (line.startsWith('|error|') || line.startsWith('|bigerror|')) {
      this.emit('serverError', roomid, line);
      return;
    }

    if (line.startsWith('|updatesearch|') || line.startsWith('|updatechallenges|')) {
      this.emit('lobby', line);
      return;
    }

    this.noteReplayOrRating(line);

    if (roomid.startsWith('battle-') && (line.startsWith('|win|') || line === '|tie' || line.startsWith('|tie|'))) {
      this.emit('battleEndLine', roomid, line);
    }

    // Keep a typed parse available for callers that want protocol objects.
    if (roomid.startsWith('battle-')) {
      try {
        const parsed = Protocol.parseBattleLine(line);
        this.emit('battleArgs', roomid, parsed.args, parsed.kwArgs);
      } catch {
        // Non-battle lines inside a room are still delivered via 'line'.
      }
    }
  }

  private noteReplayOrRating(text: string): void {
    const rating = parseRatingLine(text);
    if (rating) this.emit('rating', rating);

    const replay = parseReplayUrl(text);
    if (replay) this.emit('replay', replay);
  }

  private onUpdateUser(line: string): void {
    const parts = line.split('|');
    const identity = parts[2] ?? '';
    const username = identity.length > 0 ? identity.slice(1) : '';
    const named = parts[3] === '1';
    if (!username) return;
    if (toID(username) !== toID(this.options.username)) return;
    if (!named && !this.options.local) return;
    this.loggedIn = true;
    this.loginWaiters.splice(0).forEach(resolve => resolve(username));
    this.loginRejecters.splice(0);
    this.emit('login', username);
  }

  private async login(): Promise<void> {
    if (!this.challstr) throw new Error('No challstr available');

    if (this.options.local || !this.options.password) {
      this.send(`|/trn ${this.options.username},0,`);
      return;
    }

    const assertion = await requestAssertion({
      loginServer: this.options.loginServer || DEFAULT_LOGIN_SERVER,
      username: this.options.username,
      password: this.options.password,
      challstr: this.challstr,
    });
    this.assertion = assertion;
    this.send(`|/trn ${this.options.username},0,${assertion}`);
  }
}

export interface RatingUpdate {
  username: string;
  before: number;
  after: number;
}

export interface ReplayNotice {
  id: string;
  url: string;
}

export function parseRatingLine(text: string): RatingUpdate | null {
  const match = text.match(
    /([^<>|]{1,40}?)'s rating:\s*(\d+)\s*(?:&rarr;|→|->)\s*(?:<strong>)?(\d+)/i,
  );
  if (!match) return null;
  return {
    username: match[1].replace(/<[^>]+>/g, '').trim(),
    before: Number(match[2]),
    after: Number(match[3]),
  };
}

export function parseReplayUrl(text: string): ReplayNotice | null {
  const match = text.match(/https?:\/\/replay\.pokemonshowdown\.com\/([a-z0-9-]+)/i);
  if (!match) return null;
  return { id: match[1], url: match[0] };
}

/**
 * Official login: POST act=login to action.php and return data.assertion.
 * The password and assertion are never included in thrown errors.
 */
export async function requestAssertion(input: {
  loginServer: string;
  username: string;
  password: string;
  challstr: string;
}): Promise<string> {
  const body = new URLSearchParams({
    act: 'login',
    name: input.username,
    pass: input.password,
    challstr: input.challstr,
  });

  let response: Response;
  try {
    response = await fetch(input.loginServer, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    throw new Error(`Login server request failed: ${safeError(err)}`);
  }

  if (!response.ok) {
    throw new Error(`Login server returned HTTP ${response.status}`);
  }

  let text = await response.text();
  if (text.startsWith(']')) text = text.slice(1);
  let data: { assertion?: string; actionsuccess?: boolean; actionerror?: string };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Login server returned a response that was not JSON');
  }

  if (!data.assertion || data.actionsuccess === false) {
    const reason = data.actionerror ? redactSecrets(data.actionerror) : 'rejected';
    throw new Error(`Login failed: ${reason}`);
  }

  return data.assertion;
}
