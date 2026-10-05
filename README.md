# jev-showdown

A self-improving Pokemon Showdown bot for Gen 9 Random Battle singles, designed for competitive ladder play. Built with TypeScript, MCTS search, Bayesian opponent modeling, and optional LLM integration.

**Target:** Top-tier performance (2340+ Elo). Current state-of-the-art is foul-play at ~2340 Elo (GPL) and Jaxcalibur at 2557 Elo (closed).

## Features

- **MCTS Search Engine**: Monte Carlo Tree Search with configurable exploration and time budgets
- **Opponent Belief Tracking**: Bayesian inference over opponent sets using randbats statistics
- **Damage Calculation**: Exact damage rolls via `@smogon/calc`
- **Data Layer**: Auto-refreshable Gen 9 random battle sets and probabilities
- **LLM Integration**: Optional Vercel AI Gateway integration for move evaluation and post-game analysis
- **Battle Logging**: SQLite database for all games with full decision history
- **Self-Play**: In-process simulation for training and benchmarking
- **Baselines**: Random and max-damage bots for comparison
- **A/B Testing**: Version promotion based on fixed-seed tournaments

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Showdown Client                           │
│              (WebSocket, login, protocol)                    │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│                         Bot                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │   Belief    │  │     MCTS     │  │    Evaluator     │   │
│  │   Tracker   │◄─┤    Engine    │◄─┤   (heuristic)    │   │
│  └─────────────┘  └──────────────┘  └──────────────────┘   │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │   Damage    │  │  LLM Client  │  │  Battle Logger   │   │
│  │    Calc     │  │  (optional)  │  │    (SQLite)      │   │
│  └─────────────┘  └──────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│                   Data Layer                                 │
│  • Gen 9 sets (smogon/pokemon-showdown)                     │
│  • Randbats stats (pkmn.github.io/randbats)                 │
│  • @pkmn/sim for local simulation                           │
└─────────────────────────────────────────────────────────────┘
```

### Components

1. **Belief Tracker** (`src/engine/belief-tracker.ts`)
   - Maintains probability distributions over opponent sets
   - Updates on move, item, ability, and Tera type reveals
   - Uses randbats statistics as priors

2. **MCTS Engine** (`src/engine/mcts.ts`)
   - UCB1 tree search with configurable exploration
   - Samples determinized opponent worlds
   - Respects turn time budgets

3. **Evaluator** (`src/engine/evaluator.ts`)
   - Heuristic evaluation function
   - Considers material, hazards, screens, momentum, information
   - Tunable weights for optimization

4. **Showdown Client** (`src/client/showdown-client.ts`)
   - WebSocket connection to Pokemon Showdown
   - Handles login flow (challstr → POST /api/login → /trn)
   - Ladder search and challenge modes

5. **Battle Logger** (`src/learning/battle-logger.ts`)
   - SQLite database for complete game records
   - Stores logs, decisions, search statistics
   - Enables loss analysis and learning

6. **Self-Play Harness** (`src/learning/self-play.ts`)
   - In-process battles via `@pkmn/sim`
   - Rapid iteration for training
   - Baseline comparisons

7. **LLM Client** (`src/utils/llm-client.ts`)
   - Vercel AI Gateway integration
   - `typesafe-ai/jev` for move scoring
   - Claude Opus 5.5 for post-game analysis
   - Graceful degradation without API key

## Setup

### Prerequisites

- Node.js 18+ (tested on 22.9.0)
- npm or yarn

### Installation

```bash
# Install dependencies
npm install

# Fetch latest Gen 9 data
npm run data:refresh

# Build TypeScript
npm run build
```

### Environment Variables

Create a `.env` file or set environment variables:

```bash
# Required for ladder play
SHOWDOWN_USERNAME=your_username
SHOWDOWN_PASSWORD=your_password

# Optional: LLM features
AI_GATEWAY_API_KEY=your_vercel_ai_gateway_key
# or
VERCEL_AI_GATEWAY_KEY=your_vercel_ai_gateway_key
```

**Note:** The bot works without LLM credentials (uses mock responses). LLM features enhance move evaluation and enable post-game analysis.

## Usage

### 1. Refresh Data (monthly after balance patches)

```bash
npm run data:refresh
```

Fetches:
- `data/gen9-sets.json` - Official random battle sets
- `data/gen9-stats.json` - Set probabilities from pkmn.github.io/randbats

### 2. Run Self-Play (training and benchmarks)

```bash
# 100 games: MCTS vs Random
npm run selfplay 100 mcts random

