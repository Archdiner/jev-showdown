import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, toSpec } from '../config/load.js';
import { teamsForSeed } from '../engine/exact/battle-utils.js';
import { runGame, type BenchPlayer } from './game.js';

/** Top-level and panel bot configs. Skip envs/ (overlays) and experiments/ (job specs). */
function botConfigFiles(): string[] {
  const root = path.join(process.cwd(), 'configs');
  const out: string[] = [];
  for (const name of fs.readdirSync(root)) {
    if (name.endsWith('.yaml') || name.endsWith('.yml')) out.push(path.join(root, name));
  }
  const panel = path.join(root, 'panel');
  if (fs.existsSync(panel)) {
    for (const name of fs.readdirSync(panel)) {
      if (name.endsWith('.yaml') || name.endsWith('.yml')) out.push(path.join(panel, name));
    }
  }
  const examples = path.join(root, 'examples');
  if (fs.existsSync(examples)) {
    for (const name of fs.readdirSync(examples)) {
      if (name.endsWith('.yaml') || name.endsWith('.yml')) out.push(path.join(examples, name));
    }
  }
  return out.sort();
}

describe('config legality smoke', () => {
  const files = botConfigFiles();
  const opponent = toSpec(loadConfig('configs/panel/maxdamage.yaml'), 'selfplay');

  test('discovers bot configs under configs/', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.some(file => file.endsWith('champion.yaml'))).toBe(true);
    expect(files.some(file => file.endsWith('exact-1ply-qw.yaml'))).toBe(true);
  });

  test('every config plays a few seeded hidden-info games with 0 invalid choices', async () => {
    const failures: string[] = [];
    for (const file of files) {
      let player: BenchPlayer;
      try {
        player = toSpec(loadConfig(file), 'selfplay');
      } catch (error) {
        failures.push(`${file}: load failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      for (const seed of [1, 2]) {
        const teams = teamsForSeed(seed);
        const result = await runGame({
          index: 0,
          seed,
          p1Team: teams.p1,
          p2Team: teams.p2,
          p1: player,
          p2: opponent,
          information: 'hidden',
        });
        if (result.p1Invalid > 0 || result.p2Invalid > 0 || result.crashed) {
          failures.push(
            `${path.relative(process.cwd(), file)} seed=${seed} `
            + `invalid=${result.p1Invalid + result.p2Invalid} crashed=${result.crashed} `
            + `error=${result.error ?? ''}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  }, 600_000);
});
