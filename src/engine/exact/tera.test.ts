import { Dex, PRNG } from '@pkmn/sim';
import * as path from 'path';
import { loadConfig } from '../../config/load.js';
import { buildDecisionBattle, actionFromChoice } from '../../client/decision-battle.js';
import { strictLegalActions } from '../../client/choice.js';
import { ladderPolicy } from '../../client/ladder-engine.js';
import {
  appendTeraChoices,
  cloneBattle,
  legalChoices,
  playChoices,
  startRandomBattle,
  teamsForSeed,
} from './battle-utils.js';
import { specFromId } from './policies.js';
import {
  EXACT_1PLY,
  EXACT_TERA_1PLY,
  exactSearch,
  teraHoldChoice,
  type TeraLine,
} from './search.js';

const CHAMPION_CONFIG_ID = '064cad7ec4ed0241';

function open(seed: number) {
  const teams = teamsForSeed(seed);
  const battle = startRandomBattle(teams.p1, teams.p2, seed);
  if (battle.requestState === 'teampreview') battle.makeChoices('default', 'default');
  return battle;
}

function line(choice: string, score: number, koRate = 0, survivalRate = 1): TeraLine {
  return { choice, score, koRate, survivalRate, playedRate: 1 };
}

/** A move that neither deals damage nor spends the turn on Substitute. */
function splashSlot() {
  return {
    id: 'splash',
    move: 'Splash',
    pp: 16,
    maxpp: 16,
    target: 'self',
    disabled: false,
    used: false,
  };
}

function replaceMoves(mon: { moveSlots: Array<{ id: string }>; baseMoveSlots: Array<{ id: string }> }, keepIds: string[]) {
  const next = mon.moveSlots.map(slot => (keepIds.includes(slot.id) ? slot : splashSlot()));
  mon.moveSlots.splice(0, mon.moveSlots.length, ...(next as typeof mon.moveSlots));
  mon.baseMoveSlots.splice(0, mon.baseMoveSlots.length, ...(next as typeof mon.baseMoveSlots));
}

describe('tera hold', () => {
  const early = { turn: 4, opponentTerastallized: false };
  const lateUnspent = { turn: 20, opponentTerastallized: false };
  const lateSpent = { turn: 20, opponentTerastallized: true };

  it('keeps Tera before turn 10 unless a KO or a survival flips', () => {
    const held = [
      line('move 1', 1),
      line('move 1 terastallize', 3),
    ];
    expect(teraHoldChoice(held, early, EXACT_TERA_1PLY)).toBe('move 1');

    const ko = [
      line('move 1', 1, 0, 1),
      line('move 1 terastallize', 1.2, 1, 1),
    ];
    expect(teraHoldChoice(ko, early, EXACT_TERA_1PLY)).toBe('move 1 terastallize');

    const save = [
      line('move 1', 2, 0, 0),
      line('move 1 terastallize', 0.4, 0, 1),
    ];
    expect(teraHoldChoice(save, early, EXACT_TERA_1PLY)).toBe('move 1 terastallize');
  });

  it('requires a full mon of HP while the opponent still has Tera', () => {
    const small = [
      line('move 1', 0),
      line('move 2 terastallize', 0.6),
    ];
    expect(teraHoldChoice(small, lateUnspent, EXACT_TERA_1PLY)).toBe('move 1');
    const clear = [
      line('move 1', 0),
      line('move 2 terastallize', 1),
    ];
    expect(teraHoldChoice(clear, lateUnspent, EXACT_TERA_1PLY)).toBe('move 2 terastallize');
  });

  it('uses the smaller margin after the opponent has Terastallized', () => {
    const lines = [
      line('move 1', 0),
      line('move 1 terastallize', 0.5),
    ];
    expect(teraHoldChoice(lines, lateSpent, EXACT_TERA_1PLY)).toBe('move 1 terastallize');
    expect(teraHoldChoice(lines, lateUnspent, EXACT_TERA_1PLY)).toBe('move 1');
  });

  it('refuses a Tera line the sim did not play', () => {
    const lines = [
      line('move 1', 0, 0, 1),
      { ...line('move 1 terastallize', 5, 1, 1), playedRate: 0 },
    ];
    expect(teraHoldChoice(lines, lateSpent, EXACT_TERA_1PLY)).toBe('move 1');
  });

  it('leaves the champion path alone', () => {
    expect(teraHoldChoice([line('move 2', 4), line('move 1', 1)], early, EXACT_1PLY)).toBe('move 2');
  });
});

