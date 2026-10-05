import { ShowdownClient } from './showdown-client.js';
import { safeError, toID } from './ids.js';

const SEARCH_BACKOFF_MAX_MS = 30_000;
const SEARCH_GAP_MS = 500;
const READY_WAIT_MS = 250;

/**
 * Showdown allows one search per format. A login keeps up to K battles by
 * holding a single search whenever fewer than K battles are active.
 */
export function isSearchRejection(message: string): boolean {
  return /couldn'?t search|already searching|limited to \d+ games|limited to \d+ battles|high load|battles will be available|cannot be started|barred from starting/i.test(message);
}

export function isAlreadySearching(message: string): boolean {
  return /already searching/i.test(message);
}

export interface SearchUpdate {
  searching: string[];
  games: string[];
}

export function parseUpdateSearch(line: string): SearchUpdate | null {
  if (!line.startsWith('|updatesearch|')) return null;
  try {
    const data = JSON.parse(line.slice('|updatesearch|'.length));
    const searching = Array.isArray(data.searching) ? data.searching.map(String) : [];
    const games = data.games && typeof data.games === 'object' ? Object.keys(data.games) : [];
    return { searching, games };
  } catch {
    return null;
  }
}

export class LadderQueue {
  private readonly active = new Set<string>();
  private searching = false;
  private stopped = false;
  private draining = false;
  private backoffMs = 1000;
  private timer: NodeJS.Timeout | null = null;
  private lastSearchAt = 0;

  constructor(
    private readonly client: ShowdownClient,
    private readonly format: string,
    private readonly concurrency: number,
    private readonly log: (message: string) => void = message => console.warn(`[ladder] ${message}`),
    private readonly autoSearch = true,
  ) {}

  get activeBattles(): number {
    return this.active.size;
  }

  get limit(): number {
    return this.concurrency;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  noteBattle(roomId: string): void {
    if (!roomId || this.active.has(roomId)) return;
    this.active.add(roomId);
    this.searching = false;
    this.backoffMs = 1000;
    if (this.autoSearch && !this.draining) this.fill();
  }

  noteEnd(roomId: string): void {
    this.active.delete(roomId);
  }

  notePopup(message: string): void {
    if (isAlreadySearching(message)) {
      this.searching = true;
      this.log(`search left queued: ${message}`);
      return;
    }
    if (!isSearchRejection(message)) return;
    this.searching = false;
    this.log(`search rejected, retrying in ${this.backoffMs}ms: ${message}`);
    this.schedule(this.backoffMs);
    this.backoffMs = Math.min(SEARCH_BACKOFF_MAX_MS, this.backoffMs * 2);
  }

  noteLobby(line: string): void {
    const update = parseUpdateSearch(line);
    if (!update || this.stopped) return;
    const formatId = toID(this.format);
    const queued = update.searching.some(format => toID(format) === formatId);
    this.searching = queued;
    if (this.autoSearch && !this.draining && !queued && this.active.size < this.concurrency) this.fill();
  }

  fill(): void {
    if (!this.autoSearch || this.stopped || this.draining || this.searching || this.timer) return;
    if (this.client.isBlocked()) {
      this.stopped = true;
      return;
    }
    if (this.active.size >= this.concurrency) return;
    if (!this.client.isReady()) {
      this.schedule(READY_WAIT_MS);
      return;
    }
    const wait = SEARCH_GAP_MS - (Date.now() - this.lastSearchAt);
    if (wait > 0) {
      this.schedule(wait);
      return;
    }
    this.searching = true;
    this.lastSearchAt = Date.now();
    try {
      if (!this.client.search(this.format)) {
        this.searching = false;
        this.schedule(READY_WAIT_MS);
      }
    } catch (err) {
      this.searching = false;
      this.log(`search paused until the connection is ready: ${safeError(err)}`);
      this.schedule(READY_WAIT_MS);
    }
  }

  /**
   * Stop queueing new games. Battles already in `active` keep running.
   * This never sends /forfeit.
   */
  drain(): void {
    if (this.stopped || this.draining) return;
    this.draining = true;
    this.cancelOutstanding();
  }

  stop(): void {
    this.stopped = true;
    this.draining = true;
    this.cancelOutstanding();
  }

  private cancelOutstanding(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.searching = false;
    if (!this.client.isReady()) return;
    try {
      this.client.cancelSearch();
    } catch {
      // The socket may already be closed. Timers must not surface that.
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.draining || this.timer || this.client.isBlocked()) {
      if (this.client.isBlocked()) this.stopped = true;
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fill();
    }, delayMs);
  }
}
