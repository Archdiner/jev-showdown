import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Dex, PRNG } from '@pkmn/sim';
import { runGame } from '../../bench/game.js';
import { DataLoader } from '../../data/data-loader.js';
import { chooseLive, buildDecisionBattle, type LivePosition } from '../../client/decision-battle.js';
import { formatChoice, strictLegalActions } from '../../client/choice.js';
import { specForAlias } from '../../config/aliases.js';
import { HybridParamsSchema } from '../../config/schema.js';
import type { RandbatsStats } from '../../types/index.js';
import {
  appendTeraChoices,
  legalChoices,
  moveSlotIndex,
  startRandomBattle,
  teamsForSeed,
} from '../exact/battle-utils.js';
import { createHybridSearch } from './search.js';
import { MIN_RANDBATS_SPECIES } from './worlds.js';

function wideStats(): RandbatsStats {
  const stats: RandbatsStats = {};
  for (const row of Dex.species.all()) {
    if (!row.exists || row.num <= 0) continue;
    if (Object.keys(stats).length >= MIN_RANDBATS_SPECIES) break;
    const ability = row.abilities?.['0'] || 'Pressure';
    stats[row.name] = {
      level: 80,
      abilities: { [ability]: 1 },
      items: { Leftovers: 1 },
      roles: {
        Standard: {
          weight: 1,
          moves: { Tackle: 1, Protect: 1 },
        },
      },
    };
  }
  return stats;
}

function opened(seed: number) {
  const teams = teamsForSeed(seed);
  const battle = startRandomBattle(teams.p1, teams.p2, seed);
  if (battle.requestState === 'teampreview') {
    battle.choose('p1', 'default');
    battle.choose('p2', 'default');
  }
  return battle;
}

function positionFrom(battle: ReturnType<typeof opened>): LivePosition {
  const foe = battle.p2.active[0];
  const bench = battle.p2.pokemon.filter(mon => mon !== foe);
  const snap = (mon: typeof foe) => ({
    species: mon.species.name,
    level: mon.level,
    hp: mon.hp,
    maxhp: mon.maxhp,
    ability: mon.ability,
    item: mon.item,
    moves: mon.moveSlots.map(slot => slot.id),
    fainted: mon.fainted,
  });
  return {
    request: battle.p1.activeRequest,
    foeActive: foe ? snap(foe) : null,
    foeBench: bench.map(snap),
    turn: battle.turn,
  };
}

function liveAllows(sent: string, request: unknown): boolean {
  const bare = sent.split('|')[0];
  const legal = new Set(strictLegalActions(request).map(action => formatChoice(action)));
  if (legal.has(bare)) return true;
  if (!bare.endsWith(' terastallize')) return false;
  const plain = bare.replace(/ terastallize$/, '');
  const active = (request as { active?: Array<{ canTerastallize?: string }> }).active?.[0];
  return Boolean(active?.canTerastallize) && legal.has(plain);
}

describe('hybrid live choice path', () => {
  it('keeps the protocol slot when a middle move is disabled', async () => {
    const battle = opened(11);
    const active = battle.p1.active[0];
    expect(active.moveSlots.length).toBeGreaterThan(2);
    active.moveSlots[1].disabled = true;
    battle.makeRequest('move');

    const position = positionFrom(battle);
    const requestMoves = position.request.active?.[0]?.moves || [];
    expect(requestMoves[1].disabled).toBe(true);
    const live = strictLegalActions(position.request).filter(action => action.type === 'move');
    expect(live.some(action => action.type === 'move' && action.moveIndex === 2)).toBe(false);
    expect(live.some(action => action.type === 'move' && action.moveIndex === 1)).toBe(true);

    const built = buildDecisionBattle(position);
    expect(built).not.toBeNull();
    if (!built) return;
    const root = appendTeraChoices(built, 'p1', legalChoices(built, 'p1'));
    for (const choice of root) {
      if (!choice.startsWith('move ')) continue;
      const slot = moveSlotIndex(choice);
      expect(requestMoves[slot]?.disabled).not.toBe(true);
    }

    const impl = createHybridSearch(HybridParamsSchema.parse({}) as never);
    const picked = await chooseLive('hybrid', position, strictLegalActions(position.request), {
      decide: async input => {
        const offered = appendTeraChoices(input.battle, 'p1', legalChoices(input.battle, 'p1'));
        const trace = await impl.search(input.battle, 'p1', {
          evaluate: {} as never,
          behavior: {} as never,
          plan: null,
          rng: new PRNG([4, 5, 6, 7] as never),
          hybrid: HybridParamsSchema.parse({
            worlds: 2,
            samples: 1,
            plan: false,
            opponent: false,
            judgment: false,
            tera: true,
          }),
          randbats: wideStats(),
          llmAllowed: false,
          deadlineMs: Date.now() + 8000,
        });
        expect(offered.includes(trace.choice) || trace.choice === 'default').toBe(true);
        if (trace.choice.startsWith('move ')) {
          expect(moveSlotIndex(trace.choice)).not.toBe(1);
        }
        return trace;
      },
    });
    const sent = formatChoice(picked.action);
    expect(liveAllows(sent, position.request)).toBe(true);
    if (picked.action.type === 'move') expect(picked.action.moveIndex).not.toBe(2);
  }, 20000);

  it('plays hidden self-play with zero invalid choices', async () => {
    const dir = process.env.JEV_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-choice-'));
    process.env.JEV_DATA_DIR = dir;
    const stats = wideStats();
    const sets: Record<string, { level: number }> = {};
    for (const name of Object.keys(stats)) sets[name] = { level: 80 };
    fs.writeFileSync(path.join(dir, 'gen9-stats.json'), JSON.stringify(stats));
    fs.writeFileSync(path.join(dir, 'gen9-sets.json'), JSON.stringify(sets));
    DataLoader.resetForTests();
    const bot = specForAlias('hybrid-core', 'selfplay');
    let invalid = 0;
    for (const seed of [11, 17]) {
      const teams = teamsForSeed(seed);
      const result = await runGame({
        index: seed,
        seed,
        p1Team: teams.p1,
        p2Team: teams.p2,
        p1: bot,
        p2: { kind: 'maxdamage' },
        information: 'hidden',
      });
      expect(result.crashed).toBe(false);
      invalid += result.p1Invalid + result.p2Invalid;
    }
    expect(invalid).toBe(0);
  }, 180000);
});
