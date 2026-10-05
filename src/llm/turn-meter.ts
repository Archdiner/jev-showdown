/** Counts from the strategist. The screen reads this after the games. */
export interface TurnMeter {
  turns: number;
  grokCalls: number;
  grokTimeouts: number;
  grokErrors: number;
  jevCalls: number;
  vetoes: number;
  fallbacks: number;
  costUsd: number;
  promptTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  grokMs: number[];
  decisionMs: number[];
  plans: string[];
}

const empty = (): TurnMeter => ({
  turns: 0,
  grokCalls: 0,
  grokTimeouts: 0,
  grokErrors: 0,
  jevCalls: 0,
  vetoes: 0,
  fallbacks: 0,
  costUsd: 0,
  promptTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  grokMs: [],
  decisionMs: [],
  plans: [],
});

let meter = empty();

export function resetTurnMeter(): void {
  meter = empty();
}

export function recordStrategistTurn(turn: {
  grok: boolean;
  grokTimeout: boolean;
  grokError?: boolean;
  jev: boolean;
  veto: boolean;
  fallback: boolean;
  costUsd: number;
  promptTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  grokMs: number;
  decisionMs: number;
  plan: string | null;
  /** Late plan cost from a call that already released the turn. */
  countTurn?: boolean;
}): void {
  if (turn.countTurn !== false) {
    meter.turns += 1;
    if (turn.grok) meter.grokCalls += 1;
    if (turn.grokTimeout) meter.grokTimeouts += 1;
    if (turn.grokError) meter.grokErrors += 1;
    if (turn.jev) meter.jevCalls += 1;
    if (turn.veto) meter.vetoes += 1;
    if (turn.fallback) meter.fallbacks += 1;
    if (turn.grokMs > 0) meter.grokMs.push(turn.grokMs);
    if (turn.decisionMs > 0) meter.decisionMs.push(turn.decisionMs);
    if (turn.plan && meter.plans.length < 3 && !meter.plans.includes(turn.plan)) meter.plans.push(turn.plan);
  }
  meter.costUsd += turn.costUsd;
  meter.promptTokens += turn.promptTokens;
  meter.outputTokens += turn.outputTokens;
  meter.reasoningTokens += turn.reasoningTokens;
}

export function readTurnMeter(): TurnMeter {
  return {
    ...meter,
    grokMs: [...meter.grokMs],
    decisionMs: [...meter.decisionMs],
    plans: [...meter.plans],
  };
}

export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}