describe('exact search tera choices', () => {
  it('does not change the champion config or its seed-7 choice', () => {
    const champion = loadConfig(path.join(process.cwd(), 'configs/champion.yaml'));
    expect(champion.configId).toBe(CHAMPION_CONFIG_ID);
    expect(champion.config.search.params.tera).toBeUndefined();

    const battle = open(7);
    const trace = exactSearch(battle, 'p1', EXACT_1PLY);
    expect(trace.choice).toBe('move 1');
    expect(trace.scores.every(row => !row.choice.includes('terastallize'))).toBe(true);
    expect(trace.scores.map(row => row.choice)).toEqual(legalChoices(battle, 'p1'));
  });

  it('adds a terastallize choice for each legal move and the sim changes type', () => {
    const battle = open(7);
    const plain = legalChoices(battle, 'p1');
    const moves = plain.filter(choice => /^move \d+$/.test(choice));
    const withTera = appendTeraChoices(battle, 'p1', plain);
    expect(withTera.filter(choice => choice.endsWith(' terastallize'))).toEqual(
      moves.map(choice => `${choice} terastallize`),
    );
    expect(legalChoices(battle, 'p1')).toEqual(plain);

    const active = battle.p1.active[0];
    const teraType = active.teraType;
    const matching = moves.find(choice => {
      const id = active.moveSlots[Number(choice.slice(5)) - 1]?.id;
      return id && Dex.moves.get(id).type === teraType;
    });
    expect(matching).toBeTruthy();

    const foe = battle.p2.active[0];
    replaceMoves(foe, []);
    foe.item = '';
    foe.set.item = '';
    battle.makeRequest('move');
    const before = foe.hp;
    const branched = cloneBattle(battle);
    expect(playChoices(branched, 'p1', `${matching} terastallize`, 'move 1')).toBe(true);
    const after = branched.p1.active[0];
    expect(after.terastallized).toBe(teraType);
    expect(after.getTypes()).toEqual([teraType]);
    expect(branched.p2.active[0].hp).toBeLessThan(before);

    const plainBranch = cloneBattle(battle);
    expect(playChoices(plainBranch, 'p1', matching!, 'move 1')).toBe(true);
    expect(plainBranch.p1.active[0].terastallized).toBeFalsy();
    expect(branched.p2.active[0].hp).toBeLessThan(plainBranch.p2.active[0].hp);
  });

  it('holds Tera on turn 1 when the foe is already at 1 HP and we are safe', () => {
    const battle = open(7);
    const us = battle.p1.active[0];
    const foe = battle.p2.active[0];
    us.boosts.def = 6;
    us.boosts.spd = 6;
    foe.boosts.atk = -6;
    foe.boosts.spa = -6;
    foe.hp = 1;
    const trace = exactSearch(battle, 'p1', { ...EXACT_TERA_1PLY, samples: 1 });
    expect(trace.scores.some(row => row.choice.includes('terastallize'))).toBe(true);
    expect(trace.choice.includes('terastallize')).toBe(false);
  });

  it('Terastallizes when that is what KOs and the plain move does not', () => {
    const battle = open(7);
    const us = battle.p1.active[0];
    const foe = battle.p2.active[0];
    const moves = legalChoices(battle, 'p1').filter(choice => /^move \d+$/.test(choice));
    const matching = moves.find(choice => {
      const id = us.moveSlots[Number(choice.slice(5)) - 1]?.id;
      return id && Dex.moves.get(id).type === us.teraType;
    });
    if (!matching) throw new Error('seed 7 active has no move of its tera type');
    const matchingId = us.moveSlots[Number(matching.slice(5)) - 1].id;

    replaceMoves(us, [matchingId]);
    replaceMoves(foe, []);
    foe.item = '';
    foe.set.item = '';
    battle.makeRequest('move');
    expect(foe.moveSlots.map(slot => slot.id)).toEqual(['splash', 'splash', 'splash', 'splash']);
    expect(us.moveSlots.map(slot => slot.id).filter(id => id !== 'splash')).toEqual([matchingId]);

    const damage = (choice: string) => {
      const copy = cloneBattle(battle);
      copy.resetRNG(new PRNG([1, 0x6d2b79f5, 0x1b873593, 0x85ebca6b] as never).startingSeed);
      const hp = copy.p2.active[0].hp;
      playChoices(copy, 'p1', choice, 'move 1');
      return hp - copy.p2.active[0].hp;
    };
    const plainDamage = damage(matching);
    const teraDamage = damage(`${matching} terastallize`);
    expect(teraDamage).toBeGreaterThan(plainDamage);
    foe.hp = plainDamage + 1;
    battle.turn = 3;
    const trace = exactSearch(battle, 'p1', { ...EXACT_TERA_1PLY, samples: 1 });
    expect(trace.choice).toBe(`${matching} terastallize`);
  });
});

