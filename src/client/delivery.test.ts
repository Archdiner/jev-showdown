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
});
