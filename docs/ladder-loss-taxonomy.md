# Ladder loss taxonomy (archinder, gen9randombattle)

Sample: every public replay returned by

`https://replay.pokemonshowdown.com/search.json?user=archinder&format=gen9randombattle`

paginated with `before=<uploadtime>` until the list stopped. That was **62 games**, uploaded **2026-10-05 00:25Z through 03:14Z**. Each replay's `.json` (protocol log plus input log) was parsed. The account was on the exact 1-ply engine (`EXACT_1PLY`, 8 samples).

Record in this window: **21 wins, 41 losses** (33.9% of games). Twelve of the wins ended because the opponent forfeited or lost to inactivity. Seven of the losses are `Archinder lost due to inactivity`. The games that were played to a knockout are about **9 wins and 34 losses**.

Search-hit ratings on these replays run from 1000 to 1209. That matches the live account sitting near Elo 1079 / GXE 28.5. The rating on a replay is the battle's listed rating, not a recomputed Elo.

## How a turn was tagged

Tags come from the spectator log, not from a second search. A turn can carry more than one tag. Cost is a rough fraction of one of our Pokémon:

- our Pokémon faints on that turn: 1.0
- we only lose HP: that fraction of its max HP
- game-level tags are counted once per loss and are not added into the turn costs

Bench resists use teammates that appeared at some point in the game, including ones that had not been sent out yet. That over-counts "a resist was available" slightly. The switch tag requires the opponent to voluntarily switch to a different species on the same turn our move is resisted or immune.

`|-immune|` is the log's word, so it includes typing, abilities, and items (Air Balloon). "Another move hits" uses the moves that Pokémon actually used in the game, not a guessed set.

## Counts

| Category | Turns | Losses | What it looks like | Rough cost |
| --- | ---: | ---: | --- | ---: |
| Never Terastallize | 0 teras in 62 games | 41/41 | Opponents terastallized 21 times. We never did, including wins. | Structural. 22 super-effective KOs in losses came with Tera still unused (14 losses). |
| Attack into an immunity while another move connects | 9 | 6 | Earthquake into Landorus or Klefki, Poison Jab into Sandslash-Alola, Psychic into Galarian Moltres, repeated on later turns. | ~6.8 mon-equivalents of wasted turns and the chip taken that turn. |
| Attack into an immunity with no other damaging move | 5 | 3 | Palossand Earth Power into Enamorus-Therian three turns in a row. The click should have been a switch. | Included in the immunity total above (14 immune turns, 9 losses, ~6.8). |
| Choice lock into an immunity | 2 | 1 | Choice Band Terrakion locked into Earthquake, then Landorus came in. Subset of the immune turns. | The lock ended the game. Choice items showed up in 3 losses and 0 wins. |
| Setup into a KO | 8 | 8 | Swords Dance, Nasty Plot, Quiver Dance, or Calm Mind on the turn we faint. Two shapes: the KO move was already revealed (Charizard into Kommo-o's Clanging Scales) or the foe had just switched in (Minun Nasty Plot into Dialga's unrevealed Fire Blast). | 8 faints, one per loss. |
| Stay in and get KOed super-effectively with a resisting teammate | 6 | 5 | The KO move's type was resisted by someone else on our team. | 6 faints. Overlaps the no-Tera SE KOs. |
| Move punished by a resist or immune switch | 26 | 13 | We clicked into a voluntary switch and the move was resisted (24) or immune (2, the Landorus Earthquake). | Tempo. Not a faint by itself. 1-ply with a max-damage foe never predicts the switch. |
| Inactivity loss | 7 games | 7 | `Archinder lost due to inactivity`. | Whole game. The 1-ply decision itself is a few hundred milliseconds, so this is not a search-depth bug. |
| Hazards | — | — | We clicked a hazard move 24 times, opponents 26. Not a gap in this window. | — |
| Priority / speed as a separate tag | 1 clear slow KO | 1 | Almost everything that looked like a speed error was a setup or a stay-in. | — |
| PP stall (`nopp`) | 0 | 0 | None in this window. | — |

The three that a 1-ply search can change without a species rule, a deeper tree, or a new opponent model:

1. **Terastallize was not a legal choice.** `legalChoices`, the live request actions, and `actionFromChoice` all dropped `terastallize`. The decision battle also never copied `teraType`, so the sim could not terastallize even if the string had been sent. This is every game, not a close decision.
2. **Immune attacks won ties and Choice locks.** When every line faints before we move, the old search keeps the first move. That first move was Earthquake, Earth Power, or Poison Jab into a type, ability, or item that blanks it, including a Choice Band lock. A later move still hit.
3. **Setup won the same tie, and unrevealed foes only had Tackle.** The live battle is built from revealed moves. An empty list becomes Tackle. Nasty Plot then looks free against a Dialga that actually has Fire Blast. A status move also wins the die-first tie when it is move 1.

Switch prediction (26 turns) needs the existing switch model and another ply. That is a different experiment (`SWITCH_DEPTH2`), not a leaf penalty. Inactivity losses are real and are not fixed by scoring more lines.

## What the 1-ply engine does now

`EXACT_1PLY` still searches one ply, eight samples, max-damage foe, HP eval. Three flags are on:

- `tera`: root choices include `move N terastallize` when the request still allows it. The ladder action list and `buildDecisionBattle` carry the same type.
- `progress`: an immune damaging move loses 1.1, a status move loses 0.9 when the foe's current moves KO us before we move, and a Choice item loses 0.5 when a benched foe walls the lock and another move hits the active. A faint is 2, so a line that actually survives still outranks a penalty.
- `foePrior`: a foe with fewer than four moves, or fewer than two real damaging moves, is given one randbats set that contains every move already on the board. A complete set is left alone, so a full-info battle does not grow extra coverage. The pool has 508 species.

`EXACT_1PLY_PREVIOUS` is the old object (no tera, no penalty, no prior) and is what the screen calls `previous`.

## Info-honest screen

Both players decide from `ladderDecisionBattle`: the same hidden view the live ladder searches (revealed moves only; an empty list is Tackle). The real battle still resolves the turn. That is the bench default (`information=hidden`). The new policy is `EXACT_1PLY`. The opponent is `EXACT_1PLY_PREVIOUS` (the same 1-ply with tera, the progress penalty, and the foe prior off). 100 seeds, sides swapped, **200 games**, seed 1, eight samples each. Win rate is wins/games. Ties stay in the denominator. The interval is a 95% Wilson score.

| | |
| --- | --- |
| Record | **115-85-0** |
| Win rate | **57.5%** |
| Wilson 95% CI | **[50.6%, 64.1%]** |
| Invalid moves | 0 |
| Crashes | 0 |
| View rebuild misses | 0 |
| Decision p99 | 175 ms (max 510 ms) |
| Randbats species in the prior | 508 |

The same three fixes are checked on seeded `gen9randombattle` positions, not on a named species: terastallize when that line is at least 1.5 HP-eval points better over one turn, refuse an immune move 1 when a later move still hits, and refuse a setup move 1 when the real foe KOs and the revealed board has hidden that move. The hand-written diagnostic suite is 22/22. Nothing in the tests writes `data/gen9-stats.json`.
