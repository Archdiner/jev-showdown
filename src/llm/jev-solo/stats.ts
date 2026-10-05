export interface JevTrace {
  fallback: boolean;
  called: boolean;
  hardSwitch: boolean;
  tera: boolean;
  teraLegal: boolean;
  switchLegal: boolean;
  latencyMs: number;
  costUsd: number;
  design: string;
  blocks: string[];
  briefChars: number;
  error?: string;
}

export interface JevTotals {
  decisions: number;
  calls: number;
  failures: number;
  hardSwitches: number;
  switchOpportunities: number;
  teras: number;
  teraOpportunities: number;
  latenciesMs: number[];
  costUsd: number;
}

export function emptyTotals(): JevTotals {
  return {
    decisions: 0,
    calls: 0,
    failures: 0,
    hardSwitches: 0,
    switchOpportunities: 0,
    teras: 0,
    teraOpportunities: 0,
    latenciesMs: [],
    costUsd: 0,
  };
}

export function absorb(total: JevTotals, trace: JevTrace): void {
  total.decisions++;
  if (trace.called) total.calls++;
  if (trace.fallback) total.failures++;
  if (trace.switchLegal) total.switchOpportunities++;
  if (trace.hardSwitch) total.hardSwitches++;
  if (trace.teraLegal) total.teraOpportunities++;
  if (trace.tera) total.teras++;
  if (trace.called) total.latenciesMs.push(trace.latencyMs);
  total.costUsd += trace.costUsd;
}

export function mergeTotals(parts: JevTotals[]): JevTotals {
  const total = emptyTotals();
  for (const part of parts) {
    total.decisions += part.decisions;
    total.calls += part.calls;
    total.failures += part.failures;
    total.hardSwitches += part.hardSwitches;
    total.switchOpportunities += part.switchOpportunities;
    total.teras += part.teras;
    total.teraOpportunities += part.teraOpportunities;
    total.latenciesMs.push(...part.latenciesMs);
    total.costUsd += part.costUsd;
  }
  return total;
}

export function wilson(wins: number, total: number, z = 1.96): [number, number] {
  if (total <= 0) return [0, 1];
  const p = wins / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function rate(part: number, total: number): string {
  if (total <= 0) return 'n/a';
  return `${((part / total) * 100).toFixed(1)}% (${part}/${total})`;
}
