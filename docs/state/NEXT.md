# Task Queue

**Last Updated**: 2026-10-04 21:51 UTC (commit 5522250)

## IN_PROGRESS

### None
All tasks below are TODO. Pick the top one to start.

---

## TODO (Ordered by Priority)

### 1. Comprehensive Benchmark with Exact Sim
**Goal**: Measure true win rates with 0% fallback rate to establish baseline

**Why**: Current metrics (71% vs random, 77% vs max-damage) were measured with 100% fallback (hand-written sim). Need to know actual performance with exact @pkmn/sim mechanics before further optimization.

**Acceptance Criteria**:
- Run 300+ games: MCTS vs Random
- Run 300+ games: MCTS vs Max-Damage
- Fallback rate stays 0.00%
- Per-turn latency < 2000ms (reasonable for search)
- Record win rates, avg game length, latency distribution in CURRENT.md
- Export 3+ loss replays for analysis

**Files Likely Involved**:
- `src/cli/selfplay.ts` - Run benchmarks
- `docs/state/CURRENT.md` - Update metrics table
- `artifacts/replays/` - Export loss replays

**Status**: TODO

---

### 2. Complete Battle State Forcing
**Goal**: Preserve all battle state (status, boosts, hazards, weather) when creating Battle objects for search

**Why**: Current forceState() only sets HP and basic hazards. Missing status (burn, paralysis) and boosts means search makes wrong predictions when these are active.

**Acceptance Criteria**:
- Set status conditions (burn, paralysis, sleep, freeze, poison, toxic, none)
- Set stat boosts for all stats (-6 to +6)
- Set Spikes/Toxic Spikes layers (0-3)
- Set screens (Light Screen, Reflect) with turn counters
- Set weather (Sun, Rain, Sandstorm, Snow) and terrain
- Set volatile status where feasible (Substitute, Leech Seed, etc.)
- Write tests for state preservation
- Verify: create Battle from mid-game state, extract state back, should match

**Files Likely Involved**:
- `src/engine/battle-state-builder.ts` - forceState() method
- `src/types/index.ts` - May need to track more state in GameState
- `src/engine/battle-state-builder.test.ts` - New test file

**Status**: TODO

---

### 3. Analyze Losses to Find Systematic Blunders
**Goal**: Identify patterns in losses vs random/max-damage to guide improvements

**Why**: Even with exact sim, if win rate is below target, need to understand WHY the bot loses to improve strategy/evaluation.

**Acceptance Criteria**:
- Export 10+ loss replays vs random
- Export 10+ loss replays vs max-damage
- Manual review: classify each loss (over-switching? missed KO? bad matchup? poor switch-in? failed to set up?)
- Document patterns in docs/knowledge/STRATEGY.md
- Propose concrete improvements in IDEAS.md

**Files Likely Involved**:
- `src/cli/export-replays.ts` - Generate loss replays
- `artifacts/replays/` - Review files
- `docs/knowledge/STRATEGY.md` - Document findings
- `docs/state/IDEAS.md` - Propose fixes

**Status**: TODO

---

### 4. Tune Evaluation Function
**Goal**: Optimize evaluation weights to maximize win rate

**Why**: Hand-tuned weights may not be optimal. Especially important after exact sim and state forcing are complete.

**Acceptance Criteria**:
- Collect training data: 1000+ self-play games with outcome labels
- Implement weight optimization (CMA-ES, Bayesian opt, or gradient descent)
- Test: 100+ games with new weights vs old weights
- Improvement: +5% win rate or better
- Document chosen weights and rationale in DECISIONS.md

**Files Likely Involved**:
- `src/learning/train-evaluator.ts` - New file for training
- `src/engine/evaluator.ts` - Apply optimized weights
- `src/learning/self-play.ts` - Generate training data
- `docs/state/DECISIONS.md` - Log optimization approach

**Status**: TODO

---

### 5. Add Missing Evaluation Heuristics
**Goal**: Improve position evaluation beyond material+matchups

**Why**: Current evaluator is basic. Missing concepts like speed control, setup opportunities, win condition detection.

**Acceptance Criteria**:
- Speed control: Bonus for outspeeding opponent, penalty for being outsped
- Setup detection: Recognize when opponent is boosting (Dragon Dance, Calm Mind, etc.)
- Win condition: Recognize when opponent's team can't touch our mon (e.g., Ghost vs all Normal moves)
- Implement each heuristic as optional weight in EvaluatorWeights
- Test each individually: does it improve win rate?
- Document in STRATEGY.md with evidence

**Files Likely Involved**:
- `src/engine/evaluator.ts` - Add new heuristics
- `src/types/format.ts` - New weight fields
- `docs/knowledge/STRATEGY.md` - Document strategy knowledge
- `docs/state/IDEAS.md` - Test results

**Status**: TODO

---

### 6. Increase Search Quality (Deeper/Broader)
**Goal**: Improve search accuracy through better exploration

**Why**: 3-ply may not be enough. More opponent action samples and deeper search could improve decision quality.

**Acceptance Criteria**:
- Experiment: 4-ply search (if time budget allows)
- Experiment: 6-8 opponent action samples (currently 4)
- Experiment: Better opponent behavioral model (use revealed moves to weight likely actions)
- Each experiment: 100+ game A/B test vs baseline
- Only adopt if +3% win rate and latency acceptable
- Document results in IDEAS.md

**Files Likely Involved**:
- `src/engine/robust-search.ts` - Depth and sample count
- `src/types/format.ts` - Behavioral model in predictBehavior()
- `docs/state/IDEAS.md` - Experiment results

**Status**: TODO

---

### 7. Implement Websocket Client for Live Play
**Goal**: Connect to real Pokemon Showdown server and play ladder games

**Why**: Self-play is useful for training, but real ladder games provide true skill assessment and edge cases.

**Acceptance Criteria**:
- Connect to showdown server with auth
- Handle all protocol messages (|switch|, |-damage|, |win|, etc.)
- Respect turn timer (20-30s hard limit)
- Graceful reconnection on disconnect
- Play 10+ ladder games without crashes
- Log ladder rating progression

**Files Likely Involved**:
- `src/client/showdown-client.ts` - Websocket protocol
- `src/cli/ladder.ts` - May need updates
- `src/bot/bot.ts` - Timer-aware action selection

**Status**: TODO

---

## DONE

### Achieve 0% Fallback Rate
**Completed**: 2026-10-04 (commit 5522250)

- Fixed team string format (packed format, no `@`)
- Initialized TeamGeneratorFactory
- Fixed ability placeholders (use 'Pressure' not 'noability')
- Fixed Unknown pokemon placeholders (packed format)
- Removed redundant battle.start() call
- Result: 0.00% fallback rate measured over 15,136 sim calls

### Create Agent Handoff System
**Completed**: 2026-10-04 (commit pending)

- Created AGENTS.md with start/end-of-session checklists
- Created docs/state/ structure (CURRENT.md, NEXT.md, DECISIONS.md, sessions/)
- Created docs/knowledge/ structure (SOURCES.md, CONVENTIONS.md, STRATEGY.md, IDEAS.md)
- Added npm run verify script
- Added scripts/check-handoff.sh validation
