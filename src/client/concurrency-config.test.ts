import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ABSOLUTE_MAX_CONCURRENCY,
  DEFAULT_CONCURRENCY_CONFIG,
  ENGINE_CONCURRENCY_LIMITS,
  loadConcurrencyFile,
  resolveConcurrencyLimit,
  selectLiveEngine,
} from './concurrency-config.js';

describe('concurrency limit', () => {
  it('keeps the global default at 1 and applies an engine profile only when asked', () => {
    expect(resolveConcurrencyLimit({ engine: 'search', useEngineProfile: false }).limit).toBe(1);
    expect(resolveConcurrencyLimit({ engine: 'search', useEngineProfile: true })).toEqual({
      profile: 'search',
      limit: ENGINE_CONCURRENCY_LIMITS.search,
    });
    expect(resolveConcurrencyLimit({ engine: 'max-damage', useEngineProfile: true }).limit).toBe(4);
    expect(resolveConcurrencyLimit({ engine: 'grok', useEngineProfile: true }).limit).toBe(1);
  });

  it('lets the CLI override the profile and clamps to the absolute max', () => {
    expect(resolveConcurrencyLimit({
      engine: 'search',
      useEngineProfile: true,
      concurrency: 8,
    }).limit).toBe(8);
    expect(resolveConcurrencyLimit({
      engine: 'grok',
      useEngineProfile: true,
      concurrency: 2,
      runners: 3,
    }).limit).toBe(6);
    expect(resolveConcurrencyLimit({
      engine: 'search',
      useEngineProfile: true,
      concurrency: 99,
    }).limit).toBe(ABSOLUTE_MAX_CONCURRENCY);
    expect(() => resolveConcurrencyLimit({
      engine: 'search',
      useEngineProfile: false,
      concurrency: 0,
    })).toThrow(/concurrency/);
  });

  it('lets a config file override the built-in engine limit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-conc-'));
    const filePath = path.join(dir, 'concurrency.json');
    fs.writeFileSync(filePath, JSON.stringify({ default: 2, engines: { search: 6, grok: 1 } }));
    const file = loadConcurrencyFile(filePath);
    expect(resolveConcurrencyLimit({ engine: 'search', useEngineProfile: true, file }).limit).toBe(6);
    expect(resolveConcurrencyLimit({ engine: 'max-damage', useEngineProfile: false, file }).limit).toBe(2);
    expect(resolveConcurrencyLimit({
      engine: 'search',
      useEngineProfile: true,
      concurrency: 4,
      file,
    }).limit).toBe(4);
  });

  it('ships configs/live/concurrency.json in line with the built-in profiles', () => {
    const file = loadConcurrencyFile(DEFAULT_CONCURRENCY_CONFIG);
    expect(file.engines).toEqual(ENGINE_CONCURRENCY_LIMITS);
    expect(file.default).toBe(1);
  });

  it('maps grok onto the search battle engine', () => {
    expect(selectLiveEngine('grok')).toEqual({ engine: 'search', profile: 'grok', useLLMPrior: true });
    expect(selectLiveEngine('maxdamage').engine).toBe('max-damage');
    expect(() => selectLiveEngine('stockfish')).toThrow(/Unknown engine/);
  });
});
