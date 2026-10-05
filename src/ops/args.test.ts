import { OPS_USAGE, opsNumber, opsValue } from './args.js';

describe('ops argv', () => {
  it('reads --server value and --server=value', () => {
    const spaced = ['live', '--local', '--server', 'ws://127.0.0.1:8010/showdown/websocket'];
    expect(opsValue(spaced, 'server')).toBe('ws://127.0.0.1:8010/showdown/websocket');
    expect(opsValue(['live', '--server=ws://127.0.0.1:8010/showdown/websocket'], 'server'))
      .toBe('ws://127.0.0.1:8010/showdown/websocket');
    expect(opsValue(['live', '--username', 'localbot'], 'username')).toBe('localbot');
    expect(opsNumber(['live', '--port', '8010'], 'port')).toBe(8010);
    expect(opsNumber(['live', '--port=0'], 'port')).toBe(0);
  });

  it('describes a local facility that does not use port 8000 or the public login server', () => {
    expect(OPS_USAGE).toContain('live --local');
    expect(OPS_USAGE).toContain('free port');
    expect(OPS_USAGE).toContain('localbot');
    expect(OPS_USAGE).toContain('--username');
    expect(OPS_USAGE).toContain('--port 8010');
    expect(OPS_USAGE).toContain('ws://127.0.0.1:8010/showdown/websocket');
    expect(OPS_USAGE).toContain('play.pokemonshowdown.com');
    expect(OPS_USAGE).toContain('Refuses to start');
    expect(OPS_USAGE).not.toContain('8000');
    expect(OPS_USAGE).not.toContain('uses the local server instead of the ladder');
  });
});
