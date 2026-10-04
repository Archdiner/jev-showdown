import { parseReplayLog } from './replay-dataset.js';

const LOG = `
|player|p1|Alpha|1|1500
|player|p2|Bravo|2|1600
|teamsize|p1|6
|teamsize|p2|6
|start
|switch|p1a: Garchomp|Garchomp, L80|300/300
|switch|p2a: Dragonite|Dragonite, L80|320/320
|turn|1
|move|p1a: Garchomp|Earthquake|p2a: Dragonite
|-ability|p2a: Dragonite|Multiscale
|move|p2a: Dragonite|Dragon Dance|p2a: Dragonite
|-terastallize|p1a: Garchomp|Ground
|-item|p1a: Garchomp|Leftovers
|turn|2
|win|Alpha
`;

describe('replay dataset', () => {
  it('parses reveals into a modeling row', () => {
    const row = parseReplayLog({
      id: 'gen9randombattle-1',
      log: LOG,
      format: '[Gen 9] Random Battle',
      formatId: 'gen9randombattle',
      rating: 1700,
      players: ['Alpha', 'Bravo'],
    });

    expect(row.winner).toBe('Alpha');
    expect(row.turns).toBe(2);
    expect(row.rating).toBe(1700);
    expect(row.p1.rating).toBe(1500);
    expect(row.p1.pokemon).toEqual([
      expect.objectContaining({
        species: 'Garchomp',
        level: 80,
        moves: ['Earthquake'],
        item: 'Leftovers',
        teraType: 'Ground',
      }),
    ]);
    expect(row.p2.pokemon[0]).toEqual(expect.objectContaining({
      species: 'Dragonite',
      ability: 'Multiscale',
      moves: ['Dragon Dance'],
    }));
  });
});