# 100 games: MCTS vs Max-Damage
npm run selfplay 100 mcts maxdamage

# With verbose logging
npm run selfplay 50 mcts random -- --verbose
```

### 3. Run Benchmarks

```bash
npm run benchmark
```

Runs 100 games each:
- MCTS vs Random
- MCTS vs Max-Damage  
- Max-Damage vs Random

Reports win rates and pass/fail (≥65% threshold).

### 4. Ladder Play

```bash
npm run ladder
```

Connects to Pokemon Showdown, logs in, and searches for rated Gen 9 Random Battle games. Uses MCTS with 5s search time per turn.

```bash
./run-live.sh --games 10 --engine search --concurrency 3
```

`run-live.sh` is the live runner. It calls the ladder client.

Concurrency is 1 unless you pass `--concurrency K` (absolute max 16). `--use-engine-profile` uses `configs/live/concurrency.json` (search 3, max-damage 4, grok 1). `--concurrency-config FILE` replaces those numbers. `--runners N` multiplies the limit. Grok (`--engine grok`) is the search engine with an LLM prior and stays at 1 game because a call is about 25 seconds.

### Graceful drain

Use a drain to swap engines in the middle of a batch. The runner stops starting new ladder searches, lets games already in progress finish, writes `logs/ladder/summary.json` (`drained` and `drainReason`), and exits. It never sends `/forfeit`.

At startup it prints the pid and run id. From another shell:

```bash
kill -USR1 <pid>
kill -TERM <pid>
touch state/DRAIN
touch live-runs/<runId>.drain
```

Any one of those is enough. Delete `state/DRAIN` before the next run or the new process will drain immediately and not search. A second `SIGTERM` or `SIGUSR1` exits without waiting; that drops the socket and still does not send `/forfeit`. `SIGINT` disconnects immediately.

`ops live` should use the same `LiveDrain` (`src/client/drain.ts`): skip new `client.search()` calls while `isDraining`, call `cancelSearch()`, and return once no games are left.

Each run also appends `logs/ladder/metrics.jsonl` (one JSON object per line) next to the per-battle logs.

### Live metrics JSONL

`v` is the schema version (`1`). Every line also has `ts` (unix ms), `runId`, and `engine`.

Percentiles are nearest-rank: sort the samples and take index `ceil(p/100 * n) - 1`. An empty sample list is `null`.

`decision` — one per turn, after the choice is chosen:

| Field | Meaning |
| --- | --- |
| `battleId`, `turn` | Room id and turn |
| `latencyMs` | Wall-clock time spent choosing |
| `secondsLeft` | Showdown turn timer, seconds, or `null` if the server has not said |
| `fallback` | True when the engine choice was replaced |
| `concurrency` | Configured simultaneous-game limit for the run |

`game` — one per finished battle:

| Field | Meaning |
| --- | --- |
| `battleId`, `turns`, `outcome` | `win`, `loss`, or `tie` |
| `decisions` | Decision samples in that battle |
| `latencyP50Ms`, `latencyP95Ms`, `latencyP99Ms` | Nearest-rank latency |
| `minTimerMarginSec` | Smallest `secondsLeft` seen, or `null` |
| `throttleEvents` | Search rejections while this battle was open |

`throttle` — Showdown rejected a ladder search (not "already searching"):

| Field | Meaning |
| --- | --- |
| `message` | Popup text |
| `concurrency` | Configured limit |

`run` — one line when the process finishes:

| Field | Meaning |
| --- | --- |
| `games`, `requested` | Finished games and the `--games` target |
| `decisions` | Decision samples in the run |
| `latencyP50Ms`, `latencyP95Ms`, `latencyP99Ms` | Run-wide nearest-rank latency |
| `minTimerMarginSec` | Smallest timer reading in the run |
| `throttleEvents` | Search rejections in the run |
| `concurrency` | Configured limit |

`--ramp` raises concurrency one game at a time toward `--concurrency` (search starts at 3, max-damage at 4) while decisions stay healthy, and steps back when they do not. Without `--ramp`, the run stays at `--concurrency`.

New searches pause when the rolling p95 decision latency exceeds the engine threshold (800ms for 1-ply search, where a healthy p99 is about 190ms; 60s for Grok), when any active turn has less than the safety margin left on Showdown's timer (15s for search), or when Showdown throttles a search. They resume after the latency and timer recover and the throttle cooldown ends. Games already in progress are not cancelled and the client never sends `/forfeit`.

`ops live` should call `ConcurrencyGovernor.allowsNewSearch(active)` before `client.search()`, `recordDecision` with latency and seconds left, and `recordThrottle` on a rejected search.

**Bot Account Best Practices:**
- Use a clearly labeled bot account (e.g., username ending in "Bot")
- Set profile to indicate it's a bot
- Keep volume modest (1 game at a time)
- Avoid suspect tests and tiering ladders

### 5. Analyze Losses

```bash
npm run analyze
```

Fetches recent losses from SQLite and displays:
- Battle metadata (opponent, turns, timestamp)
- Key decisions from final 5 turns
- LLM analysis (if API key available)
- Overall win rate statistics

### 6. Run Tests

```bash
npm test

