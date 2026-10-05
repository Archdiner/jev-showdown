import { capEvaluationState } from '../state-summary.js';
import { buildFacts } from './facts.js';
import { contextBlocks } from './blocks.js';
import type { BlockSettings, BoardInput, Brief, ContextConfig, RenderedBlock } from './types.js';
import { CONTEXT_SCHEMA_VERSION, DEFAULT_CONTEXT_CONFIG } from './types.js';

export function assembleBrief(board: BoardInput, config: ContextConfig = DEFAULT_CONTEXT_CONFIG): Brief {
  const facts = board.facts ?? buildFacts(board);
  const prepared: BoardInput = { ...board, facts };
  const rendered: RenderedBlock[] = [];
  for (const block of contextBlocks) {
    const settings = settingsFor(block.id, block.version, block.defaultMaxChars, config);
    if (!settings.enabled) continue;
    const body = block.render(prepared, settings).trim();
    if (!body) continue;
    const text = bound(settings, body);
    rendered.push({ id: block.id, version: block.version, chars: text.length, text });
  }
  const header = `context v${config.version || CONTEXT_SCHEMA_VERSION} ${rendered.map(block => `${block.id}@${block.version}`).join(',')}`;
  const text = capEvaluationState([header, ...rendered.map(block => block.text)].join('\n'));
  return { version: config.version || CONTEXT_SCHEMA_VERSION, text, blocks: rendered };
}

export function settingsFor(id: string, version: string, fallbackChars: number, config: ContextConfig): BlockSettings {
  const override = config.blocks?.[id as keyof NonNullable<ContextConfig['blocks']>];
  return {
    id,
    version,
    enabled: override?.enabled !== false,
    variant: override?.variant,
    maxChars: override?.maxChars ?? fallbackChars,
  };
}

function bound(settings: BlockSettings, body: string): string {
  const header = `[${settings.id} v${settings.version}]`;
  const full = `${header}\n${body}`;
  if (full.length <= settings.maxChars) return full;
  if (settings.maxChars <= header.length + 1) return header;
  return `${full.slice(0, settings.maxChars - 1)}…`;
}
