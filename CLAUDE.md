# Agent Handoff Protocol

**Mission**: Build a Pokemon Showdown Gen 9 Random Battle bot that reaches #1 on the ladder through exact game mechanics and strategic play.

## Non-Negotiables

1. **MIT-only code** - No GPL/AGPL dependencies. Current stack: @pkmn/* (MIT), @smogon/calc (MIT), TypeScript (Apache-2.0)
2. **Exact @pkmn/sim mechanics in search** - Forward simulation must use `Battle.makeChoices()`, not hand-written approximations. Fallback rate must stay at 0%.
3. **Never present placeholder results** - All metrics, benchmarks, and claims must be measured and verified with actual game counts and commit SHAs
4. **Small, atomic commits** - Push frequently (every logical change). Never batch unrelated changes
5. **Verify all claims with numbers** - "Improved performance" → "Win rate: 71% → 95% (300 games, commit abc123)"

## Start-of-Session Checklist

□ **Read** `docs/state/CURRENT.md` - What works, what's broken, latest metrics  
□ **Run** `npm run verify` - Build + tests + 20-game smoke benchmark  
□ **Confirm** correct branch (`git status`) and that remote HEAD matches local (`git fetch && git log origin/cursor/pokemon-showdown-bot-c043..HEAD`)  
□ **Pick** the top item from `docs/state/NEXT.md` (status: TODO) or continue the IN_PROGRESS task  
□ **Create** session log: `docs/state/sessions/YYYY-MM-DD-HHMM-<slug>.md`

## End-of-Session Checklist

□ **Update** `docs/state/CURRENT.md` - New metrics, what changed, new issues  
□ **Update** `docs/state/NEXT.md` - Mark completed tasks DONE, add new tasks, update IN_PROGRESS  
□ **Update** session log with final metrics, failures, handoff notes  
□ **Record** benchmark numbers with game counts and commit SHA  
□ **Push** all changes: `git push -u origin cursor/pokemon-showdown-bot-c043`  
□ **Verify** remote HEAD contains your commits: `git fetch && git log HEAD..origin/cursor/pokemon-showdown-bot-c043`  
□ **Run** `scripts/check-handoff.sh` to validate protocol compliance

## Directory Structure

```
docs/
  state/              # Living state (update every session)
    CURRENT.md        # What works, metrics, known issues
    NEXT.md           # Ordered task queue
    DECISIONS.md      # Architecture decisions log
    sessions/         # Session logs
  knowledge/          # Growable shared knowledge
    SOURCES.md        # Data sources and reliability
    CONVENTIONS.md    # Code style, testing, protocols
    STRATEGY.md       # Pokemon strategy knowledge
    IDEAS.md          # Hypothesis backlog
```

## Where Creativity is Welcome

✓ Strategy improvements (evaluation weights, win condition detection)  
✓ Search enhancements (better opponent modeling, deeper lookahead)  
✓ New features (opening book, endgame tablebase)  
✓ Testing hypotheses from `IDEAS.md`

## Where to Stay Locked

✗ Non-negotiables above  
✗ Data sources (must match `SOURCES.md`)  
✗ Benchmark protocol (must be reproducible)  
✗ Module boundaries (see `CONVENTIONS.md`)

---

**Current Branch**: `cursor/pokemon-showdown-bot-c043`  
**Current PR**: [#1](https://github.com/Archdiner/jev-showdown/pull/1)  
**Last Updated**: 2026-10-04 21:51 UTC (commit 5522250)
