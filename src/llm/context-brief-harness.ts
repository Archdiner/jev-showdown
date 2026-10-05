/**
 * Renders situation briefs for a few generated battles.
 * No gateway key is read. Exit 0 when every brief has the full section list.
 */
import { startRandomBattle, teamsForSeed } from '../engine/exact/battle-utils.js';
import { BRIEF_SECTIONS, renderContextBrief } from './context-brief.js';

delete process.env.VERCEL_AI_GATEWAY_KEY;
delete process.env.AI_GATEWAY_API_KEY;

const seeds = [1, 2, 3, 8, 9];
for (const seed of seeds) {
  const teams = teamsForSeed(seed);
  const battle = startRandomBattle(teams.p1, teams.p2, seed);
  const brief = renderContextBrief(battle, 'p1');
  if (brief.sections.join() !== [...BRIEF_SECTIONS].join()) {
    console.error(`seed ${seed} missing sections: ${brief.sections.join(',')}`);
    process.exit(1);
  }
  console.log(`seed ${seed} chars=${brief.text.length} sections=${brief.sections.length} truncated=${brief.truncated}`);
}
console.log('no-key harness ok');
