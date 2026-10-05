import * as path from 'path';
import { legalChoices, safeChoose, startRandomBattle, teamsForSeed } from '../engine/exact/battle-utils.js';
import { LocalServerAdapter, SelfplayAdapter } from './adapters.js';
import { buildBot } from './bot.js';
import { loadConfig } from './load.js';

describe('selfplay and local-server adapters', () => {
  it('returns the same choice and configId from one seeded state', async () => {
    const loaded = loadConfig(path.join(process.cwd(), 'configs/champion.yaml'));
    const selfBot = buildBot(loaded, 'selfplay');
    const localBot = buildBot(loaded, 'local');
    expect(selfBot.configId).toBe(localBot.configId);
    expect(selfBot.env.timeLimitMs).not.toBe(localBot.env.timeLimitMs);

    const teams = teamsForSeed(11);
    const battle = startRandomBattle(teams.p1, teams.p2, 11);
    const self = new SelfplayAdapter(selfBot);
    const local = new LocalServerAdapter(localBot);

    const firstSelf = await self.decide(battle, 'p1');
    const firstLocal = await local.decideFromInputLog(battle.inputLog.join('\n'), 'p1');
    expect(firstLocal.choice).toBe(firstSelf.choice);
    expect(firstLocal.configId).toBe(firstSelf.configId);
    expect(firstLocal.layerIds).toEqual(firstSelf.layerIds);

    const p2 = legalChoices(battle, 'p2');
    expect(p2.length).toBeGreaterThan(0);
    const second = await self.decide(battle, 'p2');
    safeChoose(battle, 'p1', firstSelf.choice);
    safeChoose(battle, 'p2', second.choice);

    const laterSelf = await self.decide(battle, 'p1');
    const laterLocal = await local.decideFromInputLog(battle.inputLog.join('\n'), 'p1');
    expect(laterLocal.choice).toBe(laterSelf.choice);
    expect(laterLocal.configId).toBe(firstSelf.configId);
    expect(laterSelf.overBudget).toBe(false);
  }, 60000);
});
