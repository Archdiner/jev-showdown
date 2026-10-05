import { Dex, Teams } from '@pkmn/sim';
import { ensureGenerators, startRandomBattle, teamsForSeed } from '../../engine/exact/battle-utils.js';
import { battleSpecies } from '../../engine/exact/species.js';
import { estimatedMaxHp, publicMatchup } from '../../engine/exact/matchup.js';
import { assembleBrief, boardFromSim } from './index.js';
import { renderContextBrief } from '../context-brief.js';

function randomBattleNames(): string[] {
  ensureGenerators();
  const gen = Teams.getGenerator('gen9randombattle') as { randomSets?: Record<string, unknown> };
  const names = new Set<string>();
  for (const key of Object.keys(gen.randomSets ?? {})) {
    const species = Dex.species.get(key);
    if (!species.exists) continue;
    names.add(species.name);
    for (const forme of species.cosmeticFormes ?? []) names.add(forme);
  }
  return [...names].sort();
}

test('every random-battle species and cosmetic forme survives the brief', () => {
  const names = randomBattleNames();
  const cosmetic = names.filter(name => Dex.species.get(name).isCosmeticForme);
  expect(names.length).toBeGreaterThan(400);
  expect(cosmetic.length).toBeGreaterThan(0);

  const template = teamsForSeed(50000);
  for (const name of names) {
    const level = 80;
    expect(estimatedMaxHp(name, level)).toBeGreaterThan(0);
    const match = publicMatchup({
      ourSpecies: name,
      ourLevel: level,
      ourHpFrac: 1,
      ourMoves: ['tackle'],
      foeSpecies: name,
      foeLevel: level,
      foeHpFrac: 1,
      foeMoves: ['tackle'],
    });
    expect(Number.isFinite(match.ourThreat)).toBe(true);

    const battle = startRandomBattle(
      [{ ...template.p1[0], species: name }, ...template.p1.slice(1)],
      template.p2,
      50000,
    );
    const brief = renderContextBrief(battle, 'p1', 2000);
    expect(brief.text.length).toBeGreaterThan(0);
    expect(brief.text).toContain('## damage');
    if (Dex.species.get(name).isCosmeticForme) {
      const board = boardFromSim(battle, 'p1', {});
      expect(assembleBrief(board).blocks.some(block => block.id === 'decision')).toBe(true);
    }
  }
}, 180000);
