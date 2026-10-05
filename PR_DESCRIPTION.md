# Belief Updater for Tightening Opponent Set Posteriors

## Summary

This PR implements an opt-in belief updater that tightens the posterior over each opponent mon's candidate randbats sets using evidence from battle. The updater uses speed order, damage-roll likelihoods, and hard filters to refine the set posterior beyond the existing move/ability/item/Tera observations.

## Changes

### Core Implementation
- **SetInference enhancements**: Extended existing `noteSpeed` and `noteDamage` methods with proper belief updates via `writeBelief`
- **Config option**: New `beliefUpdaterEnabled` field in `SetInferenceParams` (default: `false`, opt-in only)
- **Weather tracking**: Added turn-based weather tracking for extension item inference
- **Hard filters**: Integrated status move checks, hazard damage, multiple move usage, and weather duration

### Evidence Types
1. **Speed-based inference**: Same-priority move order reveals Choice Scarf when discriminative (accounts for Trick Room, paralysis, boosts, Tailwind)
2. **Damage-roll likelihoods**: Observed HP% lost vs calculated 16-roll distributions per candidate item/ability/Tera (capped at 2 updates per mon to prevent overfitting)
3. **Hard filters**:
   - Status moves → ban Assault Vest
   - Multiple different moves → ban Choice items
   - Hazard damage taken → ban Heavy-Duty Boots
   - Weather lasting 8+ turns → extension items (Heat/Damp/Icy/Smooth Rock)
   - Missing Leftovers healing → downweight Leftovers

### Testing
- Comprehensive test suite in `evidence-updater.test.ts`
- Speed inference tests (Scarf detection from move order)
- Damage inference tests (item likelihood updates)
- Hard filter tests (Assault Vest, Choice items, Boots)
- Parity tests (belief updater disabled = baseline behavior)

### Config
- New config: `configs/exact-1ply-qw-belief.yaml` extends `exact-1ply-qw.yaml` with `beliefUpdaterEnabled: true`
- Live defaults untouched (belief updater stays `false` for existing configs)
- Updated config schema and all opponent layer defaults

## Evaluation Plan

### 1. Offline Item/Role Accuracy
Compare posterior accuracy on honest hidden-info bench logs:
```bash
# Baseline: exact-1ply-qw without belief
npm run bench -- --config exact-1ply-qw --honest-bench --eval-belief

# With belief updater
npm run bench -- --config exact-1ply-qw-belief --honest-bench --eval-belief
```
**Metrics**: Item top-1 accuracy, role top-1 accuracy, log-likelihood (Brier score)

**Target**: Item accuracy 83% → ≥90%, log-loss reduction on held-out replays

### 2. Online Win Rate (800+ Paired Hidden-Info Games)
Seat-swapped paired hidden-info games vs exact-1ply-qw baseline:
```bash
# Main comparison: belief-enabled vs baseline
npm run selfplay -- \
  --p1-config exact-1ply-qw-belief \
  --p2-config exact-1ply-qw \
  --games 800 \
  --swap-seats \
  --honest-bench

# Ablation: same config without belief (control for other changes)
npm run selfplay -- \
  --p1-config exact-1ply-qw \
  --p2-config exact-1ply-qw \
  --games 800 \
  --swap-seats \
  --honest-bench
```
**Metrics**: Win rate, Wilson 95% CI

**Expected**: +2–5 pts vs exact-1ply-qw (unlocks sampled-world search value)

### 3. Latency Budget
```bash
npm run bench -- --config exact-1ply-qw-belief --latency
```
**Budget**: p99 <300 ms (inline with search requirements)

**Expected**: p99 +0–5 ms (evidence updates run between turns, not on decision path)

### 4. Guardrails (Required: 0 Violations)
```bash
npm run bench -- --config exact-1ply-qw-belief --guardrails
```
- 0 invalid choices
- 0 crashes (crashes must never be scored as ties)
- 0 timeouts

### 5. Pre-Flight Check
Before each run:
```bash
npm run data:refresh
npm run verify
```
Confirm `randbatsSpeciesCount() == 509` (fail run if <500)

## Integration with Sampled-World Search (PR #49)

The belief updater is designed to feed into the sampled-world search from PR #49 (branch `cursor/determinized-search-1dd2`) if merged. The tighter posterior will:
- Reduce world diversity when sets are well-constrained
- Focus search on plausible opponent actions
- Improve PIMC sample efficiency (avoids averaging over impossible sets)

**Interface**: `SetInference.sampleWorlds(n)` already draws from the posterior, so no changes needed in PR #49 to benefit from tighter beliefs.

## Related Work

- **PR #62**: Merged rolePosterior system (this extends it with evidence-based updates)
- **Background**: uploads/top5-modelfree.md item #1 and "best next prototype" section
- **Foul Play reference**: Speed/damage inference cited as "extremely important" for randbats performance

## Checklist

- [x] Opt-in config (live defaults untouched)
- [x] Parity tests (disabled = baseline behavior)
- [x] No LLM or external calls
- [x] Comprehensive test coverage
- [ ] Offline evaluation (item/role accuracy)
- [ ] Online win rate (800+ paired games)
- [ ] Latency p99 <300 ms
- [ ] 0 invalid choices / 0 crashes
- [ ] `randbatsSpeciesCount() == 509` verified

## Notes

- Evidence updates run **between turns** (opponent's events), not on the decision path
- The updater is **conservative**: if an update would eliminate all roles, it rolls back
- Speed inference caps at 1 update per mon; damage inference caps at 2 to avoid overfitting
- Hard filters are applied immediately when evidence appears (status move, hazard, etc.)
- Weather extension inference triggers at 8+ turns (normal weather lasts 5 turns)

---

**Ready for review**: Core implementation complete with passing tests. Evaluation benchmarks to be run after PR is opened.
