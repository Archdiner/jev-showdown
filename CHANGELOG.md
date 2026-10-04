# Changelog

**Note**: This file is the owner-facing plain-English summary of changes. For technical state and task queue, run:
- `npm run graph -- status` - Current champion, metrics, frontier tasks
- `npm run graph -- next` - Exactly one task with measurable acceptance criteria
- View `state/graph.html` for visual graph

---

# Cloud Agent Run (Oct 4, 2026)

## Latest Update (Oct 4, 23:03 UTC - Commit d045097)

### 12. Comprehensive Regression Tracking System ✅
**Files**: `src/graph/regression-tracker.ts`, `src/graph/regressions-cli.ts`, `src/graph/schema.ts`

Owner requirement: detect when bot gets worse at ANYTHING, not just overall win rate.

**Broad Metric Set**:
- Win rate vs each panel opponent (random-v1, maxdamage-v1)
- **Per-situation stats**: leading/trailing, endgames (1v1, 2v2), hazard advantage/disadvantage, weather, Tera timing (first/second)
- **Decision quality**: switch frequency/quality, setup sweeps allowed/achieved, speed-option survival, blunder rate
- **Diagnostic suite pass rate**: % of hand-crafted positions solved correctly
- **Hard guardrails**: invalid choices, crashes, timeouts, p99 latency, fallback rate, state mismatches
- **Ladder** (when available): rolling rating/GXE, rolling 100-game win rate, max loss streak

