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

`--labeled-champion` plays the gatekeeper's current champion file for the whole batch. It is off unless you pass it. `--rollback` keeps the builtin `--engine` policy. The process logs `config live` with the config id, content hash, and commit before searching, and writes those fields plus `role` and `share` on every finished game. A promotion does not swap the engine until the next batch.

`--ab <config>:<share>` is repeatable. It splits new battles inside this one process. `<config>` is a yaml or json path, a config id of a file under `configs/`, or an engine profile (`search`, `exact`, `max-damage`). `<share>` is that config's fraction of battles, in `(0, 1]`. The shares must sum to at most 1. The rest play the champion. A hash of the room id picks the arm, so the same battle keeps it. Concurrency, the turn timer, and the choice watchdog stay shared. A challenger is pulled back to the champion after any invalid move, a loss on our timer, a crash, or 4 losses in a row. Each pull is one `jev.ab-incident.v1` line in `incidents.jsonl`. The process takes the account lock once, before login, and every arm shares it.

```bash
npm run ladder -- --games 40 --format gen9randombattle --engine search --concurrency 3 --ab configs/panel/maxdamage.yaml:0.2
```

`--check` prints one preflight canary per arm after proving each config file builds.

One Showdown account can have one ladder process. Before it logs in, the runner creates `state/ladder-<userid>.lock` with `O_EXCL`. The file holds the pid, the start time, and the host. A second runner prints that host, pid, and start time and exits non-zero. A lock is stale only when its pid is dead on this host. A lock written on another machine is not taken over. The file is removed on exit and on SIGINT. The first SIGTERM drains and keeps the lock until the process exits, so a restart during that drain is refused. `--check` does not take the lock. A local two-bot series locks both BotAlpha and BotBravo.

Concurrency is 1 unless you pass `--concurrency K` (absolute max 16). `--use-engine-profile` uses `configs/live/concurrency.json` (search 3, max-damage 4, grok 1). `--concurrency-config FILE` replaces those numbers. `--runners N` multiplies the limit. Grok (`--engine grok`) is the search engine with an LLM prior and stays at 1 game because a call is about 25 seconds. `ops live --runners=N --concurrency=K` uses the same limit: default 1, then those flags, clamped at 16. It does not pick an engine profile, because one login plays whichever config the gatekeeper approved.

### Graceful drain

Use a drain to swap engines in the middle of a batch. The runner stops starting new ladder searches, lets games already in progress finish, writes `logs/ladder/summary.json` (`drained` and `drainReason`), and exits. Live games are not forfeited. A battle room whose newest `|t:|` is more than 70 minutes old is forfeited when it is rejoined and does not count as in progress or against concurrency. A room with no `|t:|` stays live.

At startup it prints the pid and run id. From another shell:

```bash
kill -USR1 <pid>
kill -TERM <pid>
touch state/DRAIN
touch live-runs/<runId>.drain
```

Any one of those is enough. The first signal exits as soon as no game is in progress, which includes a runner whose only rooms were stale. Delete `state/DRAIN` before the next run or the new process will drain immediately and not search. A second `SIGTERM` or `SIGUSR1` exits without waiting; that drops the socket and does not forfeit a live game. `SIGINT` disconnects immediately.

`ops live` should use the same `LiveDrain` (`src/client/drain.ts`): skip new `client.search()` calls while `isDraining`, call `cancelSearch()`, and return once no games are left.

Each run also appends `logs/ladder/metrics.jsonl` (one JSON object per line) next to the per-battle logs.

### Live metrics JSONL

`v` is the schema version (`1`). Every line also has `ts` (unix ms), `runId`, and `engine`. A decision or game line stamps the `configId`, `configHash`, `role` (`champion` or `challenger`), and `share` of the config that played that battle. The `run` line lists every arm in `ab`. `gitSha` is the process commit.

Percentiles are nearest-rank: sort the samples and take index `ceil(p/100 * n) - 1`. An empty sample list is `null`.

