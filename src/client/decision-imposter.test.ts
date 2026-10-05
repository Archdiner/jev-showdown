import { legalChoices } from '../engine/exact/battle-utils.js';
import { buildDecisionBattle, type LivePosition } from './decision-battle.js';

describe('decision battle Imposter', () => {
  it('does not invent foe moves when live Ditto request is Transform-only', () => {
    const position: LivePosition = {
      request: {
        active: [
          {
            moves: [{ move: 'Transform', id: 'transform', pp: 16, maxpp: 16, disabled: false }],
            canTerastallize: 'Steel',
          },
        ],
        side: {
          id: 'p1',
          name: 'P1',
          pokemon: [
            {
              ident: 'p1: Ditto',
              details: 'Ditto, L87',
              condition: '17/225',
              active: true,
              moves: ['transform'],
              baseAbility: 'imposter',
              ability: 'imposter',
              item: 'choicescarf',
              teraType: 'Steel',
            },
            {
              ident: 'p1: Magikarp',
              details: 'Magikarp, L80',
              condition: '100/100',
              active: false,
              moves: ['splash'],
              ability: 'swiftswim',
            },
          ],
        },
      },
      foeActive: {
        species: 'Tropius',
        level: 88,
        hp: 200,
        maxhp: 280,
        ability: 'harvest',
        item: 'sitrusberry',
        moves: ['airslash', 'protect', 'substitute', 'leechseed'],
      },
      foeBench: [],
    };

    const battle = buildDecisionBattle(position);
    expect(battle).not.toBeNull();
    const legal = legalChoices(battle!, 'p1', { tera: true });
    expect(legal.filter(c => c.startsWith('move'))).toEqual(['move 1', 'move 1 terastallize']);
    const active = battle!.p1.active[0];
    expect(active.species.name).toBe('Ditto');
    expect(active.moveSlots.map(slot => slot.id)).toEqual(['transform']);
  });
});
