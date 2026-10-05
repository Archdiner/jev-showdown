import { budgetSearchMs, clampConcurrency, MAX_LADDER_CONCURRENCY, parseEngine } from './engines.js';
import { isAlreadySearching, isSearchRejection, parseUpdateSearch } from './ladder-queue.js';

describe('ladder concurrency', () => {
  it('caps concurrency at the server limit', () => {
    expect(clampConcurrency(1)).toBe(1);
    expect(clampConcurrency(4)).toBe(4);
    expect(clampConcurrency(9)).toBe(MAX_LADDER_CONCURRENCY);
    expect(() => clampConcurrency(0)).toThrow(/concurrency/);
  });

  it('splits search time across in-flight battles', () => {
    expect(budgetSearchMs(800, 1)).toBe(800);
    expect(budgetSearchMs(800, 4)).toBe(200);
    expect(budgetSearchMs(80, 4)).toBe(50);
  });

  it('names the live engines', () => {
    expect(parseEngine('search')).toBe('search');
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
});
