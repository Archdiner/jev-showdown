# Search Failure Investigation Report

**Date**: October 4, 2026  
**Priority**: CRITICAL  
**Target**: >=95% vs random over 300 paired games, 0 invalid choices  
**Current**: ~60% vs random (50 games, preliminary)

## Problem Statement

3-ply exact-sim search winning only 62.7% vs uniformly random opponent is catastrophically broken. Max-damage baseline gets 84% vs random, so something fundamental is wrong with our search or evaluation.

## Bugs Found and Fixed

### 1. Critical: Search Perspective Bug ✅ FIXED

**Problem**:
- Bot assumed it was always p1
- Terminal evaluation: `result.winner === 'p1' ? 10000 : -10000`
- When bot was p2 and won (winner = 'p2'), it scored -10000 (thought it lost!)
- Bot actively avoided winning moves when playing as p2
- Action mapping: `simulateTurn(myAction, oppAction)` passed actions in wrong order for p2

**Root Cause**:
- GameState didn't track which player we are
- SimWrapper.simulateTurn expects `(p1Action, p2Action)` in that order
- Search always passed `(myAction, oppAction)` assuming we're p1

**Fix** (Commit `8fcc0b6`):
- Added `playerId: 'p1' | 'p2'` to GameState interface
- Extract from `request.side.id` in buildGameState
- Fixed evaluateAction:
  ```typescript
  const weAreP1 = !state.playerId || state.playerId === 'p1';
  const p1Action = weAreP1 ? myAction : oppAction.action;
  const p2Action = weAreP1 ? oppAction.action : myAction;
  const result = await this.simWrapper.simulateTurn(state, p1Action, p2Action);
  
  if (result.terminated) {
    const value = result.winner === (weAreP1 ? 'p1' : 'p2') ? 10000 : -10000;
  }
  ```

**Impact**:
- Preliminary: 60% vs random (50 games) - NO SIGNIFICANT IMPROVEMENT
- This suggests perspective bug was NOT the main issue
- Other fundamental problems remain

### 2. Trapped Switch Bug ✅ FIXED

**Problem**:
- getLegalActions only checked `active.trapped`
- Didn't check `active.maybeTrapped` (Shadow Tag, Arena Trap, Magnet Pull, partial trapping)
- Led to invalid switch choices

**Fix** (Commit `6c8b819`):
```typescript
const isTrapped = active.trapped || active.maybeTrapped;
if (request.side && request.side.pokemon && actions.length > 0 && !isTrapped) {
  // Add switches
}
```

**Impact**:
- Should eliminate invalid choice errors
- Testing in progress

## Diagnostic Test Suite

Created 4 hand-crafted positions with obvious best moves:

| Test | Scenario | Expected | Result | Pass |
|------|----------|----------|--------|------|
| 1 | 4x super-effective KO available | Attack | Attack | ✅ |
| 2 | Don't switch into 4x weakness | Stay in | Volt Switch | ❌ |
| 3 | Stay in vs walled opponent | Stay in | Stay in | ✅ |
| 4 | P2 perspective - take KO | Attack move 1 | Attack move 2 | ❌ |

**Results**: 2/4 passing, 0.00% fallback rate

**Analysis**:
- Tests 1 and 3 (simple KO opportunities) passed
- Tests 2 and 4 (nuanced decisions) failed
- Suggests evaluation or search depth issues, not perspective

## Suspects Remaining

### 1. Paranoid Minimax vs Stochastic Opponent 🔴 HIGH PRIORITY

**Theory**: Search is treating opponent as worst-case (minimax) instead of stochastic.
- Against random opponent, we should model as uniform distribution over legal actions
- Current code uses behavioral model (`predictBehavior`) but applies it to opponent action sampling
- The search structure looks correct (weighted average over opponent responses)
- But the weights might not be accurate vs random

**Investigation Needed**:
- Check if `predictBehavior` is being used correctly
- Verify weighted averaging is actually happening
- Compare scores for different opponent action assumptions

### 2. Evaluation Function Weakness 🔴 HIGH PRIORITY

