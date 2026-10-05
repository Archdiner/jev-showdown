import { GraphDB } from './db.js';

/**
 * Comprehensive metric set for regression detection.
 * Detects when bot gets worse at ANYTHING, not just overall win rate.
 */

export interface MetricSnapshot {
  // Core performance
  win_rate_by_opponent: Record<string, number>; // e.g., { 'random-v1': 0.95, 'maxdamage-v1': 0.80 }
  
  // Situational performance
  situations: {
    leading: { games: number; wins: number; win_rate: number }; // Material advantage
    trailing: { games: number; wins: number; win_rate: number }; // Material disadvantage
    endgame_1v1: { games: number; wins: number; win_rate: number };
    endgame_2v2: { games: number; wins: number; win_rate: number };
    hazard_advantage: { games: number; wins: number; win_rate: number }; // We have hazards up
    hazard_disadvantage: { games: number; wins: number; win_rate: number }; // They have hazards up
    weather_active: { games: number; wins: number; win_rate: number };
    tera_first: { games: number; wins: number; win_rate: number }; // We Tera'd first
    tera_second: { games: number; wins: number; win_rate: number }; // They Tera'd first
  };
  
  // Decision quality
  decisions: {
    switch_frequency: number; // Switches per game
    switch_quality: number; // % switches that improved position (eval increase)
    setup_sweeps_allowed: number; // Times opponent set up and swept
    setup_sweeps_achieved: number; // Times we set up and swept
    speed_option_survival: number; // % games where speed option survived to endgame
    blunder_rate: number; // Moves causing >300 eval swing (as % of total moves)
  };
  
  // Diagnostic tests
  diagnostic_suite: {
    total: number;
    passed: number;
    pass_rate: number;
  };
  
  // Hard guardrails
  guardrails: {
    invalid_choices: number;
    crashes: number;
    timeouts: number;
    p99_latency_ms: number;
    fallback_rate: number;
    state_mismatches: number;
  };
  
  // Ladder (when available)
  ladder?: {
    rating: number;
    gxe: number; // Glicko-X-Elo
    rolling_100_win_rate: number;
    max_loss_streak: number;
  };
  
  // Metadata
  games_played: number;
  timestamp: number;
  commit_sha?: string;
}

export interface RegressionResult {
  metric_path: string; // e.g., 'win_rate_by_opponent.random-v1'
  baseline_value: number;
  candidate_value: number;
  delta: number;
  ci_lower: number; // Wilson CI lower bound
  ci_upper: number;
  significant: boolean; // Is regression statistically significant?
  severity: 'critical' | 'major' | 'minor';
}

export class RegressionTracker {
  private db: GraphDB;
  
  // Thresholds for significance (after CI check)
  private readonly THRESHOLDS = {
    critical: 0.10, // 10% drop
    major: 0.05,    // 5% drop
    minor: 0.02,    // 2% drop
  };
  
  constructor(db?: GraphDB) {
    this.db = db || new GraphDB();
  }
  