`decision` — one per turn, after the choice is chosen:

| Field | Meaning |
| --- | --- |
| `battleId`, `turn` | Room id and turn |
| `latencyMs` | Wall-clock time spent choosing |
| `secondsLeft` | Showdown turn timer, seconds, or `null` if the server has not said. The client sends `/timer on` when a battle opens (never `/forfeit`). The value is the private `Time left: N sec this turn` line, or a public line that names us |
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

## Ops dashboard

`npm run dashboard` starts a local feed of finished games. It prints a URL on `127.0.0.1:8787` (override with `--port` and `--host`). The page lists each game and splits timer, disconnect, and crash results away from strategy results. Filters are end reason and opponent rating band. The same numbers are on `GET /api/status`, `/api/runs`, `/api/games`, `/api/metrics`, `/api/agents`, `/api/snapshot`, and `GET /api/events` (SSE).

```bash
npm run dashboard
npm run dashboard -- --fixture src/dashboard/fixtures --port 8787
```

On a Mac with live logs, the defaults are `state/ops`, `logs/ladder`, and `~/jev-search/live-runs`. Copy `dashboard.config.example.json` to `dashboard.config.json` or set `DASHBOARD_HOST`, `DASHBOARD_PORT`, `DASHBOARD_CONFIG`, `OPS_DIR`, `LADDER_LOG_DIR`, `SEARCH_LOG_DIR`, `JEV_SEARCH_DIR`. `JEV_SEARCH_DIR` is joined with `live-runs` unless the path already ends there. Missing files stay empty and show up under gaps in `/api/status`.

`logs/ladder/metrics.jsonl` is the live metrics log (`type` `game` carries `latencyP50Ms`, `latencyP95Ms`, `latencyP99Ms`, and `minTimerMarginSec`). The feed merges that line onto the ladder result with the same `battleId`. `decision` and `throttle` lines stay out of the game table. The field list is under Live metrics JSONL above.

A richer per-game record is also accepted (`type` or `kind` of `game`, `result`, or `live-game`):

```json
{"type":"game","ts":1710000000000,"id":"battle-1","replayUrl":"https://replay.pokemonshowdown.com/gen9randombattle-1","outcome":"loss","opponent":"ace","opponentRating":1410,"ratingBefore":1200,"ratingAfter":1184,"endReason":"timer loss (ours)","durationMs":240000,"turns":30,"latency":{"p50":180,"p95":900,"max":1500},"minTimerSeconds":1,"engine":"search","configId":"champion","configHash":"abc","gitSha":"87b268f","concurrency":2}
```

Accepted aliases: `opponentName`, `opponentElo`, `eloBefore` / `ourRatingBefore`, `eloAfter` / `rating` / `elo`, `replay` or `replayId` (bare ids become a replay.pokemonshowdown.com link), `end_reason`, `duration` (milliseconds) or `durationSec`, `latencyP50` / `latencyP50Ms` / `latencyP95` / `latencyP95Ms` / `latencyP99` / `latencyP99Ms` / `latencyMax`, `minTimerMarginSec`, `config_hash`, `git` / `commit`. `endReason` becomes `ko`, `opponent-forfeit`, `our-forfeit`, `timer-ours`, `timer-theirs`, `disconnect`, or `crash`. A bare `timer` on a win is `timer-theirs`; on a loss it is `timer-ours`.

Opponent bands are `unknown`, `under-1200`, `1200-1399`, `1400-1599`, and `1600-plus`. Query `endReason` and `band` on `/api/games` and `/api/metrics` (`any` clears a filter). `endReason=strategy` is KO and forfeit. `endReason=timer-disconnect` is both timer sides plus disconnect. Strategy win rate drops timer, disconnect, and crash games. `[ladder]` lines have no end reason, so they stay in the strategy rate and a loss there is also counted as unclassified.

Without that JSONL, the feed falls back to ladder lines:

```
[ladder] 2/30 win vs X turns=21 invalid=0 crashes=0 fallbacks=0 elo=1073
```

