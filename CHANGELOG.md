# Changelog

## Hybrid search plus an optional game plan

`configs/hybrid.yaml` is a live engine (`--engine hybrid`). It samples the opponent's hidden sets from the gen9 randbats table, locks revealed moves, ability, and item, drops Assault Vest after a status move and Heavy-Duty Boots after hazard chip, and soft-reweights Choice Scarf from speed order. Each sampled world is an exact `@pkmn/sim` battle. Our actions and their replies form a small payoff matrix; regret matching mixes the replies; worlds are averaged by probability. Terastallize is a legal line only for this search. A Tera hold keeps it off early unless the KO rate or the plan says otherwise.

Three blocks are separate config flags. The game plan is asynchronous (turn 1, faints, new reveals, and every few turns) and becomes a preserve bonus and a Tera timing prior. Opponent modelling reweights the sampler from the plan's style. Final judgment may pick among the top three only when their scores sit inside a margin. The default judge is `alibaba/qwen3.8-27b` on Cerebras with reasoning effort medium and no forced temperature. The planner option is `anthropic/claude-opus-5.5` at low effort. A timeout falls back to the search move. Bench profiles are `hybrid-core` (search only), `hybrid-plan` (plan and opponent model), and `hybrid` (all three). Self-play stays hidden-information for both sides, including exact-1ply. Randbats data under 500 species fails the search. The data-loader and belief-tracker tests write a temp directory.

Honest bench, hidden information, 52 pairs (104 games), sides swapped, 509 randbats species. `hybrid-core` (search only) vs exact-1ply: 55W-49L-0T, Wilson 95% 43.4–62.2%, invalid 0, crashes 0, timeouts 0, p50 144ms, p95 196ms. Vs max-damage: 67W-37L-0T, Wilson 95% 54.9–73.0%, invalid 0, crashes 0, timeouts 0, p50 149ms, p95 215ms. Commit `a7d4dfe`. The plan and judgment screens did not finish: the Vercel AI Gateway answered `http_402` (credit balance required) after the first successful calls.

## Opponent set inference

Given the public battle log, the bot keeps a probability distribution over each foe's randbats role, moves, item, ability, and Tera type, and over teammates that have not appeared. Revealed moves, items, and abilities update that distribution. So do damage rolls, speed order (Choice Scarf at randbats level), and negative evidence: a status move rules out Assault Vest, hazard damage rules out Heavy-Duty Boots, a turn with no Leftovers recovery rules out Leftovers, and two different moves without a switch rule out a Choice item. Unrevealed teammates are drawn under the random-battle team rules (no duplicate species, type and role limits). `sampleWorlds(n)` returns concrete teams weighted by that posterior for a search. The champion policy is unchanged; `setInference: calibrated` is opt-in. `npm run eval:sets` scores the distribution against the raw randbats prior on seeded self-play, split into dev and held-out. The players choose a random legal move and terastallize on one in four move choices when the request allows it, so a Tera type is revealed often enough to score. Tests do not write `data/gen9-stats.json`.

## Reliability sentinel

`npm run ops -- sentinel` reads the ladder logs, ops heartbeats, circuits, drain files, and the process list every minute. Each broken invariant becomes an incident in `state/ops/incidents.jsonl` (folded into `state/ops/incidents.json`). A P0 is a game being lost or data being corrupted now. The incident stays open until the check is clear, and it is verified only after a 10 minute soak. `npm run ops -- scorecard` is the owner screen: uptime, open P0/P1, incidents opened and verified, MTTR, Elo, batch and variant records, and what the gate promoted or rejected. Phantom rows (`phantom: true`, or a 0-turn tie with end reason disconnect or unknown) are left out of those rates, and the files the numbers came from are named. The dashboard shows the same incidents and scorecard. `npm run ops -- sentinel --once --json` prints the current incidents as one JSON object and exits 1 when a P0 is open. `npm run ops -- scorecard --md --since <iso>` compares Elo, win rate, and record with the previous window of the same length. When a game row carries `invalidChoiceReasons`, those reasons are added to the invalid-choice incident. The bot's move choice is unchanged.


## Live A/B routing on one ladder login