  /**
   * Compare candidate against baseline (previous champion).
   * Returns list of detected regressions with proper statistics.
   */
  detectRegressions(
    baseline: MetricSnapshot,
    candidate: MetricSnapshot
  ): RegressionResult[] {
    const regressions: RegressionResult[] = [];
    
    // 1. Compare win rates by opponent
    for (const [opponent, candidateWR] of Object.entries(candidate.win_rate_by_opponent)) {
      const baselineWR = baseline.win_rate_by_opponent[opponent];
      if (baselineWR === undefined) continue;
      
      const result = this.compareWinRate(
        `win_rate_by_opponent.${opponent}`,
        baselineWR,
        candidateWR,
        baseline.games_played,
        candidate.games_played
      );
      
      if (result.significant && result.delta < 0) {
        regressions.push(result);
      }
    }
    
    // 2. Compare situational performance
    for (const [situation, candidateStats] of Object.entries(candidate.situations)) {
      const baselineStats = baseline.situations[situation as keyof typeof baseline.situations];
      if (!baselineStats || baselineStats.games < 10 || candidateStats.games < 10) continue;
      
      const result = this.compareWinRate(
        `situations.${situation}`,
        baselineStats.win_rate,
        candidateStats.win_rate,
        baselineStats.games,
        candidateStats.games
      );
      
      if (result.significant && result.delta < 0) {
        regressions.push(result);
      }
    }
    
    // 3. Compare decision quality metrics
    const decisionMetrics: Array<keyof MetricSnapshot['decisions']> = [
      'switch_frequency',
      'switch_quality',
      'speed_option_survival',
    ];
    
    for (const metric of decisionMetrics) {
      const baselineVal = baseline.decisions[metric];
      const candidateVal = candidate.decisions[metric];
      
      // Higher is better for switch_quality and speed_option_survival
      // switch_frequency is neutral (depends on style)
      if (metric === 'switch_quality' || metric === 'speed_option_survival') {
        const delta = candidateVal - baselineVal;
        if (delta < -this.THRESHOLDS.minor) {
          regressions.push({
            metric_path: `decisions.${metric}`,
            baseline_value: baselineVal,
            candidate_value: candidateVal,
            delta,
            ci_lower: candidateVal - 0.05, // Simplified CI
            ci_upper: candidateVal + 0.05,
            significant: Math.abs(delta) > this.THRESHOLDS.minor,
            severity: this.getSeverity(delta),
          });
        }
      }
    }
    
    // 4. Compare setup sweeps (fewer allowed is better, more achieved is better)
    const sweepsAllowedDelta = candidate.decisions.setup_sweeps_allowed - baseline.decisions.setup_sweeps_allowed;
    if (sweepsAllowedDelta > 0) {
      regressions.push({
        metric_path: 'decisions.setup_sweeps_allowed',
        baseline_value: baseline.decisions.setup_sweeps_allowed,
        candidate_value: candidate.decisions.setup_sweeps_allowed,
        delta: sweepsAllowedDelta,
        ci_lower: candidate.decisions.setup_sweeps_allowed - 0.5,
        ci_upper: candidate.decisions.setup_sweeps_allowed + 0.5,
        significant: sweepsAllowedDelta > 0.5,
        severity: this.getSeverity(-sweepsAllowedDelta / 10),
      });
    }
    
    const sweepsAchievedDelta = candidate.decisions.setup_sweeps_achieved - baseline.decisions.setup_sweeps_achieved;
    if (sweepsAchievedDelta < 0) {
      regressions.push({
        metric_path: 'decisions.setup_sweeps_achieved',
        baseline_value: baseline.decisions.setup_sweeps_achieved,
        candidate_value: candidate.decisions.setup_sweeps_achieved,
        delta: sweepsAchievedDelta,
        ci_lower: candidate.decisions.setup_sweeps_achieved - 0.5,
        ci_upper: candidate.decisions.setup_sweeps_achieved + 0.5,
        significant: Math.abs(sweepsAchievedDelta) > 0.5,
        severity: this.getSeverity(sweepsAchievedDelta / 10),
      });
    }
    
    // 5. Compare blunder rate (lower is better)
    const blunderDelta = candidate.decisions.blunder_rate - baseline.decisions.blunder_rate;
    if (blunderDelta > this.THRESHOLDS.minor) {
      regressions.push({
        metric_path: 'decisions.blunder_rate',
        baseline_value: baseline.decisions.blunder_rate,
        candidate_value: candidate.decisions.blunder_rate,
        delta: blunderDelta,
        ci_lower: candidate.decisions.blunder_rate - 0.01,
        ci_upper: candidate.decisions.blunder_rate + 0.01,
        significant: blunderDelta > this.THRESHOLDS.minor,
        severity: this.getSeverity(-blunderDelta),
      });
    }
    
    // 6. Compare diagnostic suite pass rate
    if (baseline.diagnostic_suite.total > 0 && candidate.diagnostic_suite.total > 0) {
      const delta = candidate.diagnostic_suite.pass_rate - baseline.diagnostic_suite.pass_rate;
      if (delta < -this.THRESHOLDS.minor) {
        regressions.push({
          metric_path: 'diagnostic_suite.pass_rate',
          baseline_value: baseline.diagnostic_suite.pass_rate,
          candidate_value: candidate.diagnostic_suite.pass_rate,
          delta,
          ci_lower: candidate.diagnostic_suite.pass_rate - 0.05,
          ci_upper: candidate.diagnostic_suite.pass_rate + 0.05,
          significant: Math.abs(delta) > this.THRESHOLDS.minor,
          severity: this.getSeverity(delta),
        });
      }
    }
    
    // 7. Check hard guardrails (any increase is a regression)
    const guardrailChecks = [
      { metric: 'invalid_choices', max: 0 },
      { metric: 'crashes', max: 0 },
      { metric: 'timeouts', max: 0 },
      { metric: 'state_mismatches', max: 0 },
    ];
    
    for (const check of guardrailChecks) {
      const metric = check.metric as keyof MetricSnapshot['guardrails'];
      const candidateVal = candidate.guardrails[metric] as number;
      const baselineVal = baseline.guardrails[metric] as number;
      
      if (candidateVal > check.max || candidateVal > baselineVal) {
        regressions.push({
          metric_path: `guardrails.${metric}`,
          baseline_value: baselineVal,
          candidate_value: candidateVal,
          delta: candidateVal - baselineVal,
          ci_lower: candidateVal,
          ci_upper: candidateVal,
          significant: true,
          severity: 'critical',
        });
      }
    }
    
    // 8. Check p99 latency (must not exceed 2000ms)
    if (candidate.guardrails.p99_latency_ms > 2000) {
      regressions.push({
        metric_path: 'guardrails.p99_latency_ms',
        baseline_value: baseline.guardrails.p99_latency_ms,
        candidate_value: candidate.guardrails.p99_latency_ms,
        delta: candidate.guardrails.p99_latency_ms - baseline.guardrails.p99_latency_ms,
        ci_lower: candidate.guardrails.p99_latency_ms,
        ci_upper: candidate.guardrails.p99_latency_ms,
        significant: true,
        severity: 'critical',
      });
    }
    
    // 9. Check fallback rate (must not exceed 1%)
    if (candidate.guardrails.fallback_rate > 0.01) {
      regressions.push({
        metric_path: 'guardrails.fallback_rate',
        baseline_value: baseline.guardrails.fallback_rate,
        candidate_value: candidate.guardrails.fallback_rate,
        delta: candidate.guardrails.fallback_rate - baseline.guardrails.fallback_rate,
        ci_lower: candidate.guardrails.fallback_rate,
        ci_upper: candidate.guardrails.fallback_rate,
        significant: true,
        severity: 'critical',
      });
    }
    
    // 10. Compare ladder metrics (if available)
    if (baseline.ladder && candidate.ladder) {
      const ratingDelta = candidate.ladder.rating - baseline.ladder.rating;
      if (ratingDelta < -50) {
        regressions.push({
          metric_path: 'ladder.rating',
          baseline_value: baseline.ladder.rating,
          candidate_value: candidate.ladder.rating,
          delta: ratingDelta,
          ci_lower: candidate.ladder.rating - 10,
          ci_upper: candidate.ladder.rating + 10,
          significant: Math.abs(ratingDelta) > 50,
          severity: this.getSeverity(ratingDelta / 500),
        });
      }
      
      const gxeDelta = candidate.ladder.gxe - baseline.ladder.gxe;
      if (gxeDelta < -0.05) {
        regressions.push({
          metric_path: 'ladder.gxe',
          baseline_value: baseline.ladder.gxe,
          candidate_value: candidate.ladder.gxe,
          delta: gxeDelta,
          ci_lower: candidate.ladder.gxe - 0.01,
          ci_upper: candidate.ladder.gxe + 0.01,
          significant: Math.abs(gxeDelta) > 0.05,
          severity: this.getSeverity(gxeDelta),
        });
      }
    }
    
    return regressions.filter(r => r.significant);
  }
  
