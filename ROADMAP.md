# Roadmap to #1

Goal: Reach #1 on the Gen 9 Random Battle ladder (2557+ Elo, beating Jaxcalibur's record).

## Current State (v0.1.0)

**Implemented:**
- ✅ MCTS search engine with UCB1
- ✅ Bayesian opponent belief tracker
- ✅ Heuristic evaluation function
- ✅ Damage calculator integration
- ✅ Showdown client (WebSocket, login)
- ✅ Battle logger (SQLite)
- ✅ Self-play harness
- ✅ Random and max-damage baselines
- ✅ LLM integration (Vercel AI Gateway)
- ✅ Data refresh pipeline

**Status:**
- Self-play benchmarks: TBD (run `npm run benchmark`)
- Ladder Elo: Not yet measured
- Estimated strength: 1400-1600 Elo (competent play)

**Known Gaps:**
- Opponent modeling is uniform (ignores Elo/playstyle)
- No damage roll inference for sets
- No speed tier tracking (Scarf detection)
- Shallow search depth (~100-1000 iterations per turn)
- Heuristic evaluation (no learned value function)
- No policy network (pure MCTS)

## Milestones

### Phase 1: Functional Bot (v0.1 - v0.3) ✅ CURRENT

**Target:** Pass self-play benchmarks, complete ladder games, reach 1500-1700 Elo.

- [x] Implement core engine (MCTS, beliefs, eval)
- [x] Build Showdown client
- [x] Add battle logging
- [x] Create self-play harness
- [ ] **Pass benchmarks** (≥65% vs max-damage, ≥90% vs random)
- [ ] **Ladder 50 games** → measure Elo
- [ ] Fix critical bugs (timeouts, crashes, illegal moves)

**Timeline:** Functional now, benchmarks and ladder TBD.

---

### Phase 2: Strong Heuristic Bot (v0.4 - v0.6)

**Target:** Reach 1800-2000 Elo (top 10-20%), beating most humans.

**Search Improvements:**
- [ ] Faster MCTS (3-5k iterations/turn)
- [ ] Root-parallel search (sample multiple opponent worlds in parallel)
- [ ] RAVE (Rapid Action Value Estimation) for move ordering
- [ ] Transposition tables (cache states)
- [ ] Iterative deepening with time control

**Belief Improvements:**
- [ ] Damage roll inference (narrow set probabilities from observed rolls)
- [ ] Speed tier tracking (detect Scarf, Tailwind, paralysis)
- [ ] Ability inference (Flash Fire, Levitate, etc.)
- [ ] PP tracking
- [ ] Set elimination on contradictions

**Evaluation Improvements:**
- [ ] Type matchup awareness (offensive/defensive typing)
- [ ] Win condition detection (sweep threats, checks)
- [ ] Endgame heuristics (priority, guaranteed KOs)
- [ ] Hazard value tuning (Stealth Rock > Spikes)
- [ ] Tera timing heuristic (preserve for sweeps or survival)

**Learning:**
- [ ] Tuned eval weights (CMA-ES or Bayesian optimization on self-play)
- [ ] Loss analysis → heuristic patches
- [ ] A/B testing pipeline (1000-game tournaments)

**Ladder:**
- [ ] 200+ games → stable Elo estimate
- [ ] Replay analysis (compare to high-Elo humans)

**Estimated timeline:** 2-4 iterations, depends on tuning.

---

### Phase 3: Learned Value Bot (v0.7 - v0.9)

**Target:** Reach 2100-2300 Elo (top 1-5%), approaching foul-play strength.

**Neural Network (Policy + Value):**
- [ ] Collect 100k+ self-play games (MCTS policy as training signal)
- [ ] Download high-Elo replays (1800+ from replay.pokemonshowdown.com)
- [ ] Design network architecture:
  - Input: Board state (team, HP, status, hazards, beliefs)
  - Output: Move policy (visit distribution) + value (win probability)
  - Size: 5-20M parameters (ResNet or Transformer)
- [ ] Train via supervised learning (self-play MCTS labels)
- [ ] Fine-tune via self-play RL (PPO or AlphaZero-style)
- [ ] Integrate into MCTS (use network for eval + move priors)

**Search Improvements:**
- [ ] PUCT (AlphaGo-style with policy prior)
- [ ] Virtual loss for root-parallel search
- [ ] Dirichlet noise at root (exploration)

**Opponent Modeling:**
- [ ] Cluster opponents by Elo (1200 / 1500 / 1800 / 2000+)
- [ ] Learn Elo-specific action distributions from replays
- [ ] Sample opponent moves from learned policy (not uniform)

**Learning Pipeline:**
- [ ] Self-play → retrain network every 10k games
- [ ] Track Elo over training (measure improvement)
- [ ] A/B test network versions (promote winners)

**Ladder:**
- [ ] 500+ games → stable Elo
- [ ] Compare to foul-play (2340) via challenge matches

**Estimated timeline:** Depends on compute (GPU required).

---

### Phase 4: Top-Tier Bot (v1.0+)