# Watch mode
npm run test:watch
```

## Configuration

Bot behavior is controlled via `BotConfig` in `src/types/index.ts`:

```typescript
{
  searchTimeMs: 5000,           // Max time per turn (ms)
  searchIterations: 1000,       // Max MCTS iterations
  explorationConstant: 1.4,     // UCB1 exploration (√2 ≈ 1.414)
  sampledWorlds: 10,            // Opponent set samples
  useTeraHeuristic: true,       // Preserve Tera for critical moments
  useLLMPrior: false,           // Blend LLM scores into search
  llmConfig: {
    endpoint: 'https://ai-gateway.vercel.sh/v1',
    model: 'typesafe-ai/jev',
  }
}
```

## Data Sources

All dependencies are MIT-licensed:

| Source | What | URL |
|--------|------|-----|
| smogon/pokemon-showdown | Official sets and mechanics | https://github.com/smogon/pokemon-showdown |
| @pkmn/sim | Exact battle simulator | https://github.com/pkmn/ps |
| @pkmn/randoms | Random team generator | https://github.com/pkmn/ps |
| @pkmn/client | Protocol parser | https://github.com/pkmn/ps |
| @smogon/calc | Damage calculator | https://github.com/smogon/damage-calc |
| pkmn.github.io/randbats | Set probability statistics | https://pkmn.github.io/randbats |

**GPL Code**: This project does NOT include or derive from foul-play (GPL-3.0). We studied its ideas but implemented search independently.

## Performance

### Current Status (v0.2.0 - Working Search Engine)

**What's Working:**
- ✅ Complete project infrastructure (TypeScript, build, tests)
- ✅ Data fetching (Gen 9 sets and statistics)
- ✅ Self-play harness with @pkmn/sim integration
- ✅ Battle logging to SQLite
- ✅ Showdown client with login flow
- ✅ Belief tracker with Bayesian updates
- ✅ **Working search engine with damage-aware evaluation**
- ✅ Type effectiveness calculation via Dex
- ✅ Forward simulation (simplified)
- ✅ Random and max-damage baselines
- ✅ Full test suite passing
- ✅ CLI commands for all operations

**Performance (Measured - Self-Play):**
- **Search bot vs Random**: 55-60% (25-50 game samples)
- **Max-Damage vs Random**: 54% (50 games)
- **Random vs Random**: 50% (baseline check ✓)

**Per-Turn Latency:**
- Search bot: 50-100ms per decision (configurable)
- Max-damage: <10ms per decision
- Random: <1ms per decision

**Known Issues:**
- ⚠️ Some long-running self-play batches hang after 20-30 games (investigating)
- ⚠️ Search simulation is simplified (random opponent model)
- ⚠️ No full determinization yet (single world sample)
- ⚠️ Showdown client not tested end-to-end on live server

**What Works Well:**
- Damage calculation with type effectiveness
- Move evaluation based on expected damage
- Fast enough for real-time ladder play
- Compiled JS is significantly faster than tsx

### Ladder Performance

**Not yet measured.** Ladder play requires:
1. Passing self-play benchmarks
2. Setting up bot account credentials
3. Running 50+ rated games for Elo estimate

**Expected initial Elo:** 1400-1600 (competent play, better than random).

**Path to 2340+:** See [ROADMAP.md](ROADMAP.md).

## Learning Pipeline

### Current: Heuristic Tuning

1. **Log battles** → SQLite (all decisions + outcomes)
2. **Analyze losses** → LLM identifies blunders
3. **Tune weights** → Manual or CMA-ES on self-play win rate
4. **A/B test** → Fixed-seed tournament vs previous version
5. **Promote** → If new version wins ≥52% over 1000 games

### Future: Neural Network Training

1. **Collect data** → Self-play + high-Elo replays (replay.pokemonshowdown.com)
2. **Train policy/value net** → AlphaZero-style (JAX, PyTorch)
3. **Plug into search** → Use net for evaluation + move priors
4. **Iterate** → Self-play → retrain → improve

## Project Structure

```
jev-showdown/
├── src/
│   ├── types/           # TypeScript interfaces
│   ├── data/            # Data loading and refresh
│   ├── engine/          # Belief tracker, MCTS, evaluator, damage calc
│   ├── client/          # Showdown WebSocket client
│   ├── bot/             # Main bot orchestrator
│   ├── learning/        # Battle logger, self-play harness
│   ├── baselines/       # Random and max-damage bots
│   ├── utils/           # LLM client, helpers
│   └── cli/             # Command-line scripts
├── data/                # Downloaded sets and stats (gitignored)
├── tests/               # Jest tests
├── battles.db           # SQLite battle log (gitignored)
├── package.json
├── tsconfig.json
├── README.md
└── ROADMAP.md
```

## Testing

```bash
npm test
```

Tests cover:
- Data loading
- Belief tracker updates
- Evaluation function
- MCTS core logic (unit)
- Self-play harness integration

**Coverage target:** >70% for core engine, belief tracker, evaluator.

## FAQ

### Does this bot cheat?

No. It uses only public information (revealed moves, items, abilities, Tera types) and exact mechanics (damage calculation, speed tiers). It infers opponent sets probabilistically, which any human can do.

### Is this allowed on Pokemon Showdown?

Yes, with caveats:
- Bots are allowed if not disruptive
- Use clearly labeled bot account
- Don't mass-queue or ladder multiple alts
- Avoid suspect tests
- Respect throttles and community norms

See research brief section 6 for details.

### Why TypeScript instead of Python?

- Exact mechanics via `@pkmn/sim` (no approximations)
- Fast in-process self-play (thousands of games/hour)
- Strong typing reduces bugs
- Official Showdown packages

### Why not copy foul-play?

foul-play is GPL-3.0 (copyleft). This project is MIT. We studied its ideas (determinized MCTS, opponent sampling) but implemented independently.

### Can I use this for other formats?

Yes, with modifications:
- Change `formatid` in config
- Update data sources (sets, stats)
- Adjust evaluation heuristics (e.g., team preview, sleep clause)

### What's the learning loop?

1. Self-play → log battles
2. Analyze losses → LLM suggests heuristic changes
3. Tune evaluator weights → CMA-ES or Bayesian optimization
4. A/B test → promote if new version beats old
5. (Future) Train policy/value network on self-play data

### How do I add a policy network?

1. Collect 100k+ self-play games
2. Train a small neural net (e.g., 5M params) to predict:
   - Policy: move visit distribution from MCTS
   - Value: game outcome
3. Replace `Evaluator` with network inference
4. Use policy as move prior in MCTS

See `ROADMAP.md` for details.

## Contributing

This is a research project. Contributions welcome:

- **Heuristics**: Improve evaluation function
- **Search**: Better move ordering, RAVE, PUCT
- **Beliefs**: Damage roll inference, Scarf detection
- **Data**: Monthly set/stat refreshes
- **Ladder**: Measured Elo reports

## License

MIT

## Credits

- **@pkmn packages** by Annika L
- **@smogon/calc** by the Smogon community
- **Research brief** compiled from Smogon forums, pkmn.github.io, and prior art (foul-play, Jaxcalibur, PokéChamp)
- **Architecture** inspired by AlphaGo/AlphaZero and foul-play's determinization approach

## See Also

- [ROADMAP.md](ROADMAP.md) - Path to #1 ladder rank
- [Research Brief](uploads/research.md) - Detailed background on format, data, and prior art
- [Smogon Random Battles Forum](https://www.smogon.com/forums/forums/random-battles.744/)
- [pkmn.github.io/randbats](https://pkmn.github.io/randbats/)
