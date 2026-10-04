# Changelog - Cloud Agent Run (Oct 4, 2026)

## Plain-English Summary of Changes

### 1. Format Interface & Modularity ✅
**Files**: `src/types/format.ts`, `src/formats/gen9-randombattle.ts`

- Created a clean `Format` interface that separates format-specific logic from core bot infrastructure
- Implemented `Gen9RandomBattle` format with:
  - Data source URLs (sets, stats, rules)
  - Opponent set sampling from role pools
  - Exact stat calculation (85 EVs, 31 IVs, neutral nature)
  - Legal action rules (switches, trapped mons, PP, disabled moves)
  - Format-specific evaluation weights
  - State reconciliation against server's `|request|` JSON
- Other formats (OU, Doubles, etc.) can now be added by implementing the Format interface without touching search, client, logger, or learning infrastructure

### 2. Live Freshness System ✅
**Files**: `src/data/freshness-checker.ts`, `src/data/data-loader.ts`

- **Automatic version checking**: On startup and at most once per 24 hours
- **Data sources monitored**:
  - smogon/pokemon-showdown gen9 random-battle sets.json
  - pkmn randbats stats
  - @pkmn/sim version
- **Change detection & logging**:
  - Species added/removed (with names)
  - Level changes per species
  - Species count changes in stats
  - @pkmn/sim version changes with warning if behind server
- **Auto-refresh**: Downloads and saves updated data when changes detected
- **Metadata tracking**: Stores hashes and timestamps in `data/metadata.json`

### 3. State Reconciliation ✅
**Files**: `src/formats/gen9-randombattle.ts`, `src/bot/bot.ts`

- Bot now calls `format.reconcileState(tracked, request)` every turn
- Compares tracked GameState against server's ground-truth `|request|` JSON
- Logs mismatches with severity levels (info/warning/error):
  - Team size discrepancies
  - Species mismatches
  - HP value differences  
  - Active index mismatches
- All mismatches logged to battle record for debugging

### 4. Search Engine Improvements
**Files**: `src/engine/robust-search.ts`, `src/engine/world-builder.ts`, `src/engine/sim-wrapper.ts`

- **Replaced** `DeterminizedSearch` with `RobustSearch`:
  - 3-ply expectiminimax lookahead (was 1-ply)
  - Multiple determinized worlds (configurable, default 4-5)
  - Opponent behavior weighting (advantage/neutral/disadvantage situations)
  - Time budget enforcement (default 1200ms per turn)
  
- **Created** `WorldBuilder`:
  - Samples opponent sets from belief distributions
  - Fills unrevealed moves from role data
  - Preserves Set/Map types during cloning
  
- **Created** `SimWrapper` for @pkmn/sim integration:
  - Interface designed for real Battle objects
  - **Currently uses fallback**: Full mid-battle Battle reconstruction is complex
  - Fallback uses improved damage calculations with exact @pkmn/sim move data
  - Action conversion to choice strings
  - State extraction from Battle objects (structure in place)

### 5. Evaluation Function Improvements ✅
**Files**: `src/engine/evaluator.ts`

- **HP-weighted material**: Accounts for partial HP, not just alive/dead
- **Type matchup awareness**: Bonus for super-effective coverage, penalty for resisted moves
- Format-specific weights from `Format.getEvaluatorWeights()`
- Better hazard valuation
- Information advantage tracking

### 6. Infrastructure Updates ✅
**Files**: `src/bot/bot.ts`, `src/learning/self-play.ts`, `src/cli/*.ts`

- Made `Bot.selectAction()` async to support proper simulation
- Updated all CLI scripts to initialize format before data loading
- Bot constructor now requires `Format` parameter
- Evaluator uses format-specific weights
- Search configuration increased: 1200ms time, 4-5 worlds, 3-ply depth

### 7. Type System Improvements ✅
**Files**: `src/types/index.ts`, `src/types/format.ts`

- Added `currentHp`, `maxHp`, `status`, `boosts` to `PokemonBelief`
- Added `EvaluatorWeights` interface
- All format-specific types in `format.ts`

## Current Performance

**Measured over 150 games each:**
- **MCTS vs Random**: 71.33% (target: >= 95%)
- **MCTS vs Max-Damage**: 77.33% (target: >= 80%)
- Max-Damage vs Random: 82%

## Known Limitations

