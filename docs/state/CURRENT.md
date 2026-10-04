# Current State

**Last Updated**: 2026-10-04 21:51 UTC (commit 5522250)

## What Works

### ✅ Exact Game Mechanics Integration
- **Real @pkmn/sim Battle objects** created from GameState
- **Battle.makeChoices()** used for all forward simulation in search
- **Fallback rate: 0.00%** (measured over 15,136 sim calls in 5 games)
- Team string generation uses correct packed format
- TeamGeneratorFactory initialized for Battle creation
- HP, status, boosts, hazards, active pokemon properly synced

### ✅ Core Infrastructure
- **Format abstraction**: Clean interface for gen9randombattle, extensible to other formats
- **Data freshness**: Auto-checks and updates sets/stats from smogon/pkmn sources
- **State reconciliation**: Validates tracked state against server `|request|` JSON every turn
- **Belief tracking**: Narrows opponent sets based on revealed moves/items/abilities
- **3-ply expectiminimax search**: 1200ms time budget, 4-5 determinized worlds
- **Self-play harness**: Runs games, collects logs, measures metrics

### ✅ Testing & Tooling
- 3 passing test suites (belief-tracker, evaluator, data-loader)
- Replay export to standalone HTML files
- Build pipeline (TypeScript) and linting (ESLint)
- All dependencies MIT-licensed

## What's Broken or Approximated

### ⚠️ Performance Below Target
**Current** (as of Oct 4, measured on earlier commits before exact sim):
- MCTS vs Random: **71.33%** over 150 games (target: ≥95%)
- MCTS vs Max-Damage: **77.33%** over 150 games (target: ≥80%)

**Note**: These metrics are from before the exact sim integration (commit 5522250). Need fresh benchmarks with 0% fallback rate to measure true performance.

### ⚠️ Battle State Forcing Incomplete
`BattleStateBuilder.forceState()` currently sets:
- ✅ HP and fainted status for all pokemon
- ✅ Active pokemon indices
- ✅ Basic hazards (Stealth Rock only)
- ❌ Status conditions (burn, paralysis, etc.) - not yet implemented
- ❌ Stat boosts - not yet implemented
- ❌ Spikes/Toxic Spikes layers - not yet implemented
- ❌ Screens (Light Screen, Reflect) - not yet implemented
- ❌ Weather/terrain - not yet implemented
- ❌ Volatile status (Substitute, Leech Seed, etc.) - not yet implemented

This means search simulations start from fresh battle state with only HP/hazards preserved, which may cause incorrect predictions for battles with ongoing status effects.

### ⚠️ Evaluation Function Needs Tuning
Current weights are hand-tuned. After exact sim integration proves reliable, should:
- Run self-play to collect training data
- Optimize weights via CMA-ES or similar
- Add missing heuristics (speed control, setup detection, win condition recognition)

## Latest Verified Metrics

| Benchmark | Win Rate | Games | Commit | Date | Fallback Rate |
|-----------|----------|-------|--------|------|---------------|
| MCTS vs Random | 71.33% | 150 | e30a2a2 | 2026-10-04 | 100% |
| MCTS vs Max-Damage | 77.33% | 150 | e30a2a2 | 2026-10-04 | 100% |
| MCTS vs Random (quick) | 100% | 5 | 5522250 | 2026-10-04 | 0% |

**Action Required**: Run full 300+ game benchmarks with 0% fallback to measure true performance with exact sim.

## Active Branch & PR

- **Branch**: `cursor/pokemon-showdown-bot-c043`
- **PR**: [#1](https://github.com/Archdiner/jev-showdown/pull/1) (draft)
- **Remote HEAD**: `5522250` (verified synced)

## Known Traps & Gotchas

1. **Team format confusion**: Packed format uses `|` delimiters, no `@` for items. Text format (for humans) uses `@ Item` syntax. Don't mix them.
   
2. **Battle.start() after setPlayer**: Don't call `battle.start()` manually - it's automatically triggered when both players are set. Calling it again throws "Battle already started".

3. **'noability' error**: Dex doesn't recognize 'noability' as a valid ability. Use 'Pressure' or the species' actual default ability instead.

4. **Unknown pokemon handling**: For unrevealed opponent mons, use `Ditto||ChoiceScarf|Limber|Transform|Hardy|85,85,85,85,85,85||||80|` as placeholder in packed format.

5. **TeamGeneratorFactory required**: Must call `Teams.setGeneratorFactory(TeamGenerators)` before creating Battle objects, or you'll get "getTeamGenerator maybe not be used" error.

6. **Bot instance persistence**: Keep one Bot instance (with one RobustSearch/SimWrapper) across a session to track cumulative fallback stats. Creating new instances resets the counters.

## Files Changed This Session

### Added
- `src/engine/battle-state-builder.ts` - Creates real Battle objects from GameState
- `.cursor/rules/00-start-here.mdc` - Agent protocol entry point

### Modified
- `src/engine/sim-wrapper.ts` - Added fallback tracking, uses BattleStateBuilder
- `src/engine/robust-search.ts` - Exposes fallback stats
- `src/bot/bot.ts` - Persistent search engine, fallback stats API
- `src/learning/self-play.ts` - Collects and reports fallback stats
- `AGENTS.md`, `CLAUDE.md` - Created handoff protocol (this session)

## Next Session Should...

1. **Run comprehensive benchmarks** (300+ games each vs random and max-damage) to get verified win rates with 0% fallback
2. **Complete state forcing** in BattleStateBuilder (status, boosts, all hazards, weather, screens)
3. **Analyze losses** - Study replays to find systematic blunders
4. **Tune evaluation** if win rate still below target after state forcing is complete
