# Data Sources

**Last Updated**: 2026-10-04 21:51 UTC

## Trusted Sources (Use These)

### Pokemon Showdown Gen9 Random Battle Sets
**URL**: `https://raw.githubusercontent.com/smogon/pokemon-showdown/master/data/random-battles/gen9/sets.json`  
**What**: Official movesets, items, abilities, and EV spreads for each Pokemon in Gen 9 Random Battles  
**Refresh Cadence**: Check daily, auto-refresh when changes detected  
**Reliability**: ✅ Ground truth - this is what the server uses  
**Cached In**: `data/gen9-sets.json`  
**Notes**: JSON format with species → role → set data. Roles are weighted (e.g., "Fast Attacker": 0.7, "Bulky Setup": 0.3)

### pkmn Randbats Statistics
**URL**: `https://pkmn.github.io/randbats/data/gen9randombattle.json`  
**What**: Statistical analysis of randbats usage - species frequency, level distribution, role distribution  
**Refresh Cadence**: Check weekly  
**Reliability**: ✅ Derived from official data, well-maintained  
**Cached In**: `data/gen9-stats.json`  
**Notes**: Use for initial belief before any reveals. Complements sets.json.

### @pkmn/sim Package
**URL**: `https://www.npmjs.com/package/@pkmn/sim`  
**What**: Official Pokemon Showdown battle simulator  
**Refresh Cadence**: Check for updates weekly (`npm outdated`)  
**Reliability**: ✅ This IS Pokemon Showdown - exact same code as server  
**Version**: Check `package.json` (currently ^0.10.11)  
**Notes**: Battle engine, move/ability/item effects, damage calculation, all mechanics. MIT licensed.

### @pkmn/dex Package
**URL**: `https://www.npmjs.com/package/@pkmn/dex`  
**What**: Pokemon data (species stats, types, moves, abilities, items)  
**Refresh Cadence**: Check for updates weekly  
**Reliability**: ✅ Official data, always in sync with @pkmn/sim  
**Version**: Check `package.json` (currently ^0.10.11)  
**Notes**: Use `Dex.species.get()`, `Dex.moves.get()`, etc. for all lookups.

### @pkmn/randoms Package
**URL**: `https://www.npmjs.com/package/@pkmn/randoms`  
**What**: Random battle team generation  
**Refresh Cadence**: Check for updates weekly  
**Reliability**: ✅ Official implementation  
**Version**: Check `package.json` (currently ^0.10.11)  
**Notes**: Used to generate teams for self-play. Provides `TeamGenerators.getTeamGenerator()`.

### @smogon/calc Package
**URL**: `https://www.npmjs.com/package/@smogon/calc`  
**What**: Damage calculator (optional, for evaluation heuristics)  
**Refresh Cadence**: Check for updates monthly  
**Reliability**: ✅ Smogon's official calculator, battle-tested  
**Version**: Check `package.json` (currently ^0.12.0)  
**Notes**: MIT licensed. Use for quick damage estimates in evaluation if needed. Slower than Battle.makeChoices() for full turn sim.

## Untrusted/Unofficial Sources (Do Not Use Without Vetting)

### ❌ Showdown Replays for Training
**Why Not**: User-submitted, may include hacked mons, disconnects, forfeits. Not representative of optimal play.  
**If Using**: Heavily filter (remove forfeits, disconnects, low-rated games). Clearly label as "noisy data".

### ❌ Smogon Strategy Forum Posts
**Why Not**: Opinions, not data. May be outdated, format-specific, or wrong.  
**If Using**: Treat as hypotheses to test, not ground truth. Verify via self-play experiments.

### ❌ Third-Party Stat Sites (Pikalytics, etc.)
**Why Not**: May lag updates, different format (VGC vs Showdown), unclear methodology.  
**If Using**: Cross-check against official sources. Use only for inspiration, not as training data.

### ❌ LLM-Generated Strategy Advice
**Why Not**: Hallucinations, outdated knowledge (training cutoff), no battle testing.  
**If Using**: Treat as creative prompts only. Test every suggestion via benchmarks before adopting.

## Data Refresh Protocol

**Automated**: `src/data/freshness-checker.ts` runs on startup and at most once per 24 hours.

**Manual**: Run `npm run data:refresh` to force check all sources and download updates.

**What It Does**:
1. Fetch latest sets.json and stats.json
2. Compare SHA256 hashes against `data/metadata.json`
3. If changed: Log changes (species added/removed, level changes), save new file, update metadata
4. Check @pkmn/sim version, warn if behind server version

**When to Refresh**:
- After any official format update announcement
- If bot starts losing badly to "impossible" sets (may be new Pokemon)
- Weekly as part of maintenance

**What to Update in Code**:
- Rarely: Data format changes would require updating data-loader.ts
- Never: Battle mechanics are in @pkmn/sim, just update the package

## Reliability Tiers

**Tier 1 (Ground Truth)**: @pkmn/sim, @pkmn/dex, official sets.json from smogon/pokemon-showdown  
→ Use without question. If bot behavior differs from this, bot is wrong.

**Tier 2 (Derived but Trustworthy)**: @pkmn/randoms, pkmn.github.io stats, @smogon/calc  
→ Use with confidence, but verify if something seems off.

**Tier 3 (Useful for Ideas)**: Smogon analyses, high-rated player replays, forum discussions  
→ Treat as hypotheses. Test before adopting.

**Tier 4 (Noise)**: Random replays, LLM output, third-party sites  
→ Do not use as truth. Can inspire experiments, but must be validated.
