import type { Battle } from '@pkmn/sim';
import { fallbackChoice, LadderSession } from './adapters.js';
import type { BuiltBot } from './bot.js';

const request = {
  active: [{ moves: [{ disabled: false }] }],
  side: { pokemon: [{ active: true, condition: '100/100' }] },
};

function bot(decide: BuiltBot['decide']): BuiltBot {
  return { decide } as BuiltBot;
}

describe('ladder choice fallback', () => {
  test('a missing sim still sends the first legal move', async () => {
    const session = new LadderSession(bot(async () => {
      throw new Error('decide should not run without a battle');
    }), { reconstruct: () => null });
    const delivered = await session.onRequest('battle-1', request, '', 'p1');
    expect(delivered).toEqual({ choice: 'move 1', fallback: true });
    expect(fallbackChoice(request)).toBe('move 1');
  });

  test('an illegal choice is replaced with a legal one', async () => {
    const session = new LadderSession(bot(async () => ({
      choice: 'switch 9',
      configId: 'cfg',
      layerIds: {} as never,
      activeLayerIds: {} as never,
      scores: [],
      ms: 1,
      advisorCalled: false,
      overBudget: false,
      gamePlan: null,
    })), { reconstruct: () => ({}) as Battle });
    const delivered = await session.onRequest('battle-1', request, '', 'p1');
    expect(delivered).toEqual({ choice: 'move 1', fallback: true });
  });

  test('a terastallize choice the request allows is sent as the config decision', async () => {
    const teraRequest = {
      active: [{
        canTerastallize: 'Fire',
        moves: [{ disabled: false }, { disabled: false }],
      }],
      side: { pokemon: [{ active: true, condition: '100/100' }] },
    };
    const session = new LadderSession(bot(async () => ({
      choice: 'move 2 terastallize',
      configId: 'cfg',
      layerIds: {} as never,
      activeLayerIds: {} as never,
      scores: [],
      ms: 1,
      advisorCalled: false,
      overBudget: false,
      gamePlan: null,
    })), { reconstruct: () => ({}) as Battle });
    const delivered = await session.onRequest('battle-local-1', teraRequest, '', 'p1');
    expect(delivered).toEqual({ choice: 'move 2 terastallize', fallback: false });
  });

  test('a terastallize choice is a fallback when the request cannot tera', async () => {
    const session = new LadderSession(bot(async () => ({
      choice: 'move 1 terastallize',
      configId: 'cfg',
      layerIds: {} as never,
      activeLayerIds: {} as never,
      scores: [],
      ms: 1,
      advisorCalled: false,
      overBudget: false,
      gamePlan: null,
    })), { reconstruct: () => ({}) as Battle });
    const delivered = await session.onRequest('battle-1', request, '', 'p1');
    expect(delivered).toEqual({ choice: 'move 1', fallback: true });
  });

  test('a legal decide result is sent as itself', async () => {
    const session = new LadderSession(bot(async () => ({
      choice: 'move 1',
      configId: 'cfg',
      layerIds: {} as never,
      activeLayerIds: {} as never,
      scores: [],
      ms: 1,
      advisorCalled: false,
      overBudget: false,
      gamePlan: null,
    })), { reconstruct: () => ({}) as Battle });
    const delivered = await session.onRequest('battle-1', request, '', 'p1');
    expect(delivered).toEqual({ choice: 'move 1', fallback: false });
  });

  test('a wait request sends nothing', async () => {
    const session = new LadderSession(bot(async () => {
      throw new Error('wait');
    }));
    const delivered = await session.onRequest('battle-1', { wait: true }, '', 'p1');
    expect(delivered).toEqual({ choice: null, fallback: false });
  });
});
