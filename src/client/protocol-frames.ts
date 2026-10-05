export interface RoomLine {
  roomid: string;
  line: string;
}

/**
 * Split one websocket frame into room-scoped protocol lines.
 *
 * Showdown batches several rooms into a single frame. Each `>roomid` line
 * switches the room for every line after it. A frame that only names the
 * first room would otherwise apply the next battle's `|request|` to the
 * previous battle. SockJS heartbeat and array frames are unwrapped first.
 */
export function roomLines(payload: string): RoomLine[] {
  const out: RoomLine[] = [];
  for (const frame of sockjsPayloads(payload)) {
    let roomid = '';
    const body = frame.endsWith('\n') ? frame.slice(0, -1) : frame;
    if (!body) continue;
    for (const line of body.split('\n')) {
      if (!line) continue;
      if (line.charAt(0) === '>') {
        roomid = line.slice(1);
        continue;
      }
      out.push({ roomid, line });
    }
  }
  return out;
}

function sockjsPayloads(payload: string): string[] {
  if (payload === 'o' || payload === 'h') return [];
  if (payload.startsWith('a[')) {
    try {
      const parsed = JSON.parse(payload.slice(1)) as unknown;
      if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) return parsed;
    } catch {
      // A raw protocol line can theoretically start with "a[". Keep it.
    }
  }
  return [payload];
}
