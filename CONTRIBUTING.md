# Contributing

One feature per pull request. Rebase on `main` before pushing. A branch that is not contained in `origin/main` does not go live: `npm run live:preflight` refuses it.

## Required CI

These checks are required. A green local `npm test` is not a substitute for the jobs that are split out:

- **test** — unit tests. They redirect writes to a temp data directory and fail if `data/` changes.
- **typecheck** — `npx tsc --noEmit` on Node 24.
- **soak** — `npm run test:soak -- --ci`. The real ladder client plays a local game at concurrency 3, including a dropped choice and a drain.
- **data guard** — the run fails if a test writes under `data/`.
- **schema** — `games.jsonl` rows match `jev.ladder-game.v1`.
- **network guard** — unit tests clear provider keys and fail if `fetch` is called.

## Bug fixes

Every bug fix ships with a regression test that fails before the fix. The pull request names the root cause, the regression test, and the invariant or check that was added or updated. The template is `.github/PULL_REQUEST_TEMPLATE.md`.

Hand-written positions are smoke alarms. Do not special-case a species, a move, an item, an ability, or a fixture. Do not tune a weight until one named test passes. `state/positions/heldout.json` stays closed.
