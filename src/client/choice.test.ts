import {
  formatChoice,
  isActionLegal,
  legalActionsForRequest,
  pickBestLegal,
  strictLegalActions,
  teamPreviewChoice,
} from './choice.js';
import { parseRatingLine, parseReplayUrl } from './showdown-client.js';
import { redactSecrets } from './ids.js';
import { gen9RandomBattle } from '../formats/gen9-randombattle.js';
import { GameState } from '../types/index.js';

function request(extra: Record<string, unknown> = {}) {
  return {
    rqid: 2,
    side: {
      id: 'p1',
      pokemon: [
        { ident: 'p1: A', details: 'A', condition: '100/100', active: true },
        { ident: 'p1: B', details: 'B', condition: '80/100', active: false },
        { ident: 'p1: C', details: 'C', condition: '0 fnt', active: false },
      ],
    },
    active: [{
      moves: [
        { move: 'Tackle', id: 'tackle', pp: 35, maxpp: 35, target: 'normal', disabled: false },
        { move: 'Growl', id: 'growl', pp: 0, maxpp: 40, target: 'normal', disabled: false },
        { move: 'Splash', id: 'splash', pp: 40, maxpp: 40, target: 'self', disabled: true },
      ],
      canTerastallize: 'Fire',
    }],
    ...extra,
  };
}

describe('choice validation', () => {
  it('drops disabled, pp-less, and trapped switches', () => {
    const legal = strictLegalActions(request());
    expect(legal).toEqual([
      { type: 'move', moveIndex: 1 },
      { type: 'switch', switchIndex: 2 },
    ]);
    expect(isActionLegal({ type: 'move', moveIndex: 2 }, request())).toBe(false);
    expect(isActionLegal({ type: 'move', moveIndex: 1, terastallize: true }, request())).toBe(true);
  });

  it('refuses switches when maybeTrapped', () => {
    const trapped = request();
    (trapped.active[0] as any).maybeTrapped = true;
    const legal = legalActionsForRequest(trapped, gen9RandomBattle);
    expect(legal.every(action => action.type === 'move')).toBe(true);
    expect(isActionLegal({ type: 'switch', switchIndex: 2 }, trapped)).toBe(false);
  });

  it('revival blessing passes to a fainted pokemon', () => {
    const forced = {
      rqid: 54,
      forceSwitch: [true],
      side: {
        pokemon: [
          { ident: 'p1: Rabsca', condition: '59/284', active: true, reviving: true },
          { ident: 'p1: Umbreon', condition: '0 fnt', active: false },
          { ident: 'p1: Lugia', condition: '149/275', active: false },
        ],
      },
    };
    expect(legalActionsForRequest(forced, gen9RandomBattle)).toEqual([
      { type: 'switch', switchIndex: 2 },
    ]);
    expect(isActionLegal({ type: 'switch', switchIndex: 3 }, forced)).toBe(false);
  });

  it('only offers switches on a force switch', () => {
    const forced = {
      rqid: 4,
      forceSwitch: [true],
      side: request().side,
    };
    const legal = strictLegalActions(forced);
    expect(legal).toEqual([{ type: 'switch', switchIndex: 2 }]);
    expect(formatChoice(legal[0], 4)).toBe('switch 2|4');
  });

  it('does not invent a move for wait or team preview', () => {
    expect(legalActionsForRequest({ wait: true, rqid: 1 }, gen9RandomBattle)).toEqual([]);
    expect(teamPreviewChoice({ teamPreview: true, rqid: 1, side: { pokemon: [{}, {}, {}] } })).toBe('team 123|1');
  });

  it('formats tera and keeps a single legal move', () => {
    expect(formatChoice({ type: 'move', moveIndex: 1, terastallize: true }, 3)).toBe('move 1 terastallize|3');
    const state = { myTeam: [], opponentTeam: [], myActive: 0, opponentActive: 0 } as unknown as GameState;
    expect(pickBestLegal(state, [{ type: 'move', moveIndex: 1 }])).toEqual({ type: 'move', moveIndex: 1 });
  });
});

describe('login and result parsing', () => {
  it('redacts secrets', () => {
    expect(redactSecrets('pass=hunter2&challstr=4|abc&assertion=xyz')).toBe('pass=***&challstr=***&assertion=***');
  });

  it('reads elo and replay urls from server text', () => {
    const rating = parseRatingLine(
      `|raw|BotAlpha's rating: 1000 &rarr; <strong>1016</strong><br />(+16 for winning)`,
    );
    expect(rating).toEqual({ username: 'BotAlpha', before: 1000, after: 1016 });
    expect(parseReplayUrl('https://replay.pokemonshowdown.com/gen9randombattle-123')).toEqual({
      id: 'gen9randombattle-123',
      url: 'https://replay.pokemonshowdown.com/gen9randombattle-123',
    });
  });
});
