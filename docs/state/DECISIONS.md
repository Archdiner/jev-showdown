# Architecture Decision Records

**Format**: ADR-style append-only log. Each decision includes context, decision, alternatives rejected, and consequences.

---

## ADR-001: TypeScript with @pkmn Ecosystem

**Date**: 2026-10-03  
**Status**: Accepted  
**Commit**: Initial

**Context**: Need accurate Pokemon mechanics and battle simulation. Options were building from scratch, using unofficial simulators, or using official @pkmn packages.

**Decision**: Use TypeScript with @pkmn/sim, @pkmn/dex, @pkmn/randoms for all battle mechanics and data.

**Alternatives Rejected**:
- Python with unofficial simulators - Less accurate, GPL licensing risks
- Building custom simulator - Too error-prone, would miss edge cases
- JavaScript instead of TypeScript - Wanted strong typing for complex game state

**Consequences**:
- ✅ Exact official mechanics guaranteed (same engine as Pokemon Showdown)
- ✅ Auto-updates when formats change (through data refresh system)
- ✅ MIT license compatible with all packages
- ⚠️ Tied to @pkmn update cycle for new Pokemon/moves

---

## ADR-002: MIT-Only Licensing

**Date**: 2026-10-03  
**Status**: Accepted (Non-Negotiable)  
**Commit**: Initial

**Context**: Open source project needs clear, permissive licensing for maximum reuse and contribution.

**Decision**: All dependencies must be MIT, Apache-2.0, BSD, or equivalent permissive licenses. No GPL/AGPL.

**Alternatives Rejected**:
- GPL dependencies - Too restrictive, would force entire project GPL
- Proprietary code - Against open source mission

**Consequences**:
- ✅ Anyone can use, modify, commercialize the code
- ✅ Easy to contribute and fork
- ❌ Cannot use some GPL-licensed ML libraries or simulators
- Ongoing: Must vet every new dependency

---

## ADR-003: Search-First Over LLM-First

**Date**: 2026-10-03  
**Status**: Accepted  
**Commit**: Initial

**Context**: Two approaches to bot decision-making: (1) LLM generates move choices, (2) Traditional search with optional LLM priors.

**Decision**: Core decision-making uses game-tree search (expectiminimax). LLMs optional for priors/heuristics only.

**Alternatives Rejected**:
- LLM-only approach - Too slow, less reliable, harder to debug
- Rule-based without search - Can't look ahead, misses tactics

**Consequences**:
- ✅ Decisions are explainable (can trace search tree)
- ✅ Fast enough for real-time play (<2s per turn)
- ✅ Improves with better evaluation, not just more training data
- ⚠️ Requires accurate forward model (exact sim)
- ⚠️ Limited by search depth and eval quality

---

## ADR-004: Public Randbats Data with Bayesian Narrowing

**Date**: 2026-10-03  
**Status**: Accepted  
**Commit**: Initial

**Context**: Opponent team is unknown. Need to sample likely sets for search tree exploration.

**Decision**: Use public pkmn.github.io/randbats statistics for role pools, narrow by revealed moves/items/abilities using Bayesian inference.

**Alternatives Rejected**:
- Uniform sampling over all legal sets - Too slow, mostly irrelevant
- Perfect information (assume we see opponent team) - Unrealistic
- Learn opponent model from ladder games - Needs too much data first

**Consequences**:
- ✅ Search explores realistic opponent responses
- ✅ Improves as more info is revealed (Bayes updating)
- ✅ Data auto-refreshes from public sources
- ⚠️ Initial belief may be wrong if opponent uses rare set
- ⚠️ Dependent on public stats being up-to-date

---

## ADR-005: Format Interface for Extensibility

**Date**: 2026-10-04  
**Status**: Accepted  
**Commit**: e30a2a2

**Context**: Bot should support multiple formats (gen9randombattle, gen9ou, gen9doubles, etc.) without duplicating core logic.

**Decision**: Created `Format` interface with format-specific methods (set sampling, legal actions, stat calculation, evaluation weights). Core bot/search/logger are format-agnostic.

