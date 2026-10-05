import * as fs from 'fs';
import * as path from 'path';

/**
 * Writes gen9-sets.json, gen9-stats.json, and a fresh metadata.json.
 * Species 0 is Pikachu so the belief tests have a named target.
 * `count` of 1 is a stub. The soak writes at least 500 so the species floor passes.
 */
export function writeSpeciesFixture(dir: string, count: number): void {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`fixture species count must be a positive integer (got ${count})`);
  }
  const sets: Record<string, unknown> = {};
  const stats: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    const name = i === 0 ? 'Pikachu' : `Species${i}`;
    sets[name] = { level: 88 };
    stats[name] = {
      level: 88,
      abilities: { Static: 1 },
      items: { 'Light Ball': 1 },
      roles: {
        'Fast Attacker': {
          weight: 1,
          moves: { Thunderbolt: 1, 'Volt Switch': 0.8 },
        },
      },
    };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'gen9-sets.json'), JSON.stringify(sets));
  fs.writeFileSync(path.join(dir, 'gen9-stats.json'), JSON.stringify(stats));
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
    lastChecked: new Date().toISOString(),
    setsHash: 'fixture',
    statsHash: 'fixture',
    simVersion: 'fixture',
    setsSpeciesCount: count,
    statsSpeciesCount: count,
  }));
}
