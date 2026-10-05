import { canonicalJson } from '../config/hash.js';
import type { ResolvedConfig } from '../config/schema.js';
import { EVAL_TERMS } from '../config/schema.js';

export function setByPath(root: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cursor[parts[i]];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new Error(`Cannot set ${dotted}: missing ${parts.slice(0, i + 1).join('.')}`);
    }
    cursor = next as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  if (!(leaf in cursor)) throw new Error(`Cannot set ${dotted}: missing ${dotted}`);
  cursor[leaf] = value;
}

export interface Axis {
  path: string;
  values: Array<string | number | boolean>;
}

export function gridConfigs(base: ResolvedConfig, axes: Axis[]): ResolvedConfig[] {
  let current: ResolvedConfig[] = [structuredClone(base)];
  for (const axis of axes) {
    const next: ResolvedConfig[] = [];
    for (const config of current) {
      for (const value of axis.values) {
        const copy = structuredClone(config);
        setByPath(copy as unknown as Record<string, unknown>, axis.path, value);
        copy.name = `${base.name} ${axis.path}=${String(value)}`;
        next.push(copy);
      }
    }
    current = next;
  }
  return current;
}

/** One-at-a-time knockouts. A variant is kept only when the strategy hash changes. */
export function ablationConfigs(config: ResolvedConfig): Array<{ label: string; config: ResolvedConfig }> {
  const variants: Array<{ label: string; config: ResolvedConfig }> = [];
  const consider = (label: string, copy: ResolvedConfig) => {
    const changed = canonicalJson({ ...copy, name: config.name }) !== canonicalJson(config);
    if (!changed) return;
    copy.name = `${config.name} ablate ${label}`;
    variants.push({ label, config: copy });
  };

  for (const key of Object.keys(config.policies) as Array<keyof ResolvedConfig['policies']>) {
    const copy = structuredClone(config);
    copy.policies[key] = { id: 'off', params: { enabled: false } };
    consider(key, copy);
  }
  for (const term of EVAL_TERMS) {
    if (config.evaluator.params.weights[term] === 0) continue;
    const copy = structuredClone(config);
    copy.evaluator = {
      ...copy.evaluator,
      params: { weights: { ...copy.evaluator.params.weights, [term]: 0 } },
    };
    consider(`weight.${term}`, copy);
  }
  if (config.advisor.params.enabled) {
    const copy = structuredClone(config);
    copy.advisor = { ...copy.advisor, params: { ...copy.advisor.params, enabled: false } };
    consider('advisor', copy);
  }
  config.context.params.blocks.forEach((block, index) => {
    if (!block.enabled) return;
    const copy = structuredClone(config);
    copy.context = {
      ...copy.context,
      params: {
        ...copy.context.params,
        blocks: copy.context.params.blocks.map((item, i) => i === index ? { ...item, enabled: false } : item),
      },
    };
    consider(`context.${block.id}`, copy);
  });
  if (config.opponentModel.behavior.id !== 'uniform') {
    const copy = structuredClone(config);
    copy.opponentModel = {
      ...copy.opponentModel,
      behavior: { ...copy.opponentModel.behavior, id: 'uniform' },
    };
    consider('behavior', copy);
  }
  if (config.opponentModel.setInference.id !== 'unconstrained') {
    const copy = structuredClone(config);
    copy.opponentModel = {
      ...copy.opponentModel,
      setInference: { ...copy.opponentModel.setInference, id: 'unconstrained' },
    };
    consider('set-inference', copy);
  }
  if (config.metaController.id !== 'static') {
    const copy = structuredClone(config);
    copy.metaController = { ...copy.metaController, id: 'static' };
    consider('meta', copy);
  }
  if (config.search.params.depth > 1) {
    const copy = structuredClone(config);
    copy.search = { ...copy.search, params: { ...copy.search.params, depth: 1 } };
    consider('search-depth', copy);
  }
  return variants;
}

export function diffConfigs(a: ResolvedConfig, b: ResolvedConfig): string[] {
  const left = flatten(a as unknown as Record<string, unknown>);
  const right = flatten(b as unknown as Record<string, unknown>);
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const lines: string[] = [];
  for (const key of keys) {
    if (left[key] !== right[key]) lines.push(`${key}: ${left[key] ?? '(absent)'} => ${right[key] ?? '(absent)'}`);
  }
  return lines;
}

function flatten(value: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      Object.assign(out, flatten(child as Record<string, unknown>, path));
    } else {
      out[path] = JSON.stringify(child);
    }
  }
  return out;
}
