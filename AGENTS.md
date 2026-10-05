# Agent Protocol

**Mission**: #1 on gen9randombattle ladder via exact mechanics + strategic play.

## Non-Negotiables

1. MIT-only code (no GPL)
2. Exact @pkmn/sim in search (0% fallback)
3. All claims verified with numbers (commit SHA + game count)
4. Small atomic commits, push frequently
5. Changes through gate (champion/challenger) - no manual overrides
6. No overfitting to examples (see below)

## Start Session

```bash
npm run verify              # build + tests + smoke
npm run graph -- status     # current champion + frontier
npm run graph -- next       # exactly ONE task with acceptance criteria
# Work on that task
```

## End Session

```bash
# For experiments:
npm run gate -- <experiment-id> <champion-id>  # verdict is final

# For shared-core/infra (must not move metrics):
npm run verify              # A/A check

# Always:
npm run graph -- update <task-id> --status=done --commit=$(git rev-parse HEAD)
npm run graph -- render     # export graph.json, graph.html
git add state/ && git commit && git push
```

## Structure

- `state/graph.db` - Project state graph (SQLite)
- `state/graph.json` - JSON export (auto-generated)
- `state/graph.html` - Visual graph (auto-generated)
- `experiments/<id>/` - Isolated experiment configs
- `CHANGELOG.md` - Owner-facing plain-English changes

## Graph Commands

```bash
npm run graph -- status             # champion + metrics + frontier
npm run graph -- next               # best next action (exactly one)
npm run graph -- add <type> <title> # create node
npm run graph -- update <id> ...    # update node
npm run graph -- link <from> <type> <to>  # create edge
npm run graph -- query <mode> <val> # query nodes
npm run graph -- render             # export graph
```

## Experiment Protocol

1. Create Hypothesis node first (expected effect, test plan, kill condition)
2. Create Experiment node linking to hypothesis
3. Code the experiment in `experiments/<id>/`
4. Submit to gate: `npm run gate -- <experiment-id> <champion-id>`
5. Gate verdict is final and auto-recorded
6. Promoted = new champion; Rejected = becomes refuted Learning

## Metrics (Encoded in Gate)

- **North star**: Live ladder Elo/GXE
- **Primary proxy**: Elo vs frozen opponent panel (random, max-damage, past champions)
- **Hard guardrails** (0 violations allowed): 0 invalid moves, 0 crashes, 0 timeouts, p99<2s, fallback≤1%, mismatches=0
- **Statistics**: SPRT (elo0=0, elo1=+10, α=β=0.05), Wilson CIs, paired games with swapped sides

See `src/graph/gate.ts` for full gate spec.

## Config layer

`buildBot(config)` is the only bot factory for self-play, the gate, regression snapshots, and the obvious-move guardrail. `configId` hashes the strategy file. Env profiles `selfplay`, `gate`, `local`, and `ladder` set time, network, logging, and whether LLM calls are allowed. They do not change the move. A time limit marks `overBudget` after the choice.

Add a component: register it in `src/config/layers` with a zod params schema, add a YAML example under `configs/examples`, run `npm run exp -- validate`. Do not special-case a species, a move, or a fixture position.

Position pools are generated from seeded random games and labeled by an exact search of depth at least 2, or mined from losses. `splitFor` holds out 20%. Sweeps and bandits score game win rate plus the dev set. Held-out agreement and live results are the gatekeeper (`npm run exp -- run` only). The analyst writes a mechanism or an eval term. Promotion stays `npm run gate`.

`npm run exp -- validate|run|sweep|ablate|tournament|leaderboard|diff`.

The advisor calls `JevAdvisor` and `GatewayClient`. Loss review calls `LossReviewer`. `npm run ladder` is the live client (`BattleDriver`). It does not import the ops facilities.

## No overfitting to examples

Hand-written positions are smoke alarms, not the target. That includes the diagnostic suite and any single matchup such as Garchomp versus Rotom-Wash.

- Do not special-case a species, move, item, ability, or fixture in engine code. No `if (species === 'Garchomp')`.
- Do not tune a weight, a sample count, or a threshold until one named test passes.
- A fix has to be a general mechanism: accuracy-weighted expectation, the sign of the eval, the opponent model, or an exact battle clone.
- The sets that count are generated and then held out.
  - Sample positions from seeded `gen9randombattle` games. Label the correct move with a forced-win check or a deeper exact-sim search. Do not label it by hand.
  - Mine further positions from live and high-Elo replay logs. Keep a position only while this sim still matches the spectator log.
