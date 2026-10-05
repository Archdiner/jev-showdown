import { Battle, BattleStreams, Teams, RandomPlayerAI } from '@pkmn/sim';
import { TeamGenerators } from '@pkmn/randoms';

async function testHarness() {
  console.log('=== Testing Battle Harness Integrity ===\n');
  
  // Test 1: Random vs Random should be ~50%
  console.log('Test 1: Random vs Random (should be ~50%)');
  const rvrResults = await runBatch(10, 'random', 'random');
  console.log(`Result: ${rvrResults.p1wins}W-${rvrResults.p2wins}L = ${(rvrResults.p1wins / 10 * 100).toFixed(1)}%\n`);
  
  // Test 2: Test move choices are being sent
  console.log('Test 2: Verifying move choices are sent correctly');
  await runSingleGameWithLogging();
}

async function runSingleGameWithLogging() {
  const streams = BattleStreams.getPlayerStreams(new BattleStreams.BattleStream());
  
  const teamGen = TeamGenerators.getTeamGenerator('gen9randombattle');
  const team1 = teamGen.getTeam();
  const team2 = teamGen.getTeam();
  
  const p1spec = { name: 'Bot1', team: Teams.pack(team1) };
  const p2spec = { name: 'Bot2', team: Teams.pack(team2) };

  let requestCount = 0;
  let choiceCount = 0;

  void (async () => {
    for await (const chunk of streams.p1) {
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('|request|')) {
          requestCount++;
          const request = JSON.parse(line.slice(9));
          if (request.active) {
            const choice = 'move 1';
            choiceCount++;
            console.log(`  P1 Request ${requestCount}: sending "${choice}"`);
            streams.p1.write(choice);
          }
        }
        if (line.startsWith('|error|')) {
          console.log(`  P1 ERROR: ${line}`);
        }
      }
    }
  })();

  const p2 = new RandomPlayerAI(streams.p2);
  void p2.start();

  let winner = null;
  void (async () => {
    for await (const chunk of streams.omniscient) {
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('|move|')) {
          console.log(`  ${line}`);
        }
        if (line.startsWith('|win|')) {
          winner = line.split('|')[2];
          console.log(`\nWinner: ${winner}`);
          break;
        }
      }
      if (winner) break;
    }
  })();

  void streams.omniscient.write(`>start {"formatid":"gen9randombattle"}
>player p1 ${JSON.stringify(p1spec)}
>player p2 ${JSON.stringify(p2spec)}`);

  await new Promise(resolve => setTimeout(resolve, 5000));
  console.log(`\nRequests: ${requestCount}, Choices sent: ${choiceCount}`);
}

async function runBatch(n: number, bot1: string, bot2: string) {
  let p1wins = 0;
  let p2wins = 0;

  for (let i = 0; i < n; i++) {
    const result = await runGame(bot1, bot2);
    if (result === 'p1') p1wins++;
    else if (result === 'p2') p2wins++;
  }

  return { p1wins, p2wins };
}

async function runGame(bot1Type: string, bot2Type: string): Promise<'p1' | 'p2' | 'tie'> {
  return new Promise((resolve) => {
    const streams = BattleStreams.getPlayerStreams(new BattleStreams.BattleStream());
    
    const teamGen = TeamGenerators.getTeamGenerator('gen9randombattle');
    const team1 = teamGen.getTeam();
    const team2 = teamGen.getTeam();
    
    const p1spec = { name: 'Bot1', team: Teams.pack(team1) };
    const p2spec = { name: 'Bot2', team: Teams.pack(team2) };

    const p1 = new RandomPlayerAI(streams.p1);
    const p2 = new RandomPlayerAI(streams.p2);
    
    void p1.start();
    void p2.start();

    let winner: 'p1' | 'p2' | 'tie' = 'tie';

    void (async () => {
      for await (const chunk of streams.omniscient) {
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('|win|')) {
            winner = line.includes('Bot1') ? 'p1' : 'p2';
            resolve(winner);
            return;
          } else if (line === '|tie' || line.startsWith('|tie|')) {
            resolve('tie');
            return;
          }
        }
      }
      resolve(winner);
    })();

    void streams.omniscient.write(`>start {"formatid":"gen9randombattle"}
>player p1 ${JSON.stringify(p1spec)}
>player p2 ${JSON.stringify(p2spec)}`);

    setTimeout(() => {
      resolve('tie');
    }, 10000);
  });
}

testHarness().catch(console.error);
