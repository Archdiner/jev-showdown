# Conventions

**Last Updated**: 2026-10-04 21:51 UTC

## Code Style

### TypeScript
- **Strict mode**: `"strict": true` in tsconfig.json (enforced)
- **Naming**:
  - Classes: `PascalCase` (e.g., `BattleStateBuilder`)
  - Interfaces/Types: `PascalCase` (e.g., `GameState`, `Format`)
  - Functions/methods: `camelCase` (e.g., `selectAction`, `createBattle`)
  - Constants: `UPPER_SNAKE_CASE` (e.g., `DEFAULT_SEARCH_TIME`)
  - Files: `kebab-case` (e.g., `battle-state-builder.ts`)
- **Imports**: Use `.js` extension in relative imports (ESM requirement)
- **Comments**: JSDoc for public APIs, inline comments only for non-obvious logic
- **Error handling**: Return null/undefined for expected failures, throw for programmer errors

### Formatting
- **Indentation**: 2 spaces (enforced by ESLint)
- **Line length**: Aim for 100 chars, but no hard limit
- **Semicolons**: Required (enforced by ESLint)
- **Quotes**: Single quotes for strings, double quotes for JSON/protocol messages
- **Trailing commas**: Yes for multi-line (helps git diffs)

### Linting
- **Tool**: ESLint with TypeScript plugin
- **Run**: `npm run lint`
- **Fix**: Add `-- --fix` to auto-fix
- **CI**: Should run on PRs (not yet set up)

## Module Boundaries

### Core Layers (In Order)
1. **types/** - Pure types and interfaces, no logic
2. **data/** - Data loading and freshness checking
3. **formats/** - Format-specific logic (set sampling, rules, weights)
4. **engine/** - Search, evaluation, simulation, belief tracking
5. **bot/** - Orchestrates engine, handles state, exposes API
6. **learning/** - Self-play, training, logging
7. **client/** - Protocol handling, websocket, ladder connection
8. **cli/** - Command-line entry points

### Dependency Rules
- ✅ Higher layers can import lower layers
- ❌ Lower layers cannot import higher layers
- ❌ No circular dependencies
- Example: `bot/` can use `engine/`, but `engine/` cannot use `bot/`

### When to Create a New Module
- New responsibility that doesn't fit existing modules
- Code would otherwise create circular dependency
- Reusable across multiple features

### When NOT to Create a New Module
- Only used in one place (keep it local)
- Tightly coupled to existing module (extend that module)
- Premature abstraction (wait until 3rd use case)

## Testing Protocol

### Unit Tests
- **Tool**: Jest with ts-jest
- **Run**: `npm test` or `npm run test:watch`
- **Coverage**: Not enforced yet, but aim for >80% on core logic
- **Location**: `*.test.ts` next to source file
- **Naming**: `describe('<ClassName>', () => { it('should <behavior>', () => { ... }) })`
- **Mocking**: Use Jest mocks for I/O (file system, network). Don't mock game logic.

### What to Test
- ✅ Belief tracking updates (move/item/ability reveals)
- ✅ Data loading and parsing
- ✅ Evaluation score calculations
- ✅ Legal action generation
- ❌ Full search (too slow for unit tests)
- ❌ Battle simulation (tested via integration)

### Integration Tests (Self-Play)
- **Purpose**: Verify full system works end-to-end
- **Run**: Via `npm run selfplay` or benchmark scripts
- **Not automated**: Too slow for CI (takes minutes)
- **When to Run**: Before pushing, after major changes

## Benchmark Protocol

### Smoke Test (Quick Validation)
```bash
npm run build
node dist/cli/selfplay.js 20 mcts random
```
- **Purpose**: Verify no crashes, reasonable behavior
- **Time**: ~1-2 minutes
- **When**: After every major change, before pushing
- **Pass Criteria**: No errors, fallback rate 0%, any win rate (just need to run)

### Full Benchmark (Performance Measurement)
```bash
npm run build
node dist/cli/selfplay.js 300 mcts random
node dist/cli/selfplay.js 300 mcts maxdamage
```
- **Purpose**: Measure true performance for CURRENT.md
- **Time**: ~1 hour total
- **When**: After completing a feature, before claiming improvement
- **Pass Criteria**: Meet targets (≥95% vs random, ≥80% vs max-damage) or document gap

### A/B Test (Compare Two Versions)
```bash
# Run both versions with same seed
node dist/cli/selfplay.js 100 mcts random --seed 42
# Check out other branch/commit
git checkout <other-branch>
npm run build
node dist/cli/selfplay.js 100 mcts random --seed 42
```
- **Purpose**: Verify a change improves performance
- **Time**: ~20 minutes per variant
- **When**: Testing experimental changes (new heuristic, different search depth, etc.)
- **Pass Criteria**: New version wins ≥55% (significant at 100 games)

### Recording Results
Always include in CURRENT.md:
- Win rate (percentage to 2 decimal places)
- Number of games
- Commit SHA
- Date
- Fallback rate
- Any special config (if not default)

Example: `MCTS vs Random: 95.33% (300 games, commit abc1234, 2026-10-04, fallback 0%)`

## How to Add a Format

1. **Create format file**: `src/formats/<format-name>.ts`
2. **Implement Format interface** from `src/types/format.ts`
3. **Required methods**:
   - `getName()` - Format ID (e.g., 'gen9ou')
   - `getDataSources()` - URLs for sets/stats
   - `sampleOpponentSet()` - Sample from belief
   - `calculateStats()` - Compute stats from base stats + EVs/IVs/nature
   - `getLegalActions()` - Given state and request, what can we do?
   - `getEvaluatorWeights()` - Format-specific evaluation weights
   - `predictBehavior()` - Opponent behavior model
   - `reconcileState()` - Validate tracked state vs server
4. **Add to data loader**: Update `src/data/data-loader.ts` to handle new format
5. **Test**: Run self-play with new format, verify it works
6. **Document**: Add to FORMATS.md (create if doesn't exist)

## How to Propose a Convention Change

1. **Check DECISIONS.md**: Is this a reversal of a past decision? If so, include reasoning why old decision was wrong.
2. **Write proposal**: Add to IDEAS.md with rationale and expected benefits
3. **Test if measurable**: If it affects performance, run benchmarks
4. **Discuss if breaking**: If it requires changing lots of code, propose in PR description
5. **Document when adopted**: Add to DECISIONS.md with context and consequences
6. **Update CONVENTIONS.md**: Make it the new standard

### Examples of Good Convention Changes
- "Use async/await instead of promises" - Improves readability
- "Move all CLI commands to cli/ directory" - Better organization
- "Add required @param docs to public methods" - Helps future developers

### Examples of Bad Convention Changes
- "Rewrite everything in Python" - Violates ADR-001, no clear benefit
- "Use tabs instead of spaces" - Style bikeshedding, not worth churn
- "Don't test anything" - Makes code fragile