`2/30` is finished games over the requested count, not concurrency. Ops heartbeats are `state/ops/heartbeats.jsonl` (`facility`, `pid`, `ts`, `status`, `detail`). Ops live games are `state/ops/live-games.jsonl` (`kind` `live-game`, `id`, `winner`, `rating`, `gxe`, `configId`). A beat older than 60s is stale.

When `state/graph.db` exists (`GRAPH_DB` overrides it), `/api/status` uses the same text as `npm run ops -- status` and `npm run ops -- report`: facility health, the factory queue, last rating and GXE, per-config record, open regressions, and the daily paragraph. The dashboard does not create that database. Without it, status is built from the heartbeat and game files only.

Cloud agents are not loaded yet. Expected file: `state/cloud-agents.json` with `version`, `updatedAt`, and `agents[]` of `id`, `name`, `status`, `branch`, `pr`, `prUrl`.

The same page has an Incidents panel and a Scorecard panel. Incidents come from `state/ops/incidents.json`, which `npm run ops -- sentinel` folds out of the append-only `state/ops/incidents.jsonl`. The scorecard is the same text as `npm run ops -- scorecard`.

## Reliability sentinel

`npm run ops -- sentinel` is a fifth long-running process next to factory, gatekeeper, live, and analyst. It does not change the move. Every 60 seconds it reads the ladder logs, the ops files, the data file, and the process list, and it records each broken invariant as an incident.

```bash
npm run ops -- sentinel              # loop every 60s
npm run ops -- sentinel --once       # one pass; exit 1 when a P0 is open, acknowledged, or fixing
npm run ops -- sentinel --once --json
npm run ops -- scorecard --since 24h
npm run ops -- scorecard --since 24h --md
npm run ops -- sentinel --ack inc-id
npm run ops -- sentinel --fixing inc-id --pr https://github.com/Archdiner/jev-showdown/pull/1
npm run ops -- sentinel --root-cause inc-id --text "two runners shared one login"
```

An incident is deduped by check id plus a key. It keeps `firstSeen`, `lastSeen`, `count`, severity, evidence with file and line, status (`open`, `acknowledged`, `fixing`, `resolved`, `verified`), and `rootCause`. A failing check moves a verified incident back to `open`. A check that stops failing marks the incident `resolved`. It becomes `verified` only after the invariant has stayed clear for the soak window (10 minutes, `--soak-ms` to override).

P0 is losing games or corrupting data now. P1 is the loop or visibility broken. P2 is a degradation or a trend. P3 is hygiene. The checks:

| Check | Severity | What it catches |
| --- | --- | --- |
| duplicate-ladder-runners | P0 | More than one `ladder.ts` on one account, including two pids choosing in one room and the forfeit that follows |
| choice-sent-not-applied | P0 | Turn-1 `our-timer` after a choice logged `sent: true` with no move, switch, or later turn |
| phantom-games | P0 | Rows flagged `phantom`, or 0-turn ties whose reason is disconnect or unknown |
| invalid-choices | P0 | `invalidChoices` greater than 0 |
| crash-or-fallback | P0 | `crashes` or `fallbacks` greater than 0 |
| species-count | P0 | `data/gen9-stats.json` missing or under 500 species (a test stub left in the repo) |
| ghost-rooms | P1 | A room with no result while `state/DRAIN` or `live-runs/*.drain` exists |
| drain-pending | P1 | A drain file older than 10 minutes |
| runner-down | P1 | A `live-runs/*.json` pid that is not `ladder.ts`, and `summary.json` is not newer |
| ops-worker-missing | P1 | factory, gatekeeper, live, or analyst has no fresh heartbeat while another worker is up |
| ops-worker-duplicate | P1 | Two fresh pids for one of those workers |
| analyst-log-dir | P1 | Analyst process has no `LADDER_LOG_DIR` and its default dirs have no game JSONL while the ladder log dir does |
| circuits-all-pulled | P1 | Every entry in `circuits.json` is pulled, so ops live stays idle |
| mixed-ratings | P1 | A local rating and a ladder rating in the same lookback window |
| replay-unconfirmed | P2 | Public game with `replayUrl` null and `replayStatus` `unconfirmed` |
| timer-margin-null | P2 | A played game with `minTimerMarginSec` null |
| elo-null-on-forfeit | P2 | `eloAfter` null on `our-forfeit` or `opponent-forfeit` |
| required-fields-null | P2 | A `jev.ladder-game.v1` row missing battleId, outcome, endReason, username, format, or turns |
| latency-p95 | P2 | Decision latency p95 over the 12s ladder budget |
| elo-drop | P2 | Elo down more than 40 across the last 10 rated ladder games |
| win-rate-batch | P2 | A 10-game batch (grouped by git sha) more than 10 points under a 50% target |
| checkout-behind | P2 | `HEAD` is behind `origin/main` |
| malformed-log-line | P3 | A JSONL line that is not an object |

