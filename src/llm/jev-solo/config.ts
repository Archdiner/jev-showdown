import fs from 'fs';
import path from 'path';
import type { ContextConfig } from '../context/types.js';
import { CONTEXT_SCHEMA_VERSION } from '../context/types.js';

export type QuestionDesign = 'choice' | 'score' | 'two-stage' | 'multi';
export type CriteriaStyle = 'plain' | 'planner';

export interface JevSoloConfig {
  id: string;
  question: QuestionDesign;
  criteria: CriteriaStyle;
  blocks?: ContextConfig['blocks'];
}

export const DEFAULT_CONFIG_PATH = path.join(process.cwd(), 'experiments', 'jev-solo', 'config.json');

const QUESTIONS: QuestionDesign[] = ['choice', 'score', 'two-stage', 'multi'];
const CRITERIA: CriteriaStyle[] = ['plain', 'planner'];

export function contextConfigOf(config: JevSoloConfig): ContextConfig {
  return { version: CONTEXT_SCHEMA_VERSION, blocks: config.blocks };
}

export function normalizeConfig(raw: Partial<JevSoloConfig>): JevSoloConfig {
  const question = QUESTIONS.includes(raw.question as QuestionDesign) ? raw.question! : 'choice';
  const criteria = CRITERIA.includes(raw.criteria as CriteriaStyle) ? raw.criteria! : 'planner';
  return {
    id: raw.id || 'jev-solo',
    question,
    criteria,
    blocks: raw.blocks,
  };
}

export function loadJevSoloConfig(file = process.env.JEV_SOLO_CONFIG || DEFAULT_CONFIG_PATH): JevSoloConfig {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<JevSoloConfig>;
  return normalizeConfig(raw);
}

export function withBlock(config: JevSoloConfig, id: string, enabled: boolean): JevSoloConfig {
  return {
    ...config,
    blocks: {
      ...config.blocks,
      [id]: { ...config.blocks?.[id as keyof NonNullable<JevSoloConfig['blocks']>], enabled },
    },
  };
}
