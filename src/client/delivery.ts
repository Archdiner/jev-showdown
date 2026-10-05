export type PopupAttribution =
  | { attribution: 'matched' | 'only-open'; roomId: string }
  | { attribution: 'ambiguous'; candidates: string[] }
  | { attribution: 'elsewhere'; candidates: [] };

const NAMED_BATTLE = /(?:battle-)?gen\d+[a-z0-9]*-\d+/i;

function mentionsId(message: string, id: string): boolean {
  if (!id) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A replay URL continues `-{password}` after the battle id. Hyphen is a
  // boundary. A following digit is not, so battle 1 does not match battle 10.
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(message);
}

function mentionsRoom(message: string, roomId: string): boolean {
  if (mentionsId(message, roomId)) return true;
  const bare = roomId.startsWith('battle-') ? roomId.slice('battle-'.length) : '';
  return bare !== '' && mentionsId(message, bare);
}

/**
 * Pick the battle a global popup belongs to.
 * A room id in the text wins, including a replay URL whose password follows
 * the id. A named battle that is not open is left alone. One open battle and
 * no id is unambiguous. Several open battles and no id is ambiguous — do not
 * guess the latest room.
 */
export function attributePopup(message: string, openRoomIds: string[]): PopupAttribution {
  const mentioned = openRoomIds.filter(roomId => mentionsRoom(message, roomId));
  if (mentioned.length === 1) return { attribution: 'matched', roomId: mentioned[0] };
  if (mentioned.length === 0 && NAMED_BATTLE.test(message)) {
    return { attribution: 'elsewhere', candidates: [] };
  }
  if (openRoomIds.length === 1) return { attribution: 'only-open', roomId: openRoomIds[0] };
  return { attribution: 'ambiguous', candidates: [...openRoomIds] };
}
