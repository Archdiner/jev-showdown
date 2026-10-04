# Ideas and Hypotheses

**Last Updated**: 2026-10-04 21:51 UTC

This is a backlog of ideas to test. Each entry includes the hypothesis, rationale, how to test, expected effect, and current status/result.

---

## Active Experiments

### None Currently
All ideas below are untested hypotheses.

---

## Hypothesis Backlog (Ordered by Priority)

### IDEA-001: Speed Control Heuristic
**Hypothesis**: Adding speed awareness to evaluation will improve win rate

**Rationale**: Currently evaluator doesn't consider speed. In many matchups, whoever moves first wins (can KO before taking damage).

**How to Test**:
1. Implement speed comparison in evaluator.ts
2. Bonus (+50) if we outspeed, penalty (-50) if slower
3. Run A/B test: 100 games with vs 100 games without
4. Compare win rates

**Expected Effect**: +3% to +5% win rate (speed is important but not everything)

**Status**: TODO

**Files**: `src/engine/evaluator.ts`

---

### IDEA-002: Setup Threat Detection
**Hypothesis**: Penalizing positions where opponent has stat boosts will improve decision-making

**Rationale**: Setup sweepers (Dragon Dance Dragonite, Calm Mind Suicune) are dangerous if not checked. Bot should prioritize stopping them.

**How to Test**:
1. Add setup detection in evaluator.ts
2. Large penalty (-300) if opponent has +2 or higher in any offensive stat
3. Run self-play with setup-heavy teams
4. Measure: Does bot switch to counter or use priority/status?

**Expected Effect**: Better performance vs setup sweepers, maybe +2% overall

**Status**: TODO

**Files**: `src/engine/evaluator.ts`

---

### IDEA-003: Win Condition Recognition
**Hypothesis**: Detecting unwinnable matchups (immune types) will prevent wasted moves

**Rationale**: If all our moves are Normal-type and opponent has Ghost-type, we CANNOT win. Should switch immediately.

**How to Test**:
1. Check for immunity (all our moves vs opponent type)
2. Huge penalty (-1000) if unwinnable
3. Set up test scenario: Ghost vs all Normal moves
4. Verify bot switches immediately

**Expected Effect**: Fixes specific scenarios, maybe +1% overall (rare but important)

**Status**: TODO

**Files**: `src/engine/evaluator.ts`

---

### IDEA-004: Deeper Search (4-Ply)
**Hypothesis**: Increasing search depth to 4-ply will find deeper tactics

**Rationale**: 3-ply can miss some tactics that require 4 moves. Trade-off: slower per turn.

**How to Test**:
1. Increase depth to 4 in RobustSearch
2. Measure per-turn latency (must stay <2s)
3. Run 100 games vs baseline (3-ply)
4. Compare win rate and time

**Expected Effect**: +2% to +4% win rate if time budget allows

**Status**: TODO

**Risk**: May exceed time budget, causing timeouts

**Files**: `src/engine/robust-search.ts`, `src/bot/bot.ts` (config)

---

### IDEA-005: More Opponent Action Samples
**Hypothesis**: Sampling 6-8 opponent actions (vs current 4) will improve search accuracy

**Rationale**: With only 4 samples, may miss important opponent responses (e.g., a particular switch or less-obvious move).

**How to Test**:
1. Increase opponent action samples from 4 to 6-8
2. Measure per-turn latency
3. Run 100 games vs baseline
4. Compare win rate

**Expected Effect**: +1% to +3% win rate

**Status**: TODO

**Risk**: Slower search, may not fit in time budget

**Files**: `src/engine/robust-search.ts`

---

### IDEA-006: History-Based Opponent Model
**Hypothesis**: Using opponent's past moves to predict future moves will improve anticipation

**Rationale**: If opponent has used Earthquake 3 times, they likely will again. Current model doesn't use history.

**How to Test**:
1. Track opponent move history in GameState
2. Weight recent moves higher in behavioral model
3. Run 100 games vs baseline
4. Check: Does bot predict opponent moves better?

**Expected Effect**: +2% to +4% win rate (prediction is valuable)

**Status**: TODO

**Files**: `src/types/index.ts` (add history), `src/types/format.ts` (use in predictBehavior)

---

### IDEA-007: Priority Move Bonus for Revenge Killing
**Hypothesis**: Boosting priority move value when opponent is low HP will improve KO rate

**Rationale**: Aqua Jet, Mach Punch, etc. are valuable for securing KOs on weakened opponents

**How to Test**:
1. Check if move has priority (priority > 0)
2. Check if opponent HP < 30%
3. If move can KO, big bonus (+200)
4. Run scenarios with Lucario, Azumarill (priority users)

