import WebSocket from 'ws';
import { EventEmitter } from 'events';

export interface ShowdownConfig {
  server?: string;
  username: string;
  password: string;
  format?: string;
}

export class ShowdownClient extends EventEmitter {
  private ws?: WebSocket;
  private config: ShowdownConfig;
  private challstr?: string;
  private connected = false;
  private battleRooms = new Set<string>();

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

  private async handleMessage(message: string): Promise<void> {
    const lines = message.split('\n');
    
    for (const line of lines) {
      if (line.startsWith('|challstr|')) {
        this.challstr = line.slice(11);
      } else if (line.startsWith('|updateuser|')) {
        const parts = line.split('|');
        if (parts[2] !== ' Guest') {
          this.emit('login', parts[2]);
        }
      } else if (line.startsWith('|init|battle')) {
        const room = lines[0].slice(1);
        this.battleRooms.add(room);
        this.emit('battleStart', room);
      } else if (line.startsWith('|request|')) {
        const requestData = JSON.parse(line.slice(9));
        const room = lines[0].slice(1);
        this.emit('request', room, requestData);
      } else if (line.startsWith('|win|')) {
        const winner = line.slice(5);
        const room = lines[0].slice(1);
        this.emit('battleEnd', room, winner);
        this.battleRooms.delete(room);
      } else if (line.startsWith('|tie')) {
        const room = lines[0].slice(1);
        this.emit('battleEnd', room, null);
        this.battleRooms.delete(room);
      }

      if (lines[0].startsWith('>')) {
        this.emit('battleMessage', lines[0].slice(1), line);
      }
    }
  }

  private async login(): Promise<void> {
    if (!this.challstr) {
      throw new Error('No challstr available');
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
    return false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
