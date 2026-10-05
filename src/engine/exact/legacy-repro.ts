/**
 * One-decision view of the old search bug.
 *
 * After a KO the live battle asks one side to switch and the other side waits.
 * BattleStateBuilder does not clone that battle. It starts a new one and
 * copies HP, so the copy still has a normal move request and wants both
 * players to act. Sending the legal switch alone throws "Not all choices done".
 * simulateTurn turns that into a terminal position with no winner, and
 * RobustSearch.evaluateAction scores any terminal line that is not our win
 * as -10000.
 *
 * The same switch commits on a toJSON/fromJSON clone.
 *
 * Run: npx tsx src/engine/exact/legacy-repro.ts
 */
import { BattleStateBuilder } from '../battle-state-builder.js';
import { gen9RandomBattle } from '../../formats/gen9-randombattle.js';
import {
  SideId,
  cloneFromSnapshot,
  hpEval,
  legalChoices,
  playChoices,
  safeChoose,
  snapshot,
  startRandomBattle,
  teamsForSeed,
} from './battle-utils.js';
import { maxDamageChoice } from './max-damage.js';
import { battleToState } from './search.js';

function mustSwitch(battle: { getSide: (id: SideId) => { activeRequest: any } }, side: SideId): boolean {
  const flags = battle.getSide(side).activeRequest?.forceSwitch;
  return Array.isArray(flags) && flags.some(Boolean);
}

async function main(): Promise<void> {
  const teams = teamsForSeed(1);
  const battle = startRandomBattle(teams.p1, teams.p2, 1);
  const builder = new BattleStateBuilder(gen9RandomBattle);

  for (let step = 0; step < 30 && !battle.ended; step++) {
    const p1 = legalChoices(battle, 'p1');
    const p2 = legalChoices(battle, 'p2');
    const side: SideId | null = mustSwitch(battle, 'p1') ? 'p1' : mustSwitch(battle, 'p2') ? 'p2' : null;
    if (!side) {
      if (p1.length) safeChoose(battle, 'p1', maxDamageChoice(battle, 'p1', p1));
      if (!battle.ended && p2.length) safeChoose(battle, 'p2', maxDamageChoice(battle, 'p2', p2));
      continue;
    }

    const choice = legalChoices(battle, side)[0];
    const state = battleToState(battle, side);
    const rebuilt = await builder.createBattle(state);
    if (!rebuilt) throw new Error('createBattle returned null');

    // The fainting side is "me", and the builder always seats "me" on p1.
    // The other side is waiting, so the live choice list has nothing for them.
    let rejected = 'accepted';
    try {
      rebuilt.makeChoices(choice, '');
    } catch (error) {
      rejected = error instanceof Error ? error.message.split('\n')[0] : String(error);
    }

    const before = BattleStateBuilder.failedSimulations;
    const again = await builder.createBattle(state);
    if (!again) throw new Error('createBattle returned null');
    const sim = await builder.simulateTurn(again, choice, '');
    const scoredAsLoss = sim.terminated && sim.winner !== 'p1';

    const clone = cloneFromSnapshot(snapshot(battle));
    const exactOk = playChoices(clone, side, choice, undefined);

    console.log(JSON.stringify({
      turn: battle.turn,
      side,
      liveChoice: choice,
      otherSideWaiting: legalChoices(battle, side === 'p1' ? 'p2' : 'p1').length === 0,
      rebuild: rejected,
      failedSimulations: BattleStateBuilder.failedSimulations - before,
      scoredAsLoss,
      exactAccepted: exactOk,
      exactHpEval: Number(hpEval(clone, side).toFixed(3)),
    }));

    if (rejected === 'Not all choices done' && scoredAsLoss && exactOk) {
      console.log('BUG: legal switch scored as a loss on the rebuild, and it commits on a clone.');
      return;
    }
    console.error('Force-switch turn did not show the bug.');
    process.exit(1);
  }

  console.error('No force-switch turn found.');
  process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
