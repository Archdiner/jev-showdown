import { jest } from '@jest/globals';
import { budgetSearchMs, clampConcurrency, MAX_LADDER_CONCURRENCY, parseEngine } from './engines.js';
import { isAlreadySearching, isSearchRejection, LadderQueue, parseUpdateSearch } from './ladder-queue.js';
import type { ShowdownClient } from './showdown-client.js';

describe('ladder concurrency', () => {
  it('clamps concurrency to the absolute max', () => {
    expect(clampConcurrency(1)).toBe(1);
    expect(clampConcurrency(4)).toBe(4);
    expect(clampConcurrency(9)).toBe(9);
    expect(clampConcurrency(99)).toBe(MAX_LADDER_CONCURRENCY);
    expect(() => clampConcurrency(0)).toThrow(/concurrency/);
  });

  it('splits search time across in-flight battles', () => {
    expect(budgetSearchMs(800, 1)).toBe(800);
    expect(budgetSearchMs(800, 4)).toBe(200);
    expect(budgetSearchMs(80, 4)).toBe(50);
  });

  it('names the live engines', () => {
    expect(parseEngine('search')).toBe('search');
    expect(parseEngine('exact')).toBe('search');
    expect(parseEngine('maxdamage')).toBe('max-damage');
    expect(() => parseEngine('stockfish')).toThrow(/Unknown engine/);
  });

  it('recognizes search rejections and the search update', () => {
    expect(isAlreadySearching("Couldn't search: You are already searching for a gen9randombattle battle.")).toBe(true);
    expect(isSearchRejection('Due to high load, you are limited to 5 games at the same time.')).toBe(true);
    expect(isSearchRejection('Due to high load, you are limited to 12 battles and team validations every 3 minutes.')).toBe(true);
    expect(isSearchRejection('The server is restarting. Battles will be available again in a few minutes.')).toBe(true);
    expect(isSearchRejection('Battle started')).toBe(false);
    expect(parseUpdateSearch('|updatesearch|{"searching":["gen9randombattle"],"games":{"battle-gen9randombattle-1":"gen9randombattle"}}')).toEqual({
      searching: ['gen9randombattle'],
      games: ['battle-gen9randombattle-1'],
    });
  });

  it('pauses the queue until the socket is ready and stops when the account is blocked', () => {
    jest.useFakeTimers({ now: 10_000 });
    try {
      let ready = false;
      let blocked = false;
      const searches: string[] = [];
      const client = {
        isReady: () => ready,
        isBlocked: () => blocked,
        search: (format: string) => {
          searches.push(format);
          return true;
        },
        cancelSearch: () => true,
      } as unknown as ShowdownClient;

      const waiting = new LadderQueue(client, 'gen9randombattle', 1, () => {}, true);
      expect(() => waiting.fill()).not.toThrow();
      jest.advanceTimersByTime(200);
      expect(searches).toEqual([]);
      ready = true;
      jest.advanceTimersByTime(250);
      expect(searches).toEqual(['gen9randombattle']);

      ready = false;
      blocked = true;
      const stopped = new LadderQueue(client, 'gen9randombattle', 1, () => {}, true);
      expect(() => stopped.fill()).not.toThrow();
      jest.advanceTimersByTime(2000);
      expect(searches).toEqual(['gen9randombattle']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels the search on drain and leaves the active game running', () => {
    jest.useFakeTimers({ now: 10_000 });
    try {
      const searches: string[] = [];
      let cancels = 0;
      const client = {
        isReady: () => true,
        isBlocked: () => false,
        search: (format: string) => {
          searches.push(format);
          return true;
        },
        cancelSearch: () => {
          cancels += 1;
          return true;
        },
      } as unknown as ShowdownClient;
      const queue = new LadderQueue(client, 'gen9randombattle', 2, () => {}, true);
      queue.fill();
      expect(searches).toEqual(['gen9randombattle']);
      queue.noteBattle('battle-gen9randombattle-1');
      queue.drain();
      expect(queue.activeBattles).toBe(1);
      expect(queue.isDraining).toBe(true);
      expect(cancels).toBe(1);
      queue.fill();
      jest.advanceTimersByTime(5_000);
      expect(searches).toEqual(['gen9randombattle']);
    } finally {
      jest.useRealTimers();
    }
  });
});