`--ab <config>:<share>` (repeatable) splits new battles across the champion and one or more challenger configs. The config is a yaml path, a config id under `configs/`, or an engine profile. A hash of the battle id picks the arm. Concurrency, the turn timer, and the choice watchdog stay shared. The process takes one login and takes the account lock once for every arm. Each finished game, metrics line, and the dashboard stamp `configId`, `role`, and `share`. The dashboard has a per-config W/L, Elo change, invalid-move panel, and a scorecard per config. A challenger is pulled to champion-only after an invalid move, a timer loss, a crash, or 4 losses in a row. Each pull is an incident in `incidents.jsonl`. `--check` prints a preflight canary for every arm. A ghost room (`phantom`) does not pull a challenger.

```bash
npm run ladder -- --games 40 --format gen9randombattle --engine search --concurrency 3 --ab configs/panel/maxdamage.yaml:0.2
```

## One ladder runner per account

A ladder process creates `state/ladder-<userid>.lock` with `O_EXCL` before it logs in. The file stores the pid, the start time, and the host. A second process for that account prints the holder's host, pid, and start time and exits non-zero, so two restarts cannot both send choices into the same battles. A lock is stale only when that pid is dead on this host. A lock from another host is left in place. The file is removed on exit and on SIGINT. The first SIGTERM drains and keeps the lock until the process exits. `--check` does not take the lock. A local two-bot series locks BotAlpha and BotBravo.

## Stale battle rooms do not block the drain

A room left over from an earlier session is rejoined when the runner logs in. If its newest `|t:|` is more than 70 minutes old, the client forfeits it and does not deliver its lines, so it is not an in-progress game and does not use a concurrency slot. A room with no `|t:|` (a local battle) stays live. A battle id that already has a result is not counted again, so a second `game_start` cannot hold the drain. The first SIGTERM or SIGUSR1 still drains real games; once every real game has a result the process exits.

## A sent choice is resent until the turn moves

`/choose` returning true is not the server applying the move. If no new `|request|` and no later `|turn|` follows that send within 8 seconds, the same choice and the same rqid are sent again, including on turn 1. A `|turn|1` that arrives after the move was sent does not count: that line starts the turn. A clock line for us with no new turn also resends. Each `choice-delivery` row has `intendedRoomId` (the battle the request belonged to) and `sentRoomId` (the room id written on `/choose`). A choice whose rqid is no longer the room's request is not sent. One websocket frame can carry several battles; each `>roomid` switches the room, so a later battle's `|request|` is not answered in the earlier room. A replay popup names the battle in its URL, including the password after the id, and is not written onto a different open battle or onto whichever room was active most recently. A popup line that names another battle is dropped instead of being stored on the room that happened to receive it. A finished battle ignores later lines, so it does not log a second `game_start`.

## Self-play uses the ladder's hidden information

Local self-play, the factory, and the gatekeeper used to search the real battle, so each bot saw the opponent's full team, sets, and unrevealed moves. They now build the decision the way the live ladder does: a `@pkmn/client` replay of the lines that side would receive, then `livePositionFromClient` and `buildDecisionBattle`. Unrevealed teammates, moves, items, and abilities stay hidden. The foe model is that same function, so a later change to the ladder's opponent sets applies here too.

`information: full` on a game, `--information=full` on `npx tsx src/bench/cli.ts`, or `JEV_INFORMATION=full` keeps the old omniscient sim for comparison. The default is hidden.

Same seeds, 20 pairs, sides swapped, 40 games, after `npm run data:refresh` (509 randbats species in `gen9-stats.json`). `exact` is `EXACT_1PLY` (8 samples). Invalid choices 0, crashes 0, view misses 0.

| Matchup | Full information | Hidden information |
| --- | --- | --- |
| exact vs max-damage | 80.0% (32W-8L-0T), 95% CI 65.2–89.5% | 60.0% (24W-16L-0T), 95% CI 44.6–73.7% |
| exact vs random | 100% (40W-0L-0T), 95% CI 91.2–100% | 100% (40W-0L-0T), 95% CI 91.2–100% |
| max-damage vs random | 100% (40W-0L-0T) | 100% (40W-0L-0T) |

Exact's voluntary switch rate vs max-damage fell from 35.5% (425/1196) with full information to 14.9% (137/921) with hidden information. The published gate (300 games, full information) was 78% vs max-damage and 98% vs random. Hidden information is where that lead shrinks.


