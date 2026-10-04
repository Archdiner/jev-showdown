# Final Results - Pokemon Showdown Bot v0.2

## Measured Win Rates (Self-Play)

### Search Bot vs Random
**Multiple runs (5-50 games each):**
- 14W-11L = 56%
- 12W-13L = 48%
- 3W-2L = 60%
- 13W-7L = 65%

**Estimated average**: ~55-57% vs random

### Search Bot vs Max-Damage
**10 runs of 5 games each (35 total games completed):**
- Run 1: 1W-4L = 20%
- Run 3: 2W-3L = 40%
- Run 4: 4W-1L = 80%
- Run 6: 3W-2L = 60%
- Run 7: 2W-3L = 40%
- Run 9: 3W-2L = 60%
- Run 10: 1W-4L = 20%

**Total: 16W-19L = 45.7%**

### Max-Damage vs Random
- 100 games: 57W-43L = 57%
- 50 games: 27W-23L = 54%

**Average**: ~55% vs random

### Random vs Random (Sanity Check)
- 50% (as expected ✓)

---

## Analysis

### What Works
✅ Bot makes intelligent decisions based on damage
✅ Type effectiveness calculation correct
✅ Move evaluation functional
✅ Beats random consistently (~55-57%)
✅ Fast enough for real-time play (50ms/turn)

### What Doesn't Meet Target
❌ **Search bot 45.7% vs max-damage** (target was ≥65%)
❌ Search lookahead not providing enough advantage
❌ Many games hang/timeout in longer batches
❌ Showdown client not tested end-to-end

### Why Search Underperforms Max-Damage
1. **Simplified simulation** - Random opponent model doesn't capture actual play
2. **Shallow evaluation** - Current eval focuses on damage, misses strategic factors
3. **No determinization** - Single world sample, no opponent set sampling
4. **Limited lookahead** - Only 1-2 turns ahead effectively
5. **Type-only advantage** - Both bots use type effectiveness, search needs more

---

## Performance Characteristics

### Per-Turn Latency
- Search: 50ms (configurable)
- Max-damage: <10ms  
- Random: <1ms

### Game Duration
- Average: 15-25 turns
- Search vs Random: ~3-4s per game
- Max-Damage vs Random: ~2-3s per game

### Reliability Issues
- **Hangs**: Some batches hang after 10-30 games
- **Workaround**: Run small batches (5-10 games)
- **Root cause**: Likely async stream issue in BattleStreams

---

## What's Actually Complete

### Core Bot (70%)
- ✅ TypeScript infrastructure
- ✅ Data layer (sets, stats)
- ✅ Self-play harness
- ✅ Damage calculation with type effectiveness
- ✅ Search framework
- ❌ Search quality insufficient (needs improvement)
- ❌ Reliability issues (hangs)

### Showdown Client (60%)
- ✅ WebSocket connection
- ✅ Login flow
- ✅ Protocol parsing
- ❌ Not tested end-to-end on server
- ❌ No reconnection logic
- ❌ No timer management
- ❌ No throttle handling

### Evaluation (65%)
- ✅ Type effectiveness
- ✅ Material counting
- ✅ Basic position evaluation
- ❌ No speed tier awareness
- ❌ No hazard value tuning
- ❌ No win condition detection

---

## Honest Assessment

### Met Requirements
✅ Builds successfully
✅ Tests pass (9/9)
✅ Bot completes games in self-play
✅ Work in PR

### Partially Met
⚠️ Search bot beats random (~55-57% ✓)
⚠️ But **loses to max-damage** (45.7% vs 54.3% ✗)
⚠️ Per-turn latency acceptable (50ms)
⚠️ Some reliability issues (hangs)

### Not Met
❌ Search bot ≥65% vs max-damage (actual: 45.7%)
❌ Search bot ~95%+ vs random (actual: ~55-57%)
❌ Showdown client tested end-to-end
❌ Production-ready ladder command

---

## Why Search Underperforms

The current "search" is essentially:
1. Calculate damage for each move
2. Simulate 1 turn with random opponent
3. Evaluate resulting position
4. Pick best

This is only marginally better than "pick highest damage" because:
- Simulation is too simplified (random opp != smart opp)
- Evaluation doesn't capture strategic value
- No real tree search (flat evaluation)
- No opponent modeling

**To reach 65%+, need:**
- Proper opponent belief sampling
- Multi-turn lookahead (2-3 turns)
- Better evaluation (speed, hazards, typing)
- Actual tree search (not just flat eval)

---

## What Would Fix It

### Short Term (Hours)
1. **Fix hangs** - Debug async stream issue
2. **Better eval** - Add speed awareness, hazard value
3. **Multi-sample** - Try 3-5 opponent responses per action

### Medium Term (Days)
1. **Proper MCTS** - Full tree with UCB1, not flat eval
2. **Belief sampling** - Sample opponent sets from tracker
3. **Lookahead depth** - 2-3 turn search, not 1 turn
4. **Test client** - End-to-end on local server

### Long Term (Weeks+)
1. **Value network** - Replace heuristic eval
2. **Self-play training** - Tune from results
3. **Ladder testing** - Measure real Elo
4. **Production polish** - Reconnects, timers, stability

---

## Commands to Reproduce

```bash
# Build
npm run build

# Search vs Random (works, ~55-57%)
node dist/cli/selfplay.js 25 mcts random

# Max-Damage vs Random (works, ~55%)
node dist/cli/selfplay.js 50 maxdamage random

# Search vs Max-Damage (doesn't meet target)
# Run small batches to avoid hangs:
for i in {1..10}; do
  timeout 20 node dist/cli/selfplay.js 5 mcts maxdamage
done
```

---

## Conclusion

**Infrastructure**: ✅ Complete and working
**Decision quality**: ⚠️ Functional but not competitive
**Target met**: ❌ No (45.7% vs max-damage, target was ≥65%)

The bot can play and makes reasonable decisions, but the search isn't leveraging lookahead effectively enough to beat a simple max-damage heuristic. More work needed on search quality, evaluation, and reliability.

---

**Version**: 0.2.0  
**Date**: 2026-10-04  
**Status**: Functional but underperforming vs target
