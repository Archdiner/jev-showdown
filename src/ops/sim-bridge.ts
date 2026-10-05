import { battleFromInputLog, inputLogBridge } from '../config/adapters.js';
import type { LiveBattleBridge, LiveBattleInput } from '../config/interfaces.js';

export function inputLogFromTranscript(log: string): string | null {
  const lines = log.split('\n').filter(line => line.includes('|siminput|'));
  if (lines.length === 0) return null;
  const raw = lines[lines.length - 1].split('|siminput|')[1] ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Local server embeds the sim input log. The ladder bridge stays untouched. */
export const localSimBridge: LiveBattleBridge = {
  reconstruct(input: LiveBattleInput) {
    const packed = inputLogFromTranscript(input.log);
    if (packed?.includes('>start')) return battleFromInputLog(packed);
    return inputLogBridge.reconstruct(input);
  },
};