**Expected Effect**: Better revenge killing, maybe +1% to +2%

**Status**: TODO

**Files**: `src/engine/evaluator.ts`

---

### IDEA-008: Opening Book for First Few Turns
**Hypothesis**: Pre-computed optimal moves for turn 1-3 will improve early game

**Rationale**: Early turns have fewer possibilities, could pre-solve. Saves search time for mid/late game.

**How to Test**:
1. Collect stats on turn 1-3 moves from high-rated players
2. Build lookup table (team makeup → best move)
3. Use book moves when available, search otherwise
4. Measure impact on win rate and avg game length

**Expected Effect**: +1% to +3% win rate, faster early game

**Status**: TODO (low priority, complex)

**Files**: New `src/learning/opening-book.ts`, `src/bot/bot.ts`

---

### IDEA-009: Endgame Tablebase for 1v1 and 2v2
**Hypothesis**: Pre-solving endgame positions will ensure perfect play in simplified positions

**Rationale**: When only 1-2 mons remain, search space is small. Can solve exactly.

**How to Test**:
1. Generate all 1v1 matchups (who wins with perfect play?)
2. Generate common 2v2 matchups
3. Store in lookup table (species + HP + moves → best action)
4. Use in evaluation/search when applicable

**Expected Effect**: +2% to +5% win rate (endgame mistakes are costly)

**Status**: TODO (medium priority, moderate complexity)

**Files**: New `src/learning/endgame-tablebase.ts`, `src/engine/evaluator.ts`

---

### IDEA-010: Parallel Search with Multiple Seeds
**Hypothesis**: Running 2-3 search threads with different RNG seeds and voting will reduce variance

**Rationale**: Single search can get "unlucky" with sampled opponent sets. Multiple seeds average out luck.

**How to Test**:
1. Run search with 2-3 different RNG seeds in parallel
2. Each produces top action + score
3. Vote or average scores
4. Measure: variance in decisions, win rate

**Expected Effect**: +1% to +2% win rate, more consistent decisions

**Status**: TODO (low priority, needs threading)

**Files**: `src/engine/robust-search.ts`, `src/bot/bot.ts`

---

### IDEA-011: Dynamic Time Budget per Turn
**Hypothesis**: Allocating more time for critical turns (low HP, must win) will improve decision quality

**Rationale**: Not all turns are equally important. Early game can use less time, endgame needs more.

**How to Test**:
1. Estimate turn criticality (HP sums, fainted count, etc.)
2. Allocate time: 500ms (simple), 1200ms (normal), 2500ms (critical)
3. Measure: Does bot make better decisions in critical moments?

**Expected Effect**: +1% to +3% win rate, better clutch plays

**Status**: TODO (medium priority)

**Files**: `src/bot/bot.ts` (time allocation), `src/engine/robust-search.ts`

---

## Rejected Ideas (Don't Pursue)

### REJECT-001: LLM-Only Decision Making
**Why Rejected**: Too slow (>5s per turn), less reliable than search, violates ADR-003

**If Revisited**: Only as coach/analysis tool, not real-time decision maker

---

### REJECT-002: Neural Network Evaluation Function
**Why Rejected**: Needs huge training data, harder to debug, diminishing returns vs hand-tuned

**If Revisited**: Only after exhausting all heuristics and reaching 95%+ vs random

---

### REJECT-003: Perfect Information Search (Cheat)
**Why Rejected**: Not realistic, wouldn't work on ladder

**If Revisited**: Could use as upper bound benchmark (how much is hidden info costing us?)

---

## Completed Experiments

### EXP-001: Exact Sim Integration (0% Fallback)
**Result**: ✅ SUCCESS - Achieved 0% fallback rate. Quick test shows 100% win rate vs random (5 games), huge improvement from 71% baseline.

**Conclusion**: Exact sim is critical. Further optimizations should assume exact sim is working.

**Date**: 2026-10-04 (commit 5522250)

---

## How to Add a New Idea

1. Copy the template below
2. Fill in all sections (be specific)
3. Add to "Hypothesis Backlog" in priority order
4. When tested, move to "Active Experiments" with results
5. When complete, move to "Completed Experiments" with conclusion

**Template**:
```
### IDEA-XXX: <Title>
**Hypothesis**: <One sentence>

**Rationale**: <Why might this work?>

**How to Test**: <Specific steps>

**Expected Effect**: <Quantified prediction>

**Status**: TODO / IN_PROGRESS / TESTED / REJECTED

**Files**: <Which files to change>
```
