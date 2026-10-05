import fs from 'fs';
import path from 'path';
import type { Battle } from '@pkmn/sim';
import type { Action, GameState, RandbatsStats } from '../../types/index.js';
import type { SideId } from '../../engine/exact/battle-utils.js';
import { GatewayClient, type EvaluateQuestion } from '../gateway-client.js';
import { JEV_MODEL_ID } from '../models.js';
import { renderContextBrief } from '../context-brief.js';
import { assembleBrief, boardFromGameState, boardFromSim, choiceToAction, withTeraChoices } from '../context/index.js';
import type { BoardInput, LegalOption } from '../context/types.js';
import { contextConfigOf, type JevSoloConfig } from './config.js';
import { ACTION_SCORE_LEVELS, RISK_LEVELS, choiceQuestion, questionsFor } from './questions.js';
import type { JevTrace } from './stats.js';

export interface JevDecision {
  choice: string;
  action: Action;
  trace: JevTrace;
}

let poolsCache: RandbatsStats | null = null;
let shared: GatewayClient | null = null;

export function sharedJevClient(): GatewayClient {
  if (!shared) {
    shared = new GatewayClient({
      timeoutMs: 4000,
      maxRetries: 1,
      perTurnLatencyBudgetMs: 8000,
    });
  }
  return shared;
}

export function loadPools(): RandbatsStats {
  if (poolsCache) return poolsCache;
  const file = path.join(process.cwd(), 'data', 'gen9-stats.json');
  if (!fs.existsSync(file)) {
    poolsCache = {};
    return poolsCache;
  }
  poolsCache = JSON.parse(fs.readFileSync(file, 'utf8')) as RandbatsStats;
  return poolsCache;
}

export function resetJevSoloCaches(): void {
  poolsCache = null;
  shared = null;
}

export async function jevSoloOnBattle(args: {
  battle: Battle;
  side: SideId;
  config: JevSoloConfig;
  client?: GatewayClient;
  pools?: RandbatsStats;
}): Promise<JevDecision> {
  try {
    const choices = withTeraChoices(args.battle, args.side);
    const board = boardFromSim(args.battle, args.side, args.pools ?? loadPools());
    board.situationBrief = renderContextBrief(args.battle, args.side, 2000).text;
    board.legal = board.legal.filter(option => choices.includes(option.choice));
    return await decideBoard(board, args.config, args.client ?? sharedJevClient());
  } catch (error) {
    return fallbackDecision(firstChoice(args.battle, args.side), args.config, error);
  }
}

export async function jevSoloFromState(args: {
  state: GameState;
  legal: Action[];
  config: JevSoloConfig;
  client?: GatewayClient;
  pools?: RandbatsStats;
}): Promise<JevDecision> {
  const board = boardFromGameState(args.state, args.legal, args.pools ?? loadPools());
  return decideBoard(board, args.config, args.client ?? sharedJevClient());
}

export async function decideBoard(board: BoardInput, config: JevSoloConfig, client: GatewayClient): Promise<JevDecision> {
  const legal = (board.legal ?? []).filter(option => option.choice !== 'default');
  if (legal.length === 0) {
    const choice = board.legal?.[0]?.choice ?? 'default';
    return finish(choice, board, config, false, false, 0, 0, [], 0);
  }
  if (legal.length === 1) {
    return finish(legal[0].choice, board, config, false, false, 0, 0, [], 0);
  }

  let brief;
  try {
    brief = assembleBrief(board, contextConfigOf(config));
  } catch (error) {
    return fallbackDecision(legal[0].choice, config, error);
  }
  const guidanceOn = brief.blocks.some(block => block.id === 'meta-guidance');
  client.startTurn();
  try {
    if (config.question === 'two-stage') {
      const first = await client.evaluate({
        model: JEV_MODEL_ID,
        state: brief.text,
        questions: questionsFor('two-stage', legal, config, guidanceOn),
      });
      if (!first.ok) {
        return finish(legal[0].choice, board, config, true, true, first.metrics.latencyMs, first.metrics.costUsd, brief.blocks.map(block => block.id), brief.text.length, first.error);
      }
      const plan = first.data.answers.strategy?.choice || 'press';
      const second = await client.evaluate({
        model: JEV_MODEL_ID,
        state: `${brief.text}\nstrategy=${plan}`,
        questions: { bestAction: choiceQuestion(legal, config, guidanceOn) },
      });
      const latency = first.metrics.latencyMs + second.metrics.latencyMs;
      const cost = first.metrics.costUsd + second.metrics.costUsd;
      if (!second.ok) {
        return finish(legal[0].choice, board, config, true, true, latency, cost, brief.blocks.map(block => block.id), brief.text.length, second.error);
      }
      const picked = pickChoice(legal, second.data.answers.bestAction);
      if (!picked) {
        return finish(legal[0].choice, board, config, true, true, latency, cost, brief.blocks.map(block => block.id), brief.text.length, 'unusable_choice');
      }
      return finish(picked.choice, board, config, true, false, latency, cost, brief.blocks.map(block => block.id), brief.text.length);
    }

    const questions = questionsFor(config.question, legal, config, guidanceOn);
    const result = await client.evaluate({ model: JEV_MODEL_ID, state: brief.text, questions });
    if (!result.ok) {
      return finish(legal[0].choice, board, config, true, true, result.metrics.latencyMs, result.metrics.costUsd, brief.blocks.map(block => block.id), brief.text.length, result.error);
    }
    const picked = pickDesign(config.question, legal, result.data.answers);
    if (!picked) {
      return finish(legal[0].choice, board, config, true, true, result.metrics.latencyMs, result.metrics.costUsd, brief.blocks.map(block => block.id), brief.text.length, 'unusable_choice');
    }
    return finish(picked.choice, board, config, true, false, result.metrics.latencyMs, result.metrics.costUsd, brief.blocks.map(block => block.id), brief.text.length);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'jev_threw';
    return finish(legal[0].choice, board, config, true, true, 0, 0, [], 0, message);
  } finally {
    client.endTurn();
  }
}

