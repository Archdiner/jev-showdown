import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { loadConcurrencyFile } from '../client/concurrency-config.js';
import { assertEnvOnly } from '../config/env.js';
import { loadConfig } from '../config/load.js';
import { ExperimentSpecSchema } from './spec.js';

export interface ValidateReport {
  ok: string[];
  errors: Array<{ file: string; message: string }>;
}

export function validateConfigs(root = path.join(process.cwd(), 'configs')): ValidateReport {
  const report: ValidateReport = { ok: [], errors: [] };
  for (const file of walk(root)) {
    if (!/\.(ya?ml|json)$/i.test(file)) continue;
    try {
      const rel = path.relative(root, file).split(path.sep).join('/');
      if (rel.startsWith('envs/')) {
        const raw = file.endsWith('.json') ? JSON.parse(fs.readFileSync(file, 'utf8')) : parseYaml(fs.readFileSync(file, 'utf8'));
        assertEnvOnly(raw);
      } else if (rel.startsWith('experiments/')) {
        const raw = file.endsWith('.json') ? JSON.parse(fs.readFileSync(file, 'utf8')) : parseYaml(fs.readFileSync(file, 'utf8'));
        ExperimentSpecSchema.parse(raw);
      } else if (rel === 'live/concurrency.json') {
        loadConcurrencyFile(file);
      } else if (rel.startsWith('live/')) {
        // Other live knobs are not strategy configs.
        const text = fs.readFileSync(file, 'utf8');
        if (file.endsWith('.json')) JSON.parse(text);
        else parseYaml(text);
      } else {
        loadConfig(file);
      }
      report.ok.push(rel);
    } catch (error) {
      report.errors.push({ file, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out.sort();
}