The scorecard names its files. It drops phantom games (`phantom: true`, or a 0-turn tie with end reason disconnect or unknown) and local games from Elo and win rate, and it says how many it dropped. Uptime is the share of the window covered by fresh `live` heartbeats. MTTR is the mean time from an incident's episode open to `verified`. Progress is the Elo series, per-batch and per-variant record, win rate against the target, gate decisions plus finished factory jobs, what was promoted or rejected and why, and open regressions. `src/ops/sentinel/fixtures.ts` writes a log set with all of the failures above for the tests.

`supervise` does not start the sentinel. A P0 makes `--once` exit 1, and the supervisor would treat that as a crash. Run sentinel beside the other four.

## Contributing

This is a research project. Contributions welcome:

- **Heuristics**: Improve evaluation function
- **Search**: Better move ordering, RAVE, PUCT
- **Beliefs**: Damage roll inference, Scarf detection
- **Data**: Monthly set/stat refreshes
- **Ladder**: Measured Elo reports

## Ladder game records

Every finished battle appends one JSON object. The ladder client writes `logs/ladder/games.jsonl` (or `--log-dir`). `ops live` writes the same fields to `state/ops/live-games.jsonl` (`source` is `ops`, plus `configPath`, `inputLog`, `log`, and `variantId` when a Thompson arm was drawn). The ladder per-battle file also stores this object as its `result` row, with `type: "result"` added by the battle log. `logs/` is gitignored. The stdout line is unchanged (`turns`, `invalid`, `crashes`, `fallbacks`, `elo`).

Schema id: `jev.ladder-game.v1`. `kind` is `ladder-game`. `source` is `ladder` or `ops`.

`outcome` is who won: `win`, `loss`, or `tie`. A game with no `|win|` and no `|tie` is `outcome: "tie"` only so the old line stays three words. **Count ties from `endReason: "tie"`.** `endReason` is how it ended:

| `endReason` | Meaning |
| --- | --- |
| `ko` | `|win|` and no forfeit or inactivity line |
| `opponent-forfeit` | opponent forfeited |
| `our-forfeit` | we forfeited |
| `our-timer` | we lost due to inactivity |
| `opponent-timer` | they lost due to inactivity |
| `disconnect` | no winner, and our socket dropped or the process stopped |
| `crash` | simulator crash line (`\|bigerror\|` / "battle crashed") |
| `tie` | `|tie` |
| `unknown` | no winner and none of the above |

Other fields:

