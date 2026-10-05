import { buildLadderArgv, flagValue, forwardLiveFlags } from './argv.js';

describe('soak argv', () => {
  it('keeps engine flags and drops connection flags', () => {
    const extra = forwardLiveFlags([
      '--local',
      '--games', '10',
      '--server', 'ws://example',
      '--engine', 'search',
      '--search-ms', '400',
      '--use-engine-profile',
      '--username', 'Bot',
      '--help',
    ]);
    expect(extra).toEqual([
      '--engine', 'search',
      '--search-ms', '400',
      '--use-engine-profile',
    ]);
  });

  it('uses the last flag value', () => {
    expect(flagValue(['--concurrency', '1', '--concurrency', '3'], '--concurrency', '9')).toBe('3');
  });

  it('appends concurrency and engine after forwarded flags', () => {
    const args = buildLadderArgv({
      server: 'ws://127.0.0.1:9/showdown/websocket',
      games: 2,
      logDir: '/tmp/logs',
      username: 'SoakBot',
      concurrency: 3,
      engine: 'max-damage',
      extra: ['--engine', 'search', '--concurrency', '1', '--use-engine-profile'],
    });
    expect(args.slice(-4)).toEqual(['--concurrency', '3', '--engine', 'max-damage']);
    expect(args).toContain('--use-engine-profile');
    expect(args).toContain('--local');
  });
});
