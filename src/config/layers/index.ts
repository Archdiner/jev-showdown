import { registerAgents } from './agent.js';
import { registerAdvisor } from './advisor.js';
import { registerContext } from './context.js';
import { registerEvaluators } from './evaluator.js';
import { registerMeta } from './meta.js';
import { registerModels } from './models.js';
import { registerOpponent } from './opponent.js';
import { registerPolicies } from './policies.js';
import { registerSearch } from './search.js';

let ready = false;

export function ensureLayers(): void {
  if (ready) return;
  ready = true;
  registerAgents();
  registerSearch();
  registerEvaluators();
  registerOpponent();
  registerPolicies();
  registerContext();
  registerAdvisor();
  registerModels();
  registerMeta();
}