  /**
   * Compare two win rates using Wilson confidence intervals.
   */
  private compareWinRate(
    metric_path: string,
    baselineWR: number,
    candidateWR: number,
    baselineGames: number,
    candidateGames: number
  ): RegressionResult {
    // Wilson CI for candidate
    const [ciLower, ciUpper] = this.wilsonCI(
      Math.round(candidateWR * candidateGames),
      candidateGames,
      0.95
    );
    
    const delta = candidateWR - baselineWR;
    
    // Significant if baseline is outside candidate's CI
    const significant = baselineWR > ciUpper || baselineWR < ciLower;
    
    return {
      metric_path,
      baseline_value: baselineWR,
      candidate_value: candidateWR,
      delta,
      ci_lower: ciLower,
      ci_upper: ciUpper,
      significant,
      severity: this.getSeverity(delta),
    };
  }
  
  private wilsonCI(wins: number, total: number, confidence: number): [number, number] {
    if (total === 0) return [0, 1];
    
    const z = 1.96; // 95% confidence
    const p = wins / total;
    const denominator = 1 + z * z / total;
    const center = (p + z * z / (2 * total)) / denominator;
    const margin = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator;
    
    return [
      Math.max(0, center - margin),
      Math.min(1, center + margin)
    ];
  }
  