## The analyst reads ladder games and the foe's real seat

`npm run ops -- analyst` tails `state/ops/live-games.jsonl` and the JSONL under `logs/ladder` and `live-runs` (per-battle files, `games.jsonl`, and copies dropped in a live-runs directory). A ladder loss becomes the same hypothesis and factory job as an ops-live loss. The protocol text comes from the row's `log` or from `localReplayPath`. `metrics.jsonl` is not a game log.

Priors count the opponent's moves and switches. The seat is `ourSide` on the row, or the `|player|` line that matches `username`. When we are p1 the foe is p2, and when we are p2 the foe is p1. A row that names neither seat is skipped for priors instead of being treated as one side. A scraped public replay counts both players. Mined regression positions use that same seat. `ops live` still sends a move as p1 when the request and the player line both omit the seat, and that guess is not written on the game row.

## Ladder games name the config that played them

Every finished ladder game stores `configId`, `configHash`, and the git commit of the config chosen when the batch started. The default is still the builtin policy: `champion-exact-1ply` for `--engine search` / `exact`, and `maxdamage-v1` for `--engine max-damage`. The hash is the policy itself, not the turn time limit.

`--labeled-champion` opts in to the gatekeeper's active champion file. The client loads it once, before the first search, and only if the file's content hash still matches the label. It logs `config live` with the source, id, hash, and commit. A missing label, two labels, or a file that changed after the label rolls back to the builtin policy and logs the reason. `--rollback` forces that builtin policy. A promotion while games are in progress does not change the engine. Start a new batch to pick it up.

## Optional PostHog mirror

If `POSTHOG_API_KEY` is set, each finished ladder game is also sent to PostHog as `ladder_game`. The HTTP call is queued and is never awaited while a turn is being chosen. `POSTHOG_LLM_TRACES=1` adds model, latency, token, and cost metrics for gateway calls, without the prompt. Unset, the sink does nothing. The JSONL file remains the record that matters.

## Ladder timers and undelivered choices are logged

A turn no longer reuses the previous `|inactive|` clock: `secondsLeft` is cleared when the next request arrives. If `/choose` returns false, the client writes a `choice-delivery` row and retries. When the server rejects the last legal move, one `no-legal-retry` row is written. Popups name a battle when the text contains its room id; with several battles and no id, each open battle logs the popup as ambiguous instead of attaching it to whichever room ended last. Finished battles are dropped from memory. The game result counts delivery failures, exhausted retries, and ambiguous popups. `createLogger` keeps the last 2000 decisions and 500 games in memory. The JSONL files still receive every row.

## Rating and GXE stay null when the server omits them

The ladder rating parser now reads GXE from the HTML popup `(GXE: …)` and from a `|rating|elo|gxe` line. If that number is not there, `gxe` is null. A missing rating stays null. The client does not fill in 1000 or 50. Each parsed update is a `rating` event in the per-battle JSONL, and the game `result` copies Elo before/after, GXE, and `gxeSource`. `ops live` writes the same nulls on its live-game row and does not feed a stand-in Elo into the circuit breaker.

## Replay links are confirmed before the game row is written

`/savereplay` still asks the Showdown server to upload the battle. The game row keeps `replayUrl` only when that upload comes back as a `replay.pokemonshowdown.com` link, and it is written as soon as the link arrives (the public client waits up to 8 seconds). `replayId` is always the battle's replay id, including when the server never confirms the upload. The raw protocol log stays on disk at `localReplayPath`. A local server is `replayStatus: "local-only"` and does not wait on a public URL.

## Each finished game is one JSONL record

`logs/ladder/games.jsonl` and `ops live`'s `live-games.jsonl` append the same `jev.ladder-game.v1` fields when a battle finishes. The row has the opponent and their pre-game rating, our Elo before and after, GXE when the line includes it, why the game ended, wall-clock duration, and which engine, config, git commit, and concurrency ran it. Decision timing uses the live-metrics names: per-turn `latencyMs`, and `latencyP50Ms`, `latencyP95Ms`, `latencyP99Ms`, `latencyMaxMs`, and `minTimerMarginSec` on the game. Missing Elo and GXE stay null. Turns, invalid choices, crashes, fallbacks, and the ladder stdout line are unchanged.