**Alternatives Rejected**:
- Hardcode gen9randombattle everywhere - Not extensible
- Runtime format string checks - Error-prone, harder to type-check
- Separate bot class per format - Code duplication

**Consequences**:
- ✅ Adding new format = implement Format interface only
- ✅ Can compare performance across formats
- ✅ Format-specific logic is isolated and testable
- ⚠️ Format interface may need updates for very different formats (Hackmons, etc.)

---

## ADR-006: Jev as the Bot Identity

**Date**: 2026-10-04  
**Status**: Accepted  
**Commit**: e30a2a2

**Context**: Bot needs a recognizable identity on the ladder.

**Decision**: Bot is named "Jev" (short, memorable). Repo is jev-showdown.

**Alternatives Rejected**:
- Generic name like "RandomBattleBot" - Boring
- Complex name - Hard to remember

**Consequences**:
- ✅ Easy to search for on ladder
- ✅ Can build reputation over time
- Neutral: No particular advantages or disadvantages

---

## ADR-007: Local Self-Play for Training and Benchmarking

**Date**: 2026-10-04  
**Status**: Accepted  
**Commit**: e30a2a2

**Context**: Need reproducible performance measurement and training data generation.

**Decision**: Built self-play harness using @pkmn/sim BattleStreams. Runs offline, logs full battle transcripts, measures win rates.

**Alternatives Rejected**:
- Only test on ladder - Can't reproduce, slow feedback
- Simplified test scenarios - Wouldn't catch real bugs
- External battle servers - Dependency on uptime

**Consequences**:
- ✅ Fast iteration (no network latency)
- ✅ Reproducible benchmarks (same opponents, same RNG seed)
- ✅ Full battle logs for debugging
- ✅ Can generate unlimited training data
- ⚠️ Self-play may miss ladder-specific edge cases

---

## ADR-008: Exact Sim in Search, Not Fallback

**Date**: 2026-10-04  
**Status**: Accepted (Non-Negotiable)  
**Commit**: 5522250

**Context**: Original implementation had hand-written damage calculator as fallback when Battle creation failed. This gave ~100% fallback rate, meaning search wasn't using exact mechanics.

**Decision**: Fixed Battle creation to achieve 0% fallback rate. Search MUST use real Battle.makeChoices() for forward simulation.

**Alternatives Rejected**:
- Accept partial fallback - Inaccurate predictions, bad decisions
- Improve fallback to match sim better - Still wouldn't be exact
- Use @smogon/calc for damage - Only does damage, not full turn

**Consequences**:
- ✅ Search predictions are now accurate (same as actual game)
- ✅ Can trust lookahead to find tactics
- ✅ Bot improves automatically when @pkmn/sim fixes bugs
- ⚠️ More complex code (Battle state forcing)
- ⚠️ Requires keeping GameState in sync with Battle internals

---

## ADR-009: 3-Ply Expectiminimax with Determinization

**Date**: 2026-10-04  
**Status**: Accepted (May Revisit)  
**Commit**: e30a2a2

**Context**: Need search algorithm that handles simultaneous moves, hidden information, and stochastic outcomes.

**Decision**: 3-ply expectiminimax search with determinization (sample opponent sets), weighted by behavioral model.

**Alternatives Rejected**:
- 1-ply (greedy) - Too shallow, misses tactics
- MCTS - Harder to tune, slower to converge
- Alpha-beta (perfect info) - Ignores hidden information
- Deeper search - Time budget wouldn't allow

**Consequences**:
- ✅ Finds 3-move tactics reliably
- ✅ Fast enough (<2s per turn)
- ✅ Balances exploration of opponent responses
- ⚠️ May miss 4+ move tactics
- ⚠️ Determinization can miss rare but important opponent sets
- Revisit: May increase to 4-ply if time budget allows

---

## Future Decisions to Document

- Choice of evaluation features and weights (after tuning)
- Search enhancements (if adopted)
- Opening book format (if implemented)
- Endgame tablebase approach (if implemented)
- Learning algorithm for weight optimization (CMA-ES vs gradient descent vs...)