function pickDesign(
  design: JevSoloConfig['question'],
  legal: LegalOption[],
  answers: Record<string, { choice?: string; score?: number; probabilities?: Record<string, number> } | undefined>
): LegalOption | null {
  if (design === 'score') {
    let best: LegalOption | null = null;
    let bestScore = -1;
    for (const option of legal) {
      const score = answers[option.id]?.score;
      if (typeof score !== 'number') continue;
      if (score > bestScore) {
        bestScore = score;
        best = option;
      }
    }
    return best;
  }
  if (design === 'multi') {
    let best: LegalOption | null = null;
    let bestRank = -1;
    const probabilities = answers.bestAction?.probabilities ?? {};
    for (const option of legal) {
      const probability = probabilities[option.id] ?? 0;
      const risk = answers[`risk_${option.id}`]?.score;
      const risk01 = typeof risk === 'number' ? risk / (RISK_LEVELS.length - 1) : 0.5;
      const rank = probability * (1 - risk01);
      if (rank > bestRank) {
        bestRank = rank;
        best = option;
      }
    }
    if (best && bestRank > 0) return best;
    return pickChoice(legal, answers.bestAction);
  }
  return pickChoice(legal, answers.bestAction);
}

function pickChoice(
  legal: LegalOption[],
  answer: { choice?: string; probabilities?: Record<string, number> } | undefined
): LegalOption | null {
  if (!answer) return null;
  if (answer.choice) {
    const named = legal.find(option => option.id === answer.choice);
    if (named) return named;
  }
  const probabilities = answer.probabilities;
  if (!probabilities) return null;
  let best: LegalOption | null = null;
  let bestP = -1;
  for (const option of legal) {
    const probability = probabilities[option.id];
    if (typeof probability !== 'number') continue;
    if (probability > bestP) {
      bestP = probability;
      best = option;
    }
  }
  return best;
}

function finish(
  choice: string,
  board: BoardInput,
  config: JevSoloConfig,
  called: boolean,
  fallback: boolean,
  latencyMs: number,
  costUsd: number,
  blocks: string[],
  briefChars: number,
  error?: string
): JevDecision {
  const option = board.legal.find(candidate => candidate.choice === choice) ?? board.legal[0];
  const action = option?.action ?? { type: 'move' as const, moveIndex: 1 };
  const switchLegal = board.legal.some(candidate => candidate.action.type === 'switch' && board.legal.some(other => other.action.type === 'move'));
  const teraLegal = board.canTera;
  return {
    choice: option?.choice ?? choice,
    action,
    trace: {
      fallback,
      called,
      hardSwitch: action.type === 'switch' && switchLegal,
      tera: action.type === 'move' && !!action.terastallize,
      teraLegal,
      switchLegal,
      latencyMs,
      costUsd,
      design: config.question,
      blocks,
      briefChars,
      error,
    },
  };
}

/** Ladder engine. One instance per battle. A failed call stays on the first legal action. */
export class JevSoloEngine {
  private fallbackReason: string | null = null;
  private lastScore = 0;

  constructor(
    private readonly config: JevSoloConfig,
    private readonly client?: GatewayClient
  ) {}

  async selectAction(state: GameState, legal: Action[]): Promise<Action> {
    this.fallbackReason = null;
    const decision = await jevSoloFromState({ state, legal, config: this.config, client: this.client });
    this.lastScore = decision.trace.fallback ? 0 : 1;
    if (decision.trace.fallback) this.fallbackReason = decision.trace.error || 'legality_fallback';
    const known = legal.some(candidate => same(candidate, decision.action));
    if (!known) {
      this.fallbackReason = this.fallbackReason || 'illegal_choice';
      return legal[0];
    }
    return decision.action;
  }

  consumeFallback(): string | null {
    const reason = this.fallbackReason;
    this.fallbackReason = null;
    return reason;
  }

  getLastEngineError(): string | null {
    return null;
  }

  getLastDecision(): { evaluation: { score: number } } {
    return { evaluation: { score: this.lastScore } };
  }
}

function firstChoice(battle: Battle, side: SideId): string {
  try {
    return withTeraChoices(battle, side)[0] ?? 'move 1';
  } catch {
    return 'move 1';
  }
}

function fallbackDecision(choice: string, config: JevSoloConfig, error: unknown): JevDecision {
  const message = error instanceof Error ? error.message : 'brief_threw';
  return {
    choice,
    action: choiceToAction(choice),
    trace: {
      fallback: true,
      called: false,
      hardSwitch: false,
      tera: false,
      teraLegal: false,
      switchLegal: false,
      latencyMs: 0,
      costUsd: 0,
      design: config.question,
      blocks: [],
      briefChars: 0,
      error: message,
    },
  };
}

function same(a: Action, b: Action): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'move' && b.type === 'move') return a.moveIndex === b.moveIndex && !!a.terastallize === !!b.terastallize;
  if (a.type === 'switch' && b.type === 'switch') return a.switchIndex === b.switchIndex;
  return false;
}

export type { EvaluateQuestion };
