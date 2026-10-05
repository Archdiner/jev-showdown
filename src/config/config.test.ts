import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildBot } from './bot.js';
import { deepMerge } from './merge.js';
import { configIdOf } from './hash.js';
import { loadConfig, resolveRaw, toSpec } from './load.js';
import { ensureLayers } from './layers/index.js';
import { hasComponent, parseParams } from './registry.js';
import { ENV_PROFILES } from './env.js';
import { startRandomBattle, teamsForSeed } from '../engine/exact/battle-utils.js';

const champion = () => loadConfig(path.join(process.cwd(), 'configs/champion.yaml'));

describe('config registry, merge, hash', () => {
  beforeAll(() => ensureLayers());

  it('merges objects and replaces arrays', () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { b: 3 }, d: [2] })).toEqual({
      a: { b: 3, c: 2 },
      d: [2],
    });
  });

  it('registers search and rejects an illegal depth', () => {
    expect(hasComponent('search', 'greedy-1ply')).toBe(true);
    expect(hasComponent('search', 'mcts-stub')).toBe(true);
    expect(() => parseParams('search', 'greedy-1ply', { depth: 9 })).toThrow();
  });

  it('hashes a config stably and ignores env', () => {
    const first = champion();
    const second = champion();
    expect(first.configId).toBe(second.configId);
    expect(first.configId).toHaveLength(16);
    const selfplay = toSpec(first, 'selfplay');
    const ladder = toSpec(first, 'ladder');
    expect(selfplay.configId).toBe(ladder.configId);
    expect(configIdOf(selfplay.config)).toBe(selfplay.configId);
    expect(ENV_PROFILES.selfplay.timeLimitMs).not.toBe(ENV_PROFILES.ladder.timeLimitMs);
  });

  it('changes the hash when an eval weight changes', () => {
    const base = champion();
    const changed = resolveRaw({
      name: 'champion',
      agent: { id: 'balanced' },
      evaluator: { id: 'weighted', params: { weights: { hpDifference: 9 } } },
    });
    expect(changed.configId).not.toBe(base.configId);
  });

  it('applies extends and keeps the parent body', () => {
    const depth = loadConfig(path.join(process.cwd(), 'configs/examples/search-depth-2.yaml'));
    expect(depth.config.search.id).toBe('depth-n');
    expect(depth.config.search.params.depth).toBe(2);
    expect(depth.config.agent.id).toBe('balanced');
    expect(depth.config.policies.teraPolicy.id).toBe('off');
    expect(depth.config.advisor.params.blend).toBe('off');
  });

  it('rejects a species name in a config', () => {
    expect(() => resolveRaw({ name: 'garchomp-line', agent: { id: 'balanced' } })).toThrow(/species/i);
  });

  it('rejects a move rule written into a temp config file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    const file = path.join(dir, 'bad.yaml');
    fs.writeFileSync(file, 'name: bad\nagent:\n  id: balanced\n  params:\n    style: balanced\nsearch:\n  id: greedy-1ply\n');
    expect(() => loadConfig(file)).not.toThrow();
    fs.writeFileSync(file, 'name: "use earthquake"\nagent:\n  id: balanced\n');
    expect(() => loadConfig(file)).toThrow(/move|species/i);
  });
});

describe('advisor uses the real evaluate endpoint', () => {
  it('posts /v1/evaluate when blend is on and the ladder env allows it', async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async input => {
      urls.push(String(input));
      return new Response(JSON.stringify({
        model: 'typesafe-ai/jev',
        answers: { opponentWillSwitch: { type: 'boolean', probability: 0.2 } },
        usage: { inputTokens: 10, outputTokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const bot = buildBot(
      path.join(process.cwd(), 'configs/examples/advisor-jev-tiebreak.yaml'),
      'ladder',
      { apiKey: 'test-key', fetchImpl }
    );
    const teams = teamsForSeed(4);
    const battle = startRandomBattle(teams.p1, teams.p2, 4);
    await bot.decide({ battle, side: 'p1' });
    expect(urls.some(url => url.includes('/v1/evaluate'))).toBe(true);
    expect(bot.configId).toBe(configIdOf(bot.config));
  }, 60000);
});
