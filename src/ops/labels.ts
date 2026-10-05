import { GraphDB } from '../graph/db.js';
import { loadConfig } from '../config/load.js';

/**
 * The only writer of `champion` and `live-approved`.
 * Factory, live, and analyst must not import this module.
 */

export function writeChampion(db: GraphDB, configPath: string): string {
  const loaded = loadConfig(configPath);
  const now = Date.now();
  for (const node of db.getNodesByType('Champion', 'active')) {
    if ((node.metadata as { configId?: string } | undefined)?.configId === loaded.configId) continue;
    db.updateNode(node.id, { status: 'superseded' });
  }
  const id = `champion-${loaded.configId}`;
  db.addNode({
    id,
    type: 'Champion',
    status: 'active',
    title: `Champion ${loaded.config.name}`,
    description: 'Labeled by the gatekeeper.',
    created_at: now,
    updated_at: now,
    version: loaded.configId,
    config_path: configPath,
    promoted_at: now,
    metadata: { configId: loaded.configId, labels: ['champion', 'live-approved'] },
  });
  writeLiveApproved(db, configPath);
  return loaded.configId;
}

export function writeLiveApproved(db: GraphDB, configPath: string): string {
  const loaded = loadConfig(configPath);
  const now = Date.now();
  const id = `live-approved-${loaded.configId}`;
  db.addNode({
    id,
    type: 'Convention',
    status: 'active',
    title: `live-approved ${loaded.config.name}`,
    description: 'Labeled by the gatekeeper. The live facility may allocate an explore share to this config.',
    created_at: now,
    updated_at: now,
    category: 'other',
    rationale: 'Passed the gatekeeper checks.',
    metadata: {
      opsKind: 'label',
      configId: loaded.configId,
      configPath,
      labels: ['live-approved'],
    },
  });
  return loaded.configId;
}