### Critical: Exact Mechanics Not Yet Integrated
The `SimWrapper` is designed for @pkmn/sim Battle objects but currently falls back to hand-written damage simulation. Full integration requires:

1. **Mid-battle Battle reconstruction**: 
   - Build team strings from current GameState
   - Create Battle with proper state (HP, status, boosts, hazards, field)
   - This is very complex - Battle objects don't have a simple "set state" API
   
2. **Alternative approach** (recommended):
   - Use Battle toJSON/fromJSON for cloning
   - Or maintain parallel Battle objects during actual games
   - Apply choose() to step forward each simulated node

3. **Why this matters**:
   - Hand-written simulator misses: status conditions, abilities, weather, terrain, items, priority, accuracy, crits, secondary effects
   - Can't learn optimal strategy against mechanics that aren't modeled
   - 71% vs random is suspiciously low - likely search is making bad predictions due to inexact sim

### Search Performance Gaps
- 71% vs random when target is 95%: indicates systematic issues
- Likely causes:
  - Inexact forward model leads to bad action values
  - Evaluation function may not capture win conditions
  - Opponent model may be sampling unrealistic responses
  - Search depth/breadth may be insufficient

## Next Steps to Reach Targets

1. **Implement real @pkmn/sim integration** (highest priority):
   - Either full Battle reconstruction or maintain shadow Battle during games
   - Use actual Battle.choose() for search tree expansion
   - This should immediately improve win rate by fixing prediction errors

2. **Analyze losses vs random**:
   - Review battle logs to find systematic mistakes
   - Are we over-switching? Under-switching?
   - Missing obvious KOs?
   - Bad switch-in decisions?

3. **Tune evaluation** once simulator is exact:
   - Run self-play to collect training data
   - Optimize weights via CMA-ES or similar
   - Add missing heuristics (speed control, win conditions, etc.)

4. **Increase search quality**:
   - More opponent action samples
   - Better behavioral models  
   - Deeper search if time permits

5. **Test websocket client** against local pokemon-showdown server

## Files Changed (16 total)

### New Files (7)
1. `src/types/format.ts` - Format interface
2. `src/formats/gen9-randombattle.ts` - Gen9 Random Battle implementation
3. `src/data/freshness-checker.ts` - Auto-refresh system
4. `src/engine/robust-search.ts` - New 3-ply search
5. `src/engine/world-builder.ts` - Determinized world construction
6. `src/engine/sim-wrapper.ts` - @pkmn/sim integration wrapper
7. `src/engine/improved-search.ts` - Intermediate implementation (kept for reference)

### Modified Files (9)
1. `src/types/index.ts` - Added HP/status fields, EvaluatorWeights
2. `src/bot/bot.ts` - Format parameter, async selectAction, reconciliation
3. `src/data/data-loader.ts` - Freshness checking integration
4. `src/engine/evaluator.ts` - HP-weighted material, type awareness
5. `src/learning/self-play.ts` - Format integration, async bot calls
6. `src/cli/selfplay.ts` - Format initialization
7. `src/cli/benchmark.ts` - Format initialization  
8. `src/cli/ladder.ts` - Format initialization
9. `src/engine/simulator.ts` - Improved fallback (still used by some code)

## Verification Commands

```bash
# Test freshness checking
npm run data:refresh

# Run benchmarks
npm run build
node dist/cli/selfplay.js 50 mcts random
node dist/cli/selfplay.js 50 mcts maxdamage

# Check for state mismatches
node dist/cli/selfplay.js 10 mcts random --verbose 2>&1 | grep "State mismatches"
```

## Honest Assessment

**What works**:
- Format abstraction is clean and extensible
- Freshness system catches data changes
- Search infrastructure is in place (async, 3-ply, determinization)
- Win rate improved from baseline (~45%) to 71-77%

**What's blocking 95% target**:
- Search forward model is still inexact (hand-written, not @pkmn/sim)
- This causes bad predictions -> bad action selection
- Can't tune eval weights effectively on inexact model
- Need to bite the bullet and do proper Battle integration

**Time investment**:
- Format system: ~2 hours (done correctly)
- Freshness: ~30 mins (done correctly)
- Search improvements: ~3 hours (structure good, sim integration incomplete)
- **Still needed**: ~4-6 hours for proper @pkmn/sim Battle integration + tuning

The foundation is solid. The missing piece is using real Battle mechanics in search, which is non-trivial but doable.