**Target:** Reach 2400+ Elo (top 0.1%), beat foul-play, approach Jaxcalibur (2557).

**Search at Scale:**
- [ ] Root-parallelized MCTS (16-64 threads)
- [ ] Deeper search (10k-50k iterations/turn with better pruning)
- [ ] Late-game solver (exact endgame evaluation)

**Advanced Opponent Modeling:**
- [ ] Per-opponent adaptation (track individual playstyles)
- [ ] Bayesian opponent policy update (human vs bot detection)
- [ ] Anti-exploit heuristics (detect patterns, randomize responses)

**Data at Scale:**
- [ ] 1M+ self-play games
- [ ] Scrape all 1800+ replays from 2026 (100k+ games)
- [ ] Offline RL (transformer trained on replay corpus)

**Jaxcalibur Techniques:**
- [ ] AlphaZero-style training (no human data)
- [ ] Self-play curriculum (gradually stronger opponents)
- [ ] Multi-format transfer (train on other random formats)

**Specialized Heuristics:**
- [ ] PP stalling detection (Jaxcalibur's known weakness)
- [ ] Setup sweep recognition
- [ ] Optimal Tera timing (game-tree lookahead)

**Ladder:**
- [ ] 1000+ games → GXE estimate (95%+ needed for #1)
- [ ] Challenge matches vs Jaxcalibur (if available)
- [ ] Leaderboard position tracking

**Estimated timeline:** Open-ended. Jaxcalibur took ~6 months on H100.

---

## Technical Debt

**High Priority:**
- [ ] Robust error handling (network failures, malformed messages)
- [ ] Turn time management (avoid timeouts)
- [ ] Protocol edge cases (forfeits, disconnects, spectators)
- [ ] Memory leaks (long self-play runs)

**Medium Priority:**
- [ ] CLI improvements (progress bars, better logging)
- [ ] Replay export (for debugging)
- [ ] Evaluation visualization (what the bot "sees")
- [ ] Configuration profiles (fast/strong modes)

**Low Priority:**
- [ ] Web UI for battle viewer
- [ ] Docker deployment
- [ ] Cloud self-play (distributed)

---

## Open Research Questions

1. **Search vs Learning Balance**  
   Jaxcalibur used deep search (~2400 Elo with search off, +150 Elo with search). Is search or the value network more important?

2. **Opponent Modeling**  
   Should we model opponents as Elo clusters, individuals, or assume perfect play? Random battles are high-variance.

3. **Data Sources**  
   Is self-play or human replays more valuable? Foul-play used no learning; Jaxcalibur used pure self-play.

4. **Tera Timing**  
   Terastallization is the hardest decision. Can we solve it with lookahead or learn it end-to-end?

5. **Move Ordering**  
   Can we beat foul-play's depth with better move ordering (RAVE, learned priors)?

6. **Anti-Bot Meta**  
   Will the ladder adapt to bots (PP stalling, exploit patterns)? How do we make play less predictable?

---

## Resources

- **Compute:** CPU for Phase 1-2, GPU (V100/A100/H100) for Phase 3-4
- **Data:** Unlimited self-play (local), ~100k high-Elo replays (public)
- **Time:** Phase 1 done, Phase 2 is weeks, Phase 3+ depends on compute
- **Baselines:** foul-play (2340), Jaxcalibur (2557, closed)

---

## Success Criteria

### Short-Term (1 month)
- ✅ Code complete and tests pass
- ⬜ Self-play benchmarks pass (≥65%)
- ⬜ Ladder functional (no timeouts/crashes over 10 games)
- ⬜ Measured Elo ≥1400

### Medium-Term (3-6 months)
- ⬜ Elo ≥1800 (top 20%)
- ⬜ Tuned evaluation weights
- ⬜ Damage roll and Scarf inference
- ⬜ 500+ ladder games logged

### Long-Term (6-12 months)
- ⬜ Policy/value network trained
- ⬜ Elo ≥2200 (top 3%)
- ⬜ Beat foul-play in challenge matches (>50%)

### Ultimate Goal
- ⬜ Elo ≥2400 (top 0.1%)
- ⬜ #1 ladder rank (surpass Jaxcalibur's 2557)
- ⬜ Published writeup (architecture, training, results)

---

## Next Steps (Immediate)

1. **Run benchmarks:** `npm run benchmark`
2. **Fix failures:** If <65% vs max-damage, debug search or eval
3. **Set up bot account:** Register on Pokemon Showdown
4. **Ladder 50 games:** Measure initial Elo
5. **Analyze losses:** `npm run analyze` → identify weak heuristics
6. **Iterate:** Tune weights, improve search, repeat

**First commit:** Working bot + passing tests + documentation  
**First PR:** Merge to main when benchmarks pass  
**First ladder run:** After merging and configuring credentials

---

## Contributors

This roadmap is a living document. Suggestions welcome via issues or PRs.

---

*Last updated: 2026-10-04*  
*Current version: v0.1.0*  
*Status: Phase 1 (Functional Bot)*
