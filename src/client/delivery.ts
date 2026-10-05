export type PopupAttribution =
  | { attribution: 'matched' | 'only-open'; roomId: string }
  | { attribution: 'ambiguous'; candidates: string[] };

function mentionsId(message: string, id: string): boolean {
  if (!id) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9-])${escaped}(?:[^a-z0-9-]|$)`).test(message);
}

function mentionsRoom(message: string, roomId: string): boolean {
  if (mentionsId(message, roomId)) return true;
  const bare = roomId.startsWith('battle-') ? roomId.slice('battle-'.length) : '';
  return bare !== '' && mentionsId(message, bare);
}

/**
 * Pick the battle a global popup belongs to.
 * A room id in the text wins. One open battle is unambiguous.
 * Several open battles and no id is ambiguous — do not guess the latest room.
 */
export function attributePopup(message: string, openRoomIds: string[]): PopupAttribution {
  const mentioned = openRoomIds.filter(roomId => mentionsRoom(message, roomId));
  if (mentioned.length === 1) return { attribution: 'matched', roomId: mentioned[0] };
  if (openRoomIds.length === 1 && mentioned.length === 0) {
    return { attribution: 'only-open', roomId: openRoomIds[0] };
  }
  return { attribution: 'ambiguous', candidates: [...openRoomIds] };
}
