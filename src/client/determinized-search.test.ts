import { describe, it, expect, beforeAll } from 'vitest';
import { teamsForSeed, startRandomBattle, legalChoices, safeChoose } from '../engine/exact/battle-utils.js';
import { livePositionFromClient } from './live-position.js';
import { chooseDeterminized } from './decision-battle.js';
import { dataLoader } from '../data/data-loader.js';
import { Battle as ClientBattle } from '@pkmn/client';
import { Generations } from '@pkmn/data';
import { Dex } from '@pkmn/dex';
import { EXACT_DET_1PLY } from '../engine/exact/search.js';

describe('determinized search choice validity', () => {
  beforeAll(async () => {
    await dataLoader.load();
  });

  it('returns valid choices after several turns', async () => {
    const teams = teamsForSeed(42);
    const battle = startRandomBattle(teams.p1, teams.p2, 42);
    
    // Play a few turns
    for (let i = 0; i < 3; i++) {
      const p1Choices = legalChoices(battle, 'p1');
      const p2Choices = legalChoices(battle, 'p2');
      if (p1Choices.length) safeChoose(battle, 'p1', p1Choices[0]);
      if (p2Choices.length) safeChoose(battle, 'p2', p2Choices[0]);
      if (battle.ended) break;
    }
    
    if (battle.ended) return; // Test another seed
    
    // Build LivePosition from protocol
    const gens = new Generations(Dex);
    const client = new ClientBattle(gens);
    for (const line of battle.log) {
      if (typeof line === 'string') {
        try {
          client.add(line);
        } catch {
          // skip
        }
      }
    }
    
    const request = battle.p1.activeRequest;
    if (request) {
      try {
        client.add(`|request|${JSON.stringify(request)}`);
      } catch {
        // skip
      }
    }
    
    const position = livePositionFromClient(client, request, 'p1');
    
    // Get choice from determinized search
    const result = await chooseDeterminized(position, EXACT_DET_1PLY, dataLoader.getStats());
    
    // Check if choice is legal for the real request
    const realLegal = legalChoices(battle, 'p1');
    expect(realLegal).toContain(result.choice);
    
    client.destroy();
  });

  it('handles forced switch correctly', async () => {
    const teams = teamsForSeed(100);
    const battle = startRandomBattle(teams.p1, teams.p2, 100);
    
    // Force a knockout
    const p1Active = battle.p1.active[0];
    if (p1Active) {
      p1Active.hp = 0;
      p1Active.fainted = true;
      p1Active.switchFlag = true;
      battle.p1.pokemonLeft = battle.p1.pokemon.filter(m => !m.fainted).length;
      battle.makeRequest('switch');
    }
    
    const realLegal = legalChoices(battle, 'p1');
    expect(realLegal.every(c => c.startsWith('switch'))).toBe(true);
    
    // Build LivePosition
    const gens = new Generations(Dex);
    const client = new ClientBattle(gens);
    for (const line of battle.log) {
      if (typeof line === 'string') {
        try {
          client.add(line);
        } catch {
          // skip
        }
      }
    }
    
    const request = battle.p1.activeRequest;
    if (!request) return;
    
    try {
      client.add(`|request|${JSON.stringify(request)}`);
    } catch {
      // skip
    }
    
    const position = livePositionFromClient(client, request, 'p1');
    const result = await chooseDeterminized(position, EXACT_DET_1PLY, dataLoader.getStats());
    
    expect(realLegal).toContain(result.choice);
    expect(result.choice).toMatch(/^switch /);
    
    client.destroy();
  });
});