describe('live request tera type', () => {
  it('copies our teraType from the request and a revealed foe Tera', () => {
    const battle = open(11);
    const request = battle.p1.activeRequest as { side: { pokemon: Array<{ teraType?: string }> } };
    const expected = request.side.pokemon[0].teraType;
    expect(expected).toBe(battle.p1.active[0].teraType);
    const foe = battle.p2.active[0];
    const built = buildDecisionBattle({
      request,
      foeActive: {
        species: foe.species.name,
        level: foe.level,
        hp: foe.hp,
        maxhp: foe.maxhp,
        moves: foe.moveSlots.map(slot => slot.id),
        terastallized: 'Ghost',
      },
      foeBench: [],
      turn: 14,
    });
    expect(built).not.toBeNull();
    expect(built?.turn).toBe(14);
    if (!built) return;
    expect(built.p1.active[0].teraType).toBe(expected);
    expect(built.p1.active[0].canTerastallize).toBe(expected);
    expect(built.p1.active[0].terastallized).toBeFalsy();
    expect(built.p2.active[0].terastallized).toBe('Ghost');
    expect(built.p2.active[0].getTypes()).toEqual(['Ghost']);
    expect(built.p2.active[0].canTerastallize).toBeNull();
    const req = built.p1.activeRequest as { active?: Array<{ canTerastallize?: string }> };
    expect(req.active?.[0]?.canTerastallize).toBe(expected);

    const spent = JSON.parse(JSON.stringify(request));
    spent.side.pokemon[0].terastallized = expected;
    const locked = buildDecisionBattle({
      request: spent,
      foeActive: {
        species: foe.species.name,
        level: foe.level,
        hp: foe.hp,
        maxhp: foe.maxhp,
        moves: foe.moveSlots.map(slot => slot.id),
      },
      foeBench: [],
    });
    expect(locked?.p1.active[0].terastallized).toBe(expected);
    expect(locked?.p1.active[0].getTypes()).toEqual([expected]);
    expect(locked?.p1.active[0].canTerastallize).toBeNull();
  });

  it('does not offer Tera when the live request omitted it', () => {
    const battle = open(7);
    const request = JSON.parse(JSON.stringify(battle.p1.activeRequest));
    delete request.active[0].canTerastallize;
    const foe = battle.p2.active[0];
    const built = buildDecisionBattle({
      request,
      foeActive: {
        species: foe.species.name,
        level: foe.level,
        hp: foe.hp,
        maxhp: foe.maxhp,
        moves: foe.moveSlots.map(slot => slot.id),
      },
      foeBench: [],
    });
    expect(built).not.toBeNull();
    const again = built?.p1.activeRequest as { active?: Array<{ canTerastallize?: string }> };
    expect(again.active?.[0]?.canTerastallize).toBeFalsy();
    expect(legalChoices(built!, 'p1', { tera: true }).some(choice => choice.includes('terastallize'))).toBe(false);
  });

  it('parses a terastallize choice and keeps the champion ladder policy', () => {
    expect(actionFromChoice('move 2 terastallize')).toEqual({ type: 'move', moveIndex: 2, terastallize: true });
    expect(ladderPolicy('search')).toEqual(specFromId('champion-exact-1ply'));
    expect(ladderPolicy('exact-tera')).toEqual(specFromId('challenger-exact-tera-1ply'));
    const policy = ladderPolicy('exact-tera');
    expect(policy).toEqual({ kind: 'exact', config: EXACT_TERA_1PLY });
    const battle = open(7);
    const request = battle.p1.activeRequest;
    const legal = strictLegalActions(request);
    expect(legal.some(action => action.type === 'move' && action.terastallize)).toBe(true);
    expect(legal[0]).toEqual({ type: 'move', moveIndex: 1 });
  });
});

describe('tera config', () => {
  it('is a different config from the champion and turns the flag on', () => {
    const champion = loadConfig(path.join(process.cwd(), 'configs/champion.yaml'));
    const tera = loadConfig(path.join(process.cwd(), 'configs/challengers/exact-tera-1ply.yaml'));
    expect(tera.config.search.params.tera).toBe(true);
    expect(tera.config.search.params.samples).toBe(8);
    expect(tera.configId).not.toBe(champion.configId);
    expect(tera.config.policies.teraPolicy.id).toBe('off');
    const example = loadConfig(path.join(process.cwd(), 'configs/examples/search-exact-tera.yaml'));
    expect(example.config.search.params.tera).toBe(true);
  });
});
