import { parentPort } from 'node:worker_threads';
import { Bot } from '../bot/bot.js';
import { BattleLogger } from '../learning/battle-logger.js';
import { gen9RandomBattle } from '../formats/gen9-randombattle.js';
import { dataLoader } from '../data/data-loader.js';
import { Action, BotConfig, GameState } from '../types/index.js';
import { pickBestLegal, sameAction } from './choice.js';
import { DecideRequest, WorkerRequest, WorkerResponse } from './decision-messages.js';
import { EngineName, freshConfig, maxDamageAction } from './engines.js';

if (!parentPort) {
  throw new Error('decision-worker must be started as a worker thread');
}

const port = parentPort;

interface IsolatedEngine {
  selectAction(state: GameState, legal: Action[]): Promise<Action>;
  getLastEngineError(): string | null;
  getLastDecision(): { evaluation: { score: number } } | undefined;
}

interface BattleEngine {
  engine: IsolatedEngine;
  config: BotConfig;
}

let engineName: EngineName = 'search';
let baseConfig: BotConfig | null = null;
const battles = new Map<string, BattleEngine>();
let chain = Promise.resolve();

function send(message: WorkerResponse): void {
  port.postMessage(message);
}

async function init(config: BotConfig, engine: EngineName): Promise<void> {
  engineName = engine;
  baseConfig = config;
  await dataLoader.load(gen9RandomBattle);
  send({ type: 'ready' });
}

async function openBattle(battleId: string): Promise<void> {
  if (battles.has(battleId) || !baseConfig) return;
  const config = freshConfig(baseConfig, baseConfig.searchTimeMs);
  if (engineName === 'max-damage') {
    battles.set(battleId, {
      config,
      engine: {
        async selectAction(state, legal) {
          return maxDamageAction(state, legal);
        },
        getLastEngineError: () => null,
        getLastDecision: () => undefined,
      },
    });
    return;
  }

  const bot = new Bot(config, gen9RandomBattle, new BattleLogger(':memory:'));
  await bot.initialize();
  bot.startBattle(battleId);
  battles.set(battleId, { config, engine: bot });
}

function closeBattle(battleId: string): void {
  const held = battles.get(battleId);
  battles.delete(battleId);
  if (held?.engine instanceof Bot) {
    held.engine.endBattle('tie', 'closed', 0);
  }
}

async function decide(message: DecideRequest): Promise<void> {
  if (!battles.has(message.battleId)) await openBattle(message.battleId);
  const held = battles.get(message.battleId);
  if (!held) {
    send({ type: 'worker-error', message: `no engine for ${message.battleId}` });
    return;
  }

  held.config.searchTimeMs = message.searchTimeMs;
  const started = Date.now();
  try {
    const action = await held.engine.selectAction(message.state, message.legal);
    const engineError = held.engine.getLastEngineError();
    const known = message.legal.some(candidate => sameAction(candidate, action));
    if (engineError || !known) {
      send({
        type: 'decision',
        id: message.id,
        action: pickBestLegal(message.state, message.legal),
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
      score: held.engine.getLastDecision()?.evaluation.score ?? null,
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
    await openBattle(message.battleId);
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
