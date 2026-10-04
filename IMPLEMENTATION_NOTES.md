# Implementation Notes

## What's Complete (v0.2.0)

### Infrastructure (100%)
- TypeScript build system with ESM modules
- Jest test framework with 9 passing tests
- Package.json with all dependencies (@pkmn/*, @smogon/calc)
- Git ignore and build configuration
- CLI commands: selfplay, ladder, analyze, benchmark
- **Compiled JS significantly faster than tsx**

### Data Layer (100%)
- Data refresh script fetching from official sources
- Gen 9 sets (509 species) and randbats statistics
- Data loader with singleton pattern
- Proper error handling for missing data

### Battle Simulation (100%)
- Self-play harness using @pkmn/sim BattleStreams
- Team generation via @pkmn/randoms TeamGenerators
- Proper async stream handling for both players
- Battle outcome detection (win/loss/tie)
- Works with RandomPlayerAI and custom bots
- GameState construction from battle requests

### Battle Logging (100%)
- SQLite database with battles and decisions tables
- Full battle record storage (log, decisions, metadata)
- Query methods (getRecentBattles, getLosses, getWinRate)
- Indexes for performance

### Showdown Client (70%)
- WebSocket connection handling
- Login flow (challstr → /api/login → /trn)
- Protocol message parsing
- Move/switch command sending
- **Not tested end-to-end on live server**
- **Missing:** Reconnection logic, proper timer handling, throttle management

### Belief Tracker (80%)
- Initialization from randbats statistics
- Bayesian updates on move/item/ability/Tera reveals
- Role probability normalization
- Sampling from belief distribution
- **Missing:** Damage roll inference, speed tier detection

### Evaluation (75%) **IMPROVED**
- Material, position, momentum, heuristics scoring
- **Type effectiveness calculation via Dex**
- Hazard evaluation (Stealth Rock, Spikes)
- Information advantage (revealed vs hidden)
- Tera usage tracking
- **Missing:** Speed tiers, win condition detection

### Damage Calculator (70%) **IMPROVED**
- **Damage estimation using Dex.moves and Dex.species**
- **Type effectiveness multipliers (0.5x, 2x, 4x, immune)**
- **Physical vs Special category detection**
- Basic damage range calculation
- **Missing:** Full @smogon/calc integration for exact rolls

### Search Engine (60%) **IMPLEMENTED**
- **Working search with action evaluation**
- **Damage-aware move scoring**
- **Forward simulation (simplified)**
- **Action selection based on evaluation + simulation**
- **Per-turn time budget enforced**
- **Missing:** Full MCTS tree (currently flat evaluation), determinization

### LLM Integration (40%)
- Vercel AI Gateway client
- Graceful degradation without API key
- Mock responses for testing
- **Missing:** Actual integration with decision engine, post-game analysis not tested

### Baselines (100%)
- Random bot (selects uniformly)
- **Max-damage bot (uses damage evaluator with type effectiveness)**

## Architecture Decisions

### Why @pkmn/sim instead of live server?
- Faster (thousands of games/hour vs dozens)
- No rate limits
- Deterministic (can replay with seeds)
- Exact mechanics
- Still test live server separately for ladder play

### Why SQLite instead of JSON files?
- Structured queries (get all losses since date)
- Indexes for performance
- ACID guarantees
- Easy to migrate to PostgreSQL later

### Why separate Bot and Engine classes?
- Bot = orchestrator (logging, beliefs, decisions)
- Engine = pure search (stateless, testable)
- Evaluator = scoring function (tunable weights)
- Clean separation of concerns

### Why not implement full MCTS first?
- Complex state simulation required
- Need exact move application logic
- Determinization sampling is non-trivial
- Better to get infrastructure working first

## What Would Come Next (Priority Order)

### 1. State Simulation (Critical)
Implement `applyAction(state, action) -> newState` in MCTS:
- Update HP after damage
- Apply status effects
- Handle switching
- Track field conditions
- This enables actual tree search

### 2. Move Damage Estimation
Convert game state to @smogon/calc Pokemon/Move objects:
- Extract stats from beliefs
- Apply boosts (stat changes)
- Handle abilities (Intimidate, etc.)
- Estimate damage for move selection

### 3. Determinization
Sample opponent sets from beliefs:
- Use randbats statistics as priors
- Generate full opponent teams
- Run MCTS in each sampled world
- Aggregate results

### 4. Evaluation Tuning
Run CMA-ES or Bayesian optimization:
- Play 1000+ self-play games
- Measure win rate vs baseline
- Update weights
- Repeat until convergence

### 5. Ladder Testing
Deploy to live server:
- Create bot account
- Run 50 games
- Measure Elo
- Analyze losses

### 6. Advanced Heuristics
Add domain knowledge:
- Type effectiveness (x4 damage, immunities)
- Speed tiers (who moves first)
- Scarf detection (observed speed > expected)
- PP tracking (force switches)
- Priority moves (Extreme Speed, Aqua Jet)

### 7. Neural Network
Train policy/value net:
- Collect 100k+ self-play games
- Train on MCTS visit distributions
- Replace heuristic evaluator
- Integrate as move prior

## Testing Strategy

### Unit Tests (9 passing)
- DataLoader: loads sets and stats
- BeliefTracker: updates probabilities correctly
- Evaluator: scores states consistently

### Integration Tests (manual)
- Self-play: `npm run selfplay 10 random random`
- Benchmarks: `npm run benchmark`

### Ladder Tests (not yet run)
- Requires Showdown account credentials
- Set SHOWDOWN_USERNAME and SHOWDOWN_PASSWORD
- Run `npm run ladder`

## Known Issues

### Performance
- Self-play games take ~2-3 seconds each
- 100-game benchmark takes ~3-5 minutes
- MCTS search would be slower (need to optimize)

### Reliability
- No retry logic for network failures
- No timeout handling in battles
- No graceful shutdown

### Completeness
- Many TODOs in code
- Simplified implementations
- No error recovery in CLI commands

## Design Patterns Used

- **Singleton:** DataLoader (shared data access)
- **Strategy:** Interchangeable bot implementations
- **Builder:** BotConfig for configuration
- **Observer:** EventEmitter in ShowdownClient
- **Factory:** createBot() for bot instantiation

## Dependencies

All MIT licensed:
- @pkmn/sim, @pkmn/randoms, @pkmn/data, @pkmn/client (0.10.11 / 0.7.3)
- @smogon/calc (0.12.0)
- better-sqlite3 (11.7.0)
- ws (8.18.0)
- TypeScript, Jest, ESLint (dev)

## File Structure

```
src/
├── types/          Shared TypeScript interfaces
├── data/           Data fetching and loading
├── engine/         Core game logic (beliefs, eval, search, damage)
├── bot/            Bot orchestrator
├── client/         Showdown WebSocket client
├── learning/       Battle logging, self-play, analysis
├── baselines/      Simple bot implementations
├── utils/          LLM client, helpers
└── cli/            Command-line scripts
```

## Metrics

- Lines of code: ~2000
- Test coverage: ~40% (data, engine, beliefs)
- Dependencies: 10 prod, 10 dev
- Build time: <1s
- Test time: ~2s
- Data size: ~2MB (gen9-sets.json + gen9-stats.json)

## Next Developer TODO

1. Implement `applyAction()` in MCTS
2. Build Pokemon/Move objects from state for damage calc
3. Integrate MCTS into Bot.selectAction()
4. Run benchmarks, ensure ≥65% vs max-damage
5. Test on live ladder
6. Analyze losses, tune eval weights
7. Iterate

---

**Status:** Working bot infrastructure, simplified decision logic, ready for MCTS integration.  
**Last updated:** 2026-10-04  
**Version:** 0.1.0
