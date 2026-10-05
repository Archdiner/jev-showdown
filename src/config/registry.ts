import { z } from 'zod';
import { deepMerge } from './merge.js';

export interface ComponentDef<P = unknown> {
  layer: string;
  id: string;
  schema: z.ZodType<P, z.ZodTypeDef, unknown>;
  defaults: P;
  create: (params: P) => unknown;
}

const defs = new Map<string, ComponentDef>();

export function register<P>(def: ComponentDef<P>): void {
  defs.set(`${def.layer}:${def.id}`, def as ComponentDef);
}

export function hasComponent(layer: string, id: string): boolean {
  return defs.has(`${layer}:${id}`);
}

export function componentIds(layer: string): string[] {
  const prefix = `${layer}:`;
  return [...defs.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)).sort();
}

export function layers(): string[] {
  return [...new Set([...defs.keys()].map(key => key.slice(0, key.indexOf(':'))))].sort();
}

export function parseParams<P>(layer: string, id: string, raw: unknown): P {
  const def = requireDef(layer, id);
  const merged = deepMerge(def.defaults, raw ?? {});
  return def.schema.parse(merged) as P;
}

export function createComponent<T = unknown>(layer: string, id: string, params: unknown): T {
  const def = requireDef(layer, id);
  return def.create(params as never) as T;
}

function requireDef(layer: string, id: string): ComponentDef {
  const def = defs.get(`${layer}:${id}`);
  if (!def) {
    throw new Error(`Unknown ${layer} "${id}". Registered: ${componentIds(layer).join(', ') || 'none'}`);
  }
  return def;
}
