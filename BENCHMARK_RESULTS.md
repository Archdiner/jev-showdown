# Stacked Improvements Benchmark Results

## Summary

Combined quickwins improvements (Terastallize, skip immune locks, fill hidden foe moves) with fitted team evaluator.

## Benchmark Setup

- **Format**: Gen 9 Random Battle
- **Information**: Hidden (honest ladder view)
- **Seeds**: Fixed beforehand, paired with sides swapped
- **Opponent model**: Max-damage
- **Randbats species**: 508 generated, 509 in stats file

## Results

### 1. Stacked Config vs Live Champion

**Config A (stacked-quickwins-fitted):**
- Search: greedy-1ply, 8 samples, tera=true, progress=true, foePrior=true
- Evaluator: fitted-team

**Config B (champion baseline):**
- Search: greedy-1ply, 8 samples, tera=false, progress=false, foePrior=false  
- Evaluator: hp-fraction

| Metric | Value |
|--------|-------|
| Games | 400 (200 pairs, seed 3000) |
| Result | **246W-154L-0T (61.5%)** |
| Wilson 95% CI | **56.6–66.1%** |
| Invalid choices | 0 |
| Crashes | 0 |
| View misses | 0 |
| p50 latency | 129ms |
| p95 latency | 186ms |
| p99 latency | 228ms |
| Max latency | 573ms |

### 2. Stacked Config vs Quickwins-Only

**Config A (stacked-quickwins-fitted):**
- Search: greedy-1ply, 8 samples, tera=true, progress=true, foePrior=true
- Evaluator: fitted-team

**Config B (quickwins-only):**
- Search: greedy-1ply, 8 samples, tera=true, progress=true, foePrior=true
- Evaluator: hp-fraction

| Metric | Value |
|--------|-------|
| Games | 400 (200 pairs, seed 5000) |
| Result | **284W-116L-0T (71.0%)** |
| Wilson 95% CI | **66.4–75.2%** |
| Invalid choices | 0 |
| Crashes | 0 |
| View misses | 0 |
| p50 latency | 128ms |
| p95 latency | 182ms |
| p99 latency | 219ms |
| Max latency | 686ms |

## Analysis

1. **Stacked vs Champion**: The stacked config beats the baseline champion by 11.5 percentage points (61.5% vs 50%). This represents a significant improvement with high confidence (CI doesn't include 50%).

2. **Stacked vs Quickwins-only**: The stacked config beats quickwins-only by 21.0 percentage points (71.0% vs 50%). This isolates the contribution of the fitted evaluator on top of the quickwins improvements.

3. **Contribution breakdown**:
   - Quickwins alone (from PR #67 results): ~57.5% vs baseline
   - Fitted eval alone (from PR #66 results): ~58.3% vs baseline  
   - Stacked (quickwins + fitted): 61.5% vs baseline, 71.0% vs quickwins-only

4. **Reliability**: All benchmarks show 0 invalid choices, 0 crashes, and 0 view misses, confirming the implementation is robust.

5. **Performance**: Decision latency is acceptable with p95 under 190ms across all benchmarks.

## Recommendation

**`configs/stacked-quickwins-fitted.yaml`** is recommended as the next live challenger config.

The config combines:
- PR #67 improvements (Terastallize search, immune lock skip, foe move filling)
- PR #66 fitted team evaluator

Win rates strongly support promotion:
- 61.5% vs live champion (Wilson CI: 56.6–66.1%)
- 71.0% vs quickwins-only (Wilson CI: 66.4–75.2%)
- 0 guardrail violations
