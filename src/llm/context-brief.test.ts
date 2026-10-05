import { describe, expect, it } from '@jest/globals';
import { startRandomBattle, teamsForSeed } from '../engine/exact/battle-utils.js';
import { BRIEF_SECTIONS, renderContextBrief } from './context-brief.js';

function hiddenFoeNames(seed: number): { text: string; hidden: string[]; active: string } {
  const teams = teamsForSeed(seed);
  const battle = startRandomBattle(teams.p1, teams.p2, seed);
  const brief = renderContextBrief(battle, 'p1', 2000);
  const ours = new Set(battle.getSide('p1').pokemon.map(mon => mon.species.name.toLowerCase()));
  const active = battle.getSide('p2').active[0]?.species.name.toLowerCase() || '';
  const hidden = battle.getSide('p2').pokemon
    .map(mon => mon.species.name)
    .filter(name => {
      const low = name.toLowerCase();
      if (low === active) return false;
      if (ours.has(low)) return false;
      return ![...ours, active].some(known => known.includes(low) || low.includes(known));
    });
  return { text: brief.text.toLowerCase(), hidden, active };
}

describe('context brief', () => {
  it('includes the situation sections and stays inside the token budget', () => {
    const teams = teamsForSeed(4);
    const battle = startRandomBattle(teams.p1, teams.p2, 4);
    const brief = renderContextBrief(battle, 'p1', 800);
    expect(brief.sections).toEqual([...BRIEF_SECTIONS]);
    expect(brief.truncated).toBe(false);
    expect(brief.text.length).toBeLessThanOrEqual(800 * 4);
    expect(brief.text).toContain('unrevealed=');
    expect(brief.text).toContain('fitted high-Elo switch model');
  });

  it('does not name opponent pokemon that have not entered', () => {
    const { text, hidden, active } = hiddenFoeNames(6);
    expect(active.length).toBeGreaterThan(0);
    expect(text).toContain(active);
    expect(hidden.length).toBeGreaterThan(0);
    for (const name of hidden) {
      expect(text).not.toContain(name.toLowerCase());
    }
  });

  it('line form names both actives and stays inside the plan budget', () => {
    const teams = teamsForSeed(4);
    const battle = startRandomBattle(teams.p1, teams.p2, 4);
    const brief = renderContextBrief(battle, 'p1', 320, 'lines');
    const us = battle.getSide('p1').active[0]?.species.name || '';
    const them = battle.getSide('p2').active[0]?.species.name || '';
    expect(us.length).toBeGreaterThan(0);
    expect(brief.sections).toContain('sides');
    expect(brief.text).toContain(us);
    expect(brief.text).toContain(them);
    expect(brief.text.length).toBeLessThanOrEqual(320 * 4);
    expect(brief.text.startsWith('sides:')).toBe(true);
  });

  it('plan form is the actives, the bench, and the field', () => {
    const teams = teamsForSeed(4);
    const battle = startRandomBattle(teams.p1, teams.p2, 4);
    const brief = renderContextBrief(battle, 'p1', 320, 'plan');
    const us = battle.getSide('p1').active[0]?.species.name || '';
    const them = battle.getSide('p2').active[0]?.species.name || '';
    expect(brief.sections).toEqual(['sides', 'bench', 'field']);
    expect(brief.text).toContain(us);
    expect(brief.text).toContain(them);
    expect(brief.text).not.toContain('moves=');
    expect(brief.text.length).toBeLessThanOrEqual(320 * 4);
  });

  it('drops sections that do not fit the budget', () => {
    const teams = teamsForSeed(4);
    const battle = startRandomBattle(teams.p1, teams.p2, 4);
    const brief = renderContextBrief(battle, 'p1', 40);
    expect(brief.truncated).toBe(true);
    expect(brief.sections.length).toBeLessThan(BRIEF_SECTIONS.length);
    expect(brief.text.length).toBeLessThanOrEqual(40 * 4);
  });

  it('no-key harness renders generated battles without a gateway', () => {
    const savedGateway = process.env.VERCEL_AI_GATEWAY_KEY;
    const savedAlt = process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_AI_GATEWAY_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    try {
      for (const seed of [1, 2, 3, 8, 9]) {
        const teams = teamsForSeed(seed);
        const battle = startRandomBattle(teams.p1, teams.p2, seed);
        const brief = renderContextBrief(battle, seed % 2 === 0 ? 'p2' : 'p1');
        expect(brief.sections).toEqual([...BRIEF_SECTIONS]);
        expect(brief.text).toContain('## damage');
        expect(brief.text).toContain('## switch');
        expect(brief.text).not.toMatch(/sk-|api[_-]?key/i);
      }
    } finally {
      if (savedGateway !== undefined) process.env.VERCEL_AI_GATEWAY_KEY = savedGateway;
      if (savedAlt !== undefined) process.env.AI_GATEWAY_API_KEY = savedAlt;
    }
  });
});
