/** Counts from the buildBot strategist search. The screen reads this after the games. */
export interface TurnMeter {
  turns: number;
  grokCalls: number;
  jevCalls: number;
  vetoes: number;
  fallbacks: number;
  costUsd: number;
}

const empty = (): TurnMeter => ({
  turns: 0,
  grokCalls: 0,
  jevCalls: 0,
  vetoes: 0,
  fallbacks: 0,
  costUsd: 0,
});

let meter = empty();

export function resetTurnMeter(): void {
  meter = empty();
}

export function recordStrategistTurn(turn: {
  grok: boolean;
  jev: boolean;
  veto: boolean;
  fallback: boolean;
  costUsd: number;
}): void {
  meter.turns += 1;
  if (turn.grok) meter.grokCalls += 1;
  if (turn.jev) meter.jevCalls += 1;
  if (turn.veto) meter.vetoes += 1;
  if (turn.fallback) meter.fallbacks += 1;
  meter.costUsd += turn.costUsd;
}

export function readTurnMeter(): TurnMeter {
  return { ...meter };
}
