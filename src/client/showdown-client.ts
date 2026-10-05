import WebSocket from 'ws';
import { EventEmitter } from 'events';

export interface ShowdownConfig {
  server?: string;
  username: string;
  password: string;
  format?: string;
  /** Guest login against a local server. Skips the play.pokemonshowdown.com assertion. */
  local?: boolean;
}

export class ShowdownClient extends EventEmitter {
  private ws?: WebSocket;
  private config: ShowdownConfig;
  private challstr?: string;
  private connected = false;
  private loggedIn = false;
  private battleRooms = new Set<string>();
  private transcripts = new Map<string, string[]>();
  private sides = new Map<string, 'p1' | 'p2'>();

  constructor(config: ShowdownConfig) {
    super();
    this.config = {
      server: config.server || 'wss://sim3.psim.us/showdown/websocket',
      format: config.format || 'gen9randombattle',
      ...config,
    };
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.config.server!);

      this.ws.on('open', () => {
        this.connected = true;
        console.log('Connected to Pokemon Showdown');
      });

      this.ws.on('message', async (data) => {
        const message = data.toString();
        await this.handleMessage(message);
        
        if (this.challstr && !this.isLoggedIn()) {
          await this.login();
          resolve();
        }
      });

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      });

      this.ws.on('close', () => {
        this.connected = false;
        console.log('Disconnected from Pokemon Showdown');
        this.emit('disconnect');
      });

      setTimeout(() => {
        if (!this.challstr) {
          reject(new Error('Connection timeout'));
        }
      }, 10000);
    });
  }

  transcript(room: string): string {
    return (this.transcripts.get(room) || []).join('\n');
  }

  sideFor(room: string): 'p1' | 'p2' | undefined {
    return this.sides.get(room);
  }

  choose(room: string, choice: string): void {
    const body = choice.startsWith('/') ? choice : `/choose ${choice}`;
    this.send(`${room}|${body}`);
  }

  private async handleMessage(message: string): Promise<void> {
    const lines = message.split('\n');
    const room = lines[0]?.startsWith('>') ? lines[0].slice(1) : '';
    if (room) {
      const bucket = this.transcripts.get(room) || [];
      bucket.push(message);
      this.transcripts.set(room, bucket);
    }

    for (const line of lines) {
      if (line.startsWith('|challstr|')) {
        this.challstr = line.slice(11);
      } else if (line.startsWith('|updateuser|')) {
        const parts = line.split('|');
        if (parts[2] !== ' Guest') {
          this.loggedIn = true;
          this.emit('login', parts[2]);
        }
      } else if (line.startsWith('|player|') && room) {
        const parts = line.split('|');
        const slot = parts[2];
        const name = (parts[3] || '').trim();
        if ((slot === 'p1' || slot === 'p2') && name && this.sameUser(name)) {
          this.sides.set(room, slot);
        }
      } else if (line.startsWith('|init|battle')) {
        if (room) this.battleRooms.add(room);
        this.emit('battleStart', room);
      } else if (line.startsWith('|request|')) {
        const requestData = JSON.parse(line.slice(9));
        const side = requestData?.side?.id;
        if (room && (side === 'p1' || side === 'p2')) this.sides.set(room, side);
        this.emit('request', room, requestData);
      } else if (line.startsWith('|win|')) {
        const winner = line.slice(5);
        this.emit('battleEnd', room, winner);
        if (room) this.battleRooms.delete(room);
      } else if (line.startsWith('|tie')) {
        this.emit('battleEnd', room, null);
        if (room) this.battleRooms.delete(room);
      }

      if (room) this.emit('battleMessage', room, line);
    }
  }

  private sameUser(name: string): boolean {
    const strip = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
    return strip(name) === strip(this.config.username);
  }

  private async login(): Promise<void> {
    if (!this.challstr) {
      throw new Error('No challstr available');
    }

    if (this.config.local || !this.config.password) {
      this.send(`|/trn ${this.config.username},0,`);
      this.loggedIn = true;
      return;
    }

    try {
      const response = await fetch('https://play.pokemonshowdown.com/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          name: this.config.username,
          pass: this.config.password,
          challstr: this.challstr,
        }),
      });

      const text = await response.text();
      const data = JSON.parse(text.slice(1));

      if (data.actionsuccess) {
        this.loggedIn = true;
        this.send(`|/trn ${this.config.username},0,${data.assertion}`);
      } else {
        throw new Error(`Login failed: ${data.assertion || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Login error:', error);
      throw error;
    }
  }

  searchBattle(): void {
    this.send(`|/search ${this.config.format}`);
  }

  cancelSearch(): void {
    this.send('|/cancelsearch');
  }

  makeMove(room: string, move: number, options?: { mega?: boolean; zmove?: boolean; dynamax?: boolean; terastallize?: boolean }): void {
    let command = `${room}|/choose move ${move}`;
    if (options?.terastallize) command += ' terastallize';
    if (options?.mega) command += ' mega';
    if (options?.zmove) command += ' zmove';
    if (options?.dynamax) command += ' dynamax';
    this.send(command);
  }

  makeSwitch(room: string, pokemon: number): void {
    this.send(`${room}|/choose switch ${pokemon}`);
  }

  forfeit(room: string): void {
    this.send(`${room}|/forfeit`);
  }

  send(message: string): void {
    if (!this.ws || !this.connected) {
      throw new Error('Not connected');
    }
    this.ws.send(message);
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
    }
  }

  private isLoggedIn(): boolean {
    return this.loggedIn;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
