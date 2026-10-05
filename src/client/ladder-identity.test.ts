import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../config/load.js';
import { GraphDB } from '../graph/db.js';
import { writeChampion } from '../ops/labels.js';
import { ladderConfigId, ladderPolicy, policyHash } from './ladder-engine.js';
import {
  builtinIdentity,
  formatLiveConfig,
  readActiveChampions,
  resolveLadderIdentity,
} from './ladder-identity.js';

const championYaml = path.join(process.cwd(), 'configs/champion.yaml');

function tempGraph(): { dir: string; graph: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-identity-'));
  const file = path.join(dir, 'champion.yaml');
  fs.copyFileSync(championYaml, file);
  return { dir, graph: path.join(dir, 'graph.db'), file };
}

describe('ladder config identity', () => {
  it('stamps the builtin policy id and policy hash', () => {
    const identity = builtinIdentity('search', 'abc123');
    expect(identity.source).toBe('builtin');
    expect(identity.configId).toBe('champion-exact-1ply');
    expect(identity.configId).toBe(ladderConfigId('search'));
    expect(identity.configHash).toBe(policyHash(ladderPolicy('search')));
    expect(identity.configHash).not.toBe(policyHash(ladderPolicy('max-damage')));
    expect(identity.gitSha).toBe('abc123');
    expect(identity.championConfigPath).toBeNull();
    expect(Object.isFrozen(identity)).toBe(true);
    expect(formatLiveConfig(identity)).toContain('source=builtin');
    expect(formatLiveConfig(identity)).toContain('id=champion-exact-1ply');
    expect(formatLiveConfig(identity)).toContain(`hash=${identity.configHash}`);
    expect(formatLiveConfig(identity)).toContain('commit=abc123');
  });

  it('leaves a labeled champion unused unless the operator opts in', () => {
    const { graph, file } = tempGraph();
    const db = new GraphDB(graph);
    writeChampion(db, file);
    db.close();
    let reads = 0;
    const identity = resolveLadderIdentity({
      engine: 'search',
      labeledChampion: false,
      rollback: false,
      gitSha: 'abc123',
      graphPath: graph,
      readChampions: () => {
        reads += 1;
        return readActiveChampions(graph);
      },
    });
    expect(reads).toBe(0);
    expect(identity.source).toBe('builtin');
    expect(identity.configId).toBe(ladderConfigId('search'));
  });

  it('loads the gatekeeper champion once when the hash still matches', () => {
    const { graph, file } = tempGraph();
    const db = new GraphDB(graph);
    const labeled = writeChampion(db, file);
    db.close();
    expect(labeled).toBe(loadConfig(file).configId);
    let reads = 0;
    const identity = resolveLadderIdentity({
      engine: 'search',
      labeledChampion: true,
      rollback: false,
      gitSha: 'deadbeef',
      graphPath: graph,
      readChampions: (graphPath) => {
        reads += 1;
        return readActiveChampions(graphPath);
      },
    });
    expect(reads).toBe(1);
    expect(identity.source).toBe('labeled-champion');
    expect(identity.configId).toBe(labeled);
    expect(identity.configHash).toBe(labeled);
    expect(identity.championConfigPath).toBe(file);
    expect(identity.gitSha).toBe('deadbeef');
    expect(Object.isFrozen(identity)).toBe(true);
    const line = formatLiveConfig(identity);
    expect(line).toContain('source=labeled-champion');
    expect(line).toContain(`id=${labeled}`);
    expect(line).toContain(`path=${file}`);
    expect(line).toContain('commit=deadbeef');
  });

  it('rolls back when the champion file changed after the label', () => {
    const { graph, file } = tempGraph();
    const db = new GraphDB(graph);
    const labeled = writeChampion(db, file);
    db.close();
    const text = fs.readFileSync(file, 'utf8').replace('style: balanced', 'style: hyper-offense');
    fs.writeFileSync(file, text);
    const identity = resolveLadderIdentity({
      engine: 'max-damage',
      labeledChampion: true,
      rollback: false,
      gitSha: 'abc123',
      graphPath: graph,
      prove: () => {
        throw new Error('should not build a drifted file');
      },
    });
    expect(identity.source).toBe('rollback');
    expect(identity.configId).toBe('maxdamage-v1');
    expect(identity.configHash).toBe(policyHash(ladderPolicy('max-damage')));
    expect(identity.championConfigPath).toBeNull();
    expect(identity.reason).toContain(labeled);
    expect(identity.reason).toContain('does not match');
    expect(formatLiveConfig(identity)).toContain('source=rollback');
  });

  it('rolls back when there is no label, two labels, or the file is missing', () => {
    const missing = resolveLadderIdentity({
      engine: 'search',
      labeledChampion: true,
      rollback: false,
      gitSha: null,
      graphPath: path.join(os.tmpdir(), 'jev-missing-graph', 'nope.db'),
    });
    expect(missing.source).toBe('rollback');
    expect(missing.reason).toBe('no active champion label');
    expect(formatLiveConfig(missing)).toContain('commit=unknown');

    const two = resolveLadderIdentity({
      engine: 'search',
      labeledChampion: true,
      rollback: false,
      gitSha: 'abc',
      readChampions: () => [
        { configId: 'a', configPath: 'one.yaml' },
        { configId: 'b', configPath: 'two.yaml' },
      ],
    });
    expect(two.source).toBe('rollback');
    expect(two.reason).toContain('more than one');
    expect(two.championConfigPath).toBeNull();

    const gone = resolveLadderIdentity({
      engine: 'search',
      labeledChampion: true,
      rollback: false,
      gitSha: 'abc',
      readChampions: () => [{ configId: 'abc', configPath: path.join(os.tmpdir(), 'missing-champion.yaml') }],
      prove: () => undefined,
    });
    expect(gone.source).toBe('rollback');
    expect(gone.reason).toContain('could not load');
  });

  it('honors an explicit rollback without reading the graph', () => {
    let reads = 0;
    const identity = resolveLadderIdentity({
      engine: 'search',
      labeledChampion: true,
      rollback: true,
      gitSha: 'abc123',
      readChampions: () => {
        reads += 1;
        return [{ configId: 'x', configPath: championYaml }];
      },
    });
    expect(reads).toBe(0);
    expect(identity.source).toBe('rollback');
    expect(identity.reason).toBe('operator rollback');
    expect(identity.configId).toBe(ladderConfigId('search'));
    expect(identity.championConfigPath).toBeNull();
  });
});