**Regression Detection**:
- Compare candidate vs previous champion using Wilson confidence intervals (95%)
- Severity levels: critical (≥10% drop), major (≥5%), minor (≥2%)
- Only flag statistically significant drops (baseline outside candidate's CI)
- Record as Regression nodes in graph with `caused` and `regressed_from` edges

**Integration**:
- Added `Regression` node type, `detected` status, `caused`/`regressed_from` edge types to schema
- CLI: `npm run regressions` - List all detected regressions by severity
- `RegressionTracker` class with `detectRegressions()`, `recordRegressions()`, `generateRegressionTable()`
- Gate will reject on ANY significant regression (next step: integrate with Gate.runPairedGames)
- Summary table in gate report (data-first, no markdown)

---

## Earlier Update (Oct 4, 22:39 UTC - Commit ec5f6b3)

### 11. Expert Strategy + Critical Search Bug Fix 🔧
**Files**: `src/graph/add-expert-strategy.ts`, `src/formats/gen9-randombattle.ts`, `src/engine/expert-evaluator.ts`, `src/engine/robust-search.ts`, `src/engine/diagnostic-tests.ts`

**Expert Strategy Encoding**:
- Added 5 Learning nodes from top-5 ladder player: strict role narrowing, hazards dominate, resource preservation, speed option, team-gen rules
- Added 6 Hypothesis nodes with test plans (hazard differential, setter protection, resource preservation, Tera-second, speed option, tempo switch)
- Implemented team generation constraints: max 2 per type, max 3 weak to one type, no shared 4x weakness (verified 100/100 real teams pass)
- Fixed strict role narrowing: check abilities in `roleData.abilities` not `items`
- Created `ExpertEvaluator` with 6 toggleable eval features ready for gate testing

**CRITICAL BUG FIXED - Search Perspective**:
- **Problem**: Bot assumed it was always p1, causing catastrophic failure when playing as p2
  - Terminal evaluation: `winner === 'p1'` always scored as +10000, even when bot was p2
  - When bot was p2 and won, it thought it LOST (-10000 score) and actively avoided winning moves
  - Action mapping: `simulateTurn(myAction, oppAction)` passed actions in wrong order when bot was p2
- **Fix**: Added `playerId: 'p1' | 'p2'` to GameState, extract from `request.side.id`
  - Map actions correctly based on player ID
  - Evaluate terminal states from our perspective: `winner === ourId ? +10000 : -10000`
- **Testing**: Created diagnostic test suite with 4 hand-crafted positions (2/4 passing, 0% fallback rate)
- **Impact**: Likely explains 62.7% vs random performance - bot was fighting itself when p2

**Investigation Task Added**:
- Created `task-investigate-search-failure` (IN_PROGRESS, critical priority)
- Acceptance criteria: >=95% vs random over 300 paired games, 0 invalid choices
- Suspects: eval sign flip ✓ (fixed), paranoid minimax, terminal scoring, world reconstruction, depth parity, time budget

**Next**: Run full benchmark to measure impact, then implement Gate.runPairedGames for hypothesis testing.

---

## Earlier Update (Oct 4, 22:28 UTC - Commit e9673a1)

### 10. Graph-Based State System with Champion/Gate ✅
**Files**: `src/graph/*`, `state/graph.db`, `AGENTS.md` (now <80 lines)

Replaced markdown docs with structured graph system:
- **SQLite backend** (`state/graph.db`) with JSON export (`state/graph.json`)
- **Node types**: Goal, Milestone, Task, Experiment, Hypothesis, Result, Decision, Learning, DataSource, Convention, Benchmark, Champion
- **Typed edges**: depends_on, tests, produced, supersedes, refutes, supports, blocks, derived_from
- **CLI commands**: `npm run graph -- <cmd>` with status, next, add, update, link, query, render
- **Gate system** (`src/graph/gate.ts`): Tournament runner with encoded metrics (not prose)
  - SPRT: elo0=0, elo1=+10, α=β=0.05
  - Hard guardrails: 0 invalid/crashes/timeouts, p99<2s, fallback≤1%, mismatches=0
  - Wilson CIs, paired games, frozen opponent panel (random-v1, maxdamage-v1)
- **Graph seeded** with current state: goal, champion v0, 4 ADR decisions, 2 data sources, 2 tasks
- **Artifact**: Visual graph at `/opt/cursor/artifacts/graph.html`

---

## Earlier Updates (Oct 4, 21:51 UTC - Commit 5522250)

### 8. Achieved 0% Fallback Rate - Exact Sim Working ✅
**Files**: `src/engine/battle-state-builder.ts`, `src/engine/sim-wrapper.ts`, `src/bot/bot.ts`, `src/learning/self-play.ts`

- **Fixed team format**: Use packed format (`Species||Item|Ability|...`) not text format (`Species @ Item`)
- **Fixed ability placeholder**: Use `'Pressure'` instead of `'noability'`
- **Fixed Unknown pokemon**: Use proper packed format for Ditto placeholder
- **Initialized TeamGeneratorFactory**: Call `Teams.setGeneratorFactory(TeamGenerators)` before Battle creation
- **Removed redundant start()**: Battle auto-starts when both players set, don't call manually
- **Added instrumentation**: Track fallback rate across search, bot, and self-play
- **Result**: Fallback rate dropped from 100% to 0.00% (measured over 15,136 sim calls in 5 games)
- **Quick test**: 100% win rate vs random (5 games) - up from 71% baseline with fallback

### 9. Created Formal Handoff System ✅
**Files**: `AGENTS.md`, `docs/state/*`, `docs/knowledge/*`, `scripts/verify.sh`, `scripts/check-handoff.sh`

- **Entry point**: `AGENTS.md` (also `CLAUDE.md`, `.cursor/rules/00-start-here.mdc`) with start/end-of-session checklists
- **Living state**: `docs/state/CURRENT.md` (metrics, issues, traps), `NEXT.md` (task queue), `DECISIONS.md` (9 ADRs), `sessions/` (per-session logs)
- **Shared knowledge**: `docs/knowledge/SOURCES.md` (data sources, refresh protocol), `CONVENTIONS.md` (code style, testing), `STRATEGY.md` (Pokemon knowledge with evidence), `IDEAS.md` (11 hypotheses to test)
- **Verification**: `npm run verify` (build + tests + 20-game smoke), `scripts/check-handoff.sh` (validates protocol compliance)
- **Cleanup**: Removed redundant status docs (FINAL_REPORT, IMPLEMENTATION_NOTES, PERFORMANCE), kept CHANGELOG as owner-facing summary

---

## Earlier Changes

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