  private getSeverity(delta: number): 'critical' | 'major' | 'minor' {
    const absDelta = Math.abs(delta);
    if (absDelta >= this.THRESHOLDS.critical) return 'critical';
    if (absDelta >= this.THRESHOLDS.major) return 'major';
    return 'minor';
  }
  
  /**
   * Record regressions as nodes in the graph.
   */
  recordRegressions(
    regressions: RegressionResult[],
    championId: string,
    candidateId: string,
    commitSha?: string
  ): void {
    const timestamp = Date.now();
    
    for (const regression of regressions) {
      const regressionId = `regression-${candidateId}-${regression.metric_path.replace(/\./g, '-')}-${timestamp}`;
      
      this.db.addNode({
        id: regressionId,
        type: 'Regression' as any,
        status: 'detected',
        title: `Regression: ${regression.metric_path}`,
        description: `${regression.severity.toUpperCase()}: ${regression.metric_path} dropped from ${regression.baseline_value.toFixed(3)} to ${regression.candidate_value.toFixed(3)} (${(regression.delta * 100).toFixed(1)}%)`,
        created_at: timestamp,
        updated_at: timestamp,
        metrics: {
          metric_path: regression.metric_path,
          baseline_value: regression.baseline_value,
          candidate_value: regression.candidate_value,
          delta: regression.delta,
          ci_lower: regression.ci_lower,
          ci_upper: regression.ci_upper,
          severity: regression.severity,
        },
        metadata: {
          commit_sha: commitSha,
        },
      } as any);
      
      // Link regression to candidate that caused it
      this.db.addEdge({
        id: `${candidateId}-caused-${regressionId}`,
        from_node: candidateId,
        to_node: regressionId,
        type: 'caused',
        created_at: timestamp,
      });
      
      // Link regression to champion it regressed from
      this.db.addEdge({
        id: `${regressionId}-regressed-from-${championId}`,
        from_node: regressionId,
        to_node: championId,
        type: 'regressed_from',
        created_at: timestamp,
      });
    }
  }
  
  /**
   * Get all regressions from the graph.
   */
  getAllRegressions(): any[] {
    const query = `
      SELECT * FROM nodes 
      WHERE type = 'Regression'
      ORDER BY created_at DESC
    `;
    
    return this.db['db'].prepare(query).all();
  }
  
  /**
   * Generate regression summary table for gate report.
   */
  generateRegressionTable(regressions: RegressionResult[]): any {
    return {
      total: regressions.length,
      by_severity: {
        critical: regressions.filter(r => r.severity === 'critical').length,
        major: regressions.filter(r => r.severity === 'major').length,
        minor: regressions.filter(r => r.severity === 'minor').length,
      },
      regressions: regressions.map(r => ({
        metric: r.metric_path,
        baseline: r.baseline_value,
        candidate: r.candidate_value,
        delta: r.delta,
        delta_percent: (r.delta * 100).toFixed(1) + '%',
        ci: `[${r.ci_lower.toFixed(3)}, ${r.ci_upper.toFixed(3)}]`,
        severity: r.severity,
      })),
    };
  }
}