## Ladder uses the promoted engines

`npm run ladder -- --engine search` and `--engine exact` call `exactSearch` with the gate champion `EXACT_1PLY` (8 samples). `--engine max-damage` calls `maxDamageChoice` from `@smogon/calc`. The ladder builds that choice from the live request, so the move index is the one the server asked for. Concurrency profiles, drain, and live metrics are unchanged.

## Operations layer

Four long-running commands share the graph and the logs: `npm run ops -- factory`, `gatekeeper`, `live`, and `analyst`. The factory runs queued simulations and may propose a config. The gatekeeper is the only command that writes `champion` or `live-approved`, and only after SPRT and a 100% diagnostic pass. Live plays those configs on one Showdown login, gives the champion most of the games, and pulls a config after a loss streak or a rating drop. The analyst turns a live loss into a general hypothesis and a factory job. `status`, `report --daily`, and `supervise` read the same store. `deploy/jev-ops.service` is the systemd unit.

## Config layer

Bots are built only with `buildBot(config)`. The same file and configId are used in self-play, the gate, and diagnostics. Env profiles change time limits, logging, and LLM permission, not the strategy. `npm run exp` runs, sweeps, ablates, and compares configs. Sweeps use win rate and the dev position set. Held-out positions and live results are checked by the gatekeeper and are not tuning targets. A loss becomes a general mechanism or eval term. Promotion stays `npm run gate`.

## Situation brief

`renderContextBrief` writes the turn context a later strategist will read: both sides that are allowed to be named, our bench and the opponent's revealed bench, a damage matrix of our moves and their likely moves into the active and every switch-in, a public speed index, field conditions, set inference from revealed moves or the random-battle movepool, and the fitted high-Elo switch probability. Unrevealed opponent species are a count, not a list. The function does not call a model. A missing `VERCEL_AI_GATEWAY_KEY` does not change it.

## Exact 1-ply search promoted

The old 3-ply search was not looking at the live battle. It built a fresh one. After a knockout the live request is a switch, and the copy still asked both players for a move. The switch was rejected. Every rejection was scored as a loss, so the search was grading crashes instead of HP. Cloning the live battle and scoring HP fraction plus faints fixes that.

Two smaller bugs sat on the same path. `@smogon/calc` only applies an ability when it is given the display name, and the helper passed the sim id (`levitate`), so Levitate was ignored and Earthquake into a floating Pokémon was scored as a hit. The helper also ignored accuracy, so an 80% move was scored as if it always landed. And the full evaluator treated `0` HP as "HP unknown" and assumed a full bar, which made a knockout look worse than chip damage. Fainted HP is now `0`. In-progress full-eval scores are divided by the material weight so a finished game (±1000) outranks a lead.

The promoted engine is a 1-ply clone of the live `@pkmn/sim` battle. The opponent reply is the accuracy-weighted max-damage move. Eight RNG draws are averaged. The score is HP fraction plus faint counts. Hand-written diagnostics are smoke alarms only (22/22 on a fixed seed). They do not promote.

Gate verdict **promoted** at commit `fcd9c92`. Seed 1, 150 pairs, sides swapped, 300 games per opponent:

| Opponent | Result | 95% CI |
| --- | --- | --- |
| random | 98.0% (294W-5L-1T) | 95.7%–99.1% |
| max-damage | 78.0% (234W-66L-0T) | 73.0%–82.3% |

Invalid choices 0, crashes 0, timeouts 0, fallback 0, p99 turn time 190ms. No turn was over 2 seconds.

Generated positions, labeled by a depth-2 search rather than by hand. Dev may be inspected. Held-out was not opened while tuning.

| Split | Positions | Replay snapshots | Search agrees with depth 2 | Max-damage agrees |
| --- | --- | --- | --- | --- |
| dev | 230 | 30 | 38.7% (89/230) | 23.9% (55/230) |
| held-out | 217 | 17 | 37.8% (82/217) | 21.2% (46/217) |

The forced-win slice is empty. These positions are the first turn where both sides can act, not endgames, so no move wins against every reply. Replay rows are the ones this sim still matched to the spectator log. Many high-Elo logs diverge on turn 1 because the team generator version differs, and those were dropped.

