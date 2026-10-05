import { attributePopup } from './delivery.js';

describe('popup attribution', () => {
  const rooms = ['battle-gen9randombattle-1', 'battle-gen9randombattle-10'];

  it('matches a room id and does not treat a shorter id as a prefix', () => {
    expect(attributePopup('see battle-gen9randombattle-10', rooms)).toEqual({
      attribution: 'matched',
      roomId: 'battle-gen9randombattle-10',
    });
    expect(attributePopup('replay gen9randombattle-1', rooms)).toEqual({
      attribution: 'matched',
      roomId: 'battle-gen9randombattle-1',
    });
  });

  it('uses the only open room', () => {
    expect(attributePopup('Battle timer is ON', ['battle-gen9randombattle-1'])).toEqual({
      attribution: 'only-open',
      roomId: 'battle-gen9randombattle-1',
    });
  });

  it('refuses to guess when several battles are open', () => {
    expect(attributePopup('Battle timer is ON', rooms)).toEqual({
      attribution: 'ambiguous',
      candidates: rooms,
    });
  });

  it('matches a replay url whose password follows the battle id', () => {
    const url = 'https://replay.pokemonshowdown.com/gen9randombattle-10-vf14y87snr046p0x7g86l2ffrf1912epw';
    expect(attributePopup(url, rooms)).toEqual({
      attribution: 'matched',
      roomId: 'battle-gen9randombattle-10',
    });
  });

  it('does not file a popup that names some other battle', () => {
    const url = 'https://replay.pokemonshowdown.com/gen9randombattle-99-abc';
    expect(attributePopup(url, rooms)).toEqual({ attribution: 'elsewhere', candidates: [] });
    expect(attributePopup(url, ['battle-gen9randombattle-1'])).toEqual({
      attribution: 'elsewhere',
      candidates: [],
    });
  });
});
