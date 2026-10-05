import { parentPort } from 'node:worker_threads';
import { gen9RandomBattle } from '../formats/gen9-randombattle.js';
import { dataLoader } from '../data/data-loader.js';
import { BotConfig } from '../types/index.js';
import { pickBestLegal, sameAction } from './choice.js';
import { chooseLive } from './decision-battle.js';
import { DecideRequest, WorkerRequest, WorkerResponse } from './decision-messages.js';
import { EngineName } from './engines.js';

if (!parentPort) {
  throw new Error('decision-worker must be started as a worker thread');
}

const port = parentPort;

let engineName: EngineName = 'search';
const battles = new Set<string>();
let chain = Promise.resolve();

function send(message: WorkerResponse): void {
  port.postMessage(message);
}

async function init(_config: BotConfig, engine: EngineName): Promise<void> {
  engineName = engine;
  await dataLoader.load(gen9RandomBattle);
  send({ type: 'ready' });
}

function openBattle(battleId: string): void {
  battles.add(battleId);
}

function closeBattle(battleId: string): void {
  battles.delete(battleId);
}

async function decide(message: DecideRequest): Promise<void> {
  if (!battles.has(message.battleId)) openBattle(message.battleId);
  const started = Date.now();
  try {
    const picked = await chooseLive(engineName, message.position, message.legal);
    const known = message.legal.some(candidate => sameAction(candidate, picked.action));
    if (!known) {
      send({
        type: 'decision',
        id: message.id,
        action: pickBestLegal(message.state, message.legal),
        score: null,
        timeMs: Date.now() - started,
        fallback: true,
        reason: 'engine returned a choice that is not legal',
      });
      return;
    }

    send({
      type: 'decision',
      id: message.id,
      action: picked.action,
      score: picked.score,
      timeMs: Date.now() - started,
      fallback: false,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    let action = message.legal[0];
    try {
      action = pickBestLegal(message.state, message.legal);
    } catch {
      // legal[0] is still a request-checked choice
    }
    send({
      type: 'decision',
      id: message.id,
      action,
      score: null,
      timeMs: Date.now() - started,
      fallback: true,
      reason,
    });
  }
}

async function handle(message: WorkerRequest): Promise<void> {
  if (message.type === 'init') {
    await init(message.config, message.engine);
    return;
  }
  if (message.type === 'open-battle') {
    openBattle(message.battleId);
    return;
  }
  if (message.type === 'close-battle') {
    closeBattle(message.battleId);
    return;
  }
  await decide(message);
}

port.on('message', (message: WorkerRequest) => {
  chain = chain.then(() => handle(message)).catch(err => {
    const text = err instanceof Error ? err.message : String(err);
    send({ type: 'worker-error', message: text });
  });
});
