/** Wilson score interval. z=1.96 is the 95% interval used by the gate. */

export interface Wilson {
  rate: number | null;
  low: number | null;
  high: number | null;
}

export function wilson(wins: number, total: number, z = 1.96): Wilson {
  if (total <= 0) return { rate: null, low: null, high: null };
  const p = wins / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return { rate: p, low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

const P0 = 0.5;
const P1 = 1 / (1 + 10 ** (-10 / 400));
const BOUNDARY = Math.log((1 - 0.05) / 0.05);

/** Same SPRT as the ops gatekeeper: elo0=0, elo1=+10, alpha=beta=0.05. */
export function sprt(wins: number, losses: number): 'promote' | 'reject' | 'continue' {
  if (wins + losses === 0) return 'continue';
  const llr = wins * Math.log(P1 / P0) + losses * Math.log((1 - P1) / (1 - P0));
  if (llr >= BOUNDARY) return 'promote';
  if (llr <= -BOUNDARY) return 'reject';
  return 'continue';
}
