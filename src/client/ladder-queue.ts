import { ShowdownClient } from './showdown-client.js';
import { safeError, toID } from './ids.js';

const SEARCH_BACKOFF_MAX_MS = 30_000;
const SEARCH_GAP_MS = 500;

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

  noteBattle(roomId: string): void {
    if (!roomId || this.active.has(roomId)) return;
    this.active.add(roomId);
    this.searching = false;
    this.backoffMs = 1000;
    if (this.autoSearch) this.fill();
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
    if (this.autoSearch && !queued && this.active.size < this.concurrency) this.fill();
  }

  fill(): void {
    if (!this.autoSearch || this.stopped || this.searching || this.timer) return;
    if (this.active.size >= this.concurrency) return;
    const wait = SEARCH_GAP_MS - (Date.now() - this.lastSearchAt);
    if (wait > 0) {
      this.schedule(wait);
      return;
    }
    this.searching = true;
    this.lastSearchAt = Date.now();
    try {
      this.client.search(this.format);
    } catch (err) {
      this.searching = false;
      this.log(`search send failed, retrying in ${this.backoffMs}ms: ${safeError(err)}`);
      this.schedule(this.backoffMs);
      this.backoffMs = Math.min(SEARCH_BACKOFF_MAX_MS, this.backoffMs * 2);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.client.cancelSearch();
    } catch {
      // The socket may already be closed.
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fill();
    }, delayMs);
  }
}
