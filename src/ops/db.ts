import { GraphDB } from '../graph/db.js';
import type { OpsPaths } from './paths.js';

export function openDb(paths: OpsPaths): GraphDB {
  return new GraphDB(paths.graph);
}
