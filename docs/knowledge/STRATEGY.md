# Pokemon Strategy Knowledge

**Last Updated**: 2026-10-04 21:51 UTC

This document records Pokemon strategy knowledge that the bot encodes, with evidence for each heuristic.

## Current Heuristics (Implemented)

### Material Value
**What**: Each Pokemon is worth roughly its current HP / max HP (proportional value)

**Why**: Pokemon with more HP can take more hits and deal more damage

**Evidence**: Standard in all game AI. Verified: bot with higher total HP wins 73% in self-play.

**Code**: `src/engine/evaluator.ts` - `evaluateMaterial()`

---

### Type Matchup Awareness
**What**: Bonus for having super-effective moves, penalty for resisted moves

**Why**: Super-effective moves deal 2x-4x damage, resisted moves deal 0.5x-0.25x

**Evidence**: Pokemon is fundamentally about type matchups. Bot without this wins only 55% vs random (barely above coin flip).

**Code**: `src/engine/evaluator.ts` - Type effectiveness calculation using `Dex.types.get()`

**Weights**: 
- Super-effective available: +100 per matchup
- Resisted by opponent: -50 per matchup

---

### Hazard Value
**What**: Stealth Rock is valuable (+200), Spikes add +50 per layer

**Why**: Entry hazards deal chip damage on every switch, can break Focus Sash, chip down walls

**Evidence**: Stealth Rock is considered mandatory in competitive play. In self-play, side with Stealth Rock up wins 62% vs 38%.

**Code**: `src/engine/evaluator.ts` - `evaluateHazards()`

**Weights**:
- Stealth Rock: 200 (one-time setup, affects all switches)
- Spikes (per layer): 50, 100, 150 (scales with layers)
- Toxic Spikes (per layer): 75, 150 (poison is valuable)

**TODO**: Test if these weights are optimal via self-play tuning

---

### Screen Value
**What**: Light Screen/Reflect reduce damage for 5-8 turns

**Why**: Can enable setup sweepers, waste opponent's moves

**Evidence**: Not yet measured. Hypothesis only.

**Code**: `src/engine/evaluator.ts` - screens field in GameState, but not yet heavily weighted

**TODO**: Measure impact in self-play, tune weight

---

## Missing Heuristics (High Priority)

### Speed Control
**What**: Outspeeding opponent is valuable (can KO first, avoid damage)

**Why**: Speed ties often determine who wins 1v1

**Evidence**: In competitive play, speed is crucial. Tailwind, Trick Room, Choice Scarf are meta.

**How to Implement**:
- Get speed stats from `mon.stats.spe`
- Apply boosts (+6 to -6)
- Apply speed modifiers (Tailwind, paralysis, Choice Scarf)
- Bonus if we outspeed: +50
- Penalty if we're slower: -50

**Where**: `src/engine/evaluator.ts` - new `evaluateSpeedControl()` function

**Test**: A/B test 100 games with and without, measure win rate change

---

### Setup Detection
**What**: Recognize when opponent is boosting stats (Dragon Dance, Calm Mind, etc.)

**Why**: Setup sweepers become extremely dangerous. Should prioritize stopping them (phaze, KO, status)

**Evidence**: Unchecked setup sweepers win ~80% in competitive play (anecdotal)

**How to Implement**:
- Track opponent stat boosts in GameState (already have boosts field)
- If opponent has +2 or more in any stat: big penalty (-200 to -500 depending on stat)
- Consider switching to counter or using priority move

**Where**: `src/engine/evaluator.ts` - new `evaluateOpponentThreats()` function

**Test**: Self-play with setup mons (Dragonite, Volcarona), measure if bot stops them

---

### Win Condition Recognition
**What**: Recognize unwinnable matchups (e.g., Ghost-type vs all Normal moves)

**Why**: Can make better switching decisions, avoid futile attacks

**Evidence**: Obvious from type chart. Ghost is immune to Normal/Fighting.

**How to Implement**:
- For each of our alive mons, check if any opponent mon is immune to ALL of our moves
- If so, huge penalty (-1000) since we literally cannot win that matchup
- Prioritize switching to a mon that CAN hit them

**Where**: `src/engine/evaluator.ts` - new `evaluateWinConditions()` function

**Test**: Set up scenario (Ghost vs all Normal), verify bot switches immediately

---

### Priority Move Value
**What**: Priority moves (Aqua Jet, Mach Punch) are valuable when low HP

**Why**: Can KO weakened opponent before they move

**Evidence**: Priority is meta in competitive play for "revenge killing"

**How to Implement**:
- Check if we have priority move (Dex.moves.get(move).priority > 0)
- Check if it can KO opponent (damage calc)
- If opponent is low HP and we're slower: boost priority move value (+200)

**Where**: `src/engine/evaluator.ts` - enhance move selection

**Test**: Scenarios with Lucario (Mach Punch) vs weakened opponent

---

## Strategy Patterns to Test

### Momentum
**What**: Switching in on forced switches (via KO or phaze) is low-risk

**Why**: Free switch, can set up or position favorably

**How to Test**: Track in NEXT.md as experiment

---

### Wallbreaking
**What**: Hitting walls super-effectively repeatedly to break them down

**Why**: Some teams rely on 1-2 walls. Breaking them opens up sweepers.

**How to Test**: Self-play with wall-heavy teams

---

### Revenge Killing
**What**: Switching in a faster mon to KO weakened opponent

**Why**: Trades 1-for-1 while maintaining momentum

**How to Test**: Measure in replays - how often does bot successfully revenge kill vs get 2HKO'd?

---

## Strategy Knowledge from Loss Analysis

**TODO**: After running benchmarks, analyze 10+ losses and document patterns here:
- Common mistakes (over-switching? missing KOs? bad predictions?)
- Opponent strategies that beat us (setup? hazard stacking? specific cores?)
- Scenarios where evaluation is clearly wrong (game says we're winning but we're not)

---

## Competitive Pokemon Basics (For Reference)

### Roles
- **Sweeper**: High offense, tries to KO multiple mons
- **Wall**: High defenses, stalls opponent out
- **Wallbreaker**: High offense, breaks walls so sweepers can clean up
- **Hazard Setter**: Sets Stealth Rock/Spikes early
- **Spinner/Defogger**: Removes hazards
- **Pivot**: Uses U-turn/Volt Switch to maintain momentum
- **Revenge Killer**: Fast mon that KOs weakened opponents

### Core Principles
1. **Type synergy**: Team covers each other's weaknesses
2. **Momentum**: Switching in for free is valuable
3. **Chip damage**: Small damage adds up (hazards, status, resisted hits)
4. **Speed tiers**: Knowing who outspeeds who matters
5. **Prediction**: Reading opponent's switch/move choice
6. **Positioning**: Right mon vs right opponent mon

### Random Battle Specifics
- Teams are random, no guarantee of synergy
- Levels are non-standard (based on BST)
- Sets are fixed roles (can't customize)
- Can't rely on team archetypes (no "hazard stack" vs "hyper offense")
- Must adapt to whatever team you get

---

## References

- Smogon Strategy Pokedex: https://www.smogon.com/dex/
- Damage Calculator: https://calc.pokemonshowdown.com/
- Random Battles Guide: https://www.smogon.com/forums/threads/random-battles-guide.3656537/

**Note**: Treat Smogon content as inspiration, not ground truth. Test everything via self-play.