Adding pieces back, same harness, seed 1. The champion row is the gate. The other rows are smaller samples. `exact:` rows use one RNG draw.

| Engine | vs random | vs max-damage | p99 |
| --- | --- | --- | --- |
| 1-ply, max-damage reply, HP, 8 draws (champion) | 98.0% of 300 | 78.0% of 300 | 190ms |
| 1-ply, max-damage reply, HP, 1 draw | 98.8% of 80 | 82.5% of 80 | 60ms |
| 1-ply, uniform reply, HP, 1 draw | 97.5% of 80 | 67.5% of 80 | 198ms |
| 2-ply, max-damage reply, HP, 1 draw | 96.7% of 30 | 80.0% of 30 | 333ms |
| 3-ply, max-damage reply, HP, 1 draw | 100% of 8 | not run | 2400ms |
| 1-ply full eval, before the 0 HP fix | 72.5% of 40 | 5.0% of 40 | 50ms |
| 1-ply full eval, after the 0 HP fix | 100% of 40 | 77.5% of 40 | 98ms |

Depth 3 is over the 2 second guardrail, so it is not the champion. Averaging every opponent move, including bad switches, is weaker against a max-damage opponent (67.5% of 80) than predicting that opponent's best move. The full evaluator was the step that collapsed, and the 0 HP check was why.

`npm run ladder -- --engine search` still calls `Bot.selectAction`. This promotion does not switch the live client.

## Ladder lock check

`npm run ladder -- --check` logs in and prints whether the account is named or locked and the current gen9randombattle rating, then exits. A proxy, ban, or lock popup, or a `‽` / `!` name in `|updateuser|`, exits immediately and does not reconnect. A close that follows that popup is not retried. `send()` no longer throws from timers; the ladder queue waits until the socket is logged in. Setup on a Mac is `npm install`, export `SHOWDOWN_USERNAME` and `SHOWDOWN_PASSWORD`, then `--check`.

## LLM layer (branch `cursor/llm-layer`)

Search stays in charge. Two models sit beside it and can be turned off:

- **Jev** (`typesafe-ai/jev`) is an evaluation model. The advisor POSTs `/v1/evaluate`. The state string is built from the dex, `@smogon/calc`, and the randbats role pool: types, Tera, ability, item, level, HP, boosts, status, speed including Scarf and boosts, per-move damage range, KO chance, accuracy, and priority, the opponent's likely moves into our active and bench, hazards, screens, weather, terrain, and each candidate's search score. Those numbers are also copied into each choice criterion. The loss reviewer has to quote that calc block and is told not to invent type matchups. Blending is off unless a gate challenger opts in (`experiments/llm-jev-prior`). A missing key, a timeout, or a free-tier `403 RestrictedModelsError` leaves the move as pure search. The 403 is logged once and later turns do not call the network.
- **Loss reviewer** defaults to **Grok 4.7** (`spacexai/grok-4.7`, $2 / $6 per million input / output tokens as of the 2026-10-04 gateway catalog). It writes a hypothesis into the project graph and does not change code. Claude Opus 5.5 and GPT-6.1 Sol are the recorded alternatives. Set `LOSS_REVIEWER_MODEL` to switch.

---


**Note**: This file is the owner-facing plain-English summary of changes. For technical state and task queue, run:
- `npm run graph -- status` - Current champion, metrics, frontier tasks
- `npm run graph -- next` - Exactly one task with measurable acceptance criteria
- View `state/graph.html` for visual graph

---

# Cloud Agent Run (Oct 4, 2026)

## Live ladder client

`npm run ladder -- --games N --format gen9randombattle --engine search --concurrency K` plays the real ladder with `SHOWDOWN_USERNAME` and `SHOWDOWN_PASSWORD`. `--engine max-damage` is the default (it won a local head-to-head against `search`). `--engine search` still calls `Bot.selectAction`. `--concurrency` (default 1, max 5) runs that many battles on one login, each with its own state, worker, and JSONL file. `npm run ladder -- --local --games N --concurrency K` plays two clients on a local MIT Pokémon Showdown server. See AGENTS.md for the exact commands. Search and eval were not changed.

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