**Theory**: Base evaluator is too weak to distinguish good from bad positions.
- Current weights: material=100, hp=50, position=30, hazards=20, momentum=15, info=10
- No consideration of:
  - Type matchups (only crude effectiveness estimation)
  - Move power and coverage
  - Speed control
  - Setup opportunities
  - Endgame material advantage

**Evidence**:
- Diagnostic test 2: Chose Volt Switch over Thunderbolt (both are attacking moves)
- Diagnostic test 4: Chose wrong attack move (both attacks, wrong one selected)
- Suggests evaluation can't distinguish between move qualities

**Investigation Needed**:
- Add detailed logging of evaluation scores for different moves
- Check if material/HP dominates everything else
- Test with stronger evaluation weights for position/matchups

### 3. World Reconstruction Bugs 🟡 MEDIUM PRIORITY

**Theory**: Battle state reconstruction is giving us wrong HP/stats/teams.
- BattleStateBuilder might be building incorrect teams
- HP tracking might be off
- Opponent team reconstruction might be wrong

**Evidence**:
- 0% fallback rate suggests simulation is working
- But simulation quality depends on accurate state reconstruction

**Investigation Needed**:
- Add state validation logging
- Compare reconstructed state vs actual battle state
- Check HP tracking across simulation

### 4. Depth-Parity Bias 🟡 MEDIUM PRIORITY

**Theory**: 3-ply search has even depth, causing horizon effects.
- At depth 3, we evaluate after opponent's response
- Might miss our own winning moves at depth 4
- Or overvalue opponent's threats that we could counter

**Investigation Needed**:
- Test with depth 2 (odd) vs depth 3 (even)
- Check if adding quiescence search helps

### 5. Time Budget Cutting Search 🟢 LOW PRIORITY

**Theory**: Search timeout cutting off before good moves found.
- Config: `searchTimeMs: 5000` (5 seconds)
- With 3 worlds × 4 opponent actions × depth 3, that's manageable
- Fallback rate 0% suggests we're not timing out badly

**Evidence**: Diagnostic tests completed in <250ms, well under budget.

## Benchmark Results (FINAL - 50 games each)

**VS Random**:
- Win rate: **60.0%** (30-20-0)
- Target: >=95%
- **FAIL**: 35 percentage points below target
- Fallback rate: 0.00% (0/179,184 calls) ✓

**VS Max-Damage**:
- Win rate: **62.0%** (31-19-0)
- Target: >=80%
- **FAIL**: 18 percentage points below target

**Max-Damage VS Random (baseline)**:
- Win rate: 76.0% (38-12-0)
- Our bot: 60% vs random < 76% max-damage baseline
- **Conclusion**: Bot performs WORSE than simple max-damage heuristic

## Next Steps (Priority Order)

1. **Finish benchmark and analyze losses**
   - Get max-damage final results
   - Mine worst losses from logs
   - Identify systematic blunders

2. **Add detailed evaluation logging**
   - Log breakdown of scores for each action
   - Identify which components dominate
   - Check if evaluation distinguishes good/bad moves

3. **Test behavioral model hypothesis**
   - Run game with uniform opponent weights (pure random model)
   - Compare performance
   - Verify weighted averaging is working

4. **Strengthen evaluation**
   - Add proper type matchup calculation
   - Add move power / coverage terms
   - Add speed control value
   - Test improved evaluator

5. **Run 300-game benchmark**
   - Once fixes applied, run full 300-game test
   - Measure against 95% target
   - Validate 0 invalid choices

## Files for Investigation

Key files to examine:
- `src/engine/robust-search.ts` - Search algorithm
- `src/engine/evaluator.ts` - Position evaluation
- `src/engine/sim-wrapper.ts` - Simulation interface
- `src/engine/battle-state-builder.ts` - State reconstruction
- `src/learning/self-play.ts` - Game execution

## Conclusion

**Perspective bug was NOT the main issue**. Win rate barely changed after fix.

**Most likely culprits**:
1. Weak evaluation function (can't distinguish move quality)
2. Behavioral model not appropriate for random opponent
3. Search depth / horizon effects

**Action Plan**: Focus on evaluation function improvements and behavioral model validation before further search algorithm changes.
