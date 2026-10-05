# Agent Protocol

**Mission**: #1 on gen9randombattle ladder via exact mechanics + strategic play.

## Non-Negotiables

1. MIT-only code (no GPL)
2. Exact @pkmn/sim in search (0% fallback)
3. All claims verified with numbers (commit SHA + game count)
4. Small atomic commits, push frequently
5. Changes through gate (champion/challenger) - no manual overrides

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

## Where Creativity Allowed

✓ New hypotheses (strategy, eval, search improvements)  
✓ Experiments via gate  
✓ Ideas with measurable effects

## Where Locked

✗ Champion (changes only via gate)  
✗ Guardrails (hard limits)  
✗ Gate verdict (no overrides)  
✗ Non-negotiables above

---

**Current**: Run `npm run graph -- status` for live state  
**Branch**: `cursor/pokemon-showdown-bot-c043`  
**PR**: [#1](https://github.com/Archdiner/jev-showdown/pull/1)

## Live ladder

The ladder client speaks the Showdown websocket protocol and asks `Bot.selectAction` (`--engine search`) or the max-damage heuristic (`--engine max-damage`) for every choice. It does not change search or eval. Credentials come only from the environment and are never printed.

One login can play several battles at once. `--concurrency K` (default 1, maximum 5) keeps a ladder search queued whenever fewer than K battles are active. Each battle has its own protocol state, JSONL log, and worker-thread engine. Search time is per battle and is split across decisions that are in flight. If the server rejects a search (already searching, the 5-game cap, or high load), the client logs the popup, backs off, and retries. It never sends `/forfeit`.

Real ladder (run this on your machine, not from a cloud agent):

```bash
export SHOWDOWN_USERNAME='your-bot-name'
export SHOWDOWN_PASSWORD='your-password'
npm run ladder -- --games 10 --format gen9randombattle --engine search --concurrency 1
```

That connects to `wss://sim3.psim.us/showdown/websocket`, logs in with `POST https://play.pokemonshowdown.com/action.php` (`act=login`, `name`, `pass`, `challstr`), then sends `/trn username,0,ASSERTION`. It searches `gen9randombattle`, plays `--games` battles, sends `/savereplay`, and exits. On an engine error or timer squeeze it plays the best legal move and records the fallback. Logs are JSONL in `logs/ladder/`:

- one file per battle, named with the username and room id: turns, decisions, scores, state mismatches, opponent role probabilities, result, replay id, replay URL, Elo before/after
- `logs/ladder/summary.json` for the run

Override the login endpoint with `SHOWDOWN_LOGIN_URL` if action.php moves. Optional flags: `--search-ms`, `--decision-ms`, `--log-dir`, `--engine`, `--concurrency`.

Local games against the MIT `pokemon-showdown` server (two client instances, no password):

```bash
npm run ladder -- --local --games 12 --format gen9randombattle --concurrency 4 --engine search
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