| Field | Meaning |
| --- | --- |
| `battleId` | Showdown room id, `battle-gen9randombattle-…` |
| `opponent`, `opponentRating` | name and pre-game ladder rating from `\|player\|`. Null when the server omits them. |
| `eloBefore`, `eloAfter` | our rating from the rating popup. `eloBefore` falls back to our `\|player\|` rating. Null when absent. Never 1000. |
| `gxe` | from the rating line when that parser provides it. Null when absent. Never 50. |
| `turns`, `invalidChoices`, `crashes`, `fallbacks`, `mismatches` | existing counters. Ops name for `invalidChoices` is `invalid`. |
| `durationMs` | wall clock from room open to the record |
| `decisions` | number of `latencyMs` samples |
| `latencyP50Ms`, `latencyP95Ms`, `latencyP99Ms` | nearest-rank percentiles of per-turn `latencyMs`, same rule as `metrics.jsonl`. Null when there are no samples. |
| `latencyMaxMs` | largest `latencyMs` sample. Null when there are no samples. |
| `minTimerMarginSec` | smallest Showdown seconds-left observed for us. Null if no timer line. |
| `engine` | ladder engine name, or the ops search layer id |
| `configId` | Builtin policy id (`champion-exact-1ply` or `maxdamage-v1`), the gatekeeper label's id when `--labeled-champion` is on, or the challenger file hash when `--ab` routed this battle. `ops live` writes the config id. |
| `configHash` | Builtin: sha256 of the policy object. Labeled champion or `--ab` file: 16-hex content hash, the same value as `configId` when the label still matches. |
| `role` | `champion` or `challenger` for a routed ladder battle. Absent on older rows and on `ops live`. |
| `share` | Fraction of new battles that config was given. The champion's share is what remains after the `--ab` shares. |
| `gitSha` | `JEV_GIT_SHA` or `GIT_COMMIT` or `GITHUB_SHA`, else `git rev-parse HEAD` |
| `concurrency` | configured `--concurrency` |
| `replayId` | Public replay id. The server's id when it confirms one, otherwise the room id with the `battle-` prefix removed (`gen9randombattle-…`). |
| `replayUrl` | Set only after the server popup or log contains `https://replay.pokemonshowdown.com/…`. `/savereplay` asks the server to upload; this process does not invent the URL. |
| `replayUploaded` | true only when `replayUrl` is set |
| `replayStatus` | `confirmed` (URL arrived), `local-only` (local server), or `unconfirmed` (public server, upload requested, no URL before the wait). The public client waits up to 8s and writes the row as soon as the URL arrives. |
| `localReplayPath` | raw protocol log on disk |
| `logPath` | per-battle JSONL |
| `ts`, `startedAt` | epoch ms. `pid` is the process id. |
| `calibration` | present when at least one turn was compared with the protocol. Foe-action accuracy, damage MAE, KO misses, and speed-order misses. See Sim calibration below. |

Per-turn rows in the battle file (not copied into `games.jsonl`):

- `searchMs`: engine time.
- `latencyMs`: wall clock spent choosing. The game row's percentiles are computed from these samples.
- `secondsLeft`: Showdown clock at the decision. Null when no `|inactive|` for us has been seen.
- `prediction`: `jev.turn-forecast.v1`, or null when the sim battle could not be built. The foe action is the modal reply (`move id` or `switch:<species id>`). HP and damage are fractions of max HP. The search champion averages its 8 draws; max-damage uses one draw. Either way the rollout is after the choice is sent, and it is capped at 8.
- `predictionBaseline`: `{ourSide, ourHpBefore, foeHpBefore}` from the client at decision time. The offline report uses it with the replay log.

A later `prediction_error` row (`jev.prediction-error.v1`) on the same file scores that forecast against the protocol up to the next request or result: `foeActionMatch`, `ourActionMatch`, `damageDealtAbs`, `damageTakenAbs`, `ourKoMismatch`, `foeKoMismatch`, `speedOrderMismatch`. `comparable` is false when the turn never played (forfeit, disconnect). Those rows are the game's `calibration` totals.

Example:

```json
{"schema":"jev.ladder-game.v1","kind":"ladder-game","source":"ladder","battleId":"battle-gen9randombattle-1","opponent":"Rival","opponentRating":1400,"outcome":"win","endReason":"ko","turns":21,"invalidChoices":0,"crashes":0,"fallbacks":0,"eloBefore":1073,"eloAfter":1089,"gxe":null,"durationMs":84000,"decisions":20,"latencyP50Ms":40,"latencyP95Ms":180,"latencyP99Ms":400,"latencyMaxMs":400,"minTimerMarginSec":12,"engine":"max-damage","configId":"maxdamage-v1","configHash":"ab12","gitSha":"87b268f","concurrency":1,"replayUrl":null,"replayStatus":"unconfirmed"}
```

