import { parentPort } from 'node:worker_threads';
import { Bot } from '../bot/bot.js';
import { BattleLogger } from '../learning/battle-logger.js';
import { gen9RandomBattle } from '../formats/gen9-randombattle.js';
import { dataLoader } from '../data/data-loader.js';
import { BotConfig } from '../types/index.js';
import { pickBestLegal, sameAction } from './choice.js';
import { DecideRequest, WorkerRequest, WorkerResponse } from './decision-messages.js';

if (!parentPort) {
  throw new Error('decision-worker must be started as a worker thread');
}

const port = parentPort;
let bot: Bot | null = null;

function send(message: WorkerResponse): void {
  port.postMessage(message);
}

async function init(config: BotConfig): Promise<void> {
  await dataLoader.load(gen9RandomBattle);
  const logger = new BattleLogger(':memory:');
  bot = new Bot(config, gen9RandomBattle, logger);
  await bot.initialize();
  bot.startBattle('ladder');
  send({ type: 'ready' });
}

async function decide(message: DecideRequest): Promise<void> {
  if (!bot) {
    send({ type: 'worker-error', message: 'Engine is not initialized' });
    return;
  }

  const started = Date.now();
  try {
    const action = await bot.selectAction(message.state, message.legal);
    const engineError = bot.getLastEngineError();
    const known = message.legal.some(candidate => sameAction(candidate, action));
    if (engineError || !known) {
      const fallback = pickBestLegal(message.state, message.legal);
      send({
        type: 'decision',
        id: message.id,
        action: fallback,
        score: null,
        timeMs: Date.now() - started,
        fallback: true,
        reason: engineError || 'engine returned a choice that is not legal',
      });
      return;
    }

    send({
      type: 'decision',
      id: message.id,
      action,
      score: bot.getLastDecision()?.evaluation.score ?? null,
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

port.on('message', (message: WorkerRequest) => {
  if (message.type === 'init') {
    init(message.config).catch(err => {
      const text = err instanceof Error ? err.message : String(err);
      send({ type: 'worker-error', message: text });
    });
    return;
  }
  void decide(message);
});
