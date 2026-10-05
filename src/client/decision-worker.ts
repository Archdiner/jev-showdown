import { parentPort } from 'node:worker_threads';
import { gen9RandomBattle } from '../formats/gen9-randombattle.js';
import { dataLoader } from '../data/data-loader.js';
import { buildBot, type BuiltBot } from '../config/bot.js';
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
let champion: BuiltBot | null = null;
const battles = new Set<string>();
const bindings = new Map<string, { configPath: string | null; engine: EngineName }>();
const bots = new Map<string, BuiltBot>();
let chain = Promise.resolve();

function send(message: WorkerResponse): void {
  port.postMessage(message);
}

async function init(_config: BotConfig, engine: EngineName, championConfigPath?: string | null): Promise<void> {
  engineName = engine;
  const configPath = engine === 'hybrid'
    ? (championConfigPath || 'configs/hybrid.yaml')
    : championConfigPath;
  champion = configPath ? buildBot(configPath, 'ladder') : null;
  if (champion && configPath) bots.set(configPath, champion);
  await dataLoader.load(gen9RandomBattle);
  send({ type: 'ready' });
}

function openBattle(battleId: string, route?: { configPath?: string | null; engine?: EngineName }): void {
  battles.add(battleId);
  if (route && (route.configPath !== undefined || route.engine !== undefined)) {
    bindings.set(battleId, {
      configPath: route.configPath ?? null,
      engine: route.engine ?? engineName,
    });
  }
}

function closeBattle(battleId: string): void {
  battles.delete(battleId);
  bindings.delete(battleId);
}

function playerFor(battleId: string): { engine: EngineName; player: BuiltBot | null } {
  const binding = bindings.get(battleId);
  if (!binding) return { engine: engineName, player: champion };
  if (!binding.configPath) return { engine: binding.engine, player: null };
  let bot = bots.get(binding.configPath);
  if (!bot) {
    bot = buildBot(binding.configPath, 'ladder');
    bots.set(binding.configPath, bot);
  }
  return { engine: binding.engine, player: bot };
}

async function decide(message: DecideRequest): Promise<void> {
  if (!battles.has(message.battleId)) openBattle(message.battleId);
  const started = Date.now();
  const routed = playerFor(message.battleId);
  try {
    const picked = await chooseLive(routed.engine, message.position, message.legal, routed.player, message.searchTimeMs);
    const plain = picked.action.type === 'move'
      ? { type: 'move' as const, moveIndex: picked.action.moveIndex }
      : picked.action;
    const known = message.legal.some(candidate => sameAction(candidate, picked.action))
      || (picked.action.type === 'move' && picked.action.terastallize && message.legal.some(candidate => sameAction(candidate, plain)));
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
    await init(message.config, message.engine, message.championConfigPath);
    return;
  }
  if (message.type === 'open-battle') {
    openBattle(message.battleId, message);
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