## Sim calibration

`npm run calibration` reads `logs/ladder` (or `--log-dir`) and prints foe-action accuracy, damage MAE both ways, KO misses, and speed-order misses. `--json` prints the same totals. The dashboard's Sim calibration panel reads the `prediction_error` rows and, when a battle only has the game-level total, `calibration` on `jev.ladder-game.v1`.

```bash
npm run calibration -- --log-dir logs/ladder
```

## Rating and GXE

Ladder Elo and GXE come from the server line, or they stay null.

- The HTML popup `rating: N → M` plus `(GXE: …)` is the public-ladder form. GXE is omitted on some lines; the record then has `gxe: null` and `gxeSource: "missing"`.
- A local `|rating|elo` or `|rating|elo|gxe` line is the other form. A missing number stays null.
- Nothing in this client writes Elo `1000` or GXE `50` as a stand-in. The per-battle JSONL (`logs/ladder/{user}-{room}.jsonl`) gets a `rating` event when a line parses, and the `result` event copies `eloBefore`, `eloAfter`, `gxe`, and `gxeSource`. `fabricated` is always `false`. `ops live` stores the same nulls on its live-game row. A missing Elo is left out of the circuit-breaker window.

## Choice delivery and timers

Per-battle JSONL (`logs/ladder/{user}-{room}.jsonl`) records these events in addition to the existing `turn` row. `type` and `kind` are the same string.

| `kind` | When |
| --- | --- |
| `timer` | Every `\|inactive\|` / `\|inactiveoff\|`. `secondsLeft`, `aboutUs`, `tight` (`aboutUs` and at most 4 seconds). |
| `choice-delivery` | After `/choose`. `sent`, `cause` (`sent`, `unconfirmed`, `stale-rqid`, `socket-closed`, `send-threw`, `illegal`, `server-rejected`, `not-your-turn`, `no-legal-retry`), `retry`, `replacement`, `serverLine`, `intendedRoomId`, `sentRoomId`. `intendedRoomId` is the battle the request belonged to. `sentRoomId` is the room id on the `/choose` message, or null when nothing was sent. A false `choose` is retried. `unconfirmed` is the same choice and rqid sent again when 8 seconds pass with no new request and no later turn, and also when our clock ticks. Turn 1 is included. `|turn|1` after the move does not clear it. `stale-rqid` was not sent. When no legal replacement remains, one `no-legal-retry` row is written. |
| `popup` | `attribution` is `matched`, `only-open`, `ambiguous`, or `elsewhere`. A replay URL matches the battle id even when a password follows it. `elsewhere` is a named battle that is not open, and it is not copied onto the battles that are. An ambiguous popup is copied onto each open battle with `candidates` and is not filed on "the latest room". |

`secondsLeft` is cleared on each `\|request\|`, so a later turn does not reuse the previous clock. The game `result` includes `choiceDeliveryFailures`, `noLegalRetries`, and `ambiguousPopups`. Finished battles are removed from the driver's room map.

`createLogger` keeps the last 2000 decisions and the last 500 games in memory. When the env log sink is a file, every row is still appended to `decisions.jsonl` and `games.jsonl`.

## Optional PostHog

Set `POSTHOG_API_KEY` to mirror each finished ladder game to PostHog as a `ladder_game` event. `POSTHOG_HOST` defaults to `https://us.i.posthog.com`. The send is queued and is not awaited on a turn. `POSTHOG_LLM_TRACES=1` also sends `$ai_generation` metrics (model, latency, tokens, cost) and does not send prompt text. With the key unset, nothing is sent. `logs/ladder/games.jsonl` stays the source of truth.

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