- `state/positions/dev.json` is the only split that may be inspected. `state/positions/heldout.json` stays closed while tuning. Report agreement on both.
- Promotion requires gate win rates against the frozen panel and the held-out set. Passing the hand-written fixtures is not enough to promote.

## Operations layer

`npm run ops -- factory|gatekeeper|live|analyst` are four processes. They share `state/graph.db`, `state/ops/*.jsonl`, and the game logs. They do not import each other.

- **factory** pulls challenger, sweep, tournament, ablation, and position-replay jobs and writes results. It may attach a proposal only when the same SPRT that the gatekeeper uses would promote. It never writes `champion` or `live-approved`.
- **gatekeeper** is the only writer of those labels. A label requires the challenger to beat the current champion under SPRT (ties count as half, crashes and that config's own invalid choices are counted), a 100% diagnostic pass of the proposed config, and enough games for the boundary to be reached. Bootstrap does not label a champion that has not played. The decision records the evidence.
- **live** plays only those labels on one Showdown login (`SHOWDOWN_USERNAME` / `SHOWDOWN_PASSWORD`). Searches go through the ladder queue: a battle counts when it starts, and a rejected search does not take a slot. If the sim cannot be rebuilt, the session still sends a legal choice. The champion gets most games; live-approved challengers share a 10–20% explore slice. A config is pulled after too many consecutive losses or too large a rating drop. `--local` uses a local server instead of the ladder. Rating and GXE are stored after every game. Each game also draws one variant id from `state/ops/variants.json` by Thompson sampling and logs that id on the live game and on each decision. A missing or empty pool draws nothing, so the config allocation is unchanged.
- **analyst** tails finished live games and ladder JSONL (`logs/ladder` and `live-runs`, including `games.jsonl`). It runs the Grok 4.7 loss reviewer against the calc block and writes a general hypothesis plus a factory job. A torn or corrupt JSONL line is skipped and recorded as `log-corrupt`. Mined positions go to the ops pool (dev / held-out by hash) and use our seat. Opponent category priors count the foe's moves from `ourSide` or the `|player|` line. A scraped replay counts both players.

`npm run ops -- status` is one screen: facility health, queue depth, live record, rating, open regressions. `npm run ops -- report --daily` is the plain-English day summary. `npm run ops -- supervise` restarts a crashed facility with backoff and exits non-zero if one cannot be started; `deploy/jev-ops.service` runs it. Jobs are idempotent and leases expire, so a restart continues the queue.

## Where Creativity Allowed

✓ New hypotheses (strategy, eval, search improvements)  
✓ Experiments via gate  
✓ Ideas with measurable effects

## Where Locked

✗ Champion (changes only via gate)  
✗ Guardrails (hard limits)  
✗ Gate verdict (no overrides)  
✗ Non-negotiables above  
✗ Held-out positions (no peeking, no editing labels to fit the bot)

---

**Current**: Run `npm run graph -- status` for live state  
**Branch**: `cursor/pokemon-showdown-bot-c043`  
**PR**: [#1](https://github.com/Archdiner/jev-showdown/pull/1)

## Live ladder

Run the client from a Mac on a residential or university network. Showdown locks datacenter, VPN, and proxy IPs (the name shows up as `‽username` or `!username` and the socket closes). Node.js 22 is the runtime. `npm install` builds the native `better-sqlite3` module.

```bash
npm install
export SHOWDOWN_USERNAME='your-name' SHOWDOWN_PASSWORD='your-password'
npm run ladder -- --check
```

`--check` logs in, prints `named` / `locked` and the current `gen9randombattle` rating, and exits. A lock, ban, or proxy popup exits with an error and does not reconnect. When it prints `named=yes locked=no`, use the play command below.

The ladder client speaks the Showdown websocket protocol. `--engine max-damage` (the default) calls `maxDamageChoice` (`@smogon/calc`). `--engine search` and `--engine exact` call `exactSearch` with `EXACT_1PLY` (8 samples), the same policy the gate promoted. Credentials come only from the environment and are never printed.

`--labeled-champion` is off unless you pass it. At batch start the client reads the gatekeeper's active champion label and plays that file for the whole batch, but only when the file's content hash still matches the label. The process logs `config live source=... id=... hash=... commit=...` before the first search. A missing label, a drifted file, or two active champions rolls back to the builtin policy for `--engine` and logs the reason. `--rollback` forces that builtin policy even when a label is valid. The choice is fixed when the process starts. A promotion during the batch does not change the engine. Drain and start a new batch to pick up a new champion. In a local two-bot series the opponent stays on `--opponent-engine`. Every finished game (`logs/ladder/games.jsonl` and the per-battle `result` row) stores that batch's `configId`, `configHash`, and commit.

One login can play several battles at once. `--concurrency K` (default 1, absolute max 16) keeps a ladder search queued whenever fewer than K battles are active. `--use-engine-profile` loads `configs/live/concurrency.json`: search 3, max-damage 4, grok 1. `--concurrency-config FILE` overrides those numbers. `--runners N` multiplies the limit the way `ops live --runners=N --concurrency=K` does. An explicit `--concurrency` wins. Showdown can still reject a search under load; that is not a client hard cap of 5. Each battle has its own protocol state, JSONL log, and worker-thread engine. Search time is per battle and is split across decisions that are in flight. If the server rejects a search (already searching, the 5-game cap, or high load), the client logs the popup, backs off, and retries. It never sends `/forfeit`. `--ramp` walks concurrency up to `--concurrency` while p95 latency and the turn timer stay healthy, and steps down when they do not. A latency spike, a thin timer margin, or a search throttle pauses new searches only. In-progress games keep playing.

`./run-live.sh` is the same ladder client. To swap engines without forfeiting, drain the run: `kill -USR1 <pid>`, `kill -TERM <pid>`, `touch state/DRAIN`, or `touch live-runs/<runId>.drain`. The process prints `<pid>` and `<runId>` when it starts. It stops searching, finishes games already on the ladder, writes `logs/ladder/summary.json`, and exits. A second `SIGTERM` or `SIGUSR1` exits immediately. Remove `state/DRAIN` before starting again.

Real ladder (run this on your Mac, not from a cloud agent, and only after `--check` reports `locked=no`):

```bash
npm run ladder -- --games 10 --format gen9randombattle --engine max-damage --concurrency 1
```

That connects to `wss://sim3.psim.us/showdown/websocket`, logs in with `POST https://play.pokemonshowdown.com/action.php` (`act=login`, `name`, `pass`, `challstr`), then sends `/trn username,0,ASSERTION`. It searches `gen9randombattle`, plays `--games` battles, sends `/savereplay`, and exits. On an engine error or timer squeeze it plays the best legal move and records the fallback. Logs are JSONL in `logs/ladder/`:

- one file per battle, named with the username and room id. Turn rows include `searchMs` (engine time), `latencyMs` (wall clock), and `secondsLeft`. The `result` row is the same object as the aggregate file. `ops live` writes that same object to `live-games.jsonl`.
- `logs/ladder/games.jsonl`, one `jev.ladder-game.v1` object per finished game. Schema is in the README.
- `logs/ladder/summary.json` for the run

Override the login endpoint with `SHOWDOWN_LOGIN_URL` if action.php moves. Optional flags: `--search-ms`, `--decision-ms`, `--log-dir`, `--engine`, `--concurrency`.

Local games against the MIT `pokemon-showdown` server (two client instances, no password):

```bash
npm run ladder -- --local --games 12 --format gen9randombattle --concurrency 4 --engine max-damage
```

The process starts a server on port 8143 with `--no-security`, logs in `BotAlpha` and `BotBravo` as guests, and ladder-searches them against each other. `--port` changes the port. To point two separate processes at a server you already started:

```bash
npm run ladder -- --local --server ws://127.0.0.1:8143/showdown/websocket --username BotAlpha --accept --games 10 --format gen9randombattle
npm run ladder -- --local --server ws://127.0.0.1:8143/showdown/websocket --username BotBravo --challenge BotAlpha --games 10 --format gen9randombattle
```

Public high-Elo replay dataset (search API, then per-replay JSON, parsed with `@pkmn/protocol`):

```bash
npm run replays:download -- --format gen9randombattle --min-rating 1600 --pages 3 --out data/replays/gen9randombattle.jsonl
```
