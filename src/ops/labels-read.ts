import { GraphDB } from '../graph/db.js';

export interface LabelView {
  configId: string;
  configPath: string;
  labels: Array<'champion' | 'live-approved'>;
}

export function readLabels(db: GraphDB): LabelView[] {
  const byId = new Map<string, LabelView>();
  const add = (configId: string, configPath: string, label: 'champion' | 'live-approved') => {
    const current = byId.get(configId) ?? { configId, configPath, labels: [] };
    current.configPath = configPath || current.configPath;
    if (!current.labels.includes(label)) current.labels.push(label);
    byId.set(configId, current);
  };
  for (const node of db.getNodesByType('Champion', 'active')) {
    const meta = (node.metadata ?? {}) as { configId?: string; labels?: string[] };
    const configPath = (node as { config_path?: string }).config_path || '';
    const configId = meta.configId || configPath;
    if (!configId) continue;
    add(configId, configPath, 'champion');
    if (meta.labels?.includes('live-approved')) add(configId, configPath, 'live-approved');
  }
  for (const node of db.getNodesByType('Convention')) {
    const meta = (node.metadata ?? {}) as { opsKind?: string; configId?: string; configPath?: string; labels?: string[] };
    if (meta.opsKind !== 'label' || node.status === 'rejected' || node.status === 'superseded') continue;
    if (!meta.configId) continue;
    if (meta.labels?.includes('live-approved')) add(meta.configId, meta.configPath || '', 'live-approved');
    if (meta.labels?.includes('champion')) add(meta.configId, meta.configPath || '', 'champion');
  }
  return [...byId.values()];
}
